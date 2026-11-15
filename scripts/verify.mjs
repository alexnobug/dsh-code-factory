#!/usr/bin/env node
/**
 * scripts/verify.mjs — L1 offline verification for dsh-code-factory.
 *
 * Asserts every product promise that can be checked with NO host, NO model and
 * NO network: the pure domain layer (`lib/domain`) and the durable store
 * (`lib/store`) running against a throwaway temp workspace. Node's built-in
 * `node:assert/strict` only — no test framework, no dependency, no config.
 *
 * Sections
 *   A  role registry & routing  iron triangle, security pin, roster cap, trim
 *                               order, unknown roles
 *   B  pipeline integrity       back-edge `failGoto`, registered roles,
 *                               per-stage `maxRounds`, gate params, staffing
 *   C  gate verdicts            checklist / keyword / composite / script / dod,
 *                               pure + total + "no evidence, no verdict"
 *   D  Definition of Done       the 7 machine-checked items, both directions
 *   E  store round-trip         create → load → save → load, mailbox tri-state,
 *                               malformed-JSONL tolerance, path fences, atomic
 *                               write (no temp leftovers), temp self-cleanup
 *   F  lock detach & serialisation
 *                               `runDetachedFromFactoryLocks` clears the
 *                               AsyncLocalStorage held-set for work that wakes
 *                               another session (otherwise that session's first
 *                               mutation is a false `lock_reentry`); FIFO
 *                               serialisation; queue hygiene; a mutant control
 *                               that neutralises detach in a temp copy; plus a
 *                               structural scanner over `src/**` proving every
 *                               session-lifecycle call site is wrapped
 *   G  harness self-check       every `checkAsync(...)` is awaited, so no verdict
 *                               can land after the summary
 *   H  stranded recovery        a live executor is never re-dispatched and a gone
 *                               one is recovered exactly once with a fresh
 *                               attempt; three-state verdict (live/gone/unknown);
 *                               stale-status reconciliation; no thrash; the
 *                               recovery path stays detached from the lock
 *   I  decision consistency     a plan that dispatches nothing may not contain a
 *                               dispatching decision (`parkedFrom` preserves the
 *                               suppressed intent); the shipped fake-host model
 *                               (`lib/runtime/testing`) keeps residency and
 *                               durability apart
 *
 * ⚠️ Sections A–E run against the compiled `lib/` half only; G–I also read
 * `lib/runtime` (the scheduler planner and the shipped fake-host model). Section
 * F8/F9 read `src/**` on purpose (they audit call sites, which no build artifact
 * preserves): they need a repository checkout, and a missing `src/` fails those
 * checks loudly rather than skipping them.
 *
 * Usage
 *   node scripts/verify.mjs        (or: pnpm verify)
 *
 * Exit codes
 *   0  every check passed
 *   1  at least one check failed
 *   2  build output missing / unreadable → run `pnpm build` first
 *
 * The compiled `lib/` half is the subject under test on purpose: the shipped
 * artifact is what has to behave, so this script never imports `src/`.
 *
 * Console note: this is a UTF-8 stream. On a GBK console some domain strings may
 * render as mojibake; the exit code and the redirected file are unaffected
 * (`node scripts/verify.mjs > verify.log` then open verify.log as UTF-8).
 *
 * @module dsh-code-factory/scripts/verify
 */

import { strict as rawAssert } from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ harness */

/**
 * Assertion census (H12).
 *
 * `check(name, fn)` used to pass as long as `fn()` did not throw. A check whose
 * loop iterated zero times, or whose body asserted nothing at all, was therefore
 * indistinguishable from a real pass — a guard in name only, and the most
 * expensive kind of false green because it reads as coverage.
 *
 * So `assert` is a counting proxy and each check runs inside its own
 * `AsyncLocalStorage` box. Section G then fails on a passing check that
 * contributed no assertion. `rawAssert` stays reachable for the rare check that
 * only proves "this call does not throw"; those record their reasoning in
 * `NO_ASSERT_CHECKS` instead of silently contributing nothing.
 */
const checkContext = new AsyncLocalStorage()
let assertionTotal = 0

const countAssertion = () => {
  assertionTotal += 1
  const box = checkContext.getStore()
  if (box) box.count += 1
}

const assert = new Proxy(rawAssert, {
  apply(target, thisArg, args) {
    countAssertion()
    return Reflect.apply(target, thisArg, args)
  },
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver)
    if (typeof value !== 'function') return value
    return (...args) => {
      countAssertion()
      return Reflect.apply(value, target, args)
    }
  },
})

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (path) => relative(repoRoot, path).split('\\').join('/')

const stats = { passed: 0, failed: 0, ran: 0 }
const failures = []
/**
 * In-flight async checks.
 *
 * `checkAsync` must be awaited. An un-awaited one keeps running while the
 * script walks on, so its verdict can land after the summary was printed and
 * silently vanish from the count and the exit code — a guard that does not run
 * is worse than no guard, because it reads as green. Section G drains this set
 * and fails when it was not empty, turning that whole failure mode loud.
 */
const inFlightChecks = new Set()
let sectionTitle = '(top)'

/** Per-check assertion tally, in declaration order. Read by section G. */
const census = []

const line = (text) => process.stdout.write(`${text}\n`)

function section(title) {
  sectionTitle = title
  line(`\n--- ${title} ---`)
}

function oneLine(value) {
  return String(value)
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' | ')
}

function record(name, error) {
  stats.ran += 1
  if (error) {
    stats.failed += 1
    failures.push({ section: sectionTitle, name, error })
    line(`  [FAIL] ${name}`)
    line(`         ${oneLine(error && error.message)}`)
    return
  }
  stats.passed += 1
  line(`  [ ok ] ${name}`)
}

/** True for anything with a `.then` — i.e. something that can settle later. */
function isThenable(value) {
  return Boolean(value) && typeof value.then === 'function'
}

function check(name, fn) {
  const box = { count: 0 }
  let outcome
  try {
    outcome = checkContext.run(box, fn)
  } catch (error) {
    census.push({ section: sectionTitle, name, assertions: box.count, async: false })
    record(name, error)
    return
  }
  /*
   * A synchronous registrar cannot await. If the body returned a promise, the row
   * above would be recorded green with zero assertions — the body keeps running
   * after `record()` — and a real assertion failure inside it escapes as an
   * unhandled rejection that kills the process before the summary prints. The
   * green row is then the *only* thing a reader sees. (The adversarial audit found
   * exactly this in E16: `verify` exited 1 while printing `[ ok ] E16`.)
   *
   * So the shape is refused, and the orphaned promise is silenced so it cannot
   * escape past the verdict that now describes it.
   */
  if (isThenable(outcome)) {
    outcome.then(undefined, () => {})
    census.push({ section: sectionTitle, name, assertions: box.count, async: false })
    record(
      name,
      new Error(
        'check() received a promise-returning body — an un-awaited verdict cannot be reported; use `await checkAsync(...)`',
      ),
    )
    return
  }
  census.push({ section: sectionTitle, name, assertions: box.count, async: false })
  record(name)
}

async function checkAsync(name, fn) {
  const box = { count: 0 }
  const where = sectionTitle
  const run = checkContext.run(box, async () => {
    try {
      await fn()
      record(name)
    } catch (error) {
      record(name, error)
    } finally {
      census.push({ section: where, name, assertions: box.count, async: true })
    }
  })
  inFlightChecks.add(run)
  const settle = () => inFlightChecks.delete(run)
  run.then(settle, settle)
  return run
}

/* --------------------------------------------------- build-output guardrail */

const LIBS = [
  ['lib/domain/index.js', join(repoRoot, 'lib', 'domain', 'index.js'), 'pure domain layer'],
  ['lib/store/store.js', join(repoRoot, 'lib', 'store', 'store.js'), 'durable store'],
  ['lib/store/lock.js', join(repoRoot, 'lib', 'store', 'lock.js'), 'factory lock (detach + queue)'],
  ['lib/runtime/index.js', join(repoRoot, 'lib', 'runtime', 'index.js'), 'scheduler planner + shipped fake-host model'],
]

line('dsh-code-factory - L1 offline verification')
line(`repo: ${repoRoot}`)
line(`node: ${process.version}`)

const missing = LIBS.filter(([, path]) => !existsSync(path))
if (missing.length > 0) {
  line('\n[FAIL] build output missing - nothing to verify')
  for (const [relPath, , what] of missing) line(`       ${relPath}  (${what})`)
  line('')
  line('       Run:  pnpm build        (请先 pnpm build)')
  line('       L1 verification reads the compiled lib/ half on purpose:')
  line('       the shipped artifact is what must behave, not the sources.')
  process.exit(2)
}

let D
let S
let L
let R
try {
  D = await import(pathToFileURL(LIBS[0][1]).href)
  S = await import(pathToFileURL(LIBS[1][1]).href)
  L = await import(pathToFileURL(LIBS[2][1]).href)
  R = await import(pathToFileURL(LIBS[3][1]).href)
} catch (error) {
  line('\n[FAIL] build output unreadable - nothing to verify')
  line(`       ${oneLine(error && error.message)}`)
  line('')
  line('       Run:  pnpm build        (请先 pnpm build)')
  process.exit(2)
}

/**
 * Freshness guard (M24).
 *
 * The previous version compared *newest src* against *newest lib* over
 * `{domain,store,shared}` only, which had two holes:
 *
 *   1. `src/runtime`, `src/tools`, `src/prompt` and `src/web` were not watched
 *      at all. Sections H and I — 44 of the checks and a large share of the
 *      assertions — read `lib/runtime`, so "verify runs green against stale
 *      code" was reachable by editing exactly the files the guard ignored.
 *   2. Even inside the watched set, one freshly built file masked every stale
 *      one: the comparison was max-vs-max, not module-by-module.
 *
 * The shape that actually holds is a per-module pairing: every compiled source
 * module needs a build output that is at least as new. A stale subject is not a
 * test failure, it is a *precondition* failure, so this exits 2 like the other
 * "nothing to verify" paths. `--allow-stale` is the deliberate escape hatch.
 */
function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(abs, out)
    else out.push(abs)
  }
  return out
}

const STALE_TOLERANCE_MS = 1000
const MODULE_PAIRS = (() => {
  const pairs = []
  for (const src of walkFiles(join(repoRoot, 'src'))) {
    const name = src.slice(repoRoot.length).split('\\').join('/')
    if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue
    const stem = name.replace(/^src\//, '').replace(/\.tsx?$/, '')
    // `src/client/**` compiles into `lib/client/client/**` (tsconfig.client.json),
    // which tsdown then bundles into the single file `lib/client.js`.
    const out =
      stem === 'client' || stem.startsWith('client/')
        ? join(repoRoot, 'lib', 'client', 'client', `${stem.slice('client/'.length)}.js`)
        : join(repoRoot, 'lib', `${stem}.js`)
    pairs.push({ src, out, name })
  }
  return pairs
})()

const staleSubjects = []
for (const { src, out, name } of MODULE_PAIRS) {
  if (!existsSync(out)) {
    staleSubjects.push(`${rel(out)} is missing (compiled from ${name})`)
    continue
  }
  if (statSync(src).mtimeMs > statSync(out).mtimeMs + STALE_TOLERANCE_MS) {
    staleSubjects.push(`${rel(out)} is older than ${name}`)
  }
}

// The shipped client artifact is a bundle of the compiled client inputs, so it
// must be at least as new as every one of them.
const clientBundle = join(repoRoot, 'lib', 'client.js')
if (!existsSync(clientBundle)) {
  staleSubjects.push('lib/client.js is missing (the shipped client bundle)')
} else {
  const bundleMtime = statSync(clientBundle).mtimeMs
  for (const input of walkFiles(join(repoRoot, 'lib', 'client'))) {
    if (!input.endsWith('.js')) continue
    if (statSync(input).mtimeMs > bundleMtime + STALE_TOLERANCE_MS) {
      staleSubjects.push(`${rel(input)} is newer than lib/client.js (bundle not rebuilt)`)
    }
  }
}

if (staleSubjects.length > 0 && !process.argv.includes('--allow-stale')) {
  line(`\n[FAIL] the subject under test is stale (${staleSubjects.length} module(s)) - nothing to verify`)
  for (const item of staleSubjects.slice(0, 20)) line(`       ${item}`)
  if (staleSubjects.length > 20) line(`       … and ${staleSubjects.length - 20} more`)
  line('')
  line('       Run:  pnpm build        (请先 pnpm build)')
  line('       Or:   pnpm verify --allow-stale   if you really mean to test the old artifact')
  process.exit(2)
}

const srcNewest = Math.max(0, ...MODULE_PAIRS.map(({ src }) => statSync(src).mtimeMs))
const fmt = (ms) => (ms === 0 ? 'n/a' : new Date(ms).toISOString())

/* ------------------------------------------------------------ shared fixture */

/** Briefs that the router classifies into each of the five families. */
const FAMILY_BRIEFS = {
  web_fullstack: '开发一个企业官网，前端用 React 做网页',
  api_only: '提供 REST API 接口的后端服务，微服务架构',
  data_pipeline: '写一个爬虫做数据清洗的 ETL 数据采集管道',
  ml_model: '训练一个机器学习深度学习模型',
  script_tool: '写一个自动化的小工具脚本',
}

/** The specification's seven mandatory security trigger words, in order. */
const SECURITY_SPEC_WORDS = ['登录', '鉴权', '用户数据', '支付', '密码', 'token', '对外']

/** Artifact reader injected into the pure gate/DoD evaluators. */
const artifactReader = (files) => (path) => files[path]

/** Full evidence for a green DoD audit — no filesystem, no command, all injected. */
function fullDodEvidence() {
  return {
    readFile: artifactReader({
      'PRD.md': '# PRD\n\n## 目标\n做东西\n\n## 验收标准\n- AC-1 能跑\n- AC-2 能停\n',
      'TEST_REPORT.md': '# TEST_REPORT\n\nAC-1 passed\nAC-2 passed\n\n结论: PASS\n',
      'REVIEW.md': '# REVIEW\n\n结论: REJECTED\n\n结论: APPROVED\n',
      'SECURITY_AUDIT.md': '# SECURITY_AUDIT\n\n结论: SEC_PASS\n',
      'README.md': '# README\n\n## 简介\nx\n\n## 安装\nx\n\n## 启动\nx\n\n## 接口一览\nx\n',
      'start.sh': '#!/bin/bash\n',
    }),
    executed: {
      2: { ok: true, exitCode: 0, detail: '12 passed' },
      5: { ok: true, exitCode: 0, detail: 'check ok' },
    },
    git: { commits: ['feat: a', 'feat: b', 'feat: c', 'chore: d'], tags: ['v1.0.0'] },
    securityTriggered: true,
    minCommits: 3,
  }
}

/* --------------------------------------------- A. role registry & routing */

section('A role registry & routing')

check('A1 the 12-job canonical registry self-audits clean', () => {
  const audit = D.validateRoleRegistry()
  assert.deepEqual(audit.errors, [], 'validateRoleRegistry reported errors')
  assert.equal(audit.ok, true)
  // M16: `assert.equal(D.CANONICAL_ROLE_COUNT, 12)` used to sit here. That is a
  // tautology — the constant and this expectation get edited together, so the
  // assertion cannot fail while the registry is wrong. The registry IS the truth;
  // what verify owes is that the hand-written count agrees with it (the audit
  // above enforces the same thing, and `ROLES.length` is the array in question).
  // The *documented* number 12 lives on the documentation side instead:
  // `check-docs` locks `roles count` in the README/spec headers and mirrors the
  // 12×8 role table cell by cell against `lib/domain/roles.js`.
  assert.equal(D.CANONICAL_ROLE_COUNT, D.ROLE_IDS.length, 'the exported count disagrees with the registry')
  assert.equal(new Set(D.ROLE_IDS).size, D.ROLE_IDS.length, 'duplicate canonical role id')
  assert.equal(D.ROLE_IDS.filter((id) => D.isDevRoleId(id)).length > 0, true)
})

check('A2 security job is security_eng; the prototype sec_eng spelling stays an alias', () => {
  assert.equal(D.SECURITY_ROLE_ID, 'security_eng')
  assert.equal(D.canonicalRoleId('sec_eng'), 'security_eng')
  assert.equal(D.canonicalRoleId('SEC_ENG'), 'security_eng')
  assert.equal(D.canonicalRoleId('security_eng'), 'security_eng')
  assert.equal(D.isSecurityRole('sec_eng'), true)
  assert.equal(D.isSecurityRole('security_eng'), true)
  const proto = D.PROTOTYPE_ROLE_ID_ALIASES
  const entries = Object.entries(proto)
  assert.equal(entries.length, 12, 'PROTOTYPE_ROLE_ID_ALIASES must list the 12 prototype ids')
  assert.deepEqual(
    [...new Set(Object.values(proto))].sort(),
    [...D.ROLE_IDS].sort(),
    'PROTOTYPE_ROLE_ID_ALIASES must map onto exactly the 12 canonical jobs',
  )
  assert.equal(proto.sec_eng, 'security_eng')
  for (const [protoId, canonical] of entries) {
    if (protoId === 'sec_eng') continue
    assert.equal(canonical, protoId, `${protoId} must be an identity mapping`)
  }
  assert.deepEqual(
    Object.keys(proto).filter((protoId) => !D.ROLE_IDS.includes(protoId)),
    ['sec_eng'],
    'sec_eng must be the only spelling the prototype table writes differently',
  )
  for (const id of D.ROLE_IDS) {
    assert.equal(D.canonicalRoleId(id), id, `${id} does not normalise to itself`)
  }
})

check('A3 unknown roles do not exist anywhere in the pipeline', () => {
  const bogus = 'wizard_of_oz'
  assert.equal(D.getRole(bogus), undefined)
  assert.equal(D.isRoleId(bogus), false)
  assert.equal(D.isCanonicalRoleId(bogus), false)
  assert.equal(D.isDevRoleId(bogus), false)
  assert.equal(D.isSecurityRole(bogus), false)
  assert.equal(D.isRoleId(D.canonicalRoleId(bogus)), false, 'unknown spelling resolved to a role')
  const roster = D.normaliseRoster(['pm', bogus, 'qa', 'be_dev', 'qa'])
  assert.deepEqual(roster, ['pm', 'qa', 'be_dev'], 'roster was not canonicalised')
  assert.equal(roster.includes(bogus), false)
})

check('A4 every task type ships a default roster that satisfies the iron triangle', () => {
  assert.equal(D.TRIAD_BASE_ROLES.includes('pm'), true)
  assert.equal(D.TRIAD_BASE_ROLES.includes('qa'), true)
  for (const type of D.TASK_TYPES) {
    assert.equal(D.hasIronTriangle(type.team), true, `${type.id}: hasIronTriangle false`)
    assert.deepEqual(D.triadViolations(type.team), [], `${type.id}: default roster misses a corner`)
    assert.equal(
      type.team.filter((role) => D.isDevRoleId(role)).length >= 1,
      true,
      `${type.id}: no *_dev in the default roster`,
    )
    for (const role of type.team) {
      assert.equal(D.isRoleId(role), true, `${type.id} names unregistered role ${role}`)
    }
  }
})

check('A5 routing every family brief yields the triangle + only registered members', () => {
  const seen = new Set()
  for (const [familyId, brief] of Object.entries(FAMILY_BRIEFS)) {
    const decision = D.assembleTeam(brief, D.DEFAULT_MAX_MEMBERS)
    assert.equal(decision.taskType, familyId, `brief for ${familyId} routed to ${decision.taskType}`)
    assert.equal(decision.pipeline, D.getTaskType(familyId).pipeline)
    assert.equal(D.hasPipeline(decision.pipeline), true)
    const team = decision.team
    assert.equal(team.includes('pm'), true, `${familyId}: no pm`)
    assert.equal(team.includes('qa'), true, `${familyId}: no qa`)
    assert.equal(team.some((role) => D.isDevRoleId(role)), true, `${familyId}: no *_dev`)
    assert.deepEqual(D.triadViolations(team), [], `${familyId}: triad violated -> ${team.join('+')}`)
    assert.equal(team.includes(D.ROUTER_ROLE_ID), false, 'the captain hat must never be spawned')
    assert.equal(team.length <= D.DEFAULT_MAX_MEMBERS, true, `${familyId}: over cap`)
    assert.equal(new Set(team).size, team.length, `${familyId}: duplicate member`)
    for (const role of team) {
      // Auto-assigned frontend specialists are registered roles but deliberately
      // not part of the canonical 12, so "registered" is the right question here.
      assert.equal(D.isRoleId(role), true, `${familyId}: unregistered member ${role}`)
    }
    assert.equal(decision.matchedKeywords.length >= 1, true, `${familyId}: no keyword evidence`)
    const matched = D.matchedKeywordsFor(brief, D.getTaskType(familyId))
    assert.equal(matched.length >= 1, true, `${familyId}: matchedKeywordsFor returned nothing`)
    seen.add(decision.taskType)
  }
  for (const familyId of D.REQUIRED_TASK_TYPE_IDS) {
    assert.equal(seen.has(familyId), true, `${familyId} is routable but no brief reached it`)
  }
})

check(`A6 exhaustively: all ${D.SECURITY_TRIGGERS.length} security triggers force a pinned security_eng`, () => {
  /*
   * This check used to iterate only the specification's seven words. That read
   * as "the security triggers are covered" while sampling 7 of 22, and it went
   * completely vacuous the moment the registry was emptied — a loop over an
   * empty array asserts nothing and still passes (H12/M22).
   */
  assert.ok(
    D.SECURITY_TRIGGERS.length >= SECURITY_SPEC_WORDS.length,
    `the registry (${D.SECURITY_TRIGGERS.length}) shrank below the specification's ${SECURITY_SPEC_WORDS.length} words`,
  )
  for (const word of SECURITY_SPEC_WORDS) {
    assert.equal(
      D.SECURITY_TRIGGERS.includes(word),
      true,
      `spec trigger ${word} is missing from SECURITY_TRIGGERS`,
    )
  }
  // Exhaustive, not a sample: every registered trigger must take the security path.
  for (const word of D.SECURITY_TRIGGERS) {
    const brief = `请实现 ${word} 的能力`
    assert.equal(D.securitySignal(brief).triggered, true, `securitySignal missed registered trigger ${word}`)
    const decision = D.assembleTeam(brief, D.DEFAULT_MAX_MEMBERS)
    assert.equal(decision.securityTriggered, true, `${word}: securityTriggered false`)
    assert.equal(
      decision.team.includes(D.SECURITY_ROLE_ID),
      true,
      `${word}: security_eng not injected -> ${decision.team.join('+')}`,
    )
    assert.equal(decision.team.includes('sec_eng'), false, 'the alias leaked into the roster')
  }
  /*
   * Negative controls. The registry grew from 22 words to a vocabulary that has
   * to recognise a *business* and not only a *mechanism* (H4), so the risk moved
   * from "misses too much" to "fires on everything" — a trigger list that
   * matches any app is the same defect pointing the other way, and it would cost
   * every ordinary factory a security slot plus a threat stage.
   *
   * Each entry is one of `FAMILY_BRIEFS` (the router must not mis-route its own
   * fixtures) or a plain-language brief that names no identity, money or
   * personal data.
   */
  const ORDINARY_BRIEFS = [
    ...Object.values(FAMILY_BRIEFS),
    '把首页配色改成蓝色',
    '做一个公司介绍的单页应用',
    '写一个把 Markdown 转成 PDF 的命令行工具',
    '给现有的日志加一个轮转策略',
  ]
  assert.ok(ORDINARY_BRIEFS.length >= 8, `only ${ORDINARY_BRIEFS.length} negative controls — too few to mean anything`)
  for (const brief of ORDINARY_BRIEFS) {
    const verdict = D.securitySignal(brief)
    assert.equal(verdict.triggered, false, `ordinary brief took the security path: 「${brief}」via ${verdict.hits.join('、')}`)
    assert.equal(verdict.source, 'none', `「${brief}」reported a source without a trigger`)
  }
  assert.equal(D.securitySignal('tokenizer 分词器').triggered, false, 'token needs a word boundary')
  assert.equal(D.assembleTeam(FAMILY_BRIEFS.script_tool, 8).securityTriggered, false)
})

check('A6b the security verdict is a first guess, revised upward by the requirements document (H4)', () => {
  /*
   * H4: the verdict used to be read off the one-line brief and never revisited.
   * The brief names a business, the PRD names the mechanisms, so a factory for
   * 「做一个跑腿的微信小程序」 was recorded as `securityTriggered: false` and its
   * securityOnly DoD item auto-passed as 「本次工厂未触发安全路径」 — for an app
   * with WeChat login, rider and customer phone numbers, addresses and payment.
   *
   * The acceptance criterion is the review's, verbatim.
   */
  const acceptance = '做一个跑腿的微信小程序'
  const signal = D.securitySignal(acceptance)
  assert.equal(signal.triggered, true, `the plan-time verdict for 「${acceptance}」is still false`)
  assert.ok(signal.hits.length > 0, 'triggered without a reason')
  assert.equal(signal.source, 'brief', 'a plan-time verdict must report itself as coming from the brief')

  // The roster follows the verdict, and the decision carries the evidence.
  const decision = D.assembleTeam(acceptance, D.DEFAULT_MAX_MEMBERS)
  assert.equal(decision.securityTriggered, true)
  assert.equal(decision.team.includes(D.SECURITY_ROLE_ID), true)
  assert.deepEqual([...(decision.securityHits ?? [])], [...signal.hits], 'the decision dropped the words that caused it')
  assert.equal(decision.securitySource, 'brief')

  // The document half, which is what the requirements stage will call.
  assert.equal(typeof D.securitySignalForDocuments, 'function', 'securitySignalForDocuments is not exported')
  const terse = '做一个给社区用的应用'
  assert.equal(D.securitySignal(terse).triggered, false, 'the control brief must stay negative on its own')
  const prd = '用户用手机号验证码注册，收货地址必填，下单后走微信支付，骑手端可查看定位。'
  const revised = D.securitySignalForDocuments(terse, [prd])
  assert.equal(revised.triggered, true, 'the requirements document did not revise the verdict')
  assert.equal(revised.source, 'document', `the revised verdict claims the wrong source: ${String(revised.source)}`)
  assert.ok(revised.hits.length > 0, 'revised without naming a word')

  /*
   * Upward only. Once the path is live the factory has staffed and pinned
   * `security_eng`, run the threat stage and stopped skipping the securityOnly
   * DoD item; a later document that no longer mentions a trigger cannot un-run
   * any of that, and demoting it would silently re-skip an audit already on the
   * record.
   */
  const noDemotion = D.securitySignalForDocuments(acceptance, ['本文档只讲配色与排版。'])
  assert.equal(noDemotion.triggered, true, 'a later document demoted a live security path')
  assert.equal(noDemotion.source, 'brief')
  for (const hit of signal.hits) {
    assert.ok(noDemotion.hits.includes(hit), `the union dropped 「${hit}」`)
  }

  // An artifact that does not exist yet is `undefined`, not a crash.
  const partial = D.securitySignalForDocuments(terse, [undefined, prd, undefined])
  assert.equal(partial.triggered, true)
  assert.equal(partial.source, 'document')
  assert.equal(D.securitySignalForDocuments(terse, []).source, 'none', 'no input means no verdict, not a document verdict')

  // Non-vacuity: the two halves must not be the same function.
  assert.notEqual(D.securitySignalForDocuments, D.securitySignal, 'the document form is an alias of the brief form')
})

check('A7 the roster cap holds and never cuts a triangle corner', () => {
  const brief = `${FAMILY_BRIEFS.web_fullstack}，含登录鉴权`
  for (const cap of [4, 5, 6, 7, 8]) {
    const decision = D.assembleTeam(brief, cap)
    assert.equal(decision.securityTriggered, true, `cap ${cap}: security path lost`)
    assert.equal(decision.team.length <= cap, true, `cap ${cap}: roster is ${decision.team.length}`)
    assert.deepEqual(D.triadViolations(decision.team), [], `cap ${cap}: triangle broken`)
    assert.equal(
      decision.team.includes(D.SECURITY_ROLE_ID),
      true,
      `cap ${cap}: pinned security_eng was trimmed`,
    )
    assert.equal(new Set(decision.team).size, decision.team.length, `cap ${cap}: duplicate member`)
  }
  // A cap below the mandatory floor is reported, never "fixed" by breaking the team.
  const floor = D.teamFloor(true)
  assert.equal(floor, 4)
  const trimmed = D.trimToCap([...D.ROLE_IDS], 2, [D.SECURITY_ROLE_ID])
  assert.equal(trimmed.overCap, true, 'a cap below the floor must report overCap')
  assert.equal(trimmed.team.length >= floor, true, 'floor roster was cut anyway')
  assert.deepEqual(D.triadViolations(trimmed.team), [], 'overCap roster lost the triangle')
  assert.equal(trimmed.team.includes(D.SECURITY_ROLE_ID), true, 'pinned role was trimmed')
})

check('A8 trim order: perf > po > tech_writer first, last *_dev never', () => {
  const roster = ['pm', 'qa', 'be_dev', 'perf', 'po', 'tech_writer']
  const four = D.trimToCap(roster, 4)
  assert.equal(four.trimmed[0], 'perf', `first trim was ${four.trimmed[0]}, expected perf`)
  assert.equal(
    four.trimmed.indexOf('perf') < four.trimmed.indexOf('po'),
    true,
    'po must go after perf',
  )
  assert.equal(four.trimmed.includes('tech_writer'), false, 'a canonical role went before tech_writer')
  assert.equal(four.team.includes('perf'), false)
  assert.equal(four.team.includes('po'), false)
  assert.deepEqual(D.triadViolations(four.team), [], 'trim broke the triangle')
  const three = D.trimToCap(roster, 3)
  assert.deepEqual(three.team.slice().sort(), ['be_dev', 'pm', 'qa'], 'floor roster is wrong')
  assert.equal(three.team.some((role) => D.isDevRoleId(role)), true, 'the last *_dev was cut')
  assert.equal(D.sanitizeCap(0) >= 1, true, 'cap sanitising must never yield 0/negative')
  assert.equal(Number.isInteger(D.sanitizeCap(3.7)), true)
})

/* ------------------------------------------------- B. pipeline integrity */

section('B pipeline integrity')

check('B1 all five templates self-audit clean', () => {
  const audit = D.validateAllPipelines()
  assert.deepEqual(audit.errors, [], 'validateAllPipelines reported errors')
  assert.equal(audit.ok, true)
  // M17 — `>= 5` would have stayed green with four templates deleted. 5 is the
  // documented contract: both READMEs and the spec header say "5 pipelines", and
  // check-docs locks all three occurrences against lib/domain/pipeline.js.
  assert.equal(D.PIPELINE_IDS.length, 5, `the registry holds ${D.PIPELINE_IDS.length} pipelines; the docs declare 5`)
  for (const id of D.PIPELINE_IDS) {
    assert.equal(audit.byPipeline[id]?.ok, true, `${id} is not ok`)
    assert.equal(D.hasPipeline(id), true)
  }
})

check('B2 fullstack is the prototype 10-stage order, verbatim', () => {
  // M17 — 10 is the documented prototype order, not a floor to clear.
  assert.equal(D.PROTOTYPE_STAGE_ORDER.length, 10, `the prototype order lists ${D.PROTOTYPE_STAGE_ORDER.length} stages; the reference has 10`)
  assert.deepEqual(D.stageIds('fullstack'), [...D.PROTOTYPE_STAGE_ORDER])
  // M17 — fullstack IS the prototype order (B3 proves the same stages in the same
  // order), so a floor of 10 would accept an eleventh stage appearing unnoticed.
  assert.equal(D.getPipeline('fullstack').length, 10, `fullstack has ${D.getPipeline('fullstack').length} stages; the prototype has 10`)
  for (const [index, stageId] of D.PROTOTYPE_STAGE_ORDER.entries()) {
    assert.equal(D.stageIndex('fullstack', stageId), index, `${stageId} moved to the wrong position`)
  }
  assert.equal(D.isFinalStage('fullstack', 'document'), true)
  assert.equal(D.nextStageId('fullstack', 'document'), undefined)
})

check('B3 stage ids unique, every stage staffed, every stage has a positive maxRounds', () => {
  for (const id of D.PIPELINE_IDS) {
    const stages = D.getPipeline(id)
    assert.equal(stages.length > 0, true, `${id}: empty template`)
    assert.equal(new Set(stages.map((stage) => stage.id)).size, stages.length, `${id}: duplicate stage id`)
    for (const stage of stages) {
      assert.equal(Number.isInteger(stage.maxRounds), true, `${id}/${stage.id}: maxRounds not an integer`)
      assert.equal(stage.maxRounds > 0, true, `${id}/${stage.id}: maxRounds must be positive`)
      assert.equal(stage.roles.length >= 1, true, `${id}/${stage.id}: no role can work this stage`)
      for (const role of stage.roles) {
        assert.equal(D.isCanonicalRoleId(role), true, `${id}/${stage.id}: unregistered role ${role}`)
        assert.equal(role !== D.ROUTER_ROLE_ID, true, `${id}/${stage.id}: the router is not a member`)
      }
      assert.equal(typeof stage.name === 'string' && stage.name.length > 0, true, `${id}/${stage.id}: no name`)
    }
  }
})

check('B4 every failGoto targets an existing, strictly earlier stage of the same template', () => {
  let edges = 0
  for (const id of D.PIPELINE_IDS) {
    const stages = D.getPipeline(id)
    let perTemplate = 0
    for (const [index, stage] of stages.entries()) {
      if (stage.failGoto === undefined) continue
      edges += 1
      perTemplate += 1
      const target = D.stageIndex(id, stage.failGoto)
      assert.equal(target >= 0, true, `${id}/${stage.id}: failGoto ${stage.failGoto} does not exist`)
      assert.equal(target < index, true, `${id}/${stage.id}: failGoto must be a back-edge`)
    }
    // M17 — `edges >= 3` was satisfied by three back-edges anywhere in the whole
    // registry, so a template that lost every one of its own still passed. The
    // real contract is per template: a template whose gates can never send work
    // backwards has no rework loop, and the loop is the entire point of failGoto.
    assert.equal(
      perTemplate >= 1,
      true,
      `${id}: no stage can fail back to an earlier one — the template has no rework loop`,
    )
  }
  line(`  ${edges} failGoto back-edge(s) across ${D.PIPELINE_IDS.length} templates`)
})

check('B5 gate definitions inside the templates are structurally valid', () => {
  for (const id of D.PIPELINE_IDS) {
    for (const stage of D.getPipeline(id)) {
      const audit = D.validateGateDef(stage.gate)
      assert.deepEqual(audit.errors, [], `${id}/${stage.id}: ${audit.errors.join('; ')}`)
      assert.equal(audit.ok, true, `${id}/${stage.id}: gate def invalid`)
      assert.equal(D.GATE_TYPES.includes(stage.gate.type), true, `${id}/${stage.id}: unknown gate type`)
      if (stage.gate.type === 'script' || stage.gate.type === 'dod') {
        assert.equal(D.gateNeedsExecution(stage.gate), true, `${id}/${stage.id}: executable gate lied`)
      }
    }
  }
})

check('B6 every pipeline has a final DoD stage and one human approval gate', () => {
  for (const id of D.PIPELINE_IDS) {
    const stages = D.getPipeline(id)
    const last = stages[stages.length - 1]
    assert.equal(last.gate.type, 'dod', `${id}: last stage must run the DoD audit`)
    assert.equal(
      stages.some((stage) => stage.humanApproval === true),
      true,
      `${id}: no human approval gate`,
    )
  }
})

check('B7 every stage of every template resolves to a real member under cap=8', () => {
  for (const [familyId, brief] of Object.entries(FAMILY_BRIEFS)) {
    const decision = D.assembleTeam(brief, D.DEFAULT_MAX_MEMBERS)
    const stages = D.getPipeline(decision.pipeline)
    const staffing = D.pipelineStaffing(decision.pipeline, decision.team)
    assert.equal(staffing.length, stages.length, `${familyId}: staffing length mismatch`)
    for (const [index, entry] of staffing.entries()) {
      assert.equal(entry.stageId, stages[index].id, 'staffing order drifted from the template')
      assert.equal(entry.assigned.length >= 1, true, `${decision.pipeline}/${entry.stageId}: nobody to dispatch`)
      for (const { required, assigned } of entry.substituted) {
        assert.equal(entry.assigned.includes(assigned), true, `${required}->${assigned} not in assigned`)
      }
    }
  }
})

/* --------------------------------------------------------- C. gate verdicts */

section('C gate verdicts')

check('C1 checklist: a missing required section fails, a full set passes', () => {
  const def = {
    type: 'checklist',
    artifact: 'PRD.md',
    requiredSections: ['目标', '验收标准'],
  }
  const partial = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'PRD.md': '# PRD\n\n## 目标\nx\n' }),
    at: 1,
  })
  assert.equal(partial.ok, false, 'a missing section must fail')
  assert.equal(partial.needsExecution, false, 'a checker has everything it needs here')
  const complete = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'PRD.md': '# PRD\n\n## 目标\nx\n\n## 验收标准\ny\n' }),
    at: 1,
  })
  assert.equal(complete.ok, true, complete.detail)
  assert.equal(D.markdownHeadings('## 目标\n### 明细\n').length, 2)
  assert.deepEqual(D.missingHeadings('## 目标\n', ['目标', '验收标准']), ['验收标准'])
})

