/**
 * Instruction-contract tests (`genui-schema.ts`): strict validation anchors
 * (genui-agui-optimization.md G1) and the send-back gate (G2). The malformed
 * paths must fail LOUDLY (tool error the model retries from) while absent
 * optional fields stay legal (client-side per-field degradation).
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateUiSendBack,
  INSTRUCTION_CAPS,
  normalizeRevision,
  parseUiSendBack,
  RevisionRegistry,
  validateInstruction,
} from './genui-schema.ts'

describe('validateInstruction', () => {
  it('accepts well-formed instructions of every component', () => {
    expect(validateInstruction({
      id: 'sales-2026',
      target: 'inline',
      component: 'chart',
      props: { chartType: 'bar', xKey: 'm', series: [{ key: 'v' }] },
      data: { items: [{ m: '1', v: 2 }] },
      summary: '月度销量',
      revision: 3,
      provenance: '来源：本轮读取的 sales.csv（工具 get_file）',
    })).toEqual([])
    expect(validateInstruction({ id: 'f', component: 'form', props: { fields: [{ id: 'a', label: 'A', type: 'text' }] }, summary: 's' })).toEqual([])
    expect(validateInstruction({ id: 't', component: 'table', props: { columns: [{ key: 'k', label: 'K' }] }, data: { rows: [{ k: 1 }] }, summary: 's' })).toEqual([])
    expect(validateInstruction({ id: 'm', component: 'metrics', props: { items: [{ key: 'x', label: 'X' }] }, data: { values: { x: 1 } }, summary: 's' })).toEqual([])
  })

  it('passes when optional containers are absent (client degrades instead)', () => {
    expect(validateInstruction({ id: 'bare', component: 'chart', summary: 's' })).toEqual([])
    expect(validateInstruction({ id: 'bare', component: 'form', props: undefined, summary: 's' })).toEqual([])
    expect(validateInstruction({ id: 'bare', component: 'table', props: { columns: null }, data: { rows: null }, summary: 's' })).toEqual([])
  })

  it('rejects unknown components and bad identity fields', () => {
    expect(validateInstruction({ id: 'x', component: 'slider', summary: 's' })).toContainEqual(
      expect.stringMatching(/component must be one of/),
    )
    expect(validateInstruction({ id: '', component: 'form', summary: 's' })).toContainEqual(expect.stringMatching(/id must be/))
    expect(validateInstruction({ id: 42, component: 'form', summary: 's' })).toContainEqual(expect.stringMatching(/id must be/))
    expect(validateInstruction({ id: 'x', component: 'form', target: 'popup', summary: 's' })).toContainEqual(
      expect.stringMatching(/target must be/),
    )
  })

  it('rejects malformed revision values but accepts absent ones', () => {
    expect(validateInstruction({ id: 'x', component: 'form', summary: 's' })).toEqual([])
    expect(validateInstruction({ id: 'x', component: 'form', revision: 0, summary: 's' })).toContainEqual(
      expect.stringMatching(/revision must be/),
    )
    expect(validateInstruction({ id: 'x', component: 'form', revision: 1.5, summary: 's' })).toContainEqual(
      expect.stringMatching(/revision must be/),
    )
    expect(validateInstruction({ id: 'x', component: 'form', revision: '2', summary: 's' })).toContainEqual(
      expect.stringMatching(/revision must be/),
    )
  })

  it('rejects wrapped-array defects with the shape description (host gate parity)', () => {
    const errors = validateInstruction({ id: 'x', component: 'form', props: { fields: { item: [] } }, summary: 's' })
    expect(errors.join('\n')).toMatch(/props\.fields of "form" must be a plain JSON array.*keys \["item"\]/s)
    expect(validateInstruction({ id: 'x', component: 'chart', props: { series: { item: [] } }, summary: 's' }).join('\n'))
      .toMatch(/props\.series of "chart"/)
    expect(validateInstruction({ id: 'x', component: 'metrics', props: { items: 'oops' }, summary: 's' }).join('\n'))
      .toMatch(/props\.items of "metrics" must be a plain JSON array, got a string/)
  })

  it('enforces the per-component quantity caps', () => {
    const fields = Array.from({ length: INSTRUCTION_CAPS.formFields + 1 }, (_, i) => ({ id: `f${i}`, label: 'F', type: 'text' }))
    expect(validateInstruction({ id: 'x', component: 'form', props: { fields }, summary: 's' }).join('\n'))
      .toMatch(new RegExp(`exceeds the cap of ${INSTRUCTION_CAPS.formFields} fields`))

    const rows = Array.from({ length: INSTRUCTION_CAPS.tableRows + 1 }, (_, i) => ({ k: i }))
    expect(validateInstruction({ id: 'x', component: 'table', data: { rows }, summary: 's' }).join('\n'))
      .toMatch(new RegExp(`exceeds the cap of ${INSTRUCTION_CAPS.tableRows} rows`))

    const series = Array.from({ length: INSTRUCTION_CAPS.chartSeries + 1 }, (_, i) => ({ key: `s${i}` }))
    expect(validateInstruction({ id: 'x', component: 'chart', props: { series }, summary: 's' }).join('\n'))
      .toMatch(new RegExp(`exceeds the cap of ${INSTRUCTION_CAPS.chartSeries} series`))

    const items = Array.from({ length: INSTRUCTION_CAPS.metricsItems + 1 }, (_, i) => ({ key: `m${i}`, label: 'M' }))
    expect(validateInstruction({ id: 'x', component: 'metrics', props: { items }, summary: 's' }).join('\n'))
      .toMatch(new RegExp(`exceeds the cap of ${INSTRUCTION_CAPS.metricsItems} items`))
  })

  it('caps the provenance declaration', () => {
    const long = 'x'.repeat(INSTRUCTION_CAPS.provenanceChars + 1)
    expect(validateInstruction({ id: 'x', component: 'form', provenance: long, summary: 's' })).toContainEqual(
      expect.stringMatching(/provenance must be ≤/),
    )
    expect(validateInstruction({ id: 'x', component: 'form', provenance: 3, summary: 's' })).toContainEqual(
      expect.stringMatching(/provenance must be a string/),
    )
  })
})

describe('RevisionRegistry', () => {
  it('records monotonic latest revisions per session and id', () => {
    const registry = new RevisionRegistry()
    registry.record('s1', 'ui-a', 1)
    registry.record('s1', 'ui-a', 3)
    registry.record('s1', 'ui-a', 2) // late-arriving lower revision never regresses
    expect(registry.latest('s1', 'ui-a')).toBe(3)
    registry.record('s1', 'ui-b', 1)
    expect(registry.latest('s1', 'ui-b')).toBe(1)
  })

  it('scopes revisions per session and drops a disposed session', () => {
    const registry = new RevisionRegistry()
    registry.record('s1', 'ui-a', 2)
    registry.record('s2', 'ui-a', 1)
    expect(registry.latest('s2', 'ui-a')).toBe(1)
    registry.dropSession('s1')
    expect(registry.latest('s1', 'ui-a')).toBeUndefined()
    expect(registry.latest('s2', 'ui-a')).toBe(1)
  })

  it('normalizes invalid revisions to 1', () => {
    expect(normalizeRevision(undefined)).toBe(1)
    expect(normalizeRevision(0)).toBe(1)
    expect(normalizeRevision('2')).toBe(1)
    expect(normalizeRevision(4)).toBe(4)
  })
})

describe('parseUiSendBack / evaluateUiSendBack (G2 contract)', () => {
  const envelope = (id: string, revision: number, payload: unknown = { component: 'form', event: 'submit', payload: { a: 1 } }): string =>
    `@[ui:${id}:${revision}] ${JSON.stringify(payload)}`

  it('parses well-formed send-backs and passes ordinary text through', () => {
    expect(parseUiSendBack(envelope('sales-chart', 2))).toMatchObject({ id: 'sales-chart', revision: 2 })
    expect(parseUiSendBack('帮我把下载目录整理一下')).toBeUndefined()
  })

  it('marks send-back-shaped text that fails the strict envelope as malformed', () => {
    expect(parseUiSendBack('@[ui:sales-chart:notanumber] {}')).toBe('malformed')
    expect(parseUiSendBack('@[ui:sales-chart:2] not-json')).toBe('malformed')
    expect(parseUiSendBack('@[ui:sales-chart:2] [1,2]')).toBe('malformed') // payload must be an object
    expect(parseUiSendBack('@[ui:sales-chart:2] {"truncated":')).toBe('malformed')
    expect(parseUiSendBack('@[ui::2] {}')).toBe('malformed')
  })

  it('delivers ordinary text and current-revision send-backs', () => {
    expect(evaluateUiSendBack('普通消息', () => undefined)).toEqual({ action: 'deliver' })
    expect(evaluateUiSendBack(envelope('ui-a', 3), () => 3)).toEqual({ action: 'deliver' })
  })

  it('rejects stale, unknown, and future revisions without feeding the model', () => {
    expect(evaluateUiSendBack(envelope('ui-a', 2), () => 3)).toEqual({ action: 'reject', reason: 'stale' })
    expect(evaluateUiSendBack(envelope('ui-a', 1), () => undefined)).toEqual({ action: 'reject', reason: 'unknown-ui' })
    expect(evaluateUiSendBack(envelope('ui-a', 9), () => 3)).toEqual({ action: 'reject', reason: 'future-revision' })
    expect(evaluateUiSendBack('@[ui:ui-a:x] {}', () => 3)).toEqual({ action: 'reject', reason: 'malformed' })
  })
})
