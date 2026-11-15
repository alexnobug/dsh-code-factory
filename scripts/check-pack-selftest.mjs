// Mutation self-test for check-pack.mjs.
//
// `check-pack.mjs` is the only thing standing between this repo and a repeat of
// B1 (a fresh clone packing a 14 kB empty shell), B5 (the installed copy not
// being the release artifact) and B6 (an artifact traceable to no commit). A
// gate nobody has seen fail is not a gate, so each case below breaks exactly one
// release invariant in `package.json`, runs the real gate, and asserts both the
// exit code and the message that names the broken invariant.
//
// Cases run with `npm_config_ignore_scripts=1`, which makes npm skip `prepack`.
// That is deliberate: the mutations are about the FILE LIST, not about the
// build, and skipping the rebuild keeps this suite to seconds. The full
// prepack path is covered by `pnpm check:pack` itself (and by CI).
//
// `package.json` is mutated in place and restored in `finally`; nothing else in
// the repository is touched.
//
// Run: `pnpm test:self:pack`
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const manifest = join(repoRoot, 'package.json')
const gate = join(here, 'check-pack.mjs')
const original = readFileSync(manifest, 'utf8')

function run(label) {
  const r = spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_ignore_scripts: '1' },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  console.log(`--- ${label}: exit=${r.status}`)
  console.log(
    out
      .trim()
      .split('\n')
      .filter((line) => /FAIL|SUCCESS|^  - |^ {6}/.test(line))
      .slice(-6)
      .join('\n'),
  )
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

/** Replace one anchor in package.json, refusing to run if the anchor moved. */
const patch = (from, to) => {
  if (!original.includes(from)) throw new Error(`probe anchor not found: ${JSON.stringify(from.slice(0, 70))}`)
  writeFileSync(manifest, original.replace(from, to))
}

// npm ALWAYS packs package.json, README*, LICENSE/LICENCE* and CHANGELOG*
// regardless of `files` - measured, not assumed: dropping `"LICENSE"` from the
// whitelist still produced 74 entries with package/LICENSE present. So the
// interesting mutation is an entry npm does NOT protect, whose absence must be
// reported by BOTH the required-entry rule and the exports-target rule.
const FILE_TYPES = '    "types",\n'
const FILE_DOCTOR = '    "scripts/doctor.mjs",\n'
const FILE_ROLLBACK = '    "ROLLBACK.md",\n'
const FILE_CLIENT_NEGATION = '    "!lib/client/**",\n'
const CLIENT_TYPES = '      "types": "./types/client.d.ts",'

try {
  // A. a published entry dropped from the file list (npm does not protect this)
  patch(FILE_TYPES, '')
  const a = run('A: types/ removed from files[]')
  expect(a.status === 1, 'a dropped published entry exits 1')
  expect(a.out.includes('package/types/client.d.ts'), 'the missing entry is named')
  expect(a.out.includes('does NOT contain'), 'the exports target is reported unresolvable')

  // B. the tsc intermediate directory starts shipping again
  patch(FILE_CLIENT_NEGATION, '')
  const b = run('B: !lib/client/** negation removed')
  expect(b.status === 1, 'the tsc intermediate shipping exits 1')
  expect(b.out.includes('package/lib/client/'), 'the offending packed path is named')
  expect(b.out.includes('must not be published'), 'the reason is stated')

  // C. an exports target that resolves in the checkout but not in the tarball
  patch(CLIENT_TYPES, '      "types": "./types/missing.d.ts",')
  const c = run('C: exports target that does not exist')
  expect(c.status === 1, 'a dangling exports target exits 1')
  expect(c.out.includes('does not exist in the checkout'), 'the dangling target is named')

  // E. the dev-only scripts start shipping alongside the two that must
  patch(FILE_DOCTOR, '    "scripts/doctor.mjs",\n    "scripts/verify.mjs",\n')
  const e = run('E: a dev-only script added to files[]')
  expect(e.status === 1, 'publishing verify.mjs exits 1')
  expect(e.out.includes('package/scripts/verify.mjs'), 'the offending packed path is named')
  expect(
    e.out.includes('only scripts/doctor.mjs and scripts/profile-backup.mjs ship'),
    'the reason distinguishes the scripts that may ship',
  )

  // F. the rollback runbook stops being published
  patch(FILE_ROLLBACK, '')
  const f = run('F: ROLLBACK.md removed from files[]')
  expect(f.status === 1, 'an unpublished runbook exits 1')
  expect(f.out.includes('package/ROLLBACK.md'), 'the missing runbook is named')

  // G. the source maps stop shipping while every emitted .js still points at them
  //    (this was the shipped state until H11: a guaranteed devtools 404)
  patch(FILE_TYPES, `${FILE_TYPES}    "!**/*.map",\n`)
  const g = run('G: source maps excluded while .js still references them')
  expect(g.status === 1, 'a dangling sourceMappingURL exits 1')
  expect(g.out.includes('sourceMappingURL='), 'the dangling reference is quoted')
  expect(g.out.includes('the tarball has no package/'), 'the missing map is named by its packed path')

  // H. a shipped map that leaks the path of the machine that built it.
  //    `files` is left pristine; the leak is injected into the BUILD OUTPUT for
  //    the duration of one run and removed in `finally`. It has to be a real file
  //    in lib/ because that is the only way to observe the real scanner.
  writeFileSync(manifest, original)
  const leakJs = join(repoRoot, 'lib', '__selftest_leak.js')
  const leakMap = join(repoRoot, 'lib', '__selftest_leak.js.map')
  const leakRef = '//# sourceMappingURL=__selftest_leak.js.map\n'
  try {
    writeFileSync(leakJs, `exports.__selftestLeak = true\n${leakRef}`)
    writeFileSync(
      leakMap,
      JSON.stringify({
        version: 3,
        file: '__selftest_leak.js',
        sources: [`D:${String.fromCharCode(92)}Users${String.fromCharCode(92)}someone${String.fromCharCode(92)}secret.ts`],
        names: [],
        mappings: '',
      }),
    )
    const h = run('H: a shipped source map leaks the builder absolute path')
    expect(h.status === 1, 'a leaking source map exits 1')
    expect(h.out.includes('publishes a path from the build machine'), 'the leak is named')
    expect(h.out.includes('__selftest_leak.js.map'), 'the offending map is named')
  } finally {
    rmSync(leakJs, { force: true })
    rmSync(leakMap, { force: true })
  }

  // D. nothing fires on the pristine manifest
  writeFileSync(manifest, original)
  const d = run('D: pristine')
  expect(d.status === 0, 'the pristine manifest still exits 0')
  expect(d.out.includes('artifact == checkout'), 'the byte-comparison actually ran')
  expect(
    /compared (\d+) file/.test(d.out) && Number(/compared (\d+) file/.exec(d.out)[1]) > 50,
    'a meaningful number of files were compared',
  )
} finally {
  writeFileSync(manifest, original)
}

console.log(
  failures === 0
    ? '\ncheck-pack self-test: all mutations behaved as designed'
    : `\ncheck-pack self-test: ${failures} expectation(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
