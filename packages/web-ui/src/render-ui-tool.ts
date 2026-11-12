/**
 * The `render_ui` tool — the model's only output channel for generative UI
 * (ADR-007 §3.2: component instructions, never frontend code).
 *
 * The execution body is a no-op: the instruction echo is the model-facing
 * result, and the rendering side effect lives entirely in the client half
 * (`tool.call.toolview` keyed slot). SR-02 isolation holds because the model
 * supplies data + parameters only — the client renders them with trusted,
 * compiled-in components; no model-provided string is ever evaluated.
 *
 * Keep the description a complete teaching surface (when to use, component
 * inventory, prop/data shapes per component): it is the model's sole spec for
 * the instruction format until a skill/prompt section proves necessary.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  COMPONENT_KEYS,
  INSTRUCTION_CAPS,
  RevisionRegistry,
  normalizeRevision,
  validateInstruction,
} from './genui-schema.ts'

/** Component keys of the P0 registry (client `genui/registry.tsx` mirrors this). */
const COMPONENT_ENUM = COMPONENT_KEYS

/** Component inventory + per-component prop/data shapes, model-facing. */
const COMPONENT_SPECS = [
  'chart — a data chart. props: { chartType: "bar" | "line" | "pie", xKey: string, series: [{ key: string, label?: string }] }. data: { items: [{ [xKey]: string, [seriesKey]: number }] } (array of rows).',
  'form — an interactive form. props: { fields: [{ id: string, label: string, type: "text" | "number" | "select" | "checkbox", required?: boolean, options?: string[], placeholder?: string }], submitLabel?: string, description?: string }. data: {} (empty).',
  'table — a data table. props: { columns: [{ key: string, label: string }], maxRows?: number }. data: { rows: [{ [key]: string | number }] }.',
  'metrics — a row of KPI cards. props: { items: [{ key: string, label: string, unit?: string }] }. data: { values: { [key]: number } }.',
].join('\n')

/** Model-facing description: when to reach for this tool and how to fill it. */
export const RENDER_UI_DESCRIPTION = [
  'Render an interactive UI panel (chart, form, table, or metrics row) for the user, inside the chat or as a side canvas.',
  'Use it whenever the answer is better shown than told: comparisons and trends → chart; structured rows → table; KPIs → metrics;',
  'and whenever you need structured user input back → form (the user\'s submission returns to you as their next message).',
  'Do NOT emit UI code or markdown code fences for this — call this tool once with the complete instruction.',
  'JSON shape is strict: every array MUST be a plain JSON array written `[...]` — never wrap it in an object like {"item": [...]}.',
  'Order the JSON keys as listed (id, revision, target, title, component, props, data, summary) so lightweight fields arrive first during streaming.',
  `Quantity caps: form ≤ ${INSTRUCTION_CAPS.formFields} fields, table ≤ ${INSTRUCTION_CAPS.tableRows} rows, chart ≤ ${INSTRUCTION_CAPS.chartSeries} series, metrics ≤ ${INSTRUCTION_CAPS.metricsItems} items — paginate or summarize beyond that.`,
  'Re-emitting an instruction with the SAME id updates that surface: increment revision by 1 each time (first render may omit it).',
  'Data discipline: `data` must come from THIS turn\'s tool results, and `provenance` (one sentence, e.g. "来源：本轮读取的 sales.csv（工具 get_file）") names that source.',
  'Components available:',
  COMPONENT_SPECS,
].join('\n')

/** Model-facing parameter schema (shared by the regular-session and butler faces). */
export const RENDER_UI_PARAMETERS = {
  id: {
    type: 'string',
    required: true,
    description: 'Stable instance id, lowercase-kebab (e.g. "sales-2026-chart"). Calling again with the same id updates that surface (a canvas bumps its version); a new id creates a new one.',
  },
  revision: {
    type: 'integer',
    description: 'Update counter of this instance id: omit it (or pass 1) on the FIRST render, and pass the previous revision + 1 on every re-emit of the same id. Surfaces older than the latest revision stop accepting user interactions.',
  },
  target: {
    type: 'string',
    enum: ['inline', 'canvas'],
    required: true,
    description: '"inline" renders inside the chat flow (single-use charts/forms); "canvas" opens a persistent side panel that survives later turns (tools the user keeps operating).',
  },
  title: {
    type: 'string',
    description: 'Human-readable surface title. Required for canvas (it names the panel tab); optional for inline.',
  },
  component: {
    type: 'string',
    enum: [...COMPONENT_ENUM],
    required: true,
    description: 'Which trusted component renders the instruction. Pick per COMPONENT_SPECS below.',
  },
  props: {
    type: 'json',
    description: 'Component configuration per COMPONENT_SPECS (chartType/series, form fields, table columns, metric items).',
  },
  data: {
    type: 'json',
    description: 'The data the component consumes, per COMPONENT_SPECS. Inline it from the current task context; never reference files or external resources.',
  },
  provenance: {
    type: 'string',
    description: 'One sentence naming where `data` came from (tool + file), e.g. "来源：本轮读取的 sales.csv（工具 get_file）". Shown with the surface and in degradation/history views.',
  },
  summary: {
    type: 'string',
    required: true,
    description: 'One-sentence human-readable summary of what the surface shows — the accessible fallback and audit line.',
  },
} as const

