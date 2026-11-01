/**
 * HiBuddy brand presentation. Props are kept minimal and local for the
 * skeleton; when the type packages are added as devDependencies, replace the
 * inline prop types with the owner types from
 * @deepseek-ai/dsh-client-ui-sidebar/client (SidebarBrandMarkOwnerProps).
 */

interface BrandMarkProps {
  /** Requested mark size in px, as supplied by the sidebar brand slot host. */
  size?: number
}

/**
 * Render the HiBuddy mark.
 * @param props - Host-supplied mark presentation.
 */
export function HibuddyBrandMark({ size = 24 }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="HiBuddy"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Placeholder mark: friendly speech-bubble robot face. */}
      <path
        d="M6 10a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v7a6 6 0 0 1-6 6h-3.6l-4.9 4.3A1 1 0 0 1 10 26.5V23a6 6 0 0 1-4-5.6Z"
        fill="currentColor"
        opacity="0.15"
      />
      <path
        d="M6 10a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v7a6 6 0 0 1-6 6h-3.6l-4.9 4.3A1 1 0 0 1 10 26.5V23a6 6 0 0 1-4-5.6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12.5" cy="13" r="1.8" fill="currentColor" />
      <circle cx="19.5" cy="13" r="1.8" fill="currentColor" />
      <path d="M12 18.2c1.2 1 2.6 1.5 4 1.5s2.8-.5 4-1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render the HiBuddy wordmark without an independently slotted mark.
 */
export function HibuddyBrandName() {
  return <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>HiBuddy</span>
}
