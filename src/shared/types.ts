/**
 * Shared domain contract for code-factory.
 *
 * ZERO imports, on purpose: this module is compiled by BOTH tsc programs and is
 * bundled into the browser half. Keep it types-only plus small pure constants so
 * the client never drags host code into the bundle.
 *
 * @module dsh-code-factory/shared/types
 */

/* ------------------------------------------------------------------ roles */

/** Model tier a role prefers. Purely advisory: the member route is snapshotted at spawn. */
export type RoleTier = 'chat' | 'reasoner'

/** One job in the role registry. */
export interface RoleDef {
  /** Stable role id, also the mailbox key and the member name inside a factory. */
  readonly id: string
  /** Human-facing Chinese title, e.g. 产品经理. */
  readonly title: string
  /** Short uppercase badge shown on the cockpit roster, e.g. PM. */
  readonly codename: string
  readonly tier: RoleTier
  /** Classification swatch for the roster chip. NOT a semantic status colour. */
  readonly color: string
  /** One-line duty summary shown in the cockpit. */
  readonly duties: string
  /**
   * Artifact whitelist: workspace-relative POSIX path prefixes this role may
   * create or modify. Used for the member brief and for the completion-time
   * scope audit. A trailing `/` means "directory subtree".
   */
  readonly outputs: readonly string[]
  /** Non-negotiable rules injected into the member persona. */
  readonly ironRules: readonly string[]
  /** Role persona body injected as the member's `persona`. */
  readonly systemPrompt: string
  /** Extra tools this role may use, on top of the member tool surface. */
  readonly tools?: readonly string[]
}

/* ------------------------------------------------------------- task types */

/** One routable task family and the roster it implies. */
export interface TaskTypeDef {
  readonly id: string
  readonly label: string
  /** Lower-cased substring keywords matched against the brief. */
  readonly keywords: readonly string[]
  /** Default roster, in suggested join order. */
  readonly team: readonly string[]
  /** Pipeline template id. */
  readonly pipeline: PipelineId
}

export type SecuritySignalSource = 'none' | 'brief' | 'document'

/**
 * Runtime whitelist for {@link SecuritySignalSource}. The store sanitises a
 * persisted `securitySource` against it, and a hand-copied second list would
 * drift exactly the way `src/client/api.ts` used to (review finding H8).
 */
export const SECURITY_SIGNAL_SOURCES = [
  'none',
  'brief',
  'document',
] as const satisfies readonly SecuritySignalSource[]

/** Router output: which family matched, which roster, which pipeline. */
export interface TeamDecision {
  readonly taskType: string
  readonly team: readonly string[]
  readonly pipeline: PipelineId
  readonly reasoning: string
  readonly matchedKeywords: readonly string[]
  /** True when a human approval gate must confirm the roster before work starts. */
  readonly securityTriggered: boolean
  /** The words that caused the security path, in registry order. */
  readonly securityHits?: readonly string[]
  /** Which input those words came from. See {@link SecuritySignalSource}. */
  readonly securitySource?: SecuritySignalSource
  /** Optional roles the cap dropped, in drop order. Absent when nothing was cut. */
  readonly trimmed?: readonly string[]
  /**
   * Template-required roles the cap force-dropped. Their stages fall back to
   * `ROLE_FALLBACKS` at dispatch time, so a caller must surface this (raise
   * `maxMembers` to the task type's roster length to clear it).
   */
  readonly trimmedRequired?: readonly string[]
  /** True when the cap could not even hold the mandatory floor (triad + security). */
  readonly overCap?: boolean
  /**
   * Frontend platform the router detected for the roster's frontend slot.
   *
   * Absent when the routed family has no frontend slot (e.g. `api_only`): the
   * detection only decides **which specialist fills the `fe_dev` slot**, it
   * never invents a frontend role for a family that has none.
   */
  readonly frontendPlatform?: FrontendPlatform
  /** Specialist role that replaced the generic `fe_dev` slot (`web_dev` / `flutter_dev` / `mini_program_dev`). */
  readonly frontendRole?: string
}

/**
 * Frontend platform a brief can imply, used to pick the frontend specialist.
 *
 * - `web`          — desktop/browser UI (the default when nothing narrower is named)
 * - `flutter`      — a Flutter/Dart application
 * - `mini_program` — a WeChat/Alipay/ByteDance/quick-app mini program
 */
