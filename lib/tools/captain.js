/**
 * captain.ts — the **13 captain tools** (`factory_*`), as `defineTool` definitions.
 *
 * These are thin adapters: every one of them resolves the shared call context
 * (`context.ts`) and hands its arguments to one engine operation (`engine.ts`),
 * then returns that operation's result. Keeping the definitions thin is what lets
 * the engine be exercised offline (see `scripts/verify.mjs`'s siblings and the
 * harness used while implementing this task) and keeps the model-facing schema
 * honest — the declared `output.schema` mirrors the engine's result interface, so
 * `tsc` fails if a field is added or renamed on one side only.
 *
 * Contract notes (API-CONTRACTS §1.2):
 *  - `parameters` / `output.schema` use the tool DSL, **not** schemastery and not
 *    raw JSON Schema. Requiredness is the per-property `required: true`
 *    annotation; an optional property simply omits it.
 *  - `output` is mandatory, and `render` returns `ContentBlock[]`.
 *  - `execute` throws `FactoryToolError` for a refusal (unknown factory id, wrong
 *    phase, missing approval): the registry turns it into the model-visible error
 *    text, which is written to say what to do next.
 *
 * Registration order: the member tools are registered first (see
 * `tools/index.ts`), because `runtime/tool-surface` validates that
 * `factory_report` / `factory_inbox` / `factory_block` exist **before** the first
 * member spawn.
 *
 * @module dsh-code-factory/tools/captain
 */
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TASK_TYPE_IDS } from '../domain/task-types.js';
import { IMPROVEMENT_STATUSES, IMPROVEMENT_TARGETS, REUSE_KINDS } from '../shared/types.js';
import { CAPTAIN_TOOL_NAMES } from '../runtime/tool-surface.js';
import { approveFactory, checkDod, deliverFactory, deleteFactory, dispatchFactory, editFactoryPlan, gateFactory, haltFactory, messageFactory, planFactory, readFactoryStatus, resumeFactory, } from './engine.js';
import { reuseFactory } from './engine/reuse.js';
import { renderToolResult, resolveToolCall } from './context.js';
/* ---------------------------------------------------------------- fragments */
/**
 * The captain tool names, in registration order — an alias of
 * {@link CAPTAIN_TOOL_NAMES} in `runtime/tool-surface.ts`, which is the **single
 * source of truth** for the captain tool set (review finding M14).
 *
 * It stays a separate exported *name* only because the registration order is the
 * thing worth asserting: the `effect(...)` calls below pass exactly these names,
 * in exactly this order, so an offline check can compare the two without a live
 * registry (`runtime/tool-surface` owns the *policy* side — what a member may
 * see; `MEMBER_TOOL_NAMES` in `member.ts` is the member-facing counterpart).
 *
 * Never re-fork this into its own literal: a literal that drifts from the policy
 * list drops a captain tool out of the member deny-filter **silently** — the
 * spawn still succeeds and the tool stays callable by members. See the M14 note
 * on `CAPTAIN_TOOL_NAMES` for the full failure mode.
 */
export const CAPTAIN_TOOL_ORDER = CAPTAIN_TOOL_NAMES;
/**
 * Captain-only tool visibility for the 0.2.2 preset world.
 *
 * `persona` / `toolFilter` are gone from SubagentStartRequest, so members share
 * the global tool registry. DSH's step-admission condition hides these captain
 * tools from delegated agents (depth > 0) while keeping them for the root
 * captain. Member-only factory tools stay visible to everyone.
 */
