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

import type { Context } from '@deepseek-ai/cordis'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* ------------------------------------------------------------ live shapes */

/** One managed process outcome (live contract). */
export interface SubprocessOutcomeLike {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** One non-consuming read of a collected stream (live contract). */
export interface SubprocessOutputReadLike {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
  readonly spillPath?: string
}

/** Offset reader over one collected stream (live contract). */
export interface SubprocessOutputReaderLike {
  readFrom(fromByte: number): SubprocessOutputReadLike
}

/** Live handle of one managed process (live contract, trimmed to what is used). */
export interface SubprocessHandleLike {
  readonly collected?: {
    readonly stdout?: SubprocessOutputReaderLike
    readonly stderr?: SubprocessOutputReaderLike
  }
  readonly done: Promise<SubprocessOutcomeLike>
  terminate(): void
  waitForExit?(signal?: AbortSignal): Promise<boolean>
}

/** Live spawn spec (live contract). */
export interface SubprocessSpawnSpecLike {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore'
    readonly stdout: { readonly maxBytes: number }
    readonly stderr: { readonly maxBytes: number }
  }
  readonly graceMs: number
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

/** Live subprocess service surface (live contract, trimmed to what is used). */
export interface SubprocessRuntimeLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike
}

/** Structural guard for the live subprocess service. */
export function isSubprocessRuntime(value: unknown): value is SubprocessRuntimeLike {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { spawn?: unknown; resolveExecutable?: unknown }
  return typeof candidate.spawn === 'function' && typeof candidate.resolveExecutable === 'function'
}

/** Why a composition does or does not expose a usable `ctx.subprocess`. */
export type SubprocessProbeStatus = 'available' | 'absent' | 'unusable' | 'threw'

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
  readonly status: SubprocessProbeStatus
  /** Present only when `status === 'available'`. */
  readonly runtime?: SubprocessRuntimeLike
  /** Present for `unusable` and `threw`. */
  readonly reason?: string
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
export function probeSubprocessRuntime(ctx: Context): SubprocessProbe {
  let candidate: unknown
  try {
    candidate = (ctx as unknown as { get(name: string): unknown }).get('subprocess')
  } catch (error) {
    return { status: 'threw', reason: describeError(error) }
  }
  if (candidate === undefined || candidate === null) return { status: 'absent' }
  if (!isSubprocessRuntime(candidate)) {
    return { status: 'unusable', reason: 'ctx.subprocess 缺少 spawn / resolveExecutable，不符合服务契约' }
  }
  return { status: 'available', runtime: candidate }
}

/**
 * @param ctx - the plugin context.
 * @returns the service, or `undefined` when this composition cannot run commands
 *   through it (see {@link probeSubprocessRuntime} for the reason).
 */
export function subprocessRuntimeOf(ctx: Context): SubprocessRuntimeLike | undefined {
  const probe = probeSubprocessRuntime(ctx)
  return probe.status === 'available' ? probe.runtime : undefined
}

/* ------------------------------------------------------------------ types */

/** How a command was executed. */
export type CommandRunnerKind = 'subprocess' | 'node' | 'injected'

