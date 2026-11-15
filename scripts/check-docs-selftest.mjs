// Mutation self-test for check-docs.mjs.
//
// `check-docs.mjs` is this repo's only enforcement of "docs are a contract", so
// its own guards need evidence that they *fire* — a rule that can never fail is
// worse than no rule, because it reads as coverage. Each case below copies the
// real script, applies one surgical mutation, and asserts the resulting exit
// code and message. B7 was exactly this shape: a rule pair that could not both
// hold, found only by reading the source.
//
// The mutated copy uses a *different* file name so this runner never deletes itself.
// Run: `pnpm test:self` (also wired into CI).
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = join(here, 'check-docs.mjs')
const tmp = join(here, '.tmp-b7-case.mjs')
const original = readFileSync(src, 'utf8')

function run(label) {
  const r = spawnSync(process.execPath, [tmp, '--quiet'], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  console.log(`--- ${label}: exit=${r.status}`)
  console.log(out.trim().split('\n').slice(-5).join('\n'))
  return { status: r.status, out }
}

let failures = 0
const expect = (ok, what) => {
  if (!ok) {
    failures += 1
    console.log(`  !! FAILED: ${what}`)
  } else {
    console.log(`  ok: ${what}`)
  }
}
const patch = (from, to) => {
  if (!original.includes(from)) throw new Error(`probe anchor not found: ${JSON.stringify(from.slice(0, 70))}`)
  writeFileSync(tmp, original.replace(from, to))
}

const UNLESS_141 = '    unless: () => V.compatibilityLines === 141,\n'
const NOW_141 = '    now: `${V.compatibilityLines}`,\n    unless: () => V.compatibilityLines === 141,'

try {
  // A. an ungated "current value + 1" ban must be rejected by the structural rule
  patch(UNLESS_141, '')
  const a = run('A: drop unless() on compatibility 141')
  expect(a.status === 1, 'ungated split-convention ban exits 1')
  expect(a.out.includes('stale table shape'), 'structural rule named in output')
  expect(a.out.includes('compatibility.json lines 141'), 'offending entry named')

  // B. when the banned literal becomes the current value, the ban graduates
  //    via the derived safety net instead of deadlocking
  patch(NOW_141, '    now: `141`,\n    unless: () => V.compatibilityLines === 141,')
  const b = run('B: banned literal == current value (derived net)')
  expect(b.status === 0, 'graduated ban does NOT deadlock (exit 0)')
  expect(b.out.includes('禁令已毕业'), 'graduation reported, not silent')
  expect(b.out.includes('token 内含当前值'), 'graduation attributed to the derived net')

  // D. the explicit unless() path graduates the same way
  patch(UNLESS_141, '    unless: () => true,\n')
  const d = run('D: unless() returns true')
  expect(d.status === 0, 'unless() graduation exits 0')
  expect(d.out.includes('禁令已毕业'), 'graduation reported')
  expect(d.out.includes('unless()'), 'graduation attributed to unless()')

  // C. none of this fires on the pristine script
  copyFileSync(src, tmp)
  const c = run('C: pristine')
  expect(c.status === 0, 'pristine script still exits 0')
  expect(!c.out.includes('禁令已毕业'), 'pristine script reports no graduation')
} finally {
  rmSync(tmp, { force: true })
}

console.log(failures === 0 ? '\ncheck-docs self-test: all mutations behaved as designed' : `\ncheck-docs self-test: ${failures} expectation(s) failed`)
process.exit(failures === 0 ? 0 : 1)