function captainToolWhen({ agent }) {
    if (agent === undefined || agent === null)
        return true;
    try {
        return delegationDepthOf(agent) === 0;
    }
    catch {
        // Fail closed for an agent that still carries subagent provenance, while
        // keeping the tools available to an ordinary root whose header shape was
        // not recognized. This avoids both silently widening a member's surface
        // and locking the captain out on a benign probe failure.
        const candidate = agent;
        if (candidate.session?.header?.origin === 'subagent')
            return false;
        if (typeof candidate.options?.subagentDepth === 'number' && candidate.options.subagentDepth > 0)
            return false;
        return true;
    }
}
function registerCaptainTool(ctx, definition) {
    return ctx.tools.register(definition, { when: captainToolWhen });
}
/** Shared parameter: a factory id, always validated with `isSafeFactoryId`. */
const FACTORY_ID = {
    type: 'string',
    required: true,
    description: '工厂 id（8 位十六进制；用 factory_status 不带参数可列出本工作区的工厂）。',
};
/** Optional stage id. */
const STAGE_ID = {
    type: 'string',
    description: '目标阶段 id（默认取流水线里第一个未通过的阶段）。',
};
/** Corrective list for a rework dispatch / a gate rejection. */
const FINDINGS = {
    type: 'array',
    items: { type: 'string' },
    description: '可执行的整改条目（每条说清「哪里不合格 + 改成什么样」）。打回时会原样写进责任角色的邮箱。',
};
/** One dispatch decision/dispatch row. */
const DISPATCH_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            role: { type: 'string', required: true },
            title: { type: 'string', required: true },
            action: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            sessionId: { type: 'string' },
            messageId: { type: 'string' },
            mode: { type: 'string' },
            error: { type: 'string' },
        },
    },
};
/** One executed command row. */
const COMMAND_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            command: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
            timedOut: { type: 'boolean', required: true },
            via: { type: 'string', required: true },
            exitCode: { type: 'number' },
        },
    },
};
/** One DoD item row. */
const DOD_ITEMS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'number', required: true },
            label: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            status: { type: 'string', required: true },
            skipped: { type: 'boolean', required: true },
            evidence: { type: 'string', required: true },
            needsExecution: { type: 'boolean', required: true },
        },
    },
};
/** Roll-up of one DoD audit. */
const DOD_SUMMARY = {
    type: 'object',
    additionalProperties: false,
    properties: {
        passed: { type: 'number', required: true },
        total: { type: 'number', required: true },
        failed: { type: 'number', required: true },
        pending: { type: 'number', required: true },
        skipped: { type: 'number', required: true },
        ok: { type: 'boolean', required: true },
    },
};
/** One roster row. */
const ROLE_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            role: { type: 'string', required: true },
            title: { type: 'string', required: true },
            codename: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            duties: { type: 'string', required: true },
        },
    },
};
/** One staged plan stage row. */
const PLAN_STAGE_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            roles: { type: 'array', required: true, items: { type: 'string' } },
            parallel: { type: 'boolean', required: true },
            humanApproval: { type: 'boolean', required: true },
            gateType: { type: 'string', required: true },
            maxRounds: { type: 'number', required: true },
            failGoto: { type: 'string' },
        },
    },
};
/** One live member row. */
const MEMBER_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            role: { type: 'string', required: true },
            title: { type: 'string', required: true },
            codename: { type: 'string', required: true },
            tier: { type: 'string', required: true },
            duties: { type: 'string', required: true },
            status: { type: 'string', required: true },
            tokens: { type: 'number', required: true },
            stage: { type: 'string' },
            sessionId: { type: 'string' },
            spawnError: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
        },
    },
};
/** One live stage row. */
const STATUS_STAGE_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            status: { type: 'string', required: true },
            round: { type: 'number', required: true },
            attempts: { type: 'number', required: true },
            roles: { type: 'array', required: true, items: { type: 'string' } },
            parallel: { type: 'boolean', required: true },
            humanApproval: { type: 'boolean', required: true },
            gateType: { type: 'string', required: true },
            failGoto: { type: 'string' },
            lastGateOk: { type: 'boolean' },
            lastGateDetail: { type: 'string' },
        },
    },
};
/** One registered artifact row. */
const ARTIFACT_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            path: { type: 'string', required: true },
            by: { type: 'string', required: true },
            stage: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            at: { type: 'number', required: true },
        },
    },
};
/** One unread-count row. */
const UNREAD_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            key: { type: 'string', required: true },
            unread: { type: 'number', required: true },
        },
    },
};
/** One mailbox feed row. */
const FEED_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            content: { type: 'string', required: true },
            ts: { type: 'number', required: true },
            status: { type: 'string', required: true },
            kind: { type: 'string' },
            stage: { type: 'string' },
        },
    },
};
/** One factory-index row. */
const FACTORY_INDEX_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            phase: { type: 'string', required: true },
            taskType: { type: 'string', required: true },
            pipeline: { type: 'string', required: true },
            updatedAt: { type: 'number', required: true },
        },
    },
};
/** One roster row whose recorded status no longer matches the executor probe. */
const STALE_MEMBER_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            role: { type: 'string', required: true },
            status: { type: 'string', required: true },
            sessionId: { type: 'string', required: true },
            stage: { type: 'string' },
            reason: { type: 'string', required: true },
        },
    },
};
/** One recent evolution-ledger row. */
const STATUS_LESSON_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            role: { type: 'string', required: true },
            stage: { type: 'string', required: true },
            gateType: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            text: { type: 'string', required: true },
            count: { type: 'number', required: true },
            lastAt: { type: 'number', required: true },
            resolvedAt: { type: 'number' },
        },
    },
};
/** One derived plugin-improvement proposal row (`target` / `status` are closed sets). */
const STATUS_IMPROVEMENT_ROWS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            target: { type: 'string', required: true, enum: IMPROVEMENT_TARGETS },
            targetFile: { type: 'string' },
            suggestion: { type: 'string', required: true },
            rationale: { type: 'string', required: true },
            role: { type: 'string' },
            stage: { type: 'string' },
            evidenceCount: { type: 'number', required: true },
            status: { type: 'string', required: true, enum: IMPROVEMENT_STATUSES },
            lastAt: { type: 'number', required: true },
        },
    },
};
/** Derived improvement backlog: whole-backlog roll-up + the hottest 5 proposals. */
const IMPROVEMENTS_SUMMARY = {
    type: 'object',
    additionalProperties: false,
    properties: {
        total: { type: 'number', required: true },
        open: { type: 'number', required: true },
        validated: { type: 'number', required: true },
        proposals: { ...STATUS_IMPROVEMENT_ROWS, required: true },
    },
};
/**
 * Workspace evolution summary: full-ledger roll-up + the newest 5 lessons, plus
 * the derived plugin-improvement backlog. `improvements` is optional on purpose:
 * the engine omits it when the derivation fails (never a fabricated empty
 * backlog), and the status summary stays silent when nothing qualified.
 */
