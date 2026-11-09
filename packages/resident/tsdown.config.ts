import { defineConfig } from 'tsdown'

const dshExternal = [/^@deepseek-ai\//, /^proper-lockfile$/]

/**
 * Two build faces, matching the dsh client-plugin layout (same shape as
 * @hibuddy/brand and @hibuddy/web-ui):
 * - node face (lib/index.js): host-side Loader row — the resident orchestrator
 *   half (stateDir gate for B1; event sources / tickets / persistence in B2+).
 * - browser face (lib/client.js): served via the client-modules registry,
 *   which loads it as a CLASSIC script. Per the official clientBundle preset
 *   (thirdparty packages/client/tsdown.client.ts clientConfig), the artifact
 *   is a CJS body wrapped by banner/intro/footer into
 *   `window.__ModuleLoader__.load({id, factory})`; externals resolve through
 *   the injected require (loader module table). react/jsx-runtime is part of
 *   the shell's PLATFORM_MODULES baseline — the resident panel (B8) consumes
 *   them once it lands.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'butler-tools': 'src/butler-tools.ts' },
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
    deps: { neverBundle: [...dshExternal, 'react', 'react/jsx-runtime'] },
    dts: false,
    sourcemap: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@hibuddy/resident", factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
