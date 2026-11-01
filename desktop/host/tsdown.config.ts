import { defineConfig } from 'tsdown'

/** Node-face bundle; @deepseek-ai/* stays external so the host shares dsh's instances. */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
  dts: false,
  sourcemap: false,
})
