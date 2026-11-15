#!/usr/bin/env node
/**
 * scripts/check-changelog.mjs — 「产物 → 提交」的机器校验。
 *
 * WHY THIS EXISTS
 *   评审对「发布溯源」这条判据的原话是：产物无法对应到任何提交。光有一个 tag
 *   不够，光有一份 CHANGELOG 也不够 —— 两者之间必须能被机器串起来，而且串错的
 *   时候必须失败。这个脚本就是那根链子。它检查四件事：
 *
 *   1. 版本一致 —— `package.json` 的 `version` 必须等于 CHANGELOG 最新一节的版本号。
 *   2. 节与 tag 对应 —— 除最新一节外，每个 `[X.Y.Z]` 都必须有同名 tag `vX.Y.Z`。
 *   3. tag 与产物对应 —— 那个 tag 指向的提交，其 `package.json` 必须声明的正是
 *      这个版本号。这条把「tag 打在哪个提交上」也纳入了机器校验：随手把
 *      `v0.2.1` 打在 0.2.0 的提交上会立刻失败。
 *   4. 条目与提交对应 —— 除最新一节外，每条 bullet 都必须以 `（` + 反引号提交短
 *      哈希 + `）` 结尾，该哈希必须真实存在（`git cat-file -e`），且必须是
 *      该版本 tag 的祖先（`git merge-base --is-ancestor`）。写错的哈希、贴到
 *      别版本里的哈希，都会失败。
 *
 * WHAT IS *NOT* CHECKED (on purpose)
 *   - 最新一节的条目哈希。本节描述的就是「还没提交完」的工作，它的哈希此刻还
 *     不存在，任何要求本节自证的要求都是自指悖论。规则是**位置性**的：最新的
 *     一节豁免，它被下一次版本小节顶下去时自动开始受检。
 *   - 文案质量。条目写得是否清楚是人读出来的，脚本不管。
 *   - `CHANGELOG.md` 是否随包发布在这里只做「`files` 里列了它」的存在性检查；
 *     真装进没装进由 `scripts/check-pack.mjs` 的 `REQUIRED` 负责。
 *
 * USAGE
 *   node scripts/check-changelog.mjs            # 校验本仓库
 *   node scripts/check-changelog.mjs --selftest # 用合成数据自测校验器本身
 *
 * @module dsh-code-factory/scripts/check-changelog
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ parsing */

/** `## [1.2.3] — YYYY-MM-DD` */
const SECTION = /^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})\s*$/u
/** A bullet that ends with a full-width parenthesised, backticked short hash. */
const HASH_TAIL = /（`([0-9a-f]{7,40})`）\s*$/u

/**
 * Split a CHANGELOG into its version sections.
 *
 * @param {string} text raw file contents.
 * @returns {{ problems: string[], sections: { version: string, date: string, line: number, bullets: { text: string, line: number }[] }[] }}
 */
export function parseChangelog(text) {
  const problems = []
  const lines = text.split(/\r?\n/)

  if (lines[0]?.trim() !== '# Changelog') {
    problems.push('第 1 行必须是 `# Changelog`（本文件是给发布者看的对照表，标题不能省）')
  }

  const sections = []
  let current = undefined
  let open = undefined
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = i + 1
    const heading = SECTION.exec(raw)
    if (heading !== null) {
      current = { version: heading[1], date: heading[2], line, bullets: [] }
      open = undefined
      sections.push(current)
      continue
    }
    // Any other level-2 heading ends the version section above it, so a
    // reader's guide or an appendix can follow the versions without its prose
    // being mistaken for release notes.
    if (raw.startsWith('## ')) {
      if (sections.length === 0) {
        problems.push(`第 ${line} 行：第一个版本小节之前出现了二级标题；版本标题必须写成 \`## [X.Y.Z] — YYYY-MM-DD\``)
      }
      current = undefined
      open = undefined
      continue
    }
    if (current === undefined) continue
    if (raw.startsWith('- ')) {
      // Bullets may wrap: a continuation line is indented and non-empty. The
      // hash tail is only ever on the LAST physical line, so the parser has to
      // rejoin the pieces before it can look for one.
      open = { text: raw.slice(2).trim(), line }
      current.bullets.push(open)
      continue
    }
    if (open !== undefined && raw.trim() !== '' && /^\s/.test(raw)) {
      open.text = `${open.text} ${raw.trim()}`
      continue
    }
    open = undefined
  }

  if (sections.length === 0) {
    problems.push('没有解析到任何 `## [X.Y.Z] — YYYY-MM-DD` 小节')
  }
  return { problems, sections }
}

