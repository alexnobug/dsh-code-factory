/**
 * dod.ts — the seven Definition-of-Done items and their pure verification.
 *
 * Round-trip of the prototype's 「DoD 七条（机器校验，缺一不予交付）」. Like
 * `gates.ts` this module owns judgement only: content comes in through an
 * injected reader, commands and git facts come in through injected results, and
 * anything that needs the outside world is returned with `needsExecution: true`
 * plus the exact commands the runtime must run. Nothing here is allowed to
 * treat model prose as evidence.
 *
 * Item → verifier mapping
 * 1 crossref  每条 AC-n 在 TEST_REPORT.md 里都有对应用例
 * 2 script    `python -m pytest -q` 退出码 0
 * 3 keyword   REVIEW.md 的最终结论是 APPROVED
 * 4 keyword   SECURITY_AUDIT.md 的最终结论是 SEC_PASS（仅安全路径触发时校验）
 * 5 script    `bash start.sh --check` 退出码 0
 * 6 file      README.md 存在，且含 简介 / 安装 / 启动 / 接口一览 四个标题
 * 7 git       逐阶段 commit 且打出 v1.0.0 tag
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects.
 *
 * @module dsh-code-factory/domain/dod
 */
import type { DodItemDef, DodState, DodStatus } from '../shared/types.js';
/** Separator used inside `DodItemDef.expect` to list several required sections. */
export declare const DOD_SECTION_SEPARATOR = "|";
/** The four README sections DoD item 6 requires. */
export declare const README_REQUIRED_SECTIONS: readonly string[];
/** Commands the runtime must run to answer DoD item 7. */
export declare const DOD_GIT_COMMANDS: readonly string[];
/** The delivery tag DoD item 7 requires. */
export declare const DOD_RELEASE_TAG = "v1.0.0";
/**
 * Opposite verdict for a keyword DoD item, so the **last** conclusion wins
 * (a report rejected in round 1 and approved in round 2 must pass).
 * Keys are `normalizeForMatch`ed.
 */
export declare const CONCLUSION_OPPOSITES: Readonly<Record<string, string>>;
/** The seven machine-checkable DoD items, in prototype order. */
export declare const DOD_ITEMS: readonly DodItemDef[];
/** Number of DoD items the cockpit reports as `N/7`. */
export declare const DOD_TOTAL: number;
/** A pre-computed script result handed in by the runtime. */
export interface DodExecuted {
    readonly ok: boolean;
    readonly detail?: string;
    readonly exitCode?: number;
}
/** Git facts the runtime gathered for item 7. */
export interface DodGitFacts {
    /** Commit subjects, oldest first (`git log --oneline`). */
    readonly commits?: readonly string[];
    /** Tag names (`git tag --list`). */
    readonly tags?: readonly string[];
}
/** Everything the pure DoD checker may look at; all optional. */
export interface DodEvalInput {
    /** Reads one workspace-relative file; `undefined` = does not exist. */
    readonly readFile?: (path: string) => string | undefined;
    /** Script verdicts keyed by DoD item id. */
    readonly executed?: Readonly<Record<number, DodExecuted>>;
    /** Git facts for item 7. */
    readonly git?: DodGitFacts;
    /** Set when the factory took the security path; gates item 4 in/out. */
    readonly securityTriggered?: boolean;
    /** Minimum commit count for the "逐阶段 commit" half of item 7 (default 1). */
    readonly minCommits?: number;
}
/** One evaluated DoD item: `DodState` (the persisted shape) plus hints. */
export interface DodEvalResult extends DodState {
    /** Three-state verdict; this layer always decides, so it is never absent (see `DodStatus`). */
    readonly status: DodStatus;
    readonly evidence: string;
    /** True when the runtime must still read a file or run a command. */
    readonly needsExecution: boolean;
    /** Commands to run before this item can be decided. */
    readonly pendingCommands: readonly string[];
    /** True for `securityOnly` items skipped on a non-security factory. */
    readonly skipped: boolean;
}
/** Roll-up of one full DoD audit. */
export interface DodSummary {
    readonly total: number;
    /** Items with `status: 'passed'` — verified. Skipped items are **not** counted here. */
    readonly passed: number;
    readonly failed: number;
    /** `securityOnly` items skipped because the security path was not triggered. */
    readonly skipped: number;
    /** Items still owing execution (`status: 'pending'`). */
    readonly pending: number;
    /** True only when nothing failed and nothing is pending (`skipped` does not block delivery). */
    readonly ok: boolean;
    /** Labels of the failed / pending items, for the rejection email. */
    readonly missing: readonly string[];
}
/** Full DoD audit result. */
export interface DodAudit {
    readonly results: readonly DodEvalResult[];
    readonly summary: DodSummary;
}
/** Looks up one DoD item definition by id. */
export declare function getDodItem(id: number): DodItemDef | undefined;
/** Splits a `file` item's `expect` into required Markdown sections. */
export declare function parseSectionExpectation(expect: string | undefined): readonly string[];
/** Unique `AC-n` acceptance ids in document order. */
export declare function extractAcceptanceIds(text: string): readonly string[];
/** Commands still owed to the DoD audit, for the runtime to execute. */
export declare function pendingDodCommands(defs?: readonly DodItemDef[]): readonly string[];
/**
 * Evaluates one DoD item. Pure and total: an unwired reader or missing git
 * facts produce `needsExecution`, never a fabricated verdict.
 */
export declare function evaluateDodItem(def: DodItemDef, input?: DodEvalInput): DodEvalResult;
/** Runs the whole audit and rolls it up. */
export declare function evaluateDod(input?: DodEvalInput, defs?: readonly DodItemDef[]): DodAudit;
/** Result of auditing the DoD item definitions themselves. */
export interface DodValidation {
    readonly ok: boolean;
    readonly errors: readonly string[];
}
/** Parameter audit for the 7 items — catches an item that could never pass. */
export declare function validateDodItems(defs?: readonly DodItemDef[]): DodValidation;