check('C2 keyword: the last conclusion line wins', () => {
  const def = {
    type: 'keyword',
    artifact: 'REVIEW.md',
    passWord: D.CONCLUSIONS.reviewPass,
    failWord: D.CONCLUSIONS.reviewFail,
  }
  const roundTrip = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'REVIEW.md': '# REVIEW\n\n结论: REJECTED\n\n结论: APPROVED\n' }),
    at: 1,
  })
  assert.equal(roundTrip.ok, true, `round-2 approval must win: ${roundTrip.detail}`)
  const rejected = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'REVIEW.md': '# REVIEW\n\n结论: REJECTED\n' }),
    at: 1,
  })
  assert.equal(rejected.ok, false, 'a rejected review must not pass')
  const folded = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'REVIEW.md': '结论 :  APPROVED\n' }),
    at: 1,
  })
  assert.equal(folded.ok, true, 'spacing / full-width colon must be folded before matching')
  const silent = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'REVIEW.md': '看起来还行\n' }),
    at: 1,
  })
  assert.equal(silent.ok, false, 'a report with no conclusion must not pass')
  assert.equal(D.scanConclusion('结论: REJECTED\n结论: APPROVED\n', '结论: APPROVED', '结论: REJECTED').verdict, 'pass')
})

check('C3 composite: one failing child fails the whole gate', () => {
  const def = {
    type: 'composite',
    checks: [
      { type: 'checklist', artifact: 'PRD.md', requiredSections: ['目标'] },
      { type: 'keyword', artifact: 'REVIEW.md', passWord: D.CONCLUSIONS.reviewPass },
    ],
  }
  const mixed = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'PRD.md': '## 目标\n', 'REVIEW.md': '结论: REJECTED\n' }),
    at: 1,
  })
  assert.equal(mixed.ok, false, 'a failing child must fail the composite')
  assert.equal(mixed.children.length, 2)
  assert.deepEqual(mixed.children.map((child) => child.ok), [true, false])
  const all = D.evaluateGate(def, {
    readArtifact: artifactReader({ 'PRD.md': '## 目标\n', 'REVIEW.md': '结论: APPROVED\n' }),
    at: 1,
  })
  assert.equal(all.ok, true, all.detail)
})

check('C4 script gate: no evidence means needsExecution, injected result decides', () => {
  const def = { type: 'script', artifact: 'TEST_REPORT.md', run: D.TEST_COMMAND }
  const pending = D.evaluateGate(def, { at: 1 })
  assert.equal(pending.needsExecution, true, 'an unexecuted command cannot be judged')
  assert.deepEqual(pending.pendingCommands, [D.TEST_COMMAND])
  const signature = D.gateCommandSignature(def)
  const ran = D.evaluateGate(def, {
    at: 1,
    executed: { [signature]: { type: 'script', ok: true, detail: '12 passed', exitCode: 0, at: 1 } },
  })
  assert.equal(ran.ok, true, ran.detail)
  const failedRun = D.evaluateGate(def, {
    at: 1,
    executed: { [signature]: { type: 'script', ok: false, detail: '3 failed', exitCode: 1, at: 1 } },
  })
  assert.equal(failedRun.ok, false, 'a non-zero exit must fail the gate')
})

check('C5 dod gate follows the injected DoD results', () => {
  const green = D.evaluateGate({ type: 'dod' }, { at: 1, dod: D.evaluateDod(fullDodEvidence()).results })
  assert.equal(green.ok, true, green.detail)
  const red = D.evaluateGate({ type: 'dod' }, { at: 1, dod: D.evaluateDod({}).results })
  assert.equal(red.ok, false, 'an unproven DoD must not pass the gate')
  const blind = D.evaluateGate({ type: 'dod' }, { at: 1 })
  assert.equal(blind.needsExecution, true, 'a dod gate without DoD results must ask for them')
})

check('C6 gate verdicts are total over a lower-bounded type list, and unsafe commands are rejected', () => {
  const def = Object.freeze({ type: 'script', artifact: 'TEST_REPORT.md', run: D.TEST_COMMAND })
  const first = D.evaluateGate(def, Object.freeze({ at: 7 }))
  // A frozen input that still evaluates is a real purity signal; the old
  // "call it twice with the same literal and compare" could not fail (M19).
  assert.deepEqual(
    D.evaluateGate(def, Object.freeze({ at: 7 })),
    first,
    'evaluating a gate is not deterministic, or it mutated its input',
  )
  assert.equal(Object.isFrozen(def), true)
  /*
   * No lower bound here meant an emptied GATE_TYPES made the loop assert nothing
   * and still pass (H12). The bound is the point of the check, not decoration.
   */
  assert.ok(
    D.GATE_TYPES.length >= 5,
    `GATE_TYPES shrank to ${D.GATE_TYPES.length}; the loop below would silently sample less`,
  )
  for (const type of D.GATE_TYPES) {
    const result = D.evaluateGate({ type }, { at: 1 })
    assert.equal(typeof result.ok, 'boolean', `${type}: no verdict at all`)
    assert.equal(result.type, type)
    assert.equal(typeof result.detail === 'string' && result.detail.length > 0, true, `${type}: no detail`)
  }
  assert.equal(D.isSafeGateCommand(D.TEST_COMMAND), true)
  assert.equal(D.isSafeGateCommand(D.DELIVERY_CHECK_COMMAND), true)
  assert.equal(D.isSafeGateCommand('rm -rf /'), false, 'destructive command accepted')
  assert.equal(D.isSafeGateCommand('npm run build && rm -rf /'), false, 'chained command accepted')
  assert.equal(D.validateGateDef({ type: 'keyword' }).ok, false, 'an incomplete keyword gate must fail')
  assert.equal(D.isSafeArtifactPath('../../etc/passwd'), false, 'path escape accepted')
  assert.equal(D.isSafeArtifactPath('docs/PRD.md'), true)
})

check('C7 gate evaluation is process-independent (two fresh processes, frozen input)', () => {
  const subject = pathToFileURL(LIBS[0][1]).href
  const script = `
    const D = await import(${JSON.stringify(subject)})
    const def = Object.freeze({ type: 'script', artifact: 'TEST_REPORT.md', run: D.TEST_COMMAND })
    const out = []
    for (const at of [0, 7, 1e9]) out.push(JSON.stringify(D.evaluateGate(def, Object.freeze({ at }))))
    for (const type of D.GATE_TYPES) out.push(JSON.stringify(D.evaluateGate(Object.freeze({ type }), Object.freeze({ at: 3 }))))
    process.stdout.write(out.join('\\n'))
  `
  const runOnce = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, `child process failed: ${oneLine(result.stderr)}`)
    return result.stdout
  }
  const a = runOnce()
  const b = runOnce()
  assert.ok(a.trim().length > 0, 'the child process produced no verdicts at all')
  assert.equal(a, b, 'gate verdicts differ between two fresh processes — the evaluator reads mutable module state')
})

/*
 * The gate executor resolves a bare `bash` (and `sh`) to a real POSIX shell
 * before starting anything. On Windows the bare name is the WSL launcher at
 * `C:\WINDOWS\system32\bash.exe`, so the delivery check `bash start.sh --check`
 * used to fail with `execvpe(/bin/bash) failed` even though Git Bash was
 * installed and on the expected path.
 *
 * There are four rungs that can start the command (argv direct, argv
 * interpreter-first, argv interpreter-retry, and the opt-in node `exec`
 * fallback), and only the argv rung consulted the resolver. The audit below is
 * shipped by the module itself so the rule is checked in-process rather than
 * re-implemented here, and it covers every rung at once.
 */
check('C8 the command executor resolves a bare shell on every execution rung', () => {
  const audit = R.auditShellResolution()
  assert.deepEqual(audit.errors, [], `auditShellResolution reported errors: ${audit.errors.join('; ')}`)
  assert.equal(audit.ok, true, 'auditShellResolution did not report ok')

  // Non-vacuity: the audit must actually be exercising the resolver, and the
  // resolver must be a no-op for commands that carry no bare shell name.
  assert.equal(typeof R.resolveShellArgv, 'function', 'resolveShellArgv is not exported')
  assert.equal(typeof R.resolveShellCommandLine, 'function', 'resolveShellCommandLine is not exported')
  assert.deepEqual(
    R.resolveShellArgv(['python', '-m', 'pytest', '-q']),
    ['python', '-m', 'pytest', '-q'],
    'a command without a bare shell name must come back untouched',
  )

  if (process.platform === 'win32' && existsSync('D:/Git/bin/bash.exe')) {
    const [head] = R.resolveShellArgv(['bash', 'start.sh', '--check'])
    assert.notEqual(head, 'bash', 'a bare `bash` still reached the executor on Windows')
    assert.ok(existsSync(head), `the resolved shell does not exist: ${head}`)
    assert.match(
      R.resolveShellCommandLine('bash start.sh --check'),
      /^(?:"[^"]+"|\S+)\s+start\.sh --check$/,
      'the interpreter rung did not rewrite the leading program name',
    )
  }
})

/*
 * The captain tool set used to be declared twice — once as the filter source in
 * `src/runtime/tool-surface.ts` and once as the registration order in
 * `src/tools/captain.ts` — and the two had already drifted in order (the surface
 * listed `status, dispatch, gate`; the registrations ran `dispatch, gate,
 * status`).
 *
 * Drift is silent in both directions, which is why it needs a structural check
 * rather than a comment: a name that is listed but never registered is dropped
 * from the member deny filter *quietly* (it lands in `droppedUnknown`, the spawn
 * still succeeds, and the captain tool stays visible to every member), and a
 * tool that is registered but missing from the list is never denied to anyone at
 * all — a member could call `factory_gate`.
 *
 * The lists are one array now, so what is left to guard is the copy that cannot
 * be de-duplicated: the literal `name:` in each `defineTool` call. Asserting on
 * the exported `CAPTAIN_TOOL_ORDER` would assert nothing — it is an alias.
 */
check('C9 registered tool names match the declared surface, in order', () => {
  const expectedCaptain = [
    'factory_plan',
    'factory_edit_plan',
    'factory_approve',
    'factory_dispatch',
    'factory_gate',
    'factory_status',
    'factory_reuse',
    'factory_message',
    'factory_dod_check',
    'factory_halt',
    'factory_resume',
    'factory_deliver',
    'factory_delete',
  ]
  const expectedMember = ['factory_report', 'factory_inbox', 'factory_block']

  assert.deepEqual([...R.CAPTAIN_TOOL_NAMES], expectedCaptain, 'the declared captain surface changed')
  assert.deepEqual([...R.MEMBER_BASE_TOOL_NAMES], expectedMember, 'the declared member surface changed')

  const registrationsIn = (relPath) => {
    const found = []
    for (const line of readFileSync(join(repoRoot, relPath), 'utf8').split('\n')) {
      const match = /^\s*name: '(factory_[a-z_]+)',\s*$/.exec(line)
      if (match !== null) found.push(match[1])
    }
    return found
  }

  const captainRegistered = registrationsIn('src/tools/captain.ts')
  const memberRegistered = registrationsIn('src/tools/member.ts')
  assert.equal(captainRegistered.length, expectedCaptain.length, 'the captain source scan found the wrong number of registrations')
  assert.equal(memberRegistered.length, expectedMember.length, 'the member source scan found the wrong number of registrations')
  assert.deepEqual(captainRegistered, expectedCaptain, 'captain registrations drifted from the declared surface')
  assert.deepEqual(memberRegistered, expectedMember, 'member registrations drifted from the declared surface')

  // The deny filter is built from both lists; anything in neither is a tool no
  // member is ever stopped from calling.
  for (const name of expectedCaptain) {
    assert.equal(R.MEMBER_BASE_TOOL_SET.has(name), false, `${name} leaked into the member tool set`)
  }
  assert.equal(
    R.FACTORY_TOOL_NAMES.length,
    expectedCaptain.length + expectedMember.length,
    'FACTORY_TOOL_NAMES is not the union of the two surfaces',
  )
})

/* ------------------------------------------------------ D. Definition of Done */

section('D Definition of Done')