/** Compare two `X.Y.Z` versions. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/* ------------------------------------------------------------------- checks */

/**
 * The pure checker: every fact about the world arrives as a callback, so the
 * self-test can drive it with fakes.
 *
 * @param {object} input
 * @param {string} input.changelogText
 * @param {string} input.packageVersion
 * @param {readonly string[]} input.packageFiles
 * @param {(version: string) => boolean} input.hasTag
 * @param {(version: string) => string | undefined} input.declaredVersionOfTag
 * @param {(hash: string) => boolean} input.commitExists
 * @param {(hash: string, version: string) => boolean} input.isAncestorOfTag
 * @returns {{ problems: string[], settled: number, bullets: number }}
 */
export function checkChangelog(input) {
  const problems = []
  const parsed = parseChangelog(input.changelogText)
  problems.push(...parsed.problems)
  const sections = parsed.sections
  if (sections.length === 0) return { problems, settled: 0, bullets: 0 }

  // 1. version <-> package.json
  if (sections[0].version !== input.packageVersion) {
    problems.push(
      `CHANGELOG 最新一节是 [${sections[0].version}]，但 package.json 声明的是 ${input.packageVersion} —— 两者必须一致`,
    )
  }

  // 2. ordering
  for (let i = 1; i < sections.length; i += 1) {
    const prev = sections[i - 1]
    const here = sections[i]
    if (compareVersions(prev.version, here.version) <= 0) {
      problems.push(`第 ${here.line} 行：[${here.version}] 排在 [${prev.version}] 之后，但版本号没有更小`)
    }
    if (here.date > prev.date) {
      problems.push(`第 ${here.line} 行：[${here.version}] 的日期 ${here.date} 晚于上一节 ${prev.date}`)
    }
  }

  // 3. CHANGELOG.md must be declared in `files`
  if (!input.packageFiles.includes('CHANGELOG.md')) {
    problems.push('package.json 的 `files` 里没有 CHANGELOG.md —— 它必须随包发布，否则装完的人看不到版本对照表')
  }

  // 4. every settled section (all but the newest) maps to a tag, and that tag
  //    maps to a commit whose package.json declares the same version, and every
  //    bullet in it names an ancestor of that tag.
  let bullets = 0
  for (let i = 1; i < sections.length; i += 1) {
    const section = sections[i]
    const tag = `v${section.version}`
    if (!input.hasTag(section.version)) {
      problems.push(`[${section.version}] 没有对应的 git tag \`${tag}\` —— 版本必须先打 tag 才会被这一节承认`)
      continue
    }
    const declared = input.declaredVersionOfTag(section.version)
    if (declared === undefined) {
      problems.push(`tag \`${tag}\` 指向的提交里读不到 package.json —— tag 打错了地方？`)
    } else if (declared !== section.version) {
      problems.push(`tag \`${tag}\` 指向的提交声明的是版本 ${declared}，不是 ${section.version} —— tag 和产物对不上`)
    }
    if (section.bullets.length === 0) {
      problems.push(`[${section.version}] 一条变更都没写`)
    }
    for (const bullet of section.bullets) {
      bullets += 1
      const match = HASH_TAIL.exec(bullet.text)
      if (match === null) {
        problems.push(
          `第 ${bullet.line} 行：[${section.version}] 的条目没有以提交短哈希结尾（形如 ` +
            '（`abc1234`）' +
            `）：「${bullet.text.slice(0, 40)}…」`,
        )
        continue
      }
      const hash = match[1]
      if (!input.commitExists(hash)) {
        problems.push(`第 ${bullet.line} 行：提交 \`${hash}\` 在仓库里不存在`)
        continue
      }
      if (!input.isAncestorOfTag(hash, section.version)) {
        problems.push(`第 ${bullet.line} 行：提交 \`${hash}\` 不是 \`${tag}\` 的祖先 —— 它不属于这个版本`)
      }
    }
  }

  return { problems, settled: Math.max(0, sections.length - 1), bullets }
}

/* --------------------------------------------------------------------- main */

const QUIET = process.argv.includes('--quiet')

/** Print one line unless `--quiet`. */
function line(text) {
  if (!QUIET) process.stdout.write(`${text}\n`)
}