const EVOLUTION_SUMMARY = {
    type: 'object',
    additionalProperties: false,
    properties: {
        total: { type: 'number', required: true },
        recurring: { type: 'number', required: true },
        resolved: { type: 'number', required: true },
        lastAt: { type: 'number' },
        lessons: { ...STATUS_LESSON_ROWS, required: true },
        improvements: IMPROVEMENTS_SUMMARY,
    },
};
/** One file row of a reuse-library entry. */
const REUSE_FILES = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            sha256: { type: 'string', required: true },
        },
    },
};
/** One reusable asset row. */
const REUSE_ENTRY = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        description: { type: 'string', required: true },
        tags: { type: 'array', required: true, items: { type: 'string' } },
        taskTypes: { type: 'array', required: true, items: { type: 'string' } },
        sourceFactoryId: { type: 'string', required: true },
        sourceFactoryName: { type: 'string', required: true },
        sourceWorkspace: { type: 'string', required: true },
        files: { ...REUSE_FILES, required: true },
        createdAt: { type: 'number', required: true },
        updatedAt: { type: 'number', required: true },
    },
};
/** A list of reusable asset rows. */
const REUSE_ENTRIES = {
    type: 'array',
    items: REUSE_ENTRY,
};
/* ------------------------------------------------------------ registration */
/**
 * Registers the 13 captain tools into the shared registry.
 *
 * Every registration is wrapped in `ctx.effect(...)`, so an HMR reload or a
 * plugin unload removes exactly the definitions it added (API-CONTRACTS §1.1).
 *
 * @param ctx - host context with the `tools` service injected.
 * @param config - resolved plugin configuration (state dir, provider, cap, …).
 */