export type FrontendPlatform = 'web' | 'flutter' | 'mini_program'

/* ----------------------------------------------------------------- gates */

/** The five gate kinds. */
export type GateType = 'checklist' | 'keyword' | 'script' | 'composite' | 'dod'

/** One gate rule. Composite nests further rules. */
export interface GateDef {
  readonly type: GateType
  /**
   * Workspace-relative POSIX path of the artifact this gate inspects.
   * Required for `checklist` and `keyword`; optional elsewhere.
   */
  readonly artifact?: string
  /** `checklist`: every one of these headings must appear in the artifact. */
  readonly requiredSections?: readonly string[]
  /** `keyword`: a line containing this substring means pass. */
  readonly passWord?: string
  /** `keyword`: a line containing this substring means explicit fail. */
  readonly failWord?: string
  /** `script`: the command to run. Exit code 0 means pass. */
  readonly run?: string
  /** `composite`: every nested gate must pass (logical AND). */
  readonly checks?: readonly GateDef[]
}

/** Machine-checkable verdict of one gate evaluation. */
export interface GateResult {
  readonly type: GateType
  readonly ok: boolean
  /** Human-readable evidence, always populated (even on pass). */
  readonly detail: string
  /** Exit code for `script` gates. */
  readonly exitCode?: number
  /** Artifact the gate inspected, when applicable. */
  readonly artifact?: string
  readonly at: number
}

/* -------------------------------------------------------------- pipeline */

export type PipelineId = string

/** One stage of a pipeline template. */
export interface StageDef {
  readonly id: string
  readonly name: string
  /** Roles that work this stage. More than one means they run in parallel. */
  readonly roles: readonly string[]
  readonly gate: GateDef
  /** True when the user must confirm before the stage is considered passed. */
  readonly humanApproval?: boolean
  /** True when `roles` work concurrently. */
  readonly parallel?: boolean
  /** Stage id to return to when this stage's gate fails. Omit to retry in place. */
  readonly failGoto?: string
  /** Gate failures tolerated before the engine escalates to the human. */
  readonly maxRounds: number
}

/** All pipeline templates, keyed by id. */
export type Pipelines = Readonly<Record<PipelineId, readonly StageDef[]>>

/* ------------------------------------------------------------------- DoD */

/** How a DoD item is machine-verified. */
export type DodKind = 'file' | 'keyword' | 'script' | 'git' | 'crossref'

/** One Definition-of-Done item. */
export interface DodItemDef {
  readonly id: number
  readonly label: string
  readonly kind: DodKind
  /** Workspace-relative artifact this item inspects. */
  readonly artifact?: string
  /** `keyword`: substring that must be present. `file`: must exist. */
  readonly expect?: string
  /** `script`: command that must exit 0. */
  readonly run?: string
  /** Skip this item when the factory did not trigger the security path. */
  readonly securityOnly?: boolean
}

/**
 * Machine-readable verdict of one DoD item — **three states, never a boolean**
 * (review finding H5: `ok: true` used to mean both "checked and fine" and
 * "never checked", so a skipped security audit read as a satisfied one).
 *
 * - `passed`  machine-verified and met its expectation
 * - `skipped` did not apply to this factory (only `securityOnly` items on a
 *             factory that never took the security path): never blocks
 *             delivery, but also never counts as a pass
 * - `failed`  verified and did not meet its expectation
 * - `pending` no verdict yet — the item still owes a file read or a command,
 *             so it must never pass a delivery gate
 *
 * Like {@link StageStatus}, this union mixes a transient state with outcomes.
 * Keep it as the one field every reader switches on, and derive
 * {@link DodState.ok} from it — `ok === (status === 'passed' || status === 'skipped')`
 * — instead of collapsing the three states back into a boolean.
 */
export type DodStatus = 'passed' | 'skipped' | 'failed' | 'pending'

