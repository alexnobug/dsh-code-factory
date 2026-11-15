/**
 * gates-runner.ts — the **executor** half of the gate engine.
 *
 * `domain/gates.ts` and `domain/dod.ts` own judgement and are pure: anything they
 * cannot decide comes back as `needsExecution: true` with the exact commands it
 * wants. This module supplies the outside world they refuse to touch — artifact
 * text, real exit codes, git facts — and hands the results back so the *domain*
 * produces the verdict. No verdict is ever computed here.
 *
 * Hard rule (API-CONTRACTS §3 陷阱 #10): **a command may only come from a pipeline
 * template.** `script` gates and DoD items carry their `run` string from
 * `domain/pipeline.ts` / `domain/dod.ts`; this module therefore re-checks every
 * command twice before starting it —
 *   1. `domain.isSafeGateCommand` (no shell metacharacters, no destructive verb),
 *   2. membership in {@link collectTemplateCommands} (the union of every script a
 *      template *could* ask for, for that pipeline, plus the DoD commands).
 * A command that fails either check is **not executed**; it is recorded as a
 * failed script result, so the gate reports "拒绝执行: …" instead of green.
 *
 * Execution order follows the domain's own contract: the gate is evaluated once
 * with no execution results. If that already decides it (a failing `checklist`
 * child, a missing artifact), nothing is started at all — no side effects for a
 * verdict that is already settled. Only when the verdict is genuinely blocked on
 * a runtime action are the `pendingCommands` it asked for executed, one by one,
 * and the gate re-evaluated with the results.
 *
 * Timeout policy (hard requirement #3): every command gets a wall-clock limit
 * (`DEFAULT_GATE_TIMEOUT_MS`, 5 min — `python -m pytest` and `npm run build` are
 * not fast). A timeout terminates the process and is reported as a **failed**
 * gate with `⏱ 超时 …` evidence; it is never silently pending and never a pass.
 *
 * @module dsh-code-factory/runtime/gates-runner
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { evaluateGate, gateCommandSignature, isSafeArtifactPath, isSafeGateCommand } from '../domain/gates.js';
import { DOD_GIT_COMMANDS, DOD_ITEMS, evaluateDod } from '../domain/dod.js';
import { getPipeline, PIPELINE_IDS } from '../domain/pipeline.js';
import { DEFAULT_GATE_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, resolveCommandRunnerDetailed, } from './commands.js';
/* ----------------------------------------------------------- allow-list */
/**
 * Every command one pipeline template may legitimately request: all `script`
 * gate commands reachable from its stages, plus the DoD command constants.
 *
 * @param pipeline - the template id (unknown ids yield the DoD commands only).
 * @returns the closed command set for that template.
 */
export function collectTemplateCommands(pipeline) {
    const commands = new Set();
    for (const stage of getPipeline(pipeline))
        collectScriptCommands(stage.gate, commands);
    for (const item of DOD_ITEMS) {
        if (typeof item.run === 'string' && item.run.trim().length > 0)
            commands.add(item.run.trim());
    }
    for (const command of DOD_GIT_COMMANDS)
        commands.add(command.trim());
    return commands;
}
function collectScriptCommands(def, into) {
    if (def.type === 'script') {
        const run = (def.run ?? '').trim();
        if (run.length > 0)
            into.add(run);
        return;
    }
    for (const check of def.checks ?? [])
        collectScriptCommands(check, into);
}
/** True when this gate tree contains a `dod` node (the DoD audit must run). */
export function containsDodGate(def) {
    if (def.type === 'dod')
        return true;
    return (def.checks ?? []).some((check) => containsDodGate(check));
}
/** All `script` nodes of a gate tree, in template order. */
export function collectGateScripts(def) {
    const nodes = [];
    const walk = (gate) => {
        if (gate.type === 'script') {
            const command = (gate.run ?? '').trim();
            if (command.length > 0)
                nodes.push({ command, signature: gateCommandSignature(gate) });
            return;
        }
        for (const check of gate.checks ?? [])
            walk(check);
    };
    walk(def);
    return nodes;
}
/* ------------------------------------------------------------ artifacts */
/** How many bytes of one artifact are read before the reader gives up. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
/**
 * The default artifact reader: workspace-relative POSIX path → UTF-8 text.
 *
 * Rejects escapes (`..`, absolute paths, drive letters, backslashes) through the
 * domain's own {@link isSafeArtifactPath}, then re-checks the resolved absolute
 * path is still inside the workspace before reading. A leading BOM is stripped —
 * the project's own incident history (API-CONTRACTS §6.1) is why encoding is
 * handled explicitly here rather than trusted.
 *
 * @param workspace - absolute workspace root.
 * @param onError - optional observer for "exists but unreadable / too large".
 * @returns the reader.
 */
