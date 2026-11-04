/**
 * Host-side shape gate tests (`assertPlainArrays`): the MiniMax M2.x wrapped-
 * array defect (`{"item": [...]}`) must settle as a tool error at the host,
 * never reach the client surfaces (S4-6 E2E finding).
 */
import { describe, expect, it } from 'vitest'
import { assertPlainArrays } from './render-ui-tool.ts'

describe('assertPlainArrays', () => {
  it('accepts plain-array shapes per component', () => {
    expect(() => assertPlainArrays('form', { fields: [{ id: 'a', label: 'A', type: 'text' }] }, undefined)).not.toThrow()
    expect(() => assertPlainArrays('chart', { chartType: 'bar', xKey: 'm', series: [{ key: 'v' }] }, { items: [{ m: '1', v: 2 }] })).not.toThrow()
    expect(() => assertPlainArrays('table', { columns: [{ key: 'k', label: 'K' }] }, { rows: [{ k: 1 }] })).not.toThrow()
    expect(() => assertPlainArrays('metrics', { items: [{ key: 'x', label: 'X' }] }, { values: { x: 1 } })).not.toThrow()
  })

  it('passes when containers or fields are absent (client degrades instead)', () => {
    expect(() => assertPlainArrays('form', undefined, undefined)).not.toThrow()
    expect(() => assertPlainArrays('chart', { chartType: 'bar' }, undefined)).not.toThrow()
    expect(() => assertPlainArrays('unknown-component', { fields: { item: [] } }, undefined)).not.toThrow()
  })

  it('rejects the wrapped-array defect with a teaching error message', () => {
    // The exact observed emission: props.fields as {"item": [...]}.
    const wrapped = { fields: { item: [{ id: 'name', label: 'N', type: 'text' }] } }
    expect(() => assertPlainArrays('form', wrapped, undefined)).toThrowError(
      /props\.fields of "form" must be a plain JSON array.*\{"item": \[\.\.\.\]\}\./s,
    )
    expect(() => assertPlainArrays('chart', { series: { item: [] } }, { items: [{ m: '1' }] })).toThrowError(/props\.series of "chart"/)
    expect(() => assertPlainArrays('chart', { series: [{ key: 'v' }] }, { items: { item: [] } })).toThrowError(/data\.items of "chart"/)
    expect(() => assertPlainArrays('table', { columns: { item: [] } }, undefined)).toThrowError(/props\.columns of "table"/)
    expect(() => assertPlainArrays('metrics', { items: { item: [] } }, undefined)).toThrowError(/props\.items of "metrics"/)
  })

  it('rejects non-object non-array field values with a shape description', () => {
    expect(() => assertPlainArrays('form', { fields: 'oops' }, undefined)).toThrowError(/got a string/)
    expect(() => assertPlainArrays('form', { fields: null }, undefined)).not.toThrow() // absent-equivalent
  })
})
