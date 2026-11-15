#!/usr/bin/env node
/**
 * scripts/install-hooks.mjs — 把 git 指向仓库内的 `.githooks/`。
 *
 * WHY
 *   评审对「工程规范」这条判据的原话是「无 hook」。仓库里放一份 `.githooks/`
 *   并不算数：git 默认只读 `.git/hooks/`，而那个目录不进版本库，换台机器克隆
 *   下来就是空的。所以「有 hook」必须包含「装得上 hook」这一步，而且这一步不能
 *   靠人记得跑。
 *
 * HOW
 *   `git config core.hooksPath .githooks`，由 package.json 的 `prepare` 生命周期
 *   在 `pnpm install` 之后自动执行（husky 用的是同一招，只是没有那层依赖）。
 *   设置是**仓库本地**的（写进 `.git/config`），不会污染全局 git 配置。
 *
 *   `core.hooksPath` 的值是相对路径吗？不是 —— git 按**当前工作目录**解析相对
 *   路径，在子目录里执行 git 命令时同一个值会指到别处。所以这里写绝对路径，
 *   并在每次安装时重算（换机器、换克隆目录都会重新算对）。
 *
 * USAGE
 *   node scripts/install-hooks.mjs           # 安装（prepare 自动调用；不在 git 仓库里则静默退出 0）
 *   node scripts/install-hooks.mjs --check   # 只检查；没装好则 exit 1（给 CI / 发布门禁用）
 *
 * @module dsh-code-factory/scripts/install-hooks
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_DIR = join(ROOT, '.githooks')
/**
 * The value `core.hooksPath` must hold: the **directory**, not a hook file.
 *
 * Git resolves `<core.hooksPath>/<hook-name>`, so pointing it at
 * `.githooks/pre-commit` would make git look for
 * `.githooks/pre-commit/pre-commit` — every hook silently stops firing and git
 * only mutters a warning. This was the bug in the first version of this
 * installer, caught by running `--check` before `install`.
 */
const WANT = HOOK_DIR.replaceAll('\\', '/')

const CHECK_ONLY = process.argv.includes('--check')

/** Run `git …` in the repo root; `undefined` when the command fails. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/** True when this running copy lives inside a git work tree. */
function inGitWorkTree() {
  return git(['rev-parse', '--is-inside-work-tree']) === 'true'
}

/** The hook files actually present in `.githooks/`. */
function hookFiles() {
  if (!existsSync(HOOK_DIR)) return []
  return readdirSync(HOOK_DIR).filter((name) => !name.startsWith('.') && !name.endsWith('.md'))
}

const present = hookFiles()
if (present.length === 0) {
  process.stdout.write('[hooks] .githooks/ 里一个 hook 都没有 —— 这个安装器没有可装的东西\n')
  process.exit(CHECK_ONLY ? 1 : 0)
}

if (!inGitWorkTree()) {
  // `pnpm install` 也会在解包出来的 tarball 里跑（没有 .git）。那不是错误。
  if (CHECK_ONLY) {
    process.stdout.write('[hooks] 不在 git 工作树里，无法校验 core.hooksPath\n')
    process.exit(1)
  }
  process.exit(0)
}

const current = git(['config', '--local', '--get', 'core.hooksPath'])

if (CHECK_ONLY) {
  if (current === WANT) {
    process.stdout.write(`[hooks] core.hooksPath = ${WANT}\n`)
    process.exit(0)
  }
  process.stdout.write(
    `[hooks] core.hooksPath 是 ${current === undefined ? '（未设置）' : current}，应当是 ${WANT} —— 跑 \`pnpm run hooks:install\`\n`,
  )
  process.exit(1)
}

if (current === WANT) {
  process.exit(0)
}

const set = git(['config', '--local', 'core.hooksPath', WANT])
if (set === undefined && git(['config', '--local', '--get', 'core.hooksPath']) !== WANT) {
  process.stdout.write('[hooks] 设置 core.hooksPath 失败 —— git config 没写进去\n')
  process.exit(1)
}

process.stdout.write(`[hooks] core.hooksPath -> ${WANT}（${present.join(' / ')} 生效；绕过用 --no-verify）\n`)