check('D1 the seven DoD items are defined and self-audit clean', () => {
  const audit = D.validateDodItems()
  assert.deepEqual(audit.errors, [], 'validateDodItems reported errors')
  assert.equal(audit.ok, true)
  // M17 — 7 is the documented contract: the spec header says "7 DoD", the README
  // prose repeats it, and check-docs mirrors the 7-row DoD table cell by cell
  // against lib/domain/dod.js. A floor of 7 would let an eighth item slip in here
  // unnoticed while the doc rules kept passing.
  assert.equal(D.DOD_ITEMS.length, 7, `the registry holds ${D.DOD_ITEMS.length} DoD items; the docs declare 7`)
  // `DOD_TOTAL === 7` asserted the same literal a second time. The honest form is
  // the relationship: the hand-written total must agree with the item list.
  assert.equal(D.DOD_TOTAL, D.DOD_ITEMS.length, 'DOD_TOTAL disagrees with the item list')
  assert.deepEqual(D.DOD_ITEMS.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(new Set(D.DOD_ITEMS.map((item) => item.id)).size, D.DOD_ITEMS.length)
  for (const item of D.DOD_ITEMS) {
    assert.equal(typeof item.label === 'string' && item.label.length > 0, true, `item ${item.id}: no label`)
    assert.equal(D.getDodItem(item.id)?.kind, item.kind)
    assert.equal(D.getDodItem(item.id).artifact !== undefined || item.kind === 'git', true, `item ${item.id}: no artifact`)
  }
  assert.equal(D.DOD_ITEMS.filter((item) => item.securityOnly === true).length, 1)
})

check('D2 with no evidence the audit invents nothing (only the skipped item passes)', () => {
  const audit = D.evaluateDod({})
  assert.equal(audit.summary.total, 7)
  assert.equal(audit.summary.ok, false, 'an evidence-free audit must not be green')
  assert.equal(audit.summary.failed + audit.summary.pending > 0, true, 'no failure and nothing pending?')
  for (const item of audit.results) {
    if (item.ok === true) {
      assert.equal(item.skipped, true, `item ${item.id} passed without evidence`)
      assert.equal(item.needsExecution, false)
    } else {
      assert.equal(
        item.needsExecution === true || item.evidence.length > 0,
        true,
        `item ${item.id} failed without an explanation`,
      )
    }
  }
  const owed = D.pendingDodCommands()
  assert.equal(owed.includes(D.TEST_COMMAND), true, 'the pytest command must be owed')
  assert.equal(owed.includes(D.DELIVERY_CHECK_COMMAND), true, 'the delivery self-check must be owed')
})

check('D3 full evidence turns the audit green, 7/7', () => {
  const audit = D.evaluateDod(fullDodEvidence())
  assert.equal(audit.summary.ok, true, `DoD failed: ${audit.summary.missing.join('; ')}`)
  assert.equal(audit.summary.passed, 7)
  assert.equal(audit.summary.failed, 0)
  assert.equal(audit.summary.pending, 0)
  assert.equal(audit.summary.skipped, 0)
  assert.deepEqual(audit.summary.missing, [])
  for (const item of audit.results) {
    assert.equal(item.needsExecution, false, `item ${item.id} still pending`)
    assert.equal(item.ok, true, `item ${item.id}: ${item.evidence}`)
  }
})

check('D4 the security-only item is skipped (not failed) without the security path', () => {
  const evidence = { ...fullDodEvidence(), securityTriggered: false }
  const audit = D.evaluateDod(evidence)
  assert.equal(audit.summary.ok, true, audit.summary.missing.join('; '))
  assert.equal(audit.summary.skipped, 1)
  assert.equal(audit.summary.passed, 6, 'a skipped audit must not be counted as passed')
  assert.equal(audit.summary.passed + audit.summary.skipped + audit.summary.failed + audit.summary.pending, 7)
  const securityItem = audit.results.find((item) => item.id === 4)
  assert.equal(securityItem.skipped, true)
  assert.equal(securityItem.status, 'skipped', 'the verdict must be readable, not only the boolean')
  assert.equal(securityItem.ok, true)
  // ...and a failing security audit on the security path is fatal
  const broken = fullDodEvidence()
  broken.readFile = artifactReader({
    'SECURITY_AUDIT.md': '# SECURITY_AUDIT\n\n结论: SEC_FAIL\n',
    'PRD.md': '# PRD\n\n## 验收标准\n- AC-1\n',
    'TEST_REPORT.md': 'AC-1 ok\n',
    'REVIEW.md': '结论: APPROVED\n',
    'README.md': '## 简介\n## 安装\n## 启动\n## 接口一览\n',
    'start.sh': '#!/bin/bash\n',
  })
  const red = D.evaluateDod(broken)
  assert.equal(red.summary.ok, false, 'SEC_FAIL must fail the DoD audit')
  assert.equal(red.summary.failed >= 1, true)
  // crossref: an acceptance id with no test case must fail item 1
  const uncovered = fullDodEvidence()
  uncovered.readFile = artifactReader({
    'PRD.md': '# PRD\n\n## 验收标准\n- AC-1\n- AC-2\n',
    'TEST_REPORT.md': 'AC-1 ok\n',
    'REVIEW.md': '结论: APPROVED\n',
    'SECURITY_AUDIT.md': '结论: SEC_PASS\n',
    'README.md': '## 简介\n## 安装\n## 启动\n## 接口一览\n',
    'start.sh': '#!/bin/bash\n',
  })
  const crossref = D.evaluateDod(uncovered)
  assert.equal(crossref.results.find((item) => item.id === 1).ok, false, 'AC-2 went unchecked')
  assert.deepEqual(D.extractAcceptanceIds('AC-1 AC-2 AC-2 AC-10'), ['AC-1', 'AC-2', 'AC-10'])
})

check('D5 a skipped audit is a verdict of its own, never a pass', () => {
  // The one derivation point: `status` wins, then the pre-`status` fallbacks.
  assert.equal(D.dodStatusOf({ ok: true, status: 'skipped' }), 'skipped')
  assert.equal(D.dodStatusOf({ ok: true, skipped: true }), 'skipped', 'legacy row: a skip must not read as passed')
  assert.equal(D.dodStatusOf({ ok: false, needsExecution: true }), 'pending')
  assert.equal(D.dodStatusOf({ ok: true }), 'passed')
  assert.equal(D.dodStatusOf({ ok: false }), 'failed')
  // ...and only a decided, non-blocking verdict may clear delivery.
  assert.equal(D.dodAllowsDelivery({ ok: true, status: 'passed' }), true)
  assert.equal(D.dodAllowsDelivery({ ok: true, status: 'skipped' }), true)
  assert.equal(D.dodAllowsDelivery({ ok: true, status: 'pending' }), false)
  assert.equal(D.dodAllowsDelivery({ ok: false, status: 'failed' }), false)
  // A skip is satisfied without being checked: the live audit must say so.
  const audit = D.evaluateDod({ ...fullDodEvidence(), securityTriggered: false })
  assert.equal(audit.results.every((item) => item.status === D.dodStatusOf(item)), true, 'audit rows and the shared derivation disagree')
  assert.equal(audit.results.filter((item) => item.status === 'skipped').length, 1)
  assert.equal(audit.results.filter((item) => item.status === 'passed').length, 6)
})

/* ----------------------------------------------------------- E. store round-trip */

section('E store round-trip (throwaway temp workspace)')

const tmpRoot = await mkdtemp(join(tmpdir(), 'code-factory-verify-'))
const store = new S.FactoryStore({ workspace: tmpRoot, stateDir: '.code-factory' })
let created

try {
  await checkAsync('E1 create -> load round-trips the whole record', async () => {
    const decision = D.assembleTeam(FAMILY_BRIEFS.web_fullstack, D.DEFAULT_MAX_MEMBERS)
    created = await store.create({
      brief: FAMILY_BRIEFS.web_fullstack,
      taskType: decision.taskType,
      pipeline: decision.pipeline,
      captainSessionId: 'session-verify-1',
      securityTriggered: decision.securityTriggered,
      members: decision.team,
      stages: D.stageIds(decision.pipeline),
    })
    assert.equal(store.root, join(tmpRoot, '.code-factory'))
    assert.equal(await store.exists(created.id), true, 'the factory dir was not created')
    const loaded = await store.load(created.id)
    assert.deepEqual(loaded, created, 'load() did not return what create() wrote')
    assert.deepEqual(loaded.members.map((member) => member.role), decision.team)
    assert.deepEqual(loaded.stages.map((stage) => stage.id), [...D.stageIds(decision.pipeline)])
    assert.equal(loaded.phase, 'staged')
    assert.equal(await store.load('ffffffff'), undefined, 'a missing factory must load as undefined')
  })

  await checkAsync('E2 save -> load persists the mutation and never rewinds updatedAt', async () => {
    const loaded = await store.loadOrThrow(created.id)
    const saved = await store.save({ ...loaded, phase: 'running' })
    assert.equal(saved.phase, 'running')
    const reread = await store.loadOrThrow(created.id)
    assert.equal(reread.phase, 'running', 'the phase change was lost')
    assert.equal(reread.updatedAt >= reread.createdAt, true, 'updatedAt went backwards')
    assert.deepEqual(reread.members, loaded.members, 'save() clobbered unrelated fields')
    const summaries = await store.list()
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].id, created.id)
    assert.equal(summaries[0].phase, 'running')
    assert.equal(summaries[0].memberCount, created.members.length)
    assert.equal(summaries[0].stageCount, created.stages.length)
  })

  await checkAsync('E3 mailbox append -> read round-trip, tri-state pending/delivered/read', async () => {
    const message = await store.mail(created.id, {
      from: 'captain',
      to: 'pm',
      content: '开工：先出 PRD',
      kind: 'dispatch',
      stage: 'requirement',
    })
    assert.equal(S.mailboxStatus(message), 'pending', 'a fresh line starts pending')
    assert.deepEqual(await store.inboxKeys(created.id), ['pm'])
    let inbox = await store.readMailbox(created.id, 'pm')
    assert.equal(inbox.length, 1)
    assert.deepEqual(
      { id: inbox[0].id, from: inbox[0].from, to: inbox[0].to, content: inbox[0].content, kind: inbox[0].kind },
      { id: message.id, from: 'captain', to: 'pm', content: '开工：先出 PRD', kind: 'dispatch' },
    )
    assert.equal((await store.listUnread(created.id, 'pm')).length, 1)
    assert.equal(await store.markDelivered(created.id, 'pm', 'all'), 1)
    inbox = await store.readMailbox(created.id, 'pm')
    assert.equal(S.mailboxStatus(inbox[0]), 'delivered')
    assert.equal(await store.markRead(created.id, 'pm', [message.id]), 1)
    inbox = await store.readMailbox(created.id, 'pm')
    assert.equal(S.mailboxStatus(inbox[0]), 'read')
    assert.equal(inbox[0].readAt >= inbox[0].deliveredAt, true, 'readAt must not precede deliveredAt')
    assert.deepEqual(await store.listUnread(created.id, 'pm'), [])
    const feed = await store.readAllMessages(created.id)
    assert.equal(feed.length, 1)
    assert.equal(feed[0].id, message.id)
    assert.equal((await store.readMailbox(created.id, 'nobody')).length, 0, 'a missing inbox is empty')
  })

  await checkAsync('E4 a malformed JSONL line is skipped and survives rewrites verbatim', async () => {
    await store.mail(created.id, { from: 'captain', to: 'qa', content: '准备验收', kind: 'dispatch' })
    const file = store.mailboxFile(created.id, 'qa')
    const good = await readFile(file, 'utf8')
    const brokenLine = '{"id": "truncated"'
    await writeFile(file, `${brokenLine}\n${good}`, 'utf8')
    const seen = []
    const messages = await store.readMailbox(created.id, 'qa', {
      onMalformedLine: (info) => seen.push(info),
    })
    assert.equal(seen.length, 1, 'the malformed line was not reported')
    assert.equal(seen[0].line, 1, 'wrong line number reported')
    assert.equal(seen[0].raw, brokenLine)
    assert.equal(seen[0].file, file)
    assert.equal(messages.length, 1, 'the good line must still be readable')
    assert.equal(messages[0].content, '准备验收')
    assert.equal(await store.markDelivered(created.id, 'qa', 'all'), 1)
    const after = await readFile(file, 'utf8')
    assert.equal(after.includes(brokenLine), true, 'a rewrite dropped the malformed line (data loss)')
    assert.equal(after.trimEnd().split('\n').length, 2, `unexpected line count: ${after}`)
    assert.equal((await store.readMailbox(created.id, 'qa'))[0].deliveredAt > 0, true)
  })

  await checkAsync('E5 artifacts.json registry round-trips', async () => {
    const record = await store.registerArtifact(created.id, {
      path: 'README.md',
      by: 'devops',
      stage: 'document',
      bytes: 42,
    })
    assert.deepEqual({ path: record.path, by: record.by, stage: record.stage, bytes: record.bytes }, {
      path: 'README.md',
      by: 'devops',
      stage: 'document',
      bytes: 42,
    })
    assert.deepEqual(await store.listArtifacts(created.id), [record])
    assert.deepEqual(await store.readStageArtifacts(created.id, 'document'), [record])
    assert.deepEqual(await store.readStageArtifacts(created.id, 'implement'), [])
    assert.deepEqual(await store.readStageArtifacts(created.id), [record])
  })

  await checkAsync('E6 path fences reject traversal, clobbering and escaping artifacts', async () => {
    assert.equal(S.isSafeKey('..'), false)
    assert.equal(S.isSafeKey('pm'), true)
    assert.equal(S.isSafeFactoryId('..'), false)
    assert.equal(S.isSafeFactoryId('ffffffff'), true)
    assert.equal(S.sanitizeKey('../../etc/passwd').includes('/'), false, 'sanitizeKey kept a separator')
    assert.equal(S.sanitizeKey('../../etc/passwd').includes('..'), false, 'sanitizeKey kept a dot-dot')
    assert.equal(store.mailboxKey('../../evil'), 'evil')
    assert.throws(() => store.factoryDir('..'), (error) => error.constructor.name === 'FactoryPathError')
    assert.throws(() => store.factoryDir('a/b'), (error) => error.constructor.name === 'FactoryPathError')
    await assert.rejects(
      () => store.registerArtifact(created.id, { path: '../outside.md', by: 'pm', stage: 'requirement' }),
      (error) => error.constructor.name === 'FactoryPathError',
    )
    await assert.rejects(
      () =>
        store.create({
          brief: 'clobber attempt',
          taskType: 'script_tool',
          pipeline: 'lightweight',
          captainSessionId: 'session-verify-1',
          members: ['pm'],
          stages: ['requirement'],
          id: created.id,
        }),
      (error) => error.constructor.name === 'FactoryStoreError',
    )
    assert.deepEqual(await store.inboxKeys(created.id), ['pm', 'qa'])
  })

  await checkAsync('E7 atomic writes leave no temp file behind, archive/remove work', async () => {
    const entries = (await readdir(store.factoryDir(created.id))).sort()
    assert.deepEqual(entries, ['artifacts.json', 'factory.json', 'inbox'], `stray files: ${entries.join(', ')}`)
    const moved = await store.archive(created.id)
    assert.equal(moved.method === 'rename' || moved.method === 'copy', true)
    assert.equal(existsSync(store.factoryDir(created.id)), false, 'the live dir survived archiving')
    assert.equal(existsSync(store.archiveDir(created.id)), true, 'the archive dir is missing')
    const archived = await store.list({ archived: true })
    assert.equal(archived.length, 1)
    assert.equal(archived[0].archived, true)
    assert.deepEqual(await store.list(), [])
    assert.equal(await store.remove(created.id, { archived: true }), true)
    assert.equal(existsSync(store.archiveDir(created.id)), false)
    assert.equal(await store.remove(created.id, { archived: true }), false, 'removing twice must be a no-op')
  })

  /*
   * B3. A mailbox that only ever grows makes every read cost the whole history.
   * These two checks pin the bound from both sides: the file stops growing, and
   * the bounded read still returns exactly what a full read would have returned.
   *
   * They get their own factory because E7 archives and removes the first one.
   */
  const mailFactory = await store.create({
    brief: 'mailbox bound probe',
    taskType: 'script_tool',
    pipeline: 'lightweight',
    captainSessionId: 'session-verify-mailbox',
    members: ['pm', 'dev', 'qa'],
    stages: [...D.stageIds('lightweight')],
  })

  await checkAsync('E8 a mailbox rotates at its bound: unread stays live, consumed is archived', async () => {
    const filler = 'x'.repeat(4096)
    const sent = []
    for (let index = 0; index < 80; index += 1) {
      sent.push(await store.mail(mailFactory.id, { from: 'captain', to: 'qa', content: `${filler}#${index}` }))
    }
    // Mark the older two thirds consumed: rotation archives exactly those.
    await store.markRead(mailFactory.id, 'qa', sent.slice(0, 60).map((message) => message.id))
    // One more append is what crosses the byte bound and triggers the rotation.
    const last = await store.mail(mailFactory.id, { from: 'captain', to: 'qa', content: `${filler}#tail` })

    const archive = store.mailboxArchiveFile(mailFactory.id, 'qa')
    assert.equal(existsSync(archive), true, 'the rotated generation was never written')
    const live = store.mailboxFile(mailFactory.id, 'qa')
    const liveSize = statSync(live).size
    // 80 × ~4 KiB would be ~330 KiB with no bound; the live file must be small.
    assert.equal(liveSize < 4 * 1024 * 1024, true, `the live mailbox is still unbounded: ${liveSize} bytes`)
    assert.equal(liveSize < statSync(archive).size, true, 'the archive is not the larger side after rotation')

    // A rotated file must never be mistaken for a member's inbox: only `qa` has
    // ever been written to, so `['qa']` proves the `.jsonl.1` archive is invisible
    // to inboxKeys() rather than being parsed as a recipient named `qa.jsonl`.
    assert.deepEqual(await store.inboxKeys(mailFactory.id), ['qa'], 'the archive leaked into inboxKeys()')

    const remaining = await store.readMailbox(mailFactory.id, 'qa')
    assert.equal(remaining.length >= 21, true, `rotation dropped unconsumed messages: ${remaining.length} left`)
    assert.equal(
      remaining.every((message) => message.readAt === undefined),
      true,
      'a consumed message survived in the live file',
    )
    assert.equal(remaining[remaining.length - 1].id, last.id, 'the newest message is not the last live line')

    // listUnread and a bounded read agree with the live file.
    const unread = await store.listUnread(mailFactory.id, 'qa')
    assert.equal(unread.length, remaining.length, 'listUnread disagrees with readMailbox after rotation')
    assert.equal((await store.readMailbox(mailFactory.id, 'qa', { limit: 5 })).length, 5)

    // The archived generation is still readable as data, not as a mailbox.
    const archivedText = readFileSync(archive, 'utf8')
    assert.equal(archivedText.split('\n').filter((line) => line.trim() !== '').length >= 60, true)
    assert.equal(archivedText.includes(sent[0].id), true, 'the oldest consumed message was not archived')
  })

  await checkAsync('E9 a bounded mailbox read returns exactly what a full read returns', async () => {
    for (const limit of [1, 2, 7, 19, 20, 21, 1000]) {
      const full = await store.readMailbox(mailFactory.id, 'qa')
      const expected = full.slice(Math.max(0, full.length - limit))
      const bounded = await store.readMailbox(mailFactory.id, 'qa', { limit })
      assert.deepEqual(
        bounded.map((message) => message.id),
        expected.map((message) => message.id),
        `limit:${limit} disagreed with a full read`,
      )
      const unreadFull = await store.readMailbox(mailFactory.id, 'qa', { unreadOnly: true })
      const unreadExpected = unreadFull.slice(Math.max(0, unreadFull.length - limit))
      const unreadBounded = await store.listUnread(mailFactory.id, 'qa', { limit })
      assert.deepEqual(
        unreadBounded.map((message) => message.id),
        unreadExpected.map((message) => message.id),
        `unreadOnly limit:${limit} disagreed with a full read`,
      )
    }
    // A limit of 0 is a legal request and must not be treated as "no limit".
    assert.deepEqual(await store.readMailbox(mailFactory.id, 'qa', { limit: 0 }), [])
  })

  await checkAsync('E10 the cockpit feed bounds how many inboxes it reads, and says so', async () => {
    // A full team is 11 roles plus `captain`; go past that so the bound engages.
    const recipients = Array.from({ length: S.MAILBOX_FEED_MAX_INBOXES + 3 }, (_, index) => `probe-${index}`)
    for (const [index, recipient] of recipients.entries()) {
      await store.mail(mailFactory.id, {
        from: 'captain',
        to: recipient,
        content: `probe ${recipient}`,
        ts: 1_000 + index,
      })
    }
    const keys = await store.inboxKeys(mailFactory.id)
    assert.equal(keys.length >= S.MAILBOX_FEED_MAX_INBOXES + 3, true, 'the probe inboxes were not created')

    const warnings = []
    const feed = await store.readAllMessages(mailFactory.id, {
      limit: 5,
      onWarning: (warning) => warnings.push(warning),
    })
    assert.equal(feed.length, 5, 'the feed did not honour its limit')
    assert.equal(warnings.length, 1, 'the feed pruned inboxes without reporting it')
    assert.equal(warnings[0].code, 'mailbox-feed-pruned')
    assert.match(warnings[0].message, /most recently written and skipped \d+/, 'the warning must name the drop')

    // Below the bound nothing is pruned and nothing is reported.
    const small = await store.create({
      brief: 'small feed probe',
      taskType: 'script_tool',
      pipeline: 'lightweight',
      captainSessionId: 'session-verify-feed',
      members: ['pm', 'dev', 'qa'],
      stages: [...D.stageIds('lightweight')],
    })
    await store.mail(small.id, { from: 'captain', to: 'pm', content: 'one' })
    await store.mail(small.id, { from: 'pm', to: 'captain', content: 'two' })
    const quiet = []
    const complete = await store.readAllMessages(small.id, { onWarning: (warning) => quiet.push(warning) })
    assert.equal(complete.length, 2, 'a small feed lost messages')
    assert.deepEqual(quiet, [], 'a small feed reported a prune it did not do')
  })

  /*
   * M13 - the dispatch ledger must be durable, not process memory.
   *
   * It used to be a `Map` inside the tool layer. After a host restart the ledger
   * was empty, so `planStageDispatch` saw `member.status === 'working'` with an
   * executor it could not judge and answered `wait` until the 30-minute stale
   * threshold elapsed - a factory could sit still for half an hour with nothing
   * running. The ledger now lives in `factory.json`, so the assertions below are:
   *   1. what the dispatch path records is readable by a brand new store (restart);
   *   2. a junk entry is dropped AND reported (never silently, never fatally).
   */
  await checkAsync('E12 the dispatch ledger is durable: a fresh store reads what the dispatch path recorded', async () => {
    const ledgerFactory = await store.create({
      brief: FAMILY_BRIEFS.script_tool,
      taskType: 'script_tool',
      pipeline: D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).pipeline,
      captainSessionId: 'session-verify-ledger',
      securityTriggered: false,
      members: D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).team,
      stages: D.stageIds(D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).pipeline),
    })
    const attempt = {
      stageId: ledgerFactory.stages[0].id,
      round: 0,
      role: ledgerFactory.members[0].role,
      kind: 'initial',
      sessionId: 'session-member-1',
      dispatchedAt: 1_700_000_000_000,
    }
    await store.save({ ...ledgerFactory, dispatchAttempts: [attempt] })

    // A brand new store, same root: exactly what the next host process sees.
    const restarted = new S.FactoryStore({ workspace: tmpRoot, stateDir: '.code-factory' })
    const reread = await restarted.loadOrThrow(ledgerFactory.id)
    assert.deepEqual(reread.dispatchAttempts, [attempt], 'the ledger did not survive the restart')

    // Settling is what stops a re-dispatch, so prove the settled form survives too.
    await restarted.save({
      ...reread,
      dispatchAttempts: [{ ...attempt, settledAt: attempt.dispatchedAt + 60_000 }],
    })
    const settled = await new S.FactoryStore({ workspace: tmpRoot, stateDir: '.code-factory' }).loadOrThrow(ledgerFactory.id)
    assert.equal(settled.dispatchAttempts?.[0]?.settledAt, attempt.dispatchedAt + 60_000)
    const roundTripped = JSON.parse(readFileSync(join(store.root, ledgerFactory.id, 'factory.json'), 'utf8'))
    assert.equal(Array.isArray(roundTripped.dispatchAttempts), true, 'dispatchAttempts is not in the persisted JSON')
  })

  await checkAsync('E13 a malformed dispatch ledger entry is dropped and reported, never fatal', async () => {
    const junkFactory = await store.create({
      brief: FAMILY_BRIEFS.script_tool,
      taskType: 'script_tool',
      pipeline: D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).pipeline,
      captainSessionId: 'session-verify-junk',
      securityTriggered: false,
      members: D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).team,
      stages: D.stageIds(D.assembleTeam(FAMILY_BRIEFS.script_tool, D.DEFAULT_MAX_MEMBERS).pipeline),
    })
    const file = join(store.root, junkFactory.id, 'factory.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const good = {
      stageId: junkFactory.stages[0].id,
      round: 0,
      role: junkFactory.members[0].role,
      kind: 'initial',
      dispatchedAt: 1_700_000_000_000,
    }
    raw.dispatchAttempts = [
      good,
      null,
      'not an object',
      { stageId: 42, round: 0, role: 'pm', kind: 'initial', dispatchedAt: 1 },
      { stageId: junkFactory.stages[0].id, round: 0, role: 'pm', kind: 'sideways', dispatchedAt: 1 },
    ]
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    const warnings = []
    const reading = new S.FactoryStore({
      workspace: tmpRoot,
      stateDir: '.code-factory',
      onWarning: (warning) => warnings.push(warning),
    })
    const loadedJunk = await reading.loadOrThrow(junkFactory.id)
    assert.deepEqual(loadedJunk.dispatchAttempts, [good], 'only the well-formed entry should survive')
    assert.equal(warnings.length, 1, `expected exactly one prune warning, saw ${warnings.length}`)
    assert.equal(warnings[0].code, 'dispatch-ledger-pruned')
    assert.match(warnings[0].message, /dropped 4 malformed dispatchAttempts entry\(ies\); 1 kept/)

    // A non-array ledger is discarded wholesale, and said so - a factory that
    // merely LOOKS like it never dispatched is worse than a loud failure.
    raw.dispatchAttempts = { oops: true }
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
    const second = []
    const reading2 = new S.FactoryStore({
      workspace: tmpRoot,
      stateDir: '.code-factory',
      onWarning: (warning) => second.push(warning),
    })
    const loadedBad = await reading2.loadOrThrow(junkFactory.id)
    assert.equal(loadedBad.dispatchAttempts, undefined)
    assert.equal(second.length, 1)
    assert.equal(second[0].code, 'dispatch-ledger-invalid')
    assert.match(second[0].message, /dispatchAttempts is not an array/)
  })
} finally {
  await rm(tmpRoot, { recursive: true, force: true })
}

/*
 * Registered last on purpose: it asserts the cleanup that the `finally` above
 * performs. The number follows declaration order (E12/E13 live inside the try),
 * so this is E14.
 */
check('E14 the temp workspace is cleaned up (no leftovers)', () => {
  assert.equal(existsSync(tmpRoot), false, `temp workspace still on disk: ${tmpRoot}`)
})

/*
 * H7 guard: the state machine must be the ONLY thing that writes `status` /
 * `phase` on a factory record.
 *
 * The transition tables in `lib/store/state.js` were fully written and
 * completely uncalled, so every real transition was a bare assignment sitting
 * somewhere in the engine — invisible to the tables, and invisible to any test
 * that only reads the JSON that came out. This scan is the one check that can
 * fail when somebody reintroduces `rec.status = 'passed'` and the value happens
 * to be a legal one anyway, which is exactly how the original defect stayed
 * quiet.
 *
 * It needs no workspace, so it is registered after the cleanup check rather
 * than inside the try above.
 */
check('E15 no factory status/phase is written outside the state machine', () => {
  // The two files allowed to assign: the state machine itself, and the fake
  // host, whose `Agent.status` is a different object that merely shares a name.
  const OWNERS = ['src/store/state.ts', 'src/runtime/testing.ts']
  const bare = /\.(status|phase)\s*=(?!=)/

  const scannable = walkFiles(join(repoRoot, 'src'))
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .filter((file) => {
      const name = rel(file)
      if (OWNERS.includes(name)) return false
      // The panel renders state; it never persists it.
      return !name.startsWith('src/client/')
    })

  // Non-vacuity: the scan must reach the layers that actually persist state,
  // otherwise a rename would silently turn this check into a no-op.
  assert.ok(scannable.length >= 30, `only ${scannable.length} source files were scanned`)
  const scanned = new Set(scannable.map((file) => rel(file)))
  for (const layer of ['src/runtime/scheduler.ts', 'src/runtime/members.ts']) {
    assert.ok(
      scanned.has(layer),
      `${layer} was not scanned (scanned ${scanned.size}: ${[...scanned].filter((n) => n.includes('tools')).join(', ') || 'no tools/*'})`,
    )
  }
  // The tool layer is deliberately more than one module now (review finding M5
  // split the 3286-line `src/tools/engine.ts` by domain), so this requires the
  // LAYER to be in the scan rather than one filename: a non-vacuity assertion
  // pinned to a filename stops guarding the moment that file is split.
  const toolModules = [...scanned].filter((name) => name.startsWith('src/tools/') && !name.endsWith('/index.ts'))
  assert.ok(
    toolModules.length >= 1,
    `no src/tools module was scanned (scanned ${scanned.size}: ${[...scanned].filter((n) => n.includes('tools')).join(', ') || 'no tools/*'})`,
  )

  const stripComments = (text) =>
    text
      // Keep the newline count so reported line numbers stay true.
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const offenders = []
  for (const file of scannable) {
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        if (bare.test(line)) offenders.push(`${rel(file)}:${index + 1} ${line.trim()}`)
      })
  }
  assert.deepEqual(
    offenders,
    [],
    `assign through transitionMember / transitionStage / transitionPhase:\n  ${offenders.join('\n  ')}`,
  )

  // And the compiled tree must agree with the sources — a guard that only
  // exists in `src/` is not the guard the runtime uses. Checked over EVERY
  // emitted tool module, so splitting the source cannot leave the guard behind
  // in a file this check no longer looks at.
  const guardCall = /transition(?:Member|Stage|Phase)\(/
  const compiledTools = walkFiles(join(repoRoot, 'lib', 'tools')).filter((file) => file.endsWith('.js'))
  assert.ok(compiledTools.length >= 1, 'no compiled tool module was found under lib/tools/')
  assert.ok(
    compiledTools.some((file) => guardCall.test(readFileSync(file, 'utf8'))),
    `no module under lib/tools/ calls a state-machine guard (checked ${compiledTools.length}: ${compiledTools.map((file) => rel(file)).join(', ')})`,
  )
  for (const file of ['lib/runtime/scheduler.js', 'lib/runtime/members.js']) {
    assert.match(readFileSync(join(repoRoot, file), 'utf8'), guardCall, `${file} does not call a state-machine guard`)
  }
})

