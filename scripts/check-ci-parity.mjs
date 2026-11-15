#!/usr/bin/env node
/**
 * check-ci-parity — the one-command chain and the CI workflow must not drift.
 *
 * WHY THIS EXISTS
 * ---------------
 * `package.json` `release:check` is the *claim*: running that one command is what
 * "green" means. `.github/workflows/ci.yml` is the *enforcement*: it is what
 * actually runs on a machine that is not the author's. Nothing tied them
 * together. The workflow's header comment asserted "every command in
 * `release:check` IS here, in the same order" — and when this gate was written
 * that sentence was false: the two changelog gates ran before the two self-tests
 * in CI and after them in the chain, and `check:changelog` / `check:changelog:self`
 * / `backup:drill` had at one point lived only in `.githooks/`, which any
 * contributor can skip with `git commit --no-verify`.
 *
 * A comment cannot fail a build. So the claim is a check now, and it fails when
 * a gate is added to one place and forgotten in the other — which is exactly how
 * the drift happened the first time.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. every command in the `release:check` chain also runs in CI;
 *   2. they run in the SAME relative order (so the two lists read the same way);
 *   3. any extra CI step is declared in CI_ONLY below, with a reason — an
 *      undeclared extra is a silent divergence in the other direction.
 *
 * WHAT IT DOES NOT ASSERT
 * -----------------------
 * That CI's steps have the same *names*, env, matrix or conditions as the chain,
 * or that a command's own behaviour is the same in both places. It compares the
 * command sequence and nothing else.
 *
 * No YAML dependency: the workflow is read line-wise for `- name:` / `run:`
 * pairs, which is the shape this file uses. If it finds no steps at all it FAILS
 * rather than passing vacuously — a parser that silently reads nothing would
 * turn every run green, which is the failure mode this whole repo guards against.
 *
 *   node scripts/check-ci-parity.mjs              # the real repo
 *   node scripts/check-ci-parity.mjs --selftest   # proves each rule can fail
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Steps CI runs that are deliberately not part of the `release:check` chain. */
const CI_ONLY = {
  install: 'dependency install is a precondition of every gate, not a gate',
}

/* ------------------------------------------------------------------ parsing */

/**
 * Normalise a `run:` line to the script name it invokes.
 *
 * `pnpm run drill:engine`, `pnpm drill:engine` and `pnpm run  drill:engine` are
 * the same command; `pnpm install --frozen-lockfile` is `install` (arguments are
 * dropped because the chain's scripts carry their own flags).
 */
export function commandOf(runLine) {
  const text = String(runLine).trim().replace(/\\$/, '').trim()
  const match = /^pnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/.exec(text)
  return match ? match[1] : null
}

/**
 * Extract `{ name, command }` for every step in a workflow, in file order.
 * `command` is null for a step that runs something other than a pnpm script.
 */
export function parseCiSteps(yamlText) {
  const steps = []
  const lines = String(yamlText).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const named = /^(\s*)- name:\s*(.+?)\s*$/.exec(lines[index])
    if (!named) continue
    const indent = named[1].length
    // The step's own keys sit at indent+2; stop at the next `- ` at our level.
    let run = null
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const line = lines[probe]
      if (/^\s*-\s/.test(line) && line.search(/\S/) <= indent) break
      const runLine = /^\s*run:\s*(.*)$/.exec(line)
      if (runLine) {
        run = runLine[1]
        break
      }
    }
    steps.push({ name: named[2], command: run === null ? null : commandOf(run) })
  }
  return steps
}

/** The `release:check` chain, as an ordered list of script names. */
export function releaseChain(packageJson) {
  const chain = packageJson?.scripts?.['release:check']
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new Error('package.json has no `release:check` script to compare against')
  }
  return chain
    .split('&&')
    .map((part) => commandOf(part))
    .filter((name) => name !== null)
}

/* -------------------------------------------------------------------- rules */

/**
 * @returns {{missing: string[], outOfOrder: string[], undeclared: string[], compared: number}}
 */
export function compareChainToCi(chain, steps, ciOnly = CI_ONLY) {
  const ciCommands = steps.map((step) => step.command).filter((name) => name !== null)

  const missing = chain.filter((name) => !ciCommands.includes(name))

  // Relative order: the subsequence of ciCommands that the chain also mentions
  // must equal the chain. Any command the chain does not mention is ignored here
  // (rule 3 owns those).
  const chainSet = new Set(chain)
  const overlap = ciCommands.filter((name) => chainSet.has(name))
  const outOfOrder = []
  for (let index = 0; index < overlap.length; index += 1) {
    if (overlap[index] !== chain[index]) {
      outOfOrder.push(`position ${index + 1}: the chain runs \`${chain[index]}\`, CI runs \`${overlap[index]}\``)
      break
    }
  }

  const undeclared = ciCommands.filter(
    (name) => !chainSet.has(name) && !Object.prototype.hasOwnProperty.call(ciOnly, name),
  )

  return { missing, outOfOrder, undeclared, compared: chain.length }
}

/* ---------------------------------------------------------------- reporting */

