/**
 * Materialize a pnpm-deployed tree: replace every symlink with a real copy of
 * its resolved target, and prune dev-only files that the packaged runtime
 * never reads — compiled output is what runs (every package's main/exports
 * default condition points at lib/dist), so TypeScript sources (.ts/.cts/.mts,
 * incl. the .d.ts subset), source maps, build info files, and native debug
 * symbols (.pdb) are dead weight. .md files are NEVER pruned — dsh skills may
 * load them at runtime. Verified against dsh 0.2.1-rc.5 (2026-11-13): the
 * nested @deepseek-ai/* subpackages ship ~600MB of src/ that the packaged app
 * never imports (all entries → lib/index.js).
 * Usage: node scripts/materialize-deploy.mjs <dir>...
 */
import { cpSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PRUNE_SUFFIXES = ['.map', '.d.ts', '.tsbuildinfo', '.ts', '.cts', '.mts', '.pdb']

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
