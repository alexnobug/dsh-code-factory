/**
 * engine/reuse.ts — `factory_reuse`: search / harvest / apply the global reuse
 * library.
 *
 * The tool is **captain-only** and deliberately narrow:
 *
 *  - `list` / `search` are read-only — no plan or factory state is touched;
 *  - `harvest` may only read a **delivered** factory (a running or staged
 *    factory has no stable deliverable to preserve) and copies its files into
 *    the workspace-independent library;
 *  - `apply` copies library files into the current workspace's `reuse/`
 *    directory and executes nothing.
 *
 * All refusals are `FactoryToolError`s written for the model to act on (which
 * phase is wrong, which path is unsafe, which entry id is unknown). Lower-level
 * `ReuseLibraryError`s are translated; unexpected errors are logged and surfaced
 * as a tool error rather than silently swallowed.
 *
 * @module dsh-code-factory/tools/engine/reuse
 */
import { REUSE_KINDS } from '../../shared/types.js';
import { REUSE_LIBRARY_DEFAULT_LIMIT, REUSE_LIBRARY_MAX_LIMIT, rankReuseEntries, reusePlanNote, } from '../../domain/reuse.js';
import { REUSE_LIBRARY_LIST_LIMIT, ReuseLibrary, ReuseLibraryError, defaultReuseLibraryDir, } from '../../store/library.js';
import { FactoryToolError, loadFactory, logLine, requireFactoryId } from '../context.js';
import { optional, optionalCount } from './plumbing.js';
/* ------------------------------------------------------------------ types */
/** Accepted `action` values. */
export const REUSE_ACTIONS = ['list', 'search', 'harvest', 'apply'];
/* --------------------------------------------------------------- helpers */
/** Build the library bound to this call's configured/global root. */
function libraryFor(call) {
    const configured = typeof call.config.libraryDir === 'string' ? call.config.libraryDir.trim() : '';
    const root = configured === '' ? defaultReuseLibraryDir() : configured;
    return new ReuseLibrary(root, {
        now: () => call.store.now(),
        onWarning: (code, message) => logLine(call.plugin, 'warn', `${code}: ${message}`),
    });
}
function normalizeAction(raw) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!REUSE_ACTIONS.includes(value)) {
        throw new FactoryToolError(`code-factory: factory_reuse 的 action 必须是 ${REUSE_ACTIONS.join(' / ')} 之一，实际是 ${JSON.stringify(raw)}。`
            + ' list=看库，search=检索，harvest=把已交付工厂的工件沉淀进库，apply=复制到工作区。');
    }
    return value;
}
function optionalKind(raw) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (value === '')
        return undefined;
    if (!REUSE_KINDS.includes(value)) {
        throw new FactoryToolError(`code-factory: kind 必须是 ${REUSE_KINDS.join(' / ')} 之一，实际是 ${JSON.stringify(raw)}。`);
    }
    return value;
}
function labelList(raw) {
    if (!Array.isArray(raw))
        return [];
    const labels = [];
    for (const value of raw) {
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (trimmed === '' || labels.includes(trimmed))
            continue;
        labels.push(trimmed);
    }
    return labels;
}
function limitOf(raw, fallback) {
    const parsed = optionalCount(raw, 1);
    if (parsed === undefined)
        return fallback;
    return Math.min(Math.max(1, parsed), REUSE_LIBRARY_MAX_LIMIT);
}
/** Translate library refusals into the model-facing error text. */
async function guarded(call, library, fn) {
    try {
        return await fn();
    }
    catch (error) {
        if (error instanceof ReuseLibraryError) {
            throw new FactoryToolError(`code-factory: 复用库操作被拒绝 —— ${error.message}（库目录: ${library.root}）`);
        }
        const detail = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `复用库操作失败: ${detail}`);
        throw new FactoryToolError(`code-factory: 复用库操作失败 —— ${detail}（库目录: ${library.root}）`);
    }
}
/* ------------------------------------------------------------- plan search */
/**
 * Read-only search used by `factory_plan` to suggest reusable assets.
 *
 * Never throws and never blocks planning: an unreadable/corrupt library reads as
 * empty, and an unexpected error is swallowed with a warning (the plan is more
 * important than the suggestion).
 *
 * @param call - the resolved tool call (workspace + config).
 * @param options - query / taskType / limit (kind/tags supported too).
 * @returns ranked matches, `[]` when the library is empty or unreadable.
 */
