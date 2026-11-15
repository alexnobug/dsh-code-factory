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
import { GATE_TYPES } from '../shared/types.js';
/* --------------------------------------------------------------- consts */
/**
 * All five gate kinds, in the order the cockpit legend lists them.
 *
 * Re-exported from `src/shared/types.ts` (review finding H8) so the browser
 * half's payload parser and this validator cannot disagree about the set.
 */
export { GATE_TYPES } from '../shared/types.js';
/** Human labels (zh-CN) used by the feed, the cockpit legend and tool output. */
export const GATE_TYPE_LABELS = {
    checklist: '章节清单',
    keyword: '结论行',
    script: '脚本退出码',
    composite: '组合门禁',
    dod: 'DoD 总验收',
};
/** Nesting depth allowed for `composite` gates (guards a corrupt template). */
export const MAX_COMPOSITE_DEPTH = 4;
/** Longest accepted template command. */
export const MAX_GATE_COMMAND_LENGTH = 240;
/**
 * Shell metacharacters / destructive verbs rejected inside a template gate
 * command. Commands are authored in `pipeline.ts` only; this is defence in
 * depth against a hand-edited or model-mutated template.
 */
export const FORBIDDEN_COMMAND_FRAGMENTS = [
    ';', '&', '|', '`', '$(', '${', '>', '<', '\n', '\r',
];
/** Destructive command shapes rejected even when quoting looks harmless. */
export const DANGEROUS_COMMAND_PATTERNS = [
    /\brm\s+-[a-z]*[rf]/i,
    /\bmkfs\b/i,
    /\bformat\s+[a-z]:/i,
    /\bshutdown\b/i,
    /\b(del|rd|rmdir)\s+\/[a-z]/i,
];
/* ------------------------------------------------------------ text tools */
/**
 * Normalises text for conclusion matching: lower-cased, full-width colon
 * folded, and **all whitespace removed** so `结论: PASS`, `结论:PASS` and
 * `结论 :  PASS` are the same thing.
 */
export function normalizeForMatch(text) {
    return text.replace(/\s+/g, '').replace(/：/g, ':').toLowerCase();
}
/** Markdown headings (`## 安装`) with the leading hashes and spaces stripped. */
export function markdownHeadings(content) {
    const headings = [];
    for (const raw of content.split(/\r?\n/)) {
        const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
        if (match && match[1])
            headings.push(match[1].trim());
    }
    return headings;
}
/** Required sections that do not appear as a Markdown heading, in input order. */
export function missingHeadings(content, required) {
    const headings = markdownHeadings(content).map((heading) => normalizeForMatch(heading));
    return required.filter((section) => {
        const needle = normalizeForMatch(section);
        return !headings.some((heading) => heading.includes(needle));
    });
}
/** True when a command may be used as a template gate command. */
export function isSafeGateCommand(run) {
    const command = run.trim();
    if (command.length === 0 || command.length > MAX_GATE_COMMAND_LENGTH)
        return false;
    for (const fragment of FORBIDDEN_COMMAND_FRAGMENTS) {
        if (command.includes(fragment))
            return false;
    }
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(command))
            return false;
    }
    return true;
}
/** True when an artifact reference is a safe workspace-relative POSIX path. */
export function isSafeArtifactPath(path) {
    const value = path.trim();
    if (value.length === 0)
        return false;
    if (value.startsWith('/') || value.includes('\\'))
        return false;
    if (/^[a-zA-Z]:/.test(value))
        return false;
    return !value.split('/').some((segment) => segment === '..');
}
/**
 * Stable execution key for a gate definition. The runtime stores the script /
 * DoD results under this key and hands them back through `GateEvalInput`.
 */