/** `git …` in the repo root, trimmed; `undefined` when the command fails. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/** Run the checker against this checkout. */
function main() {
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) {
    process.stdout.write('[FAIL] CHANGELOG.md 不存在 —— 没有它，产物就无法对应到提交\n')
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const tags = new Set((git(['tag', '--list']) ?? '').split('\n').filter(Boolean))

  const declaredCache = new Map()
  const declaredVersionOfTag = (version) => {
    if (declaredCache.has(version)) return declaredCache.get(version)
    const raw = git(['show', `v${version}:package.json`])
    let value
    try {
      value = raw === undefined ? undefined : JSON.parse(raw).version
    } catch {
      value = undefined
    }
    declaredCache.set(version, value)
    return value
  }

  const ancestorCache = new Map()
  const isAncestorOfTag = (hash, version) => {
    const key = `${hash}@${version}`
    if (ancestorCache.has(key)) return ancestorCache.get(key)
    const ok = git(['merge-base', '--is-ancestor', hash, `v${version}`]) !== undefined
    ancestorCache.set(key, ok)
    return ok
  }

  const result = checkChangelog({
    changelogText: readFileSync(changelogPath, 'utf8'),
    packageVersion: pkg.version,
    packageFiles: pkg.files ?? [],
    hasTag: (version) => tags.has(`v${version}`),
    declaredVersionOfTag,
    commitExists: (hash) => git(['cat-file', '-e', `${hash}^{commit}`]) !== undefined,
    isAncestorOfTag,
  })

  for (const problem of result.problems) process.stdout.write(`[FAIL] ${problem}\n`)
  if (result.problems.length > 0) {
    process.stdout.write(`\nFAIL: changelog — ${result.problems.length} 项不合格\n`)
    process.exit(1)
  }
  line(`[ ok ] 版本一致：CHANGELOG 最新一节 = package.json = ${pkg.version}`)
  line(`[ ok ] ${result.settled} 个已发布小节的 tag 指向的提交声明了同名版本`)
  line(`[ ok ] ${result.bullets} 条变更条目全部指向真实且属于该版本的提交`)
  line(`SUCCESS: changelog — ${result.settled + 1} 个版本，${result.bullets + 0} 条已归档条目`)
}

/* ----------------------------------------------------------------- selftest */

/** Synthetic fixtures that must fail (and one that must pass). */
function selftest() {
  const good = [
    '# Changelog',
    '',
    '## [1.1.0] — 2026-02-02',
    '',
    '- 新东西，还没提交。（本次提交）',
    '',
    '## [1.0.0] — 2026-01-01',
    '',
    '- 老东西。（`aaaaaaa`）',
    '',
  ].join('\n')
  const world = {
    packageVersion: '1.1.0',
    packageFiles: ['CHANGELOG.md'],
    hasTag: (v) => v === '1.0.0',
    declaredVersionOfTag: () => '1.0.0',
    commitExists: (h) => h === 'aaaaaaa',
    isAncestorOfTag: () => true,
  }
  const cases = [
    ['全绿', { ...world, changelogText: good }, 0],
    ['版本不一致', { ...world, changelogText: good, packageVersion: '9.9.9' }, 1],
    ['缺 tag', { ...world, changelogText: good, hasTag: () => false }, 1],
    ['tag 指向别版本', { ...world, changelogText: good, declaredVersionOfTag: () => '0.9.0' }, 1],
    ['条目缺哈希', { ...world, changelogText: good.replace('（`aaaaaaa`）', '') }, 1],
    ['哈希不存在', { ...world, changelogText: good, commitExists: () => false }, 1],
    ['哈希不属于该版本', { ...world, changelogText: good, isAncestorOfTag: () => false }, 1],
    ['files 缺 CHANGELOG', { ...world, changelogText: good, packageFiles: [] }, 1],
    ['版本号倒序', { ...world, changelogText: good.replace('## [1.1.0]', '## [0.1.0]') }, 1],
    ['没有小节', { ...world, changelogText: '# Changelog\n' }, 1],
  ]
  let failed = 0
  for (const [name, input, expected] of cases) {
    const found = checkChangelog(input).problems.length
    const ok = expected === 0 ? found === 0 : found >= expected
    if (!ok) failed += 1
    process.stdout.write(`  [${ok ? ' ok ' : 'FAIL'}] ${name} — 期望${expected === 0 ? '通过' : '至少 1 项不合格'}，实得 ${found}\n`)
  }
  if (failed > 0) {
    process.stdout.write(`\nFAIL: changelog selftest — ${failed}/${cases.length} 个用例不合格\n`)
    process.exit(1)
  }
  process.stdout.write(`SUCCESS: changelog selftest — ${cases.length}/${cases.length} 个用例通过\n`)
}

if (process.argv.includes('--selftest')) selftest()
else main()