export async function searchReuse(call, options = {}) {
    try {
        return await libraryFor(call).search(options);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `规划时读取复用库失败（已忽略，不影响规划）: ${detail}`);
        return [];
    }
}
/* ------------------------------------------------------------------ tool */
/**
 * Execute one `factory_reuse` action.
 *
 * @param call - the resolved tool call.
 * @param input - action plus action-specific arguments.
 * @returns the tool result (always includes `entries`, even when empty).
 * @throws {FactoryToolError} for an unknown action, a non-delivered factory, an
 *         unsafe path, an unknown entry id or a library failure.
 */
export async function reuseFactory(call, input) {
    const action = normalizeAction(input.action);
    const library = libraryFor(call);
    /* ------------------------------------------------------------- list */
    if (action === 'list') {
        const limit = limitOf(input.limit, REUSE_LIBRARY_LIST_LIMIT);
        const entries = await guarded(call, library, () => library.list(limit));
        return {
            summary: entries.length === 0
                ? '复用库还没有任何资产。先对已交付工厂执行 factory_reuse action=harvest，把可复用模块/文档沉淀进库。'
                : `复用库返回 ${entries.length} 条资产（按最近更新排序，最多 ${limit} 条）。`,
            action,
            entries: [...entries],
            notes: entries.length === 0 ? ['库目录不存在或为空时也会返回空列表，不会报错。'] : [],
            nextAction: entries.length === 0
                ? 'factory_plan → approve → deliver 一个工厂后，用 factory_reuse action=harvest factoryId=<id> paths=[...] 入库。'
                : '用 factory_reuse action=apply entryId=<id> 复制到工作区 reuse/，或 action=search 按关键词检索。',
        };
    }
    /* ----------------------------------------------------------- search */
    if (action === 'search') {
        const query = optional(input.query);
        const taskType = optional(input.taskType);
        const tags = labelList(input.tags);
        const kind = optionalKind(input.kind);
        const limit = limitOf(input.limit, REUSE_LIBRARY_DEFAULT_LIMIT);
        const options = {
            ...(query === undefined ? {} : { query }),
            ...(taskType === undefined ? {} : { taskType }),
            ...(tags.length === 0 ? {} : { tags }),
            ...(kind === undefined ? {} : { kind }),
            limit,
        };
        const matches = await guarded(call, library, () => library.search(options));
        const entries = matches.map((match) => match.entry);
        return {
            summary: entries.length === 0
                ? '复用库没有匹配的资产；换关键词/放宽 taskType/tags，或先用 factory_reuse action=list 看全库。'
                : `复用库检索到 ${entries.length} 条匹配（按相关度排序，最多 ${limit} 条）。`,
            action,
            entries,
            notes: entries.length === 0
                ? ['检索条件为空时按设计返回空列表；至少给 query / taskType / tags / kind 之一。']
                : entries.slice(0, 3).map((entry) => `${entry.name}（${entry.kind}，id=${entry.id}）`),
            nextAction: entries.length === 0
                ? '换一个 query，或 factory_reuse action=list 看库中已有资产。'
                : '选中后 factory_reuse action=apply entryId=<id> 复制到工作区 reuse/ 参考/适配。',
        };
    }
    /* ---------------------------------------------------------- harvest */
    if (action === 'harvest') {
        const rawFactoryId = optional(input.factoryId);
        if (rawFactoryId === undefined) {
            throw new FactoryToolError('code-factory: action=harvest 需要 factoryId —— 只有已交付（phase=delivered）的工厂才能沉淀到复用库。'
                + ' 先用 factory_status 找到已交付工厂的 id。');
        }
        const factoryId = requireFactoryId(rawFactoryId);
        const state = await loadFactory(call, factoryId);
        if (state.phase !== 'delivered') {
            throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 当前 phase=${state.phase}，不能沉淀到复用库 —— `
                + '只有已交付（delivered）的工厂才有稳定、可复用的工件。先完成流水线与 DoD 交付，再 harvest。');
        }
        const paths = labelList(input.paths);
        if (paths.length === 0) {
            throw new FactoryToolError('code-factory: action=harvest 需要 paths（工作区相对路径，可传文件或目录，例如 ["src/backend/","API_CONTRACT.md"]）。');
        }
        const kind = optionalKind(input.kind) ?? 'module';
        const taskTypes = labelList(input.taskTypes);
        const entry = await guarded(call, library, () => library.harvest({
            sourceFactoryId: state.id,
            sourceFactoryName: state.name,
            sourceWorkspace: call.workspace,
            paths,
            name: optional(input.name) ?? `${state.name} · 复用资产`,
            description: optional(input.description) ?? `来自已交付工厂 ${state.id}（${state.name}）的复用资产，使用时需按新项目适配。`,
            kind,
            tags: labelList(input.tags),
            taskTypes: taskTypes.length > 0 ? taskTypes : [state.taskType],
        }));
        return {
            summary: `已沉淀复用资产「${entry.name}」（id=${entry.id}，kind=${entry.kind}，${entry.files.length} 个文件）到全局复用库。`,
            action,
            entries: [entry],
            entry,
            notes: [
                `来源工厂 ${state.id} / ${state.name}（phase=delivered）。`,
                `库目录: ${library.root}/entries/${entry.id}/files`,
                '之后新项目 factory_plan 会自动检索并提示；也可用 factory_reuse action=search 手动检索。',
            ],
            nextAction: '在后续项目规划时留意 factory_plan 的复用提示，或直接用 factory_reuse action=apply 复制到工作区 reuse/。',
        };
    }
    /* ------------------------------------------------------------ apply */
    const entryId = optional(input.entryId);
    if (entryId === undefined) {
        throw new FactoryToolError('code-factory: action=apply 需要 entryId —— 先 factory_reuse action=list 或 action=search 找到资产 id。');
    }
    const targetDir = optional(input.targetDir);
    const overwrite = input.overwrite === true;
    const applied = await guarded(call, library, () => library.apply(entryId, call.workspace, targetDir, overwrite));
    const notes = [
        `复制到工作区 ${applied.targetDir}/，共 ${applied.copied.length} 个文件。`,
        '复制品是参考材料，需要按本项目需求改造；不要直接当成交付物。',
    ];
    if (applied.skipped.length > 0) {
        notes.push(`${applied.skipped.length} 个目标文件已存在，默认不覆盖；确认要覆盖时再传 overwrite=true。`);
    }
    return {
        summary: `已把复用资产 ${entryId} 复制到 ${applied.targetDir}/：新写 ${applied.copied.length} 个文件`
            + (applied.skipped.length > 0 ? `，跳过 ${applied.skipped.length} 个已存在文件` : '')
            + '。未执行任何代码。',
        action,
        entries: [],
        appliedFiles: [...applied.copied],
        targetDir: applied.targetDir,
        notes,
        nextAction: '阅读 reuse/ 下的参考实现并改造成本项目所需；需要整目录重写时先确认覆盖范围，再传 overwrite=true。',
    };
}
/* -------------------------------------------------------------- utilities */
/**
 * Rank entries without touching the filesystem — re-exported for callers that
 * already have an in-memory entry list (tests / future read-only projections).
 */
export function rankReuse(entries, options = {}) {
    return rankReuseEntries(entries, options);
}
/** Build the planning note from matches without re-implementing the wording. */
export function reusePlanningNote(matches) {
    return reusePlanNote(matches);
}
//# sourceMappingURL=reuse.js.map