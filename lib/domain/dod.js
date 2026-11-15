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
import { dodStatusOf, isSafeArtifactPath, isSafeGateCommand, missingHeadings, normalizeForMatch, scanConclusion, } from './gates.js';
/* --------------------------------------------------------------- consts */
/** Separator used inside `DodItemDef.expect` to list several required sections. */
export const DOD_SECTION_SEPARATOR = '|';
/** The four README sections DoD item 6 requires. */
export const README_REQUIRED_SECTIONS = ['简介', '安装', '启动', '接口一览'];
/** Commands the runtime must run to answer DoD item 7. */
export const DOD_GIT_COMMANDS = ['git log --oneline', 'git tag --list'];
/** The delivery tag DoD item 7 requires. */
export const DOD_RELEASE_TAG = 'v1.0.0';
/**
 * Opposite verdict for a keyword DoD item, so the **last** conclusion wins
 * (a report rejected in round 1 and approved in round 2 must pass).
 * Keys are `normalizeForMatch`ed.
 */
export const CONCLUSION_OPPOSITES = {
    approved: 'rejected',
    'sec_pass': 'sec_fail',
    pass: 'fail',
    done: 'blocked',
};
/** The seven machine-checkable DoD items, in prototype order. */
export const DOD_ITEMS = [
    {
        id: 1,
        label: 'PRD 验收标准与测试用例全映射通过',
        kind: 'crossref',
        artifact: 'PRD.md',
        expect: 'TEST_REPORT.md',
    },
    {
        id: 2,
        label: 'pytest 实跑全绿（退出码 0）',
        kind: 'script',
        artifact: 'TEST_REPORT.md',
        run: 'python -m pytest -q',
    },
    {
        id: 3,
        label: '代码评审 APPROVED · 无遗留阻塞级问题',
        kind: 'keyword',
        artifact: 'REVIEW.md',
        expect: 'APPROVED',
    },
    {
        id: 4,
        label: '安全审计 SEC_PASS',
        kind: 'keyword',
        artifact: 'SECURITY_AUDIT.md',
        expect: 'SEC_PASS',
        securityOnly: true,
    },
    {
        id: 5,
        label: 'start.sh --check 退出码 0',
        kind: 'script',
        artifact: 'start.sh',
        run: 'bash start.sh --check',
    },
    {
        id: 6,
        label: 'README 含 简介/安装/启动/接口一览',
        kind: 'file',
        artifact: 'README.md',
        expect: README_REQUIRED_SECTIONS.join(DOD_SECTION_SEPARATOR),
    },
    {
        id: 7,
        label: `git 逐阶段 commit · 版本 tag ${DOD_RELEASE_TAG}`,
        kind: 'git',
        expect: DOD_RELEASE_TAG,
    },
];
/** Number of DoD items the cockpit reports as `N/7`. */
export const DOD_TOTAL = DOD_ITEMS.length;
/* ------------------------------------------------------------- helpers */
/** Looks up one DoD item definition by id. */
export function getDodItem(id) {
    return DOD_ITEMS.find((item) => item.id === id);
}
/** Splits a `file` item's `expect` into required Markdown sections. */
export function parseSectionExpectation(expect) {
    if (!expect)
        return [];
    return expect
        .split(DOD_SECTION_SEPARATOR)
        .map((section) => section.trim())
        .filter((section) => section.length > 0);
}
/** Unique `AC-n` acceptance ids in document order. */
export function extractAcceptanceIds(text) {
    const ids = [];
    const pattern = /\bAC[-_ ]?(\d{1,3})\b/gi;
    let match = pattern.exec(text);
    while (match !== null) {
        const id = `AC-${match[1]}`;
        if (!ids.includes(id))
            ids.push(id);
        match = pattern.exec(text);
    }
    return ids;
}
/** Commands still owed to the DoD audit, for the runtime to execute. */
export function pendingDodCommands(defs = DOD_ITEMS) {
    const commands = [];
    for (const def of defs) {
        if (def.kind === 'script' && def.run)
            commands.push(def.run);
        if (def.kind === 'git')
            commands.push(...DOD_GIT_COMMANDS);
    }
    return commands;
}
/* ------------------------------------------------------------ evaluation */
function result(def, ok, evidence, extra = {}) {
    const base = {
        id: def.id,
        label: def.label,
        ok,
        evidence,
        needsExecution: false,
        pendingCommands: [],
        skipped: false,
        ...extra,
    };
    // The three-state verdict is derived in exactly one place, so `ok`, `skipped`,
    // `needsExecution` and `status` can never drift apart — see `DodStatus` for
    // why the boolean alone is not enough (review finding H5).
    return { ...base, status: dodStatusOf(base) };
}
/**
 * Evaluates one DoD item. Pure and total: an unwired reader or missing git
 * facts produce `needsExecution`, never a fabricated verdict.
 */
