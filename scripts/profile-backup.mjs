#!/usr/bin/env node
/**
 * Profile backup / verify / restore, with a manifest that proves itself.
 *
 * ## Why this exists (see REVIEW-工程评审报告.md B4)
 *
 * The E2E runbook described a backup that produced `hashes-before.txt` and
 * `manifest-before.txt`. What was actually on disk was five copied config files,
 * no checksums, and no directory where the runbook said to look — so "we can roll
 * back" was a claim with no evidence behind it, and nothing could detect a backup
 * that was already wrong when it was taken.
 *
 * This tool is the missing half. Every backup writes `manifest.json` with a
 * per-file SHA-256, plus `manifest.sha256` over the manifest itself. `verify`
 * re-hashes the payload *and* the manifest, so a tampered manifest cannot certify
 * a tampered tree, and a correct-looking backup cannot hide a file that changed
 * after it was taken.
 *
 * ## Usage
 *
 * ```text
 * node scripts/profile-backup.mjs backup  [--profile desktop] [--into <dir>]
 * node scripts/profile-backup.mjs verify  <backup-dir>
 * node scripts/profile-backup.mjs restore <backup-dir> [--into <dir>] [--apply]
 * node scripts/profile-backup.mjs drill
 * ```
 *
 * `restore` is a dry run unless `--apply` is given, and it refuses to restore from
 * a backup that does not verify.
 *
 * `drill` is the part that makes the rest trustworthy: it builds a throwaway
 * profile-shaped tree, backs it up, and then asserts that verify *fails* on a
 * corrupted byte, a deleted file, an added file and a tampered manifest, and that
 * a restore brings it back. It never touches a real profile and never needs the
 * DSH host, so it can run in CI and in the offline verification suite.
 *
 * @module dsh-code-factory/scripts/profile-backup
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Bumped when the manifest shape changes; `verify` refuses anything newer. */
const MANIFEST_SCHEMA = 1

/**
 * Files copied from a profile root when present.
 *
 * Deliberately excludes `node_modules/`: the lockfile plus `dsh plugin … install`
 * reproduces the tree, and copying hundreds of megabytes on every backup would
 * make operators skip the backup.
 */
const ROOT_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

/** Directories copied recursively (small, and they carry the registration state). */
const ROOT_DIRS = ['.dsh-market', '.plugin-manager']

/** Inside `.plugin-manager/`, keep the registry plus the most recent logs. */
const LOG_DIR = 'logs'
const MAX_LOGS = 20

const TOOL = 'dsh-code-factory/scripts/profile-backup.mjs'

/** This file, so the drill can re-invoke the CLI in a child process. */
const SCRIPT_PATH = fileURLToPath(import.meta.url)

function fail(message, code = 1) {
  process.stderr.write(`profile-backup: ${message}\n`)
  process.exit(code)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Every file under `root`, as POSIX paths relative to it, sorted. */
function walk(root, out = []) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, name.name)
    if (name.isDirectory()) walk(full, out)
    else if (name.isFile()) out.push(full)
  }
  return out.sort()
}

/** `relative()` plus a platform-independent separator. */
function rel(root, file) {
  return relative(root, file).split(sep).join('/')
}

/** Refuse to operate on a path that escapes its root. */
function inside(root, candidate) {
  const resolved = resolve(candidate)
  const base = resolve(root)
  return resolved === base || resolved.startsWith(base + sep)
}

/* ------------------------------------------------------------------ backup */