/** Evaluated DoD item. */
export interface DodState {
  readonly id: number
  readonly label: string
  /** Legacy roll-up boolean: true unless the verdict is `failed` / `pending`. Prefer `status`. */
  readonly ok: boolean
  /** Three-state verdict; absent only on records persisted before it existed. */
  readonly status?: DodStatus
  readonly evidence?: string
  /**
   * Definition facts from `domain/dod.ts`, projected so the panel can explain
   * what the item checks instead of showing only its outcome. Optional: a record
   * written by an older plugin (or a sparse fixture) still parses.
   */
  readonly kind?: DodKind
  /** Workspace-relative artifact the item inspects. */
  readonly artifact?: string
  /** `keyword`: substring that must be present. `file`: must exist. */
  readonly expect?: string
  /** `script`: the command the audit runs (template constant, never model input). */
  readonly run?: string
  /** True when the item only applies on the security path. */
  readonly securityOnly?: boolean
}

/* ------------------------------------------------------------- evolution */

/**
 * Where a lesson came from.
 *
 * - `gate` — a stage gate rejected the work (the corrective list is the lesson)
 * - `dod`  — the final Definition-of-Done audit failed an item
 */
export type LessonKind = 'gate' | 'dod'

/**
 * One durable, cross-factory lesson learned in a workspace.
 *
 * The ledger is the plugin's *evolution* memory: a mistake that cost a rework
 * round or failed a DoD item is recorded once, deduplicated by its normalised
 * text, and then injected into the briefs/dispatches of later factories so the
 * same mistake is not repeated. It is deliberately factory-agnostic: `factoryId`
 * records where it was last seen, not who may read it.
 */
export interface LessonRecord {
  /** Stable id (hash of the signature) so a repeat updates instead of duplicating. */
  readonly id: string
  /** Canonical role id the lesson is addressed to (the role that owns the fix). */
  readonly role: string
  /** Stage id the mistake happened in. */
  readonly stage: string
  /** Human-facing stage name, captured at record time (templates may change). */
  readonly stageName?: string
  /** Gate type (`checklist` / `keyword` / `script` / `composite` / `dod`) or `dod`. */
  readonly gateType: string
  readonly kind: LessonKind
  /** The actionable lesson: what went wrong and what to do instead. */
  readonly text: string
  /** The gate's own verdict line, quoted for auditability. */
  readonly detail?: string
  /** How many times this exact lesson has been seen. Recurrence is the loud signal. */
  readonly count: number
  readonly firstAt: number
  readonly lastAt: number
  /** Set when a later round for the same factory/stage/role passed the gate. */
  readonly resolvedAt?: number
  /** The factory where the lesson was last seen (`` undefined `` for legacy rows). */
  readonly factoryId?: string
  /** Task family the factory was routed to, so lessons can be prioritised by context. */
  readonly taskType?: string
}

/** Runtime whitelist for {@link LessonKind}. See {@link MEMBER_STATUSES}. */
export const LESSON_KINDS = ['gate', 'dod'] as const satisfies readonly LessonKind[]

/** Roll-up of the workspace's evolution ledger. */
export interface EvolutionStats {
  /** Distinct lessons kept (capped by the store). */
  readonly total: number
  /** Lessons seen more than once — the ones that keep costing rework. */
  readonly recurring: number
  /** Lessons a later round in the same factory resolved. */
  readonly resolved: number
  /** Newest `lastAt`, or absent when the ledger is empty. */
  readonly lastAt?: number
}

/* ---------------------------------------------------------- improvements */

/**
 * Where a recurring lesson should be fixed **in the plugin itself**.
 *
 * This is deliberately about where a human/captain would make a code-or-doc
 * change later; the runtime never edits its own source. `targetFile` points at
 * the most likely file so the proposal is actionable without another search.
 */
export type ImprovementTarget = 'role-rule' | 'captain-rule' | 'gate' | 'dod' | 'pipeline' | 'doc'

/** `open` = the mistake is still recurring; `validated` = a later round fixed it. */
export type ImprovementStatus = 'open' | 'validated'

/**
 * One actionable plugin-improvement proposal derived from recurring lessons.
 *
 * Proposals are **derived, not stored**: the evolution ledger stays the single
 * durable record, and every reader recomputes the same list from it. That keeps
 * the feedback loop honest (no proposal can drift from its evidence) and means a
 * proposal needs no accept/reject state to be useful — `validated` is evidence
 * that a fix already worked once.
 */