/** Everything one command run needs. */
export interface CommandRunOptions {
  /** Absolute working directory (the factory workspace root). */
  readonly cwd: string
  /** Wall-clock limit; `0` disables the timeout. Defaults to {@link DEFAULT_GATE_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Caller cancellation (tool signal). */
  readonly signal?: AbortSignal
  /** Per-stream collected-byte ceiling. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxOutputBytes?: number
}

/** The observed result of one command run. */
export interface CommandOutcome {
  readonly command: string
  readonly argv: readonly string[]
  readonly ok: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated: boolean
  readonly spillPath?: string
  /** The executable actually started, when the host resolved a canonical path. */
  readonly resolvedExecutable?: string
  /**
   * True when the command had to go through the platform command interpreter
   * (Windows `.cmd`/`.bat` shims such as `npm`). Recorded so evidence never
   * hides how the process was actually started.
   */
  readonly shellFallback?: boolean
  readonly via: CommandRunnerKind
  /** One-line evidence, always populated — the verbatim text a gate reports. */
  readonly detail: string
}

/** A command executor. */
export interface CommandRunner {
  readonly kind: CommandRunnerKind
  run(command: string, options: CommandRunOptions): Promise<CommandOutcome>
}

/** Wall-clock limit for one template command (pytest / npm build are not fast). */
export const DEFAULT_GATE_TIMEOUT_MS = 300_000

/** Extra time given to a terminated process before it is declared unquiesced. */
export const HARD_STOP_MS = 10_000

/** How long `terminate()`'s teardown ladder may take before the spawn spec's own grace ends. */
export const SPAWN_GRACE_MS = 5_000

/** Per-stream collected-output ceiling (128 KiB) — enough for a gate verdict's evidence. */
export const DEFAULT_MAX_OUTPUT_BYTES = 131_072

/** Longest text quoted into a one-line detail. */
const DETAIL_HEAD = 220

/* --------------------------------------------------- windows bash fallback */

/** Git Bash installs that provide a real bash where PATH's `bash` is the WSL launcher. */
const WINDOWS_BASH_CANDIDATES: readonly string[] = [
  'D:/Git/bin/bash.exe',
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
]

/**
 * Bare shell names that must never be resolved through PATH on Windows.
 *
 * PATH's `bash` is `C:\WINDOWS\system32\bash.exe` — the **WSL launcher**, not GNU
 * bash: without a distro it exits non-zero after `execvpe(/bin/bash) failed`. A
 * bare `sh` does not resolve at all. Both are kept here (rather than being
 * assumed by a caller) so every execution path asks the same question.
 */
const WINDOWS_SHELL_NAMES: readonly string[] = ['bash', 'sh']

/**
 * The bash this host should start when a template command asks for `bash`.
 *
 * On Windows the bare name resolves to the WSL launcher, which fails unless the
 * default distro ships `/bin/bash`; Git Bash is a real bash but is not on PATH.
 * The preference is used only when the file exists, and never off Windows, so
 * the template command (and the DoD command signature) stays `bash start.sh --check`.
 */
function preferredBash(): string | undefined {
  if (process.platform !== 'win32') return undefined
  return WINDOWS_BASH_CANDIDATES.find((candidate) => existsSync(candidate))
}

/**
 * The bare lowercase program name of an argv head, or `undefined` when the head
 * already names a path.
 *
 * `bash`, `BASH`, `bash.exe` → `'bash'`; `/usr/bin/bash` and `D:\Git\bin\bash.exe`
 * → `undefined`, because an explicit path is a deliberate choice this module must
 * not second-guess.
 */
function bareProgramName(program: string): string | undefined {
  if (program.includes('/') || program.includes('\\')) return undefined
  return program.toLowerCase().replace(/\.exe$/, '')
}

/**
 * The absolute executable to start in place of one bare `bash` / `sh`, or
 * `undefined` to leave the command exactly as the template wrote it.
 *
 * `sh` prefers Git's own `sh.exe` beside the bash that was found (it keeps
 * POSIX-mode semantics) and otherwise falls back to that bash, which runs POSIX
 * scripts and is still strictly better than a bare name that does not resolve on
 * Windows at all. Never throws and never invents a path: no Git Bash on disk means
 * "keep the bare name", so this can only turn a guaranteed failure into a working
 * command — it never starts failing where the bare name would at least have tried.
 *
 * The one preference, three consumers: the direct `ctx.subprocess` start, the
 * `%ComSpec%` interpreter rung and the node `exec` fallback all reach it through
 * the two resolvers below, so it cannot be "simplified" out of one of them.
 */
function preferredShell(program: string): string | undefined {
  const name = bareProgramName(program)
  if (name === undefined || !WINDOWS_SHELL_NAMES.includes(name)) return undefined
  const bash = preferredBash()
  if (bash === undefined) return undefined
  if (name === 'sh') {
    const sibling = join(dirname(bash), 'sh.exe')
    if (existsSync(sibling)) return sibling
  }
  return bash
}

/* ------------------------------------------------------------ argv split */

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
export function splitCommandLine(command: string): readonly string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== undefined) {
      if (char === '\\' && index + 1 < command.length) {
        index += 1
        current += command[index] ?? ''
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) argv.push(current)
      current = ''
      started = false
      continue
    }
    current += char
  }
  if (started || current.length > 0) argv.push(current)
  return argv
}

