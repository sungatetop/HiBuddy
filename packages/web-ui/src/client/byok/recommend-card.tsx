/**
 * `settings.models.footer` occupant (FR-06 rule 1): the HiBuddy recommended
 * provider setup, rendered after the provider rows and the add controls.
 *
 * Static informational card: names the product-default route (DeepSeek
 * official) and the mainland-China-reachable catalog routes, and restates the
 * SR-03 key-handling promise. Lives in the footer slot, so it never interferes
 * with the official editor cards.
 */
import type { CSSProperties, ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Full props of the registered footer card: list owner seat (empty) + locale. */
export type RecommendCardProps = PropsLocale<'hibuddy-byok'>

/** Card surface reusing the dsh theme tokens. */
const styles = {
  root: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 'var(--dsw-radius-xl)',
    padding: '12px 14px',
    display: 'grid',
    gap: 6,
  } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8 } satisfies CSSProperties,
  title: { fontSize: 13, fontWeight: 600 } satisfies CSSProperties,
  body: { margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' } satisfies CSSProperties,
  privacy: { margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
}

/** Render the recommendation footer card. */
export function RecommendCard({ t }: RecommendCardProps): ReactNode {
  return (
    <div style={styles.root}>
      <div style={styles.head}>
        <StateDot state="done" />
        <span style={styles.title}>{t('recommend.title')}</span>
      </div>
      <p style={styles.body}>{t('recommend.body')}</p>
      <p style={styles.privacy}>{t('recommend.privacy')}</p>
    </div>
  )
}