export function gateCommandSignature(def) {
    if (def.type === 'script')
        return `script:${(def.run ?? '').trim()}`;
    if (def.type === 'dod')
        return `dod:${def.artifact ?? '*'}`;
    return `${def.type}:${def.artifact ?? '*'}:${def.passWord ?? ''}`;
}
/** True when this gate kind can never be decided without the runtime. */
export function isExecutableGate(type) {
    return type === 'script' || type === 'dod';
}
/** True when this gate definition (recursively) needs a runtime action. */
export function gateNeedsExecution(def) {
    if (isExecutableGate(def.type))
        return true;
    if (def.type === 'composite')
        return (def.checks ?? []).some((check) => gateNeedsExecution(check));
    return false;
}
/* ------------------------------------------------------------ validation */
/**
 * Validates one gate definition and every nested child. Parameter validation
 * only — nothing here executes or reads a file.
 */
export function validateGateDef(def, path = 'gate', depth = 0) {
    const errors = [];
    const at = (message) => {
        errors.push(`${path}: ${message}`);
    };
    if (!def || typeof def !== 'object') {
        at('门禁定义必须是对象');
        return { ok: false, errors };
    }
    if (!GATE_TYPES.includes(def.type)) {
        at(`未知门禁类型 ${String(def.type)}`);
        return { ok: false, errors };
    }
    if (depth > MAX_COMPOSITE_DEPTH) {
        at(`composite 嵌套超过 ${MAX_COMPOSITE_DEPTH} 层`);
        return { ok: false, errors };
    }
    if (def.artifact !== undefined && !isSafeArtifactPath(def.artifact)) {
        at(`artifact 必须是工作区相对 POSIX 路径: ${def.artifact}`);
    }
    switch (def.type) {
        case 'checklist': {
            if (!def.artifact)
                at('checklist 门禁必须给出 artifact');
            if (!def.requiredSections || def.requiredSections.length === 0) {
                at('checklist 门禁必须给出非空 requiredSections');
            }
            else if (def.requiredSections.some((section) => section.trim().length === 0)) {
                at('requiredSections 含空字符串');
            }
            break;
        }
        case 'keyword': {
            if (!def.artifact)
                at('keyword 门禁必须给出 artifact');
            if (!def.passWord && !def.failWord)
                at('keyword 门禁至少要给出 passWord 或 failWord');
            if (def.passWord && def.failWord && normalizeForMatch(def.passWord) === normalizeForMatch(def.failWord)) {
                at('passWord 与 failWord 不能相同');
            }
            break;
        }
        case 'script': {
            if (!def.run || def.run.trim().length === 0)
                at('script 门禁必须给出 run 命令');
            else if (!isSafeGateCommand(def.run))
                at(`run 命令被安全校验拒绝（只能来自流水线模板）: ${def.run}`);
            break;
        }
        case 'composite': {
            const checks = def.checks ?? [];
            if (checks.length === 0)
                at('composite 门禁必须给出非空 checks');
            checks.forEach((check, index) => {
                const nested = validateGateDef(check, `${path}.checks[${index}]`, depth + 1);
                errors.push(...nested.errors);
            });
            break;
        }
        case 'dod': {
            if (def.requiredSections && def.requiredSections.length > 0 && !def.artifact) {
                at('dod 门禁给出 requiredSections 时必须同时给出 artifact');
            }
            if (def.requiredSections && def.requiredSections.some((section) => section.trim().length === 0)) {
                at('requiredSections 含空字符串');
            }
            break;
        }
    }
    return { ok: errors.length === 0, errors };
}
/* -------------------------------------------------------- conclusion scan */
/**
 * Scans a report for its verdict. The **last** matching line decides, so a
 * multi-round document (`结论: REJECTED` … `结论: APPROVED`) passes; a tie on
 * the same line resolves to fail (conservative).
 */