/* --------------------------------------------------------- shell resolver */

/**
 * Start/end offsets of the leading program token of a command line, skipping
 * leading whitespace and honouring a quoted head (`"bash" x`).
 *
 * @param command - the raw template command line.
 * @returns the half-open span of the token that names the program.
 */
function leadingProgramSpan(command: string): { readonly start: number; readonly end: number } {
  let index = 0
  while (index < command.length && /\s/.test(command[index] ?? '')) index += 1
  const start = index
  let quote: '"' | "'" | undefined
  while (index < command.length) {
    const char = command[index] ?? ''
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (/\s/.test(char)) break
    index += 1
  }
  return { start, end: index }
}

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
export function resolveShellArgv(argv: readonly string[]): readonly string[] {
  const head = argv[0]
  if (head === undefined) return argv
  const preferred = preferredShell(head)
  if (preferred === undefined) return argv
  return [preferred, ...argv.slice(1)]
}

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
export function resolveShellCommandLine(command: string): string {
  const head = splitCommandLine(command)[0]
  if (head === undefined) return command
  const preferred = preferredShell(head)
  if (preferred === undefined) return command
  const span = leadingProgramSpan(command)
  const quoted = /\s/.test(preferred) ? `"${preferred}"` : preferred
  return `${command.slice(0, span.start)}${quoted}${command.slice(span.end)}`
}