export function evaluateDodItem(def, input = {}) {
    if (def.securityOnly && !input.securityTriggered) {
        // `ok: true` here means only "does not block delivery"; the verdict is
        // `skipped` ("never checked", not "checked and fine"). Collapsing the two
        // is exactly the defect review finding H5 reported.
        return result(def, true, '已跳过：本次工厂未触发安全路径（securityOnly）', { skipped: true });
    }
    switch (def.kind) {
        case 'file': {
            const path = def.artifact ?? '';
            if (!path)
                return result(def, false, '条目缺少 artifact 参数');
            if (!input.readFile)
                return result(def, false, `待读取工件: ${path}`, { needsExecution: true });
            const content = input.readFile(path);
            if (content === undefined)
                return result(def, false, `工件不存在: ${path}`);
            const sections = parseSectionExpectation(def.expect);
            if (sections.length > 0) {
                const missing = missingHeadings(content, sections);
                if (missing.length > 0) {
                    return result(def, false, `${path} 缺 ${missing.length}/${sections.length} 个标题: ${missing.join('、')}`);
                }
                return result(def, true, `${path} 存在，含 ${sections.length} 个必备标题: ${sections.join('、')}`);
            }
            return result(def, true, `${path} 存在（${content.length} 字符）`);
        }
        case 'keyword': {
            const path = def.artifact ?? '';
            const expect = def.expect ?? '';
            if (!path || !expect)
                return result(def, false, '条目缺少 artifact 或 expect 参数');
            if (!input.readFile)
                return result(def, false, `待读取工件: ${path}`, { needsExecution: true });
            const content = input.readFile(path);
            if (content === undefined)
                return result(def, false, `工件不存在: ${path}`);
            const opposite = CONCLUSION_OPPOSITES[normalizeForMatch(expect)] ?? '';
            const scan = scanConclusion(content, expect, opposite);
            if (scan.verdict === 'pass')
                return result(def, true, `${path}:${scan.lineNo} ${scan.line}`);
            if (scan.verdict === 'fail') {
                return result(def, false, `${path}:${scan.lineNo} 最终结论不是「${expect}」: ${scan.line}`);
            }
            return result(def, false, `${path} 未发现含「${expect}」的结论行`);
        }
        case 'script': {
            const run = (def.run ?? '').trim();
            if (run.length === 0)
                return result(def, false, '条目缺少 run 命令');
            if (!isSafeGateCommand(run))
                return result(def, false, `条目命令被安全校验拒绝: ${run}`);
            const done = input.executed?.[def.id];
            if (!done)
                return result(def, false, `待执行: ${run}`, { needsExecution: true, pendingCommands: [run] });
            if (done.ok) {
                return result(def, true, `${run} → 退出码 0${done.detail ? ` (${done.detail})` : ''}`);
            }
            return result(def, false, `${run} → 退出码 ${done.exitCode ?? '非 0'}${done.detail ? ` (${done.detail})` : ''}`);
        }
        case 'crossref': {
            const source = def.artifact ?? '';
            const target = def.expect ?? '';
            if (!source || !target)
                return result(def, false, '条目缺少 artifact 或 expect 参数');
            if (!input.readFile) {
                return result(def, false, `待读取工件: ${source} + ${target}`, { needsExecution: true });
            }
            const sourceContent = input.readFile(source);
            if (sourceContent === undefined)
                return result(def, false, `工件不存在: ${source}`);
            const targetContent = input.readFile(target);
            if (targetContent === undefined)
                return result(def, false, `工件不存在: ${target}`);
            const ids = extractAcceptanceIds(sourceContent);
            if (ids.length === 0) {
                return result(def, false, `${source} 未按 AC-n 编号验收标准，无法做用例映射`);
            }
            const normalizedTarget = normalizeForMatch(targetContent);
            const uncovered = ids.filter((id) => !normalizedTarget.includes(normalizeForMatch(id)));
            if (uncovered.length > 0) {
                const shown = uncovered.slice(0, 8).join('、');
                const suffix = uncovered.length > 8 ? ` 等 ${uncovered.length} 条` : '';
                return result(def, false, `${target} 未覆盖 ${uncovered.length}/${ids.length} 条验收标准: ${shown}${suffix}`);
            }
            return result(def, true, `${source} 的 ${ids.length} 条 AC-n 全部在 ${target} 有对应用例`);
        }
        case 'git': {
            const expect = def.expect ?? '';
            if (!input.git) {
                return result(def, false, `待执行: ${DOD_GIT_COMMANDS.join(' / ')}`, {
                    needsExecution: true,
                    pendingCommands: [...DOD_GIT_COMMANDS],
                });
            }
            const tags = input.git.tags ?? [];
            if (expect && !tags.some((tag) => tag === expect || tag === `refs/tags/${expect}`)) {
                const shown = tags.length > 0 ? tags.join('、') : '无';
                return result(def, false, `未找到版本 tag ${expect}（现有 tag: ${shown}）`);
            }
            const commits = input.git.commits ?? [];
            const minCommits = input.minCommits ?? 1;
            if (commits.length < minCommits) {
                return result(def, false, `逐阶段 commit 不足: ${commits.length} < ${minCommits}`);
            }
            return result(def, true, `tag ${expect} 存在，commit ${commits.length} 条（要求 ≥ ${minCommits}）`);
        }
    }
    // Unreachable for a registered kind; keeps the switch total.
    return result(def, false, `未实现的 DoD 类型: ${String(def.kind)}`);
}
/** Runs the whole audit and rolls it up. */
export function evaluateDod(input = {}, defs = DOD_ITEMS) {
    const results = defs.map((def) => evaluateDodItem(def, input));
    const withStatus = (status) => results.filter((item) => item.status === status);
    const failed = withStatus('failed');
    const pending = withStatus('pending');
    const summary = {
        total: results.length,
        // Only machine-verified items are passes; a `skipped` item is counted in
        // `skipped` alone, so "N/7 通过" can never absorb an item nobody checked (H5).
        passed: withStatus('passed').length,
        failed: failed.length,
        skipped: withStatus('skipped').length,
        pending: pending.length,
        ok: failed.length === 0 && pending.length === 0,
        missing: [...failed, ...pending].map((item) => `#${item.id} ${item.label}`),
    };
    return { results, summary };
}
/** Parameter audit for the 7 items — catches an item that could never pass. */
export function validateDodItems(defs = DOD_ITEMS) {
    const errors = [];
    const knownKinds = ['file', 'keyword', 'script', 'git', 'crossref'];
    if (defs.length !== 7)
        errors.push(`DoD 条目应为 7 条，实际 ${defs.length} 条`);
    const ids = new Set();
    for (const def of defs) {
        const at = (message) => {
            errors.push(`DoD #${def.id}: ${message}`);
        };
        if (ids.has(def.id))
            at('id 重复');
        ids.add(def.id);
        if (!Number.isInteger(def.id) || def.id < 1)
            at('id 必须是正整数');
        if (def.label.trim().length === 0)
            at('label 为空');
        if (!knownKinds.includes(def.kind))
            at(`未知校验类型 ${String(def.kind)}`);
        if (def.artifact !== undefined && !isSafeArtifactPath(def.artifact)) {
            at(`artifact 必须是工作区相对 POSIX 路径: ${def.artifact}`);
        }
        switch (def.kind) {
            case 'file':
                if (!def.artifact)
                    at('file 条目必须给出 artifact');
                if (def.expect !== undefined && parseSectionExpectation(def.expect).length === 0) {
                    at('expect 若给出则必须包含至少一个标题');
                }
                break;
            case 'keyword':
                if (!def.artifact)
                    at('keyword 条目必须给出 artifact');
                if (!def.expect || def.expect.trim().length === 0)
                    at('keyword 条目必须给出 expect');
                break;
            case 'script':
                if (!def.run || def.run.trim().length === 0)
                    at('script 条目必须给出 run');
                else if (!isSafeGateCommand(def.run))
                    at(`run 命令被安全校验拒绝: ${def.run}`);
                break;
            case 'crossref':
                if (!def.artifact)
                    at('crossref 条目必须给出 artifact（来源工件）');
                if (!def.expect)
                    at('crossref 条目必须给出 expect（交叉校验目标工件）');
                break;
            case 'git':
                if (!def.expect || def.expect.trim().length === 0)
                    at('git 条目必须给出 expect（tag 名）');
                break;
        }
    }
    if (!defs.some((def) => def.securityOnly)) {
        errors.push('至少需要一条 securityOnly 条目，供未触发安全路径的工厂跳过');
    }
    return { ok: errors.length === 0, errors };
}
//# sourceMappingURL=dod.js.map