function report(result) {
  const lines = []
  if (result.missing.length > 0) {
    lines.push(`  [FAIL] ${result.missing.length} command(s) in release:check never run in CI`)
    for (const name of result.missing) lines.push(`         \`${name}\` — add it to .github/workflows/ci.yml`)
  } else {
    lines.push(`  [ ok ] every release:check command runs in CI (${result.compared} compared)`)
  }

  if (result.outOfOrder.length > 0) {
    lines.push('  [FAIL] the two lists disagree on order')
    for (const detail of result.outOfOrder) lines.push(`         ${detail}`)
  } else {
    lines.push('  [ ok ] the two lists agree on order')
  }

  if (result.undeclared.length > 0) {
    lines.push(`  [FAIL] ${result.undeclared.length} CI step(s) are not in the chain and not declared`)
    for (const name of result.undeclared) lines.push(`         \`${name}\` — add it to the chain, or to CI_ONLY with a reason`)
  } else {
    lines.push('  [ ok ] every extra CI step is declared in CI_ONLY')
  }
  return lines
}

function healthy(result) {
  return result.missing.length === 0 && result.outOfOrder.length === 0 && result.undeclared.length === 0
}

/* ------------------------------------------------------------------- selftest */

const FIXTURE_CHAIN = ['alpha', 'beta', 'gamma']
const FIXTURE_STEPS = (commands) =>
  commands
    .map((command) => `      - name: step ${command}\n        run: pnpm run ${command}`)
    .join('\n')

function selftest() {
  const cases = []
  const expect = (label, ok, detail) => cases.push({ label, ok, detail })

  const run = (commands) => compareChainToCi(FIXTURE_CHAIN, parseCiSteps(FIXTURE_STEPS(commands)))

  const baseline = run(['alpha', 'beta', 'gamma'])
  expect('identical lists are healthy', healthy(baseline), JSON.stringify(baseline))

  const missing = run(['alpha', 'gamma'])
  expect('a command missing from CI is caught', missing.missing.length === 1 && missing.missing[0] === 'beta', JSON.stringify(missing.missing))

  const swapped = run(['beta', 'alpha', 'gamma'])
  expect('a reordering is caught', swapped.outOfOrder.length === 1, JSON.stringify(swapped.outOfOrder))

  const extra = run(['alpha', 'beta', 'gamma', 'sneaky'])
  expect('an undeclared extra step is caught', extra.undeclared.length === 1 && extra.undeclared[0] === 'sneaky', JSON.stringify(extra.undeclared))

  const declared = compareChainToCi(FIXTURE_CHAIN, parseCiSteps(FIXTURE_STEPS(['alpha', 'install', 'beta', 'gamma'])), { install: 'reason' })
  expect('a declared extra step is allowed, and does not break order', healthy(declared), JSON.stringify(declared))

  const empty = compareChainToCi(FIXTURE_CHAIN, parseCiSteps('# just a comment\n'))
  expect('an unparsable workflow fails instead of passing vacuously', empty.missing.length === FIXTURE_CHAIN.length, JSON.stringify(empty.missing))

  const bare = commandOf('pnpm typecheck')
  const runPrefixed = commandOf('pnpm run typecheck')
  expect('`pnpm X` and `pnpm run X` normalise to the same command', bare === runPrefixed && bare === 'typecheck', `${bare} vs ${runPrefixed}`)

  const flagged = commandOf('pnpm run drill:engine --quiet')
  expect('flags are dropped, the script name is kept', flagged === 'drill:engine', String(flagged))

  expect('a non-pnpm step has no command and is ignored', commandOf('echo hi') === null, String(commandOf('echo hi')))

  for (const item of cases) {
    process.stdout.write(`  [${item.ok ? ' ok ' : 'FAIL'}] ${item.label}${item.ok ? '' : ` — ${item.detail}`}\n`)
  }
  const failed = cases.filter((item) => !item.ok).length
  if (failed > 0) {
    process.stdout.write(`\nFAILURE: ci-parity selftest — ${failed}/${cases.length} cases failed\n`)
    process.exit(1)
  }
  process.stdout.write(`\nSUCCESS: ci-parity selftest — ${cases.length}/${cases.length} cases passed\n`)
}

/* ----------------------------------------------------------------------- main */

function main() {
  if (process.argv.includes('--selftest')) {
    process.stdout.write('ci-parity gate — selftest\n')
    selftest()
    return
  }

  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const yaml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const steps = parseCiSteps(yaml)

  process.stdout.write('ci-parity — release:check and the CI workflow must agree\n')

  // A parser that reads nothing would report "no missing commands" and pass.
  // That is the one outcome this gate must never produce.
  if (steps.length === 0) {
    process.stdout.write('  [FAIL] no CI steps were parsed out of .github/workflows/ci.yml\n')
    process.stdout.write('\nFAILURE: ci-parity — the workflow could not be read, so nothing was compared\n')
    process.exit(2)
  }

  const result = compareChainToCi(releaseChain(packageJson), steps)
  for (const line of report(result)) process.stdout.write(`${line}\n`)

  if (!healthy(result)) {
    process.stdout.write('\nFAILURE: ci-parity — the chain and the workflow have drifted apart\n')
    process.exit(1)
  }
  process.stdout.write(
    `\nSUCCESS: ci-parity — ${result.compared} commands agree in content and order; `
      + `${steps.length} CI steps, ${Object.keys(CI_ONLY).length} declared extra(s)\n`,
  )
}

main()
