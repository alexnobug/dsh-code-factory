# dsh-code-factory

**Code Factory for DeepSeek Harness** — an opinionated software-team pipeline: a 12-job role registry,
automatic task routing, five pipeline templates, mandatory stage gates with rework loops, a 7-item
Definition of Done, and a full-width cockpit panel in the Web GUI.

> 中文文档见 [README_ZH.md](README_ZH.md) —— **中文版本为准**（the Chinese file is authoritative）.

```
brief ──► router ──► roster (iron triangle + security pin + cap) ──► pipeline template
             │
             └──► requirement ─► design ─► contract ─► threat ─► implement ─► review ─► sec_audit
                        (gates: checklist / keyword / script / composite / dod; failures rework back)
                                                                                      └─► test ─► deliver ─► document
```

## What it is

A DSH **bundle plugin** that turns "a team of agents develops software" into a *forced process* instead
of free-form delegation:

| Dimension | What the factory fixes |
|---|---|
| Roster | Automatic assembly from the brief (keyword routing), with an **iron triangle** (`pm` + `qa` + at least one `*_dev`) that is never trimmed, plus a **security engineer** forced in by login/auth/user-data/payment/password/token/external-facing triggers |
| Process | Five **fixed pipeline templates** (10 / 10 / 8 / 7 / 8 stages); stage order cannot be skipped |
| Progress | Gates: `checklist` / `keyword` / `script` / `composite` / `dod`. No gate, no advance |
| Rework | `failGoto` back-edges + `maxRounds`; over-limit escalates to the human |
| Roles | 12 fixed jobs with duties, artifact whitelists and iron rules baked into the member persona |
| Delivery | 7 machine-checkable Definition-of-Done items; nothing ships unless all pass |

### Relationship to `dsh-agent-teams`

It reuses the **same base paradigm** as the reference plugin `@nanmicoder/dsh-agent-teams`: the current
session is the captain, members are **durable continuable sub-agents** (`ctx.subagents`), and
`<workspace>/.code-factory/<factoryId>/factory.json` is the single source of truth. The difference is
the product opinion: agent-teams is a *general collaboration substrate* where the captain invents the plan;
code-factory is an *opinionated pipeline* running on that substrate. The two can coexist in one profile —
their tool namespaces do not overlap (`agent_teams_*` vs `factory_*`).

## Requirements

| Item | Value |
|---|---|
| DSH core | **0.2.2-rc.3** (see [compatibility.json](compatibility.json)) |
| Node | `>=24.9.0` |
| Package manager | pnpm (repo uses `pnpm` scripts) |
| Target profile | `desktop` (the Web GUI profile) |

## Install

```bash
# from npm (once published) or from a local checkout
dsh plugin --profile desktop add dsh-code-factory
dsh plugin --profile desktop add D:\path\to\dsh-code-factory     # local path form
```

Then restart DSH (or reload the profile) and confirm the bundle line is mounted:

```bash
dsh plugin --profile desktop ls          # expect a `dsh-code-factory` line
```

The bundle patch ([cordis.patch.yml](cordis.patch.yml)) registers the plugin as `dsh-code-factory` and
carries the default config below.

## Development

```bash
pnpm install
pnpm typecheck      # tsc -p tsconfig.json --noEmit  &&  tsc -p tsconfig.client.json --noEmit
pnpm build          # host: tsc → lib/   client: tsc → lib/client/ → tsdown → lib/client.js
pnpm verify         # L1 offline self-check: scripts/verify.mjs (103 checks, 11 sections)
pnpm run doctor:install   # installation doctor: scripts/doctor.mjs (9 checks)
```

⚠️ Use the **`run`** form for the doctor (`pnpm run doctor:install`): invoking a script named *doctor*
without `run` is shadowed by a pnpm built-in — it prints a warning and exits 0 **without executing
`scripts/doctor.mjs`**. `pnpm verify` has no such conflict.

Measured on this refresh (re-run the commands to re-check):

