/**
 * Run Markdown export (PRD FR-08 rule 3, S5-2): render one derived run
 * timeline as a self-contained Markdown document and hand it to the browser
 * download seam. Export is an explicit user action, so full tool arguments are
 * included (SR-03: 用户显式导出除外); results stay summarized.
 */
import type { RunTimeline } from './derive.ts'

/** Locale resolver shape the exporter needs (the tab's `t`). */
export type RunExportText = (key: RunExportKey) => string

/** Copy keys the Markdown renderer consumes. */
export type RunExportKey =
  | 'export.title'
  | 'export.session'
  | 'export.startedAt'
  | 'export.endedAt'
  | 'export.prompt'
  | 'export.timeline'
  | 'export.step'
  | 'export.tool'
  | 'export.output'
  | 'export.args'
  | 'export.result'
  | 'export.error'
  | 'export.duration'
  | 'export.tokens'
  | 'export.approval'
  | 'export.interrupted'
  | 'export.noPrompt'

/** Wall-clock stamp for the file name: `20261104-210504`. */
function fileStamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Local date-time rendering inside the document. */
function stamp(at: number): string {
  return new Date(at).toLocaleString()
}

/** Human duration: `1.2s` / `2m03s`. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** Fenced block guard: keep embedded triple backticks from breaking the fence. */
function fence(text: string, language: string): string {
  const longest = text.match(/`{3,}/g)?.reduce((n, run) => Math.max(n, run.length), 2) ?? 2
  const marker = '`'.repeat(longest + 1)
  return `${marker}${language}\n${text}\n${marker}`
}

/** Render one run timeline as Markdown (status word comes from the tab locale). */
export function runMarkdown(run: RunTimeline, sessionId: string, t: RunExportText, statusText: string): string {
  const lines: string[] = []
  lines.push(`# ${t('export.title')} — Turn ${run.turn}`)
  lines.push('')
  lines.push(`- ${t('export.session')}: \`${sessionId}\``)
  lines.push(`- ${t('export.startedAt')}: ${stamp(run.startedAt)}`)
  lines.push(
    run.endedAt === undefined
      ? `- ${t('export.endedAt')}: — (${statusText})`
      : `- ${t('export.endedAt')}: ${stamp(run.endedAt)} (${statusText})`,
  )
  lines.push(`- ${t('export.prompt')}: ${run.prompt === '' ? t('export.noPrompt') : run.prompt}`)
  if (run.status.kind === 'error') lines.push(`- ${t('export.error')}: ${run.status.message}`)
  lines.push('')
  lines.push(`## ${t('export.timeline')}`)
  lines.push('')
  for (const item of run.items) {
    if (item.kind === 'step') {
      lines.push(`### ${t('export.step')} ${item.step}`)
      lines.push('')
      continue
    }
    const time = stamp(item.at)
    if (item.kind === 'prompt') {
      lines.push(`- \`${time}\` **${t('export.prompt')}**: ${item.text}`)
    } else if (item.kind === 'tool') {
      const state = item.status === 'running' ? '…' : item.status === 'error' ? `✗${item.errorReason === undefined ? '' : ` (${item.errorReason})`}` : '✓'
      const took = item.durationMs === undefined ? '' : ` — ${t('export.duration')}: ${duration(item.durationMs)}`
      lines.push(`- \`${time}\` **${t('export.tool')}** \`${item.name}\` — ${state}${took}`)
      lines.push(`  - ${t('export.args')}:`)
      lines.push(indent(fence(item.argsRaw === '' ? 'null' : safeJson(item.argsRaw), 'json'), 4))
      if (item.resultSummary !== undefined) lines.push(`  - ${t('export.result')}: ${item.resultSummary}`)
      if (item.decision !== undefined) lines.push(`  - ${t('export.approval')}: ${item.decision.decision}`)
    } else {
      const tokens = item.outputTokens === undefined ? '' : ` — ${t('export.tokens')}: ${item.outputTokens}`
      const marker = item.interrupted === true ? ` (${t('export.interrupted')})` : ''
      lines.push(`- \`${time}\` **${t('export.output')}**${marker}${tokens}:`)
      lines.push('')
      lines.push(indent(fence(item.text === '' ? '…' : item.text, ''), 4))
      lines.push('')
    }
    // TS has narrowed `item` to the non-step union here; every content row is
    // followed by a blank line to keep list items visually separated.
    lines.push('')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Parse-or-echo for the raw argument JSON (unparsable model output stays visible). */
function safeJson(argsRaw: string): string {
  try {
    return JSON.stringify(JSON.parse(argsRaw), null, 2)
  } catch {
    return argsRaw
  }
}

/** Indent every non-empty line by `n` spaces (list-nested code fences). */
function indent(text: string, n: number): string {
  const pad = ' '.repeat(n)
  return text.split('\n').map((line) => (line === '' ? '' : pad + line)).join('\n')
}

/** Hand the rendered document to the browser download seam. */
export function downloadRunMarkdown(run: RunTimeline, sessionId: string, t: RunExportText, statusText: string): void {
  const markdown = runMarkdown(run, sessionId, t, statusText)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `hibuddy-run-${run.turn}-${fileStamp(run.startedAt)}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
