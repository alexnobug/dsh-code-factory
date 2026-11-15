/**
 * `src/prompt` barrel — every prompt renderer and protocol constant in one import.
 *
 * Every module is **pure**: text in, text out, no `ctx`, no filesystem, no clock.
 * The host half renders the captain's system-prompt section from
 * `captain-protocol.ts` and every member-facing prompt from `member-brief.ts`;
 * `design-playbook.ts` supplies the UI/UX design lead's handbook that
 * `member-brief.ts` injects for that one role. The offline self-check asserts on
 * the same strings.
 *
 * @module dsh-code-factory/prompt
 */

export * from './member-brief.js'
export * from './design-playbook.js'
export * from './captain-protocol.js'