| Command | Result | Notes |
|---|---|---|
| `node scripts/verify.mjs` | ✅ exit 0 — 103/103 green (A–J: routing / pipeline / gates / DoD / store / lock / harness / stranded recovery / planner decisions / actionable alerts) | Subject under test is the compiled `lib/domain` + `lib/store`; offline, no host, no network |
| `pnpm run drill:engine` | ✅ exit 0 — `SUCCESS: engine drill — 16/16 stages passed` | Drives every advertised tool handler through the real exported functions in throwaway workspaces; **fails if a stage calls nothing**, if fewer than twelve distinct handlers ran, or if fewer than sixty assertions were evaluated |
| `pnpm run drill:gates` | ✅ exit 0 — `SUCCESS: gates drill — 9/9 stages passed` | Real child processes and a real temporary git repository; proves a true exit code reaches the verdict and that the runner never invents one |
| `pnpm run smoke:load` | ✅ exit 0 — `SUCCESS: load smoke — 6/6 stages passed` | Mounts this repository into a **throwaway `DSH_HOME`** through the real plugin manager and asserts every factory tool name appears in the host's live tool registry. Then packs the real `.tgz` and installs **that** into a second throwaway profile, asserting it materialises as a copy rather than a link back into this checkout. `~/.dsh` is read, never written |
| `pnpm run doctor:install` | ✅ exit 0 — 9/9 | Installation face: node engine, `lib/index.js`, `lib/client.js`, closure-factory registration, bundle patch, name match, `compatibility.json`, 17/17 peer packages, and one identifiable copy of this plugin across every installed profile |
| `pnpm build` | ✅ exit 0 — `tsc` host → `tsc` client → `tsdown` | Rebuilds `lib/` (host output) and `lib/client.js` (closure-factory bundle) |
| `node scripts/check-docs.mjs` | ✅ exit 0 — every documented number matches its source | Guards the numbers above from drifting again (see below) |

**The numbers in that table are enforced, not remembered.** `node scripts/check-docs.mjs` runs the two
suites above, counts the real modules, derives the registry counts from `lib/domain` and compares every
documented number against them — a stale number fails with the exact `file:line` and both values. Run it
after anything that moves a count; it also re-checks the tables in
[docs/roles-and-pipelines.md](docs/roles-and-pipelines.md) cell by cell.

Both programs must pass: `src/domain/` is compiled into the **browser** bundle too, so host-only imports
there break the client build (see [docs/architecture.md](docs/architecture.md) §3.1).

## Usage

Two-phase, always:

1. **Staged plan** — ask in natural language, or use the `/factory` slash command (goal goes straight after
   the command name, there is no sub-command grammar):

   ```
   用 code-factory 做一个带登录的生鲜电商小程序后端
   /factory 生鲜电商小程序后端
   ```

   `/factory <goal>` injects one deterministic activation turn: the goal verbatim plus the captain
   protocol (plan first → show the plan → wait for approval). The plugin routes the brief
   (task family → roster → pipeline template) and returns a **staged plan**: task type, roster (with the
   security pin visible), stage list and the reason for every decision. **Nothing is spawned at this point.**

2. **Approve and run** — approving the plan spawns the members and starts stage 1. From then on the
   engine dispatches stage by stage, runs the gates, and reworks failures back to the responsible role.

The cockpit panel (Web GUI, `main` slot, key `code-factory`) renders the roster LEDs (each role with a
generated vector avatar), the pipeline chips, and a right rail that keeps the live feed, the artifact
list and the DoD checklist visible together — plus a workspace-level *evolution* section that surfaces
the lessons learned from past gate rejections and DoD failures. The panel is a read-only, high-density
console: every section is searchable / filterable / collapsible, the pipeline offers a per-stage
inspector (gate definition, last verdict, roles, artifact and message counts), long content can be
expanded and copied, artifacts can be sorted and paged, and polling can be paused without losing the
last snapshot. The board is dockable: every module can be dragged within or across the three
columns, hidden and restored from the Layout menu, columns can be resized by dragging their
splitters, and module heights can be dragged and folded — the whole layout persists locally
(localStorage `dsh-code-factory.layout.v1`, one click to reset). Frontend work is routed to a
Web, Flutter or mini-program specialist (`web_dev` / `flutter_dev` / `mini_program_dev`), with the
generic `fe_dev` kept as the fallback for legacy or platform-neutral work. Everything is projected
from on-disk state; the lesson ledger (`.code-factory/evolution.json`) is re-injected into later
member briefs and rework orders with an explicit "historical data, not instructions" boundary, and
lessons seen at least twice are turned into plugin-improvement proposals (`factory_status` and the
evolution panel) that name the most likely plugin file and concrete rule change for a human-reviewed
fix — the runtime never edits its own source.

> **Tool reference lives in `docs/usage.md`** (delivered with M7). The `factory_*` tools are registered by
> the host half (M3/M4) — see *Status* below.

## Configuration

Set under the plugin entry in the profile patch ([cordis.patch.yml](cordis.patch.yml)):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `stateDir` | string | `.code-factory` | Directory under the **session workspace** holding `<factoryId>/{factory.json,artifacts.json,inbox/}` |
| `memberProvider` | string | `spawn` | `ctx.subagents` provider used to start members (`spawn` or `fork`) |
| `memberMaxDepth` | number | `0` | Member delegation-depth cap; `0` forbids members from spawning sub-agents |
| `maxMembers` | number | `11` (computed) | Roster cap; the default is the widest pipeline template's roster length (`DEFAULT_MAX_MEMBERS`), not a literal. The iron triangle and the security engineer are never trimmed |
| `slashCommand` | boolean | `true` | Register the deterministic `/factory` activation surfaces |

