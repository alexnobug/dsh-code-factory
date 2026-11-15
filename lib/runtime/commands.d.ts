/**
 * commands.ts — the **command executor** behind the gate runner.
 *
 * A gate verdict must never come from model prose: `script` gates and DoD item
 * 2/5/7 are decided by a real process exit code. This module is the only place
 * in code-factory that starts a process.
 *
 * ## The sanctioned path: `ctx.subprocess`
 *
 * The host exposes an abstract subprocess service (`ctx.subprocess`), verified
 * live for this runtime:
 *
 *   `cordis_inspect_query` → host `Service.listService {service:'subprocess'}`
 *   - `resolveExecutable(command, env?, signal?): Promise<string>`
 *   - `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`   ← synchronous handle
 *
 * The referenced types are copied verbatim from that live answer (they belong to
 * `@deepseek-ai/dsh-subprocess`, which is **not** installed in this project's
 * `node_modules`, so they cannot be imported; the service access expression the
 * live contract itself documents is `ctx.get("subprocess")`, which is what
 * {@link subprocessRuntimeOf} uses):
 *
 * ```ts
 * interface SubprocessSpawnSpec { argv: readonly string[]; cwd: string; stdio: SubprocessStdio;
 *                                  graceMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
 * interface SubprocessStdio    { stdin: SubprocessStdinMode; stdout: SubprocessOutputMode;
 *                                stderr: SubprocessOutputMode; control?: 'pipe' }
 * type SubprocessOutputMode    = 'pipe' | 'inherit' | SubprocessCollect
 * interface SubprocessCollect  { maxBytes: number; spill?: { maxBytes: number } }
 * interface SubprocessHandle   { readonly collected: SubprocessCollectedOutputs;
 *                                readonly done: Promise<SubprocessOutcome>;
 *                                terminate(): void; waitForExit(signal?): Promise<boolean> }
 * interface SubprocessOutputReader { readFrom(fromByte: number): SubprocessOutputRead }
 * interface SubprocessOutcome { exitCode: number | null; signal: NodeJS.Signals | null }
 * ```
 *
 * Two consequences shape this file:
 *  1. **`argv`, not a shell string.** "Start one managed child process from a
 *     fully-specified spec; this seam applies no defaults." A template command is
 *     therefore split into argv by {@link splitCommandLine} — which is safe
 *     because a template command has already passed
 *     `domain.isSafeGateCommand` (no `;` `&` `|` `` ` `` `$(` `>` `<` newline),
 *     so there is nothing shell-ish left to interpret. `gates-runner.ts` re-runs
 *     that check (and the pipeline-template allowlist) before anything starts.
 *  2. **Collection must be requested**: `stdio.stdout/stderr = { maxBytes }`
 *     turns on the offset-based, non-consuming reader `Readable`-free path.
 *
 * ## Timeout and quiescence
 *
 * `handle.done` is raced against the timeout; on expiry `terminate()` starts the
 * provider's documented teardown and the race continues against
 * `graceMs + HARD_STOP_MS`, so a wedged child can neither hang a gate nor be
 * reported as a pass. A timed-out run is a **failed** gate with explicit
 * evidence (hard requirement #3) — never a pending verdict.
 *
 * ## Windows shims
 *
 * `npm`, `pnpm` and friends are `.cmd` shims on Windows and cannot be started
 * directly. The template commands are metacharacter-free by construction, so the
 * runner has a **bounded** fallback ladder: a `.cmd`/`.bat` target is started
 * through the command interpreter (`%ComSpec%`) first, and a failing direct start
 * is retried through it once. Both cases set `shellFallback: true` on the outcome
 * and say so in the evidence line — the same command, disclosed.
 *
 * ## Windows `bash` is the WSL launcher
 *
 * `bash` on PATH resolves to `C:\WINDOWS\system32\bash.exe`, which is the **WSL
 * launcher**: with no distro it dies on `execvpe(/bin/bash) failed` and the gate
 * reads a non-zero exit code for a command that never ran. Git Bash (`D:\Git\...`)
 * is a real bash but is not on PATH. `bash start.sh --check` reaches this module
 * through **three** different execution paths, so the preference is applied by one
 * shared resolver ({@link resolveShellArgv} / {@link resolveShellCommandLine},
 * both over {@link preferredShell}) instead of at each call site:
 *
 * | path | what would resolve `bash` | resolver |
 * | --- | --- | --- |
 * | `ctx.subprocess` direct start | the provider's own PATH lookup | {@link resolveShellArgv} |
 * | `%ComSpec% /d /s /c <line>` rung | cmd.exe's PATH lookup | {@link resolveShellCommandLine} |
 * | node fallback (`exec`) | cmd.exe's PATH lookup | {@link resolveShellCommandLine} |
 *
 * All three are required; applying the preference to only the first is the defect
 * this design exists to prevent.
 *
 * ## The node fallback
 *
 * `createNodeCommandRunner()` exists for tests and for a composition without the
 * subprocess service. It is **never** selected implicitly: the subprocess service
 * is the only path that runs inside the host's own execution world (sandbox,
 * PATH scrubbing, managed teardown), so bypassing it silently would be a
 * downgrade. Callers opt in with `allowNodeFallback: true`, and every outcome
 * records which path ran it (`via`).
 *
 * @module dsh-code-factory/runtime/commands
 */