/** Result of auditing the Windows shell preference (`ok: false` must fail the check). */
export interface ShellResolutionAudit {
  readonly ok: boolean
  /** One line per violated invariant; empty when {@link ShellResolutionAudit.ok}. */
  readonly errors: readonly string[]
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
export function auditShellResolution(): ShellResolutionAudit {
  const errors: string[] = []
  const bashLine = 'bash start.sh --check'
  const bashArgv: readonly string[] = splitCommandLine(bashLine)
  const pythonArgv: readonly string[] = ['python', '-m', 'pytest', '-q']
  const pinnedArgv: readonly string[] = ['D:/Git/bin/bash.exe', 'start.sh', '--check']
  const emptyArgv: readonly string[] = []
  const preferred = preferredShell('bash')

  // A command that is not a bare shell name must survive untouched, everywhere.
  if (resolveShellArgv(pythonArgv) !== pythonArgv) errors.push('非 shell argv 被改写: python -m pytest -q')
  if (resolveShellArgv(emptyArgv) !== emptyArgv) errors.push('空 argv 被改写')
  if (resolveShellArgv(pinnedArgv) !== pinnedArgv) errors.push('已写绝对路径的 argv 被改写')
  if (resolveShellCommandLine('python -m pytest -q') !== 'python -m pytest -q') errors.push('非 shell 命令行被改写: python')
  if (resolveShellCommandLine('git log --oneline') !== 'git log --oneline') errors.push('非 shell 命令行被改写: git')
  if (resolveShellCommandLine('') !== '') errors.push('空命令行被改写')
  const indented = resolveShellCommandLine(`  ${bashLine}`)
  if (indented !== `  ${resolveShellCommandLine(bashLine)}`) errors.push(`前导空白未原样保留: ${indented}`)

  const rewrittenArgv = resolveShellArgv(bashArgv)
  const rewrittenLine = resolveShellCommandLine(bashLine)
  if (preferred === undefined) {
    // No Git Bash on this host: the bare name must be left to try, unchanged.
    if (rewrittenArgv !== bashArgv) errors.push('无 Git Bash 时 argv 被改写')
    if (rewrittenLine !== bashLine) errors.push(`无 Git Bash 时命令行被改写: ${rewrittenLine}`)
    return { ok: errors.length === 0, errors }
  }

  const quoted = /\s/.test(preferred) ? `"${preferred}"` : preferred
  if (!existsSync(preferred)) errors.push(`首选 bash 不存在: ${preferred}`)
  if (rewrittenArgv[0] !== preferred) errors.push(`argv 头不是首选 bash: ${rewrittenArgv[0] ?? '（空）'}`)
  if (rewrittenArgv.slice(1).join(' ') !== 'start.sh --check') errors.push(`argv 其余参数被改写: ${rewrittenArgv.join(' ')}`)
  if (rewrittenLine !== `${quoted} start.sh --check`) errors.push(`解释器命令行不是首选 bash: ${rewrittenLine}`)
  if (rewrittenLine.startsWith('bash ')) errors.push('解释器命令行仍以裸 bash 开头（会再次命中 WSL 启动器）')
  const shArgv = resolveShellArgv(['sh', '-c', 'true'])
  const shProgram = shArgv[0] ?? ''
  if (shProgram === 'sh') errors.push('裸 sh 未被解析')
  else if (!existsSync(shProgram)) errors.push(`sh 未解析到真实文件: ${shProgram}`)
  if (shArgv.slice(1).join(' ') !== '-c true') errors.push(`sh 其余参数被改写: ${shArgv.join(' ')}`)

  return { ok: errors.length === 0, errors }
}

/* --------------------------------------------------------------- helpers */

/** Trims one text to the detail head and normalises newlines. */
function head(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ⏎ ').trim()
  return flat.length > DETAIL_HEAD ? `${flat.slice(0, DETAIL_HEAD)}…` : flat
}

/** First non-empty line of whichever stream said something. */
function tailHint(stdout: string, stderr: string): string {
  const source = stderr.trim().length > 0 ? stderr : stdout
  return head(source)
}

/** Reads a collected stream, tolerating a provider that did not expose readers. */
function readReader(reader: SubprocessOutputReaderLike | undefined): {
  readonly text: string
  readonly lossy: boolean
  readonly spillPath?: string
} {
  if (reader === undefined || typeof reader.readFrom !== 'function') return { text: '', lossy: false }
  try {
    const read = reader.readFrom(0)
    return {
      text: typeof read?.text === 'string' ? read.text : '',
      lossy: read?.lossy === true,
      ...(typeof read?.spillPath === 'string' ? { spillPath: read.spillPath } : {}),
    }
  } catch {
    return { text: '', lossy: true }
  }
}

/** Builds the always-populated one-line evidence for an outcome. */
export function summarizeOutcome(outcome: CommandOutcome): string {
  const where =
    outcome.via === 'node'
      ? '（node 回退执行器）'
      : outcome.shellFallback === true
        ? '（经命令解释器 / shell shim）'
        : ''
  if (outcome.timedOut) {
    return `⏱ 超时 ${outcome.durationMs}ms 已终止：${outcome.command}${where}`
  }
  if (outcome.aborted) {
    return `⛔ 已取消：${outcome.command}${where}`
  }
  if (outcome.exitCode === null && outcome.signal === null) {
    return `⚠ 未能启动：${outcome.command}${where} —— ${head(outcome.stderr)}`
  }
  if (outcome.ok) {
    return `退出码 0（${outcome.durationMs}ms）：${outcome.command}${where}`
  }
  const hint = tailHint(outcome.stdout, outcome.stderr)
  const code = outcome.exitCode === null ? `signal ${outcome.signal ?? '?'}` : `退出码 ${outcome.exitCode}`
  return `${code}（${outcome.durationMs}ms）：${outcome.command}${where}${hint.length > 0 ? ` —— ${hint}` : ''}`
}

/** Composes the final outcome record and its detail line. */
function finalize(partial: Omit<CommandOutcome, 'ok' | 'detail'> & { readonly ok?: boolean }): CommandOutcome {
  const ok = partial.ok ?? (!partial.timedOut && !partial.aborted && partial.exitCode === 0)
  const outcome: CommandOutcome = { ...partial, ok, detail: '' }
  // Assigned after construction so `detail` can summarise the finished record.
  return { ...outcome, detail: summarizeOutcome(outcome) }
}

/** Failures that never reached a running process. */
function unstarted(
  command: string,
  argv: readonly string[],
  via: CommandRunnerKind,
  message: string,
  startedAt: number,
  extra: Partial<CommandOutcome> = {},
): CommandOutcome {
  return finalize({
    command,
    argv,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: message,
    outputTruncated: false,
    via,
    ...extra,
  })
}

/* ------------------------------------------------------- subprocess runner */

/** True for a Windows shim (`.cmd` / `.bat`), which Node cannot exec without an interpreter. */
function isWindowsShim(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable)
}

