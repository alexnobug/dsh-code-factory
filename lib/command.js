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
// Value import on purpose: a model-visible user message can only be minted by
// the message factory (it stamps the stable `MessageId` and freezes the record),
// so `agent.followup()` cannot be called with a hand-built object. This is the
// same import the reference plugin `@nanmicoder/dsh-agent-teams` uses, and
// `@deepseek-ai/dsh-llm` is already a declared dependency of this package.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/**
 * The closed command namespace this plugin owns: `/<FACTORY_COMMAND>`.
 *
 * Deliberately a single word with no sub-command grammar — the captain protocol
 * is driven by tool calls and natural language, and every extra alias is another
 * command other plugins could shadow.
 */
export const FACTORY_COMMAND = 'factory';
/** Effect label shown in the fiber's effect diagnostics tree. */
const EFFECT_LABEL = 'code-factory: /factory command';
/** Discovery-UI summary for `/factory`. */
const COMMAND_DESCRIPTION = '以 code-factory 多 Agent 流水线完成一个目标（先出 staged 规划，批准后才组队）';
/** Composer placeholder hinting the free-form input shape. */
const COMMAND_INPUT_HINT = '<目标描述，例如：做一个带登录的电商后端>';
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
export function buildActivationDirective(goal) {
    const trimmed = typeof goal === 'string' ? goal.trim() : '';
    const lines = [
        `【code-factory 激活指令】用户通过 /${FACTORY_COMMAND} 激活了 code-factory。你现在是这次任务的队长（captain），本轮必须走「先 staged 规划、经用户批准后再组队」的两阶段协议。`,
        '',
        '本轮必须按顺序执行：',
        `1. 第一步调用 factory_plan：它只把 staged 规划写入磁盘，不创建任何子会话、不唤醒任何成员。`,
        '2. 把规划结果原样呈现给用户，至少包含：任务类型（taskType）、团队编制（每个角色的职责与工件边界）、流水线阶段顺序，以及每阶段的门禁类型与打回目标（failGoto / maxRounds）。',
        '3. 呈现完就停下，等待用户的明确批准。只有收到明确批准，才允许调用 factory_approve。',
        '',
        '硬性约束：',
        '- 禁止在同一轮里既规划又批准：调用 factory_plan 之后本轮结束，等用户回复。',
        '- 用户批准之前，禁止调用 factory_approve / factory_dispatch，禁止创建任何子代理。',
        '- 规划需要调整时用 factory_edit_plan 修改，改完仍要重新等待批准。',
        '- 批准之后的推进用 factory_gate / factory_status / factory_message；交付前先 factory_dod_check，再 factory_deliver。',
        '',
    ];
    if (trimmed === '') {
        lines.push(`用户没有在 /${FACTORY_COMMAND} 后面给出目标：先用一句话向用户确认这次要做什么，本轮不要调用 factory_plan。`);
    }
    else {
        lines.push(`用户目标（原样保留，不要改写）：${trimmed}`);
    }
    return lines.join('\n');
}
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
export function registerFactoryCommand(ctx, options) {
    if (!options || options.enabled !== true)
        return () => undefined;
    const definition = {
        name: FACTORY_COMMAND,
        description: COMMAND_DESCRIPTION,
        input: { hint: COMMAND_INPUT_HINT },
        handler: (invocation) => {
            if (invocation.signal.aborted) {
                return { kind: 'error', text: `code-factory: /${FACTORY_COMMAND} 已取消，未注入激活指令。` };
            }
            // `rawInput` is "the exact text following the registered command name,
            // including separator whitespace" — the goal is the trimmed remainder.
            const goal = invocation.rawInput.trim();
            try {
                invocation.agent.followup(createUserMessage({
                    content: activationContent(goal),
                    // Plugin-produced, not the user's own message: the directive must not
                    // be rendered inside the user's bubble (see the module header).
                    source: { kind: 'code-factory-command', goal },
                }));
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: `code-factory: 无法把激活指令注入本轮（${describeError(error)}）。请重试 /${FACTORY_COMMAND}，或用自然语言直接让队长开始规划。`,
                };
            }
            return {
                kind: 'success',
                text: goal === ''
                    ? `code-factory 已激活，但没有收到目标 —— 请告诉队长这次要做什么；它不会自行开工。`
                    : `code-factory 已激活：队长会先产出 staged 规划（任务类型 / 团队编制 / 阶段与门禁），等你批准后才会组建团队。`,
            };
        },
    };
    return ctx.effect(() => ctx.commands.register(definition), EFFECT_LABEL);
}
/**
 * The model-visible content of the injected follow-up turn: the user's goal
 * verbatim, then the activation directive.
 *
 * The directive is a separate block (not string-concatenated into the user's
 * words) so a reader of the session log can tell the two apart, and the whole
 * message carries the `'code-factory-command'` source with `goal` as structured
 * payload (see the module header).
 */
function activationContent(goal) {
    const content = [];
    if (goal !== '')
        content.push({ type: 'text', text: goal });
    content.push({ type: 'text', text: buildActivationDirective(goal) });
    return content;
}
/** Compact one-line description of a thrown value, for the command result card. */
function describeError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=command.js.map