import type { Context } from '@deepseek-ai/cordis';
/** One managed process outcome (live contract). */
export interface SubprocessOutcomeLike {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
}
/** One non-consuming read of a collected stream (live contract). */
export interface SubprocessOutputReadLike {
    readonly text: string;
    readonly nextOffset: number;
    readonly lossy: boolean;
    readonly spillPath?: string;
}
/** Offset reader over one collected stream (live contract). */
export interface SubprocessOutputReaderLike {
    readFrom(fromByte: number): SubprocessOutputReadLike;
}
/** Live handle of one managed process (live contract, trimmed to what is used). */
export interface SubprocessHandleLike {
    readonly collected?: {
        readonly stdout?: SubprocessOutputReaderLike;
        readonly stderr?: SubprocessOutputReaderLike;
    };
    readonly done: Promise<SubprocessOutcomeLike>;
    terminate(): void;
    waitForExit?(signal?: AbortSignal): Promise<boolean>;
}
/** Live spawn spec (live contract). */
export interface SubprocessSpawnSpecLike {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly stdio: {
        readonly stdin: 'ignore';
        readonly stdout: {
            readonly maxBytes: number;
        };
        readonly stderr: {
            readonly maxBytes: number;
        };
    };
    readonly graceMs: number;
    readonly signal?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
}
/** Live subprocess service surface (live contract, trimmed to what is used). */
export interface SubprocessRuntimeLike {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike;
}
/** Structural guard for the live subprocess service. */
export declare function isSubprocessRuntime(value: unknown): value is SubprocessRuntimeLike;
/** Why a composition does or does not expose a usable `ctx.subprocess`. */
export type SubprocessProbeStatus = 'available' | 'absent' | 'unusable' | 'threw';
/**
 * Outcome of probing `ctx.subprocess`.
 *
 * `threw` is deliberately its own status: folding a failed lookup into `absent`
 * would make the runtime claim "this composition has no subprocess service"
 * when the truth is "asking for it blew up" — a refusal message that asserts
 * something it cannot know. The reason travels with the status so callers can
 * report it verbatim.
 */
export interface SubprocessProbe {
    readonly status: SubprocessProbeStatus;
    /** Present only when `status === 'available'`. */
    readonly runtime?: SubprocessRuntimeLike;
    /** Present for `unusable` and `threw`. */
    readonly reason?: string;
}
/**
 * Resolves `ctx.subprocess` through the access expression the live service
 * contract documents for an optional consumer (`ctx.get("subprocess")`,
 * `requiresUndefinedCheck: true`). No module augmentation is used, so this
 * plugin stays correct whether or not `@deepseek-ai/dsh-subprocess` is installed
 * beside it.
 *
 * @param ctx - the plugin context.
 * @returns the probe, naming exactly why the service is unavailable when it is.
 */
