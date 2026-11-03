/**
 * Minimal runtime shape guards for generative-UI surface components.
 *
 * Model-supplied props/data are untrusted by definition: each surface
 * validates its exact expected shape and THROWS on mismatch, which the
 * toolview's error boundary converts into the static fallback (SR-02
 * degradation) — a malformed instruction never renders half-garbled UI.
 */

/** Narrow to a plain object (null/array excluded). */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected a JSON object')
  }
  return value as Record<string, unknown>
}

/** Narrow to an array. */
export function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('expected a JSON array')
  return value
}

/** Narrow to a non-empty string. */
export function asString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('expected a non-empty string')
  return value
}

/** Narrow to a finite number. */
export function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('expected a finite number')
  return value
}

/** Narrow to an optional finite number. */
export function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : asNumber(value)
}

/** Narrow to an optional string. */
export function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : asString(value)
}

/** Human-readable number for tables/metrics/axes. */
export function formatNumber(value: number): string {
  if (Math.abs(value) >= 10000) return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  return String(Math.round(value * 100) / 100)
}

/** Truncate a label for axis/table display. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