export function createWorkspaceArtifactReader(workspace, onError) {
    const root = resolve(workspace);
    return (relative) => {
        if (!isSafeArtifactPath(relative)) {
            onError?.({ path: relative, reason: '不是安全的工作区相对 POSIX 路径' });
            return undefined;
        }
        const target = resolve(root, relative);
        if (target !== root && !target.startsWith(root + sep)) {
            onError?.({ path: relative, reason: '解析后的绝对路径越出工作区' });
            return undefined;
        }
        try {
            const info = statSync(target);
            if (!info.isFile()) {
                onError?.({ path: relative, reason: '不是普通文件' });
                return undefined;
            }
            if (info.size > MAX_ARTIFACT_BYTES) {
                onError?.({ path: relative, reason: `文件超过 ${MAX_ARTIFACT_BYTES} 字节上限（${info.size}）` });
                return undefined;
            }
            const text = readFileSync(target, 'utf8');
            return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        }
        catch (error) {
            // `ArtifactReader` documents `undefined` as "does not exist", so ENOENT is
            // the only failure that may stay silent. Every other I/O failure (EBUSY,
            // EACCES, EPERM, a directory that raced us, a vanished symlink target) is
            // NOT a missing file — reporting it here is what stops the domain from
            // telling the captain "工件不存在" about a document that is sitting right
            // there. Downstream this surfaces through `GateRunResult.readErrors`.
            const code = error?.code;
            if (code !== 'ENOENT') {
                const detail = error instanceof Error ? error.message : String(error);
                onError?.({ path: relative, reason: `读取失败（${typeof code === 'string' ? code : '未知错误'}）: ${detail}` });
            }
            return undefined;
        }
    };
}
/* ------------------------------------------------------------- helpers */
/** Builds a failed script verdict with explicit reason text. */
function refusedResult(reason, at) {
    return { type: 'script', ok: false, detail: reason, at };
}
/** Maps one command outcome into the shape `domain/gates` reads back. */
function outcomeResult(outcome, at) {
    return {
        type: 'script',
        ok: outcome.ok,
        detail: outcome.detail,
        ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
        at,
    };
}
/** Splits `git log --oneline` output into commit subject lines. */
export function parseGitLog(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/** Splits `git tag --list` output into tag names. */
export function parseGitTags(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
function dodStateOf(item) {
    // `status` must survive the projection: it is the machine-readable field the
    // `dod` gate switches on, and dropping it here would let a `skipped` item
    // fall back to `ok: true` = "satisfied" (review finding H5).
    return {
        id: item.id,
        label: item.label,
        ok: item.ok,
        status: item.status,
        ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
    };
}
/* --------------------------------------------------------------- factory */
/**
 * Creates the gate executor.
 *
 * @param options - workspace, context and executor policy.
 * @returns the runner. When no executor is available the runner still evaluates
 *   content gates normally and reports every command as `拒绝执行: 无可用命令执行器`
 *   — a gate can therefore never pass on evidence that does not exist.
 */
export function createGateRunner(options) {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const readErrors = [];
    const readArtifact = options.readArtifact ??
        createWorkspaceArtifactReader(options.workspace, (info) => {
            readErrors.push(info);
        });
    const resolution = options.runner !== undefined
        ? { runner: options.runner, source: 'injected' }
        : resolveCommandRunnerDetailed(options.ctx, {
            ...(options.allowNodeFallback !== undefined ? { allowNodeFallback: options.allowNodeFallback } : {}),
            ...(options.preferNodeRunner !== undefined ? { preferNode: options.preferNodeRunner } : {}),
        });
    const runOnce = async (command, signal, runner) => {
        const outcome = await runner.run(command, {
            cwd: options.workspace,
            timeoutMs,
            maxOutputBytes,
            ...(signal !== undefined ? { signal } : {}),
        });
        options.onCommand?.(outcome);
        return outcome;
    };
    /**
     * Everything that must be true before a template command may be started.
     *
     * Returns the runner on success, so a caller cannot reach {@link runOnce}
     * without one: the old shape returned a bare refusal string and left the call
     * site to apply `runner!`, an invariant that lived in the ordering of two
     * functions rather than in the types. A refusal that only exists because the
     * probe failed quotes the probe's own reason instead of asserting a cause.
     */
    const refusalFor = (command, pipeline) => {
        const trimmed = command.trim();
        if (trimmed.length === 0)
            return { allowed: false, refusal: '空命令，拒绝执行' };
        if (!isSafeGateCommand(trimmed)) {
            return { allowed: false, refusal: `命令未通过安全校验（含 shell 元字符或危险动词），拒绝执行: ${trimmed}` };
        }
        const allow = collectTemplateCommands(pipeline ?? PIPELINE_IDS[0] ?? 'fullstack');
        if (!allow.has(trimmed)) {
            return {
                allowed: false,
                refusal: `命令不在流水线模板 ${String(pipeline)} 的白名单内，拒绝执行: ${trimmed}（命令只能来自模板，不接受模型自由指定）`,
            };
        }
        if (resolution.runner === undefined) {
            return { allowed: false, refusal: `无可用命令执行器（${resolution.reason}），拒绝执行: ${trimmed}` };
        }
        return { allowed: true, runner: resolution.runner };
    };
    const collectGitFacts = async (signal) => {
        const outcomes = [];
        const texts = [];
        for (const command of DOD_GIT_COMMANDS) {
            const verdict = refusalFor(command, undefined);
            if (!verdict.allowed) {
                return {
                    outcomes,
                    error: verdict.refusal,
                };
            }
            const outcome = await runOnce(command, signal, verdict.runner);
            outcomes.push(outcome);
            texts.push(outcome.stdout);
            if (!outcome.ok) {
                return { outcomes, error: `git 事实采集失败：${outcome.detail}` };
            }
        }
        const [log = '', tags = ''] = texts;
        return { facts: { commits: parseGitLog(log), tags: parseGitTags(tags) }, outcomes };
    };
    const runDod = async (context) => {
        const executed = {};
        /** Execution evidence collected per item, merged onto the domain verdicts afterwards. */
        const evidence = new Map();
        const skipped = [];
        let git = { outcomes: [] };
        for (const item of DOD_ITEMS) {
            if (item.securityOnly === true && !context.securityTriggered) {
                skipped.push(item.id);
                evidence.set(item.id, []);
                continue;
            }
            if (item.kind === 'git') {
                git = await collectGitFacts(context.signal);
                evidence.set(item.id, git.outcomes);
                continue;
            }
            if (item.kind !== 'script') {
                evidence.set(item.id, []);
                continue;
            }
            const command = (item.run ?? '').trim();
            const verdict = refusalFor(command, context.pipeline);
            if (!verdict.allowed) {
                executed[item.id] = { ok: false, detail: verdict.refusal };
                evidence.set(item.id, []);
                continue;
            }
            const outcome = await runOnce(command, context.signal, verdict.runner);
            executed[item.id] = {
                ok: outcome.ok,
                detail: outcome.detail,
                ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
            };
            evidence.set(item.id, [outcome]);
        }
        const audit = evaluateDod({
            readFile: readArtifact,
            executed,
            ...(git.facts !== undefined ? { git: git.facts } : {}),
            securityTriggered: context.securityTriggered,
            ...(context.minCommits !== undefined ? { minCommits: context.minCommits } : {}),
        });
        // The verdicts are the domain's; this module only attaches what it executed.
        const items = audit.results.map((result) => ({
            result,
            outcomes: evidence.get(result.id) ?? [],
        }));
        const failed = audit.summary.failed;
        const pending = audit.summary.pending;
        const skippedCount = audit.summary.skipped;
        return {
            audit,
            items,
            git,
            skipped,
            detail: 
            // `summary.passed` counts machine-verified items only, so a skipped
            // security audit is reported as skipped and never as a pass (H5).
            `DoD ${audit.summary.passed}/${audit.summary.total} 通过`
                + (skippedCount > 0 ? `（跳过 ${skippedCount} 条 securityOnly）` : '')
                + (failed > 0 ? `，未达标 ${failed} 条` : '')
                + (pending > 0 ? `，待执行 ${pending} 条` : ''),
        };
    };
    const runGateDetailed = async (def, context) => {
        const at = now();
        const before = readErrors.length;
        // Pass 1 — decide without touching the outside world.
        const dry = evaluateGate(def, { readArtifact, at });
        if (!dry.needsExecution) {
            return { evaluation: dry, outcomes: [], refused: [], readErrors: readErrors.slice(before), at };
        }
        const executed = {};
        const outcomes = [];
        const refused = [];
        const wanted = new Set(dry.pendingCommands.map((command) => command.trim()));
        for (const node of collectGateScripts(def)) {
            if (!wanted.has(node.command))
                continue;
            const verdict = refusalFor(node.command, context.pipeline);
            if (!verdict.allowed) {
                executed[node.signature] = refusedResult(verdict.refusal, at);
                refused.push(verdict.refusal);
                continue;
            }
            const outcome = await runOnce(node.command, context.signal, verdict.runner);
            outcomes.push(outcome);
            executed[node.signature] = outcomeResult(outcome, at);
        }
        // A `dod` gate reports `needsExecution` without `pendingCommands`, so the
        // DoD audit is driven by the gate tree itself.
        const needsDod = containsDodGate(def);
        const dod = needsDod ? await runDod({ ...context }) : undefined;
        const dodStates = dod?.audit.results.map((item) => dodStateOf(item));
        const evaluation = evaluateGate(def, {
            readArtifact,
            executed,
            ...(dodStates !== undefined ? { dod: dodStates } : {}),
            at,
        });
        return {
            evaluation,
            outcomes,
            refused,
            ...(dod !== undefined ? { dod } : {}),
            readErrors: readErrors.slice(before),
            at,
        };
    };
    return {
        executor: resolution.runner?.kind,
        workspace: options.workspace,
        timeoutMs,
        templateCommands: (pipeline) => [...collectTemplateCommands(pipeline)].sort(),
        runGateDetailed,
        runGate: async (def, context) => (await runGateDetailed(def, context)).evaluation,
        runDod,
        collectGitFacts,
    };
}
//# sourceMappingURL=gates-runner.js.map