export interface ImprovementProposal {
  /** Stable id derived from the source lesson, so the list is diff-stable. */
  readonly id: string
  /** Short Chinese headline shown in the cockpit. */
  readonly title: string
  readonly target: ImprovementTarget
  /** Workspace-relative plugin file the change most likely belongs in. */
  readonly targetFile?: string
  /** What to add/change, phrased as a concrete instruction. */
  readonly suggestion: string
  /** Why this is worth changing, including the recurrence evidence. */
  readonly rationale: string
  /** Role the lesson belongs to, for filtering/display. */
  readonly role?: string
  /** Stage id the lesson happened in. */
  readonly stage?: string
  /** Gate type that produced the lesson, when applicable. */
  readonly gateType?: string
  /** Source lesson ids (one today; the field is a list for future grouping). */
  readonly lessonIds: readonly string[]
  /** How many times the underlying mistake has been seen. */
  readonly evidenceCount: number
  readonly status: ImprovementStatus
  readonly lastAt: number
}

/** Runtime whitelist for {@link ImprovementTarget}. See {@link MEMBER_STATUSES}. */
export const IMPROVEMENT_TARGETS = [
  'role-rule',
  'captain-rule',
  'gate',
  'dod',
  'pipeline',
  'doc',
] as const satisfies readonly ImprovementTarget[]

/** Runtime whitelist for {@link ImprovementStatus}. */
export const IMPROVEMENT_STATUSES = ['open', 'validated'] as const satisfies readonly ImprovementStatus[]

/**
 * The cockpit's read-only evolution projection.
 *
 * `lessons` is filtered to the factory's own roster and recent high-frequency
 * mistakes, newest/hottest first — never the whole ledger, because the panel is
 * a focus surface, not an archive. `improvements` is derived from the same
 * lessons (recurring ones only) and tells the human which plugin rule/file is
 * worth changing next.
 */
export interface EvolutionView {
  readonly stats: EvolutionStats
  readonly lessons: readonly LessonRecord[]
  /** Recurring lessons turned into plugin-improvement proposals (newest/hottest first). */
  readonly improvements?: readonly ImprovementProposal[]
}

/* ------------------------------------------------------------ reuse library */

/**
 * What a reusable asset is.
 *
 * The library is deliberately about **transferable work**, not about a factory:
 * a delivered module, copy, design spec, test kit or ops recipe can be copied
 * into a later workspace and adapted, instead of being re-invented from a brief.
 */
export type ReuseKind = 'module' | 'content' | 'design' | 'test' | 'ops' | 'other'

/** Runtime whitelist for {@link ReuseKind}. See {@link MEMBER_STATUSES}. */
export const REUSE_KINDS = [
  'module',
  'content',
  'design',
  'test',
  'ops',
  'other',
] as const satisfies readonly ReuseKind[]

/** One file stored inside a reuse entry. */
export interface ReuseFile {
  /** POSIX workspace-relative path as stored in the library. */
  readonly path: string
  /** Byte size at harvest time. */
  readonly bytes: number
  /** SHA-256 of the stored bytes, for integrity checks and stable ids. */
  readonly sha256: string
}

/**
 * One harvested, cross-project reusable asset.
 *
 * `id` is deterministic over the source factory + input paths + file hashes, so
 * re-harvesting an unchanged selection updates the same entry instead of
 * duplicating it.
 */