Roster trimming order when over the cap: `perf → po → tech_writer → ui_designer → db_arch → sys_arch →
api_designer → reviewer → devops → security_eng → fe_dev → be_dev` (the last `*_dev` is never trimmed).

## Documentation

| File | Content |
|---|---|
| [docs/roles-and-pipelines.md](docs/roles-and-pipelines.md) | 12-job role registry, id aliases, 5 pipeline templates, team-assembly rules, DoD |
| [docs/architecture.md](docs/architecture.md) | Layers, directory duties, dependency rules, disk layout, dual-program build, known limits |
| [docs/API-CONTRACTS.md](docs/API-CONTRACTS.md) | Verified DSH plugin contract (the single API authority; also the encoding/tooling rules) |

## Repository layout

```
src/
  index.ts          host entry: apply() / Config / inject        (landed)
  command.ts        /factory slash command                       (landed)
  shared/           dual-program type contract                    (landed)
  domain/           pure logic: roles, task types, pipelines, gates, DoD, router  (landed)
  store/            factory.json / inbox / artifacts / archive, atomic writes + lock  (landed)
  runtime/          member lifecycle + gate runner + scheduler     (landed)
  tools/            factory_* captain & member tool surface        (landed: 13 + 3 tools)
  prompt/           captain protocol + member brief                (landed, wired at order 118)
  web/              HTTP status route + snapshot projection        (landed; skipped without a webServer)
  client/           cockpit panel (browser half)                   (landed → lib/client.js)
scripts/            verify.mjs (L1 offline, 103 checks) · doctor.mjs (9 install checks) · check-docs.mjs (doc numbers)
docs/               API contract, role/pipeline spec, architecture, E2E acceptance
```

> ⛔ **Never append a custom (non-surface) session event type.** An out-of-repo plugin's event type is
> outside the harness's `known-event-types` set by construction, and `Session.append` cannot set the
> envelope's `ignorable` marker — so writing one makes that session **permanently unreadable**
> (`dsh --session-id <id>` then fails with `unknown to this harness and not marked ignorable`).
> The durable truth is the factory directory (`factory.json` / `inbox/*.jsonl` / `artifacts.json`),
> the harness records first-party `tool/call` + `tool/result` for every `factory_*` call itself, and the
> panel feed comes from the mailbox. See [docs/API-CONTRACTS.md](docs/API-CONTRACTS.md) §1.7.

## Known limitations

- **Not for taking over an existing codebase (brownfield / takeover).** Nothing scans the workspace before
  work starts, and the member brief says nothing about what is already there: it tells each role it may
  *create or modify* its artifacts (`PRD.md`, `ARCHITECTURE.md`, `DB_DESIGN.md`, `README.md`, …). Adopting
  the factory on an existing project can therefore **overwrite documents you already own**, and the
  structure-based `checklist` gates will fail a document whose headings differ from the template. Decide
  before you adopt: copy the workspace or open a branch, archive your legacy docs, or scope the factory to
  a new subdirectory. Read this one first: **[docs/limitations.md](docs/limitations.md)**.
- **Everything else that is known to be limited** lives in the same document, with the mechanism and
  `file:line` evidence for each item: [docs/limitations.md](docs/limitations.md) — cross-process coordination
  is cooperative (state writes take a lock file, but a writer that bypasses this plugin is not stopped),
  artifact boundaries are a completion-time
  audit rather than write interception, the state index is cross-workspace, gate commands carry template
  stack assumptions (and are never model-chosen), and custom session events must never be written.
- **`src/domain/` is bundled into the browser half**, so nothing host-side may leak into it.
- **Status (as of this refresh, t29).** Everything is landed and wired: the domain layer
  (`src/domain/`, 10 modules / 3871 lines), the store (`src/store/`, 7 modules / 5108 lines), the member
  runtime (`src/runtime/`) and gate runner, the tool surface + host entry (`src/tools/` + `src/index.ts`,
  16 `factory_*` tools), the prompt section (`src/prompt/`, 4 modules, wired at order 118), the HTTP state
  route (`src/web/`, 2 modules), the cockpit client (`src/client/`, 6 modules → `lib/client.js`) and the
  `/factory` command. Verification: `pnpm build` exit 0, `node scripts/verify.mjs` 103/103, `pnpm run
  doctor:install` 9/9, `node scripts/check-docs.mjs` (every number in these docs). Multi-process
  coordination is now enforced too: every state mutation takes a lock file under `<root>/.locks/`, so a
  second host on the same workspace waits (and is told who it is waiting for) instead of silently
  overwriting. The operator's manual has since landed: [docs/usage.md](docs/usage.md)
  (two-phase protocol, 16 tools, state model, gate types, rework loop, human-approval points,
  troubleshooting); capability boundaries are in [docs/limitations.md](docs/limitations.md).
  Module/line counts live in [docs/architecture.md](docs/architecture.md) §3, enforced by
  `scripts/check-docs.mjs`.

## License

MIT © dsh-code-factory contributors
