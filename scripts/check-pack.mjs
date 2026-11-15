#!/usr/bin/env node
/**
 * scripts/check-pack.mjs — the release-artifact gate.
 *
 * Answers one question the other three scripts cannot:
 *
 *   "Is the tarball we would actually publish the SAME tree we just tested?"
 *
 * Why this file exists (see REVIEW-工程评审报告.md B1 / B5 / B6):
 *
 *   - `lib/` is a build product and `git ls-files lib` is empty, so a fresh
 *     clone has no `lib/` at all. `npm pack` used to ship a 14 kB shell:
 *     no host entry, no client bundle. `package.json` now declares
 *     `"prepack": "pnpm run build"`, and this script proves the result.
 *   - The published 0.1.0 tarball and the working tree carried the SAME version
 *     number with DIFFERENT `lib/client.js` bytes (the tree had a newer
 *     multi-factory index). Nothing detected that until now. This script
 *     byte-compares every shipped file against the checkout.
 *   - An artifact that cannot be tied to a commit is not releasable. The
 *     tarball sha256 printed here is what a release note must record next to
 *     the git tag (see docs/RELEASING.md).
 *
 * What it does
 *   1. runs the real `npm pack` (which triggers `prepack` -> `pnpm build`)
 *      into a throwaway directory, so the artifact is built exactly the way a
 *      publisher would build it;
 *   2. asserts the release invariants on the tarball's own file list:
 *      required entries present, tsc intermediates and source maps absent,
 *      and every `main` / `types` / `exports` target resolvable INSIDE the
 *      tarball (not merely inside the checkout);
 *   3. extracts the tarball and SHA256-compares every file against the
 *      checkout, so "the package is not the tree" is a hard failure.
 *
 * Usage
 *   node scripts/check-pack.mjs              (or: pnpm run check:pack)
 *   node scripts/check-pack.mjs --keep       keep the temp dir, print its path
 *
 * Exit codes
 *   0  the tarball is complete, minimal, self-consistent and byte-identical to
 *      the checkout
 *   1  at least one release invariant failed (each failure prints its own fix)
 *   2  could not pack at all (npm missing, prepack/build failed)
 *
 * @module dsh-code-factory/scripts/check-pack
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (path) => relative(repoRoot, path).split(sep).join('/')
const line = (text) => process.stdout.write(`${text}\n`)
const KEEP = process.argv.includes('--keep')

/**
 * `npm_config_ignore_scripts` is how npm reports `--ignore-scripts` to a child.
 * In that mode `prepack` never runs, so the tarball is built from whatever
 * `lib/` happens to be on disk: fine for the mutation self-test, NOT fine for a
 * release. The gate still runs, but it says out loud what it did not prove.
 */
const SCRIPTS_IGNORED = /^(1|true)$/i.test(process.env.npm_config_ignore_scripts ?? '')

/** Every failure is collected so one run reports the whole picture. */
const failures = []
const notes = []
const fail = (id, problem, fix) => failures.push({ id, problem, fix })
/** A non-fatal observation: printed in the report, never changes the exit code. */
const note = (text) => notes.push(text)
/** One-line rendering of a thrown value (Error, string, anything). */
const describeError = (error) => (error instanceof Error ? error.message : String(error))

/* ------------------------------------------------------------------ packing */

function pack() {
  const dir = mkdtempSync(join(tmpdir(), 'code-factory-pack-'))
  // `shell: true` is required to reach `npm.cmd` on Windows, and Node does not
  // escape argv for the shell - so quote the one argument that is a path.
  const dest = process.platform === 'win32' ? `"${dir}"` : dir
  try {
    execFileSync('npm', ['pack', '--pack-destination', dest], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    line('[FAIL] `npm pack` did not complete - the artifact was never produced')
    if (detail) line(detail.split('\n').slice(-25).map((l) => `        ${l}`).join('\n'))
    line('       -> `npm pack` runs the `prepack` script (`pnpm run build`); fix the build first')
    rmSync(dir, { recursive: true, force: true })
    process.exit(2)
  }
  const tarballs = readdirSync(dir).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    line(`[FAIL] expected exactly one .tgz in the pack destination, found ${tarballs.length}`)
    rmSync(dir, { recursive: true, force: true })
    process.exit(2)
  }
  return { dir, tarball: join(dir, tarballs[0]), filename: tarballs[0] }
}

