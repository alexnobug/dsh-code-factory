/**
 * Pure projection: the durable `FactoryState` → the cockpit's `FactorySnapshot`.
 *
 * `docs/API-CONTRACTS.md` §7 makes the HTTP route the client's only data channel,
 * so this module owns exactly one job: turn what is on disk into what the panel
 * renders, without touching the filesystem itself.
 *
 * What it adds on top of the state record:
 *  - **Role facts** — `title` / `codename` / `color` / `duties` / `tier` come from
 *    the role registry, not from `factory.json` (a member row only stores its
 *    status, route and counters). Unknown roles fall back to the raw id instead
 *    of being dropped, so a factory written by an older registry still renders.
 *  - **Stage facts** — `name` / `parallel` / `humanApproval` / `gateType` /
 *    `failGoto` / `maxRounds` / `gate` come from the pipeline template; the state
 *    record carries the live status, round, attempt/start/end stamps and the last
 *    gate verdict (`lastGate`), which are projected verbatim for the stage
 *    inspector. An unknown stage id (template changed after the factory was
 *    staged) degrades to the id plus the last gate's own type, or to
 *    `UNKNOWN_GATE_TYPE` when there is not even that — it has no `gate`.
 *  - **DoD definition facts** — each persisted `DodState` is joined with its
 *    `domain/dod.ts` definition (`kind` / `artifact` / `expect` / `run` /
 *    `securityOnly`) so the panel can explain what an item checks instead of
 *    showing only its verdict. An id with no definition stays outcome-only.
 *  - **Factory metadata** — `approvedAt` / `securityHits` / `securitySource` /
 *    `deliveryPath` are passed through when the record has them.
 *  - **Snapshot is a value, never a live view** — template-sourced arrays/objects
 *    (`roles`, `gate`, `requiredSections`, those inside `composite.checks`) are
 *    copied, so a consumer mutating the snapshot cannot edit the pipeline
 *    registry every factory reads.
 *  - **Side files** — artifacts and mailbox messages are folded in by the caller
 *    (the route reads them from `FactoryStore`) and bounded here.
 *
 * Ordering contract (the panel renders these arrays verbatim):
 *  - `members`   — roster order, as stored.
 *  - `stages`    — pipeline order, as stored.
 *  - `artifacts` — registration order, oldest first (the panel is an
 *    "ARTIFACTS · 工件登记表" registry, not a newest-first activity feed).
 *  - `feed`      — chronological, oldest first, keeping only the newest
 *    `feedLimit` messages.
 *  - `alerts`    — most urgent first (see `deriveAlerts`); derived, never stored.
 *
 * No I/O, no clock, no randomness: every function here is a pure fold, which is
 * why it can be asserted against fixtures in `scripts/verify.mjs`.
 *
 * @module dsh-code-factory/web/snapshot
 */
import { UNKNOWN_GATE_TYPE } from '../shared/types.js';
import { getDodItem } from '../domain/dod.js';
import { getStage } from '../domain/pipeline.js';
import { canonicalRoleId, getRole } from '../domain/roles.js';
import { deriveAlerts } from '../domain/alerts.js';
import { selectEvolutionLessons } from '../store/evolution.js';
/** Default size of the projected message feed. */
export const DEFAULT_FEED_LIMIT = 50;
/** Hard ceiling for `feedLimit`, so a bad config can never make the poll heavy. */
export const MAX_FEED_LIMIT = 500;
/** Max lessons the cockpit evolution panel receives (the full ledger stays on disk). */
export const EVOLUTION_SNAPSHOT_LIMIT = 12;
/**
 * Project one durable factory record into the cockpit payload.
 *
 * @param state - the record read from `factory.json`.
 * @param sources - artifacts and messages read from the factory directory.
 * @returns the snapshot the panel polls for.
 */
