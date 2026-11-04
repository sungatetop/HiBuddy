/**
 * HiBuddy quota notice card: `shell.quota-notice` chain entry (S5-4, FR-09
 * rule 2). Replaces the official generic Toast with an actionable card — the
 * provider-neutral notice copy plus a one-click jump to the provider
 * configuration, the product answer to "quota/balance exhausted".
 *
 * The settings dialog has no reachable programmatic open (openSettings and
 * openSection are owner props of specific official slot entries, and the
 * Shortcuts face exposes no invoke), so the jump replays the official
 * `settings.open` gesture — a synthetic Ctrl+Alt+Comma keydown on window. The
 * shortcuts keyboard adapter builds its gesture straight from the event
 * (code/modifier keys, no isTrusted gate), so the synthetic press drives the
 * same command pipeline as a physical one; no modal being open, the event's
 * region resolves to `page`, which the command accepts.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Full props of the quota notice card: chain owner seat + our locale. */
export type HibuddyQuotaNoticeProps =
  & PropsRuntime<'shell.quota-notice'>
  & PropsLocale<'hibuddy-quota'>
  & { matched: QuotaNoticeOwnerProps }

/** Card surface reusing the dsh theme tokens (theme-safe without a CSS pipeline). */
const styles = {
  root: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 'var(--dsw-radius-xl)',
    boxShadow: 'var(--dsw-shadow-lv2)',
    padding: '14px 16px',
    display: 'grid',
    gap: 8,
    maxWidth: 420,
  } satisfies CSSProperties,
  strip: { display: 'flex', alignItems: 'center', gap: 8 } satisfies CSSProperties,
  title: { fontSize: 14, fontWeight: 600 },
  body: { margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
}

/**
 * Dispatch the official `settings.open` web gesture (default binding
 * Ctrl+Alt+Comma). Registered gap: a direct landing on the Models section is
 * unreachable (openSection serves onboarding steps only) — the dialog opens
 * on its default page.
 */
function openSettingsDialog(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    code: 'Comma',
    ctrlKey: true,
    altKey: true,
    bubbles: true,
  }))
}

/** Render the quota notice card; the host remounts it per notice (seq key). */
export function HibuddyQuotaNotice(props: HibuddyQuotaNoticeProps): ReactNode {
  const { matched, t } = props
  return (
    <div style={styles.root} data-hibuddy-quota="" role="alert">
      <div style={styles.strip}>
        <StateDot state="warning" />
        <span style={styles.title}>{t('title')}</span>
      </div>
      <p style={styles.body}>{matched.message}</p>
      <p style={styles.hint}>{t('hint')}</p>
      <div style={styles.actions}>
        <Button variant="outline" onClick={matched.dismiss}>{t('dismiss')}</Button>
        <Button variant="primary" onClick={openSettingsDialog}>{t('goSettings')}</Button>
      </div>
    </div>
  )
}
