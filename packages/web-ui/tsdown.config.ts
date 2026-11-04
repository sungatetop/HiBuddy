import { defineConfig } from 'tsdown'

const dshExternal = [/^@deepseek-ai\//]

/**
 * Client face externals. The dsh client-modules module table exposes only the
 * platform seed words — no @deepseek-ai package is resolvable from a plugin
 * client bundle, so every @deepseek-ai import must stay type-only, with one
 * exception: `dsh-typert-protocol/remote-info` is import-free (no cordis) and
 * small, so the client face bundles it to mount the `hibuddy` namespace.
 */
const clientDshExternal = [/^@deepseek-ai\/(?!dsh-typert-protocol\/remote-info)/]

/**
 * Two build faces, matching the dsh client-plugin layout:
 * - node face (lib/index.js): host-side Loader row.
 * - browser face (lib/client.js): served via the client-modules registry,
 *   which loads it as a CLASSIC script. Per the official clientBundle preset
 *   (thirdparty packages/client/tsdown.client.ts clientConfig), the artifact
 *   is a CJS body wrapped by banner/intro/footer into
 *   `window.__ModuleLoader__.load({id, factory})`; externals resolve through
 *   the injected require (loader module table). react/jsx-runtime is part of
 *   the shell's PLATFORM_MODULES baseline.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    fixedExtension: false,
    deps: { neverBundle: dshExternal },
    dts: false,
    sourcemap: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    deps: { neverBundle: [...clientDshExternal, 'react', 'react/jsx-runtime'] },
    dts: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@hibuddy/web-ui", factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
