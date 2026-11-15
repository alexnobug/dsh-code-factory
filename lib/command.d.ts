/**
 * `/factory` — the deterministic activation surface of the code-factory plugin.
 *
 * Typing `/factory <goal>` in a session does three things, in this order:
 *
 *  1. `CommandRuntime.execute()` resolves this definition and runs the handler
 *     **without sending the command line to the model** (the registry documents
 *     `command/run` / `command/done` as direct log-only appends).
 *  2. The handler queues exactly one ordinary follow-up turn whose content is the
 *     user's goal (verbatim) followed by {@link buildActivationDirective}, so the
 *     very first model request of that turn already follows the two-phase staged
 *     protocol ("plan first, approve later, never in the same turn").
 *  3. The returned `CommandResult` is rendered directly by the dispatching UI.
 *
 * Why both blocks live in ONE message: `Agent.followup()` makes its item *the
 * sole ordinary message of its own turn*, and `Agent.inject()` is documented to
 * "miss a request whose pre-step already claimed its batch". Splitting the goal
 * and the directive into two calls would therefore either produce two turns
 * (directive missing from the first one) or risk a silent drop when the agent is
 * busy. One message carrying both blocks cannot be missed.
 *
 * Why the message carries a CUSTOM source kind instead of `{kind:'user'}`: the
 * directive is machine-generated protocol text, and attributing it to the user
 * makes the chat render it inside the user's own bubble — the user ends up
 * reading a wall of Chinese instructions they never typed. `MessageSourceMap` is
 * a merge-extensible sum type ("each producer declares its own `kind` in its own
 * module"; "user messages carry any producer's kind, and consumers fall through
 * unknown kinds"), so this module declares `'code-factory-command'` and tags the
 * injected message with it, carrying the goal as structured payload. The
 * reference plugin `@nanmicoder/dsh-agent-teams` does the same with
 * `'agent-teams-command'`.
 *
 * API provenance (verified against the installed 0.2.1-rc.2 packages):
 *  - `ctx.commands.register(definition): () => void` — live
 *    `cordis_inspect_query` → host `Service.listService {service:'commands'}`,
 *    and `node_modules/@deepseek-ai/dsh-commands/lib/types/index.d.ts`.
 *  - `CommandDefinition` / `CommandInvocation` / `CommandResult` shapes — the
 *    same two sources.
 *  - `MessageSourceMap` / `MessageSource` (merge-extensible source vocabulary) —
 *    live `cordis_inspect_query` → host `Service.listService {service:'llm'}`,
 *    matching `node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:101`.
 *  - `Agent.followup(message: UserMessage): void` —
 *    `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:192`.
 *  - `createUserMessage({content, source})` —
 *    `node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:213`; the real
 *    custom-source usage is
 *    `@nanmicoder/dsh-agent-teams@0.1.22/lib/command.js:141`.
 *
 * @module dsh-code-factory/command
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Message-source vocabulary addition owned by this plugin.
 *
 * `MessageSourceMap` is merge-extensible by design — "each producer declares its
 * own `kind` in its own module" — so content this command injects is tagged as
 * plugin-produced instead of masquerading as something the user typed. Consumers
 * that do not know the kind fall through and treat the message as opaque content.
 *
 * `goal` mirrors the reference plugin's `'agent-teams-command'` payload: a
 * rendering surface can recover the user's request from the source alone (to
 * show it as the user's input) without re-parsing the directive text.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'code-factory-command': {
            readonly kind: 'code-factory-command';
            /** The goal exactly as typed after `/factory`, trimmed. `''` when omitted. */
            readonly goal: string;
        };
    }
}
/**
 * The closed command namespace this plugin owns: `/<FACTORY_COMMAND>`.
 *
 * Deliberately a single word with no sub-command grammar — the captain protocol
 * is driven by tool calls and natural language, and every extra alias is another
 * command other plugins could shadow.
 */
export declare const FACTORY_COMMAND = "factory";
/**
 * Build the deterministic activation directive injected into the turn opened by
 * `/factory`.
 *
 * Pure function: the same `goal` always yields byte-identical text (no clock, no
 * randomness, no ambient state), so it is safe to assert on in verification and
 * cheap to reason about in a session log.
 *
 * @param goal - the text the user typed after `/factory`, already trimmed by the
 *   caller. An empty string means the user activated the protocol without saying
 *   what to build; the directive then tells the captain to ask instead of planning.
 * @returns the model-facing directive block.
 */
export declare function buildActivationDirective(goal: string): string;
/**
 * Register the closed `/factory` namespace on the host command registry.
 *
 * The registration is wrapped in `ctx.effect(...)`, so it is torn down with the
 * plugin fiber (HMR / unload) — the returned function is that effect's disposer.
 *
 * @param ctx - host context with the `commands` service injected.
 * @param options - `{ enabled: false }` registers nothing and returns a no-op
 *   disposer, letting `Config.slashCommand` switch the surface off.
 * @returns disposer that unregisters this exact definition (no-op when disabled).
 */
export declare function registerFactoryCommand(ctx: Context, options: {
    enabled: boolean;
}): () => void;
