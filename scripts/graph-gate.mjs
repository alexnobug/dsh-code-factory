#!/usr/bin/env node
/**
 * scripts/graph-gate.mjs — 「模块图」的机器门禁：0 循环依赖、0 悬空导入。
 *
 * WHY THIS EXISTS
 * ---------------
 * 评审对「可维护性」这条判据写的是：「结构工程优秀（38 模块 / 103 条 import 边 /
 * 0 循环依赖、0 层违规、0 悬空导入）」。那组数字当时是**一次性的人工审计**的产物：
 * 它没有留在仓库里，于是没有任何东西会在它变坏时叫出声。本脚本把其中**可机检的
 * 两条**（0 循环依赖、0 悬空导入）变成门禁。剩下的那条见下「不判什么」。
 *
 * 为什么必须先剥注释和字面量（这个脚本存在的另一半理由）
 * ------------------------------------------------------
 * 第一版审计器直接在源码文本上正则匹配 `import … from '…'`，结果报出 5 条循环 ——
 * 全部是幻边。它们是 `src/domain/roles.ts:85` 的 JSDoc：
 *
 *     `{@link import('./router.js').assembleTeam}`
 *
 * 一段**注释**里的 `import`。同类幻边还有字符串里的示例代码、模板字面量里的文档
 * 片段。所以解析之前必须先做一次真正的词法剥离：块注释、行注释、单/双引号字符串、
 * 模板字面量（含 `${…}` 洞 —— **洞内是代码，不是文本**，所以洞要被递归地当作代码
 * 继续扫）全部置为空格。剥离时**保持长度不变**，这样报出来的行号就是原文行号。
 * 剥离之后再找 `import` / `export … from`，幻边消失。**没有这一步，这个门禁会自己
 * 制造 5 条假红。**
 *
 * 判什么 / 不判什么
 * -----------------
 * 是门禁（红 = 退出码 1）：
 *   1. 0 循环依赖 —— 模块图上的强连通分量，含自环；值边与 type-only 边一起算
 *      （`import type` 也会真的把两个模块耦合在一起）。
 *   2. 0 悬空导入 —— 每一个相对说明符都必须解析到某个真实的**模块**或真实的文件。
 * 是普查（打印出来，但不产生退出码，**不是门禁**）：
 *   - 每个顶层目录的模块数 / 出边数；
 *   - 零被引用模块数。入口点天然零引用，所以它不能被判成错误 —— 只能被人看一眼。
 * 不判：
 *   - **分层违规**。本仓库没有定义任何分层规则，所以这里**没有这一项**。评审报告里
 *     的「0 层违规」当年是人工判断，本脚本不假装能复现它 —— 编一条规则再声称在守
 *     它，正是本仓库反复吃过的那种亏。上面那两条普查数字同理，它们只是数字。
 *   - 循环是否「有害」。图上有环就是有环，这里不区分好环与坏环。
 *
 * 与 lib/ 的关系（前置条件，不是判据）
 * ------------------------------------
 * 被判的是 `src/**`（人写的图）。仓库**发布**的却是 `lib/**`。所以：
 *   - 任一 `src/X.ts` 的 `lib/X.js` 缺失或更旧 → 退出码 2，提示 `pnpm build`。
 *     否则一个绿色的 src 结论会被误读成「发布产物也是干净的」，而后者没被看过。
 *   - `lib/**` 的图会一并解析，与 src 的循环数 / 悬空数比对：**不一致就退出码 2**，
 *     因为那说明 lib 没能复现 src（构建中途或构建残缺），此时没有任何结论可下。
 * 这两条都是**前置条件**，因此永远不会产出一条关于代码的「FAIL」。
 *
 * EXIT CODES
 *   0  src 图 0 循环、0 悬空，且 lib 复现了 src（或用了 `--allow-stale`，见下）
 *   1  src 图里有循环，或有悬空导入
 *   2  前置条件不成立：src/ 空、lib/ 缺失或过期、lib/ 与 src/ 不一致 → 先 `pnpm build`
 *
 * USAGE
 *   node scripts/graph-gate.mjs             # 加 `--quiet` 只打印失败与普查
 *   node scripts/graph-gate.mjs --allow-stale  # src 写到一半、还没 build 时问 src 图
 *   node scripts/graph-gate.mjs --selftest  # 用合成夹具自测门禁本身（仓库零写入）
 *
 * `--allow-stale` 是刻意留的逃生舱（同 `scripts/verify.mjs`）：有人的 `src/` 正改到
 * 一半、还没 `pnpm build`，他仍然应该能问出「**src 图**现在干净吗」。代价写死在输出
 * 里 —— 打开它，lib/ 那半边就根本没有被校验，成功行会明说这一点，而不是让一个
 * exit 0 被读成「发布产物也干净」。
 *
 * @module dsh-code-factory/scripts/graph-gate
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const QUIET = process.argv.includes('--quiet')
/**
 * `--allow-stale` 是刻意留的逃生舱（`scripts/verify.mjs` 有同名开关）：有人的
 * `src/` 写到一半、还没 `pnpm build` 时，他仍然应该能问出「**src 图**现在干净吗」。
 * 代价写死在输出里 —— 打开它，lib/ 那半边就**根本没有被校验**，成功行会明说这一点，
 * 而不是让一个 exit 0 被读成「发布产物也干净」。
 */