/*
 * E16 — every closed vocabulary has exactly one definition.
 *
 * Why this exists (review finding H8)
 *
 * Five state unions and the mailbox-kind union each had a runtime whitelist
 * written twice: once on the host side, once by hand in `src/client/api.ts`.
 * Nothing detected a drift, because every consumer of those lists *falls back to
 * a default* instead of throwing — a client that had fallen behind would render a
 * plausible panel built from stale vocabulary and never report anything wrong.
 *
 * The repair was to put each list in `src/shared/types.ts`, the one layer both
 * halves may import, and to re-export rather than re-declare at the old sites.
 * This check is what keeps the repair from being undone: a second declaration of
 * any of these names anywhere under `src/` is a failure, and the browser half
 * must be importing the shared ones.
 *
 * The exhaustiveness device is asserted too. `as const satisfies readonly X[]`
 * alone only rejects values outside the union; it happily accepts a list that is
 * *missing* a member, which is the exact shape of the original defect.
 * `AssertNever<Exclude<X, (typeof LIST)[number]>>` is what turns that into a
 * build error, and it is a one-line deletion nobody would notice.
 */
await checkAsync('E16 every closed vocabulary has exactly one definition, in shared', async () => {
  /** name → the exact contents the compiled module must expose. */
  const VOCABULARIES = {
    MEMBER_STATUSES: ['staged', 'idle', 'working', 'rework', 'blocked', 'done', 'error', 'removed'],
    STAGE_STATUSES: ['pending', 'active', 'gate', 'passed', 'rejected'],
    FACTORY_PHASES: ['staged', 'running', 'halted', 'delivered', 'discarded'],
    GATE_TYPES: ['checklist', 'keyword', 'script', 'composite', 'dod'],
    DOD_STATUSES: ['passed', 'skipped', 'failed', 'pending'],
    MESSAGE_KINDS: ['dispatch', 'reject', 'handoff', 'report', 'blocked', 'approval', 'system'],
    ALERT_KINDS: [
      'awaiting-plan-review',
      'awaiting-approval',
      'rounds-exhausted',
      'stage-rejected',
      'member-blocked',
      'member-error',
      'halted',
    ],
    ALERT_SEVERITIES: ['action', 'attention'],
  }
  const names = Object.keys(VOCABULARIES)
  const SHARED = 'src/shared/types.ts'

  // 1. shared is the definition site.
  const sharedText = readFileSync(join(repoRoot, SHARED), 'utf8')
  for (const name of names) {
    assert.match(
      sharedText,
      new RegExp(`^export const ${name} = \\[`, 'm'),
      `${SHARED} does not export \`${name}\``,
    )
  }

  // 2. Nobody else declares one. Comment-stripped so prose about a list does not
  //    count, with the newline count preserved so a hit reports a true line.
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const sources = walkFiles(join(repoRoot, 'src'))
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .filter((file) => rel(file) !== SHARED)

  // Non-vacuity: the scan must actually reach the files the defect lived in.
  assert.ok(sources.length >= 30, `only ${sources.length} source files were scanned`)
  const scanned = new Set(sources.map((file) => rel(file)))
  for (const layer of ['src/client/api.ts', 'src/store/state.ts', 'src/domain/gates.ts', 'src/tools/engine.ts']) {
    assert.ok(scanned.has(layer), `${layer} was not scanned`)
  }

  const redeclared = []
  for (const file of sources) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const name of names) {
        if (new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b\\s*[:=]`).test(line)) {
          redeclared.push(`${rel(file)}:${index + 1} re-declares ${name}`)
        }
      }
    })
  }
  assert.deepEqual(
    redeclared,
    [],
    `import these from ${SHARED} instead of copying them:\n  ${redeclared.join('\n  ')}`,
  )

  // 3. The browser half must be a consumer, not a spectator. A re-export would
  //    satisfy step 2 while leaving the panel on its own copy, so the import is
  //    asserted by name.
  const clientText = readFileSync(join(repoRoot, 'src/client/api.ts'), 'utf8')
  const clientImport = clientText.match(/import \{([\s\S]*?)\} from '\.\.\/shared\/types\.js'/g) ?? []
  const imported = new Set(
    clientImport.flatMap((block) => block.replace(/import \{|\} from.*$/g, '').split(',')).map((s) => s.trim()),
  )
  for (const name of ['MEMBER_STATUSES', 'STAGE_STATUSES', 'FACTORY_PHASES', 'GATE_TYPES', 'DOD_STATUSES', 'MESSAGE_KINDS']) {
    assert.ok(imported.has(name), `src/client/api.ts does not import \`${name}\` from ${SHARED}`)
  }

  // 4. The compiled module must carry the exact contents, so a silent removal or
  //    reorder fails here rather than in a panel nobody is looking at.
  const shared = await import(pathToFileURL(join(repoRoot, 'lib', 'shared', 'types.js')).href)
  for (const [name, expected] of Object.entries(VOCABULARIES)) {
    assert.deepEqual([...shared[name]], expected, `lib/shared/types.js exports an unexpected \`${name}\``)
  }

  // 5. And the exhaustiveness device is still in place.
  for (const [name, union] of [
    ['MEMBER_STATUSES', 'MemberStatus'],
    ['STAGE_STATUSES', 'StageStatus'],
    ['FACTORY_PHASES', 'FactoryPhase'],
    ['GATE_TYPES', 'GateType'],
    ['DOD_STATUSES', 'DodStatus'],
    ['MESSAGE_KINDS', 'MessageKind'],
    ['ALERT_KINDS', 'AlertKind'],
    ['ALERT_SEVERITIES', 'AlertSeverity'],
  ]) {
    assert.match(
      sharedText,
      new RegExp(`AssertNever<Exclude<${union}, \\(typeof ${name}\\)\\[number\\]>>`),
      `${SHARED} no longer proves \`${name}\` exhaustive over \`${union}\``,
    )
  }
})

/*
 * E17 — no binding is read inside the callback that initialises it.
 *
 * Why this exists
 *
 * The engine drill found two crashes of one shape in `src/tools/engine.ts`:
 *
 *     const { value, state } = await mutateFactory(call, id, async (current) => {
 *       …
 *       settleAttempts(state, role, def.id, now)   // ReferenceError, every call
 *     })
 *
 * The outer destructuring target is in its temporal dead zone for the entire
 * duration of the callback, so the read throws — and because `mutateFactory`
 * throws *before* it saves, the record is left byte-identical. That is how the
 * first one survived a commit and a green suite: `factory_dispatch` crashed on
 * every call while the factory on disk looked untouched, so no behavioural check
 * could tell it apart from "nothing happened yet".
 *
 * A type checker cannot report this. `state` is declared, it is in scope, and the
 * reference is legal TypeScript that throws at runtime — which is why verify has
 * to look for it structurally.
 *
 * The rule is deliberately conservative: if the name is also declared as a
 * parameter of a function nested anywhere inside the call, the whole name is
 * skipped. That keeps `approveFactory`'s `async (state) => {…}` (a real shadow,
 * genuinely fine) from being reported, at the price of missing a name that is
 * shadowed in one nested function and misused in the outer callback. Precision
 * over recall, because a structural check that cries wolf gets deleted.
 */
check('E17 no binding is read inside the callback that initialises it', () => {
  /** Blanks comments and string bodies, keeping every newline so lines stay true. */
  const maskNonCode = (text) => {
    let out = ''
    let state = 'code'
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]
      const c2 = text[i + 1]
      if (state === 'code') {
        if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 1; continue }
        if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 1; continue }
        if (c === "'" || c === '"' || c === '`') { state = c; out += ' '; continue }
        out += c
        continue
      }
      if (state === 'line') {
        if (c === '\n') { state = 'code'; out += '\n'; continue }
        out += ' '
        continue
      }
      if (state === 'block') {
        if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 1; continue }
        out += c === '\n' ? '\n' : ' '
        continue
      }
      if (c === '\\') { out += '  '; i += 1; continue }
      if (c === state) { state = 'code'; out += ' '; continue }
      out += c === '\n' ? '\n' : ' '
    }
    return out
  }

  /** Reports `{ reads, scanned }` for one masked source text. */
  const tdzReads = (masked) => {
    const reads = []
    let scanned = 0
    const open = /const \{([^{}]*)\}\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\(/g
    let match
    while ((match = open.exec(masked)) !== null) {
      const bound = match[1]
        .split(',')
        .map((part) => part.trim().split(':')[0].trim())
        .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
      if (bound.length === 0) continue
      scanned += 1

      // The extent of the call, so a read *after* it is not an offender.
      const paren = match.index + match[0].length - 1
      let depth = 0
      let end = masked.length - 1
      for (let i = paren; i < masked.length; i += 1) {
        if (masked[i] === '(') depth += 1
        else if (masked[i] === ')') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      const span = masked.slice(paren, end + 1)

      for (const name of bound) {
        // A shadow means the name is a *parameter of a function declared inside
        // the call*. Matching the bare shapes `(name)` / `, name,` here is not
        // enough — `settleAttempts(state, role, …)` looks exactly like a
        // parameter list, and treating a call as a declaration is what made the
        // first version of this check blind to its own positive control.
        if (new RegExp(`(?<![\\w.$'])${name}\\s*=>`).test(span)) continue
        const arrow = /\(([^()]*)\)\s*(?::[^=]*?)?=>/g
        let declares = false
        let declared
        while ((declared = arrow.exec(span)) !== null) {
          const params = declared[1].split(',').map((part) => part.trim().split(':')[0].trim())
          if (params.includes(name)) { declares = true; break }
        }
        if (declares) continue
        const read = new RegExp(`(?<![\\w.$'])${name}\\b(?!\\s*:)`).exec(span)
        if (read !== null) {
          reads.push({ line: masked.slice(0, paren + read.index).split('\n').length, name })
        }
      }
    }
    return { reads, scanned }
  }

  // Positive control: the detector must report exactly the shape it exists for.
  const PLANTED = [
    'const { value, state } = await mutateFactory(call, id, async (current) => {',
    '  await settle(current)',
    '  settleAttempts(state, role, def.id, now)',
    '})',
  ].join('\n')
  assert.deepEqual(
    tdzReads(maskNonCode(PLANTED)).reads.map((hit) => hit.name),
    ['state'],
    'the detector no longer sees a temporal-dead-zone read — this check is now vacuous',
  )

  // Negative control: a real shadow is legitimate and must not be reported.
  const SHADOWED = [
    'const { value, state } = await mutateFactory(call, id, async (state) => {',
    "  state.phase = 'running'",
    '})',
  ].join('\n')
  assert.deepEqual(
    tdzReads(maskNonCode(SHADOWED)).reads,
    [],
    'the detector reports a legitimately shadowed parameter',
  )

  const sources = walkFiles(join(repoRoot, 'src')).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
  assert.ok(sources.length >= 30, `only ${sources.length} source files were scanned`)

  const offenders = []
  let scanned = 0
  const filesWithCalls = new Set()
  for (const file of sources) {
    const result = tdzReads(maskNonCode(readFileSync(file, 'utf8')))
    scanned += result.scanned
    if (result.scanned > 0) filesWithCalls.add(rel(file))
    for (const hit of result.reads) offenders.push(`${rel(file)}:${hit.line} reads \`${hit.name}\` inside its own initialiser`)
  }

  // Non-vacuity: `await`-destructuring a value out of a call that also takes a
  // callback is what this check is about, and the tool layer is where it lives.
  // Asserted per LAYER, not per filename: M5 split the old single engine module
  // by domain, and a check pinned to `src/tools/engine.ts` would go vacuous the
  // moment those destructures moved to a sibling module.
  assert.ok(scanned >= 4, `only ${scanned} callback-taking destructures were found`)
  assert.ok(
    [...filesWithCalls].some((file) => file.startsWith('src/tools/')),
    `no src/tools module was scanned as a callback-taking destructure (saw: ${[...filesWithCalls].join(', ') || 'none'})`,
  )

  assert.deepEqual(
    offenders,
    [],
    `bind the callback's own parameter instead:\n  ${offenders.join('\n  ')}`,
  )
})

/*
 * E18 — `consumeMailbox` reads and marks inside ONE locked window.
 *
 * Why this exists (review finding M10)
 *
 * `factory_inbox` used to read the mailbox and then mark what it had read in two
 * separate calls, with the lock only on the second one. That is a message-loss
 * window rather than a theoretical one: once a mailbox rotates (E8 exercises the
 * rotation itself) a message the rotation moves into the archive between the
 * read and the mark is no longer in the live file, so the mark matches nothing
 * and the archived copy stays unread forever — and archives are never read back.
 *
 * The repair was `FactoryStore.consumeMailbox`, which does both under one
 * `withLock`. This check is what keeps the repair from being undone: the race
 * below is precisely what the old two-call sequence gets wrong, and the source
 * half fails if the production path ever goes back to reading and marking as
 * two steps.
 */
