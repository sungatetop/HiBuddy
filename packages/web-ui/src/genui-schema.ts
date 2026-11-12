/**
 * Generative-UI instruction contract (ADR-007 §3.2 as extended by
 * genui-agui-optimization.md G1/G2) — the single definition point shared by
 * the host half (strict gate in `render_ui.execute`, revision registry, butler
 * send-back check) and the client half (streaming projection, send-back
 * envelope). Pure data + pure functions: no dsh/cordis imports, so both faces
 * can depend on it.
 *
 * Strictness philosophy (borrowed from JEV, without its domain model): the
 * instruction is untrusted model output — every constraint violation here
 * settles as a tool error the model reads and retries from (host) or degrades
 * to the static summary fallback (client). Absent optional fields stay legal
 * (the client degrades per-field); PRESENT-but-malformed fields are errors.
 */

/** Keys of the P0 trusted-component registry (client `genui/registry.tsx`). */
export const COMPONENT_KEYS = ['chart', 'form', 'table', 'metrics'] as const
export type UiComponentKey = (typeof COMPONENT_KEYS)[number]

/** Quantity caps (strict, model-teaching; tuned per genui-agui-optimization.md G1). */
export const INSTRUCTION_CAPS = {
  /** form: props.fields entries. */
  formFields: 20,
  /** table: data.rows entries. */
  tableRows: 100,
  /** chart: props.series entries. */
  chartSeries: 8,
  /** metrics: props.items entries. */
  metricsItems: 12,
  /** provenance declaration length (soft contract, hard cap). */
  provenanceChars: 500,
} as const

/** The plain-data shape of one render_ui instruction (as the tool receives it). */
export interface InstructionShape {
  readonly id: unknown
  readonly revision?: unknown
  readonly target?: unknown
  readonly component?: unknown
  readonly props?: unknown
  readonly data?: unknown
  readonly provenance?: unknown
  readonly summary?: unknown
}

/** Normalize the revision: absent/invalid → 1 (pre-revision instructions stay compatible). */
export function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1
}

/** Human-readable shape description for validation error messages. */
function describeShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const head = keys.slice(0, 5).map((key) => JSON.stringify(key)).join(', ')
    return `an object with keys [${head}${keys.length > 5 ? ', …' : ''}]`
  }
  return `a ${typeof value}`
}

/** True when `value` is a plain JSON object (null/array excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strict instruction validation (G1). Returns the error list — empty means
 * valid. Absent optional containers pass (client degrades); present-but-
 * wrong-shape fields, unknown components, and over-cap arrays fail. The
 * caller throws with a teaching message so the model can self-correct.
 */
export function validateInstruction(instruction: InstructionShape): string[] {
  const errors: string[] = []
  if (typeof instruction.id !== 'string' || instruction.id.length === 0 || instruction.id.length > 128) {
    errors.push('id must be a non-empty string (≤128 chars)')
  }
  if (instruction.revision !== undefined
    && !(typeof instruction.revision === 'number' && Number.isInteger(instruction.revision) && instruction.revision >= 1)) {
    errors.push('revision must be an integer ≥ 1 (omit it for a first render; re-emits of the same id increment it)')
  }
  if (instruction.target !== undefined && instruction.target !== 'inline' && instruction.target !== 'canvas') {
    errors.push('target must be "inline" or "canvas"')
  }
  if (typeof instruction.provenance === 'string' && instruction.provenance.length > INSTRUCTION_CAPS.provenanceChars) {
    errors.push(`provenance must be ≤ ${INSTRUCTION_CAPS.provenanceChars} chars`)
  } else if (instruction.provenance !== undefined && typeof instruction.provenance !== 'string') {
    errors.push('provenance must be a string (one sentence naming the data source)')
  }
  const component = instruction.component
  if (component !== undefined && !COMPONENT_KEYS.includes(component as UiComponentKey)) {
    errors.push(`component must be one of ${COMPONENT_KEYS.join(' | ')}, got ${JSON.stringify(component)}`)
    return errors // further checks are per-component
  }
  const props = isRecord(instruction.props) ? instruction.props : undefined
  const data = isRecord(instruction.data) ? instruction.data : undefined
  if (component === 'chart') {
    const series = props?.series
    if (series !== undefined && series !== null) {
      if (!Array.isArray(series)) errors.push(`props.series of "chart" must be a plain JSON array, got ${describeShape(series)}`)
      else if (series.length > INSTRUCTION_CAPS.chartSeries) {
        errors.push(`props.series of "chart" exceeds the cap of ${INSTRUCTION_CAPS.chartSeries} series`)
      }
    }
    const items = data?.items
    if (items !== undefined && items !== null && !Array.isArray(items)) {
      errors.push(`data.items of "chart" must be a plain JSON array, got ${describeShape(items)}`)
    }
  }
  if (component === 'form') {
    const fields = props?.fields
    if (fields !== undefined && fields !== null) {
      if (!Array.isArray(fields)) errors.push(`props.fields of "form" must be a plain JSON array, got ${describeShape(fields)}`)
      else if (fields.length > INSTRUCTION_CAPS.formFields) {
        errors.push(`props.fields of "form" exceeds the cap of ${INSTRUCTION_CAPS.formFields} fields`)
      }
    }
  }
  if (component === 'table') {
    const columns = props?.columns
    if (columns !== undefined && columns !== null && !Array.isArray(columns)) {
      errors.push(`props.columns of "table" must be a plain JSON array, got ${describeShape(columns)}`)
    }
    const rows = data?.rows
    if (rows !== undefined && rows !== null) {
      if (!Array.isArray(rows)) errors.push(`data.rows of "table" must be a plain JSON array, got ${describeShape(rows)}`)
      else if (rows.length > INSTRUCTION_CAPS.tableRows) {
        errors.push(`data.rows of "table" exceeds the cap of ${INSTRUCTION_CAPS.tableRows} rows`)
      }
    }
  }
  if (component === 'metrics') {
    const items = props?.items
    if (items !== undefined && items !== null) {
      if (!Array.isArray(items)) errors.push(`props.items of "metrics" must be a plain JSON array, got ${describeShape(items)}`)
      else if (items.length > INSTRUCTION_CAPS.metricsItems) {
        errors.push(`props.items of "metrics" exceeds the cap of ${INSTRUCTION_CAPS.metricsItems} items`)
      }
    }
  }
  return errors
}

