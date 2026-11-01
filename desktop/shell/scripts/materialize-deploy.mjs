/**
 * Materialize a pnpm-deployed tree: replace every symlink with a real copy of
 * its resolved target, and prune dev-only files (.map/.d.ts/.tsbuildinfo) that
 * the packaged runtime never reads — but never .md files, which dsh skills may
 * load at runtime — so the afterPack copy and NSIS pack handle a smaller tree.
 * Usage: node scripts/materialize-deploy.mjs <dir>...
 */
import { cpSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PRUNE_SUFFIXES = ['.map', '.d.ts', '.tsbuildinfo']

function walk(dir, counters) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const target = realpathSync(full)
      rmSync(full, { recursive: true })
      // dereference: copy content, never links, so the result is fully plain files.
      cpSync(target, full, { recursive: true, dereference: true })
      counters.replaced += 1
      // The dereferenced copy can itself contain links and dev-only files —
      // process it instead of assuming it is already clean.
      walk(full, counters)
    } else if (entry.isDirectory()) {
      walk(full, counters)
    } else if (entry.isFile() && PRUNE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
      rmSync(full, { force: true })
      counters.pruned += 1
    }
  }
}

for (const root of process.argv.slice(2)) {
  // per-root counters so each log line reports its own tree, not a running total
  const counters = { replaced: 0, pruned: 0 }
  walk(root, counters)
  console.log(`materialized: ${root} (${counters.replaced} links replaced, ${counters.pruned} files pruned)`)
}
