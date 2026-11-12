/**
 * Generative-UI shared skin (frontend-design pass, 2026-11-12).
 *
 * The surfaces style themselves with inline dsh theme tokens — that base must
 * work without any CSS pipeline. This module layers a small, scoped stylesheet
 * on top: state feedback (focus rings, row hover, pointer affordances), depth
 * (one restrained elevation step), a shared entrance, and per-component accent
 * wiring. Everything maps dsh tokens — no hardcoded palette colors — so it
 * follows the shell's light/dark themes. CSS is authored statically here and
 * never derived from model output (SR-02).
 *
 * Contract: each card root carries `data-hibuddy-genui` + class `hg-card` and
 * an inline `--hg-accent` (from `componentAccent`); surfaces add the `hg-*`
 * classes documented below. Render `<GenuiSkin />` once per card.
 */
import { type CSSProperties, type ReactNode } from 'react'

/**
 * Per-component accent (Okabe-Ito-adjacent, mirrors the chart palette so the
 * badge dot, focus ring and metric hairline all echo the data color).
 */
const ACCENTS: Record<string, string> = {
  chart: '#4e79a7',
  form: '#59a14f',
  table: '#76b7b2',
  metrics: '#f28e2b',
}

/** Accent of one component key; unknown keys get a neutral gray. */
export function componentAccent(component: string | undefined): string {
  if (component === undefined) return '#8a8a8a'
  return ACCENTS[component] ?? '#8a8a8a'
}

/**
 * Accent custom prop for a card root (spread into the root's style so the
 * scoped skin CSS can read it).
 */
export function accentStyle(component: string | undefined): CSSProperties {
  return { '--hg-accent': componentAccent(component) } as CSSProperties
}

const CSS = `
[data-hibuddy-genui].hg-card {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 4%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent);
  transition: box-shadow .2s ease, border-color .2s ease;
  animation: hg-enter .28s ease-out;
}
[data-hibuddy-genui].hg-card:hover {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent);
}
@keyframes hg-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  [data-hibuddy-genui].hg-card { animation: none; transition: none; }
}
[data-hibuddy-genui] .hg-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
[data-hibuddy-genui] .hg-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--hg-accent, #8a8a8a);
  flex: none;
}
[data-hibuddy-genui] .hg-provenance {
  margin: 0;
  padding-left: 10px;
  border-left: 2px solid color-mix(in srgb, var(--hg-accent, #8a8a8a) 45%, transparent);
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}
[data-hibuddy-genui] .hg-raw {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 6%, transparent);
  scrollbar-width: thin;
}
/* form: focus + affordance (inline styles stay the no-skin base) */
[data-hibuddy-genui] .hg-control:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hg-accent, #4e79a7) 55%, transparent);
  outline-offset: 1px;
  border-color: var(--hg-accent, #4e79a7);
}
[data-hibuddy-genui] .hg-control {
  transition: border-color .15s ease, background .15s ease;
}
[data-hibuddy-genui] .hg-control:hover {
  border-color: color-mix(in srgb, var(--hg-accent, #4e79a7) 55%, var(--dsw-specific-input-major));
}
[data-hibuddy-genui] .hg-submit {
  transition: filter .15s ease, transform .05s ease;
}
[data-hibuddy-genui] .hg-submit:hover { filter: brightness(1.06); }
[data-hibuddy-genui] .hg-submit:active { transform: translateY(1px); }
[data-hibuddy-genui] .hg-submit:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hg-accent, #4e79a7) 55%, transparent);
  outline-offset: 2px;
}
/* table: hierarchy + row tracking */
[data-hibuddy-genui] .hg-table tbody tr {
  transition: background .12s ease;
}
[data-hibuddy-genui] .hg-table tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 4%, transparent);
}
[data-hibuddy-genui] .hg-table tbody tr:hover {
  background: color-mix(in srgb, var(--hg-accent, #4e79a7) 7%, transparent);
}
[data-hibuddy-genui] .hg-table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .04em;
  border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-tertiary) 28%, transparent);
}
/* metrics: quiet cards with an accent hairline */
[data-hibuddy-genui] .hg-metric {
  position: relative;
  overflow: hidden;
  transition: box-shadow .2s ease, border-color .2s ease;
}
[data-hibuddy-genui] .hg-metric::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: color-mix(in srgb, var(--hg-accent, #f28e2b) 55%, transparent);
}
[data-hibuddy-genui] .hg-metric:hover {
  border-color: color-mix(in srgb, var(--hg-accent, #f28e2b) 45%, var(--dsw-specific-input-major));
}
/* chart: pointer affordance on data marks */
[data-hibuddy-genui] .hg-chart rect[data-hg-mark],
[data-hibuddy-genui] .hg-chart circle[data-hg-mark],
[data-hibuddy-genui] .hg-chart path[data-hg-mark] {
  transition: opacity .15s ease;
  cursor: default;
}
[data-hibuddy-genui] .hg-chart rect[data-hg-mark]:hover,
[data-hibuddy-genui] .hg-chart circle[data-hg-mark]:hover,
[data-hibuddy-genui] .hg-chart path[data-hg-mark]:hover {
  opacity: .78;
}
`

/**
 * One-per-document style injector: the first render mounts the stylesheet,
 * later mounts are no-ops (id dedupe), so multiple cards on one page share it.
 */
export function GenuiSkin(): ReactNode {
  if (typeof document !== 'undefined' && document.getElementById('hibuddy-genui-skin') !== null) {
    return null
  }
  return <style id="hibuddy-genui-skin">{CSS}</style>
}