/** Recursively list files under `root`, as repo-relative POSIX paths. */
function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/* ------------------------------------------------------------------ invariants */

const REQUIRED = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/index.d.ts',
  'package/lib/client.js',
  'package/cordis.patch.yml',
  'package/compatibility.json',
  'package/README.md',
  'package/README_ZH.md',
  // The version -> commit table. Whoever installs the tarball on a machine with
  // no checkout is exactly the person who needs to know what changed and when.
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/types/client.d.ts',
  // The two scripts that ARE published. doctor.mjs answers "is this installation
  // loadable?"; profile-backup.mjs answers "can I get back to a known-good
  // profile?" — both questions are asked by whoever installed the package, on a
  // machine that has no source checkout. See FORBIDDEN below for the
  // mirror-image rule that keeps every other script out.
  'package/scripts/doctor.mjs',
  'package/scripts/profile-backup.mjs',
  // The rollback runbook itself. It used to live in docs/, which is not
  // published, so the people who needed it could not read it (report item B4).
  'package/ROLLBACK.md',
]

/** Paths that must NEVER ship, each with the reason a reviewer needs. */
const FORBIDDEN = [
  [/^package\/lib\/client\//, 'lib/client/** is the tsc intermediate the bundler READS; it is not a published entry (this also keeps its .map files out)'],
  [
    /^package\/scripts\/(?!doctor\.mjs$)(?!profile-backup\.mjs$)/,
    'only scripts/doctor.mjs and scripts/profile-backup.mjs ship (a `bin` entry and the rollback tool an operator needs on a machine with no checkout); every other script is dev-only — verify/check-docs read src/, docs/ and the checkout layout that a profile install does not have',
  ],
  [/^package\/src\//, 'src/ is not published; the tarball ships build output only'],
  [/^package\/node_modules\//, 'node_modules must never be packed'],
  [/\.tsbuildinfo$/, 'build caches must never be packed'],
]

const { dir, tarball, filename } = pack()

execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
// `tar -xzf <file> -C <dir>` writes `package/` under `dir`; the walking base is
// `dir` (not `dir/package`) so every entry keeps its `package/` prefix.
if (!existsSync(join(dir, 'package'))) {
  line('[FAIL] the tarball does not contain a top-level `package/` directory')
  process.exit(2)
}

const packed = walk(join(dir, 'package'), dir)
const packedSet = new Set(packed)

/* 1. required entries */
for (const required of REQUIRED) {
  if (!packedSet.has(required)) {
    fail(
      required,
      `missing from the tarball (${packed.length} entries packed)`,
      required === 'package/lib/index.js' || required === 'package/lib/client.js'
        ? 'the build did not run before packing - `prepack` must be `pnpm run build`'
        : `add it to \`files\` in package.json (or stop declaring it in \`exports\`)`,
    )
  }
}

/* 2. forbidden entries */
for (const entry of packed) {
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(entry)) fail(entry, `must not be published: ${why}`, 'tighten `files` in package.json')
  }
}

/* 3. every exported subpath resolves INSIDE the tarball */
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const exported = []
const collectTargets = (value, where) => {
  if (typeof value === 'string') exported.push([where, value])
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) collectTargets(inner, `${where}.${key}`)
  }
}
for (const [key, value] of Object.entries(pkg.exports ?? {})) collectTargets(value, `exports["${key}"]`)
if (pkg.main) exported.push(['main', pkg.main])
if (pkg.types) exported.push(['types', pkg.types])

