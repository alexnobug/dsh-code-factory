/**
 * captain-protocol.ts — the captain's system-prompt section, as pure strings.
 *
 * This module holds **no behaviour**: it is text plus the three constants a
 * registration site needs, so the host half can mount it with
 *
 * ```ts
 * ctx.systemPrompt.section({ name: CAPTAIN_PROTOCOL_NAME, order: CAPTAIN_PROTOCOL_ORDER, text: CAPTAIN_PROTOCOL })
 * ```
 *
 * Shape verified in API-CONTRACTS §1.3 (`[LIVE]`): `section()` takes a **single
 * object** with `name` (required), `order`, and `text` — *not* `content`, and not
 * a positional `(name, options)` pair. The reference plugin registers its own
 * protocol at order 117 (immediately after the delegation-policy section), so
 * code-factory takes 118 and leaves 117 alone.
 *
 * Why the protocol lives in the system prompt at all: the captain is the
 * *user's* agent — a normal session model — and the pipeline discipline has to be
 * in front of it before it decides anything. Everything the protocol states is
 * also enforced by the tools themselves (a gate cannot be skipped by prose), so
 * the text is guidance for a cooperative model, not the safety mechanism.
 *
 * @module dsh-code-factory/prompt/captain-protocol
 */
/** Section name registered on `ctx.systemPrompt`. */
export declare const CAPTAIN_PROTOCOL_NAME = "code-factory";
/** Section order: after the delegation-policy section (reference plugin uses 117). */
export declare const CAPTAIN_PROTOCOL_ORDER = 118;
/** One-line description other plugins' diagnostics can quote. */
export declare const CAPTAIN_PROTOCOL_SUMMARY = "code-factory \u961F\u957F\u534F\u8BAE\uFF1Astaged \u89C4\u5212 \u2192 \u7528\u6237\u6279\u51C6 \u2192 \u6309\u9636\u6BB5\u5524\u9192\u6210\u5458 \u2192 \u95E8\u7981\u88C1\u51B3/\u6253\u56DE \u2192 DoD \u603B\u9A8C\u6536 \u2192 \u4EA4\u4ED8";
/**
 * The workspace-relative artifacts the pipeline hands between stages. Quoted in
 * the protocol so the captain never has to guess a filename, and kept in sync
 * with `domain.pipeline.ARTIFACTS` by the offline self-check.
 */
export declare const CAPTAIN_PROTOCOL_ARTIFACTS: readonly string[];
/** The captain system-prompt section text (never mutated, safe to concatenate). */
export declare const CAPTAIN_PROTOCOL: string;