export function scanConclusion(content, passWord, failWord) {
    const pass = normalizeForMatch(passWord);
    const fail = normalizeForMatch(failWord);
    const lines = content.split(/\r?\n/);
    let passIdx = -1;
    let failIdx = -1;
    let passLine = '';
    let failLine = '';
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const normalized = normalizeForMatch(line);
        if (fail.length > 0 && normalized.includes(fail)) {
            failIdx = index;
            failLine = line.trim();
        }
        if (pass.length > 0 && normalized.includes(pass)) {
            passIdx = index;
            passLine = line.trim();
        }
    }
    if (passIdx < 0 && failIdx < 0)
        return { verdict: 'none', line: '', lineNo: 0 };
    if (passIdx >= 0 && (failIdx < 0 || passIdx > failIdx)) {
        return { verdict: 'pass', line: passLine, lineNo: passIdx + 1 };
    }
    return { verdict: 'fail', line: failLine, lineNo: failIdx + 1 };
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
export function dodStatusOf(item) {
    if (item.status !== undefined)
        return item.status;
    if (item.needsExecution === true)
        return 'pending';
    if (item.skipped === true)
        return 'skipped';
    return item.ok ? 'passed' : 'failed';
}
/**
 * True only for a verdict that may clear a delivery gate: `passed` was
 * machine-verified and `skipped` never applied to this factory. `failed` and
 * `pending` may not — collapsing `skipped` into "satisfied" is the defect
 * review finding H5 reported.
 *
 * @param item - a DoD row, as produced by `domain/dod.ts` or read from state.
 * @returns whether this row is decided and non-blocking.
 */
export function dodAllowsDelivery(item) {
    const status = dodStatusOf(item);
    return status === 'passed' || status === 'skipped';
}
/* ------------------------------------------------------------ evaluation */
/** Creates a verdict object with the shared fields filled in. */
function verdict(def, ok, detail, at, extra = {}) {
    const result = {
        type: def.type,
        ok,
        detail,
        at,
        artifact: def.artifact,
        needsExecution: false,
        pendingCommands: [],
        ...extra,
    };
    return result;
}
/** Reads an artifact, distinguishing "missing file" from "no reader wired". */
function readArtifact(input, path) {
    if (!input.readArtifact)
        return { kind: 'pending' };
    const content = input.readArtifact(path);
    if (content === undefined)
        return { kind: 'missing' };
    return { kind: 'content', content };
}
/**
 * Evaluates one gate. Pure: identical inputs always produce an identical
 * verdict, and anything that needs the outside world is reported as
 * `needsExecution` with `pendingCommands` rather than guessed.
 */
