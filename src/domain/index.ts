/**
 * Domain barrel — the whole pure-logic surface of code-factory in one import.
 *
 * `src/domain/**` is the only layer shared by all three consumers:
 *   - the host half (tools, engine, store)         → `import { … } from '../domain/index.js'`
 *   - the browser half (cockpit panel projection)  → same barrel, no host code
 *   - `scripts/verify.mjs` (offline L1 self-check) → same barrel through `lib/`
 *
 * Everything exported here is a pure function or a frozen-by-convention data
 * table: no `ctx`, no filesystem, no clock, no randomness. Anything that needs
 * the outside world (reading an artifact, running a gate command, `git`) is
 * injected by the caller — see `GateEvalInput` and `DodEvalInput`.
 *
 * @module dsh-code-factory/domain
 */

export * from './roles.js'
export * from './task-types.js'
export * from './gates.js'
export * from './dod.js'
export * from './pipeline.js'
export * from './router.js'
export * from './alerts.js'
export type * from '../shared/types.js'
