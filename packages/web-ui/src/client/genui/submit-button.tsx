/**
 * Submit-button seam: the dsh `Button` primitive is not resolvable from every
 * client bundle that embeds the trusted surfaces (the resident chat panel
 * bundles them without the dsh module table, genui-agui-optimization.md G4),
 * so the submit button is injectable like the other seams. The web-ui client
 * face installs the themed primitive at apply time; embedders that never call
 * the setter keep the plain fallback styled with the same theme variables the
 * surfaces already use.
 */
import { type CSSProperties, type ReactNode } from 'react'

/** Props the form surface passes to its submit button. */
export interface SubmitButtonProps {
  onClick: () => void
  children: ReactNode
}

/** A submit-button renderer (same shape as a function component). */
export type SubmitButtonComponent = (props: SubmitButtonProps) => ReactNode

let current: SubmitButtonComponent | undefined

/** Install the themed submit button; later calls replace earlier ones. */
export function setSubmitButton(install: SubmitButtonComponent): void {
  current = install
}

/** Neutral fallback matching the surfaces' own theme-token styling. */
const fallbackStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px solid var(--dsw-specific-input-major)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
}

/** The form's submit button: the installed primitive, or the plain fallback. */
export function SubmitButton(props: SubmitButtonProps): ReactNode {
  const Component = current
  if (Component !== undefined) return <Component {...props} />
  return (
    <button type="button" style={fallbackStyle} className="hg-submit" onClick={props.onClick}>
      {props.children}
    </button>
  )
}