await checkAsync('E18 consumeMailbox reads and marks inside one locked window', async () => {
  const consumeRoot = await mkdtemp(join(tmpdir(), 'code-factory-verify-consume-'))
  try {
    const consumeStore = new S.FactoryStore({ workspace: consumeRoot, stateDir: '.code-factory' })
    const decision = D.assembleTeam(FAMILY_BRIEFS.web_fullstack, D.DEFAULT_MAX_MEMBERS)
    const consumeFactory = await consumeStore.create({
      brief: FAMILY_BRIEFS.web_fullstack,
      taskType: decision.taskType,
      pipeline: decision.pipeline,
      captainSessionId: 'session-verify-e18',
      securityTriggered: decision.securityTriggered,
      members: decision.team,
      stages: D.stageIds(decision.pipeline),
    })
    const KEY = 'qa'
    const COUNT = 12
    /*
     * The production default. `readMemberInbox` asks for unread only unless the
     * caller passed `includeRead`, and this is the shape the race below has to
     * be tested through: a read that returns the whole mailbox would return the
     * same rows to both consumers no matter how well it locked, so it cannot
     * tell the fixed code from the broken code.
     */
    const UNREAD = { read: { unreadOnly: true } }
    const seed = async (prefix) => {
      const sent = []
      for (let index = 0; index < COUNT; index += 1) {
        sent.push(await consumeStore.mail(consumeFactory.id, { from: 'captain', to: KEY, content: `${prefix}#${index}` }))
      }
      return sent.map((message) => message.id)
    }

    // (a) The plain contract: everything unread comes back, is marked, and the
    //     reported remainder is the truth rather than a prediction.
    const firstIds = await seed('msg')
    const first = await consumeStore.consumeMailbox(consumeFactory.id, KEY, UNREAD)
    assert.deepEqual(
      first.messages.map((message) => message.id),
      firstIds,
      'consumeMailbox did not return the live mailbox, oldest first',
    )
    assert.equal(first.markedRead, COUNT, 'consumeMailbox did not mark everything it returned')
    assert.equal(first.remainingUnread, 0, 'consumeMailbox reported unread messages it had just marked')
    assert.equal((await consumeStore.listUnread(consumeFactory.id, KEY)).length, 0, 'the consumed messages came back as unread')

    // (b) The regression. Two consumers race for one mailbox: the single locked
    //     window must make them PARTITION it. Read-then-mark hands both the same
    //     unread set — one of them then marks nothing, and across a rotation that
    //     difference is a message nobody ever sees.
    const raceIds = await seed('race')
    const [left, right] = await Promise.all([
      consumeStore.consumeMailbox(consumeFactory.id, KEY, UNREAD),
      consumeStore.consumeMailbox(consumeFactory.id, KEY, UNREAD),
    ])
    const seen = [...left.messages, ...right.messages].map((message) => message.id)
    assert.equal(seen.length, COUNT, `the racy pair returned ${seen.length} messages for ${COUNT} sends`)
    assert.equal(new Set(seen).size, COUNT, 'the two consumers were both handed the same message')
    assert.deepEqual([...seen].sort(), [...raceIds].sort(), 'the two consumers did not cover the mailbox exactly once')
    assert.equal(left.markedRead + right.markedRead, COUNT, 'the pair did not mark exactly the messages they took')
    assert.equal((await consumeStore.listUnread(consumeFactory.id, KEY)).length, 0)

    // (c) `markRead: false` is a real peek — what `factory_inbox` promises when
    //     the caller asks to re-read history without clearing it.
    const peekIds = await seed('peek')
    const peek = await consumeStore.consumeMailbox(consumeFactory.id, KEY, { ...UNREAD, markRead: false })
    assert.deepEqual(
      peek.messages.map((message) => message.id),
      peekIds,
      'markRead:false returned the wrong messages',
    )
    assert.equal(peek.markedRead, 0, 'markRead:false flipped messages to read')
    assert.equal(peek.remainingUnread, COUNT, 'markRead:false claimed the mailbox was drained')
    const afterPeek = await consumeStore.consumeMailbox(consumeFactory.id, KEY, UNREAD)
    assert.equal(afterPeek.markedRead, COUNT, 'a peek consumed what it was supposed to leave behind')
    assert.equal(afterPeek.remainingUnread, 0)

    // (d) The other half of the contract, which reading `readMemberInbox` is what
    //     makes visible: a history read (`includeRead`) returns already-read rows
    //     as well, and must consume ONLY the unread part. Re-stamping `readAt` on
    //     a message somebody already handled would silently rewrite history.
    await seed('hist')
    const history = await consumeStore.consumeMailbox(consumeFactory.id, KEY, {})
    const everything = await consumeStore.readMailbox(consumeFactory.id, KEY)
    assert.equal(history.messages.length, everything.length, 'a history read did not return the whole mailbox')
    assert.ok(everything.length >= COUNT * 4, `the mailbox lost rows: ${everything.length} < ${COUNT * 4}`)
    assert.equal(history.markedRead, COUNT, 'a history read consumed more than the unread part')
    assert.equal(history.remainingUnread, 0)
    const narrowed = await consumeStore.consumeMailbox(consumeFactory.id, KEY, { read: { limit: 3 } })
    assert.equal(narrowed.messages.length, 3, 'a limit did not bound the returned window')
  } finally {
    await rm(consumeRoot, { recursive: true, force: true })
  }

  // The source half: the production path must go through the one-window call.
  // The tool layer is allowed to be several modules (M5), so this is asserted
  // per LAYER, and the racy second step is asserted to be GONE rather than the
  // caller being pinned to a filename.
  const toolSources = walkFiles(join(repoRoot, 'src', 'tools')).filter((file) => file.endsWith('.ts'))
  assert.ok(toolSources.length >= 1, 'no src/tools source was found')
  const consumers = toolSources.filter((file) => /\bconsumeMailbox\s*\(/.test(readFileSync(file, 'utf8')))
  assert.ok(
    consumers.length >= 1,
    `no src/tools module consumes a mailbox in one locked window (scanned ${toolSources.length}: ${toolSources.map((file) => rel(file)).join(', ')})`,
  )
  const twoStep = toolSources.filter((file) => /\.markRead\s*\(/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(
    twoStep.map((file) => rel(file)),
    [],
    'the read-then-mark two-step is back in the tool layer — use store.consumeMailbox instead',
  )
})

/*
 * E19 — `factory.json` carries a schema version, and an unknown one is refused.
 *
 * Why this exists (review finding M8)
 *
 * `factory.json` is the single source of truth and it had NO version field at
 * all, so after a plugin upgrade an old record was interpreted under the new
 * schema. A renamed or re-meaning field then becomes a silent misread of the one
 * file that matters — the worst failure mode available to it, because every
 * other reading of the factory is derived from it.
 *
 * The repair adds `schemaVersion`, stamps it in the ONE place the record is
 * serialised, and REFUSES a version this build must not interpret. The refusal
 * being loud is the whole point: a record somebody else wrote is a fact the
 * reader cannot resolve, not a default to fall back to.
 *
 * Backward compatibility is asserted as hard as the refusal, because the two
 * fail in opposite directions: a version check that rejects every record written
 * before versioning existed would be a worse bug than the one being fixed.
 */
await checkAsync('E19 factory.json carries a schema version and refuses an unknown one', async () => {
  const schemaRoot = await mkdtemp(join(tmpdir(), 'code-factory-verify-schema-'))
  /** Ids must satisfy `isSafeFactoryId`; these are 8 hex characters, like the real ones. */
  const probeId = (n) => `c0ffee${String(n).padStart(2, '0')}`
  const recordPath = (id) => join(schemaRoot, '.code-factory', id, 'factory.json')
  const handWrite = async (id, record) => {
    await mkdir(join(schemaRoot, '.code-factory', id), { recursive: true })
    await writeFile(recordPath(id), JSON.stringify(record, null, 2), 'utf8')
  }

  try {
    assert.equal(typeof S.FACTORY_SCHEMA_VERSION, 'number', 'the store does not publish a schema version')
    assert.equal(S.FACTORY_SCHEMA_VERSION_LEGACY, 0, 'the "written before versioning" value must stay 0')

    const schemaStore = new S.FactoryStore({ workspace: schemaRoot, stateDir: '.code-factory' })
    const decision = D.assembleTeam(FAMILY_BRIEFS.web_fullstack, D.DEFAULT_MAX_MEMBERS)
    const factory = await schemaStore.create({
      brief: FAMILY_BRIEFS.web_fullstack,
      taskType: decision.taskType,
      pipeline: decision.pipeline,
      captainSessionId: 'session-verify-e19',
      securityTriggered: decision.securityTriggered,
      members: decision.team,
      stages: D.stageIds(decision.pipeline),
    })

    // (a) Every write path stamps it, asserted on the FILE, not on the returned
    //     value — a return value that disagrees with the disk is exactly the
    //     drift this finding is about.
    const onDisk = () => JSON.parse(readFileSync(recordPath(factory.id), 'utf8'))
    assert.equal(onDisk().schemaVersion, S.FACTORY_SCHEMA_VERSION, 'create() did not stamp the record on disk')
    assert.equal(factory.schemaVersion, S.FACTORY_SCHEMA_VERSION, 'create() returned an unstamped record')
    await schemaStore.save({ ...(await schemaStore.loadOrThrow(factory.id)), phase: 'running' })
    assert.equal(onDisk().schemaVersion, S.FACTORY_SCHEMA_VERSION, 'save() did not stamp the record on disk')
    await schemaStore.mutate(factory.id, (state) => { state.phase = 'halted' })
    assert.equal(onDisk().schemaVersion, S.FACTORY_SCHEMA_VERSION, 'mutate() did not stamp the record on disk')
    assert.equal(onDisk().phase, 'halted', 'the mutate() did not actually persist')

    // (b) Backward compatibility, and a read must stay a read.
    const legacyId = probeId(1)
    const legacy = { ...onDisk(), id: legacyId }
    delete legacy.schemaVersion
    await handWrite(legacyId, legacy)
    const legacyBefore = readFileSync(recordPath(legacyId), 'utf8')
    const loadedLegacy = await schemaStore.loadOrThrow(legacyId)
    assert.equal(loadedLegacy.schemaVersion, S.FACTORY_SCHEMA_VERSION, 'a pre-versioning record did not resolve to the current schema')
    assert.equal(loadedLegacy.id, legacyId, 'migrating the version dropped the record identity')
    assert.deepEqual(loadedLegacy.members, factory.members, 'migrating the version dropped the roster')
    assert.equal(
      readFileSync(recordPath(legacyId), 'utf8'),
      legacyBefore,
      'a read rewrote the file it was only supposed to read — stamping on read is a lost-update window',
    )

    // (c) A record from a NEWER build is refused, and the refusal names what it
    //     could not resolve: the file, the version found, the version understood.
    const newerId = probeId(2)
    await handWrite(newerId, { ...onDisk(), id: newerId, schemaVersion: 99 })
    const refusal = await schemaStore.load(newerId).then(() => undefined, (error) => error)
    assert.ok(
      refusal instanceof S.FactorySchemaVersionError,
      `a newer record was not refused with a FactorySchemaVersionError: ${refusal?.name}: ${refusal?.message}`,
    )
    assert.equal(refusal.found, 99, 'the refusal lost the version it found')
    assert.equal(refusal.supported, S.FACTORY_SCHEMA_VERSION, 'the refusal lost the version this build understands')
    assert.ok(refusal.message.includes('99'), 'the refusal does not name the version it found')
    assert.ok(refusal.message.includes('factory.json'), 'the refusal does not name the file it refused')

    // (d) The version table itself. A non-number is a REFUSAL, never a coercion:
    //     `"1"` is the dangerous one, because reading it as 1 would treat a
    //     record this build cannot vouch for as one it wrote itself.
    assert.equal(S.assertSupportedSchemaVersion(undefined, 'f.json', 1, 0), 0, 'an absent version must resolve to the legacy value')
    assert.equal(S.assertSupportedSchemaVersion(1, 'f.json', 1, 0), 1)
    assert.equal(S.assertSupportedSchemaVersion(0, 'f.json', 1, 0), 0, 'an older version must pass through, to be migrated')
    for (const raw of ['1', null, {}, true, 1.5, -1, Number.NaN, '1.0']) {
      assert.throws(
        () => S.assertSupportedSchemaVersion(raw, 'f.json', 1, 0),
        S.FactorySchemaVersionError,
        `${JSON.stringify(raw)} was accepted instead of refused`,
      )
    }
    assert.throws(
      () => S.assertSupportedSchemaVersion(2, 'f.json', 1, 0),
      S.FactorySchemaVersionError,
      'a version above the supported one was accepted',
    )

    // (e) The migration chain: the stamp is real, and an unknown step is a loud
    //     failure rather than a record passed through as if it were understood.
    const sample = await schemaStore.loadOrThrow(factory.id)
    assert.equal(S.migrateFactoryState(sample, 0, 1).schemaVersion, 1, '0 -> 1 did not stamp the record')
    assert.equal(S.migrateFactoryState(sample, 1, 1), sample, '1 -> 1 must be a no-op, not a rewrite')
    assert.throws(() => S.migrateFactoryState(sample, 1, 2), /no migration step 1 -> 2/, 'an unimplementable step was silently accepted')
    assert.throws(() => S.migrateFactoryState(sample, 2, 1), /downgrade/, 'a downgrade was accepted')

    // (f) One unreadable record must not take the whole workspace with it: the
    //     cockpit lists what it can read and reports the rest, because a refusal
    //     that hides every OTHER factory is a denial of service on the panel.
    const summaries = await schemaStore.list()
    const listed = summaries.map((summary) => summary.id)
    assert.ok(listed.includes(factory.id), `a readable factory vanished from list(): ${listed.join(', ')}`)
    assert.ok(listed.includes(legacyId), `a migrated record vanished from list(): ${listed.join(', ')}`)
    assert.ok(!listed.includes(newerId), 'an unreadable record was listed as if it had been understood')
  } finally {
    await rm(schemaRoot, { recursive: true, force: true })
  }
})

/* --------------------------------- F. lock detach & serialisation ---------- */

/*
 * Why this section exists
 *
 * `withFactoryLock` detects re-entry through an `AsyncLocalStorage` held-set.
 * A locked window that awaits work which *starts, wakes or tears down another
 * session* (member spawn, prompt delivery, interrupt, drain) would leak that
 * held-set into the session's async lineage, so that session's first factory
 * mutation would be rejected as a `lock_reentry` it never caused.
 * `runDetachedFromFactoryLocks(fn)` runs `fn` with the held-set cleared and
 * restores the caller's context on the way out. Removing it is a silent
 * regression: nothing else in the suite notices, and it only shows up as a
 * member dying on a lock error at runtime. Section F is the guard.
 *
 * F1-F3 are the same three checks the mutant control (F7) replays against a
 * temp copy with detach neutralised, so "the assertions can fail" is asserted
 * by the suite itself, not just by a human running an injection once.
 */

section('F lock detach & serialisation')

const LOCK_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Keys this section uses; F6 asserts none of them leaks back into the table. */
const F_LOCK_PREFIX = 'verify:t22:'
const fLockKey = (name) => `${F_LOCK_PREFIX}${name}`

/**
 * The client contract of `lib/store/lock.js`, written against the module as a
 * parameter so the very same checks can be replayed against a mutant copy.
 * `detachDependent` marks the checks that MUST fail once detach is neutralised.
 */
const MECHANISM_CHECKS = [
  {
    name: 'detach empties the held set for the wrapper body - across awaits - and restores the caller',
    detachDependent: true,
    async run(lock) {
      const key = fLockKey('detach')
      await lock.withFactoryLock(key, async () => {
        assert.equal(lock.isFactoryLockHeld(key), true, 'the locked window must hold its key')
        assert.deepEqual(lock.factoryLockHeldKeys(), [key])
        const seen = await lock.runDetachedFromFactoryLocks(async () => {
          const immediate = lock.factoryLockHeldKeys()
          await LOCK_SLEEP(5)
          return { immediate, afterAwait: lock.factoryLockHeldKeys() }
        })
        assert.deepEqual(seen.immediate, [], 'held set must be empty inside the detached body')
        assert.deepEqual(seen.afterAwait, [], 'detach must survive an await inside the body')
        assert.deepEqual(lock.factoryLockHeldKeys(), [key], 'caller context must come back on exit')
      })
      assert.deepEqual(lock.factoryLockHeldKeys(), [], 'no held context may leak out of the window')
    },
  },
  {
    name: 'work woken inside the lock window can take the same key (no false re-entry)',
    detachDependent: true,
    async run(lock) {
      const key = fLockKey('woken')
      let woken
      await lock.withFactoryLock(key, async () => {
        woken = lock.runDetachedFromFactoryLocks(() =>
          lock.withFactoryLock(key, async () => {
            await LOCK_SLEEP(2)
            return 'woken'
          }),
        )
      })
      const settled = await woken.then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      assert.equal(
        settled.error,
        undefined,
        `the woken task must not be rejected — a rejection here is a FALSE re-entry: ${settled.error?.name} ${settled.error?.message}`,
      )
      assert.equal(settled.value, 'woken', 'the woken task must acquire the key after the holder releases')
      assert.equal(await lock.withFactoryLock(key, async () => 'reusable'), 'reusable')
    },
  },
  {
    name: 'control: the same woken work WITHOUT detach is a false re-entry (the wrapper is load-bearing)',
    detachDependent: false,
    async run(lock) {
      const key = fLockKey('nodetach')
      let captured
      await lock.withFactoryLock(key, async () => {
        captured = lock.withFactoryLock(key, async () => 'never').then(
          () => null,
          (error) => error,
        )
        await captured
      })
      const error = await captured
      assert.equal(error?.name, 'FactoryLockReentryError', `expected a loud re-entry, got ${String(error)}`)
      assert.equal(error?.code, 'lock_reentry')
      assert.equal(error?.key, key)
    },
  },
]

for (const [index, mechanism] of MECHANISM_CHECKS.entries()) {
  await checkAsync(`F${index + 1} ${mechanism.name}`, () => mechanism.run(L))
}

await checkAsync('F4 detach is transparent: value and throw pass through, context survives a throw', async () => {
  assert.equal(L.runDetachedFromFactoryLocks(() => 42), 42, 'sync return value must pass through')
  assert.equal(await L.runDetachedFromFactoryLocks(async () => 'ok'), 'ok', 'async return value must pass through')
  const boom = new Error('detach-transparency')
  assert.throws(() => L.runDetachedFromFactoryLocks(() => { throw boom }), (error) => error === boom)
  const key = fLockKey('transparent')
  await L.withFactoryLock(key, async () => {
    await assert.rejects(() => L.runDetachedFromFactoryLocks(async () => { throw boom }), (error) => error === boom)
    assert.equal(L.isFactoryLockHeld(key), true, 'a throw inside the wrapper must not clear the caller context')
  })
})

await checkAsync('F5 same-key work is serialised FIFO, never overlaps, and a rejecting task keeps the queue usable', async () => {
  const key = fLockKey('fifo')
  let inside = 0
  let maxInside = 0
  const order = []
  const delays = [12, 2, 8, 0, 4]
  const tasks = delays.map((ms, index) =>
    L.withFactoryLock(key, async () => {
      inside += 1
      maxInside = Math.max(maxInside, inside)
      order.push(index)
      await LOCK_SLEEP(ms)
      inside -= 1
      if (index === 3) throw new Error('task 3 fails on purpose')
      return index
    }),
  )
  const settled = await Promise.allSettled(tasks)
  assert.equal(maxInside, 1, 'two same-key tasks ran concurrently')
  assert.deepEqual(order, [0, 1, 2, 3, 4], 'the queue is not FIFO')
  assert.deepEqual(
    settled.map((entry) => entry.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled'],
    'a rejecting task must not poison later tasks',
  )
  assert.equal(await L.withFactoryLock(key, async () => 'still usable'), 'still usable')
})

await checkAsync('F6 no leaked queue entry and no held context after every scenario above', async () => {
  // The queue bookkeeping (`pending -= 1`, entry deletion) runs in a `.then()`
  // on the task's own settled promise, i.e. one microtask *after* the awaiting
  // caller resumes. Flush a macrotask so this check measures the steady state
  // instead of racing the bookkeeping.
  await LOCK_SLEEP(0)
  assert.deepEqual(L.factoryLockHeldKeys(), [], 'a held key leaked out of the F section')
  const stats = L.factoryLockQueueStats().filter((entry) => entry.key.startsWith(F_LOCK_PREFIX))
  assert.deepEqual(stats, [], `leaked lock queue entries: ${JSON.stringify(stats)}`)
  assert.deepEqual(
    L.factoryLockQueueKeys().filter((entry) => entry.key.startsWith(F_LOCK_PREFIX)),
    [],
    'a queue entry was never deleted',
  )
})

await checkAsync('F7 control: neutralising detach in a throwaway copy fails exactly the detach-dependent checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'code-factory-detach-'))
  try {
    /*
   * The copied modules keep their relative layout under a throwaway `lib/` root,
   * and their own relative imports are followed transitively. Copying the two
   * files flat used to be enough, but `state.js` now imports `../shared/types.js`
   * (the six closed vocabularies live there — see E16), and a flat copy made this
   * control fail with
   *   Cannot find module '…\Temp\shared\types.js' imported from …\Temp\…\state.js
   * i.e. for a packaging reason, not a detach one. Following the closure keeps the
   * control measuring what it is named after.
   */
    const copied = new Set()
    const copyClosure = async (relPath) => {
      if (copied.has(relPath)) return
      copied.add(relPath)
      const source = join(repoRoot, 'lib', relPath)
      if (!existsSync(source)) return
      const target = join(dir, relPath)
      await mkdir(join(dir, ...relPath.split('/').slice(0, -1)), { recursive: true })
      const text = await readFile(source, 'utf8')
      await writeFile(target, text, 'utf8')
      for (const match of text.matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)) {
        const resolved = fileURLToPath(new URL(match[1], pathToFileURL(source)))
        const dep = relative(join(repoRoot, 'lib'), resolved).split('\\').join('/')
        if (!dep.startsWith('..')) await copyClosure(dep)
      }
    }
    await copyClosure('store/lock.js')
    await copyClosure('store/state.js')

    const lockPath = join(dir, 'store', 'lock.js')
    const original = await readFile(lockPath, 'utf8')
    const anchor = 'return held.run(DETACHED_LOCK_CONTEXT, fn);'
    assert.equal(
      original.includes(anchor),
      true,
      `injection anchor not found in lib/store/lock.js — this control must be kept in sync with the implementation (expected: ${anchor})`,
    )
    await writeFile(lockPath, original.replace(anchor, 'return fn();'), 'utf8')
    const mutant = await import(pathToFileURL(lockPath).href)

    const failed = []
    for (const mechanism of MECHANISM_CHECKS) {
      try {
        await mechanism.run(mutant)
      } catch {
        failed.push(mechanism.name)
      }
    }
    const expected = MECHANISM_CHECKS.filter((mechanism) => mechanism.detachDependent).map((mechanism) => mechanism.name)
    assert.equal(expected.length >= 2, true, 'fewer than two detach-dependent checks: the guard is too thin')
    assert.deepEqual(
      [...failed].sort(),
      [...expected].sort(),
      `a mutant without detach must fail exactly the detach-dependent checks; failed=[${failed.join(' | ')}] expected=[${expected.join(' | ')}]`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/*
 * Structural scanner (F8/F9)
 *
 * The behavioural checks above prove the *mechanism* works. They cannot prove
 * the codebase still *uses* it: a new `await deliverToMember(...)` added inside
 * a locked window without the wrapper would keep every F1-F7 check green. This
 * scanner closes that hole by auditing call sites in the source tree.
 *
 * Rule: every call site of a session-lifecycle operation must sit inside a
 * `runDetachedFromFactoryLocks(...)` span, and so must every raw
 * `ctx.subagents.*` / `ctx.agents.*` call outside the module that implements the
 * wrappers (`src/runtime/compat.ts`, whose own host calls inherit the detach
 * context established by its callers).
 *
 * The lexer below is a pragmatic code-mask (comments, strings and template
 * literals are not code), not a TypeScript parser. F9's controls are what keep
 * it honest: they prove it *detects* an unwrapped call and that removing any one
 * existing wrapper is reported, so a scanner that sees nothing cannot pass.
 */

const DETACH_WRAPPER = 'runDetachedFromFactoryLocks'
/** Host session-lifecycle surface that MUST be wrapped (bare import names). */
const DETACH_REQUIRED_CALLEES = [
  'startWithLenientFilter', // starts a continuable child session
  'deliverToMember', // wakes a member with a prompt
  'interruptMemberTurn', // tears down an in-flight member turn
  'drainMemberChildren', // settles member children
]
/** Module implementing the wrappers: its own host calls are not call sites. */
const WRAPPER_IMPLEMENTATION = 'src/runtime/compat.ts'

/** 1 = the character is real code, 0 = comment / string body. */
function codeMask(text) {
  const mask = new Uint8Array(text.length)
  let state = 'code'
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const c2 = text[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; continue }
      if (c === '/' && c2 === '*') { state = 'block'; continue }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tq'
      else mask[i] = 1
      continue
    }
    if (state === 'line') { if (c === '\n') state = 'code'; continue }
    if (state === 'block') { if (c === '*' && c2 === '/') { i += 1; state = 'code' } ; continue }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { i += 1; continue }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code'
      continue
    }
    if (state === 'tq') { if (c === '\\') { i += 1; continue } if (c === '`') state = 'code' }
  }
  return mask
}

const lineIndexAt = (text, index) => text.slice(0, index).split('\n').length

/** `[start, end]` of every `runDetachedFromFactoryLocks(...)` call, balanced-paren. */
function detachWrapperSpans(text, mask) {
  const spans = []
  const re = new RegExp(`\\b${DETACH_WRAPPER}\\s*\\(`, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    if (!mask[match.index]) continue
    let depth = 0
    for (let i = match.index + match[0].length - 1; i < text.length; i += 1) {
      if (!mask[i]) continue
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') {
        depth -= 1
        if (depth === 0) { spans.push([match.index, i]); break }
      }
    }
  }
  return spans
}

/** Audits one in-memory snapshot: `{ callSites, violations, wrapperSpans }`. */
function scanDetachCoverage(entries) {
  const callSites = []
  const violations = []
  const wrapperCount = { total: 0 }
  for (const { path, text } of entries) {
    const mask = codeMask(text)
    const spans = detachWrapperSpans(text, mask)
    wrapperCount.total += spans.length
    wrapperCount[path] = spans.length
    const covered = (index) => spans.some(([start, end]) => index > start && index < end)

    for (const callee of DETACH_REQUIRED_CALLEES) {
      const re = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g')
      let match
      while ((match = re.exec(text)) !== null) {
        if (!mask[match.index]) continue
        const before = text.slice(Math.max(0, match.index - 48), match.index)
        if (/function\s+(async\s+)?$/.test(before)) continue // declaration, not a call
        const site = { path, line: lineIndexAt(text, match.index), callee }
        callSites.push(site)
        if (!covered(match.index)) violations.push({ ...site, reason: `outside ${DETACH_WRAPPER}(...)` })
      }
    }

    if (path === WRAPPER_IMPLEMENTATION) continue
    const hostRe = /ctx\.(subagents|agents)\.\w+\s*\(/g
    let hostMatch
    while ((hostMatch = hostRe.exec(text)) !== null) {
      if (!mask[hostMatch.index]) continue
      const site = { path, line: lineIndexAt(text, hostMatch.index), callee: hostMatch[0].replace(/\s*\($/, '') }
      callSites.push(site)
      if (!covered(hostMatch.index)) {
        violations.push({ ...site, reason: `raw host session call outside ${DETACH_WRAPPER}(...)` })
      }
    }
  }
  return { callSites, violations, wrapperCount }
}

/** `src/**​/*.ts(x)` as in-memory snapshots; unreadable files are reported, not skipped. */
async function readSourceTree() {
  const paths = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) paths.push(child)
    }
  }
  walk('src')

  const entries = []
  const unreadable = []
  for (const path of paths) {
    try {
      const text = await readFile(join(repoRoot, path), 'utf8')
      entries.push({ path, text, mtimeMs: statSync(join(repoRoot, path)).mtimeMs })
    } catch (error) {
      unreadable.push({ path, message: String((error && error.message) || error) })
    }
  }
  return { entries, unreadable }
}

/**
 * Removes the wrapper around the first call site of `callee` (balanced rewrite,
 * in memory only). Used by F9 to prove the scanner reports a missing wrapper.
 */
function unwrapFirstCallSite(text, callee) {
  const mask = codeMask(text)
  const spans = detachWrapperSpans(text, mask)
  const re = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    if (!mask[match.index]) continue
    const before = text.slice(Math.max(0, match.index - 48), match.index)
    if (/function\s+(async\s+)?$/.test(before)) continue
    const span = spans.find(([start, end]) => match.index > start && match.index < end)
    if (!span) return { text, removed: false }
    const [start, end] = span
    const inner = text.slice(start + DETACH_WRAPPER.length + 1, end)
    return { text: text.slice(0, start) + inner + text.slice(end + 1), removed: true }
  }
  return { text, removed: false }
}

await checkAsync('F8 src/ has no session-lifecycle call site outside a detach wrapper', async () => {
  // §6.3: the tree is shared with concurrent writers, so re-read once before
  // reporting anything; only a violation that survives both reads is a verdict.
  const evaluate = async () => {
    const snapshot = await readSourceTree()
    return { ...scanDetachCoverage(snapshot.entries), unreadable: snapshot.unreadable, entries: snapshot.entries }
  }
  let result = await evaluate()
  const newest = result.entries.reduce((acc, entry) => (entry.mtimeMs > acc.mtimeMs ? entry : acc), { path: '-', mtimeMs: 0 })
  line(`  scanned ${result.entries.length} source files, ${result.callSites.length} call sites, ${result.wrapperCount.total} wrappers`)
  line(`  newest scanned file: ${newest.path} @ ${new Date(newest.mtimeMs).toISOString()}`)
  if (result.unreadable.length > 0 || result.violations.length > 0) {
    await LOCK_SLEEP(200)
    const reread = await evaluate()
    assert.deepEqual(reread.unreadable, [], `source files unreadable: ${JSON.stringify(reread.unreadable)}`)
    assert.deepEqual(
      reread.violations,
      [],
      `first read: ${JSON.stringify(result.violations)} — re-read: ${JSON.stringify(reread.violations)}`,
    )
    result = reread
  }
  assert.deepEqual(result.unreadable, [], `source files unreadable: ${JSON.stringify(result.unreadable)}`)
  assert.deepEqual(
    result.violations,
    [],
    `unwrapped session-lifecycle call sites: ${result.violations.map((v) => `${v.path}:${v.line} ${v.callee} (${v.reason})`).join('; ')}`,
  )
  assert.equal(
    result.callSites.length >= DETACH_REQUIRED_CALLEES.length,
    true,
    `the scanner only saw ${result.callSites.length} call sites — it is not looking at the real tree (vacuous scan)`,
  )
})

check('F9 scanner controls: an unwrapped call is detected, and each real wrapper is load-bearing', () => {
  const membersPath = 'src/runtime/members.ts'
  const absolute = join(repoRoot, membersPath)
  assert.equal(existsSync(absolute), true, `${membersPath} is missing — this check audits the source tree`)
  const members = readFileSync(absolute, 'utf8')

  // green control: the untouched file is clean
  assert.deepEqual(scanDetachCoverage([{ path: membersPath, text: members }]).violations, [])

  // anti-vacuity: every guarded callee must really appear in the tree
  const seen = new Set(scanDetachCoverage([{ path: membersPath, text: members }]).callSites.map((site) => site.callee))
  for (const callee of DETACH_REQUIRED_CALLEES) {
    assert.equal(
      seen.has(callee),
      true,
      `${callee} is guarded by this scanner but appears nowhere in ${membersPath} — keep the list in sync with the code`,
    )
  }

  // positive detection: a synthetic unwrapped call must be reported
  const synthetic = `${members}\nconst injected = await startWithLenientFilter(() => 1)\n`
  const syntheticViolations = scanDetachCoverage([{ path: membersPath, text: synthetic }]).violations
  assert.equal(syntheticViolations.length, 1, `synthetic unwrapped call not reported: ${JSON.stringify(syntheticViolations)}`)
  assert.equal(syntheticViolations[0].callee, 'startWithLenientFilter')

  // negative controls: dropping any one wrapper is reported, with no collateral
  // noise (startWithLenientFilter also covers the raw host call it wraps).
  const expected = { deliverToMember: 1, interruptMemberTurn: 1, drainMemberChildren: 1, startWithLenientFilter: 2 }
  for (const [callee, count] of Object.entries(expected)) {
    const { text, removed } = unwrapFirstCallSite(members, callee)
    assert.equal(removed, true, `no wrapper found around ${callee} — the mutation could not be applied`)
    const found = scanDetachCoverage([{ path: membersPath, text }]).violations
    assert.equal(found.length, count, `removing the wrapper around ${callee} reported ${found.length} violation(s), expected ${count}`)
    assert.equal(
      found.some((violation) => violation.callee === callee),
      true,
      `the reported violation does not name ${callee}: ${JSON.stringify(found)}`,
    )
  }
})

/* ---- F10/F11: the lock really excludes a SECOND OS PROCESS (not just a task) -- */

/**
 * Run `procs` real OS processes that share one counter file and each perform
 * `rounds` read-modify-writes with a deliberate gap between the read and the write.
 *
 * Every process reads and writes at a wall-clock barrier handed to it by this
 * parent, so the unlocked variants are guaranteed to overlap inside the critical
 * section rather than merely likely to.
 *
 * @param {{ locked: boolean, rounds: number }} options `locked: false` bypasses
 *   `store.withLock` entirely — the pre-fix code path, used here as the negative
 *   control that proves the probe can actually observe a lost update.
 * @returns {Promise<number>} the counter value the file ends on.
 */
async function crossProcessRace({ locked, rounds }) {
  const dir = await mkdtemp(join(tmpdir(), 'code-factory-race-'))
  const counterFile = join(dir, 'counter.txt')
  const storeLib = LIBS.find(([, file]) => file.endsWith('store.js'))[1]
  const procs = 2
  const barrier = Date.now() + 600

  const body = `
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { FactoryStore } = await import(${JSON.stringify(pathToFileURL(storeLib).href)})
const store = new FactoryStore({ root: ${JSON.stringify(store.root)} })
const counter = ${JSON.stringify(counterFile)}
const rounds = ${rounds}
const barrier = ${barrier}
const bump = async () => {
  const text = await readFile(counter, 'utf8').catch(() => '0')
  await new Promise((resolve) => setTimeout(resolve, 150))
  await writeFile(counter, String(Number(text) + 1))
}
while (Date.now() < barrier) await new Promise((resolve) => setTimeout(resolve, 5))
for (let i = 0; i < rounds; i += 1) {
  ${
    locked
      ? `await store.withLock(${JSON.stringify(created.id)}, bump)`
      : 'await bump() /* deliberately unlocked: the negative control */'
  }
}
`

  await Promise.all(
    Array.from({ length: procs }, async () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', body], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const code = await new Promise((resolve) => child.on('close', resolve))
      assert.equal(code, 0, `race child exited ${code}: ${stderr.trim()}`)
    }),
  )

  const text = await readFile(counterFile, 'utf8').catch(() => '0')
  return Number(text)
}

const RACE_ROUNDS = 3

await checkAsync('F10 two real OS processes serialise on the cross-process lock (no lost update)', async () => {
  const total = RACE_ROUNDS * 2
  const counted = await crossProcessRace({ locked: true, rounds: RACE_ROUNDS })
  assert.equal(
    counted,
    total,
    `the counter ended on ${counted}, expected ${total} — ${total - counted} read-modify-write(s) were lost, so store.withLock did not exclude the second process`,
  )
})

await checkAsync('F11 negative control: the same race WITHOUT the lock does lose updates', async () => {
  const total = RACE_ROUNDS * 2
  let lost = 0
  // Three attempts: the barrier makes an overlap near-certain, and requiring the
  // probe to fail at least once in three keeps this honest on a loaded machine
  // without ever letting a broken probe pass by accident.
  for (let attempt = 0; attempt < 3 && lost === 0; attempt += 1) {
    lost = total - (await crossProcessRace({ locked: false, rounds: RACE_ROUNDS }))
  }
  assert.ok(
    lost > 0,
    `the unlocked control finished on ${total}/${total} three times — the probe cannot detect a lost update, so F10 proves nothing`,
  )
})