const ALLOW_STALE = process.argv.includes('--allow-stale')

/** Print one line unless `--quiet`. */
function line(text) {
  if (!QUIET) process.stdout.write(`${text}\n`)
}

const posix = (p) => p.split(sep).join('/')
/** Repo-relative, always POSIX, for stable `file:line` reporting. */
const relTo = (base, abs) => posix(relative(base, abs))

/* ------------------------------------------------------- 词法剥离（幻边防线） */

/** 扫过一个引号字面量；返回闭合引号之后的下标（未闭合则返回文本末尾）。 */
function scanQuoted(text, start, quote) {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return text.length
}

/**
 * 把 `out`（`text` 的可写副本）里的注释与字面量文本置为空格，并把每一个字符串
 * 字面量记进 `literals`。
 *
 * `depth > 0` 表示正走在一个模板字面量的 `${…}` 洞里：洞内是**代码**，所以走到
 * 配对的 `}` 就返回，让外层继续按模板文本处理。
 *
 * @param {string} text
 * @param {number} start
 * @param {number} depth
 * @param {string[]} out
 * @param {{start:number,end:number,value:string}[]} literals
 * @returns {number} 结束位置之后的下标
 */
function scan(text, start, depth, out, literals) {
  const n = text.length
  const hide = (a, b) => {
    for (let k = Math.max(0, a); k < b && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = start
  while (i < n) {
    const c = text[i]
    if (depth > 0 && c === '}') return i + 1
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      const stop = nl === -1 ? n : nl
      hide(i, stop)
      i = stop
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const stop = close === -1 ? n : close + 2
      hide(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      const end = scanQuoted(text, i, c)
      const closed = end > i + 1 && text[end - 1] === c
      literals.push({ start: i, end, value: closed ? text.slice(i + 1, end - 1) : text.slice(i + 1) })
      // 引号本身留着：`extractImports` 靠它认出「这里本来是个字面量」，再回到
      // `literals` 里按起点取回真正的说明符。内容置空，所以字符串里的 `import`
      // 再也不可能被当成一条边。
      hide(i + 1, end - 1)
      i = end
      continue
    }
    if (c === '`') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '`') {
          closed = true
          break
        }
        if (text[j] === '$' && text[j + 1] === '{') {
          hide(i, j + 2) // 这段模板文本 + `${`
          i = scan(text, j + 2, depth + 1, out, literals)
          j = i
          continue
        }
        j += 1
      }
      if (closed) {
        hide(i, j)
        hide(j, j + 1)
        i = j + 1
      } else {
        hide(i, n)
        i = n
      }
      continue
    }
    i += 1
  }
  return i
}

/**
 * @param {string} text
 * @returns {{ masked: string, literals: {start:number,end:number,value:string}[] }}
 */
export function stripLiterals(text) {
  const out = text.split('')
  const literals = []
  scan(text, 0, 0, out, literals)
  return { masked: out.join(''), literals }
}

