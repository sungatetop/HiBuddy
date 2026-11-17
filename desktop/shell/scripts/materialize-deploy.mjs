/**
 * Flatten a pnpm-deployed tree into a deduped, npm-style node_modules.
 *
 * Why: pnpm 12's `deploy` / `--node-linker=hoisted` does not hoist — it
 * materializes packages wherever each requirer resolves them (measured on
 * dsh 0.2.1-rc.5: @deepseek-ai/dsh-brand ×232, 213k files, max relative
 * path 436 chars). NSIS installs the tree with SHFileOperation, which
 * hard-fails on any path ≥ MAX_PATH (260), so the packaged tree must be
 * flat and deduped.
 *
 * Algorithm:
 *   1. Collect every package instance in the tree: name@version, declared
 *      dep ranges, and a representative dir — the shallowest instance,
 *      which is where pnpm ran postinstall scripts (native build artifacts
 *      exist only there).
 *   2. Per name, hoist the version satisfying the most requirers to the
 *      top-level node_modules; requirers whose range it fails get a nested
 *      copy in their own node_modules. A fixpoint pass resolves shadowing
 *      (an ancestor's nested copy hiding the top version a descendant
 *      needs). Root-package requirements always win a top slot.
 *   3. Copy representatives into a fresh node_modules, pruning dev-only
 *      files (.ts/.d.ts/.map/...). .md files are never pruned — dsh skills
 *      may load them at runtime.
 *
 * Works on any pnpm layout (hoisted-closure copies or isolated symlinks);
 * the representative copy is dereferenced, so the result is plain files.
 *
 * Usage: node scripts/materialize-deploy.mjs <dir>...
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Range, satisfies } from 'semver'

const PRUNE_SUFFIXES = ['.map', '.d.ts', '.tsbuildinfo', '.ts', '.cts', '.mts', '.pdb']
const ROOT = '@@root'

// Exotic specs (file:, git:, workspace:) can't be range-checked — semver 7
// returns false (not throws) for them, so detect unparseable ranges first
// and accept any installed version.
const sat = (version, range) => {
  try { new Range(range) } catch { return true }
  return satisfies(version, range)
}

// ---------------------------------------------------------------- collect

function collect(rootNm) {
  const registry = new Map()  // 'name@version' -> {name, version, deps, best:{dir,depth}}
  const depRanges = new Map() // depName -> Map(range -> Set(requirerKey))
  let instances = 0

  function visitPkg(dir, depth) {
    instances++
    let pkg
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') return
    const key = `${pkg.name}@${pkg.version}`
    let rec = registry.get(key)
    if (!rec) {
      rec = { name: pkg.name, version: pkg.version, deps: {}, best: { dir, depth } }
      registry.set(key, rec)
    } else if (depth < rec.best.depth) {
      rec.best = { dir, depth }
    }
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }
    for (const [depName, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range) continue
      if (!(depName in rec.deps)) rec.deps[depName] = range
      let byRange = depRanges.get(depName)
      if (!byRange) depRanges.set(depName, byRange = new Map())
      let set = byRange.get(range)
      if (!set) byRange.set(range, set = new Set())
      set.add(key)
    }
    visitNm(join(dir, 'node_modules'), depth + 1)
  }

  function visitNm(nm, depth) {
    let entries
    try { entries = readdirSync(nm, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.bin' || e.name === '.pnpm') continue
      if (e.name.startsWith('@')) {
        let subs
        try { subs = readdirSync(join(nm, e.name), { withFileTypes: true }) } catch { continue }
        for (const s of subs) if (s.isDirectory()) visitPkg(join(nm, e.name, s.name), depth)
      } else {
        visitPkg(join(nm, e.name), depth)
      }
    }
  }

  visitNm(rootNm, 0)
  return { registry, depRanges, instances }
}

// ------------------------------------------------------------------- plan

function plan(registry, depRanges, rootDeps) {
  const versionsOf = new Map() // name -> [rec]
  for (const rec of registry.values()) {
    let list = versionsOf.get(rec.name)
    if (!list) versionsOf.set(rec.name, list = [])
    list.push(rec)
  }
  const reqsOf = new Map() // depName -> [{from, range}]
  for (const [depName, byRange] of depRanges) {
    const list = []
    for (const [range, froms] of byRange) for (const from of froms) list.push({ from, range })
    reqsOf.set(depName, list)
  }
  for (const [depName, range] of Object.entries(rootDeps)) {
    if (!reqsOf.has(depName)) reqsOf.set(depName, [])
    reqsOf.get(depName).push({ from: ROOT, range })
  }

  // top version per name: satisfies the most requirer/range pairs
  const top = new Map()
  for (const [name, recs] of versionsOf) {
    const list = reqsOf.get(name) ?? []
    let best = recs[0], bestScore = -1
    for (const rec of recs) {
      let score = 0
      for (const { range } of list) if (sat(rec.version, range)) score++
      if (score > bestScore) { bestScore = score; best = rec }
    }
    top.set(name, best)
  }

  // nested[key][depName] = version — a copy placed inside key's own
  // node_modules because the resolution path (own → ancestors → top)
  // would otherwise first hit an incompatible version.
  const nested = new Map()
  const planFor = key => {
    let m = nested.get(key)
    if (!m) nested.set(key, m = new Map())
    return m
  }
  const satisfying = (name, range) => {
    for (const rec of versionsOf.get(name) ?? []) if (sat(rec.version, range)) return rec
    return null
  }
  const parentsOf = key => {
    const rec = registry.get(key)
    if (!rec) return []
    const out = []
    for (const [parentKey, p] of nested) {
      if (parentKey !== ROOT && p.get(rec.name) === rec.version) out.push(parentKey)
    }
    return out
  }
  // effective version of depName on every ancestor chain of fromKey:
  // a version string, or null when the chain reaches the top slot
  const firstHits = (fromKey, depName) => {
    const out = []
    const seen = new Set([fromKey])
    const walk = key => {
      for (const p of parentsOf(key)) {
        if (seen.has(p)) continue
        seen.add(p)
        const hit = nested.get(p)?.get(depName)
        if (hit !== undefined) { out.push(hit); continue }
        walk(p)
      }
    }
    walk(fromKey)
    return out
  }

  let changed = true, guard = 0
  while (changed && guard++ < 100) {
    changed = false
    for (const [depName, list] of reqsOf) {
      for (const { from, range } of list) {
        if (from !== ROOT && nested.get(from)?.has(depName)) continue // own copy satisfies
        if (from === ROOT) {
          const rec = top.get(depName)
          if (!rec || !sat(rec.version, range)) {
            const v = satisfying(depName, range)
            if (v) { top.set(depName, v); changed = true }
            else console.warn(`materialize: no installed ${depName} satisfies "${range}" (deploy root)`)
          }
          continue
        }
        const eff = firstHits(from, depName) // empty = plain top-level requirer
        const topRec = top.get(depName)
        const ok = eff.length
          ? eff.every(v => v !== null && sat(v, range))
          : !!topRec && sat(topRec.version, range)
        if (!ok) {
          const v = satisfying(depName, range)
          if (v) { planFor(from).set(depName, v.version); changed = true }
          else console.warn(`materialize: no installed ${depName} satisfies "${range}" for ${from}`)
        }
      }
    }
  }
  return { top, nested }
}

// ------------------------------------------------------------------ copy

const namePath = name => (name.startsWith('@') ? join(...name.split('/')) : name)

// Copies a directory tree, pruning dev-only files and dereferencing
// symlinks. fs.cpSync's filter is unusable here: Node keeps calling it for
// descendants of rejected directories and copies any that return true, so
// skipped nested deps would resurrect their whole closure into the output.
function copyTree(src, dest, rec, counters, isPkgRoot) {
  let entries
  try { entries = readdirSync(src, { withFileTypes: true }) } catch { return }
  mkdirSync(dest, { recursive: true })
  for (const e of entries) {
    if (isPkgRoot && e.name === 'node_modules') {
      // Everything the package resolved inside its own node_modules is
      // re-planned by the flattener (top-level or nested copies). pnpm's
      // hoisted deploy also materializes undeclared phantom/peer entries
      // here — copying any of them wholesale would resurrect whole dep
      // closures. Skipping all of them is safe: the plan places every
      // package name found anywhere in the tree (top level), so phantom
      // requires still resolve. Truly vendored node_modules deeper inside
      // package content are not affected and are copied wholesale.
      continue
    }
    const s = join(src, e.name)
    const d = join(dest, e.name)
    if (e.isDirectory()) {
      copyTree(s, d, rec, counters, false)
    } else if (e.isSymbolicLink()) {
      let st
      try { st = statSync(s) } catch { continue } // broken link
      if (PRUNE_SUFFIXES.some(x => e.name.endsWith(x))) { counters.pruned++; continue }
      if (st.isDirectory()) copyTree(s, d, rec, counters, false)
      else copyFileSync(s, d)
    } else if (e.isFile()) {
      if (PRUNE_SUFFIXES.some(x => e.name.endsWith(x))) { counters.pruned++; continue }
      copyFileSync(s, d)
    }
  }
}

function copyPruned(rec, dest, counters) {
  copyTree(rec.best.dir, dest, rec, counters, true)
}

// ---------------------------------------------------------------- flatten

for (const root of process.argv.slice(2)) {
  const nm = join(root, 'node_modules')
  const { registry, depRanges, instances } = collect(nm)
  if (registry.size === 0) {
    console.log(`flattened: ${root} (no node_modules — skipped)`)
    continue
  }
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const rootDeps = { ...rootPkg.dependencies, ...rootPkg.optionalDependencies }
  const { top, nested } = plan(registry, depRanges, rootDeps)

  const counters = { pruned: 0, nestedCopies: 0 }
  const staging = `${nm}.flat`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  // BFS over the placement tree; a key nested under several parents is
  // copied per parent, mirroring npm's layout for version conflicts.
  const queue = []
  for (const [name, rec] of top) {
    const dir = join(staging, namePath(name))
    copyPruned(rec, dir, counters)
    queue.push({ key: `${rec.name}@${rec.version}`, dir, ancestors: new Set() })
  }
  let qi = 0
  while (qi < queue.length) {
    const { key, dir, ancestors } = queue[qi++]
    const p = nested.get(key)
    if (!p) continue
    for (const [depName, v] of p) {
      const childKey = `${depName}@${v}`
      if (ancestors.has(childKey)) { console.warn(`materialize: nesting cycle at ${childKey} under ${key}; skipped`); continue }
      const rec = registry.get(childKey)
      if (!rec) { console.warn(`materialize: missing ${childKey} planned for ${key}`); continue }
      const childDir = join(dir, 'node_modules', namePath(depName))
      copyPruned(rec, childDir, counters)
      counters.nestedCopies++
      queue.push({ key: childKey, dir: childDir, ancestors: new Set([...ancestors, key]) })
    }
  }

  rmSync(nm, { recursive: true, force: true })
  renameSync(staging, nm)
  console.log(`flattened: ${root} (${registry.size} unique packages from ${instances} instances, ${top.size} top + ${counters.nestedCopies} nested copies, ${counters.pruned} files pruned)`)
}