await checkAsync('F12 a live foreign holder blocks us, is reported, and then times out loudly', async () => {
  const storeLib = LIBS.find(([, file]) => file.endsWith('store.js'))[1]
  const body = `
import { pathToFileURL } from 'node:url'
const { FactoryStore } = await import(${JSON.stringify(pathToFileURL(storeLib).href)})
const store = new FactoryStore({ root: ${JSON.stringify(store.root)} })
await store.withLock(${JSON.stringify(created.id)}, async () => {
  process.stdout.write('held\\n')
  await new Promise((resolve) => setTimeout(resolve, 2500))
})
`
  const child = spawn(process.execPath, ['--input-type=module', '-e', body], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  // Wait for the child to actually hold the lock before racing it.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the poller never reported the holder (stderr: ${stderr.trim()})`)), 10_000)
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('held')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const waits = []
  let thrown
  try {
    await store.withLock(created.id, async () => 'should never run', {
      fileLock: { timeoutMs: 400, pollMs: 40, onWait: (info) => waits.push(info) },
    })
  } catch (error) {
    thrown = error
  } finally {
    child.kill()
  }

  assert.ok(
    thrown instanceof S.FactoryFileLockTimeoutError,
    `expected a FactoryFileLockTimeoutError, got ${thrown === undefined ? 'no error at all (the second writer proceeded!)' : String(thrown)}`,
  )
  assert.equal(thrown.holder?.pid, child.pid, `the error did not name the holder: ${JSON.stringify(thrown.holder)}`)
  assert.ok(waits.length >= 1, 'onWait never fired, so a stall would be silent')
  assert.equal(waits[0].file, S.factoryLockFile(store.root, created.id))
})

/*
 * The in-process queue had an opt-in timeout that, when it expired, only
 * abandoned the *wait*: the task stayed chained to the queue tail and ran
 * anyway, so the caller saw a failure while the write still landed. There was
 * also no default, so a single never-settling task parked every later mutation
 * of that factory forever with no error anywhere.
 *
 * F13 and F14 pin both halves: the default exists and is finite, and an
 * abandoned task never runs.
 */
await checkAsync('F13 the acquisition watchdog is on by default and can be opted out of', async () => {
  assert.equal(typeof L.DEFAULT_FACTORY_LOCK_TIMEOUT_MS, 'number', 'no default watchdog is exported')
  assert.ok(
    L.DEFAULT_FACTORY_LOCK_TIMEOUT_MS > 0 && L.DEFAULT_FACTORY_LOCK_TIMEOUT_MS <= 5 * 60_000,
    `default watchdog is not a sane duration: ${L.DEFAULT_FACTORY_LOCK_TIMEOUT_MS}`,
  )

  // A holder that never settles: with the default in force the second caller
  // must be released by the watchdog, not left hanging.
  const key = `${F_LOCK_PREFIX}watchdog`
  assert.equal(
    typeof L.FactoryLockTimeoutError,
    'function',
    'FactoryLockTimeoutError went missing from the lock module',
  )

  let released = false
  const held = L.withFactoryLock(key, async () => {
    await LOCK_SLEEP(250)
    released = true
  }, { timeoutMs: 0 })

  let thrown
  try {
    await L.withFactoryLock(key, async () => 'should never run', { timeoutMs: 25 })
  } catch (error) {
    thrown = error
  }
  await held
  assert.ok(released, 'the holder never finished, so the queue is broken')
  assert.ok(
    thrown instanceof L.FactoryLockTimeoutError,
    `expected a FactoryLockTimeoutError from the second caller, got ${String(thrown)}`,
  )
  assert.equal(thrown.key, key)
  assert.equal(thrown.timeoutMs, 25)
  assert.ok(typeof thrown.queueDepth === 'number' && thrown.queueDepth >= 1, 'the error did not report the queue depth')

  // S2: a lock error used to name only the machine key, so a maintainer reading
  // `withFactoryLock("factory:9f3ac2d1")` had to decode it to learn WHICH factory
  // stalled. `subject` is how a caller that knows the identity says so; the lock
  // layer stays generic, so a caller that does not know still gets the key alone.
  assert.equal(thrown.subject, undefined, 'a caller that supplied no subject must not get an invented one')
  assert.ok(
    !String(thrown.message).includes('subject:'),
    `no subject was supplied, so the message must not grow one: ${String(thrown.message)}`,
  )

  let selfDescribing
  const heldAgain = L.withFactoryLock(key, async () => {
    await LOCK_SLEEP(250)
  }, { timeoutMs: 0 })
  try {
    await L.withFactoryLock(key, async () => 'should never run', {
      timeoutMs: 25,
      subject: '工厂 watchdog-subject',
    })
  } catch (error) {
    selfDescribing = error
  }
  await heldAgain
  assert.ok(
    selfDescribing instanceof L.FactoryLockTimeoutError,
    `expected a timeout, got ${String(selfDescribing)}`,
  )
  assert.equal(selfDescribing.subject, '工厂 watchdog-subject')
  assert.ok(
    String(selfDescribing.message).includes('subject: 工厂 watchdog-subject'),
    `the message must carry the human identity: ${String(selfDescribing.message)}`,
  )
  assert.ok(
    String(selfDescribing.message).includes(key),
    'the machine key must survive; the subject is an addition, not a replacement',
  )

  // ...and the wiring has to be live. `Store.withLock` is the caller that knows
  // both the key and the factory, so it is the caller whose errors this fix was
  // for; a `subject` that no production caller ever passes would be dead code.
  let fromStore
  const storeHeld = store.withLock(created.id, async () => {
    await LOCK_SLEEP(250)
  }, { lockOptions: { timeoutMs: 0 } })
  try {
    await store.withLock(created.id, async () => 'should never run', { lockOptions: { timeoutMs: 25 } })
  } catch (error) {
    fromStore = error
  }
  await storeHeld
  assert.ok(
    fromStore instanceof L.FactoryLockTimeoutError,
    `expected a lock timeout through Store.withLock, got ${String(fromStore)}`,
  )
  assert.equal(fromStore.subject, `工厂 ${created.id}`, 'Store.withLock must name the factory it could not lock')
  assert.ok(
    String(fromStore.message).includes(`subject: 工厂 ${created.id}`),
    `the store's lock error must be readable without decoding the key: ${String(fromStore.message)}`,
  )
})

await checkAsync('F14 an abandoned task is dropped, not merely un-awaited', async () => {
  const key = `${F_LOCK_PREFIX}abandon`
  let ran = 0

  const held = L.withFactoryLock(key, async () => {
    await LOCK_SLEEP(250)
  }, { timeoutMs: 0 })

  let thrown
  try {
    await L.withFactoryLock(
      key,
      () => {
        ran += 1
        return 'landed'
      },
      { timeoutMs: 25 },
    )
  } catch (error) {
    thrown = error
  }

  // Give the queue time to reach the abandoned task's turn and settle it.
  await held
  await LOCK_SLEEP(50)

  assert.ok(thrown instanceof L.FactoryLockTimeoutError, `expected a timeout, got ${String(thrown)}`)
  assert.equal(ran, 0, 'a timed-out caller still performed its write')
  assert.ok(
    !L.factoryLockQueueKeys().includes(key),
    `an abandoned queue entry leaked: ${JSON.stringify(L.factoryLockQueueStats())}`,
  )
})

/* ------------------------------------------------- G. harness self-check ---- */

section('G harness self-check')

/*
 * Every `checkAsync(...)` must be awaited (see `inFlightChecks`). If one was
 * not, drain it so its verdict is still counted, then fail loudly: a guard
 * whose verdict can land after the summary reads as green while never running.
 * Section I carries a second copy of this guard at the true tail of the run.
 */
const floatedChecks = inFlightChecks.size
if (floatedChecks > 0) {
  line(`  [note] ${floatedChecks} async check(s) were still in flight — draining before the summary`)
  await Promise.allSettled([...inFlightChecks])
}

check('G1 no checkAsync(...) verdict escaped the summary (every call site is awaited)', () => {
  assert.equal(
    floatedChecks,
    0,
    `${floatedChecks} async check(s) were still running when the run reached the summary — await them, ` +
      'otherwise their verdict never reaches the exit code',
  )
})

/*
 * H12: "did not throw" is not the same as "asserted something", and a census
 * taken here would only see sections A–G.
 *
 * Both census assertions therefore live at the true tail of the run, as `I12`
 * and `I13`, next to the drain guard that re-measures `inFlightChecks` for the
 * same reason: section G runs *before* sections H and I register their checks,
 * so anything measured here is structurally blind to them. (This bit for real —
 * the floor read 45 of 67 and failed on the first run.)
 */

/*
 * B4: rollback used to be a claim. The runbook described a backup that wrote
 * checksums; what was on disk was five copied files and no manifest, and the
 * directory the runbook named did not exist. `scripts/profile-backup.mjs` is the
 * missing half, and this check runs its self-test, which asserts that a
 * corrupted byte, a deleted file, an added file, a tampered manifest and a
 * missing seal are each caught and named — and that a restore refuses a backup
 * that no longer verifies. Without a check like this the tool would be one more
 * untested script that only looks like a safety net.
 */
check('G2 the rollback tool catches every way a backup can be wrong (drill)', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'profile-backup.mjs'), 'drill'], {
    encoding: 'utf8',
  })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `profile-backup drill failed:\n${out}`)
  assert.match(out, /all \d+ stages behaved as designed/, 'the drill must report its stage count')
  const failed = out.split('\n').filter((one) => one.includes('[FAIL]'))
  assert.deepEqual(failed, [], `drill stages failed:\n${failed.join('\n')}`)
})

/* ------------------------ H. stranded recovery & executor verdict (t21) ---- */

section('H stranded attempt recovery & executor verdict')

/*
 * Ported from the t21 offline harness (`.tmp-runtime-check/t21-stranded.mjs`),
 * which lived OUTSIDE the repository: nobody runs a file in a temp directory,
 * and deleting that directory would have deleted the regression guard with it.
 * Same reasoning as the F section (t22), same subject discipline.
 *
 * What is asserted here is `scheduler.ts` rule 4 — a member whose durable status
 * claims work that no executor is performing. The criterion is the liveness
 * probe (`ctx.agents.get(sessionId)`), and the two branches are opposites:
 *
 *   - a LIVE executor  ⇒ `wait`, never a re-dispatch (re-dispatching duplicates work);
 *   - a GONE executor  ⇒ exactly one recovery with a fresh attempt (nothing to duplicate).
 *
 * The third state (`unknown`: no probe wired) must fail safe.
 */
const H_DEAD_SESSION = '8c67ea14-6ebe-46ee-a1b1-bf622dbf74cc'
const H_LIVE_SESSION = '11111111-2222-3333-4444-555555555555'
const H_NOW = 1791708000000
const H_STALE = R.DEFAULT_STALE_AFTER_MS
const H_LOCK_PREFIX = 'verify:t30:'

/** The rehearsed incident record (factory.json of 94cc97c3, after a restart). */
function incidentState(overrides = {}) {
  const pipelineId = overrides.pipeline ?? 'lightweight'
  return {
    id: '94cc97c3',
    name: '批量图片重命名脚本',
    brief: '写一个批量重命名图片文件的 Python 脚本，支持 dry-run。',
    taskType: 'script_tool',
    pipeline: pipelineId,
    captainSessionId: 'session-acd00664-5055-4ddc-9fc6-d919ee1c0f94',
    phase: 'running',
    securityTriggered: false,
    members: [
      {
        role: 'pm',
        status: 'working',
        tokens: 0,
        sessionId: H_DEAD_SESSION,
        startedAt: H_NOW - 60_000,
        currentStage: 'requirement',
      },
      { role: 'be_dev', status: 'staged', tokens: 0 },
      { role: 'reviewer', status: 'staged', tokens: 0 },
      { role: 'qa', status: 'staged', tokens: 0 },
      { role: 'devops', status: 'staged', tokens: 0 },
    ],
    stages: D.getPipeline(pipelineId).map((def) => ({
      id: def.id,
      status: def.id === 'requirement' ? 'active' : 'pending',
      round: 0,
      attempts: def.id === 'requirement' ? 1 : 0,
      ...(def.id === 'requirement' ? { startedAt: H_NOW - 60_000 } : {}),
    })),
    dod: [],
    createdAt: H_NOW - 3_000_000,
    updatedAt: H_NOW - 60_000,
    approvedAt: H_NOW - 3_000_000,
    ...overrides,
  }
}

function hPatchMember(state, role, patch) {
  Object.assign(state.members.find((candidate) => candidate.role === role), patch)
  return state
}
function hPatchStage(state, stageId, patch) {
  Object.assign(state.stages.find((candidate) => candidate.id === stageId), patch)
  return state
}
/** `sessionId → 'running' | 'idle'`; a session that is absent is `gone`. */
function executorProbes(live) {
  return {
    isLive: (sessionId) => (live ?? {})[sessionId] !== undefined,
    isRunning: (sessionId) => (live ?? {})[sessionId] === 'running',
  }
}

const H_PROVIDER = {
  name: 'spawn',
  capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async prepareContinuable() {
    return {}
  },
}
const H_REGISTERED_TOOLS = new Set([
  'factory_report',
  'factory_inbox',
  'factory_block',
  'factory_plan',
  'factory_gate',
  'read',
  'write',
  'pwsh',
])

/**
 * A hand-rolled host, byte-for-byte the probe semantics the incident ran with.
 * Used by H1–H10; section I uses the SHIPPED model (`runtime/testing.ts`) so the
 * two can be compared.
 */
function bareHost(options = {}) {
  const calls = { delivered: [], startActivation: [], interrupted: [], drained: [] }
  const symbol = Symbol.for('dsh.subagent.deliverPrompt')
  const liveAgents = new Map(
    Object.entries(options.live ?? {}).map(([sessionId, status]) => [sessionId, { id: sessionId, status }]),
  )
  let childCounter = 0
  return {
    calls,
    liveAgents,
    ctx: {
      subagents: {
        async startActivation(spec) {
          calls.startActivation.push(spec)
          childCounter += 1
          return { childId: options.childId ?? `fresh-${childCounter}`, messageId: `msg-${childCounter}` }
        },
        getProvider: (name) => (name === H_PROVIDER.name ? H_PROVIDER : undefined),
        list: () => [H_PROVIDER.name],
        interrupt() {},
        async drainChildren() {},
        async listChildren() {
          return []
        },
        [symbol]: async (parent, childId, content, source, signal, delivery) => {
          if (options.deliverFails !== undefined) throw options.deliverFails
          calls.delivered.push({ childId, delivery, text: content[0]?.text })
          return `msg-deliver-${calls.delivered.length}`
        },
      },
      agents: { get: (id) => liveAgents.get(id) },
      tools: {
        get: (name) => (H_REGISTERED_TOOLS.has(name) ? { name } : undefined),
        view: () => ({ restrictableNames: new Set(H_REGISTERED_TOOLS) }),
      },
      get: () => undefined,
    },
  }
}

const hCaptain = (ctx) => ({ id: 'captain-verify-h', options: { subagentDepth: 0 }, session: { header: {} }, ctx })
const hApplyOptions = (now = H_NOW) => ({ provider: 'spawn', signal: new AbortController().signal, now: () => now })
const DISPATCH_ACTIONS = new Set(['spawn', 'wake', 'rework'])
const dispatchingActions = (plan) =>
  plan.decisions.filter((decision) => DISPATCH_ACTIONS.has(decision.action)).map((decision) => decision.action)

await checkAsync('H1 a live executor is never re-dispatched and never reconciled', async () => {
  for (const mode of ['running', 'idle']) {
    const state = incidentState()
    const plan = R.planStageDispatch({
      state,
      now: H_NOW,
      attempts: [],
      ...executorProbes({ [H_DEAD_SESSION]: mode }),
    })
    assert.equal(plan.dispatches.length, 0, `${mode}: dispatched while the executor is live`)
    assert.equal(plan.decisions[0]?.action, 'wait', `${mode}: decision must be wait`)
    assert.equal(plan.reconcile.length, 0, `${mode}: a live member must not be reconciled`)
    assert.match(plan.decisions[0]?.reason ?? '', /不重复派发/, `${mode}: reason must state the no-duplicate rule`)
    if (mode === 'running') {
      assert.match(plan.decisions[0]?.reason ?? '', /正在运行/, 'running: reason must name the running state')
    }

    // With the open ledger attempt still in hand it must STILL wait, and applying
    // that plan must neither deliver nor spawn.
    const runtime = bareHost({ live: { [H_DEAD_SESSION]: mode } })
    const ledger = [
      { stageId: 'requirement', round: 0, role: 'pm', sessionId: H_DEAD_SESSION, dispatchedAt: H_NOW - 5_000, kind: 'initial' },
    ]
    const planned = R.planStageDispatch({ state, now: H_NOW, attempts: ledger, ...executorProbes({ [H_DEAD_SESSION]: mode }) })
    const outcome = await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, planned, hApplyOptions())
    assert.equal(planned.dispatches.length, 0, `${mode}+ledger: no dispatch`)
    assert.equal(runtime.calls.delivered.length, 0, `${mode}+ledger: nothing actually delivered`)
    assert.equal(runtime.calls.startActivation.length, 0, `${mode}+ledger: no spawn`)
    assert.equal(state.stages[0].attempts, 1, `${mode}+ledger: attempts unchanged`)
    assert.equal(outcome.reconciled.length, 0, `${mode}+ledger: no reconcile`)
  }
})

await checkAsync('H2 a gone executor is recovered exactly once with a fresh attempt, and converges', async () => {
  const state = incidentState()
  const runtime = bareHost()
  const plan = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(plan.known, true, 'the stage must be planned')
  assert.equal(plan.dispatches.length, 1, `exactly one recovery dispatch expected, got ${plan.dispatches.length}`)
  const decision = plan.dispatches[0] ?? {}
  assert.equal(decision.action, 'wake', 'recovery action')
  assert.equal(decision.role, 'pm', 'the stranded member is the target')
  assert.equal(decision.consumesAttempt, true, 'recovery must consume a fresh attempt')
  assert.equal(decision.recoveredFromStranded, true, 'recovery must be flagged, never silent')
  assert.match(decision.reason ?? '', /stranded/, 'reason must name the recovery')
  assert.match(decision.strandedEvidence ?? '', /ctx\.agents\.get/, 'evidence must quote the probe')
  assert.match(plan.summary ?? '', /stranded 恢复/, 'plan summary must report the recovery')

  const outcome = await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, plan, hApplyOptions())
  assert.equal(outcome.applied.length, 1, 'the recovery must be applied')
  assert.equal(outcome.failed.length, 0, `nothing may fail: ${JSON.stringify(outcome.failed)}`)
  assert.equal(runtime.calls.delivered.length, 1, 'a real turn must be delivered')
  assert.equal(runtime.calls.delivered[0]?.childId, H_DEAD_SESSION, 'delivered to the durable session (cold resume)')
  assert.equal(runtime.calls.delivered[0]?.delivery, 'queue', 'queued as its own turn')
  assert.equal(state.stages[0].attempts, 2, 'attempts must increment 1 → 2')
  assert.equal(state.stages[0].round, 0, 'round (gate rejections) must stay untouched')
  assert.equal(state.members[0].status, 'working', 'the member goes back to working honestly')
  assert.match(outcome.summary ?? '', /stranded 恢复/, 'outcome summary must report the recovery')
  assert.match(outcome.summary ?? '', /attempts \+1/, 'outcome summary must report the attempt cost')
  assert.match(runtime.calls.delivered[0]?.text ?? '', /阶段派发/, 'the delivery is a normal stage dispatch')

  // The in-process ledger may still hold the open attempt: still exactly ONE.
  const withLedger = incidentState()
  const ledgerRuntime = bareHost()
  const ledgerPlan = R.planStageDispatch({
    state: withLedger,
    now: H_NOW,
    attempts: [
      { stageId: 'requirement', round: 0, role: 'pm', sessionId: H_DEAD_SESSION, dispatchedAt: H_NOW - 60_000, kind: 'initial' },
    ],
    ...executorProbes({}),
  })
  assert.equal(ledgerPlan.dispatches.length, 1, 'an unsettled attempt + gone ⇒ exactly one recovery')
  assert.equal(ledgerPlan.dispatches[0]?.action, 'wake', 'recovery action with an open ledger attempt')
  assert.equal(ledgerPlan.dispatches[0]?.consumesAttempt, true, 'the recovery still costs a fresh attempt')
  await R.applyStageDispatch(ledgerRuntime.ctx, hCaptain(ledgerRuntime.ctx), withLedger, ledgerPlan, hApplyOptions())
  assert.equal(withLedger.stages[0].attempts, 2, 'attempts must increment with an open ledger attempt too')
})

check('H3 the executor verdict is three-state: live / gone / unknown', () => {
  const state = incidentState()
  const verdict = (inputs) => R.memberExecutorVerdict({ state, now: H_NOW, ...inputs }, H_DEAD_SESSION)
  assert.deepEqual(verdict(executorProbes({ [H_DEAD_SESSION]: 'running' })), { state: 'live', running: true }, 'a resident running agent is live/running')
  assert.deepEqual(verdict(executorProbes({ [H_DEAD_SESSION]: 'idle' })), { state: 'live', running: false }, 'a resident idle agent is live but not running')
  assert.deepEqual(verdict(executorProbes({})), { state: 'gone', running: false }, 'a probe that answers and finds nobody is gone')
  assert.deepEqual(verdict({}), { state: 'unknown', running: false }, 'no probe at all must read unknown — NOT gone')
  assert.equal(verdict({ isLive: () => true, isRunning: () => undefined }).running, false, 'an unanswerable running probe must not claim running')
  assert.deepEqual(verdict({ isLive: () => true, isRunning: () => false }), { state: 'live', running: false }, 'a live/idle probe set')
})

check('H4 an unavailable probe fails safe: wait inside the window, recover only past it', () => {
  const blind = R.planStageDispatch({ state: incidentState(), now: H_NOW, attempts: [] })
  assert.equal(blind.dispatches.length, 0, 'no probe ⇒ no recovery')
  assert.equal(blind.decisions[0]?.action, 'wait', 'no probe ⇒ wait')
  assert.match(blind.decisions[0]?.reason ?? '', /不可判定/, 'the reason must say the executor is undecidable')

  const staleLedger = [
    { stageId: 'requirement', round: 0, role: 'pm', sessionId: H_DEAD_SESSION, dispatchedAt: H_NOW - H_STALE - 60_000, kind: 'initial' },
  ]
  const stale = R.planStageDispatch({ state: incidentState(), now: H_NOW, attempts: staleLedger })
  assert.equal(stale.dispatches[0]?.action, 'wake', 'past the documented window the fallback recovers')
  assert.equal(stale.dispatches[0]?.consumesAttempt, true, 'the fallback recovery also consumes an attempt')
  assert.match(stale.dispatches[0]?.reason ?? '', /停滞阈值/, 'the reason must name the threshold')

  const freshLedger = [
    { stageId: 'requirement', round: 0, role: 'pm', sessionId: H_DEAD_SESSION, dispatchedAt: H_NOW - 5_000, kind: 'initial' },
  ]
  const fresh = R.planStageDispatch({ state: incidentState(), now: H_NOW, attempts: freshLedger })
  assert.equal(fresh.dispatches.length, 0, 'inside the window it must still wait')
  assert.match(fresh.decisions[0]?.reason ?? '', /未超时/, 'the reason must name the remaining window')

  const tuned = R.planStageDispatch({ state: incidentState(), now: H_NOW, attempts: freshLedger, staleAfterMs: 1_000 })
  assert.equal(tuned.dispatches[0]?.action, 'wake', 'the staleness window must be configurable')
  assert.equal(H_STALE, 30 * 60 * 1000, 'the default window must stay the documented 30 min')
})

await checkAsync('H5 a stale claimed status is reconciled to idle; a live member never is', async () => {
  // The rehearsed factory is parked on the checklist gate with lastGate.ok = true.
  const state = incidentState()
  hPatchStage(state, 'requirement', {
    status: 'gate',
    round: 0,
    attempts: 1,
    lastGate: { type: 'checklist', ok: true, detail: 'PRD.md 必备章节 3/3 齐全', at: H_NOW - 1000 },
  })
  const runtime = bareHost()
  const plan = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(plan.dispatches.length, 0, 'a stage awaiting a verdict dispatches nothing')
  assert.equal(plan.reconcile.length, 1, 'the stale member status must be scheduled for repair')
  assert.equal(plan.reconcile[0]?.role, 'pm', 'pm is the stale member')
  assert.equal(plan.reconcile[0]?.from, 'working', 'the repair records the previous status')
  assert.equal(plan.reconcile[0]?.to, 'idle', 'the repair target is idle')
  assert.match(plan.reconcile[0]?.reason ?? '', /执行者不在场/, 'the repair reason must quote the probe')
  assert.match(plan.summary ?? '', /状态收敛/, 'the plan summary must report the repair')
  assert.equal(plan.notes.some((note) => note.includes('factory_gate')), true, 'the note must still point at factory_gate')

  const outcome = await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, plan, hApplyOptions())
  assert.equal(outcome.reconciled.length, 1, 'the repair must be applied')
  assert.equal(state.members[0].status, 'idle', 'the durable status is idle again (no lie)')
  assert.equal(runtime.calls.delivered.length, 0, 'reconciliation must never message a member')
  assert.equal(runtime.calls.startActivation.length, 0, 'reconciliation must never spawn')
  assert.match(outcome.summary ?? '', /收敛/, 'the outcome summary must report the repair')
  assert.equal(state.stages[0].attempts, 1, 'reconciliation must not touch attempts')

  // A live member keeps its status.
  const livePlan = R.planStageDispatch({
    state: incidentState(),
    now: H_NOW,
    attempts: [],
    ...executorProbes({ [H_DEAD_SESSION]: 'idle' }),
  })
  assert.equal(livePlan.reconcile.length, 0, 'a live member must keep its working status')
})