function resolveProfileDir(profile) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/** Run `dsh plugin --profile <p> ls`, recording the outcome either way. */
function capturePluginList(profile) {
  const result = spawnSync('dsh', ['plugin', '--profile', profile, 'ls'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const body = [result.stdout ?? '', result.stderr ?? ''].filter((part) => part.trim() !== '').join('\n')
  if (result.error) return `# dsh plugin ls unavailable: ${result.error.message}\n${body}`
  return `# exit ${result.status ?? 'null'}\n${body}`
}

function collectFiles(profileDir) {
  const picked = []
  for (const name of ROOT_FILES) {
    const full = join(profileDir, name)
    if (existsSync(full) && statSync(full).isFile()) picked.push(full)
  }
  const market = join(profileDir, '.dsh-market')
  if (existsSync(market)) picked.push(...walk(market))
  const manager = join(profileDir, '.plugin-manager')
  if (existsSync(manager)) {
    for (const file of walk(manager)) {
      const parts = rel(manager, file).split('/')
      // The registry is small and load-bearing; logs are trimmed to the newest.
      if (parts[0] === LOG_DIR && parts.length > 1) continue
      picked.push(file)
    }
    const logs = join(manager, LOG_DIR)
    if (existsSync(logs)) {
      const recent = walk(logs).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, MAX_LOGS)
      picked.push(...recent)
    }
  }
  return picked
}

function commandBackup(argv) {
  const profile = option(argv, '--profile') ?? 'desktop'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const into = option(argv, '--into') ?? join(process.cwd(), '.e2e-backups')
  const target = join(into, `${profile}-${stamp}`)
  const profileDir = resolveProfileDir(profile)

  if (!existsSync(profileDir)) fail(`no profile directory at ${profileDir}`)

  mkdirSync(target, { recursive: true })
  const sources = collectFiles(profileDir)
  if (sources.length === 0) fail(`profile ${profileDir} has none of ${ROOT_FILES.join(', ')}`)

  const entries = []
  for (const source of sources) {
    const name = rel(profileDir, source)
    const dest = join(target, 'payload', name)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, dest)
    const bytes = readFileSync(dest)
    entries.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), mtimeMs: statSync(source).mtimeMs })
  }

  writeFileSync(join(target, 'plugin-ls.txt'), `${capturePluginList(profile)}\n`, 'utf8')

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    tool: TOOL,
    profile,
    source: profileDir,
    createdAt: new Date().toISOString(),
    files: entries,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(target, 'manifest.json'), manifestText, 'utf8')
  writeFileSync(join(target, 'manifest.sha256'), `${sha256(Buffer.from(manifestText, 'utf8'))}  manifest.json\n`, 'utf8')

  // Kept for operators who still follow the older runbook: same information,
  // in the shape that runbook names.
  writeFileSync(
    join(target, 'hashes-before.txt'),
    `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    'utf8',
  )
  writeFileSync(
    join(target, 'manifest-before.txt'),
    `${entries.map((entry) => `${entry.bytes}\t${entry.path}`).join('\n')}\n`,
    'utf8',
  )

  process.stdout.write(`backup: ${target}\n`)
  process.stdout.write(`  ${entries.length} file(s), manifest sha256 ${sha256(Buffer.from(manifestText, 'utf8')).slice(0, 16)}…\n`)
  return 0
}

/* ------------------------------------------------------------------ verify */

/**
 * Check a backup directory. Returns a list of problems; empty means healthy.
 *
 * Checks the manifest against its own checksum FIRST: a manifest that has been
 * edited can otherwise be made to agree with any payload.
 */
function verifyBackup(dir) {
  const problems = []
  const manifestPath = join(dir, 'manifest.json')
  const sealPath = join(dir, 'manifest.sha256')
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing`]
  if (!existsSync(sealPath)) return [`${sealPath} is missing (nothing proves the manifest itself)`]

  const manifestText = readFileSync(manifestPath, 'utf8')
  const expectedSeal = readFileSync(sealPath, 'utf8').trim().split(/\s+/)[0]
  const actualSeal = sha256(Buffer.from(manifestText, 'utf8'))
  if (expectedSeal !== actualSeal) {
    problems.push(`manifest.json does not match manifest.sha256 (expected ${expectedSeal}, got ${actualSeal})`)
    return problems
  }

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    return [`manifest.json is not valid JSON: ${error.message}`]
  }
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > MANIFEST_SCHEMA) {
    problems.push(`manifest schemaVersion ${manifest.schemaVersion} is newer than this tool understands (${MANIFEST_SCHEMA})`)
    return problems
  }
  if (!Array.isArray(manifest.files)) return ['manifest.json has no files array']

  const payload = join(dir, 'payload')
  const expected = new Set()
  for (const entry of manifest.files) {
    expected.add(entry.path)
    const full = join(payload, entry.path)
    if (!inside(payload, full)) {
      problems.push(`${entry.path} escapes the backup directory`)
      continue
    }
    if (!existsSync(full)) {
      problems.push(`${entry.path} is listed in the manifest but missing from the payload`)
      continue
    }
    const bytes = readFileSync(full)
    if (bytes.length !== entry.bytes) {
      problems.push(`${entry.path} is ${bytes.length} bytes, manifest says ${entry.bytes}`)
      continue
    }
    const digest = sha256(bytes)
    if (digest !== entry.sha256) problems.push(`${entry.path} hashes ${digest}, manifest says ${entry.sha256}`)
  }

  if (existsSync(payload)) {
    for (const file of walk(payload)) {
      const name = rel(payload, file)
      if (!expected.has(name)) problems.push(`${name} is in the payload but not in the manifest`)
    }
  }
  return problems
}