/* ----------------------------------------------------------- 边提取与分类 */

/** 出现在 import 子句里就一定说明它不是一条 import 的字符。 */
const TERMINATORS = new Set([';', '=', '(', ')', '.', '`', ':', '?'])
/** 从关键字往后最多看这么多字符；再远就不是同一条语句了。 */
const HEAD_MAX = 600

/** `(` 之后、`)` 之前的第一个字面量。 */
function firstLiteralAfter(masked, byStart, from, limit) {
  const stop = Math.min(masked.length, from + limit)
  for (let i = from; i < stop; i += 1) {
    const c = masked[i]
    if (c === '"' || c === "'") return byStart.get(i)
    if (c === ')') return undefined
  }
  return undefined
}

/**
 * 决定一段 import 子句到底算不算一条边，以及它是不是 type-only。
 *
 * 规则是**拒绝优先**的：认不出来就不记边。方向上的取舍是刻意的 —— 少记一条边会
 * 漏掉一个环（会有人发现），多记一条幻边会制造一条假红（会有人失去信任）。
 *
 * @param {'import'|'export'} kw
 * @param {string} head 关键字之后、字面量之前的原文（已剥注释与字面量内容）
 * @returns {'bare'|'dynamic'|'type'|'value'|undefined}
 */
function classifyHead(kw, head) {
  if (kw === 'import' && /^\s*$/.test(head)) return 'bare' // import 'x'
  if (kw === 'import' && /^\s*\(\s*$/.test(head)) return 'dynamic' // import('x')
  if (!/\bfrom\s*$/.test(head)) return undefined
  // 只允许 import/export 子句里合法的那几个字符。这条把
  // `export default class A { m() { return 'x' } }` 这类「后面也会出现字符串」的
  // 语句挡在门外 —— 它没有 `from`，本来就不该被算成边。
  if (!/^[\s\w$*{},\u00c0-\uffff]+$/u.test(head)) return undefined
  if (/^\s*type\b/u.test(head)) return 'type'
  const named = /^\s*\{([\s\S]*)\}\s*from\s*$/.exec(head)
  if (named !== null) {
    const parts = named[1]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
    // `import { type A, type B } from '…'` 会被 tsc 完整擦除；只要有一个成员不是
    // type 限定的，它就还是一条真正的运行期边。
    if (parts.length > 0 && parts.every((p) => /^type\s+[\w$]+(\s+as\s+[\w$]+)?$/u.test(p))) return 'type'
  }
  return 'value'
}

/**
 * 提取一个模块里所有的 import / export-from 边。纯函数：只吃文本。
 *
 * @param {string} text
 * @returns {{specifier:string,kind:string,index:number}[]}
 */
export function extractImports(text) {
  const { masked, literals } = stripLiterals(text)
  const byStart = new Map(literals.map((l) => [l.start, l]))
  const found = []
  for (const hit of masked.matchAll(/\b(import|export)\b/g)) {
    const kw = hit[1]
    const start = hit.index + hit[0].length
    if (kw === 'import') {
      let k = start
      while (k < masked.length && /\s/.test(masked[k])) k += 1
      if (masked[k] === '(') {
        const spec = firstLiteralAfter(masked, byStart, k + 1, 200)
        if (spec !== undefined) found.push({ specifier: spec.value, kind: 'dynamic', index: hit.index })
        continue
      }
    }
    let head = ''
    let spec
    let j = start
    const limit = Math.min(masked.length, start + HEAD_MAX)
    while (j < limit) {
      const c = masked[j]
      if (c === '"' || c === "'") {
        const lit = byStart.get(j)
        if (lit !== undefined) {
          spec = lit
          break
        }
        j += 1
        continue
      }
      if (TERMINATORS.has(c)) break
      head += c
      j += 1
    }
    if (spec === undefined) continue
    const kind = classifyHead(kw, head)
    if (kind === undefined) continue
    found.push({ specifier: spec.value, kind, index: hit.index })
  }
  return found
}

/* ----------------------------------------------------------------- 解析 */

const STRIP_JS_EXT = /\.(js|mjs|cjs|jsx)$/
const ASSET_EXT = ['', '.json', '.css', '.svg', '.md', '.txt', '.yml', '.yaml', '.node']

/**
 * 把一个相对说明符变成候选路径。仓库写的是编译后的 ESM 说明符（`./x.js`），而
 * 磁盘上是 `./x.ts`，所以两种拼法都要试；目录索引同理。
 *
 * @param {string} fromPath 发起方的仓库相对 POSIX 路径
 * @param {string} specifier
 */
export function resolveSpecifier(fromPath, specifier) {
  const parts = fromPath.split('/').slice(0, -1)
  for (const seg of specifier.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const joined = parts.join('/')
  const stem = joined.replace(STRIP_JS_EXT, '')
  return {
    joined,
    stem,
    moduleCandidates: [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`],
    fileCandidates: [joined, ...ASSET_EXT.map((e) => `${stem}${e}`)],
  }
}

/** 行号 = 这个下标之前出现过几个换行。 */
function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') n += 1
  return n
}

/* ------------------------------------------------------------- 强连通分量 */

/**
 * 迭代版 Tarjan。返回所有**真**分量：大小 > 1 的，或带自环的单点。
 *
 * @param {string[]} nodes
 * @param {(node: string) => string[]} edgesOf 只返回已知节点的后继
 * @returns {string[][]}
 */
export function stronglyConnected(nodes, edgesOf) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const sccs = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root)) continue
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    const work = [{ node: root, i: 0, out: edgesOf(root) }]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame.i < frame.out.length) {
        const next = frame.out[frame.i]
        frame.i += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, i: 0, out: edgesOf(next) })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = []
        for (;;) {
          const node = stack.pop()
          onStack.delete(node)
          component.push(node)
          if (node === frame.node) break
        }
        const selfLoop = edgesOf(frame.node).includes(frame.node)
        if (component.length > 1 || selfLoop) sccs.push(component.reverse())
      }
    }
  }
  return sccs
}

/* --------------------------------------------------------------- 建图 */

/**
 * 纯核心：吃一批模块（路径 + 文本），吐一张图。所有「世界事实」都从参数进来，
 * 所以 `--selftest` 可以用合成夹具驱动它，一个字节都不写盘。
 *
 * @param {object} input
 * @param {{path:string,text:string}[]} input.modules
 * @param {(path:string)=>boolean} [input.exists] 磁盘上是否存在该路径（用于非模块文件）
 * @returns {object}
 */
export function analyze({ modules, exists }) {
  const known = new Set(modules.map((m) => m.path))
  const isFile = exists ?? ((p) => known.has(p))
  const adjacency = new Map()
  const dangling = []
  const perModule = []
  const counts = { value: 0, type: 0, external: 0, asset: 0 }

  for (const mod of modules) {
    const out = new Set()
    for (const edge of extractImports(mod.text)) {
      if (!edge.specifier.startsWith('.')) {
        counts.external += 1
        continue
      }
      const resolution = resolveSpecifier(mod.path, edge.specifier)
      const target = resolution.moduleCandidates.find((c) => known.has(c))
      if (target !== undefined) {
        out.add(target)
        if (edge.kind === 'type') counts.type += 1
        else counts.value += 1
        continue
      }
      if (resolution.fileCandidates.some((c) => isFile(c))) {
        counts.asset += 1
        continue
      }
      dangling.push({ from: mod.path, specifier: edge.specifier, line: lineOf(mod.text, edge.index) })
    }
    adjacency.set(mod.path, out)
    perModule.push({ path: mod.path, outDegree: out.size })
  }

  const cycles = stronglyConnected([...known], (p) => [...(adjacency.get(p) ?? [])])
  const imported = new Set()
  for (const targets of adjacency.values()) for (const t of targets) imported.add(t)

  return {
    modules: modules.length,
    edges: counts.value + counts.type + counts.external + counts.asset,
    value: counts.value,
    typeOnly: counts.type,
    external: counts.external,
    asset: counts.asset,
    dangling,
    cycles,
    adjacency,
    perModule,
    orphans: [...known].filter((p) => !imported.has(p)),
  }
}

/* ----------------------------------------------------------- 文件系统层 */

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, filter, out)
    else if (filter(abs)) out.push(abs)
  }
  return out
}

function loadModules(dir, filter, base) {
  return walk(dir, filter).map((abs) => ({ path: relTo(base, abs), text: readFileSync(abs, 'utf8') }))
}

const isTsModule = (f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')
/**
 * `lib/client.js` 是 tsdown 打出来的**单文件包**，`lib/client/**` 是它的中间产物：
 * 它们的说明符图不是模块图（客户端源码在 src 那侧已经被覆盖），所以不参与比对。
 * `.map` / `.d.ts` 不是模块。
 */
const isLibModule = (abs) => {
  const p = posix(abs)
  if (!p.endsWith('.js')) return false
  if (/[/\\]lib[/\\]client\.js$/.test(p)) return false
  if (/[/\\]lib[/\\]client[/\\]/.test(p)) return false
  return true
}

const STALE_TOLERANCE_MS = 1000

/**
 * 逐模块配对（同 `scripts/verify.mjs` 的 M24 修法）：每一个编译源都要有一份不比它
 * 旧的产物。缺一个或旧一个，本次门禁就没有资格给 src 发绿卡。
 *
 * @returns {string[]} 问题列表，空 = 新鲜
 */
function freshnessProblems() {
  const problems = []
  const sources = walk(join(ROOT, 'src'), isTsModule)
  for (const abs of sources) {
    const name = relTo(ROOT, abs)
    const stem = name.replace(/^src\//, '').replace(/\.tsx?$/, '')
    const out =
      stem === 'client' || stem.startsWith('client/')
        ? join(ROOT, 'lib', 'client', 'client', `${stem.slice('client/'.length)}.js`)
        : join(ROOT, 'lib', `${stem}.js`)
    if (!existsSync(out)) {
      problems.push(`${relTo(ROOT, out)} 不存在（由 ${name} 编译而来）`)
      continue
    }
    if (statSync(abs).mtimeMs > statSync(out).mtimeMs + STALE_TOLERANCE_MS) {
      problems.push(`${relTo(ROOT, out)} 比 ${name} 旧`)
    }
  }
  return problems
}

function precondition(problems, hint) {
  for (const item of problems.slice(0, 20)) process.stdout.write(`       ${item}\n`)
  if (problems.length > 20) process.stdout.write(`       … 还有 ${problems.length - 20} 项\n`)
  process.stdout.write(`\n[ FAIL ] 前置条件不成立 —— 本次没有任何结论可下（退出码 2）\n       ${hint}\n`)
  process.exit(2)
}

/* ------------------------------------------------------------------- main */

function reportGraph(label, graph) {
  line(
    `[ ok ] ${label}：${graph.modules} 个模块 · ${graph.edges} 条 import 边` +
      `（${graph.value} 值 + ${graph.typeOnly} type-only + ${graph.external} 包外 + ${graph.asset} 非模块文件）`,
  )
  line(`[ ok ] ${label}：0 循环依赖（含自环；type-only 边一并算入）`)
  line(`[ ok ] ${label}：0 悬空导入（每个相对说明符都解析到了真实模块或真实文件）`)
}

function main() {
  const srcModules = loadModules(join(ROOT, 'src'), isTsModule, ROOT)
  if (srcModules.length === 0) {
    process.stdout.write('[ FAIL ] src/ 下一个模块都没找到 —— 这个门禁的主体不存在\n')
    process.exit(2)
  }

  const stale = freshnessProblems()
  if (stale.length > 0 && !ALLOW_STALE) {
    process.stdout.write(`\n[ FAIL ] ${stale.length} 个编译产物缺失或过期 —— 门禁不敢给 src 发绿卡\n`)
    precondition(stale, 'Run:  pnpm build   （src 干净不等于发布出去的 lib 也干净）')
  }

  const graph = analyze({ modules: srcModules, exists: (p) => existsSync(join(ROOT, p)) })

  // lib/ 复现 src/ 了吗？没复现就没有结论可下 —— 这是前置条件，不是判决。
  // `--allow-stale` 之下这一步整个跳过：拿一份过期的 lib 去比对，比不比都没有意义。
  let libGraph
  if (stale.length === 0) {
    const libModules = loadModules(join(ROOT, 'lib'), isLibModule, ROOT)
    if (libModules.length === 0) {
      process.stdout.write('\n[ FAIL ] lib/ 下一个编译模块都没有\n')
      precondition(['lib/ 是空的或不存在'], 'Run:  pnpm build')
    }
    libGraph = analyze({ modules: libModules, exists: (p) => existsSync(join(ROOT, p)) })
    const parity = []
    if (libGraph.cycles.length !== graph.cycles.length) {
      parity.push(`循环依赖数不一致：src ${graph.cycles.length} 个，lib ${libGraph.cycles.length} 个`)
    }
    if (libGraph.dangling.length !== graph.dangling.length) {
      parity.push(`悬空导入数不一致：src ${graph.dangling.length} 条，lib ${libGraph.dangling.length} 条`)
    }
    if (parity.length > 0) {
      process.stdout.write(`\n[ FAIL ] lib/ 没有复现 src/（${parity.length} 项）\n`)
      precondition(parity, 'lib/ 可能正构建到一半，或构建残缺 → Run:  pnpm build  并重跑')
    }
  }

  /* ----------------------------------------------------------- 判决 */

  const problems = []
  if (graph.cycles.length > 0) {
    problems.push(`  ✗ [循环依赖] ${graph.cycles.length} 个强连通分量`)
    for (const component of graph.cycles.slice(0, 10)) {
      problems.push(`      ${component.join(' → ')} → ${component[0]}`)
    }
  }
  if (graph.dangling.length > 0) {
    problems.push(`  ✗ [悬空导入] ${graph.dangling.length} 条相对说明符解析不到任何文件`)
    for (const item of graph.dangling.slice(0, 10)) {
      problems.push(`      ${item.from}:${item.line}  '${item.specifier}'`)
    }
  }

  if (problems.length > 0) {
    process.stdout.write(`\nFAILURES:\n${problems.join('\n')}\n`)
    process.stdout.write(
      `\nFAIL: graph — ${graph.cycles.length} 个循环依赖、${graph.dangling.length} 条悬空导入` +
        `（已解析 ${graph.modules} 个模块 / ${graph.edges} 条边）。\n` +
        '修法：把环拆开（把共享的那部分下沉到更低的模块，或改传参），或把说明符改对。\n',
    )
    process.exit(1)
  }

  reportGraph('src', graph)
  if (libGraph !== undefined) {
    line(`[ ok ] lib 复现 src：${libGraph.modules} 个模块 / ${libGraph.edges} 条边，循环与悬空数与 src 一致`)
  }

  // 普查 —— 不是门禁，不产生退出码。写出来只是让人看一眼。
  const byLayer = new Map()
  for (const mod of graph.perModule) {
    const layer = mod.path.split('/').slice(0, 2).join('/')
    const bucket = byLayer.get(layer) ?? { modules: 0, outDegree: 0 }
    bucket.modules += 1
    bucket.outDegree += mod.outDegree
    byLayer.set(layer, bucket)
  }
  line('')
  line('ADVISORY（普查，不是门禁，不产生退出码）：')
  for (const [layer, bucket] of [...byLayer].sort()) {
    line(`       ${layer} — ${bucket.modules} 个模块 / ${bucket.outDegree} 条出边`)
  }
  line(`       ${graph.orphans.length} 个模块零被引用（入口点天然如此，这里不判对错）`)

  if (stale.length > 0) {
    // M18 的同一条教训：被跳过的规则不能让结果看起来像全绿。
    process.stdout.write(
      `\nWARNING — --allow-stale 跳过了 ${stale.length} 个过期/缺失的编译产物：\n` +
        stale
          .slice(0, 10)
          .map((item) => `  - ${item}`)
          .join('\n') +
        (stale.length > 10 ? `\n  - … 还有 ${stale.length - 10} 项` : '') +
        '\n下面这个结论**只覆盖 src/ 的模块图**，lib/ 那半边根本没有被校验。' +
        '\n去掉 --allow-stale 并先 `pnpm build`，才是完整的一次门禁。\n',
    )
  }

  process.stdout.write(
    `\nSUCCESS: graph — ${graph.modules} 个模块，0 循环依赖，0 悬空导入` +
      `（${graph.value} 值边 + ${graph.typeOnly} type-only 边；` +
      (libGraph === undefined ? '⚠ lib 未被校验，见上面的 WARNING）' : 'lib 已复现）') +
      '\n',
  )
}

/* --------------------------------------------------------------- selftest */

/**
 * 把 `{路径: 源码}` 变成一张图。
 *
 * @param {Record<string,string>} sources
 * @param {string[]} [nonModules] 磁盘上存在、但不是模块的文件（`.css` 之类）
 */
function graphOf(sources, nonModules = []) {
  return analyze({
    modules: Object.entries(sources).map(([path, text]) => ({ path, text })),
    exists: (p) => nonModules.includes(p),
  })
}

/**
 * 自测门禁**本身**。两部分：
 *   A. 合成源码夹具（纯内存）—— 证明提取器的分类与拒绝规则；
 *   B. 真实临时目录 —— 证明走盘的那条路（walk + 解析 + 行号）也真的会红，
 *      而且证明仓库零写入：夹具建在 `os.tmpdir()` 下，结束时删掉并断言已删掉。
 */
function selftest() {
  let failed = 0
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failed += 1
    process.stdout.write(
      `  [${ok ? ' ok ' : 'FAIL'}] ${name} — 期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}\n`,
    )
  }

  process.stdout.write('--- A: 合成源码夹具（幻边防线、分类、解析）\n')

  const clean = graphOf({
    'src/a.ts': "import { b } from './b.js'\n",
    'src/b.ts': "import { c } from './c.js'\n",
    'src/c.ts': 'export const c = 1\n',
  })
  check('全绿：2 条值边、0 环、0 悬空', [clean.value, clean.cycles.length, clean.dangling.length], [2, 0, 0])

  const cyclic = graphOf({ 'src/a.ts': "import { b } from './b.js'\n", 'src/b.ts': "import { a } from './a.js'\n" })
  check('真环被抓住', [cyclic.cycles.length], [1])

  const selfLoop = graphOf({ 'src/a.ts': "import { a } from './a.js'\n" })
  check('自环被抓住', [selfLoop.cycles.length], [1])

  const dangling = graphOf({ 'src/a.ts': "import { b } from './ghost.js'\n" })
  check('悬空导入被抓住', [dangling.dangling.length], [1])

  // 幻边防线 —— 这四条是删掉 stripLiterals 之后立刻会变红的那四条。
  const jsdoc = graphOf({
    'src/a.ts': "/**\n * {@link import('./router.js').assembleTeam}\n */\nexport const x = 1\n",
  })
  check('JSDoc 里的 import 不是边（roles.ts:85 那个坑）', [jsdoc.edges], [0])

  const lineComment = graphOf({ 'src/a.ts': "// import { b } from './b.js'\nexport const x = 1\n" })
  check('行注释里的 import 不是边', [lineComment.edges], [0])

  const inString = graphOf({ 'src/a.ts': "export const s = \"import { b } from './b.js'\"\n" })
  check('字符串里的 import 不是边', [inString.edges], [0])

  const inTemplate = graphOf({ 'src/a.ts': 'export const s = `import { b } from \'./b.js\'`\n' })
  check('模板字面量里的 import 不是边', [inTemplate.edges], [0])

  const inHole = graphOf({
    'src/a.ts': "export const u = `${import('./b.js')}`\n",
    'src/b.ts': 'export const b = 1\n',
  })
  check('模板 ${} 洞内是代码，动态 import 仍算边', [inHole.value], [1])

  const notAnImport = graphOf({
    'src/a.ts': "import.meta.url\nexport const importer = './b.js'\nexport const important = 1\n",
  })
  check('import.meta / importer / important 都不是边', [notAnImport.edges], [0])

  const exportAssign = graphOf({ 'src/a.ts': "export const p = './b.js'\n" })
  check('export const p = "…" 不是边', [exportAssign.edges], [0])

  const exportDefaultClass = graphOf({
    'src/a.ts': "export default class A { m() { return './b.js' } }\n",
  })
  check('export default class 里的字符串不是边', [exportDefaultClass.edges], [0])

  // 分类
  const typeOnly = graphOf({
    'src/a.ts': "import type { B } from './b.js'\nimport { type C } from './c.js'\n",
    'src/b.ts': 'export type B = 1\n',
    'src/c.ts': 'export type C = 1\n',
  })
  check('type-only：import type 与全 type 限定都算类型边', [typeOnly.value, typeOnly.typeOnly], [0, 2])

  const mixed = graphOf({
    'src/a.ts': "import { type B, C } from './b.js'\n",
    'src/b.ts': 'export const C = 1\nexport type B = 1\n',
  })
  check('混着写还是一条运行期边', [mixed.value, mixed.typeOnly], [1, 0])

  const forms = graphOf(
    {
      'src/a.ts':
        "import { b } from './b.js'\nexport { b } from './b.js'\nexport * from './b.js'\nconst d = await import('./b.js')\nimport './style.css'\n",
      'src/b.ts': 'export const b = 1\n',
    },
    ['src/style.css'],
  )
  check(
    '四种形式都算边；.css 算非模块文件而不是悬空',
    [forms.value, forms.asset, forms.dangling.length],
    [4, 1, 0],
  )

  const external = graphOf({ 'src/a.ts': "import { Service } from '@deepseek-ai/cordis'\nimport { join } from 'node:path'\n" })
  check('包外说明符算 external，不算悬空', [external.external, external.dangling.length], [2, 0])

  const index = graphOf({
    'src/a.ts': "import { b } from './sub/index.js'\n",
    'src/sub/index.ts': 'export const b = 1\n',
  })
  check('目录索引 ./sub/index.js → sub/index.ts', [index.value, index.dangling.length], [1, 0])

  const upward = graphOf({
    'src/deep/a.ts': "import { b } from '../b.js'\n",
    'src/b.ts': 'export const b = 1\n',
  })
  check('../ 相对解析正确', [upward.value, upward.dangling.length], [1, 0])

  process.stdout.write('--- B: 真实临时目录（走盘的那条路；仓库零写入）\n')
  const scratch = join(tmpdir(), `graph-gate-selftest-${process.pid}`)
  try {
    mkdirSync(join(scratch, 'pkg'), { recursive: true })
    writeFileSync(
      join(scratch, 'pkg', 'a.ts'),
      "import { b } from './b.js'\nimport { ghost } from './ghost.js'\n",
      'utf8',
    )
    writeFileSync(join(scratch, 'pkg', 'b.ts'), "import { a } from './a.js'\nexport const b = 1\n", 'utf8')
    const modules = loadModules(scratch, isTsModule, scratch)
    const real = analyze({ modules, exists: (p) => existsSync(join(scratch, p)) })
    check('真实目录：走盘也能建图', [real.modules, real.value], [2, 2])
    check('真实目录：环被抓住', [real.cycles.length], [1])
    check('真实目录：悬空被抓住且行号是原文行号', real.dangling.map((d) => [d.from, d.line, d.specifier]), [
      ['pkg/a.ts', 2, './ghost.js'],
    ])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  check('临时夹具已删除（仓库与 TEMP 都没留东西）', [existsSync(scratch)], [false])

  if (failed > 0) {
    process.stdout.write(`\nFAIL: graph selftest — ${failed} 个用例不合格\n`)
    process.exit(1)
  }
  process.stdout.write('\nSUCCESS: graph selftest — 所有用例都按设计红了/绿了\n')
  process.stdout.write('  这个自测证明的是：幻边防线（注释/字符串/模板）真的在挡，\n')
  process.stdout.write('  真环与真悬空真的会被判红，且走盘那条路与合成夹具给出同样的结论。\n')
  process.stdout.write('  它**不**证明 src/ 现在干净 —— 那要跑不带 --selftest 的那条。\n')
}

if (process.argv.includes('--selftest')) selftest()
else main()