export function evaluateGate(def, input = {}) {
    const at = input.at ?? 0;
    const validation = validateGateDef(def);
    if (!validation.ok) {
        return verdict(def, false, `门禁定义非法: ${validation.errors[0] ?? '未知参数错误'}`, at);
    }
    switch (def.type) {
        case 'checklist': {
            const artifact = def.artifact ?? '';
            const required = def.requiredSections ?? [];
            const read = readArtifact(input, artifact);
            if (read.kind === 'pending') {
                return verdict(def, false, `待读取工件: ${artifact}`, at, { needsExecution: true });
            }
            if (read.kind === 'missing') {
                return verdict(def, false, `工件不存在: ${artifact}`, at);
            }
            const missing = missingHeadings(read.content, required);
            if (missing.length === 0) {
                return verdict(def, true, `${artifact} 必备章节 ${required.length}/${required.length} 齐全`, at);
            }
            return verdict(def, false, `${artifact} 缺 ${missing.length}/${required.length} 节: ${missing.join('、')}`, at);
        }
        case 'keyword': {
            const artifact = def.artifact ?? '';
            const passWord = def.passWord ?? '';
            const failWord = def.failWord ?? '';
            const read = readArtifact(input, artifact);
            if (read.kind === 'pending') {
                return verdict(def, false, `待读取工件: ${artifact}`, at, { needsExecution: true });
            }
            if (read.kind === 'missing') {
                return verdict(def, false, `工件不存在: ${artifact}`, at);
            }
            const scan = scanConclusion(read.content, passWord, failWord);
            if (scan.verdict === 'pass') {
                return verdict(def, true, `${artifact}:${scan.lineNo} 命中「${passWord}」`, at);
            }
            if (scan.verdict === 'fail') {
                return verdict(def, false, `${artifact}:${scan.lineNo} 命中「${failWord}」: ${scan.line}`, at);
            }
            return verdict(def, false, `${artifact} 未发现结论行（需含「${passWord}」${failWord ? ` 或「${failWord}」` : ''}）`, at);
        }
        case 'script': {
            const run = (def.run ?? '').trim();
            const signature = gateCommandSignature(def);
            const done = input.executed?.[signature];
            if (!done) {
                return verdict(def, false, `待执行: ${run}`, at, { needsExecution: true, pendingCommands: [run] });
            }
            return verdict(def, done.ok, done.detail, at, { exitCode: done.exitCode });
        }
        case 'composite': {
            const checks = def.checks ?? [];
            const children = checks.map((check) => evaluateGate(check, input));
            const failed = children.filter((child) => !child.ok && !child.needsExecution);
            const pending = children.filter((child) => child.needsExecution);
            const pendingCommands = [...new Set(pending.flatMap((child) => [...child.pendingCommands]))];
            if (failed.length > 0) {
                // Verdict already decided: nothing must be executed any more, so the
                // execution hints stay empty (they describe *required* runtime work).
                return verdict(def, false, `组合门禁 ${children.length} 项中 ${failed.length} 项未通过: ${failed.map((child) => child.detail).join(' ∧ ')}`, at, { children });
            }
            if (pending.length > 0) {
                return verdict(def, false, `组合门禁待执行 ${pending.length}/${children.length} 项: ${pending.map((child) => child.detail).join(' ∧ ')}`, at, { children, needsExecution: true, pendingCommands });
            }
            return verdict(def, true, `组合门禁 ${children.length}/${children.length} 项通过`, at, { children });
        }
        case 'dod': {
            const sections = def.requiredSections ?? [];
            if (def.artifact && sections.length > 0) {
                const read = readArtifact(input, def.artifact);
                if (read.kind === 'pending') {
                    return verdict(def, false, `待读取工件: ${def.artifact}`, at, { needsExecution: true });
                }
                if (read.kind === 'missing') {
                    return verdict(def, false, `工件不存在: ${def.artifact}`, at);
                }
                const missing = missingHeadings(read.content, sections);
                if (missing.length > 0) {
                    return verdict(def, false, `${def.artifact} 缺 ${missing.length}/${sections.length} 节: ${missing.join('、')}`, at);
                }
            }
            const dod = input.dod ?? [];
            if (dod.length === 0) {
                return verdict(def, false, '待执行: DoD 总验收（7 条机器校验）', at, { needsExecution: true });
            }
            // `passed` and `skipped` clear the gate; `failed` and `pending` do not.
            // The count reports verified items only, so a skipped item is never
            // presented as a satisfied one (review finding H5).
            const blockingItems = dod.filter((item) => !dodAllowsDelivery(item));
            const passed = dod.filter((item) => dodStatusOf(item) === 'passed').length;
            const skipped = dod.filter((item) => dodStatusOf(item) === 'skipped').length;
            const skipNote = skipped > 0 ? `（跳过 ${skipped} 条未触发）` : '';
            if (blockingItems.length > 0) {
                return verdict(def, false, `DoD ${passed}/${dod.length} 通过${skipNote}，未达标: ${blockingItems.map((item) => `#${item.id} ${item.label}`).join('；')}`, at);
            }
            return verdict(def, true, `DoD ${passed}/${dod.length} 条通过${skipNote}`, at);
        }
    }
    // Unreachable for a validated definition; keeps the switch total.
    return verdict(def, false, `未实现的门禁类型: ${String(def.type)}`, at);
}
//# sourceMappingURL=gates.js.map