/**
 * Host-side revision registry (G1/G2): the `render_ui` execute body records
 * `session → id → latest revision`; the butler pump reads the same registry
 * (shared as the `hibuddy-genui-revisions` cordis service) to reject stale
 * send-backs before they reach the model. Max-wins per id so a late-arriving
 * lower revision can never regress the gate.
 */
export class RevisionRegistry {
  readonly #sessions = new Map<string, Map<string, number>>()

  /** Record one accepted instruction revision (monotonic per session+id). */
  record(sessionId: string, id: string, revision: number): number {
    let ids = this.#sessions.get(sessionId)
    if (ids === undefined) {
      ids = new Map()
      this.#sessions.set(sessionId, ids)
    }
    const normalized = normalizeRevision(revision)
    const current = ids.get(id)
    if (current === undefined || normalized > current) ids.set(id, normalized)
    return ids.get(id)!
  }

  /** Latest known revision of one id (undefined = never rendered in this session). */
  latest(sessionId: string, id: string): number | undefined {
    return this.#sessions.get(sessionId)?.get(id)
  }

  /** The session is gone — drop its state (session-scoped, in-memory). */
  dropSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }
}

/** One parsed `@[ui:<id>:<revision>] {payload}` send-back (G2 contract). */
export interface UiSendBack {
  readonly id: string
  readonly revision: number
  readonly payload: unknown
}

/** Send-back envelope prefix: `@[ui:<id>:<revision>]` followed by one JSON object. */
const SEND_BACK_PATTERN = /^@\[ui:([A-Za-z0-9_-]{1,128}):(\d+)\]\s*(\{[\s\S]*\})$/

/**
 * Parse one text as a UI send-back (G2). Returns undefined when the text is
 * NOT a send-back (ordinary user text — deliver as-is). A text that STARTS
 * like a send-back but fails the strict shape is returned as a malformed
 * marker so the host can reject it without feeding the model.
 */
export function parseUiSendBack(text: string): UiSendBack | undefined | 'malformed' {
  if (!text.startsWith('@[ui:')) return undefined
  const match = SEND_BACK_PATTERN.exec(text.trim())
  if (match === null) return 'malformed'
  const [, id, revision, payload] = match as unknown as [string, string, string, string]
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!isRecord(parsed)) return 'malformed'
    return { id, revision: normalizeRevision(Number(revision)), payload: parsed }
  } catch {
    return 'malformed'
  }
}

/** Verdict of the host send-back gate (G2): deliver into the turn, or reject with a reason. */
export type UiSendBackVerdict =
  | { readonly action: 'deliver' }
  | { readonly action: 'reject'; readonly reason: 'malformed' | 'unknown-ui' | 'stale' | 'future-revision' }

/**
 * The host gate over one inbound text (G2): ordinary text delivers; a
 * well-formed send-back delivers only when its revision matches the latest
 * known revision of that id — stale/unknown/future revisions and malformed
 * envelopes are rejected WITHOUT reaching the model (the host answers the
 * user with a visible notice instead).
 * @param latestOf - revision lookup for one instruction id (undefined = never rendered).
 */
export function evaluateUiSendBack(text: string, latestOf: (id: string) => number | undefined): UiSendBackVerdict {
  const parsed = parseUiSendBack(text)
  if (parsed === undefined) return { action: 'deliver' }
  if (parsed === 'malformed') return { action: 'reject', reason: 'malformed' }
  const latest = latestOf(parsed.id)
  if (latest === undefined) return { action: 'reject', reason: 'unknown-ui' }
  if (parsed.revision < latest) return { action: 'reject', reason: 'stale' }
  if (parsed.revision > latest) return { action: 'reject', reason: 'future-revision' }
  return { action: 'deliver' }
}
