import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    exports: 'src/exports.ts',
  },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  // shebang for CLI entry — harmless on library entry
  banner: {
    js: '#!/usr/bin/env node',
  },
})