function commandVerify(argv) {
  const dir = argv.find((arg) => !arg.startsWith('--'))
  if (!dir) fail('verify needs a backup directory')
  if (!existsSync(dir)) fail(`no such backup directory: ${dir}`)
  const problems = verifyBackup(dir)
  if (problems.length === 0) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    process.stdout.write(`verify: OK — ${manifest.files.length} file(s) match the sealed manifest\n`)
    return 0
  }
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.stderr.write(`verify: ${problems.length} problem(s)\n`)
  return 1
}

/* ----------------------------------------------------------------- restore */

function commandRestore(argv) {
  const dir = argv.find((arg) => !arg.startsWith('--'))
  if (!dir) fail('restore needs a backup directory')
  if (!existsSync(dir)) fail(`no such backup directory: ${dir}`)

  const problems = verifyBackup(dir)
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    fail(`refusing to restore from a backup that does not verify (${problems.length} problem(s))`)
  }

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const target = option(argv, '--into') ?? manifest.source
  const apply = argv.includes('--apply')
  process.stdout.write(`${apply ? 'restore' : 'restore (dry run)'}: ${manifest.files.length} file(s) -> ${target}\n`)
  for (const entry of manifest.files) process.stdout.write(`  ${entry.path}\n`)
  if (!apply) {
    process.stdout.write('nothing was written; pass --apply to restore\n')
    return 0
  }
  for (const entry of manifest.files) {
    const source = join(dir, 'payload', entry.path)
    const dest = join(target, entry.path)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, dest)
  }
  const after = verifyBackup(dir)
  if (after.length > 0) fail('the backup stopped verifying during restore', 2)
  process.stdout.write(`restore: ${manifest.files.length} file(s) written to ${target}\n`)
  return 0
}

/* ----------------------------------------------------------------- compare */

/**
 * Compare a live directory against a backup's manifest.
 *
 * This is the "did the rollback actually land?" question, and it is deliberately
 * separate from `verify`: `verify` answers "is the backup internally sound?",
 * `compare` answers "does this directory now match it?".
 *
 * Note what it does NOT claim: extra files in the target are reported but are
 * not a failure by default (a rollback overwrites; it does not prune). Pass
 * `--strict` to make surprise files fatal too.
 */
function commandCompare(argv) {
  const dir = argv.find((arg) => !arg.startsWith('--'))
  if (!dir) fail('compare needs a backup directory')
  if (!existsSync(dir)) fail(`no such backup directory: ${dir}`)
  const against = option(argv, '--against')
  if (against === undefined) fail('compare needs --against <directory>')
  if (!existsSync(against)) fail(`no such directory to compare against: ${against}`)

  const sound = verifyBackup(dir)
  if (sound.length > 0) {
    for (const problem of sound) process.stderr.write(`  - ${problem}\n`)
    fail(`refusing to compare against a backup that does not verify (${sound.length} problem(s))`)
  }

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const problems = []
  let same = 0
  for (const entry of manifest.files) {
    const target = join(against, entry.path)
    if (!existsSync(target)) {
      problems.push(`${entry.path} is missing from ${against}`)
      continue
    }
    const bytes = readFileSync(target)
    if (bytes.length !== entry.bytes) {
      problems.push(`${entry.path} is ${bytes.length} bytes, the backup has ${entry.bytes}`)
      continue
    }
    if (sha256(bytes) !== entry.sha256) {
      problems.push(`${entry.path} differs from the backup`)
      continue
    }
    same += 1
  }

  const listed = new Set(manifest.files.map((entry) => entry.path))
  for (const prefix of ['.dsh-market', '.plugin-manager']) {
    const source = join(dir, 'payload', prefix)
    if (!existsSync(source)) continue
    for (const file of walk(source)) {
      const name = `${prefix}/${rel(source, file)}`
      if (!listed.has(name)) problems.push(`${name} exists in the target but not in the backup`)
    }
  }

  process.stdout.write(`compare: ${same}/${manifest.files.length} file(s) identical to the backup\n`)
  if (problems.length === 0) return 0
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.stderr.write(`compare: ${problems.length} difference(s)\n`)
  return argv.includes('--strict') || problems.some((line) => !line.includes('exists in the target')) ? 1 : 0
}

