/**
 * HiBuddy brand presentation. Props are kept minimal and local for the
 * skeleton; when the type packages are added as devDependencies, replace the
 * inline prop types with the owner types from
 * @deepseek-ai/dsh-client-ui-sidebar/client (SidebarBrandMarkOwnerProps).
 */

import { MASCOT_DATA_URI } from './mascot-data.ts'

interface BrandMarkProps {
  /** Requested mark size in px, as supplied by the sidebar brand slot host. */
  size?: number
}

/**
 * Render the HiBuddy mark: the cat-butler mascot (see
 * packages/brand/assets/icon-candidates/ for the design source). Rendered as
 * an <img> from the bundled data URI so the raster mascot survives any
 * bundler without asset-pipeline support; the border radius clips the
 * source tile's cream corners on dark surfaces.
 * @param props - Host-supplied mark presentation.
 */
export function HibuddyBrandMark({ size = 24 }: BrandMarkProps) {
  return (
    <img
      src={MASCOT_DATA_URI}
      width={size}
      height={size}
      alt="HiBuddy"
      style={{
        borderRadius: '24%',
        objectFit: 'cover',
        display: 'block',
      }}
    />
  )
}

/**
 * Render the HiBuddy wordmark without an independently slotted mark.
 */
export function HibuddyBrandName() {
  return <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>HiBuddy</span>
}
