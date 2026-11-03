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

/** Component keys of the P0 registry (client `genui/registry.tsx` mirrors this). */
const COMPONENT_ENUM = ['chart', 'form', 'table', 'metrics'] as const

/** Component inventory + per-component prop/data shapes, model-facing. */
const COMPONENT_SPECS = [
  'chart — a data chart. props: { chartType: "bar" | "line" | "pie", xKey: string, series: [{ key: string, label?: string }] }. data: { items: [{ [xKey]: string, [seriesKey]: number }] } (array of rows).',
  'form — an interactive form. props: { fields: [{ id: string, label: string, type: "text" | "number" | "select" | "checkbox", required?: boolean, options?: string[], placeholder?: string }], submitLabel?: string, description?: string }. data: {} (empty).',
  'table — a data table. props: { columns: [{ key: string, label: string }], maxRows?: number }. data: { rows: [{ [key]: string | number }] }.',
  'metrics — a row of KPI cards. props: { items: [{ key: string, label: string, unit?: string }] }. data: { values: { [key]: number } }.',
].join('\n')

/** Model-facing description: when to reach for this tool and how to fill it. */
const TOOL_DESCRIPTION = [
  'Render an interactive UI panel (chart, form, table, or metrics row) for the user, inside the chat or as a side canvas.',
  'Use it whenever the answer is better shown than told: comparisons and trends → chart; structured rows → table; KPIs → metrics;',
  'and whenever you need structured user input back → form (the user\'s submission returns to you as their next message).',
  'Do NOT emit UI code or markdown code fences for this — call this tool once with the complete instruction.',
  'Order the JSON keys as listed (id, target, title, component, props, data, summary) so lightweight fields arrive first during streaming.',
  'Components available:',
  COMPONENT_SPECS,
].join('\n')

/** Registry-ready definition; registered per agent scope in the host half. */
export const renderUiTool = defineTool({
  name: 'render_ui',
  description: TOOL_DESCRIPTION,
  parameters: {
    id: {
      type: 'string',
      required: true,
      description: 'Stable instance id, lowercase-kebab (e.g. "sales-2026-chart"). Calling again with the same id updates that surface (a canvas bumps its version); a new id creates a new one.',
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
    summary: {
      type: 'string',
      required: true,
      description: 'One-sentence human-readable summary of what the surface shows — the accessible fallback and audit line.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', enum: [true], required: true, description: 'The instruction was accepted for rendering.' },
        id: { type: 'string', required: true, description: 'Echo of the instruction id.' },
        note: { type: 'string', description: 'Optional delivery note (e.g. canvas opened).' },
      },
    },
    render: (args, value) => [
      {
        type: 'text' as const,
        text: `UI "${value.id}" (${args.component}) accepted${value.note !== undefined ? ` — ${value.note}` : ''}.`,
      },
    ],
  },
  async execute(args) {
    // No-op by design (ADR-007 §3.2): rendering is a client-side effect keyed
    // by the tool call; the canonical value only confirms acceptance.
    return { ok: true as const, id: args.id }
  },
})