export declare function probeSubprocessRuntime(ctx: Context): SubprocessProbe;
/**
 * @param ctx - the plugin context.
 * @returns the service, or `undefined` when this composition cannot run commands
 *   through it (see {@link probeSubprocessRuntime} for the reason).
 */
export declare function subprocessRuntimeOf(ctx: Context): SubprocessRuntimeLike | undefined;
/** How a command was executed. */
export type CommandRunnerKind = 'subprocess' | 'node' | 'injected';
/** Everything one command run needs. */
export interface CommandRunOptions {
    /** Absolute working directory (the factory workspace root). */
    readonly cwd: string;
    /** Wall-clock limit; `0` disables the timeout. Defaults to {@link DEFAULT_GATE_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Caller cancellation (tool signal). */
    readonly signal?: AbortSignal;
    /** Per-stream collected-byte ceiling. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
    readonly maxOutputBytes?: number;
}
/** The observed result of one command run. */
export interface CommandOutcome {
    readonly command: string;
    readonly argv: readonly string[];
    readonly ok: boolean;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputTruncated: boolean;
    readonly spillPath?: string;
    /** The executable actually started, when the host resolved a canonical path. */
    readonly resolvedExecutable?: string;
    /**
     * True when the command had to go through the platform command interpreter
     * (Windows `.cmd`/`.bat` shims such as `npm`). Recorded so evidence never
     * hides how the process was actually started.
     */
    readonly shellFallback?: boolean;
    readonly via: CommandRunnerKind;
    /** One-line evidence, always populated — the verbatim text a gate reports. */
    readonly detail: string;
}
/** A command executor. */
export interface CommandRunner {
    readonly kind: CommandRunnerKind;
    run(command: string, options: CommandRunOptions): Promise<CommandOutcome>;
}
/** Wall-clock limit for one template command (pytest / npm build are not fast). */
export declare const DEFAULT_GATE_TIMEOUT_MS = 300000;
/** Extra time given to a terminated process before it is declared unquiesced. */
export declare const HARD_STOP_MS = 10000;
/** How long `terminate()`'s teardown ladder may take before the spawn spec's own grace ends. */
export declare const SPAWN_GRACE_MS = 5000;
/** Per-stream collected-output ceiling (128 KiB) — enough for a gate verdict's evidence. */
export declare const DEFAULT_MAX_OUTPUT_BYTES = 131072;
/**
 * Splits one template command line into argv.
 *
 * Quote-aware (`"a b"` / `'a b'`) and escape-aware for backslashes inside quotes,
 * then whitespace-separated. This is deliberately **not** a shell: a template
 * command may not contain shell metacharacters at all
 * (`domain.gates.FORBIDDEN_COMMAND_FRAGMENTS`), and {@link isSafeGateCommand} is
 * re-checked by the runner before anything is started.
 *
 * @param command - the template command, e.g. `python -m pytest -q`.
 * @returns argv; `[]` when the command is blank.
 */
export declare function splitCommandLine(command: string): readonly string[];
/**
 * Applies the Windows shell preference to one already-split argv.
 *
 * This is the resolver for argv-based paths — today the direct `ctx.subprocess`
 * start — because a provider that receives the bare name `bash` resolves it
 * through PATH itself and hands the WSL launcher back.
 *
 * @param argv - argv from {@link splitCommandLine}.
 * @returns a **new** argv with `argv[0]` replaced by the preferred absolute
 *   executable, or the **same array instance** when nothing was rewritten. That
 *   identity is the documented "no rewrite happened" signal; callers may use it to
 *   report whether a preference applied.
 */
export declare function resolveShellArgv(argv: readonly string[]): readonly string[];
/**
 * Applies the Windows shell preference to a raw command line, for the paths that
 * can only hand a **string** to a command interpreter (`%ComSpec% /d /s /c …` and
 * `node:child_process.exec`). Those re-resolve `bash` through PATH inside the
 * interpreter, which is precisely the WSL-launcher trap the argv resolver avoids.
 *
 * Only the head token is replaced; everything after it is passed through verbatim,
 * so the interpreter still sees exactly the command the template declared. The
 * replacement is quoted only when it contains whitespace (the
 * `C:/Program Files/Git/...` candidate), because cmd.exe splits on unquoted spaces.
 *
 * @param command - the raw template command line.
 * @returns the line an interpreter must execute, or `command` unchanged.
 */
export declare function resolveShellCommandLine(command: string): string;
/** Result of auditing the Windows shell preference (`ok: false` must fail the check). */
export interface ShellResolutionAudit {
    readonly ok: boolean;
    /** One line per violated invariant; empty when {@link ShellResolutionAudit.ok}. */
    readonly errors: readonly string[];
}
/**
 * Pure self-audit of the shared shell resolution — the regression guard for
 * *"the preference applied to one execution path only"*.
 *
 * It restates the invariants in one place so they are a machine check rather than
 * a claim in a report: every path resolves through {@link preferredShell}, nothing
 * that is not a bare `bash`/`sh` is ever touched, and a missing Git Bash leaves the
 * template command exactly as written (never a new failure mode).
 *
 * Platform-honest: off Windows, or on a Windows host without Git Bash, every
 * invariant it can state is "the command comes through unchanged".
 *
 * @returns the audit; `errors` is empty exactly when the invariants hold.
 */
export declare function auditShellResolution(): ShellResolutionAudit;
/** Builds the always-populated one-line evidence for an outcome. */
export declare function summarizeOutcome(outcome: CommandOutcome): string;
/**
 * Creates the sanctioned executor over `ctx.subprocess`.
 *
 * @param ctx - the plugin context.
 * @returns the runner, or `undefined` when the composition exposes no subprocess
 *   service (the caller then decides between an injected runner, the opt-in node
 *   fallback, and failing the gate loudly).
 */
export declare function createSubprocessCommandRunner(ctx: Context): CommandRunner | undefined;
/**
 * The node fallback executor (`node:child_process.exec`), for tests and for a
 * composition without the subprocess service.
 *
 * It is opt-in on purpose: `ctx.subprocess` is the only path that runs inside the
 * host's execution world. Every outcome from this runner reports
 * `via: 'node'`, so evidence never overstates how a gate was decided.
 *
 * @param options - unused today; kept so a caller can pin argv behaviour later.
 * @returns the runner.
 */
export declare function createNodeCommandRunner(_options?: {
    readonly shell?: string;
}): CommandRunner;
/** Options for {@link resolveCommandRunner}. */
export interface ResolveCommandRunnerOptions {
    /** An explicitly injected runner (tests, embedding hosts). Highest priority. */
    readonly runner?: CommandRunner;
    /** Force the node fallback even when `ctx.subprocess` exists (tests only). */
    readonly preferNode?: boolean;
    /** Allow the node fallback when no subprocess service is mounted. Default `false`. */
    readonly allowNodeFallback?: boolean;
}
/** Where the executor came from, or the reason there is none. */
export type CommandRunnerResolution = {
    readonly runner: CommandRunner;
    readonly source: 'injected' | 'node-forced' | 'subprocess' | 'node-fallback';
} | {
    readonly runner: undefined;
    readonly reason: string;
};
/**
 * Picks the executor for this composition, keeping the reason when there is none.
 *
 * Order: injected runner → (forced) node runner → `ctx.subprocess` → opt-in node
 * fallback → none, with {@link noRunnerReason} naming why.
 *
 * @param ctx - the plugin context.
 * @param options - injection / fallback policy.
 * @returns the runner and its provenance, or the reason there is none.
 */
export declare function resolveCommandRunnerDetailed(ctx: Context, options?: ResolveCommandRunnerOptions): CommandRunnerResolution;
/**
 * Picks the executor for this composition.
 *
 * Order: injected runner → (forced) node runner → `ctx.subprocess` → opt-in node
 * fallback → `undefined` (the caller must then fail the gate loudly).
 *
 * @param ctx - the plugin context.
 * @param options - injection / fallback policy.
 * @returns the runner, or `undefined` when nothing may execute commands here.
 */
export declare function resolveCommandRunner(ctx: Context, options?: ResolveCommandRunnerOptions): CommandRunner | undefined;