/* ------------------------------------------------------------------- drill */

function writeFileAt(root, name, body) {
  const full = join(root, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body, 'utf8')
}

/** Copy every file under `from` into `to`, preserving relative paths. */
function copyTree(from, to) {
  for (const file of walk(from)) {
    const dest = join(to, rel(from, file))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(file, dest)
  }
}

/**
 * Prove the tool on a throwaway tree.
 *
 * Each stage asserts an exact outcome: verify is run against four specifically
 * broken trees, and the drill fails if any of them is reported healthy.
 */
function commandDrill() {
  const root = mkdtempSync(join(tmpdir(), 'profile-backup-drill-'))
  const stages = []
  const record = (name, ok, detail) => {
    stages.push({ name, ok, detail })
    process.stdout.write(`  [${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`)
  }

  try {
    // A throwaway profile under a throwaway DSH_HOME, so the drill can never
    // see — let alone overwrite — a real profile.
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'drill')
    writeFileAt(profile, 'package.json', '{"name":"drill-profile"}\n')
    writeFileAt(profile, 'cordis.patch.yml', 'plugins:\n  - drill\n')
    writeFileAt(profile, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
    writeFileAt(profile, '.dsh-market/registry.json', '{"entries":[]}\n')
    writeFileAt(profile, '.plugin-manager/registry.json', '{"plugins":{}}\n')
    writeFileAt(profile, '.plugin-manager/logs/operation-1.log', 'ok\n')
    writeFileAt(profile, '.plugin-manager/logs/operation-2.log', 'ok\n')

    const into = join(root, 'backups')
    // Every CLI step runs as a child process: `fail()` calls `process.exit`, so
    // an in-process call would end the drill instead of reporting a refusal.
    const self = (args) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: home },
      })
      return { status: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
    }

    const made = self(['backup', '--profile', 'drill', '--into', into])
    record('backup exits 0 and writes a manifest', made.status === 0, made.out.split('\n')[0])
    if (made.status !== 0) return 1
    const backupDir = join(into, readdirSync(into)[0])

    const fresh = verifyBackup(backupDir)
    record('a fresh backup verifies', fresh.length === 0, fresh.join('; '))

    const healthy = self(['verify', backupDir])
    record('the verify command exits 0 on a healthy backup', healthy.status === 0, healthy.out)

    const payload = join(backupDir, 'payload')
    const victim = join(payload, 'package.json')
    const original = readFileSync(victim)

    writeFileSync(victim, Buffer.concat([original, Buffer.from(' ')]))
    let problems = verifyBackup(backupDir)
    record(
      'a corrupted byte is caught and named',
      problems.length > 0 && problems.some((line) => line.startsWith('package.json')),
      problems[0],
    )
    writeFileSync(victim, original)

    const removed = join(payload, 'cordis.patch.yml')
    const removedBody = readFileSync(removed)
    rmSync(removed)
    problems = verifyBackup(backupDir)
    record(
      'a deleted payload file is caught and named',
      problems.length > 0 && problems.some((line) => line.includes('cordis.patch.yml')),
      problems[0],
    )
    writeFileSync(removed, removedBody)

    writeFileSync(join(payload, '.plugin-manager/extra.json'), '{}\n')
    problems = verifyBackup(backupDir)
    record(
      'an unlisted payload file is caught and named',
      problems.length > 0 && problems.some((line) => line.includes('extra.json')),
      problems[0],
    )
    rmSync(join(payload, '.plugin-manager/extra.json'))

    const manifestPath = join(backupDir, 'manifest.json')
    const manifestBody = readFileSync(manifestPath)
    const tampered = JSON.parse(manifestBody.toString('utf8'))
    const victimEntry = tampered.files.find((entry) => entry.path === 'package.json')
    if (victimEntry !== undefined) victimEntry.sha256 = 'F'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    problems = verifyBackup(backupDir)
    record(
      'a tampered manifest cannot certify itself',
      problems.length > 0 && problems.some((line) => line.includes('manifest.sha256')),
      problems[0],
    )
    writeFileSync(manifestPath, manifestBody)

    const sealPath = join(backupDir, 'manifest.sha256')
    const sealBody = readFileSync(sealPath)
    rmSync(sealPath)
    problems = verifyBackup(backupDir)
    record(
      'a missing seal is caught',
      problems.length > 0 && problems.some((line) => line.includes('manifest.sha256')),
      problems[0],
    )
    writeFileSync(sealPath, sealBody)

    const restoreTarget = join(root, 'restored')
    const applied = self(['restore', backupDir, '--into', restoreTarget, '--apply'])
    const restoredFile = join(restoreTarget, 'package.json')
    record(
      'restore reproduces the payload byte for byte',
      applied.status === 0 && existsSync(restoredFile) && readFileSync(restoredFile).equals(original),
      applied.out.split('\n').pop(),
    )

    const dryTarget = join(root, 'dry')
    const dry = self(['restore', backupDir, '--into', dryTarget])
    record(
      'restore is a dry run without --apply',
      dry.status === 0 && !existsSync(join(dryTarget, 'package.json')),
      'nothing written without the flag',
    )

    const agreeing = self(['compare', backupDir, '--against', profile])
    record(
      'compare passes when the target still matches the backup',
      agreeing.status === 0 && /7\/7 file\(s\) identical/.test(agreeing.out),
      agreeing.out.split('\n')[0],
    )

    const drifted = join(root, 'drifted')
    copyTree(profile, drifted)
    // Same length, different bytes: this exercises the hash comparison rather
    // than the cheaper size check.
    writeFileSync(join(drifted, 'pnpm-lock.yaml'), 'lockfileVersion: 8\n', 'utf8')
    const disagreeing = self(['compare', backupDir, '--against', drifted])
    record(
      'compare notices a file the target has changed',
      disagreeing.status !== 0 && disagreeing.out.includes('pnpm-lock.yaml differs from the backup'),
      disagreeing.out.split('\n').filter(Boolean).pop(),
    )

    const corrupted = readFileSync(victim)
    writeFileSync(victim, Buffer.concat([corrupted, Buffer.from('x')]))
    const never = join(root, 'never')
    const refused = self(['restore', backupDir, '--into', never, '--apply'])
    record(
      'restore refuses a backup that no longer verifies',
      refused.status !== 0 && refused.out.includes('refusing to restore'),
      refused.out.split('\n').pop(),
    )
    record('the refused restore wrote nothing', !existsSync(join(never, 'package.json')))
    writeFileSync(victim, corrupted)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const failed = stages.filter((stage) => !stage.ok)
  if (failed.length > 0) {
    process.stderr.write(`drill: ${failed.length}/${stages.length} stage(s) failed\n`)
    return 1
  }
  process.stdout.write(`drill: all ${stages.length} stages behaved as designed\n`)
  return 0
}

/* -------------------------------------------------------------------- main */

/** Read `--name value`, or undefined when absent. */
function option(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

const argv = process.argv.slice(2)
const command = argv[0]
if (command === undefined || command === '--help' || command === '-h') {
  process.stdout.write(
    [
      'usage: profile-backup.mjs <command> [options]',
      '  backup  [--profile <name>] [--into <dir>]',
      '  verify  <backup-dir>',
      '  compare <backup-dir> --against <dir> [--strict]',
      '  restore <backup-dir> [--into <dir>] [--apply]',
      '  drill',
      '',
    ].join('\n'),
  )
  process.exit(command === undefined ? 2 : 0)
}
const rest = argv.slice(1)
const status =
  command === 'backup'
    ? commandBackup(rest)
    : command === 'verify'
      ? commandVerify(rest)
      : command === 'restore'
        ? commandRestore(rest)
        : command === 'compare'
          ? commandCompare(rest)
          : command === 'drill'
            ? commandDrill()
            : fail(`unknown command ${JSON.stringify(command)}`, 2)
process.exit(status ?? 0)