check('H6 a member that already reported is not re-dispatched, but a rejected stage reopens', () => {
  const done = hPatchMember(incidentState(), 'pm', { status: 'done' })
  const donePlan = R.planStageDispatch({ state: done, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(donePlan.dispatches.length, 0, 'a done member must not be re-woken on the same stage')
  assert.equal(donePlan.decisions[0]?.action, 'wait', 'decision for a done member is wait')
  assert.match(donePlan.decisions[0]?.reason ?? '', /factory_gate/, 'the reason must point at the gate')
  assert.equal(donePlan.reconcile.length, 0, 'a done member must not be reconciled')

  const rejected = hPatchMember(incidentState(), 'pm', { status: 'done' })
  hPatchStage(rejected, 'requirement', { status: 'rejected', round: 1, attempts: 1 })
  const rejectedPlan = R.planStageDispatch({ state: rejected, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(rejectedPlan.dispatches[0]?.action, 'rework', 'a rejected stage still owes the rework')

  // A rejected stage recovers as a rework carrying the gate's own rejection list.
  const withGate = incidentState()
  hPatchStage(withGate, 'requirement', {
    status: 'rejected',
    round: 1,
    attempts: 1,
    lastGate: { type: 'checklist', ok: false, detail: 'PRD.md 缺 1/3 节: 非目标', at: H_NOW - 1000 },
  })
  const rework = R.planStageDispatch({ state: withGate, now: H_NOW, attempts: [], ...executorProbes({}) }).dispatches[0] ?? {}
  assert.equal(rework.action, 'rework', 'a rejected stage recovers as a rework')
  assert.equal(rework.rework?.round, 1, 'the rework round comes from the stage record')
  assert.deepEqual(rework.rework?.findings, ['PRD.md 缺 1/3 节: 非目标'], 'the gate detail becomes the finding')
  assert.equal(rework.consumesAttempt, true, 'the rework recovery consumes a fresh attempt')
})

await checkAsync('H7 an unresumable session is replaced; a transient failure is not', async () => {
  const notResumable = Object.assign(new Error(`subagent "${H_DEAD_SESSION}" is unavailable`), { code: 'NOT_RESUMABLE' })
  const state = incidentState()
  const runtime = bareHost({ deliverFails: notResumable })
  const plan = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
  const outcome = await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, plan, hApplyOptions())
  assert.equal(runtime.calls.delivered.length, 0, 'the dead delivery must not be repeated')
  assert.equal(runtime.calls.startActivation.length, 1, 'a fresh session must be created instead')
  assert.equal(outcome.applied.length, 1, 'the replacement counts as applied')
  assert.equal(outcome.applied[0]?.sessionReplaced, H_DEAD_SESSION, 'the replaced session id must be recorded')
  assert.equal(state.members[0].sessionId, 'fresh-1', 'the member must point at the fresh session')
  assert.equal(state.stages[0].attempts, 2, 'attempts must increment once')
  assert.match(outcome.summary ?? '', /替换不可恢复会话/, 'the outcome summary must report the replacement')

  // The same state with a stale session also needs the rework shape honoured; and
  // a temporary failure must keep the session and cost no attempt.
  const temporary = Object.assign(new Error('subagent/delivery-unavailable: inbox is busy'), { code: 'DELIVERY_UNAVAILABLE' })
  const state2 = incidentState()
  const runtime2 = bareHost({ deliverFails: temporary })
  const plan2 = R.planStageDispatch({ state: state2, now: H_NOW, attempts: [], ...executorProbes({}) })
  const outcome2 = await R.applyStageDispatch(runtime2.ctx, hCaptain(runtime2.ctx), state2, plan2, hApplyOptions())
  assert.equal(runtime2.calls.startActivation.length, 0, 'a temporary failure must NOT cost the session')
  assert.equal(state2.members[0].sessionId, H_DEAD_SESSION, 'the session must be kept')
  assert.equal(outcome2.failed.length, 1, 'the failure must be reported instead')
  assert.equal(state2.stages[0].attempts, 1, 'a failed dispatch consumes no attempt')

  assert.equal(
    R.isUnresumableDeliveryError('subagent "x" has no supported continuation state and cannot be resumed; choose a different target'),
    true,
    'phrase detection',
  )
  assert.equal(R.isUnresumableDeliveryError('subagent/not-resumable'), true, 'remote error code detection')
  assert.equal(R.isUnresumableDeliveryError('whatever', 'NOT_RESUMABLE'), true, 'SubagentError code detection')
  assert.equal(
    R.isUnresumableDeliveryError('subagent/delivery-unavailable: inbox is busy', 'DELIVERY_UNAVAILABLE'),
    false,
    'temporary failures must be excluded',
  )
  assert.equal(
    R.isUnresumableDeliveryError('message delivery requires the exact live sender agent', 'UNAUTHORIZED'),
    false,
    'authority failures must be excluded',
  )
})

await checkAsync('H8 once the executor is back the recovery stops (no thrash)', async () => {
  const state = incidentState()
  const runtime = bareHost()
  const first = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
  await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, first, hApplyOptions())
  assert.equal(state.stages[0].attempts, 2, 'the first recovery consumed an attempt')

  // The re-delivered turn woke the member: the runtime now holds a running agent.
  const second = R.planStageDispatch({
    state,
    now: H_NOW + 1_000,
    attempts: [
      { stageId: 'requirement', round: 0, role: 'pm', sessionId: H_DEAD_SESSION, dispatchedAt: H_NOW, kind: 'initial' },
    ],
    ...executorProbes({ [H_DEAD_SESSION]: 'running' }),
  })
  assert.equal(second.dispatches.length, 0, 'no second recovery while the member runs')
  assert.equal(second.decisions[0]?.action, 'wait', 'it must wait for the report instead')
  const outcome = await R.applyStageDispatch(runtime.ctx, hCaptain(runtime.ctx), state, second, hApplyOptions(H_NOW + 1_000))
  assert.equal(runtime.calls.delivered.length, 1, 'still exactly one delivery overall')
  assert.equal(state.stages[0].attempts, 2, 'attempts must not grow again')
  assert.equal(outcome.reconciled.length, 0, 'a running member keeps its working status')

  // Two live members on the planned stage: no duplicates either.
  const parallel = incidentState()
  hPatchMember(parallel, 'be_dev', { status: 'working', sessionId: H_LIVE_SESSION, currentStage: 'implement' })
  hPatchStage(parallel, 'requirement', { status: 'passed' })
  hPatchStage(parallel, 'implement', { status: 'active', attempts: 1 })
  const parallelPlan = R.planStageDispatch({
    state: parallel,
    now: H_NOW,
    attempts: [],
    ...executorProbes({ [H_DEAD_SESSION]: 'running', [H_LIVE_SESSION]: 'running' }),
  })
  assert.equal(parallelPlan.dispatches.length, 0, 'two live members ⇒ no dispatch')
  assert.equal(parallelPlan.reconcile.length, 0, 'live members are never reconciled')
  assert.equal(parallelPlan.round, 0, 'the plan round must stay 0 (attempts are not rounds)')
})

check('H9 escalation paths are unchanged by the recovery rules', () => {
  const blocked = hPatchMember(incidentState(), 'pm', { status: 'blocked' })
  const blockedPlan = R.planStageDispatch({ state: blocked, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(blockedPlan.escalate, true, 'a blocked member must escalate')
  assert.equal(blockedPlan.dispatches.length, 0, 'a blocked member must not be re-dispatched')

  const exhausted = incidentState()
  hPatchStage(exhausted, 'requirement', { status: 'rejected', round: 2, attempts: 2 })
  const exhaustedPlan = R.planStageDispatch({ state: exhausted, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(exhaustedPlan.escalate, true, 'rounds exhausted must escalate')
  assert.equal(exhaustedPlan.dispatches.length, 0, 'no automatic rework past maxRounds')
  assert.equal(exhaustedPlan.notes.some((note) => note.includes('轮次已用尽')), true, 'the note must explain the exhaustion')

  const unstaffable = incidentState({ members: [{ role: 'fe_dev', status: 'staged', tokens: 0 }] })
  const unstaffablePlan = R.planStageDispatch({ state: unstaffable, now: H_NOW, attempts: [], ...executorProbes({}), stageId: 'document' })
  assert.equal(unstaffablePlan.staffing.missing.length > 0, true, 'an unstaffable stage must report the missing role')
  assert.equal(unstaffablePlan.escalate, true, 'an unstaffable stage must escalate')
  assert.equal(unstaffablePlan.dispatches.length, 0, 'an unstaffable stage dispatches nothing')

  const removed = hPatchMember(incidentState(), 'pm', { status: 'removed' })
  const removedPlan = R.planStageDispatch({ state: removed, now: H_NOW, attempts: [], ...executorProbes({}) })
  assert.equal(removedPlan.decisions[0]?.action, 'skip', 'a removed member must be skipped')
  assert.equal(removedPlan.reconcile.length, 0, 'a removed member must not be reconciled')
})

await checkAsync('H10 a recovery\u2019s derived host work is detached from the factory lock', async () => {
  // The recovery path derives host work (a delivery, or a fresh child creation).
  // Awaited inside a held factory lock it would ride AsyncLocalStorage into the
  // member session, whose first factory mutation is then rejected as a lock
  // RE-ENTRY. The observable is the inherited held set (`isFactoryLockHeld`).
  const key = `${H_LOCK_PREFIX}recovery`
  const seen = { deliver: null, spawn: null, control: null }
  const lockHost = (options = {}) => {
    const symbol = Symbol.for('dsh.subagent.deliverPrompt')
    return {
      subagents: {
        async startActivation() {
          seen.spawn = { held: L.isFactoryLockHeld(key) }
          return { childId: 'fresh-lock-1', messageId: 'm-spawn' }
        },
        getProvider: () => H_PROVIDER,
        list: () => [H_PROVIDER.name],
        interrupt() {},
        async drainChildren() {},
        async listChildren() {
          return []
        },
        [symbol]: async () => {
          seen.deliver = { held: L.isFactoryLockHeld(key) }
          if (options.deliverThrows !== undefined) throw options.deliverThrows
          return 'm-deliver'
        },
      },
      agents: { get: () => undefined },
      tools: {
        get: (name) => (H_REGISTERED_TOOLS.has(name) ? { name } : undefined),
        view: () => ({ restrictableNames: new Set(H_REGISTERED_TOOLS) }),
      },
      get: () => undefined,
    }
  }

  {
    const state = incidentState()
    const ctx = lockHost()
    const plan = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
    await L.withFactoryLock(key, async () => {
      await R.applyStageDispatch(ctx, hCaptain(ctx), state, plan, hApplyOptions())
      assert.equal(L.isFactoryLockHeld(key), true, 'the caller must still hold the lock after apply')
    })
    assert.equal(state.stages[0].attempts, 2, 'the recovery dispatch must happen inside the lock window')
  }
  assert.equal(seen.deliver?.held, false, 'the delivery must run detached — the held set must not ride into the member session')

  {
    const state = incidentState()
    const notResumable = Object.assign(new Error(`subagent "${H_DEAD_SESSION}" is unavailable`), { code: 'NOT_RESUMABLE' })
    const ctx = lockHost({ deliverThrows: notResumable })
    const plan = R.planStageDispatch({ state, now: H_NOW, attempts: [], ...executorProbes({}) })
    await L.withFactoryLock(key, async () => {
      await R.applyStageDispatch(ctx, hCaptain(ctx), state, plan, hApplyOptions())
    })
    assert.equal(state.members[0].sessionId, 'fresh-lock-1', 'the replacement session must be created inside the lock window')
  }
  assert.equal(seen.spawn?.held, false, 'the child creation must run detached — its session must be able to mutate the factory')

  // Negative control: without the detach seam the derived call inherits the held key.
  await L.withFactoryLock(key, async () => {
    const inherited = L.isFactoryLockHeld(key)
    let outcome = 'accepted'
    try {
      await L.withFactoryLock(key, async () => 'accepted')
    } catch (error) {
      outcome =
        error instanceof L.FactoryLockReentryError || /reentry/i.test(String(error?.message))
          ? 'reentry-rejected'
          : `error:${error?.message}`
    }
    seen.control = { held: inherited, outcome }
  })
  assert.equal(seen.control?.held, true, 'control: an un-detached derivation sees the held key')
  assert.equal(seen.control?.outcome, 'reentry-rejected', 'control: its nested acquire is rejected as a re-entry')

  // Queue hygiene for this section's own prefix (F6 owns the F prefix).
  await LOCK_SLEEP(0)
  assert.deepEqual(
    L.factoryLockHeldKeys().filter((entry) => String(entry).startsWith(H_LOCK_PREFIX)),
    [],
    'a held key leaked out of the H section',
  )
  assert.deepEqual(
    L.factoryLockQueueStats().filter((entry) => entry.key.startsWith(H_LOCK_PREFIX)),
    [],
    `leaked lock queue entries: ${JSON.stringify(L.factoryLockQueueStats().filter((entry) => entry.key.startsWith(H_LOCK_PREFIX)))}`,
  )
  assert.deepEqual(
    L.factoryLockQueueKeys().filter((entry) => entry.key.startsWith(H_LOCK_PREFIX)),
    [],
    'a queue entry was never deleted',
  )
})

/* ----------------------- I. decision consistency & fake-host model (t25) ---- */

section('I planner decision consistency & the shipped fake-host model')

/*
 * Ported from the t25 offline harness (`.tmp-runtime-check/t25-planner-consistency.mjs`),
 * same drift reason as H.
 *
 * Two rules:
 *  - P: a plan that dispatches NOTHING must not contain a decision claiming it
 *    will (`be_dev→wake` beside `planned=0` was t23's observation 2). The
 *    suppressed intent survives in `parkedFrom`.
 *  - K: the fake-host model shipped in `runtime/testing.ts` must keep residency
 *    and durability apart — a hand-rolled host that answers a constant `undefined`
 *    fabricates a stranded recovery for a member that was just spawned.
 */
const I_NOW = 1791710000000
const I_DEAD = { isLive: () => false, isRunning: () => undefined }
const I_LIVE_RUNNING = { isLive: () => true, isRunning: () => true }
const I_LIVE_IDLE = { isLive: () => true, isRunning: () => false }

/** Lightweight pipeline: requirement(pm) → implement(be_dev) → … */
function pipelineState(overrides = {}) {
  const pipelineId = overrides.pipeline ?? 'lightweight'
  return {
    id: 't25fac01',
    name: '批量图片重命名脚本',
    brief: '写一个批量重命名图片文件的 Python 脚本，支持 dry-run。',
    taskType: 'script_tool',
    pipeline: pipelineId,
    captainSessionId: 'session-verify-i-captain',
    phase: 'running',
    securityTriggered: false,
    members: [
      { role: 'pm', status: 'working', tokens: 0, sessionId: 'pm-1', currentStage: 'requirement' },
      { role: 'be_dev', status: 'idle', tokens: 0, sessionId: 'be-1', currentStage: 'implement' },
      { role: 'reviewer', status: 'staged', tokens: 0 },
      { role: 'qa', status: 'staged', tokens: 0 },
      { role: 'devops', status: 'staged', tokens: 0 },
    ],
    stages: D.getPipeline(pipelineId).map((def) => ({
      id: def.id,
      status: def.id === 'requirement' ? 'active' : 'pending',
      round: 0,
      attempts: def.id === 'requirement' ? 1 : 0,
    })),
    dod: [],
    createdAt: I_NOW - 600_000,
    updatedAt: I_NOW - 60_000,
    approvedAt: I_NOW - 600_000,
    ...overrides,
  }
}

/** The active implement stage with an idle live be_dev — the P0 baseline shape. */
function implementBaseline() {
  const state = pipelineState()
  hPatchStage(state, 'requirement', { status: 'passed' })
  hPatchStage(state, 'implement', { status: 'active', attempts: 1 })
  return state
}

check('I1 an active stage with an idle live member really does dispatch (the park baseline)', () => {
  const plan = R.planStageDispatch({ state: implementBaseline(), now: I_NOW, attempts: [], ...I_LIVE_RUNNING })
  assert.equal(plan.stageId, 'implement', 'the implement stage must be the one planned')
  assert.equal(plan.dispatches.length >= 1, true, `an active stage must dispatch: ${JSON.stringify(dispatchingActions(plan))}`)
  assert.equal(dispatchingActions(plan).includes('wake'), true, 'the baseline decision is wake — this is the shape t23 saw')
  assert.equal(plan.decisions.every((decision) => decision.parkedFrom === undefined), true, 'nothing may be parked in the baseline')
  assert.equal(plan.escalate, false, 'the baseline must not escalate')
})

check('I2 a parked stage rewrites its dispatch as wait and keeps parkedFrom', () => {
  const state = implementBaseline()
  hPatchStage(state, 'implement', {
    status: 'gate',
    attempts: 1,
    lastGate: { type: 'keyword', ok: true, detail: 'REVIEW.md 结论: APPROVED', at: I_NOW - 1000 },
  })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], stageId: 'implement', ...I_LIVE_RUNNING })
  assert.equal(plan.dispatches.length, 0, 'planned=0 for a parked stage')
  assert.deepEqual(dispatchingActions(plan), [], 'no decision may claim it will dispatch')
  assert.equal(
    plan.decisions.every((decision) => decision.action === 'wait' || decision.action === 'skip'),
    true,
    `every decision must be wait/skip: ${JSON.stringify(plan.decisions.map((decision) => decision.action))}`,
  )
  const beDev = plan.decisions.find((decision) => decision.role === 'be_dev') ?? {}
  assert.equal(beDev.action, 'wait', 'the parked decision is wait')
  assert.equal(beDev.parkedFrom, 'wake', 'the suppressed intent must be preserved')
  assert.equal(beDev.consumesAttempt, false, 'a parked decision consumes no attempt')
  assert.match(beDev.reason ?? '', /factory_gate/, 'the reason must name the unblock action')
  // M15 — this check asserts BEHAVIOUR. It used to also match the Chinese copy of
  // the reason, the summary and the notes, which made a harmless reword (zero
  // behaviour change) turn several behavioural checks red, while a behaviour
  // regression that kept the wording stayed green. Structure is asserted here;
  // the wording is pinned exactly once, in I2b.
  assert.equal(
    beDev.reason.includes(String(beDev.parkedFrom)),
    true,
    'the reason must quote the action it suppressed, whatever the wording',
  )
  assert.equal(plan.escalate, false, 'a parked stage is not an escalation')
  assert.equal(plan.notes.some((note) => note.includes('factory_gate')), true, 'the plan notes must point at factory_gate')
  assert.equal(
    plan.notes.some((note) => note.includes(String(beDev.parkedFrom)) && note.includes(beDev.action)),
    true,
    `a note must record ${beDev.parkedFrom}→${beDev.action}: ${JSON.stringify(plan.notes)}`,
  )
  assert.equal(
    typeof plan.summary === 'string' && plan.summary.includes(beDev.action),
    true,
    `the summary must name the downgraded action (${beDev.action}): ${JSON.stringify(plan.summary)}`,
  )
  assert.equal(plan.reconcile.length, 0, 'nothing to reconcile (the member is live)')
})

/**
 * M15 — the human wording of the park-downgrade lives here, and only here.
 *
 * Everything a reader sees about this downgrade is a composed Chinese sentence.
 * Pinning it in the behavioural check (I2) coupled "did the planner behave" to
 * "did anyone reword the sentence"; pinning it nowhere let the prose rot. So: I2
 * asserts structure, this check asserts text, and a deliberate copy edit is
 * expected to break THIS check and nothing else.
 */
check('I2b the park-downgrade wording is pinned exactly once (copy-edit snapshot)', () => {
  const state = implementBaseline()
  hPatchStage(state, 'implement', {
    status: 'gate',
    attempts: 1,
    lastGate: { type: 'keyword', ok: true, detail: 'REVIEW.md 结论: APPROVED', at: I_NOW - 1000 },
  })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], stageId: 'implement', ...I_LIVE_RUNNING })
  const beDev = plan.decisions.find((decision) => decision.role === 'be_dev') ?? {}
  assert.match(beDev.reason ?? '', /被抑制的原判定「wake」/, 'the reason wording moved — update this snapshot deliberately')
  assert.match(beDev.reason ?? '', /唤醒它开始本阶段/, 'the surviving original reason moved')
  assert.equal(
    plan.notes.some((note) => note.includes('decision 语义已对齐') && note.includes('wake→wait')),
    true,
    `the downgrade note wording moved: ${JSON.stringify(plan.notes)}`,
  )
  assert.match(plan.summary ?? '', /等待门禁裁决/, 'the summary wording moved')
  assert.match(plan.summary ?? '', /降级为 wait/, 'the summary wording moved')
})

check('I3 the t23 observation verbatim: the stage tools-dev measured no longer reads wake', () => {
  const state = pipelineState()
  hPatchMember(state, 'be_dev', { status: 'idle', sessionId: 'be-1', currentStage: 'implement' })
  hPatchStage(state, 'requirement', { status: 'passed' })
  hPatchStage(state, 'implement', { status: 'gate', attempts: 1 })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], stageId: 'implement', ...I_LIVE_RUNNING })
  const beDev = plan.decisions.find((decision) => decision.role === 'be_dev')
  assert.equal(beDev?.action, 'wait', 'the stage tools-dev measured must now read wait')
  assert.equal(beDev?.parkedFrom, 'wake', '…and still shows what it would have done')
  assert.equal(plan.dispatches.length, 0, 'planned must stay 0')
  assert.equal(plan.stageId, 'implement', 'the plan still reports the stage it selected')
})

check('I4 a parked stage never contradicts escalate:false, even with a blocked member', () => {
  const state = pipelineState()
  hPatchMember(state, 'be_dev', { status: 'blocked', sessionId: 'be-1', currentStage: 'implement' })
  hPatchStage(state, 'requirement', { status: 'passed' })
  hPatchStage(state, 'implement', { status: 'gate', attempts: 1 })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], stageId: 'implement', ...I_LIVE_IDLE })
  assert.equal(plan.escalate, false, 'a parked stage never escalates')
  assert.equal(plan.decisions[0]?.action, 'wait', 'a blocked member must not be surfaced as an escalate decision')
  assert.equal(plan.decisions[0]?.parkedFrom, 'escalate', 'the escalate intent must be preserved')
  assert.match(plan.decisions[0]?.reason ?? '', /factory_gate/, 'the reason must still point at the gate')
  assert.match(plan.decisions[0]?.reason ?? '', /BLOCKED/, 'the blocking condition must stay readable')
  assert.deepEqual(dispatchingActions(plan), [], 'nothing may dispatch')
})

check('I5 escalation semantics: an exhausted round parks the rework, a plain block keeps escalate', () => {
  const exhausted = pipelineState()
  hPatchMember(exhausted, 'pm', { status: 'working', sessionId: 'pm-1', currentStage: 'requirement' })
  hPatchStage(exhausted, 'requirement', { status: 'rejected', round: 2, attempts: 2 })
  const plan = R.planStageDispatch({ state: exhausted, now: I_NOW, attempts: [], stageId: 'requirement', ...I_DEAD })
  assert.equal(plan.escalate, true, 'rounds exhausted still escalates')
  assert.equal(plan.dispatches.length, 0, 'nothing is dispatched while escalating')
  assert.deepEqual(dispatchingActions(plan), [], 'no dispatching decision survives an escalation')
  assert.equal(plan.decisions[0]?.action, 'wait', 'the would-be rework is parked as wait')
  assert.equal(plan.decisions[0]?.parkedFrom, 'rework', 'the suppressed rework intent must be kept')
  assert.match(plan.decisions[0]?.reason ?? '', /需要人工介入/, 'the reason must explain the suppression')

  const blocked = pipelineState()
  hPatchMember(blocked, 'be_dev', { status: 'blocked', sessionId: 'be-1', currentStage: 'implement' })
  hPatchStage(blocked, 'requirement', { status: 'passed' })
  hPatchStage(blocked, 'implement', { status: 'active', attempts: 1 })
  const blockedPlan = R.planStageDispatch({ state: blocked, now: I_NOW, attempts: [], stageId: 'implement', ...I_LIVE_IDLE })
  assert.equal(blockedPlan.escalate, true, 'a blocked member escalates when nothing is parked')
  assert.equal(blockedPlan.decisions[0]?.action, 'escalate', 'the escalate decision is kept (the plan says escalate too)')
  assert.equal(blockedPlan.dispatches.length, 0, 'planned=0 while escalating')
  assert.deepEqual(dispatchingActions(blockedPlan), [], 'no dispatching decision survives an escalation')
})

check('I6 breadth: every stage of every template parks with consistent decisions', () => {
  let checked = 0
  for (const pipelineId of D.PIPELINE_IDS) {
    for (const def of D.getPipeline(pipelineId)) {
      const state = pipelineState({ pipeline: pipelineId })
      for (const stage of state.stages) {
        if (stage.id === def.id) continue
        if (D.stageIndex(pipelineId, stage.id) < D.stageIndex(pipelineId, def.id)) stage.status = 'passed'
      }
      hPatchStage(state, def.id, { status: 'gate', attempts: 1 })
      const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], stageId: def.id, ...I_DEAD })
      assert.equal(plan.dispatches.length, 0, `${pipelineId}/${def.id}: planned=0`)
      assert.deepEqual(dispatchingActions(plan), [], `${pipelineId}/${def.id}: no dispatching decision`)
      assert.equal(plan.escalate, false, `${pipelineId}/${def.id}: no escalation`)
      assert.equal(
        plan.notes.some((note) => note.includes('factory_gate')),
        true,
        `${pipelineId}/${def.id}: notes must point at factory_gate`,
      )
      checked += 1
    }
  }
  // M17 — `>= 40` would have stayed green if a template lost three stages. The
  // sweep visits every stage of every template, so `checked` IS the repo's stage
  // total: both READMEs and the spec header document "43 stages", and check-docs
  // locks all three occurrences against lib/domain/pipeline.js.
  assert.equal(checked, 43, `swept ${checked} parked stage plans; the five templates declare 43 stages`)
  line(`  swept ${checked} parked stage plans across ${D.PIPELINE_IDS.length} templates`)
})

check('I7 parking does not break the stranded reconcile', () => {
  const state = pipelineState()
  hPatchStage(state, 'requirement', { status: 'gate', attempts: 1 })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], ...I_DEAD })
  assert.equal(plan.dispatches.length, 0, 'parked ⇒ planned=0')
  assert.equal(plan.decisions[0]?.action, 'wait', 'parked decision')
  assert.equal(plan.decisions[0]?.parkedFrom, 'wake', 'the suppressed recovery must be recorded')
  assert.equal(plan.reconcile.length, 1, 'the stale status must still be reconciled')
  assert.equal(plan.reconcile[0]?.from, 'working', 'reconcile keeps its own semantics')
})

await checkAsync('I8 the shipped fake-host model: residency, cold restart, cold resume, no thrash', async () => {
  const host = R.createFakeMemberHost()
  const started = await host.ctx.subagents.startActivation({
    provider: 'spawn',
    label: '产品经理@t25fac01',
    request: { prompt: [{ type: 'text', text: 'brief' }] },
    delivery: 'parent',
  })
  assert.equal(host.isResident(started.childId), true, 'startActivation must register the child (residency)')
  assert.equal(host.catalog.has(started.childId), true, '…and record a durable catalog row')
  assert.equal(host.probes.isLive(started.childId), true, 'the probe must report the fresh member live')
  assert.equal(host.probes.isRunning(started.childId), true, 'a freshly started child is running')
  assert.equal(host.calls.startActivation.length, 1, 'the start must be recorded')
  assert.match(host.calls.startActivation[0]?.promptText ?? '', /brief/, 'the initial prompt must be recorded for assertions')

  const strandedShape = (sessionId) => {
    const state = pipelineState()
    hPatchMember(state, 'pm', { status: 'working', sessionId, currentStage: 'requirement' })
    return state
  }
  const justSpawned = R.planStageDispatch({ state: strandedShape(started.childId), now: I_NOW, attempts: [], ...host.probes })
  assert.equal(justSpawned.dispatches.length, 0, 'a just-spawned member is NOT stranded')
  assert.equal(justSpawned.decisions[0]?.action, 'wait', 'the planner waits for its report')

  // Cold restart of ONE member: residency gone, durable session kept.
  host.killSession(started.childId)
  assert.equal(host.isResident(started.childId), false, 'residency is gone after the restart')
  assert.equal(host.catalog.has(started.childId), true, 'the durable session survives the restart')
  const coldState = strandedShape(started.childId)
  const coldPlan = R.planStageDispatch({ state: coldState, now: I_NOW, attempts: [], ...host.probes })
  assert.equal(coldPlan.dispatches.length, 1, 'a cold-restarted member IS stranded')
  assert.equal(coldPlan.dispatches[0]?.action, 'wake', 'the recovery action must be wake')
  assert.equal(coldPlan.dispatches[0]?.consumesAttempt, true, 'the recovery consumes a fresh attempt')
  const captainAgent = { id: 'captain-verify-i', options: { subagentDepth: 0 }, session: { header: {} }, ctx: host.ctx }
  const outcome = await R.applyStageDispatch(host.ctx, captainAgent, coldState, coldPlan, hApplyOptions(I_NOW))
  assert.equal(outcome.applied.length, 1, 'the recovery must be applied')
  assert.equal(coldState.stages[0].attempts, 2, 'attempts must increment 1 → 2')
  assert.equal(host.calls.delivered[0]?.childId, started.childId, 'delivered to the durable session (cold resume)')
  assert.equal(host.isResident(started.childId), true, 'the delivery must re-register it (cold resume modelled)')
  const afterResume = R.planStageDispatch({ state: coldState, now: I_NOW + 1000, attempts: [], ...host.probes })
  assert.equal(afterResume.dispatches.length, 0, 'once back, the planner waits again (no thrash)')

  // Drain releases residency but keeps the durable session.
  const drainedHost = R.createFakeMemberHost()
  const drainedStart = await drainedHost.ctx.subagents.startActivation({ provider: 'spawn', label: 'PM', request: {}, delivery: 'parent' })
  drainedHost.drainChild(drainedStart.childId)
  assert.equal(drainedHost.isResident(drainedStart.childId), false, 'a drained member must not be resident')
  assert.equal(drainedHost.catalog.has(drainedStart.childId), true, 'draining keeps the durable catalog row')
  const drainedPlan = R.planStageDispatch({ state: strandedShape(drainedStart.childId), now: I_NOW, attempts: [], ...drainedHost.probes })
  assert.equal(drainedPlan.dispatches.length, 1, 'a drained member is re-dispatchable (cold resume)')

  // A full host restart clears every Activation and keeps every session.
  const restartHost = R.createFakeMemberHost()
  const first = await restartHost.ctx.subagents.startActivation({ provider: 'spawn', label: 'A', request: {}, delivery: 'parent' })
  const second = await restartHost.ctx.subagents.startActivation({ provider: 'spawn', label: 'B', request: {}, delivery: 'parent' })
  assert.equal(restartHost.agents.size, 2, 'two members must be resident')
  restartHost.killAllSessions()
  assert.equal(restartHost.agents.size, 0, 'no residency survives a host restart')
  assert.equal(restartHost.catalog.size, 2, 'both durable sessions survive')
  assert.equal([first.childId, second.childId].every((id) => restartHost.catalog.has(id)), true, 'catalog rows are the durable truth')
})

