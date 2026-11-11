/**
 * Deterministic artifact scan for worker receipts (perception B12′ §5.3).
 *
 * After a successful round the orchestrator scans the ticket's working
 * directory for files the worker produced — `mtime >= startedAt - 1s`, newest
 * first, at most 20. The scan is host-side and read-only (the directory is the
 * existing sandbox write root, so no new read surface is opened):
 *
 * - skips hidden and temporary files (`.`, `~$`, `*.tmp`);
 * - skips symbolic links (an escape-proofing boundary — a worker-placed link
 *   cannot drag files from outside the working directory into a receipt);
 * - recursion is capped at depth 4 with a 200-file scan budget;
 * - any failure degrades to `[]` — a broken scan must never fail a receipt.
 *
 * The butler sees the artifact list and can forward results to the user with
 * `send_message_to_user(attachments=[{ path: ... }])` (B11′ attachment loop).
 */

import { basename, extname, join } from 'node:path'
import { lstatSync, readdirSync } from 'node:fs'
import type { ArtifactRef } from './domain.ts'
import { kindOfExtension } from './attachments.ts'

/** Recursion depth limit (design §5.3). */
const MAX_DEPTH = 4

/** Total files examined before the scan stops collecting (design §5.3). */
const MAX_SCANNED = 200

/** Artifacts listed on a receipt (design §5.3). */
const MAX_ARTIFACTS = 20

/** Hidden / temporary file names: dotfiles, Office lock files, editor temps. */
const SKIP_NAME = /^(\.|~\$)|\.tmp$/i

/** One candidate file discovered by the walk. */
interface Candidate {
  path: string
  size: number
  mtimeMs: number
}

/**
 * Scans `root` for files modified at or after `sinceMs`, newest first, capped
 * at 20 entries. Never throws: unreadable directories and files are skipped,
 * so a broken scan degrades to `[]`.
 */
export function scanArtifacts(root: string, sinceMs: number): ArtifactRef[] {
  const candidates: Candidate[] = []
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= MAX_SCANNED) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip silently
    }
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED) return
      if (SKIP_NAME.test(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      try {
        const stats = lstatSync(full)
        if (stats.mtimeMs >= sinceMs) {
          candidates.push({ path: full, size: stats.size, mtimeMs: stats.mtimeMs })
        }
      } catch {
        // unreadable/vanished file: skip
      }
    }
  }
  walk(root, 1)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, MAX_ARTIFACTS).map(({ path, size }) => ({
    name: basename(path),
    path,
    size,
    kind: kindOfExtension(extname(path)),
  }))
}