for (const [where, target] of exported) {
  const inside = `package/${posix.normalize(String(target).replace(/^\.\//, ''))}`
  const onDisk = join(repoRoot, String(target).replace(/^\.\//, ''))
  if (!existsSync(onDisk)) {
    fail(where, `points at ${target}, which does not exist in the checkout`, 'fix the path or run `pnpm build`')
  } else if (!packedSet.has(inside)) {
    fail(where, `points at ${target}, which the tarball does NOT contain`, 'add the path to `files` in package.json')
  }
}

/* 4. lib/ completeness, both directions */
const repoLib = walk(join(repoRoot, 'lib')).filter((p) => !p.startsWith('client/') && p.endsWith('.js'))
const packedLib = packed
  .filter((p) => p.startsWith('package/lib/') && p.endsWith('.js'))
  .map((p) => p.slice('package/lib/'.length))
const missingLib = repoLib.filter((p) => !packedLib.includes(p))
const extraLib = packedLib.filter((p) => !repoLib.includes(p))
if (missingLib.length > 0) {
  fail('lib completeness', `${missingLib.length} built module(s) are on disk but not packed: ${missingLib.slice(0, 6).join(', ')}`, 'rebuild, then re-run this check')
}
if (extraLib.length > 0) {
  fail('lib completeness', `${extraLib.length} module(s) are packed but not on disk: ${extraLib.slice(0, 6).join(', ')}`, 'the tarball is stale - delete lib/ and rebuild')
}

/* 4b. every sourceMap reference in a shipped .js resolves INSIDE the tarball, and
 *     no shipped .map leaks a path from the machine that built it (H11).
 *
 * Why this is a gate and not a convention: every emitted .js ends with
 * `//# sourceMappingURL=<name>.map`. When `files` excluded maps, all of those
 * references were a guaranteed 404 in devtools - a defect nobody sees until they
 * are debugging the installed plugin, which is exactly when it must work. The
 * two halves of the fix are "ship the map" and "make sure shipping it did not
 * publish the builder's home directory", so both are asserted here. */
const SOURCE_MAP_REFERENCE = /\/\/# sourceMappingURL=([^\s'"]+)/
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+[\\/]|\/(?:Users|home|mnt|opt|var)\/)/
let mapReferences = 0
for (const entry of packed) {
  if (!entry.endsWith('.js')) continue
  const text = readFileSync(join(dir, entry), 'utf8')
  const reference = SOURCE_MAP_REFERENCE.exec(text)
  if (reference === null) continue // inline maps and map-less builds are fine
  const target = reference[1]
  if (/^(?:data:|https?:)/.test(target)) continue // an inline or remote map is not a missing file
  mapReferences += 1
  const resolved = posix.normalize(posix.join(posix.dirname(entry), target))
  if (!packedSet.has(resolved)) {
    fail(
      entry,
      `ends with \`sourceMappingURL=${target}\` but the tarball has no ${resolved}`,
      'either ship the map (it must not be in a FORBIDDEN path) or stop emitting the reference',
    )
  } else if (!existsSync(join(repoRoot, resolved.slice('package/'.length)))) {
    fail(resolved, 'is packed as a source map but is not in the checkout', 'delete lib/ and rebuild')
  }
}
if (mapReferences === 0) {
  note('no shipped .js declares a source map: devtools will show the bundle, not the TypeScript')
}

let scannedMaps = 0
for (const entry of packed) {
  if (!entry.endsWith('.map')) continue
  scannedMaps += 1
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
  } catch (error) {
    fail(entry, `is not valid JSON: ${describeError(error)}`, 'delete lib/ and rebuild')
    continue
  }
  const leaking = []
  for (const source of Array.isArray(parsed.sources) ? parsed.sources : []) {
    if (typeof source === 'string' && ABSOLUTE_PATH.test(source)) leaking.push(`sources: ${source}`)
  }
  for (const key of ['sourceRoot', 'file']) {
    if (typeof parsed[key] === 'string' && ABSOLUTE_PATH.test(parsed[key])) leaking.push(`${key}: ${parsed[key]}`)
  }
  if (leaking.length > 0) {
    fail(entry, `publishes a path from the build machine: ${leaking.slice(0, 3).join('; ')}`, 'make the bundler emit relative sources, or drop the map')
  }
}

/* 5. the tarball IS the tree, byte for byte */
let compared = 0
for (const entry of packed) {
  const stripped = entry.slice('package/'.length)
  const onDisk = join(repoRoot, stripped)
  if (!existsSync(onDisk) || !statSync(onDisk).isFile()) {
    fail(entry, 'is in the tarball but not in the checkout', 'delete lib/ and rebuild, then re-run this check')
    continue
  }
  if (stripped === 'package.json') continue // npm normalises this one; checked below
  const packedHash = sha256(join(dir, entry))
  const repoHash = sha256(onDisk)
  compared += 1
  if (packedHash !== repoHash) {
    fail(entry, `differs from the checkout (packed ${packedHash.slice(0, 12)}, tree ${repoHash.slice(0, 12)})`, 'the tarball was built from a different tree - rebuild and re-run this check')
  }
}