export interface ReuseEntry {
  readonly id: string
  readonly name: string
  readonly kind: ReuseKind
  readonly description: string
  readonly tags: string[]
  /** Task families this asset was useful for (`web_fullstack`, …). */
  readonly taskTypes: string[]
  readonly sourceFactoryId: string
  readonly sourceFactoryName: string
  /** Absolute workspace the asset was harvested from (audit trail). */
  readonly sourceWorkspace: string
  readonly files: ReuseFile[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** One ranked search hit: the entry plus its relevance score. */
export interface ReuseMatch {
  readonly entry: ReuseEntry
  readonly score: number
}

/* ----------------------------------------------------------------- state */

/** Factory lifecycle. `staged` never has spawned members. */
export type FactoryPhase = 'staged' | 'running' | 'halted' | 'delivered' | 'discarded'

/** Sub-state while `staged`. */
export type PlanReviewState = 'awaiting_review' | 'awaiting_feedback'

/** Member lifecycle inside one factory. */
export type MemberStatus =
  | 'staged'
  | 'idle'
  | 'working'
  | 'rework'
  | 'blocked'
  | 'done'
  | 'error'
  | 'removed'

/** Stage lifecycle. */
export type StageStatus = 'pending' | 'active' | 'gate' | 'passed' | 'rejected'

/** One member of one factory. */
export interface MemberState {
  readonly role: string
  /** Durable continuable child session id. Empty until spawned. */
  sessionId?: string
  status: MemberStatus
  /** Stage this member is currently working, when active. */
  currentStage?: string
  /** Resolved LLM route, snapshotted at spawn time. */
  provider?: string
  model?: string
  reasoningEffort?: string
  /** Last start failure, so the captain can see why a member never acquired a session. */
  spawnError?: string
  tokens: number
  startedAt?: number
  endedAt?: number
}

/** One stage instance of one factory. */
export interface StageStateRec {
  readonly id: string
  status: StageStatus
  /** Gate-failure rounds consumed so far. */
  round: number
  /** Dispatch count, for scheduler diagnostics. */
  attempts: number
  startedAt?: number
  endedAt?: number
  /** The most recent gate verdict for this stage. */
  lastGate?: GateResult
}

/**
 * One recorded dispatch: what was handed out, to whom, and whether it came back.
 *
 * Lives in the **shared** contract rather than in `runtime/scheduler` because it
 * is now part of the durable record (`FactoryState.dispatchAttempts`). It used to
 * be a process-local `Map` in the tool layer, which meant a host restart erased
 * every open attempt; the scheduler then saw `member.status === 'working'` with an
 * executor it could not judge and answered `wait` for up to the 30-minute stale
 * threshold (review finding M13). Persisting it makes the recovery decision
 * available immediately after a cold start.
 */
export interface DispatchAttempt {
  readonly stageId: string
  /** Round the dispatch belonged to (0 = first attempt at that stage). */
  readonly round: number
  readonly role: string
  readonly sessionId?: string
  readonly dispatchedAt: number
  /** Set once the member reported back (or the attempt was superseded). */
  readonly settledAt?: number
  readonly kind: 'initial' | 'rework'
}

/** One mailbox message. */
export interface FactoryMessage {
  readonly id: string
  /** `captain` or a role id. */
  readonly from: string
  /** `captain` or a role id. */
  readonly to: string
  readonly content: string
  readonly ts: number
  /** Coarse category, used for cockpit colouring. */
  readonly kind?: MessageKind
  /** Stage this message relates to. */
  readonly stage?: string
  /** Gate round this message relates to. */
  readonly round?: number
  /** Set once the recipient's live inbox accepted it. */
  deliveredAt?: number
  /** Set once the recipient consumed it. */
  readAt?: number
}

export type MessageKind =
  | 'dispatch'
  | 'reject'
  | 'handoff'
  | 'report'
  | 'blocked'
  | 'approval'
  | 'system'

/** One registered artifact. */
export interface ArtifactRecord {
  readonly path: string
  readonly by: string
  readonly stage: string
  readonly bytes: number
  readonly at: number
}

/** The durable factory record — the single source of truth. */
export interface FactoryState {
  /** Short stable id (8 hex chars). Also the on-disk directory name. */
  readonly id: string
  /**
   * On-disk shape version of this record (review finding M8). The store's read
   * path refuses a record whose version it does not understand instead of
   * interpreting it under the current schema.
   *
   * **Absent means schema 0** — "written before versioning existed" — which is a
   * meaningful value, not missing data. It is optional so that every record
   * written by an older plugin, and every test fixture that predates the field,
   * still typechecks; the store walks those forward through its migration chain
   * and stamps the current version on the next write.
   *
   * Deliberately *not* exported as a runtime constant from here: `shared` is the
   * zero-import contract both halves compile, and the authoritative number lives
   * next to the store that enforces it (`FACTORY_SCHEMA_VERSION`).
   */
  readonly schemaVersion?: number
  readonly name: string
  /** The user's original brief, plus any clarifications folded in. */
  readonly brief: string
  readonly taskType: string
  readonly pipeline: PipelineId
  /** Session id of the captain agent that owns this factory. */
  readonly captainSessionId: string
  phase: FactoryPhase
  planReviewState?: PlanReviewState
  approvedAt?: number
  /**
   * Set when the router forced a security role that the roster cap must not trim.
   *
   * **Not readonly on purpose** (review finding H4): the plan-time verdict reads
   * one line of prose, so it can be wrong. It is re-derived from the artifacts
   * after every gate and may only be flipped **from `false` to `true`** — never
   * back. The `readonly` this field used to carry was the defect stated in the
   * type system: nothing in the runtime was able to correct it.
   */
  securityTriggered: boolean
  /**
   * The words that put this factory on the security path, in registry order.
   *
   * Recorded so the verdict is auditable after the fact: the brief is one
   * sentence and the PRD is a document, so the same boolean can mean "the brief
   * said 支付" or "nothing in the brief matched, but the requirements stage read
   * 手机号/收货地址 out of the PRD" (H4). Optional because a record written
   * before this field existed still loads; absent means "unknown", not "none".
   * The store drops evidence that contradicts a `false` verdict, with a warning.
   */
  securityHits?: readonly string[]
  /** Which input those words came from. See {@link SecuritySignalSource}. */
  securitySource?: SecuritySignalSource
  members: MemberState[]
  stages: StageStateRec[]
  dod: DodState[]
  /**
   * The dispatch ledger: every hand-out the captain has applied, newest last.
   *
   * Optional so a `factory.json` written before this field existed still loads;
   * `FactoryStore` normalises a missing value to `[]`. Capped by the tool layer
   * (`LEDGER_LIMIT`) because the array is rewritten on every state save.
   */
  dispatchAttempts?: DispatchAttempt[]
  createdAt: number
  updatedAt: number
  deliveryPath?: string
}

/* -------------------------------------------------------------- snapshot */

/** Compact per-role row for the cockpit roster. */
export interface SnapshotMember {
  readonly role: string
  readonly title: string
  readonly codename: string
  readonly color: string
  readonly duties: string
  readonly tier: RoleTier
  readonly status: MemberStatus
  readonly currentStage?: string
  readonly tokens: number
  readonly sessionId?: string
  readonly spawnError?: string
  /** Resolved route snapshotted at spawn time (the panel can show it). */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** Member start/end stamps, when the record carries them. */
  readonly startedAt?: number
  readonly endedAt?: number
}

/** Compact per-stage row for the cockpit pipeline bar. */
export interface SnapshotStage {
  readonly id: string
  readonly name: string
  readonly status: StageStatus
  readonly round: number
  readonly roles: readonly string[]
  readonly parallel: boolean
  readonly humanApproval: boolean
  readonly failGoto?: string
  /**
   * The gate this stage is judged by, or {@link UNKNOWN_GATE_TYPE} when the
   * template is gone *and* the stage never recorded a verdict.
   */
  readonly gateType: GateType | typeof UNKNOWN_GATE_TYPE
  /** Gate-failure budget from the template, when it still resolves. */
  readonly maxRounds?: number
  /** Dispatch count for this stage. */
  readonly attempts?: number
  readonly startedAt?: number
  readonly endedAt?: number
  /** The most recent gate verdict (evidence detail, exit code, artifact, time). */
  readonly lastGate?: GateResult
  /**
   * The template's gate rule, projected for the stage inspector.
   *
   * Optional: an unknown stage id has no template, and a fixture written before
   * this field existed must keep parsing.
   */
  readonly gate?: GateDef
}

/* ---------------------------------------------------------------- alerts */

/**
 * Why the cockpit is asking a human (or the captain agent) to act.
 *
 * Every kind is **derived from the durable record**, so the alert list is a pure
 * function of `factory.json` plus the pipeline template. That is deliberate:
 * an alert cannot be dismissed into a false green, and it survives a reload, a
 * cold restart, and a lost in-process notification.
 */
export type AlertKind =
  | 'awaiting-plan-review'
  | 'awaiting-approval'
  | 'rounds-exhausted'
  | 'stage-rejected'
  | 'member-blocked'
  | 'member-error'
  | 'halted'

/** How loudly the panel should say it. `action` means "nothing moves without you". */
export type AlertSeverity = 'action' | 'attention'

/**
 * Runtime whitelists for the alert unions, kept **next to the union** so the
 * browser half imports them instead of hand-copying a second list.
 *
 * `src/client/api.ts` used to re-declare every server enum by hand; a drift there
 * was invisible because the parser falls back to a default instead of throwing
 * (review finding H8). New enums must not repeat that mistake.
 */
export const ALERT_KINDS = [
  'awaiting-plan-review',
  'awaiting-approval',
  'rounds-exhausted',
  'stage-rejected',
  'member-blocked',
  'member-error',
  'halted',
] as const satisfies readonly AlertKind[]

/** Runtime whitelist for {@link AlertSeverity}. See {@link ALERT_KINDS}. */
export const ALERT_SEVERITIES = ['action', 'attention'] as const satisfies readonly AlertSeverity[]

/**
 * Compile-time proof that the whitelists above are **exhaustive**.
 *
 * `satisfies` only rejects values that are not in the union; it happily accepts a
 * list that is *missing* one. `Exclude<…>` resolving to something other than
 * `never` fails the constraint here, so adding a kind to the union without adding
 * it to the list is a build error rather than a silent fallback at runtime.
 */
type AssertNever<T extends never> = T
type _AlertKindsAreExhaustive = AssertNever<Exclude<AlertKind, (typeof ALERT_KINDS)[number]>>
type _AlertSeveritiesAreExhaustive = AssertNever<Exclude<AlertSeverity, (typeof ALERT_SEVERITIES)[number]>>

/**
 * Runtime whitelists for the five state unions, for the same reason as
 * {@link ALERT_KINDS} — and until review finding H8 was closed the browser half
 * DID hand-copy all five.
 *
 * They live here rather than in `src/store/state.ts` (where three of them used
 * to sit) because `shared` is the only layer both halves may depend on: the
 * layering rule in `docs/architecture.md` puts `store` and `domain` ABOVE
 * `shared`, so a client importing the store would invert it.
 *
 * `src/store/state.ts` and `src/domain/gates.ts` re-export these rather than
 * re-declaring them, so every existing import path keeps working and there is
 * exactly one list per union.
 */
export const MEMBER_STATUSES = [
  'staged',
  'idle',
  'working',
  'rework',
  'blocked',
  'done',
  'error',
  'removed',
] as const satisfies readonly MemberStatus[]

/** Every stage status, in lifecycle order. See {@link MEMBER_STATUSES}. */
export const STAGE_STATUSES = [
  'pending',
  'active',
  'gate',
  'passed',
  'rejected',
] as const satisfies readonly StageStatus[]

/** Every factory phase. See {@link MEMBER_STATUSES}. */
export const FACTORY_PHASES = [
  'staged',
  'running',
  'halted',
  'delivered',
  'discarded',
] as const satisfies readonly FactoryPhase[]

/** Every gate type. See {@link MEMBER_STATUSES}. */
export const GATE_TYPES = [
  'checklist',
  'keyword',
  'script',
  'composite',
  'dod',
] as const satisfies readonly GateType[]

/**
 * Reported in place of a gate type when **no source can be resolved**.
 *
 * A stage's gate type is projected from two places: the pipeline template's gate,
 * or — when the template is gone — the type recorded on the stage's last verdict.
 * With neither, the cockpit projection, the captain's status row and the panel's
 * parser all used to assert `'checklist'`: a real gate type, and the most
 * permissive-looking one, so every surface named a rule no record contained.
 *
 * This marker replaces that guess. It is deliberately **not** a member of
 * {@link GateType}, so it can never be evaluated as a rule, and it lives here
 * because this module — zero imports, imported by both halves — is the one place
 * every projection can agree on.
 */
export const UNKNOWN_GATE_TYPE = 'unknown'

/** Every DoD item verdict. See {@link MEMBER_STATUSES}. */
export const DOD_STATUSES = [
  'passed',
  'skipped',
  'failed',
  'pending',
] as const satisfies readonly DodStatus[]

/**
 * Every mailbox message kind. See {@link MEMBER_STATUSES}.
 *
 * Not named by review finding H8, which counted five unions — this is the sixth:
 * the same list was hand-copied into `src/tools/engine.ts` (the caption's
 * validator) and `src/client/api.ts` (the panel's parser), so a new kind added
 * to one would have been rejected by the other with no build error.
 */
export const MESSAGE_KINDS = [
  'dispatch',
  'reject',
  'handoff',
  'report',
  'blocked',
  'approval',
  'system',
] as const satisfies readonly MessageKind[]

/**
 * Compile-time proof that the five whitelists are **exhaustive**, not merely
 * well-typed — the same device as {@link _AlertKindsAreExhaustive}.
 *
 * This is what makes the H8 failure mode impossible rather than unlikely: add a
 * member status to the union and forget the list, and the build fails here
 * instead of the panel silently rendering the fallback forever.
 */
type _MemberStatusesAreExhaustive = AssertNever<Exclude<MemberStatus, (typeof MEMBER_STATUSES)[number]>>
type _StageStatusesAreExhaustive = AssertNever<Exclude<StageStatus, (typeof STAGE_STATUSES)[number]>>
type _FactoryPhasesAreExhaustive = AssertNever<Exclude<FactoryPhase, (typeof FACTORY_PHASES)[number]>>
type _GateTypesAreExhaustive = AssertNever<Exclude<GateType, (typeof GATE_TYPES)[number]>>
type _DodStatusesAreExhaustive = AssertNever<Exclude<DodStatus, (typeof DOD_STATUSES)[number]>>
type _MessageKindsAreExhaustive = AssertNever<Exclude<MessageKind, (typeof MESSAGE_KINDS)[number]>>
type _SecuritySignalSourcesAreExhaustive = AssertNever<Exclude<SecuritySignalSource, (typeof SECURITY_SIGNAL_SOURCES)[number]>>
type _LessonKindsAreExhaustive = AssertNever<Exclude<LessonKind, (typeof LESSON_KINDS)[number]>>
type _ImprovementTargetsAreExhaustive = AssertNever<Exclude<ImprovementTarget, (typeof IMPROVEMENT_TARGETS)[number]>>
type _ImprovementStatusesAreExhaustive = AssertNever<Exclude<ImprovementStatus, (typeof IMPROVEMENT_STATUSES)[number]>>
type _ReuseKindsAreExhaustive = AssertNever<Exclude<ReuseKind, (typeof REUSE_KINDS)[number]>>

/**
 * One reason this factory is not green, with the single step that clears it.
 *
 * The panel renders these verbatim; the captain reads the same list from the
 * tool surface, so there is exactly one definition of "needs attention".
 */
export interface SnapshotAlert {
  /**
   * Stable across polls for the same underlying condition, so a renderer can
   * dedupe (and the server can log only the first occurrence of each).
   */
  readonly id: string
  readonly kind: AlertKind
  readonly severity: AlertSeverity
  /** Chinese one-liner, rendered verbatim. */
  readonly title: string
  /** The concrete evidence: round numbers, role ids, the raw error text. */
  readonly detail: string
  /** The one thing that clears this alert. */
  readonly next: string
  /** Stage this alert is about, when it is about a stage. */
  readonly stage?: string
  /** Role this alert is about, when it is about a member. */
  readonly role?: string
}

/** Everything the cockpit panel needs for one factory, in one payload. */
export interface FactorySnapshot {
  readonly id: string
  readonly name: string
  readonly brief: string
  readonly taskType: string
  readonly pipeline: PipelineId
  readonly phase: FactoryPhase
  readonly planReviewState?: PlanReviewState
  readonly securityTriggered: boolean
  readonly members: readonly SnapshotMember[]
  readonly stages: readonly SnapshotStage[]
  readonly dod: readonly DodState[]
  readonly artifacts: readonly ArtifactRecord[]
  readonly feed: readonly FactoryMessage[]
  /**
   * Everything blocking this factory, most urgent first. Empty means green.
   *
   * This is the panel's only "someone must act" channel: the host exposes no
   * notification API (`docs/limitations.md` §10), so a banner that cannot be
   * missed is the notification.
   */
  readonly alerts: readonly SnapshotAlert[]
  /**
   * The workspace's evolution memory, projected for this factory.
   *
   * Optional so a snapshot written by an older plugin (or a sparse fixture)
   * still parses: absent means "no ledger read", not "no lessons ever".
   */
  readonly evolution?: EvolutionView
  /** Set once the user approved the staged plan. */
  readonly approvedAt?: number
  /** The words that put this factory on the security path, when recorded. */
  readonly securityHits?: readonly string[]
  /** Which input the security words came from. */
  readonly securitySource?: SecuritySignalSource
  /** Delivery path recorded by `factory_deliver`. */
  readonly deliveryPath?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/* ------------------------------------------------------------ tool result */

/** What `factory_gate` decided. */
export type GateAction = 'advance' | 'reject' | 'escalate' | 'delivered' | 'await_approval'
