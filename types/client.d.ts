/**
 * Public type surface of the browser half of `dsh-code-factory`.
 *
 * READ THIS BEFORE ADDING A FIELD.
 *
 * `lib/client.js` is NOT an ES module. The DSH Web shell loads it as a classic
 * script that registers one CJS closure factory on `window.__ModuleLoader__`
 * (`docs/API-CONTRACTS.md` §2.2, `compatibility.json.client.loaderContract`).
 * The only names the shell reads off that closure are `apply` and `inject`.
 * Everything else the bundle exports (the cockpit components, the locale
 * dictionaries, the slot ids) is internal to that closure.
 *
 * So this file is deliberately a SUBSET declaration, and it exists for tooling
 * that needs the shape rather than for `import` at runtime: writing
 * `import { apply } from 'dsh-code-factory/client'` in application code will
 * type-check and then fail at runtime, because there is no module to import.
 *
 * It is hand-maintained, not emitted: the bundler runs with `dts: false`
 * (`tsdown.config.ts`) because the client half has no importable declaration
 * graph to roll up. Keep it in sync with the `apply` / `inject` exports in
 * `src/client/index.tsx`; `scripts/check-pack.mjs` proves it ships.
 *
 * @module dsh-code-factory/client
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Cordis service keys the browser half needs, in the shell's short-name form.
 * Mirrors `dsh.client.inject` in `package.json` and `compatibility.json`.
 */
export declare const inject: readonly string[]

/**
 * Register the cockpit panel (`main`), the sidebar entry (`sidebar.panellist`)
 * and the per-turn factory card (`conversation.chat.turnTail`).
 */
export declare function apply(ctx: Context): void
