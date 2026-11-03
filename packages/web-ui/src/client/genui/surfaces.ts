/**
 * P0 trusted-surface registration: fills the registry with the four built-ins
 * (chart / form / table / metrics). Called once from the client `apply`, so
 * registration follows the plugin lifecycle instead of import side effects.
 */
import { ChartSurface } from './chart.tsx'
import { FormSurface } from './form.tsx'
import { MetricsSurface } from './metrics.tsx'
import { registerUiSurface } from './registry.ts'
import { TableSurface } from './table.tsx'

/** Register every P0 built-in surface. Idempotent (Map set semantics). */
export function registerGenuiSurfaces(): void {
  registerUiSurface('chart', ChartSurface)
  registerUiSurface('form', FormSurface)
  registerUiSurface('table', TableSurface)
  registerUiSurface('metrics', MetricsSurface)
}
