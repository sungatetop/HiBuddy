/**
 * electron-builder config for @hibuddy/desktop-shell (ADR-004 D8).
 *
 * Layout: shell entry inside app.asar; the RunAsNode host tree (full
 * @deepseek-ai/* dependency closure incl. native modules) and the hibuddy
 * profile template ship as plain resources — outside asar, so the host keeps
 * normal Node module resolution.
 *
 * The trees are copied by the afterPack hook instead of extraResources:
 * electron-builder excludes a source directory's root node_modules in
 * extraResources/files copies (dsh's desktop config works around the same
 * behavior), and stacked overlapping entries do not merge reliably. afterPack
 * runs before the NSIS target is built, so the copied trees are packaged.
 *
 * Staging dirs under build/ are produced by `pnpm deploy --prod` plus
 * scripts/materialize-deploy.mjs (symlinks → real files, dev-only files
 * pruned) in the `dist` script chain.
 */
import { cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const config = {
  appId: 'cn.hibuddy.desktop',
  productName: 'HiBuddy',
  directories: {
    // Overridable when the default dir is locked by an external process.
    output: process.env.HIBUDDY_INSTALLER_DIR ?? 'dist/installer',
  },
  // Use the locally installed Electron 44.7.0 dist (pinned: dsh's native
  // loader whitelists 44.7.0 only); avoids a network download at packaging.
  electronDist: 'node_modules/electron/dist',
  // The host relies on ELECTRON_RUN_AS_NODE — must stay fused on in packaged builds.
  electronFuses: {
    runAsNode: true,
  },
  files: [
    'lib/main.js',
    'assets/**',
    'package.json',
  ],
  asar: true,
  // No native deps live inside the asar (the host tree ships prebuilt binaries
  // as plain resources), so skip @electron/rebuild's Electron download.
  npmRebuild: false,
  win: {
    icon: 'assets/hibuddy.png',
    target: ['nsis'],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-Setup-${version}.${ext}',
    // Pre-kill the windowless RunAsNode host (same exe image) and leftover
    // soffice.exe before the copy phase — see installer.nsh for why the
    // built-in close-application flow alone leaves "file in use" loops.
    include: 'installer.nsh',
    // Keep the NSIS default 7z extraction. 0.3.0/0.3.1 routed through
    // nsisunz zip extraction, but nsisunz cannot read Zip64 archives — the
    // dsh closure (>100k entries) yields a zip it silently fails to unpack.
    // With the tree flattened by materialize-deploy.mjs (no path ≥ MAX_PATH),
    // the 7z default is the viable path; differential blockmaps stay enabled.
  },
  afterPack: async context => {
    const resources = join(context.appOutDir, 'resources')
    for (const name of ['host', 'profile']) {
      const destination = join(resources, name)
      rmSync(destination, { recursive: true, force: true })
      cpSync(join(here, 'build', name), destination, { recursive: true, dereference: true })
    }
  },
}

export default config
