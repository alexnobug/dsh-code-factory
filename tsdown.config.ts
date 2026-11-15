import { defineConfig } from 'tsdown'
import { owningPackage, shellModuleIds } from './scripts/shell-modules.mjs'

/**
 * Client-half bundler.
 *
 * The DSH Web shell does not import our client entry as an ES module. It loads
 * `lib/client.js` as a classic script that registers one CJS closure factory on
 * `window.__ModuleLoader__`:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => { ... return module.exports; }
 *   })
 *
 * The factory must export `apply` and `inject`. `require()` resolves ONLY the
 * modules the shell itself registered; everything else must be inlined.
 *
 * Which ids those are — and why guessing by scope prefix is fatal — lives in
 * `scripts/shell-modules.mjs`, the single source of truth shared with
 * `scripts/check-bundle.mjs`. Read that file before touching this one.
 *
 * Default posture: BUNDLE. Bundling something the shell also ships costs bytes;
 * externalizing something it does not ship is a runtime crash that takes the
 * whole plugin down. `check-bundle.mjs` (last step of `pnpm build`) then fails
 * the build on either mistake.
 */
const PACKAGE_NAME = 'dsh-code-factory'

const SHELL_MODULES = shellModuleIds()

export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  // Produced by `tsc -p tsconfig.client.json` (src/client/index.tsx -> lib/client/client/index.js).
  entry: { client: 'lib/client/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  // The host half already emitted lib/index.js + lib/*.d.ts into this directory.
  clean: false,
  deps: {
    neverBundle: (id: string) => SHELL_MODULES.has(owningPackage(id)),
    alwaysBundle: (id: string) => !SHELL_MODULES.has(owningPackage(id)),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    exports: 'named',
    banner: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ].join('\n'),
    footer: ['\t\treturn module.exports;', '\t}', '});', ''].join('\n'),
  },
})