export function buildFactorySnapshot(state, sources = {}) {
    let snapshot = {
        id: state.id,
        name: state.name,
        brief: state.brief,
        taskType: state.taskType,
        pipeline: state.pipeline,
        phase: state.phase,
        securityTriggered: state.securityTriggered,
        // Factory metadata is optional on the record; absent stays absent (a sparse
        // fixture or an older plugin must not gain fabricated keys).
        ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
        ...(state.securityHits === undefined ? {} : { securityHits: [...state.securityHits] }),
        ...(state.securitySource === undefined ? {} : { securitySource: state.securitySource }),
        members: state.members.map(toSnapshotMember),
        stages: state.stages.map((stage) => toSnapshotStage(state.pipeline, stage)),
        dod: state.dod.map(toSnapshotDod),
        artifacts: sortArtifacts(sources.artifacts ?? []),
        feed: takeNewestMessages(sources.feed ?? [], sources.feedLimit ?? DEFAULT_FEED_LIMIT),
        alerts: deriveAlerts(state),
        ...(state.deliveryPath === undefined ? {} : { deliveryPath: state.deliveryPath }),
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
    };
    if (state.planReviewState !== undefined) {
        snapshot = { ...snapshot, planReviewState: state.planReviewState };
    }
    if (sources.evolution !== undefined) {
        // The ledger is workspace-wide; the panel only receives the lessons that are
        // relevant HERE (this roster's roles + globally recurring mistakes). `stats`
        // stays the full-ledger roll-up so the panel can say "N in the workspace".
        snapshot = {
            ...snapshot,
            evolution: {
                stats: sources.evolution.stats,
                lessons: selectEvolutionLessons(sources.evolution.lessons, {
                    roles: state.members.map((member) => canonicalRoleId(member.role)),
                    limit: EVOLUTION_SNAPSHOT_LIMIT,
                }),
            },
        };
    }
    return snapshot;
}
/**
 * One index row from a loaded record or a listing row.
 *
 * @param source - anything carrying identity, name, routing and freshness.
 * @returns the summary row.
 */
export function buildFactoryIndexEntry(source) {
    return {
        id: source.id,
        name: source.name,
        taskType: source.taskType,
        phase: source.phase,
        updatedAt: source.updatedAt,
    };
}
/**
 * The whole index: deduplicated by factory id (a factory visible through two
 * workspaces is reported once, keeping its freshest stamp) and ordered by
 * `updatedAt` descending — the order the header picker expects.
 *
 * @param sources - every known factory, from every discovered workspace.
 * @returns the sorted index rows.
 */
