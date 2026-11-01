import { defineConfig } from 'tsdown'

const dshExternal = [/^@deepseek-ai\//]

/**
 * Two build faces, matching the dsh client-plugin layout:
 * - node face (lib/index.js): host-side Loader row.
 * - browser face (lib/client.js): served via the client-modules registry;
 *   react and @deepseek-ai/* stay external.
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
    format: 'esm',
    platform: 'browser',
    deps: { neverBundle: [...dshExternal, 'react', 'react/jsx-runtime'] },
    dts: false,
    sourcemap: false,
  },
])