/**
 * The interpreter form of one template command.
 *
 * On Windows `npm` resolves to `npm.cmd`, and a `.cmd`/`.bat` cannot be started
 * directly (`CreateProcess` needs an interpreter). The template commands are
 * already metacharacter-free (`domain.isSafeGateCommand`), so handing the raw
 * command string to the platform interpreter is the same command, not a second
 * one — and the outcome records `shellFallback: true` so evidence never hides it.
 */
function interpreterArgv(command: string): readonly string[] {
  const shell = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
  return [shell, '/d', '/s', '/c', command]
}

/**
 * Creates the sanctioned executor over `ctx.subprocess`.
 *
 * @param ctx - the plugin context.
 * @returns the runner, or `undefined` when the composition exposes no subprocess
 *   service (the caller then decides between an injected runner, the opt-in node
 *   fallback, and failing the gate loudly).
 */
export function createSubprocessCommandRunner(ctx: Context): CommandRunner | undefined {
  const runtime = subprocessRuntimeOf(ctx)
  if (runtime === undefined) return undefined

  const terminate = (handle: SubprocessHandleLike): void => {
    try {
      handle.terminate()
    } catch {
      /* the provider owns its teardown ladder; a failing terminate is not a verdict */
    }
  }

  return {
    kind: 'subprocess',
    async run(command: string, options: CommandRunOptions): Promise<CommandOutcome> {
      const startedAt = Date.now()
      const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
      const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const argv = splitCommandLine(command)
      if (argv.length === 0) return unstarted(command, argv, 'subprocess', '空命令', startedAt)
      // Windows: swap a bare `bash`/`sh` for Git Bash *before* the provider's own
      // PATH lookup, which would canonicalise it to the WSL launcher. `preferred`
      // stays undefined when nothing was rewritten (identity is the contract of
      // `resolveShellArgv`), so the resolution below keeps its old behaviour.
      const shellArgv = resolveShellArgv(argv)
      const preferred = shellArgv === argv ? undefined : shellArgv[0]
      const executable = preferred ?? argv[0] ?? ''

      let resolvedExecutable: string | undefined
      let resolveNote = ''
      try {
        const resolved = await runtime.resolveExecutable(executable, undefined, options.signal)
        if (typeof resolved === 'string' && resolved.length > 0) resolvedExecutable = resolved
      } catch (error) {
        resolveNote = `解析可执行文件 "${executable}" 失败（${describeError(error)}）；改用 PATH 裸名执行。`
      }

      // The interpreter rungs below hand a *string* to %ComSpec%, which resolves
      // `bash` through PATH again — so they get the same preference (see the
      // module header: three paths, one resolver pair).
      const shellCommand = resolveShellCommandLine(command)
      const directArgv: readonly string[] = preferred === undefined
        ? (resolvedExecutable === undefined ? argv : [resolvedExecutable, ...argv.slice(1)])
        : shellArgv
      const stdio = { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes } } as const
      const attempt = (attemptArgv: readonly string[]): SubprocessHandleLike =>
        runtime.spawn({
          argv: attemptArgv,
          cwd: options.cwd,
          stdio,
          graceMs: SPAWN_GRACE_MS,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })

      /** Bounded fallback ladder: a shim goes through the interpreter first, a
       * direct start is retried through it only when the start itself failed. */
      const ladder: readonly { argv: readonly string[]; shellFallback: boolean }[] =
        process.platform === 'win32'
          ? isWindowsShim(directArgv[0] ?? '')
            ? [
                { argv: interpreterArgv(shellCommand), shellFallback: true },
                { argv: directArgv, shellFallback: false },
              ]
            : [
                { argv: directArgv, shellFallback: false },
                { argv: interpreterArgv(shellCommand), shellFallback: true },
              ]
          : [{ argv: directArgv, shellFallback: false }]

      let handle: SubprocessHandleLike | undefined
      let spawnArgv: readonly string[] = directArgv
      let shellFallback = false
      let spawnError: unknown
      for (const rung of ladder) {
        try {
          handle = attempt(rung.argv)
          spawnArgv = rung.argv
          shellFallback = rung.shellFallback
          spawnError = undefined
          break
        } catch (error) {
          spawnError = error
        }
      }
      if (handle === undefined) {
        return unstarted(command, spawnArgv, 'subprocess', `${resolveNote}启动失败: ${describeError(spawnError)}`, startedAt)
      }

      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const donePromise = handle.done.then(
        (outcome) => ({ kind: 'done' as const, outcome }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      )
      const timeoutPromise =
        timeoutMs > 0
          ? new Promise<{ kind: 'timeout' }>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true
                terminate(handle)
                resolve({ kind: 'timeout' })
              }, timeoutMs)
            })
          : undefined

      const first = timeoutPromise === undefined ? await donePromise : await Promise.race([donePromise, timeoutPromise])
      if (first.kind === 'timeout') {
        // Terminated; give the provider's teardown ladder its documented grace.
        let hardTimer: ReturnType<typeof setTimeout> | undefined
        const hardStop = new Promise<{ kind: 'hard' }>((resolve) => {
          hardTimer = setTimeout(() => resolve({ kind: 'hard' }), SPAWN_GRACE_MS + HARD_STOP_MS)
        })
        const second = await Promise.race([donePromise, hardStop])
        if (hardTimer !== undefined) clearTimeout(hardTimer)
        if (timer !== undefined) clearTimeout(timer)
        const stdout = readReader(handle.collected?.stdout)
        const stderr = readReader(handle.collected?.stderr)
        const note = second.kind === 'done' ? '' : '；终止后仍未观察到退出，已放弃等待'
        return finalize({
          command,
          argv: spawnArgv,
          exitCode: second.kind === 'done' ? second.outcome.exitCode : null,
          signal: second.kind === 'done' ? second.outcome.signal : null,
          timedOut: true,
          aborted: options.signal?.aborted === true,
          durationMs: Date.now() - startedAt,
          stdout: stdout.text,
          stderr: `${stderr.text}${note}`,
          outputTruncated: stdout.lossy || stderr.lossy,
          ...(stdout.spillPath !== undefined ? { spillPath: stdout.spillPath } : {}),
          ...(resolvedExecutable !== undefined ? { resolvedExecutable } : {}),
          shellFallback,
          via: 'subprocess',
        })
      }
      if (timer !== undefined) clearTimeout(timer)

      if (first.kind === 'failed') {
        return unstarted(command, spawnArgv, 'subprocess', `子进程失败: ${describeError(first.error)}`, startedAt, {
          ...(resolvedExecutable !== undefined ? { resolvedExecutable } : {}),
          shellFallback,
        })
      }

      const stdout = readReader(handle.collected?.stdout)
      const stderr = readReader(handle.collected?.stderr)
      const abortedByCaller = options.signal?.aborted === true
      return finalize({
        command,
        argv: spawnArgv,
        exitCode: first.outcome.exitCode,
        signal: first.outcome.signal,
        timedOut: false,
        aborted: abortedByCaller && first.outcome.exitCode !== 0,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text,
        stderr: `${resolveNote}${stderr.text}`,
        outputTruncated: stdout.lossy || stderr.lossy,
        ...(stdout.spillPath !== undefined ? { spillPath: stdout.spillPath } : {}),
        ...(resolvedExecutable !== undefined ? { resolvedExecutable } : {}),
        shellFallback,
        via: 'subprocess',
      })
    },
  }
}