export function buildFactoryIndex(sources) {
    const byId = new Map();
    for (const source of sources) {
        const entry = buildFactoryIndexEntry(source);
        const previous = byId.get(entry.id);
        if (previous === undefined || previous.updatedAt < entry.updatedAt)
            byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}
/* ------------------------------------------------------------------- dod */
/**
 * One persisted DoD row joined with its static definition.
 *
 * `domain/dod.ts` owns the seven item definitions; projecting `kind` / `artifact`
 * / `expect` / `run` / `securityOnly` lets the panel explain **what** an item
 * checks rather than only whether it passed. An id with no definition (a record
 * written by a future/renamed registry) keeps only its outcome — no field is
 * invented. Every definition value is a template constant, never model input.
 */
function toSnapshotDod(item) {
    const def = getDodItem(item.id);
    return {
        id: item.id,
        label: item.label,
        ok: item.ok,
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
        ...(def === undefined
            ? {}
            : {
                kind: def.kind,
                ...(def.artifact === undefined ? {} : { artifact: def.artifact }),
                ...(def.expect === undefined ? {} : { expect: def.expect }),
                ...(def.run === undefined ? {} : { run: def.run }),
                ...(def.securityOnly === undefined ? {} : { securityOnly: def.securityOnly }),
            }),
    };
}
/* --------------------------------------------------------------- members */
/**
 * One roster row, enriched with the registry's presentation metadata.
 *
 * Every registry lookup is optional: an unknown role keeps its id as the title
 * and an empty swatch, which the panel renders as an unclassified chip. Optional
 * route/lifecycle fields are copied only when the durable record carries them —
 * an older `factory.json` (or a sparse fixture) must not gain `undefined` keys.
 */
function toSnapshotMember(member) {
    const role = getRole(member.role);
    const startedAt = finiteNumber(member.startedAt);
    const endedAt = finiteNumber(member.endedAt);
    return {
        role: member.role,
        title: role?.title ?? member.role,
        codename: role?.codename ?? member.role.toUpperCase(),
        color: role?.color ?? '',
        duties: role?.duties ?? '',
        tier: role?.tier ?? 'chat',
        status: member.status,
        tokens: Number.isFinite(member.tokens) ? member.tokens : 0,
        ...(member.currentStage === undefined ? {} : { currentStage: member.currentStage }),
        ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
        ...(member.spawnError === undefined ? {} : { spawnError: member.spawnError }),
        ...(member.provider === undefined ? {} : { provider: member.provider }),
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
    };
}
/* ---------------------------------------------------------------- stages */
/** A finite number from a possibly-sparse persisted field, or `undefined`. */
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** Shallow structural copy of one gate verdict, omitting absent optional fields. */
function projectGateResult(result) {
    return {
        type: result.type,
        ok: result.ok,
        detail: result.detail,
        at: result.at,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
    };
}
/**
 * Structural copy of one gate definition (recursive for `composite`).
 *
 * The snapshot must be a *value*, not a live view of the pipeline registry: the
 * route serialises it and a caller mutating a returned array would otherwise
 * edit the template every other factory reads. Copies are deterministic and do
 * not alter the template.
 */
function projectGateDef(gate) {
    return {
        type: gate.type,
        ...(gate.artifact === undefined ? {} : { artifact: gate.artifact }),
        ...(gate.requiredSections === undefined ? {} : { requiredSections: [...gate.requiredSections] }),
        ...(gate.passWord === undefined ? {} : { passWord: gate.passWord }),
        ...(gate.failWord === undefined ? {} : { failWord: gate.failWord }),
        ...(gate.run === undefined ? {} : { run: gate.run }),
        ...(gate.checks === undefined ? {} : { checks: gate.checks.map((child) => projectGateDef(child)) }),
    };
}
/**
 * One pipeline row: the live status from the state record, the template facts
 * from the pipeline registry, and the stage's own recorded history.
 *
 * `lastGate` and the optional lifecycle fields come from `factory.json` (proof
 * of what actually happened); `gate` / `maxRounds` come from the template (what
 * will be checked). Neither source is invented when absent.
 */
function toSnapshotStage(pipeline, stage) {
    const template = getStage(pipeline, stage.id);
    const failGoto = template?.failGoto;
    const attempts = finiteNumber(stage.attempts);
    const startedAt = finiteNumber(stage.startedAt);
    const endedAt = finiteNumber(stage.endedAt);
    return {
        id: stage.id,
        name: template?.name ?? stage.id,
        status: stage.status,
        round: Number.isFinite(stage.round) ? stage.round : 0,
        roles: template?.roles === undefined ? [] : [...template.roles],
        parallel: template?.parallel === true,
        humanApproval: template?.humanApproval === true,
        // A stage whose template disappeared still reports the gate it last ran;
        // with neither source there is nothing to report but the unknown marker —
        // `'checklist'` here would name a rule the record never contained.
        gateType: template?.gate.type ?? stage.lastGate?.type ?? UNKNOWN_GATE_TYPE,
        ...(failGoto === undefined ? {} : { failGoto }),
        ...(template === undefined ? {} : { maxRounds: template.maxRounds }),
        ...(attempts === undefined ? {} : { attempts }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(stage.lastGate === undefined ? {} : { lastGate: projectGateResult(stage.lastGate) }),
        ...(template === undefined ? {} : { gate: projectGateDef(template.gate) }),
    };
}
/* ------------------------------------------------------------- side files */
/** Registration order, oldest first; a stable copy so callers cannot mutate ours. */
function sortArtifacts(artifacts) {
    return [...artifacts].sort((left, right) => left.at - right.at || left.path.localeCompare(right.path));
}
/** Chronological order, keeping the newest `limit` messages (oldest first). */
function takeNewestMessages(feed, limit) {
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), MAX_FEED_LIMIT)) : DEFAULT_FEED_LIMIT;
    if (bounded === 0)
        return [];
    const ordered = [...feed].sort((left, right) => left.ts - right.ts);
    return ordered.length <= bounded ? ordered : ordered.slice(ordered.length - bounded);
}
//# sourceMappingURL=snapshot.js.map