check('I9 the anti-model: the probes the model exists to prevent, and the fail-safe they explain', () => {
  const state = pipelineState()
  hPatchMember(state, 'pm', { status: 'working', sessionId: 'spawned-1', currentStage: 'requirement' })
  const naive = R.planStageDispatch({ state, now: I_NOW, attempts: [], ...R.naiveProbes() })
  assert.equal(naive.dispatches.length, 1, 'the naive probe set fabricates a recovery for a just-spawned member')
  assert.equal(naive.dispatches[0]?.action, 'wake', '…as a wake')
  assert.equal(naive.dispatches[0]?.recoveredFromStranded, true, '…flagged as a stranded recovery')
  assert.equal(naive.dispatches[0]?.consumesAttempt, true, '…that would burn an attempt')
  assert.equal(R.createFakeMemberHost({ forgetEverySession: true }).probes.isLive('anything'), false, 'the option and the helper must agree')
  assert.equal(R.isFakeAgent({ id: 'x', status: 'running' }), true, 'the structural guard must recognise fake agents')
  assert.equal(R.isFakeAgent({ id: 'x' }), false, 'the guard must reject look-alikes')

  const registryLess = R.createFakeMemberHost({ withoutAgentRegistry: true })
  assert.equal(registryLess.ctx.agents, undefined, 'no agent registry at all')
  assert.equal(Object.keys(registryLess.probes).length, 0, 'no probes to spread')
  const blind = R.planStageDispatch({ state: pipelineState(), now: I_NOW, attempts: [], ...registryLess.probes })
  assert.equal(blind.dispatches.length, 0, 'without a probe the planner fails safe (wait)')
  assert.match(blind.decisions[0]?.reason ?? '', /不可判定/, 'the reason must name the missing probe')
})

await checkAsync('I10 the model drives failure injection and the tool registry', async () => {
  const failing = Object.assign(new Error('subagent "x" is unavailable'), { code: 'NOT_RESUMABLE' })
  const host = R.createFakeMemberHost({ deliveryError: failing })
  const state = pipelineState()
  hPatchMember(state, 'pm', { status: 'working', sessionId: 'dead-7', currentStage: 'requirement' })
  const plan = R.planStageDispatch({ state, now: I_NOW, attempts: [], ...I_DEAD })
  const captainAgent = { id: 'captain-verify-i', options: { subagentDepth: 0 }, session: { header: {} }, ctx: host.ctx }
  const outcome = await R.applyStageDispatch(host.ctx, captainAgent, state, plan, hApplyOptions(I_NOW))
  assert.equal(outcome.applied[0]?.sessionReplaced, 'dead-7', 'the model must drive the session-replacement path')
  assert.equal(host.calls.startActivation.length, 1, 'a replacement session must be created')

  const tools = R.createFakeMemberHost()
  assert.equal(tools.ctx.tools.get('factory_report')?.name, 'factory_report', 'member tools must be registered')
  assert.equal(tools.ctx.tools.view().restrictableNames.has('factory_gate'), true, 'the registry view lists captain tools')
  assert.equal(tools.ctx.tools.get('does_not_exist'), undefined, 'unknown names stay unknown')
  assert.equal(R.FAKE_HOST_DELIVER_SYMBOL_KEY, 'dsh.subagent.deliverPrompt', 'the documented symbol key must not move')
  assert.equal(Symbol.for(R.FAKE_HOST_DELIVER_SYMBOL_KEY), Symbol.for('dsh.subagent.deliverPrompt'), 'the key must be the global symbol the host installs')
})

/*
 * Tail guard: G runs before H/I, so the "nothing is still in flight" verdict has
 * to be re-measured after the last new async check — an un-awaited check added
 * below G would otherwise escape the summary (the F-section bug of t22).
 */
const tailFloating = inFlightChecks.size

check('I11 the tail is drained: no checkAsync(...) verdict can escape the summary', () => {
  assert.equal(
    tailFloating,
    0,
    `${tailFloating} async check(s) were still in flight past section I — await them, ` +
      'otherwise their verdict never reaches the exit code',
  )
})

/*
 * The census gate (H12). It has to run after the last `check(...)` registration
 * in the file, which is why it is here and not in section G.
 */
check('I12 the census has a floor (deleting assertions cannot read as green)', () => {
  assert.ok(census.length >= 60, `only ${census.length} checks were recorded, expected >= 60`)
  assert.ok(
    assertionTotal >= 1000,
    `only ${assertionTotal} assertions ran, expected >= 1000 — a shrink this large is a deletion, not a refactor`,
  )
  const sections = new Set(census.map((entry) => entry.section))
  for (const required of ['A ', 'B ', 'C ', 'D ', 'E ', 'F ', 'G ', 'H ', 'I ']) {
    assert.ok(
      [...sections].some((title) => title.startsWith(required)),
      `section ${required.trim()} recorded no checks at all`,
    )
  }
})

check('I13 no passing check is a no-op (every check contributed an assertion)', () => {
  const silent = census.filter((entry) => entry.assertions === 0)
  assert.deepEqual(
    silent.map((entry) => `[${entry.section}] ${entry.name}`),
    [],
    'these checks passed without asserting anything; a body that cannot fail is not coverage. ' +
      'If a check only proves "this call does not throw", say so explicitly in NO_ASSERT_CHECKS.',
  )
})

/* ------------------------------------------------- J actionable alerts (H10) */

/*
 * Why this section exists
 *
 * An `escalate` gate verdict and an `await_approval` human-approval stop used to
 * have **no consumer**: the only thing that ever read them was the model turn
 * that produced them, so a factory could park for as long as nobody happened to
 * open the panel, and a member that never acquired a session was visible only as
 * a `spawnError` field that nothing rendered.
 *
 * The host exposes no notification API, so the fix is `src/domain/alerts.ts`: a
 * list derived from the durable record on every read, impossible to dismiss, and
 * rendered as a banner. This section pins the derivation, because an alerting
 * channel that silently stops alerting is worse than none - the reader learns to
 * trust a quiet board.
 *
 * `deriveAlerts` is pure, so everything here is synchronous and offline.
 */

section('J actionable alerts derived from the record')

const alertRoot = await mkdtemp(join(tmpdir(), 'code-factory-alerts-'))
let alertBase
let alertPersisted = ''
try {
  const alertStore = new S.FactoryStore({ workspace: alertRoot, stateDir: '.code-factory' })
  const decision = D.assembleTeam(FAMILY_BRIEFS.web_fullstack, D.DEFAULT_MAX_MEMBERS)
  alertBase = await alertStore.create({
    brief: FAMILY_BRIEFS.web_fullstack,
    taskType: decision.taskType,
    pipeline: decision.pipeline,
    captainSessionId: 'session-verify-alerts',
    securityTriggered: decision.securityTriggered,
    members: decision.team,
    stages: D.stageIds(decision.pipeline),
  })
  alertPersisted = readFileSync(join(alertStore.root, alertBase.id, 'factory.json'), 'utf8')
} finally {
  await rm(alertRoot, { recursive: true, force: true })
}

/** The fixture with a top-level patch applied. */
const alertState = (patch) => ({ ...alertBase, ...patch })
/** The fixture with one stage patched by id. */
const alertStage = (state, stageId, patch) => ({
  ...state,
  stages: state.stages.map((stage) => (stage.id === stageId ? { ...stage, ...patch } : stage)),
})
/** The fixture with one member patched by role. */
const alertMember = (state, role, patch) => ({
  ...state,
  members: state.members.map((member) => (member.role === role ? { ...member, ...patch } : member)),
})
const idsOf = (alerts) => alerts.map((alert) => alert.id)

check('J0 the fixture offers both a human-approval stage and a plain one (J6 must not be vacuous)', () => {
  const human = alertBase.stages.filter((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval === true)
  const plain = alertBase.stages.filter((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval !== true)
  assert.equal(human.length >= 1, true, 'the fullstack template has no humanApproval stage: J6 would prove nothing')
  assert.equal(plain.length >= 1, true, 'every fullstack stage needs human approval: J6 has no contrast')
  assert.equal(alertBase.phase, 'staged', 'the fixture must start staged')
  assert.equal(alertBase.members.length > 0, true, 'the fixture has no members')
})

check('J1 a terminal factory is silent (an alert nobody can act on trains the reader to ignore the banner)', () => {
  assert.deepEqual(D.deriveAlerts(alertState({ phase: 'delivered' })), [])
  assert.deepEqual(D.deriveAlerts(alertState({ phase: 'discarded' })), [])
})

check('J2 a halted factory is an action alert, and it says how to get out', () => {
  const alerts = D.deriveAlerts(alertState({ phase: 'halted' }))
  const halted = alerts.find((alert) => alert.kind === 'halted')
  assert.ok(halted, `no halted alert: ${JSON.stringify(idsOf(alerts))}`)
  assert.equal(halted.severity, 'action', 'a halt waits for a person, so it is an action, not attention')
  assert.match(halted.next ?? '', /factory_resume/, 'the alert must name the way out')
})

check('J3 a staged factory is waiting on the USER, and the alert names the one move that helps', () => {
  const alerts = D.deriveAlerts(alertBase)
  assert.equal(alerts.length, 1, `a fresh staged factory should raise exactly one alert, saw ${JSON.stringify(idsOf(alerts))}`)
  const staged = alerts[0]
  assert.equal(staged.kind, 'awaiting-plan-review')
  assert.equal(staged.severity, 'action')
  assert.match(staged.next ?? '', /factory_approve/)
  assert.match(staged.id, /^awaiting-plan-review:/, 'the id must encode the plan-review state so a state change re-keys it')
})

check('J4 an exhausted round is the loudest thing on the board (it is the escalate condition)', () => {
  const target = alertBase.stages[0].id
  const maxRounds = D.getStage(alertBase.pipeline, target)?.maxRounds
  assert.equal(typeof maxRounds, 'number', 'the first stage must declare maxRounds for this check to mean anything')
  const state = alertStage(alertState({ phase: 'running' }), target, { round: maxRounds, status: 'gate' })
  const alerts = D.deriveAlerts(state)
  const exhausted = alerts.find((alert) => alert.kind === 'rounds-exhausted')
  assert.ok(exhausted, `no rounds-exhausted alert: ${JSON.stringify(idsOf(alerts))}`)
  assert.equal(exhausted.severity, 'action')
  assert.equal(exhausted.stage, target)
  assert.match(exhausted.detail, new RegExp(`${maxRounds}/${maxRounds}`))
  // A passed stage at the same round is history, not an escalation.
  const passed = alertStage(state, target, { status: 'passed' })
  assert.equal(D.deriveAlerts(passed).some((alert) => alert.kind === 'rounds-exhausted'), false)
})

check('J5 a rejected stage carries the gate own detail, not a paraphrase', () => {
  const target = alertBase.stages[0].id
  const detail = 'TEST_REPORT.md 未列出 pytest 退出码；SEC_PASS 缺失。'
  const state = alertStage(alertState({ phase: 'running' }), target, {
    status: 'rejected',
    lastGate: { type: 'script', detail, at: 1_700_000_000_000 },
  })
  const rejected = D.deriveAlerts(state).find((alert) => alert.kind === 'stage-rejected')
  assert.ok(rejected, 'a rejected stage must alert')
  assert.equal(rejected.severity, 'action')
  assert.equal(rejected.detail, `门禁（script）打回：${detail}`, 'the gate wording must survive verbatim')
  assert.match(rejected.next ?? '', /findings/)
})

check('J6 a human-approval stop is an action; a plain gate is only attention', () => {
  const human = alertBase.stages.find((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval === true).id
  const plain = alertBase.stages.find((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval !== true).id

  const parked = alertStage(alertState({ phase: 'running' }), human, { status: 'gate' })
  const approval = D.deriveAlerts(parked).find((alert) => alert.stage === human)
  assert.ok(approval, 'a parked humanApproval stage must alert')
  assert.equal(approval.severity, 'action', 'a human approval stop waits for a person')
  assert.match(approval.title, /人工审批点/)
  assert.match(approval.next ?? '', /humanConfirm/)

  const gated = alertStage(alertState({ phase: 'running' }), plain, { status: 'gate' })
  const pending = D.deriveAlerts(gated).find((alert) => alert.stage === plain)
  assert.ok(pending, 'a parked plain stage must still be visible')
  assert.equal(pending.severity, 'attention', 'the captain agent, not the user, unblocks a plain gate')
  assert.equal(pending.kind, 'awaiting-approval')
})

check('J7 a member that never started, and a member that reported BLOCKED, are both reported', () => {
  const role = alertBase.members[0].role
  const other = alertBase.members[1]?.role ?? role

  const errored = D.deriveAlerts(
    alertMember(alertState({ phase: 'running' }), role, { spawnError: 'subagent "x" is unavailable' }),
  ).find((alert) => alert.kind === 'member-error')
  assert.ok(errored, 'a spawnError must be loud: it is the only trace of a member that never existed')
  assert.equal(errored.severity, 'action')
  assert.equal(errored.role, role)
  assert.equal(errored.detail, 'subagent "x" is unavailable', 'the raw error must be shown, not summarised')

  const blocked = D.deriveAlerts(
    alertMember(alertState({ phase: 'running' }), other, { status: 'blocked', currentStage: alertBase.stages[0].id }),
  ).find((alert) => alert.kind === 'member-blocked')
  assert.ok(blocked, 'a BLOCKED member must be loud: the scheduler will not hand it work again')
  assert.equal(blocked.role, other)
  assert.match(blocked.detail, new RegExp(alertBase.stages[0].id))

  // A member with a spawn error is reported once, not twice.
  const both = D.deriveAlerts(
    alertMember(alertState({ phase: 'running' }), role, { status: 'blocked', spawnError: 'boom' }),
  )
  assert.equal(both.filter((alert) => alert.role === role).length, 1, 'a member must not be double-reported')
})

check('J8 ordering: every action precedes every attention, it is stable, and the ids are unique', () => {
  const human = alertBase.stages.find((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval === true).id
  const plain = alertBase.stages.find((stage) => D.getStage(alertBase.pipeline, stage.id)?.humanApproval !== true).id
  let state = alertStage(alertState({ phase: 'running' }), human, { status: 'gate' })
  state = alertStage(state, plain, { status: 'gate' })
  state = alertMember(state, alertBase.members[0].role, { status: 'blocked' })

  const alerts = D.deriveAlerts(state)
  assert.equal(alerts.some((alert) => alert.severity === 'attention'), true, 'the fixture must contain an attention alert')
  assert.equal(alerts.some((alert) => alert.severity === 'action'), true, 'the fixture must contain an action alert')
  const firstAttention = alerts.findIndex((alert) => alert.severity === 'attention')
  const lastAction = alerts.map((alert) => alert.severity).lastIndexOf('action')
  assert.equal(lastAction < firstAttention, true, `actions are not grouped first: ${JSON.stringify(alerts.map((a) => a.severity))}`)
  assert.equal(alerts[0].severity, 'action', 'taking [0] must yield the most urgent item')

  const ids = idsOf(alerts)
  assert.equal(new Set(ids).size, ids.length, `alert ids are not unique: ${JSON.stringify(ids)}`)
  assert.deepEqual(D.deriveAlerts(state), alerts, 'deriveAlerts is not deterministic')
  assert.deepEqual(Object.keys(alerts[0]).includes('severity'), true, 'severity is the sort key and must be present')
})

check('J9 alerts are DERIVED, never stored (no `alerts` key ever reaches factory.json)', () => {
  const parsed = JSON.parse(alertPersisted)
  assert.equal('alerts' in parsed, false, 'alerts must not be persisted: a stored copy can fall out of sync')
  assert.equal('alerts' in alertBase, false, 'the in-memory record must not carry alerts either')
  const shaped = D.deriveAlerts(alertBase)[0]
  assert.deepEqual(
    Object.keys(shaped),
    ['id', 'kind', 'severity', 'title', 'detail', 'next'],
    'every alert must carry the same six fields: the renderer reads all of them',
  )
  assert.equal(typeof shaped.title, 'string', 'the title is what the banner shows')
  assert.equal(shaped.title.length > 0, true)
  assert.equal(shaped.detail.length > 0, true)
  assert.equal(shaped.next.length > 0, true)
})

/* ------------------------------------------------- K member.tokens is REAL */

// M22 — this banner used to be the only thing separating the token checks from
// section J, so `section()` was never called and every K verdict was counted
// under J while the summary line claimed a K that did not exist. A label the
// harness never emits is a label nobody can trust; declaring the section makes
// the census, the section list and the summary agree with the code.
section('K the member token reading is real (sessionQuery → member.tokens)')

/*
 * Why this section exists
 *
 * `MemberRecord.tokens` used to be a field nothing ever wrote. `src/store/store.ts`
 * created every member with `tokens: 0`, `freshMemberRecords` did the same, and no
 * code path ever changed it — so the cockpit header's TOKENS counter was a constant
 * zero dressed up as a measurement, and `totalTokens` summed a row of fake zeros.
 * The engineering review recorded exactly that as the one named gap on the
 * completeness axis ("`member.tokens` 永远为 0").
 *
 * The number is now derived from the real session log. The host exposes
 * `ctx.get("sessionQuery")`; `readSession(sessionId)` returns the full
 * `SessionEvent[]`, and `assistant/message` is the event that carries
 * `usage?: TokenUsage`. (`listEvents` does NOT work here: `SessionEventRecord` is
 * `{sessionId, seq, type, time, surface}` — no `data`, so no usage.)
 *
 * What is gated here: the DERIVATION — the arithmetic, the inheritance boundary,
 * the dirty-data handling, and the fact that "cannot read" is distinguishable from
 * "read it, nothing burned". K5 is a source audit of the edge (that the two member
 * entry points actually write the result), because driving that end to end needs a
 * live host session and a fake one would only prove the fake.
 */

const K_ASSISTANT = 'assistant/message'
const kEvent = (type, usage) => ({
  type,
  seq: 0,
  time: 0,
  data: usage === undefined ? { turn: 0, step: 0 } : { turn: 0, step: 0, usage },
})
const kCtx = (snapshot) => ({
  get: (key) => (key === 'sessionQuery' ? { readSession: async () => snapshot } : undefined),
})

const kNoService = await R.measureMemberTokens({ get: () => undefined }, 'sess-1')
const kEmptyId = await R.measureMemberTokens(kCtx({ events: [] }), '')
const kSum = await R.measureMemberTokens(
  kCtx({
    inheritedEventCount: 1,
    events: [
      kEvent(K_ASSISTANT, { inputTokens: 999, outputTokens: 999, totalTokens: 1998 }),
      kEvent('user/message'),
      kEvent(K_ASSISTANT, { inputTokens: 100, outputTokens: 20 }),
      kEvent('tool/call'),
      kEvent(K_ASSISTANT, { inputTokens: 7, outputTokens: 3, totalTokens: 50 }),
      kEvent(K_ASSISTANT, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 1000 }),
      kEvent(K_ASSISTANT),
    ],
  }),
  'sess-1',
)
const kZeroUsage = await R.measureMemberTokens(
  kCtx({ events: [kEvent('user/message'), kEvent(K_ASSISTANT)] }),
  's',
)
const kDirty = await R.measureMemberTokens(
  kCtx({
    events: [
      kEvent(K_ASSISTANT, { totalTokens: Number.NaN, inputTokens: -5, outputTokens: 42 }),
      kEvent(K_ASSISTANT, { totalTokens: 'x' }),
    ],
  }),
  's',
)
let kPropagated = false
const kThrowing = await R.measureMemberTokens(
  {
    get: () => ({
      readSession: async () => {
        throw new Error('EIO')
      },
    }),
  },
  's',
).catch(() => {
  kPropagated = true
  return 'threw'
})
const kNoEvents = await R.measureMemberTokens(kCtx({}), 's')
const kNullEvents = await R.measureMemberTokens(kCtx({ events: null }), 's')
const kOverflow = await R.measureMemberTokens(
  kCtx({ inheritedEventCount: 999, events: [kEvent(K_ASSISTANT, { totalTokens: 5 })] }),
  's',
)

check('K1 the token source names WHICH failure it hit, never a bare "no number"', () => {
  const absent = R.probeTokenSource(undefined)
  assert.equal(absent.status, 'absent', 'no plugin context at all is "absent"')
  assert.match(absent.reason, /sessionQuery/, 'the reason must name the missing service')

  assert.equal(
    R.probeTokenSource({ get: () => undefined }).status,
    'absent',
    'a composition without the service is "absent"',
  )

  const unusable = R.probeTokenSource({ get: () => ({ listEvents() {} }) })
  assert.equal(unusable.status, 'unusable', 'present-but-wrong-shape must NOT read as "absent"')
  assert.match(unusable.reason, /readSession/, 'and it must name the method it wanted')

  assert.equal(
    R.probeTokenSource({ get: () => ({ readSession: async () => ({ events: [] }) }) }).status,
    'available',
    'the documented shape must read as available',
  )

  const throwing = R.probeTokenSource({
    get: () => {
      throw new Error('boom')
    },
  })
  assert.equal(throwing.status, 'absent', 'a ctx.get that throws must not propagate')
  assert.match(throwing.reason, /boom/, 'and the cause must survive into the reason')
})

check('K2 nobody burned anything is DIFFERENT from nothing could be read', () => {
  assert.equal(kNoService, undefined, 'with no service the caller keeps the old value — not 0')
  assert.equal(kEmptyId, undefined, 'a blank session id is not a measurement')
  assert.equal(kZeroUsage, undefined, 'a log with no usage is "not measured", not "measured 0"')
  assert.equal(kNoEvents, undefined, 'a snapshot without events is "not measured"')
  assert.equal(kNullEvents, undefined, 'a null events array is "not measured"')
  assert.equal(kPropagated, false, 'a failing readSession must not reject into factory_report')
  assert.equal(kThrowing, undefined, 'a failing readSession yields "not measured"')
})

check('K3 the sum is this session\'s own burn: inheritance skipped, totalTokens preferred', () => {
  assert.equal(kSum.total, 50 + 120 + 10, 'expected totalTokens-wins-then-input+output over 3 messages')
  assert.equal(kSum.messages, 3, 'only assistant/message events that actually carry usage count')
  assert.equal(kSum.inherited, 1, 'the inherited prefix length must be reported, not guessed')
  assert.equal(
    kSum.total,
    180,
    'the inherited assistant/message (totalTokens 1998) must NOT be billed to this member',
  )
})

check('K4 dirty usage degrades to a finite number instead of poisoning the sum', () => {
  assert.equal(kDirty.total, 42, 'NaN and string totals fall back to input+output; negatives count as 0')
  assert.equal(Number.isFinite(kDirty.total), true, 'a NaN total would poison every later addition')
  assert.equal(kOverflow, undefined, 'an inheritedEventCount past the end skips everything and does not throw')
})

check('K5 the member entry points really write the reading onto the record', () => {
  const membersSrc = readFileSync(join(repoRoot, 'src', 'tools', 'engine', 'members.ts'), 'utf8')
  const calls = membersSrc.match(/measureMemberTokens\(call\.plugin, call\.callerId\)/gu) ?? []
  const writes = membersSrc.match(/if \(tokens !== undefined\) member\.tokens = tokens\.total/gu) ?? []
  assert.equal(calls.length, 2, 'both factory_report and factory_block must measure (found ' + calls.length + ')')
  assert.equal(writes.length, 2, 'and both must persist the result (found ' + writes.length + ')')
  const barrel = readFileSync(join(repoRoot, 'src', 'runtime', 'index.ts'), 'utf8')
  assert.match(barrel, /export \* from '\.\/tokens\.js'/u, 'the runtime barrel must export the module')
})

/* ---------------------------------------------------------- census report */

/**
 * `--census` prints the per-check assertion tally. Diagnostic, not a gate: the
 * gate is section G, which fails on a passing check that asserted nothing.
 */
if (process.argv.includes('--census')) {
  const bySection = new Map()
  for (const entry of census) {
    const bucket = bySection.get(entry.section) ?? { checks: 0, assertions: 0, empty: [] }
    bucket.checks += 1
    bucket.assertions += entry.assertions
    if (entry.assertions === 0) bucket.empty.push(entry.name)
    bySection.set(entry.section, bucket)
  }
  line('\n--- assertion census ---')
  for (const [title, bucket] of bySection) {
    line(
      `  ${title}: ${bucket.checks} checks / ${bucket.assertions} assertions` +
        (bucket.empty.length > 0 ? `  <-- ${bucket.empty.length} with ZERO assertions` : ''),
    )
    for (const name of bucket.empty) line(`        · ${name}`)
  }
  line(`  TOTAL: ${census.length} checks / ${assertionTotal} assertions`)
}

/* ------------------------------------------------------------------ summary */

/**
 * M21 — "all green" is only an anchor if you can name the tree it describes.
 * The review's complaint was that the passing run belonged to an uncommitted
 * working tree, so there was no green commit to bisect towards. So print the
 * commit, and when the tree is dirty say so out loud: a green run on
 * `abc1234 (DIRTY)` is a strictly weaker claim than a green run on `abc1234`,
 * and the reader deserves to know which one they are holding.
 */
function describeTree() {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    if (result.error !== undefined || result.status !== 0) return undefined
    return String(result.stdout ?? '').trim()
  }
  const head = git(['rev-parse', '--short', 'HEAD'])
  if (head === undefined || head === '') {
    return 'commit: unknown — no git here, so this run cannot be tied to a revision'
  }
  const status = git(['status', '--porcelain'])
  if (status === undefined) return `commit: ${head} (working-tree state unknown)`
  return status === ''
    ? `commit: ${head} (clean)`
    : `commit: ${head} (DIRTY — this run describes the working tree, not the commit)`
}

line(`\n${'-'.repeat(66)}`)
if (stats.failed === 0) {
  line(`SUCCESS: ${stats.passed}/${stats.ran} checks passed - L1 offline verification green`)
  line('sections: A routing | B pipeline | C gates | D DoD | E store | F lock detach & serialisation')
  line('          G harness self-check | H stranded recovery & executor verdict | I planner decisions & fake-host model')
  line('          J actionable alerts derived from the record | K the member token reading is real')
  line(`subject: ${rel(LIBS[0][1])} + ${rel(LIBS[1][1])} + ${rel(LIBS[2][1])} + ${rel(LIBS[3][1])}`)
  line(describeTree())
  process.exit(0)
}

line(`FAILURE: ${stats.failed}/${stats.ran} checks failed`)
line(describeTree())
for (const failure of failures) {
  line(`  - [${failure.section}] ${failure.name}`)
  line(`      ${oneLine(failure.error && failure.error.message)}`)
}
line('\nFirst failure, full stack:')
line(String((failures[0].error && failures[0].error.stack) || failures[0].error))
process.exit(1)