/* ------------------------------------------------------------- node runner */

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
export function createNodeCommandRunner(_options: { readonly shell?: string } = {}): CommandRunner {
  return {
    kind: 'node',
    run(command: string, options: CommandRunOptions): Promise<CommandOutcome> {
      const startedAt = Date.now()
      const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
      const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      // `exec` takes a *string* and always goes through the platform command
      // interpreter, so a bare `bash` would be resolved by cmd.exe's PATH lookup
      // (→ the WSL launcher). This runner gets the same central preference as the
      // subprocess runner; `command` (the template text) is still what the outcome
      // reports, while `argv` now records what actually started.
      const executedCommand = resolveShellCommandLine(command)
      const argv = splitCommandLine(executedCommand)
      return new Promise<CommandOutcome>((resolve) => {
        let settled = false
        const finish = (outcome: CommandOutcome): void => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
        try {
          const child = exec(
            executedCommand,
            {
              cwd: options.cwd,
              timeout: timeoutMs > 0 ? timeoutMs : 0,
              maxBuffer: maxBytes,
              windowsHide: true,
              encoding: 'utf8',
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            },
            (error, stdout, stderr) => {
              const text = typeof stdout === 'string' ? stdout : ''
              const err = typeof stderr === 'string' ? stderr : ''
              const killed = (error as (Error & { killed?: boolean; signal?: NodeJS.Signals }) | null)?.killed === true
              const signal = (error as (Error & { signal?: NodeJS.Signals }) | null)?.signal ?? null
              const callerAborted = options.signal?.aborted === true
              const timedOut = killed && !callerAborted && timeoutMs > 0
              const exitCode = error === null ? 0 : killed ? null : Number((error as { code?: unknown }).code ?? 1) || 1
              finish(
                finalize({
                  command,
                  argv,
                  exitCode,
                  signal,
                  timedOut,
                  aborted: error !== null && !timedOut && callerAborted,
                  durationMs: Date.now() - startedAt,
                  stdout: text,
                  stderr: error === null ? err : `${err}${err.length > 0 ? ' ' : ''}${head(describeError(error))}`,
                  outputTruncated: false,
                  // `exec` always goes through the platform shell.
                  shellFallback: true,
                  via: 'node',
                }),
              )
            },
          )
          child.on('error', (error) => {
            finish(unstarted(command, argv, 'node', describeError(error), startedAt, { shellFallback: true }))
          })
        } catch (error) {
          finish(unstarted(command, argv, 'node', describeError(error), startedAt, { shellFallback: true }))
        }
      })
    },
  }
}