/* 6. package.json survived packing (npm rewrites it, so compare the contract) */
const packedPkg = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'))
for (const field of ['name', 'version', 'main', 'types', 'exports', 'files', 'dsh', 'peerDependencies']) {
  const a = JSON.stringify(pkg[field] ?? null)
  const b = JSON.stringify(packedPkg[field] ?? null)
  if (a !== b) fail('package.json', `\`${field}\` changed while packing`, 'do not let npm rewrite the release contract')
}
/* 7. the artifact must trace to a commit (B6) */

const size = statSync(tarball).size
const digest = sha256(tarball)

const noteRel = posix.join('release-notes', `${pkg.version}.md`)
const notePath = join(repoRoot, noteRel)

/** Run git and return trimmed stdout, or null when git is unavailable/fails. */
const gitOrNull = (...argv) => {
  try {
    return execFileSync('git', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const head = gitOrNull('rev-parse', 'HEAD')
const exactTag = gitOrNull('describe', '--tags', '--exact-match', 'HEAD')

if (!existsSync(notePath)) {
  notes.push(
    `no ${noteRel}: ${pkg.name}@${pkg.version} is not a release yet. To release it, write ${noteRel} recording the sha256 printed below, commit it, then \`git tag v${pkg.version}\`.`,
  )
} else {
  const noteText = readFileSync(notePath, 'utf8')
  const declaredSha = /\bsha256\b[^0-9a-f]{0,24}([0-9a-f]{64})/i.exec(noteText)
  if (declaredSha === null) {
    fail(noteRel, 'does not record the artifact sha256', `add \`sha256 ${digest}\` to ${noteRel}`)
  } else if (declaredSha[1].toLowerCase() !== digest) {
    fail(
      noteRel,
      `records sha256 ${declaredSha[1].slice(0, 12)}... but this tree packs to ${digest.slice(0, 12)}...`,
      `the note describes a different artifact - update ${noteRel} to the sha256 printed below and re-tag v${pkg.version}, or bump the version`,
    )
  }
  if (exactTag === null) {
    notes.push(
      `HEAD (${head?.slice(0, 12) ?? 'unknown'}) is not tagged: \`git tag v${pkg.version}\` the commit that carries ${noteRel}, so the artifact traces to a commit`,
    )
  } else if (exactTag !== `v${pkg.version}`) {
    fail(
      'git tag',
      `HEAD is tagged ${exactTag} but package.json declares ${pkg.version}`,
      `tag the release commit \`v${pkg.version}\`, or set package.json's version to match the tag`,
    )
  } else {
    const declaredCommit = /\bcommit\b[^0-9a-f]{0,24}([0-9a-f]{7,40})/i.exec(noteText)
    if (declaredCommit !== null && head !== null && !head.startsWith(declaredCommit[1])) {
      fail(
        noteRel,
        `records commit ${declaredCommit[1]} but HEAD is ${head.slice(0, 12)}`,
        'the note points at a different commit - correct it, or move the tag to that commit',
      )
    }
  }
}

/* --------------------------------------------------------------------- report */

line('check-pack: release artifact gate')
if (SCRIPTS_IGNORED) {
  line('  [warn] npm_config_ignore_scripts is set: `prepack` did NOT run, so this')
  line('         run proves the file list only - NOT that a fresh clone can pack.')
}
line(`  tarball  ${filename}`)
line(`  entries  ${packed.length}`)
line(`  size     ${size} bytes`)
line(`  sha256   ${digest}`)
line(`  compared ${compared} file(s) against the checkout, byte for byte`)

if (failures.length === 0) {
  line(`\n${'-'.repeat(66)}`)
  line(`SUCCESS: ${packed.length} entries, all release invariants hold, artifact == checkout`)
  if (SCRIPTS_IGNORED) line('note: prepack was skipped - re-run without --ignore-scripts before publishing')
  else line(`record this in the release note: ${filename} sha256 ${digest}`)
  if (notes.length > 0) for (const note of notes) line(`note: ${note}`)
  if (KEEP) line(`temp dir kept: ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

line(`\n${'-'.repeat(66)}`)
line(`FAILURE: ${failures.length} release invariant(s) broken`)
for (const { id, problem, fix } of failures) {
  line(`  - ${id}`)
  line(`      ${problem}`)
  line(`      -> ${fix}`)
}
if (KEEP) line(`temp dir kept: ${dir}`)
else rmSync(dir, { recursive: true, force: true })
process.exit(1)