/**
 * Per-component fields that MUST be plain JSON arrays, as `[container, key]`
 * pairs (missing container/field is the client's concern, not ours). This is
 * the host-side gate against a recurring model defect (observed on MiniMax
 * M2.x, 5/5 E2E runs): arrays systematically emitted as proto-style wrappers
 * `{"item": [...]}`. Without this gate the bad shape reaches the client and
 * SR-02 silently degrades the whole surface to static text; with it, the call
 * settles as a tool error whose message teaches the retry (plain `[...]`).
 */
const ARRAY_FIELDS: Record<string, Array<['props' | 'data', string]>> = {
  chart: [['props', 'series'], ['data', 'items']],
  form: [['props', 'fields']],
  table: [['props', 'columns'], ['data', 'rows']],
  metrics: [['props', 'items']],
}

/** Short human-readable shape description for validation error messages. */
function describeShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const head = keys.slice(0, 5).map(key => JSON.stringify(key)).join(', ')
    return `an object with keys [${head}${keys.length > 5 ? ', …' : ''}]`
  }
  return `a ${typeof value}`
}

/**
 * Host-side shape gate (see {@link ARRAY_FIELDS}): throws so the pipeline
 * settles the call as an `isError` tool result whose text the model reads and
 * self-corrects from. Absent containers/fields pass — the client surfaces
 * handle missing data with their own degradation paths (SR-02).
 */
export function assertPlainArrays(component: string, props: unknown, data: unknown): void {
  const spec = ARRAY_FIELDS[component]
  if (spec === undefined) return // unknown component: client degrades statically
  for (const [container, key] of spec) {
    const holder = container === 'props' ? props : data
    if (holder === null || typeof holder !== 'object') continue
    const value = (holder as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue // absent-equivalent: client degrades
    if (!Array.isArray(value)) {
      throw new TypeError(
        `render_ui validation failed: ${container}.${key} of "${component}" must be a plain JSON array [...] but got ${describeShape(value)}. `
        + 'NEVER wrap arrays in objects like {"item": [...]}. Re-emit the instruction with every array written directly as [...].',
      )
    }
  }
}

/** Registry-ready definition factory; registered per agent scope in the host half. */
export function createRenderUiTool(revisions: RevisionRegistry) {
  return defineTool({
    name: 'render_ui',
    description: RENDER_UI_DESCRIPTION,
    parameters: RENDER_UI_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', enum: [true], required: true, description: 'The instruction was accepted for rendering.' },
          id: { type: 'string', required: true, description: 'Echo of the instruction id.' },
          revision: { type: 'integer', required: true, description: 'The revision recorded for this instruction.' },
          note: { type: 'string', description: 'Optional delivery note (e.g. canvas opened).' },
        },
      },
      render: (args, value) => [
        {
          type: 'text' as const,
          text: `UI "${value.id}" (${args.component}, revision ${value.revision}) accepted${value.note !== undefined ? ` — ${value.note}` : ''}.`,
        },
      ],
    },
    async execute(args, exec) {
      // Host-side shape gate first (see ARRAY_FIELDS): a wrapped-array emission
      // settles as a tool error the model reads and retries from, instead of
      // reaching the client and silently degrading the surface (SR-02).
      assertPlainArrays(args.component, args.props, args.data)
      // Strict contract gate (G1): unknown components, over-cap arrays, and
      // malformed optional fields settle as a teaching tool error. Absent
      // optional fields stay legal (client degrades per-field).
      const errors = validateInstruction(args)
      if (errors.length > 0) {
        throw new TypeError(
          `render_ui validation failed: ${errors.join('; ')}. Fix the listed fields and re-emit the complete instruction.`,
        )
      }
      // Revision registration (G1/G2): the host records id → latest revision
      // per session; the butler pump reads the same registry to reject stale
      // `@[ui:…]` send-backs before they reach the model. Session-scoped: a
      // sessionless execution has no send-back gate to serve.
      const revision = normalizeRevision(args.revision)
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined) revisions.record(sessionId, args.id, revision)
      // No-op by design (ADR-007 §3.2): rendering is a client-side effect keyed
      // by the tool call; the canonical value only confirms acceptance.
      return { ok: true as const, id: args.id, revision }
    },
  })
}
