// Runs the desktop plugin under jsdom. Two things are redirected:
//  - '@hermes/plugin-sdk' is only provided by the desktop app, so the tests use a stand-in
//    (sdk-shim.jsx) with the same exports and the same confirm-dialog behaviour.
//  - desktop/plugin.js lives outside this package, so its React imports are pinned to this
//    package's copy. Two copies of React would break hooks.
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@hermes/plugin-sdk', replacement: here('./sdk-shim.jsx') },
      { find: /^react\/jsx-runtime$/, replacement: here('./node_modules/react/jsx-runtime.js') },
      { find: /^react$/, replacement: here('./node_modules/react/index.js') },
      { find: /^react-dom\/client$/, replacement: here('./node_modules/react-dom/client.js') },
    ],
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  test: {
    environment: 'jsdom',
    include: ['ui/**/*.test.jsx'],
    testTimeout: 15000,
  },
})