/* ------------------------------------------------------------------ glue */

/** Options for {@link resolveCommandRunner}. */
export interface ResolveCommandRunnerOptions {
  /** An explicitly injected runner (tests, embedding hosts). Highest priority. */
  readonly runner?: CommandRunner
  /** Force the node fallback even when `ctx.subprocess` exists (tests only). */
  readonly preferNode?: boolean
  /** Allow the node fallback when no subprocess service is mounted. Default `false`. */
  readonly allowNodeFallback?: boolean
}

/** Where the executor came from, or the reason there is none. */
export type CommandRunnerResolution =
  | { readonly runner: CommandRunner; readonly source: 'injected' | 'node-forced' | 'subprocess' | 'node-fallback' }
  | { readonly runner: undefined; readonly reason: string }

/**
 * Truthful reason no executor is available, quoted from the probe rather than
 * assumed. {@link resolveCommandRunner} drops this; a caller that must *explain*
 * a refusal (the gate runner) keeps it.
 */
function noRunnerReason(probe: SubprocessProbe, allowNodeFallback: boolean): string {
  if (probe.status === 'threw') {
    return `探测 ctx.subprocess 失败：${probe.reason ?? '未知原因'}`
  }
  if (probe.status === 'unusable') {
    return `ctx.subprocess 存在但不可用：${probe.reason ?? '不符合服务契约'}`
  }
  if (probe.status === 'available') {
    return 'ctx.subprocess 可用但未能构造执行器'
  }
  return allowNodeFallback
    ? 'ctx.subprocess 不可用，且 node 回退执行器无法构造'
    : 'ctx.subprocess 不可用且未启用 node 回退'
}

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
export function resolveCommandRunnerDetailed(
  ctx: Context,
  options: ResolveCommandRunnerOptions = {},
): CommandRunnerResolution {
  if (options.runner !== undefined) return { runner: options.runner, source: 'injected' }
  if (options.preferNode === true) return { runner: createNodeCommandRunner(), source: 'node-forced' }
  const probe = probeSubprocessRuntime(ctx)
  if (probe.status === 'available') {
    const subprocess = createSubprocessCommandRunner(ctx)
    if (subprocess !== undefined) return { runner: subprocess, source: 'subprocess' }
  }
  if (options.allowNodeFallback === true) return { runner: createNodeCommandRunner(), source: 'node-fallback' }
  // Past the fallback branch, `allowNodeFallback` is known not to be true.
  return { runner: undefined, reason: noRunnerReason(probe, false) }
}

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
export function resolveCommandRunner(
  ctx: Context,
  options: ResolveCommandRunnerOptions = {},
): CommandRunner | undefined {
  return resolveCommandRunnerDetailed(ctx, options).runner
}

/** Compact one-line description of a thrown value (kept local: no import cycle). */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
