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
import type { Context } from '@deepseek-ai/cordis';
import type { GateDef, PipelineId } from '../shared/types.js';
import type { ArtifactReader, GateEvaluation } from '../domain/gates.js';
import type { DodAudit, DodEvalResult, DodGitFacts } from '../domain/dod.js';
import type { CommandOutcome, CommandRunner, CommandRunnerKind } from './commands.js';
/**
 * Every command one pipeline template may legitimately request: all `script`
 * gate commands reachable from its stages, plus the DoD command constants.
 *
 * @param pipeline - the template id (unknown ids yield the DoD commands only).
 * @returns the closed command set for that template.
 */
export declare function collectTemplateCommands(pipeline: PipelineId): ReadonlySet<string>;
/** True when this gate tree contains a `dod` node (the DoD audit must run). */
export declare function containsDodGate(def: GateDef): boolean;
/** One script node of a gate tree: its command plus the signature the domain reads back. */
export interface GateScriptNode {
    readonly command: string;
    readonly signature: string;
}
/** All `script` nodes of a gate tree, in template order. */
export declare function collectGateScripts(def: GateDef): readonly GateScriptNode[];
/** How many bytes of one artifact are read before the reader gives up. */
export declare const MAX_ARTIFACT_BYTES: number;
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
export declare function createWorkspaceArtifactReader(workspace: string, onError?: (info: {
    readonly path: string;
    readonly reason: string;
}) => void): ArtifactReader;
/** One gate execution request. */
export interface GateRunContext {
    /** Pipeline the gate belongs to (allow-list scope). */
    readonly pipeline: PipelineId;
    /** Stage id, for evidence and logs. */
    readonly stageId: string;
    /** Round counter (0 = first attempt). */
    readonly round?: number;
    /** Whether the factory took the security path (gates DoD item 4). */
    readonly securityTriggered: boolean;
    /** Minimum commit count for DoD item 7; defaults to the domain's 1. */
    readonly minCommits?: number;
    /** Cancellation for every command of this gate. */
    readonly signal?: AbortSignal;
}
/** One DoD audit request. */
export interface DodRunContext {
    /** Whether the factory took the security path. */
    readonly securityTriggered: boolean;
    /** Allow-list scope; optional because a DoD check may be run without a stage. */
    readonly pipeline?: PipelineId;
    /** Minimum commit count for item 7 (逐阶段 commit 的实际门限). */
    readonly minCommits?: number;
    /** Cancellation. */
    readonly signal?: AbortSignal;
}
/** Git facts gathered for DoD item 7. */
export interface GitFactsResult {
    readonly facts?: DodGitFacts;
    readonly outcomes: readonly CommandOutcome[];
    readonly error?: string;
}
/** One DoD item verdict with its execution evidence. */
export interface DodItemOutcome {
    readonly result: DodEvalResult;
    /** Commands run for this item, in order (empty for file/keyword/crossref). */
    readonly outcomes: readonly CommandOutcome[];
}
/** Full DoD audit result: the domain audit plus everything executed for it. */
export interface DodAuditResult {
    readonly audit: DodAudit;
    readonly items: readonly DodItemOutcome[];
    readonly git: GitFactsResult;
    /** Items skipped because the factory did not trigger the security path. */
    readonly skipped: readonly number[];
    readonly detail: string;
}
/** The detailed result of one gate evaluation. */
export interface GateRunResult {
    /** The domain verdict (never computed here). */
    readonly evaluation: GateEvaluation;
    /** Every command this evaluation actually started, in order. */
    readonly outcomes: readonly CommandOutcome[];
    /** Commands refused before execution (safety / allow-list / no executor). */
    readonly refused: readonly string[];
    /** The DoD audit, when the gate tree contained a `dod` node. */
    readonly dod?: DodAuditResult;
    /** Artifact reads that failed for a reason other than "missing". */
    readonly readErrors: readonly {
        readonly path: string;
        readonly reason: string;
    }[];
    readonly at: number;
}
/** Options for {@link createGateRunner}. */
export interface GateRunnerOptions {
    /** Plugin context, used to resolve `ctx.subprocess`. */
    readonly ctx: Context;
    /** Absolute workspace root — always `caller.session.header.cwd` (陷阱 #3). */
    readonly workspace: string;
    /** Artifact reader override; defaults to {@link createWorkspaceArtifactReader}. */
    readonly readArtifact?: ArtifactReader;
    /** Executor override (tests / embedding host). */
    readonly runner?: CommandRunner;
    /** Timeout per command; defaults to {@link DEFAULT_GATE_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Per-stream output ceiling; defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
    readonly maxOutputBytes?: number;
    /** Allow the node fallback when `ctx.subprocess` is absent. Default `false`. */
    readonly allowNodeFallback?: boolean;
    /** Force the node executor (tests). */
    readonly preferNodeRunner?: boolean;
    /** Clock override. */
    readonly now?: () => number;
    /** Observer for every started command (feed / session events). */
    readonly onCommand?: (outcome: CommandOutcome) => void;
}
/** The gate/DoD executor. */
export interface GateRunner {
    /** Which executor is wired, or `undefined` when no command may run here. */
    readonly executor: CommandRunnerKind | undefined;
    readonly workspace: string;
    readonly timeoutMs: number;
    /** Command vocabulary of one template (for diagnostics/UI). */
    templateCommands(pipeline: PipelineId): readonly string[];
    /** Evaluates one gate, executing whatever the domain asked for. */
    runGate(def: GateDef, context: GateRunContext): Promise<GateEvaluation>;
    /** Same, plus the raw evidence (for the feed and `factory_gate`). */
    runGateDetailed(def: GateDef, context: GateRunContext): Promise<GateRunResult>;
    /** Runs the seven DoD items with real execution. */
    runDod(context: DodRunContext): Promise<DodAuditResult>;
    /** Runs `git log --oneline` / `git tag --list` only. */
    collectGitFacts(signal?: AbortSignal): Promise<GitFactsResult>;
}
/** Splits `git log --oneline` output into commit subject lines. */
export declare function parseGitLog(text: string): readonly string[];
/** Splits `git tag --list` output into tag names. */
export declare function parseGitTags(text: string): readonly string[];
/**
 * Creates the gate executor.
 *
 * @param options - workspace, context and executor policy.
 * @returns the runner. When no executor is available the runner still evaluates
 *   content gates normally and reports every command as `拒绝执行: 无可用命令执行器`
 *   — a gate can therefore never pass on evidence that does not exist.
 */
export declare function createGateRunner(options: GateRunnerOptions): GateRunner;
