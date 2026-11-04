/**
 * `settings.models.provider-card` occupant (FR-06 rule 3): connection check
 * inside every provider card of the Models settings page.
 *
 * Registered once per adapter-family settings namespace (`llm-deepseek`,
 * `llm-pi-ai`) — the slot dispatches on `entryKey = settingsNs`, so one
 * registration covers shipped, added, and hand-declared rows of that family.
 * The probe itself runs host-side (`hibuddy/verifyProvider`): the client never
 * sees key material. Auto-probes once per route per TTL window when the card
 * reports a configured key (fresh after saving), with a manual re-test.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { VerifyProviderOutcome } from '../../verify-provider.ts'

/** Full props of the registered card: keyed owner seat + locale + probe seam. */
export type VerifyProviderCardProps = ProviderCardExtrasOwnerProps &
  PropsLocale<'hibuddy-byok'> & {
    /** Host-side probe (registration inject) — runs `hibuddy/verifyProvider`. */
    verifyProvider(route: string): Promise<VerifyProviderOutcome>
  }

/** Freshness window for the session-local auto-probe cache. */
const PROBE_TTL_MS = 60_000

/** Session-local probe results, so re-mounting a card does not re-fires requests. */
const probeCache = new Map<string, { at: number; outcome: VerifyProviderOutcome }>()

/** Card surface reusing the dsh theme tokens. */
const styles = {
  root: {
    borderTop: '1px dashed var(--dsw-specific-input-major)',
    marginTop: 10,
    paddingTop: 10,
    display: 'grid',
    gap: 6,
  } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 } satisfies CSSProperties,
  title: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } satisfies CSSProperties,
  status: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', margin: 0 } satisfies CSSProperties,
  ok: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-success-primary)', margin: 0 } satisfies CSSProperties,
  fail: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-danger-primary)', margin: 0 } satisfies CSSProperties,
  actions: { display: 'flex', justifyContent: 'flex-end' } satisfies CSSProperties,
}

/** Render the connection-check block for one provider card. */
export function VerifyProviderCard(props: VerifyProviderCardProps): ReactNode {
  const { provider, configured, keyConfigured, t, verifyProvider } = props
  const route = provider.provider
  const [outcome, setOutcome] = useState<VerifyProviderOutcome | undefined>(() => {
    const cached = probeCache.get(route)
    return cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS ? cached.outcome : undefined
  })
  const [checking, setChecking] = useState(false)
  const run = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const result = await verifyProvider(route)
      probeCache.set(route, { at: Date.now(), outcome: result })
      setOutcome(result)
    } finally {
      setChecking(false)
    }
  }, [route, verifyProvider])
  // Auto-probe when the card first reports a configured key — the moment right
  // after the user saves one (the page refreshes the credential snapshot). The
  // TTL cache keeps repeated card mounts from re-firing requests.
  const autoKey = useRef<string | null>(null)
  useEffect(() => {
    if (!configured || !keyConfigured || checking) return
    const cache = probeCache.get(route)
    if (cache !== undefined && Date.now() - cache.at < PROBE_TTL_MS) {
      setOutcome(cache.outcome)
      return
    }
    if (autoKey.current === route) return
    autoKey.current = route
    void run()
  }, [configured, keyConfigured, route, run, checking])
  if (!configured) return null
  let status: ReactNode = <p style={styles.status}>{t('verify.idle')}</p>
  if (checking) status = <p style={styles.status}>{t('verify.checking')}</p>
  else if (outcome !== undefined) {
    status = outcome.ok
      ? <p style={styles.ok}>{t('verify.ok', { model: outcome.model })}</p>
      : <p style={styles.fail}>{t(`verify.reason.${outcome.reason}`, outcome.reason === 'unknown' ? { detail: outcome.detail } : undefined)}</p>
  }
  return (
    <div style={styles.root}>
      <div style={styles.head}>
        <StateDot state={checking ? 'ongoing' : outcome === undefined ? 'idle' : outcome.ok ? 'done' : 'error'} />
        <span style={styles.title}>{t('verify.title')}</span>
      </div>
      {status}
      <div style={styles.actions}>
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void run()}>{t('verify.retry')}</Button>
      </div>
    </div>
  )
}
