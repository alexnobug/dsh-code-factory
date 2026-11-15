/**
 * gates.ts — the five gate kinds, as pure verdict functions.
 *
 * This module owns the **judgement** half of the M5 gate executor: it inspects
 * artifact text and decides pass/fail. It never touches the filesystem and
 * never runs a command — the runtime injects artifact text and pre-computed
 * script results, and anything this layer cannot decide is returned with
 * `needsExecution: true` plus the exact commands to run (API-CONTRACTS §4.2:
 * `script`/`dod` execution belongs to the runtime; commands may only come from
 * the pipeline templates, never from model output).
 *
 * Gate semantics
 * - `checklist`  every required section must appear as a Markdown heading
 * - `keyword`    the **last** conclusion line wins (a report that was rejected
 *                in round 1 and approved in round 2 must pass)
 * - `script`     exit code 0; delegated to the runtime
 * - `composite`  logical AND over nested gates, evaluated recursively
 * - `dod`        the 7-item Definition-of-Done audit (+ optional artifact
 *                section anchors); delegated to the runtime
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects —
 * this file is bundled into the browser half via `tsconfig.client.json`.
 *
 * @module dsh-code-factory/domain/gates
 */
import type { DodState, DodStatus, GateDef, GateResult, GateType } from '../shared/types.js';
/**
 * All five gate kinds, in the order the cockpit legend lists them.
 *
 * Re-exported from `src/shared/types.ts` (review finding H8) so the browser
 * half's payload parser and this validator cannot disagree about the set.
 */
export { GATE_TYPES } from '../shared/types.js';
/** Human labels (zh-CN) used by the feed, the cockpit legend and tool output. */
export declare const GATE_TYPE_LABELS: Readonly<Record<GateType, string>>;
/** Nesting depth allowed for `composite` gates (guards a corrupt template). */
export declare const MAX_COMPOSITE_DEPTH = 4;
/** Longest accepted template command. */
export declare const MAX_GATE_COMMAND_LENGTH = 240;
/**
 * Shell metacharacters / destructive verbs rejected inside a template gate
 * command. Commands are authored in `pipeline.ts` only; this is defence in
 * depth against a hand-edited or model-mutated template.
 */
export declare const FORBIDDEN_COMMAND_FRAGMENTS: readonly string[];
/** Destructive command shapes rejected even when quoting looks harmless. */
export declare const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[];
/** Result of validating one gate definition (parameters only, no execution). */
export interface GateValidation {
    readonly ok: boolean;
    readonly errors: readonly string[];
}
/** Reads one workspace-relative artifact; `undefined` = file does not exist. */
export type ArtifactReader = (path: string) => string | undefined;
/** Verdict of a gate evaluation: a `GateResult` plus execution hints. */
export interface GateEvaluation extends GateResult {
    /** True when this gate (or a nested child) still needs a runtime action. */
    readonly needsExecution: boolean;
    /** Commands the runtime must execute, in order, before a verdict exists. */
    readonly pendingCommands: readonly string[];
    /** Per-child verdicts for `composite` gates. */
    readonly children?: readonly GateEvaluation[];
}
/**
 * Everything the pure evaluator may look at. Every field is optional: with no
 * reader and no executed results every content gate reports `needsExecution`
 * instead of inventing a verdict.
 */
export interface GateEvalInput {
    readonly readArtifact?: ArtifactReader;
    /** Pre-computed script verdicts keyed by {@link gateCommandSignature}. */
    readonly executed?: Readonly<Record<string, GateResult>>;
    /** DoD verdicts for `dod` gates, as produced by `domain/dod.ts` (three-state `DodState.status`). */
    readonly dod?: readonly DodState[];
    /** Timestamp stamped on the verdicts; the runtime passes its own clock. */
    readonly at?: number;
}
/** One line of a conclusion scan. */
export interface ConclusionScan {
    readonly verdict: 'pass' | 'fail' | 'none';
    readonly line: string;
    /** 1-based line number, `0` when nothing matched. */
    readonly lineNo: number;
}
/**
 * Normalises text for conclusion matching: lower-cased, full-width colon
 * folded, and **all whitespace removed** so `结论: PASS`, `结论:PASS` and
 * `结论 :  PASS` are the same thing.
 */