export function registerFactoryCaptainTools(ctx, config) {
    const effect = (name, dispose) => {
        ctx.effect(() => dispose, `code-factory: tool ${name}`);
    };
    /* ---------------------------------------------------------- factory_plan */
    effect('factory_plan', registerCaptainTool(ctx, defineTool({
        name: 'factory_plan',
        description: '以「staged 两阶段协议」的第一个阶段：把用户的原始需求变成一份计划（任务类型 / 团队编制 / 流水线阶段与门禁），'
            + '只写入磁盘，**不创建任何子会话、不唤醒任何成员**。返回计划详情与工厂 id。'
            + '何时用：用户给出要做的目标、且还没有已批准的计划时。'
            + '拿到结果后把计划完整呈现给用户并结束本轮——只有用户明确批准后才能调用 factory_approve。'
            + '同一个 brief 重复调用是幂等的（复用已存在的 staged 计划）。'
            + '规划时会自动检索跨项目复用库，命中可复用资产会写进 notes（不会自动复制文件）。',
        parameters: {
            brief: { type: 'string', required: true, description: '用户的原始需求（原样传入，不要改写、不要补全）。' },
            name: { type: 'string', description: '工厂显示名；省略时取 brief 第一行。' },
            taskType: {
                type: 'string',
                enum: TASK_TYPE_IDS,
                description: '显式指定任务类型（省略则由 brief 关键词自动路由）。指定后会覆盖路由结果并联合该类型的默认编制。',
            },
            members: {
                type: 'array',
                items: { type: 'string' },
                description: '显式指定编制（角色 id 或别名）；省略则由路由组队。铁三角（pm + qa + 一个 *_dev）与安全岗会被强制保留。',
            },
            maxMembers: {
                type: 'number',
                description: '编制上限（硬限制）。省略时取插件配置 maxMembers，其默认值等于最宽模板的编制数。'
                    + '装不下模板需要的岗位时不会静默：结果里的 trimmedRequired 会列出被裁掉的岗位，'
                    + '对应阶段将退回 ROLE_FALLBACKS。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    brief: { type: 'string', required: true },
                    taskType: { type: 'string', required: true },
                    pipeline: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    planReviewState: { type: 'string', required: true },
                    securityTriggered: { type: 'boolean', required: true },
                    maxMembers: { type: 'number', required: true },
                    team: ROLE_ROWS,
                    stages: PLAN_STAGE_ROWS,
                    reasoning: { type: 'array', required: true, items: { type: 'string' } },
                    trimmed: { type: 'array', required: true, items: { type: 'string' } },
                    trimmedRequired: { type: 'array', required: true, items: { type: 'string' } },
                    overCap: { type: 'boolean', required: true },
                    factoryFile: { type: 'string', required: true },
                    reusedPlan: { type: 'boolean', required: true },
                    spawnedMembers: { type: 'number', required: true },
                    childSessions: { type: 'number', required: true },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await planFactory(call, args);
        },
    })));
    /* ----------------------------------------------------- factory_edit_plan */
    effect('factory_edit_plan', registerCaptainTool(ctx, defineTool({
        name: 'factory_edit_plan',
        description: '修改一份还没批准的 staged 计划（brief / 名称 / 任务类型 / 编制 / 上限 / 备注）。'
            + '何时用：用户对计划提出修改意见、且计划仍是 staged、还没有任何成员会话时。'
            + '改完仍是 awaiting_review：必须重新把计划呈现给用户并等明确批准。'
            + '一旦有成员会话（已批准）编制即冻结，此时只能走 factory_message / 门禁打回单。',
        parameters: {
            factoryId: FACTORY_ID,
            brief: { type: 'string', description: '新的需求描述（会重新路由任务类型与编制，除非同时给出 taskType / members）。' },
            name: { type: 'string', description: '新的工厂显示名。' },
            taskType: { type: 'string', enum: TASK_TYPE_IDS, description: '新的任务类型（同时决定流水线模板）。' },
            members: { type: 'array', items: { type: 'string' }, description: '新的编制（角色 id 或别名）。' },
            maxMembers: { type: 'number', description: '新的编制上限。' },
            note: { type: 'string', description: '这次改动的原因/用户原话，会记进工厂 feed。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    brief: { type: 'string', required: true },
                    taskType: { type: 'string', required: true },
                    pipeline: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    planReviewState: { type: 'string', required: true },
                    securityTriggered: { type: 'boolean', required: true },
                    maxMembers: { type: 'number', required: true },
                    team: ROLE_ROWS,
                    stages: PLAN_STAGE_ROWS,
                    reasoning: { type: 'array', required: true, items: { type: 'string' } },
                    trimmed: { type: 'array', required: true, items: { type: 'string' } },
                    trimmedRequired: { type: 'array', required: true, items: { type: 'string' } },
                    overCap: { type: 'boolean', required: true },
                    factoryFile: { type: 'string', required: true },
                    reusedPlan: { type: 'boolean', required: true },
                    spawnedMembers: { type: 'number', required: true },
                    childSessions: { type: 'number', required: true },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                    changedFields: { type: 'array', required: true, items: { type: 'string' } },
                    editedAt: { type: 'number', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await editFactoryPlan(call, args);
        },
    })));
    /* ------------------------------------------------------- factory_approve */
    effect('factory_approve', registerCaptainTool(ctx, defineTool({
        name: 'factory_approve',
        description: '两阶段协议的第二个阶段：用户**明确批准**后，把 staged 计划推进到 running，并只唤醒第一阶段真正要干活的成员。'
            + '这是唯一会创建子会话（成员）的入口。重复调用是幂等的（已 running 的工厂不会重复 spawn）。'
            + '何时用：用户在看过计划之后明确说了「可以 / 批准 / 开始」。用户没批就不许调用。',
        parameters: { factoryId: FACTORY_ID },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    alreadyApproved: { type: 'boolean', required: true },
                    approvedAt: { type: 'number' },
                    stageId: { type: 'string' },
                    stageName: { type: 'string' },
                    round: { type: 'number' },
                    planned: { type: 'number', required: true },
                    decisions: DISPATCH_ROWS,
                    applied: DISPATCH_ROWS,
                    failed: DISPATCH_ROWS,
                    spawned: { type: 'array', required: true, items: { type: 'string' } },
                    missingRoles: { type: 'array', required: true, items: { type: 'string' } },
                    escalate: { type: 'boolean', required: true },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await approveFactory(call, args);
        },
    })));
    /* ------------------------------------------------------ factory_dispatch */
    effect('factory_dispatch', registerCaptainTool(ctx, defineTool({
        name: 'factory_dispatch',
        description: '推进当前阶段：按真相源算出「现在谁有活」，只创建/唤醒/返工该干活的成员（空闲成员复用，不重复派发）。'
            + '何时用：刚批准之后、或某个阶段通过/被打回之后要往下走时；成员已在工作或已有未完成派发时它会返回 wait 而不是重复派发。'
            + '⚠️ 若当前阶段停在门禁（阶段 status=gate），本工具没有派发项、只会返回 wait —— `wait` 不代表工厂卡死；'
            + '此时唯一正确的解封动作是 factory_gate（需要人工审批的阶段则先问用户）。'
            + '返回每个角色的决策（spawn/wake/rework/wait/skip/escalate）与理由。',
        parameters: {
            factoryId: FACTORY_ID,
            stageId: STAGE_ID,
            findings: FINDINGS,
            note: { type: 'string', description: '本次派发的说明，记进工厂 feed。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    known: { type: 'boolean', required: true },
                    stageId: { type: 'string', required: true },
                    stageName: { type: 'string', required: true },
                    round: { type: 'number', required: true },
                    parallel: { type: 'boolean', required: true },
                    humanApproval: { type: 'boolean', required: true },
                    planned: { type: 'number', required: true },
                    decisions: DISPATCH_ROWS,
                    applied: DISPATCH_ROWS,
                    failed: DISPATCH_ROWS,
                    waiting: DISPATCH_ROWS,
                    skipped: DISPATCH_ROWS,
                    spawned: { type: 'array', required: true, items: { type: 'string' } },
                    missingRoles: { type: 'array', required: true, items: { type: 'string' } },
                    escalate: { type: 'boolean', required: true },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await dispatchFactory(call, args);
        },
    })));
    /* ---------------------------------------------------------- factory_gate */
    effect('factory_gate', registerCaptainTool(ctx, defineTool({
        name: 'factory_gate',
        description: '对当前阶段出**门禁裁决**（只认真实证据：checklist 查 Markdown 标题、keyword 查最后结论行、'
            + 'script 由执行器真实跑模板命令取退出码、dod 逐条机器校验；模型的说明一律不算通过）。'
            + '返回 advance / reject / escalate / await_approval / delivered 之一：'
            + 'reject 会按 failGoto 回退、轮次 +1、把整改清单写进责任角色邮箱；轮次用尽（round ≥ maxRounds）返回 escalate；'
            + 'humanApproval 阶段在门禁通过后返回 await_approval，直到用户明确确认（再调用一次并传 humanConfirm=true）。',
        parameters: {
            factoryId: FACTORY_ID,
            stageId: STAGE_ID,
            findings: FINDINGS,
            humanConfirm: {
                type: 'boolean',
                description: '只有用户明确确认了 humanApproval 阶段的产出时才传 true（此时复用上一轮门禁证据，不重复执行命令）。',
            },
            minCommits: { type: 'number', description: 'DoD/dod 门禁要求的最小 commit 数（逐阶段 commit 的实际门限，默认 1）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    stageId: { type: 'string', required: true },
                    stageName: { type: 'string', required: true },
                    gateType: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    detail: { type: 'string', required: true },
                    round: { type: 'number', required: true },
                    maxRounds: { type: 'number', required: true },
                    humanApproval: { type: 'boolean', required: true },
                    needsHumanConfirm: { type: 'boolean', required: true },
                    rejectedTo: { type: 'string' },
                    resetStages: { type: 'array', required: true, items: { type: 'string' } },
                    findings: { type: 'array', required: true, items: { type: 'string' } },
                    notifiedRoles: { type: 'array', required: true, items: { type: 'string' } },
                    wokenRoles: { type: 'array', required: true, items: { type: 'string' } },
                    refusedCommands: { type: 'array', required: true, items: { type: 'string' } },
                    commands: COMMAND_ROWS,
                    dod: DOD_SUMMARY,
                    dodItems: DOD_ITEMS,
                    nextStage: { type: 'string' },
                    nextStageName: { type: 'string' },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await gateFactory(call, args);
        },
    })));
    /* -------------------------------------------------------- factory_status */
    effect('factory_status', registerCaptainTool(ctx, defineTool({
        name: 'factory_status',
        description: '读磁盘真相：工厂 phase / 成员状态（含 spawnError）/ 每个阶段的 round 与最近门禁判定 / DoD 结果 / 已登记工件 / '
            + '各邮箱未读数 / 最近消息 feed；并**只读**解释成员执行者状态（`executorAudit`：`stale` = 状态已过期、'
            + '执行者不在场的 stranded 成员；`uncertain` = 无法判定，无可用探针）。'
            + '本工具不写盘、不派发、不唤醒任何成员。不带参数时列出本工作区的工厂索引，并回退到当前会话自己的工厂。'
            + '`evolution` 是工作区进化教训库的只读摘要（total / recurring / resolved / lastAt + 最近 5 条）：门禁打回与 DoD 失败会自动入库。'
            + '其中跨任务反复出现的教训会提炼成插件改进建议（`evolution.improvements`：目标文件 / 具体建议 / 是否已验证），供规划与复盘时落实。'
            + '何时用：每次做推进决定之前——不要凭记忆推进流水线；nextAction 会按当前阶段状态给出唯一正确的下一步。',
        parameters: {
            factoryId: { type: 'string', description: '要查看的工厂 id；省略则取当前会话（队长或成员）所属的工厂。' },
            sessionId: { type: 'string', description: '按会话查它所属的工厂（只做等值匹配，不参与任何路径拼接）。' },
            feedLimit: { type: 'number', description: 'feed 保留的最新消息条数（默认取插件配置）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    scope: { type: 'string', required: true },
                    workspace: { type: 'string', required: true },
                    stateDir: { type: 'string', required: true },
                    factoryId: { type: 'string' },
                    name: { type: 'string' },
                    phase: { type: 'string' },
                    taskType: { type: 'string' },
                    pipeline: { type: 'string' },
                    planReviewState: { type: 'string' },
                    securityTriggered: { type: 'boolean' },
                    brief: { type: 'string' },
                    captainSessionId: { type: 'string' },
                    factoryFile: { type: 'string' },
                    deliveryPath: { type: 'string' },
                    members: MEMBER_ROWS,
                    stages: STATUS_STAGE_ROWS,
                    currentStage: { type: 'string' },
                    dod: DOD_SUMMARY,
                    dodItems: DOD_ITEMS,
                    artifacts: ARTIFACT_ROWS,
                    unread: UNREAD_ROWS,
                    feed: FEED_ROWS,
                    factories: FACTORY_INDEX_ROWS,
                    executorAudit: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            stale: { ...STALE_MEMBER_ROWS, required: true },
                            uncertain: { ...STALE_MEMBER_ROWS, required: true },
                            note: { type: 'string', required: true },
                        },
                    },
                    evolution: EVOLUTION_SUMMARY,
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await readFactoryStatus(call, args);
        },
    })));
    /* --------------------------------------------------------- factory_reuse */
    effect('factory_reuse', registerCaptainTool(ctx, defineTool({
        name: 'factory_reuse',
        description: '跨项目复用库：把已交付工厂的模块/文档沉淀到全局库（code-factory-library），并在新项目里检索/复制。'
            + 'action=list 列出库资产；action=search 按 query/taskType/tags/kind 相关度检索；'
            + 'action=harvest 把**已交付（delivered）**工厂的 paths 收进库（工作区相对路径，保留结构；拒绝符号链接 / .env / .pem / .key / .git / node_modules / .code-factory；单文件 5MB、总 50MB、500 文件上限）；'
            + 'action=apply 把 entry 复制到工作区 reuse/<id>（默认不覆盖已存在文件；**不执行任何代码**）。'
            + '只读或只复制，不修改工厂状态；复制品是参考材料，需要按新项目适配。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ['list', 'search', 'harvest', 'apply'],
                description: 'list=列出；search=检索；harvest=沉淀已交付工厂资产；apply=复制到工作区。',
            },
            query: { type: 'string', description: 'search 关键词（匹配名称/描述/tags/taskTypes/文件路径）。' },
            taskType: { type: 'string', description: 'search 任务类型精确加分（如 web_fullstack）。' },
            tags: { type: 'array', items: { type: 'string' }, description: 'search 标签交集；harvest 时作为入库标签。' },
            kind: {
                type: 'string',
                enum: [...REUSE_KINDS],
                description: '资产类型；search 时作为过滤条件，harvest 时作为入库类型（默认 module）。',
            },
            limit: { type: 'number', description: '返回条数上限（list 默认 20，search 默认 5，最大 20）。' },
            factoryId: { type: 'string', description: 'harvest 的来源工厂 id（必须 phase=delivered）。' },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'harvest 的工作区相对路径（文件或目录；目录会递归复制并保留相对结构）。',
            },
            name: { type: 'string', description: '资产名称（默认「<工厂名> · 复用资产」）。' },
            description: { type: 'string', description: '资产说明（默认写明来源工厂与「需适配」）。' },
            taskTypes: {
                type: 'array',
                items: { type: 'string' },
                description: 'harvest 适用任务类型（默认来源工厂的 taskType）。',
            },
            entryId: { type: 'string', description: 'apply 的资产 id（来自 list/search 结果）。' },
            targetDir: { type: 'string', description: 'apply 的目标目录（工作区相对，默认 reuse/<id>）。' },
            overwrite: {
                type: 'boolean',
                description: 'apply 时是否覆盖已存在的目标文件（默认 false：跳过并报告，不覆盖）。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    entries: { ...REUSE_ENTRIES, required: true },
                    entry: REUSE_ENTRY,
                    appliedFiles: { type: 'array', items: { type: 'string' } },
                    targetDir: { type: 'string' },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await reuseFactory(call, args);
        },
    })));
    /* ------------------------------------------------------- factory_message */
    effect('factory_message', registerCaptainTool(ctx, defineTool({
        name: 'factory_message',
        description: '把一条消息写进某个收件人的邮箱（收件人 = captain 或角色 id），并默认同时投递给该成员的会话（空闲成员会被唤醒）。'
            + '何时用：给成员补一条指令/上下文、向某个角色说明任务背景、或往工厂 feed 里留一条自己的审计记录（to=captain）。'
            + '邮箱是持久记录，投递是加速通道——投递失败时消息仍在磁盘上。',
        parameters: {
            factoryId: FACTORY_ID,
            to: { type: 'string', required: true, description: '收件人：captain（队长自己的审计频道）或角色 id（如 pm / security_eng）。' },
            content: { type: 'string', required: true, description: '消息正文。' },
            kind: {
                type: 'string',
                enum: ['dispatch', 'reject', 'handoff', 'report', 'blocked', 'approval', 'system'],
                description: '消息类型（默认 system），用于面板配色与筛选。',
            },
            stage: { type: 'string', description: '关联的阶段 id。' },
            round: { type: 'number', description: '关联的门禁轮次。' },
            deliver: { type: 'boolean', description: '设为 false 时只写邮箱、不投递给成员（默认投递）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    messageId: { type: 'string', required: true },
                    from: { type: 'string', required: true },
                    to: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    stage: { type: 'string' },
                    round: { type: 'number' },
                    delivered: { type: 'boolean', required: true },
                    mode: { type: 'string' },
                    via: { type: 'string' },
                    error: { type: 'string' },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await messageFactory(call, args);
        },
    })));
    /* ------------------------------------------------------ factory_dod_check */
    effect('factory_dod_check', registerCaptainTool(ctx, defineTool({
        name: 'factory_dod_check',
        description: '跑 DoD 总验收（7 条机器校验：PRD↔用例映射 / pytest 实跑 / REVIEW APPROVED / SEC_PASS（安全路径）/ '
            + 'start.sh --check / README 四标题 / git 逐阶段 commit 与 v1.0.0 tag），把结果写进 factory.json。'
            + '何时用：交付前必须跑；也能用来查看「还差哪几条」。缺证据一律算未达标，不接受文字自述。',
        parameters: {
            factoryId: FACTORY_ID,
            minCommits: { type: 'number', description: '「逐阶段 commit」要求的最小 commit 数（默认 1）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    passed: { type: 'number', required: true },
                    total: { type: 'number', required: true },
                    failed: { type: 'number', required: true },
                    pending: { type: 'number', required: true },
                    skipped: { type: 'number', required: true },
                    securityTriggered: { type: 'boolean', required: true },
                    items: DOD_ITEMS,
                    commands: COMMAND_ROWS,
                    commits: { type: 'number', required: true },
                    tags: { type: 'array', required: true, items: { type: 'string' } },
                    gitError: { type: 'string' },
                    refusedCommands: { type: 'array', required: true, items: { type: 'string' } },
                    missing: { type: 'array', required: true, items: { type: 'string' } },
                    notes: { type: 'array', required: true, items: { type: 'string' } },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await checkDod(call, args);
        },
    })));
    /* ---------------------------------------------------------- factory_halt */
    effect('factory_halt', registerCaptainTool(ctx, defineTool({
        name: 'factory_halt',
        description: '暂停工厂：中断正在工作的成员，phase 置为 halted（磁盘状态保留，不回收成员会话）。'
            + '何时用：用户要求「先停一下」、或需要人工介入时。重复调用是幂等的。恢复要用 factory_resume。',
        parameters: {
            factoryId: FACTORY_ID,
            reason: { type: 'string', description: '暂停原因（用户原话或当前卡点），会记进 feed。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    alreadyHalted: { type: 'boolean', required: true },
                    interrupted: { type: 'array', required: true, items: { type: 'string' } },
                    failed: { type: 'array', required: true, items: { type: 'string' } },
                    reason: { type: 'string', required: true },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await haltFactory(call, args);
        },
    })));
    /* -------------------------------------------------------- factory_resume */
    effect('factory_resume', registerCaptainTool(ctx, defineTool({
        name: 'factory_resume',
        description: '恢复被暂停（halted）的工厂，phase 回到 running。必须写明原因（用户在哪一轮明确要求继续）。'
            + '它本身不派发任何工作：恢复后用 factory_dispatch 重新派发当前阶段。',
        parameters: {
            factoryId: FACTORY_ID,
            reason: { type: 'string', required: true, description: '恢复原因：用户在哪里明确要求继续。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    phase: { type: 'string', required: true },
                    alreadyRunning: { type: 'boolean', required: true },
                    reason: { type: 'string', required: true },
                    currentStage: { type: 'string' },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await resumeFactory(call, args);
        },
    })));
    /* ------------------------------------------------------- factory_deliver */
    effect('factory_deliver', registerCaptainTool(ctx, defineTool({
        name: 'factory_deliver',
        description: '交付：**重新**跑一次 DoD 七条机器校验，只有「所有阶段 passed + DoD 全绿」才把 phase 置为 delivered 并记下交付物路径；'
            + '否则返回 delivered=false 与 blocked 清单（不是通过）。重复调用是幂等的。'
            + '何时用：factory_dod_check 全绿之后，作为流水线的最后一步。',
        parameters: {
            factoryId: FACTORY_ID,
            deliveryPath: { type: 'string', description: '交付物路径（工作区相对，默认 DELIVERY.md）。' },
            note: { type: 'string', description: '交付说明，记进 feed。' },
            minCommits: { type: 'number', description: '逐个阶段 commit 要求的最小 commit 数（默认 1）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    delivered: { type: 'boolean', required: true },
                    alreadyDelivered: { type: 'boolean', required: true },
                    phase: { type: 'string', required: true },
                    deliveryPath: { type: 'string' },
                    dodPassed: { type: 'number', required: true },
                    dodTotal: { type: 'number', required: true },
                    blocked: { type: 'array', required: true, items: { type: 'string' } },
                    stagesPassed: { type: 'boolean', required: true },
                    items: DOD_ITEMS,
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await deliverFactory(call, args);
        },
    })));
    /* -------------------------------------------------------- factory_delete */
    effect('factory_delete', registerCaptainTool(ctx, defineTool({
        name: 'factory_delete',
        description: '结束一个工厂：中断并回收所有成员，phase 置为 discarded，然后默认**归档**到 archive/（保留 factory.json + inbox + artifacts）。'
            + 'mode=destroy 会真删除目录，必须显式 confirm=true。何时用：用户确认不再需要这个工厂时；删除前先说明归档与真删的区别。',
        parameters: {
            factoryId: FACTORY_ID,
            mode: {
                type: 'string',
                enum: ['archive', 'destroy'],
                description: 'archive（默认，移到 archive/ 保留记录）或 destroy（真删除，需要 confirm=true）。',
            },
            confirm: { type: 'boolean', description: 'destroy 模式必须传 true，表示用户已明确同意永久删除。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    factoryId: { type: 'string', required: true },
                    mode: { type: 'string', required: true },
                    archived: { type: 'boolean', required: true },
                    removed: { type: 'boolean', required: true },
                    drained: { type: 'array', required: true, items: { type: 'string' } },
                    drainErrors: { type: 'array', required: true, items: { type: 'string' } },
                    path: { type: 'string' },
                    nextAction: { type: 'string', required: true },
                },
            },
            render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
            const call = resolveToolCall(exec, config);
            return await deleteFactory(call, args);
        },
    })));
}
//# sourceMappingURL=captain.js.map