export declare function normalizeForMatch(text: string): string;
/** Markdown headings (`## 安装`) with the leading hashes and spaces stripped. */
export declare function markdownHeadings(content: string): readonly string[];
/** Required sections that do not appear as a Markdown heading, in input order. */
export declare function missingHeadings(content: string, required: readonly string[]): readonly string[];
/** True when a command may be used as a template gate command. */
export declare function isSafeGateCommand(run: string): boolean;
/** True when an artifact reference is a safe workspace-relative POSIX path. */
export declare function isSafeArtifactPath(path: string): boolean;
/**
 * Stable execution key for a gate definition. The runtime stores the script /
 * DoD results under this key and hands them back through `GateEvalInput`.
 */
export declare function gateCommandSignature(def: GateDef): string;
/** True when this gate kind can never be decided without the runtime. */
export declare function isExecutableGate(type: GateType): boolean;
/** True when this gate definition (recursively) needs a runtime action. */
export declare function gateNeedsExecution(def: GateDef): boolean;
/**
 * Validates one gate definition and every nested child. Parameter validation
 * only — nothing here executes or reads a file.
 */
export declare function validateGateDef(def: GateDef, path?: string, depth?: number): GateValidation;
/**
 * Scans a report for its verdict. The **last** matching line decides, so a
 * multi-round document (`结论: REJECTED` … `结论: APPROVED`) passes; a tie on
 * the same line resolves to fail (conservative).
 */
export declare function scanConclusion(content: string, passWord: string, failWord: string): ConclusionScan;
/**
 * The fields {@link dodStatusOf} needs: `domain/dod.ts` hands it its fully
 * resolved flags, a persisted row only carries `ok` (plus `status` from the
 * moment this version wrote it).
 */
export interface DodStatusSource {
    readonly ok: boolean;
    /** Present on every row written since `DodStatus` existed. */
    readonly status?: DodStatus;
    /** True while the item still owes a file read or a command. */
    readonly needsExecution?: boolean;
    /** True for a `securityOnly` item skipped on a non-security factory. */
    readonly skipped?: boolean;
}
/**
 * The three-state verdict of one DoD item or row, derived in one place so no
 * reader re-invents it and no reader falls back to the bare boolean:
 * `passed` (machine-verified) / `skipped` (never applicable to this factory) /
 * `failed`, plus `pending` while the item still owes a file read or a command.
 *
 * The three verdicts are deliberately not collapsible into `ok`: a skipped
 * security audit is *satisfied* (it must not block delivery) yet it was never
 * *checked*, and reporting that as a pass is exactly the defect review finding
 * H5 described. `skipped` is therefore read before `ok`.
 *
 * Rows written before `DodStatus` existed carry no `status`, so they fall back
 * to the legacy `ok` boolean — which by construction could not tell a verified
 * item from a `securityOnly` skip (review finding H5). The runtime always
 * writes `status` now, so the fallback only ever applies to old records.
 *
 * @param item - a DoD row, as produced by `domain/dod.ts` or read from state.
 * @returns the row's verdict.
 */
export declare function dodStatusOf(item: DodStatusSource): DodStatus;
/**
 * True only for a verdict that may clear a delivery gate: `passed` was
 * machine-verified and `skipped` never applied to this factory. `failed` and
 * `pending` may not — collapsing `skipped` into "satisfied" is the defect
 * review finding H5 reported.
 *
 * @param item - a DoD row, as produced by `domain/dod.ts` or read from state.
 * @returns whether this row is decided and non-blocking.
 */
export declare function dodAllowsDelivery(item: DodState): boolean;
/**
 * Evaluates one gate. Pure: identical inputs always produce an identical
 * verdict, and anything that needs the outside world is reported as
 * `needsExecution` with `pendingCommands` rather than guessed.
 */
export declare function evaluateGate(def: GateDef, input?: GateEvalInput): GateEvaluation;
