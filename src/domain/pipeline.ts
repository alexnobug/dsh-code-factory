/**
 * pipeline.ts — the five pipeline templates.
 *
 * Order is data, not control flow: the engine walks `role → gate → failGoto`
 * and may never skip a stage. All five templates are complete — the skeleton's
 * omitted-stub templates (api / data) are filled in here — and every `failGoto`
 * points at an **earlier** stage of the same template (a gate can only send work
 * back, never forward).
 *
 * Stage order of the prototype pipeline (实施方案 §1.2 流水线表) is preserved
 * verbatim for `fullstack`:
 *
 *   requirement(人工审批) → design(并行 ui/sys/db) → contract(人工审批) →
 *   threat → implement(并行 fe/be) → review(打回 implement, 3 轮) →
 *   sec_audit(打回 implement) → test(composite, 打回 implement) →
 *   deliver → document(dod 总验收)
 *
 * Template stack assumptions (the factory is opinionated on purpose — gate
 * commands come from these templates and may NEVER be supplied by a model):
 *   - `npm run build --if-present` … JS/TS stacks (a missing build script is a
 *     no-op, never a false failure)
 *   - `python -m compileall -q …` … Python stacks (no `.py` files = success)
 *   - `python -m pytest -q`      … the DoD's test command
 *   - `bash start.sh --check`    … the delivery self-check the prototype names
 *
 * Stage staffing: the roster cap may trim a specialist (see `router.ts`), so
 * {@link resolveStageRoles} resolves each stage against the actual team and
 * falls back along `roles.ts` → `ROLE_FALLBACKS`, reporting substitutions and
 * genuinely unstaffed stages instead of failing at dispatch time.
 *
 * **`fe_dev` is a slot, not (any more) the default assignment.** The implement
 * stages keep the generic `fe_dev` role id, while `router.assembleTeam` replaces
 * the frontend slot with the detected platform specialist (`web_dev` /
 * `flutter_dev` / `mini_program_dev`). `resolveStageRoles` therefore maps the
 * generic slot onto the real specialist via `ROLE_FALLBACKS.fe_dev`, and an old
 * roster that really did staff `fe_dev` still resolves directly.
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects.
 *
 * @module dsh-code-factory/domain/pipeline
 */

import type { GateDef, PipelineId, Pipelines, StageDef } from '../shared/types.js'
import { validateGateDef } from './gates.js'
import { README_REQUIRED_SECTIONS } from './dod.js'
import { ROLE_FALLBACKS, canonicalRoleId, isRoleId } from './roles.js'

/* ------------------------------------------------------------ vocabulary */

/** Artifact paths the pipeline templates gate on (single source of truth). */
export const ARTIFACTS = {
  prd: 'PRD.md',
  uiSpec: 'UI_SPEC.md',
  architecture: 'ARCHITECTURE.md',
  dbDesign: 'DB_DESIGN.md',
  apiContract: 'API_CONTRACT.md',
  threatModel: 'THREAT_MODEL.md',
  securityAudit: 'SECURITY_AUDIT.md',
  review: 'REVIEW.md',
  testReport: 'TEST_REPORT.md',
  readme: 'README.md',
  delivery: 'DELIVERY.md',
  startScript: 'start.sh',
} as const

/** Conclusion lines the keyword gates accept — member briefs quote the same strings. */
export const CONCLUSIONS = {
  reviewPass: '结论: APPROVED',
  reviewFail: '结论: REJECTED',
  secPass: '结论: SEC_PASS',
  secFail: '结论: SEC_FAIL',
  testPass: '结论: PASS',
  testFail: '结论: FAIL',
} as const

/** Test command used by the test stage and by DoD item 2. */
export const TEST_COMMAND = 'python -m pytest -q'

/** Delivery self-check command used by the deliver stage and by DoD item 5. */
export const DELIVERY_CHECK_COMMAND = 'bash start.sh --check'

/** The prototype's stage order; `fullstack` must contain it, in order. */
export const PROTOTYPE_STAGE_ORDER: readonly string[] = [
  'requirement',
  'design',
  'contract',
  'threat',
  'implement',
  'review',
  'sec_audit',
  'test',
  'deliver',
  'document',
]

/** All template ids; the router only ever returns one of these. */
export const PIPELINE_IDS: readonly PipelineId[] = ['fullstack', 'api', 'data', 'lightweight', 'ml']

/* --------------------------------------------------------- gate builders */

function checklist(artifact: string, requiredSections: readonly string[]): GateDef {
  return { type: 'checklist', artifact, requiredSections: [...requiredSections] }
}

function keyword(artifact: string, passWord: string, failWord: string): GateDef {
  return { type: 'keyword', artifact, passWord, failWord }
}

function script(run: string, artifact?: string): GateDef {
  return artifact ? { type: 'script', run, artifact } : { type: 'script', run }
}

function composite(checks: readonly GateDef[]): GateDef {
  return { type: 'composite', checks: [...checks] }
}

function dodGate(artifact?: string, requiredSections?: readonly string[]): GateDef {
  if (artifact && requiredSections && requiredSections.length > 0) {
    return { type: 'dod', artifact, requiredSections: [...requiredSections] }
  }
  return { type: 'dod' }
}

interface StageSpec {
  readonly id: string
  readonly name: string
  readonly roles: readonly string[]
  readonly gate: GateDef
  readonly humanApproval?: boolean
  readonly failGoto?: string
  readonly maxRounds: number
}

/**
 * Normalises a stage: `parallel` is derived from the role count, because
 * `StageDef` defines "more than one role" as concurrent work.
 */
function stage(spec: StageSpec): StageDef {
  const parallel = spec.roles.length > 1
  const def: StageDef = {
    id: spec.id,
    name: spec.name,
    roles: [...spec.roles],
    gate: spec.gate,
    parallel,
    maxRounds: spec.maxRounds,
    ...(spec.humanApproval ? { humanApproval: true } : {}),
    ...(spec.failGoto ? { failGoto: spec.failGoto } : {}),
  }
  return def
}

/* ------------------------------------------------------------ templates */

/**
 * All five templates. `fullstack` is the prototype pipeline; the other four are
 * the same discipline with the specialist stages they actually need.
 */
export const PIPELINES: Pipelines = {
  fullstack: [
    stage({
      id: 'requirement',
      name: '需求分析',
      roles: ['pm'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.prd, ['背景与目标', '用户故事', '功能清单', '验收标准', '非目标', '待确认问题']),
    }),
    stage({
      id: 'design',
      name: '并行设计',
      roles: ['ui_designer', 'sys_arch', 'db_arch'],
      maxRounds: 2,
      gate: composite([
        checklist(ARTIFACTS.uiSpec, ['页面清单', '交互流程', '设计规范']),
        checklist(ARTIFACTS.architecture, ['技术选型', '模块划分', '接口清单']),
        checklist(ARTIFACTS.dbDesign, ['ER 设计', '索引策略', '迁移脚本']),
      ]),
    }),
    stage({
      id: 'contract',
      name: 'API 契约冻结',
      roles: ['api_designer'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.apiContract, ['接口清单', '字段级 Schema', '错误码']),
    }),
    stage({
      id: 'threat',
      name: '威胁建模',
      roles: ['security_eng'],
      maxRounds: 1,
      gate: checklist(ARTIFACTS.threatModel, ['STRIDE', '威胁清单', '缓解措施']),
    }),
    stage({
      id: 'implement',
      name: '并行开发',
      roles: ['fe_dev', 'be_dev'],
      maxRounds: 3,
      gate: script('npm run build --if-present', 'package.json'),
    }),
    stage({
      id: 'review',
      name: '代码评审',
      roles: ['reviewer'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.review, CONCLUSIONS.reviewPass, CONCLUSIONS.reviewFail),
    }),
    stage({
      id: 'sec_audit',
      name: '安全审计',
      roles: ['security_eng'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.securityAudit, CONCLUSIONS.secPass, CONCLUSIONS.secFail),
    }),
    stage({
      id: 'test',
      name: '测试验证',
      roles: ['qa'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: composite([
        keyword(ARTIFACTS.testReport, CONCLUSIONS.testPass, CONCLUSIONS.testFail),
        script(TEST_COMMAND, ARTIFACTS.testReport),
      ]),
    }),
    stage({
      id: 'deliver',
      name: '构建交付',
      roles: ['devops'],
      maxRounds: 2,
      gate: script(DELIVERY_CHECK_COMMAND, ARTIFACTS.startScript),
    }),
    stage({
      id: 'document',
      name: '文档与总验收',
      roles: ['devops'],
      maxRounds: 2,
      gate: dodGate(ARTIFACTS.readme, README_REQUIRED_SECTIONS),
    }),
  ],

  api: [
    stage({
      id: 'requirement',
      name: '需求分析',
      roles: ['pm'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.prd, ['背景与目标', '用户故事', '功能清单', '验收标准', '非目标', '待确认问题']),
    }),
    stage({
      id: 'design',
      name: '并行设计',
      roles: ['sys_arch', 'db_arch'],
      maxRounds: 2,
      gate: composite([
        checklist(ARTIFACTS.architecture, ['技术选型', '模块划分', '接口清单']),
        checklist(ARTIFACTS.dbDesign, ['ER 设计', '索引策略', '迁移脚本']),
      ]),
    }),
    stage({
      id: 'contract',
      name: 'API 契约冻结',
      roles: ['api_designer'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.apiContract, ['接口清单', '字段级 Schema', '错误码']),
    }),
    stage({
      id: 'threat',
      name: '威胁建模',
      roles: ['security_eng'],
      maxRounds: 1,
      gate: checklist(ARTIFACTS.threatModel, ['STRIDE', '威胁清单', '缓解措施']),
    }),
    stage({
      id: 'implement',
      name: '接口实现',
      roles: ['be_dev'],
      maxRounds: 3,
      gate: script('python -m compileall -q src'),
    }),
    stage({
      id: 'review',
      name: '代码评审',
      roles: ['reviewer'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.review, CONCLUSIONS.reviewPass, CONCLUSIONS.reviewFail),
    }),
    stage({
      id: 'sec_audit',
      name: '安全审计',
      roles: ['security_eng'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.securityAudit, CONCLUSIONS.secPass, CONCLUSIONS.secFail),
    }),
    stage({
      id: 'test',
      name: '测试验证',
      roles: ['qa'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: composite([
        keyword(ARTIFACTS.testReport, CONCLUSIONS.testPass, CONCLUSIONS.testFail),
        script(TEST_COMMAND, ARTIFACTS.testReport),
      ]),
    }),
    stage({
      id: 'deliver',
      name: '构建交付',
      roles: ['devops'],
      maxRounds: 2,
      gate: script(DELIVERY_CHECK_COMMAND, ARTIFACTS.startScript),
    }),
    stage({
      id: 'document',
      name: '文档与总验收',
      roles: ['devops'],
      maxRounds: 2,
      gate: dodGate(ARTIFACTS.readme, README_REQUIRED_SECTIONS),
    }),
  ],

  data: [
    stage({
      id: 'requirement',
      name: '需求与数据源分析',
      roles: ['pm'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.prd, ['背景与目标', '数据源与字段映射', '处理流程', '验收标准', '非目标']),
    }),
    stage({
      id: 'design',
      name: '并行设计',
      roles: ['sys_arch', 'db_arch'],
      maxRounds: 2,
      gate: composite([
        checklist(ARTIFACTS.architecture, ['技术选型', '数据流', '调度策略']),
        checklist(ARTIFACTS.dbDesign, ['ER 设计', '索引策略']),
      ]),
    }),
    stage({
      id: 'implement',
      name: '管道实现',
      roles: ['be_dev'],
      maxRounds: 3,
      gate: script('python -m compileall -q src'),
    }),
    stage({
      id: 'review',
      name: '代码评审',
      roles: ['reviewer'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.review, CONCLUSIONS.reviewPass, CONCLUSIONS.reviewFail),
    }),
    stage({
      id: 'sec_audit',
      name: '安全审计',
      roles: ['security_eng'],
      failGoto: 'implement',
      maxRounds: 2,
      gate: keyword(ARTIFACTS.securityAudit, CONCLUSIONS.secPass, CONCLUSIONS.secFail),
    }),
    stage({
      id: 'test',
      name: '测试验证',
      roles: ['qa'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: composite([
        keyword(ARTIFACTS.testReport, CONCLUSIONS.testPass, CONCLUSIONS.testFail),
        script(TEST_COMMAND, ARTIFACTS.testReport),
      ]),
    }),
    stage({
      id: 'deliver',
      name: '构建交付',
      roles: ['devops'],
      maxRounds: 2,
      gate: script(DELIVERY_CHECK_COMMAND, ARTIFACTS.startScript),
    }),
    stage({
      id: 'document',
      name: '文档与总验收',
      roles: ['devops'],
      maxRounds: 2,
      gate: dodGate(ARTIFACTS.readme, README_REQUIRED_SECTIONS),
    }),
  ],

  lightweight: [
    stage({
      id: 'requirement',
      name: '需求分析',
      roles: ['pm'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.prd, ['功能清单', '验收标准', '非目标']),
    }),
    stage({
      id: 'implement',
      name: '实现',
      roles: ['be_dev'],
      maxRounds: 3,
      gate: script('python -m compileall -q .'),
    }),
    stage({
      id: 'review',
      name: '代码评审',
      roles: ['reviewer'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.review, CONCLUSIONS.reviewPass, CONCLUSIONS.reviewFail),
    }),
    stage({
      id: 'sec_audit',
      name: '安全审计',
      roles: ['security_eng'],
      failGoto: 'implement',
      maxRounds: 2,
      gate: keyword(ARTIFACTS.securityAudit, CONCLUSIONS.secPass, CONCLUSIONS.secFail),
    }),
    stage({
      id: 'test',
      name: '测试验证',
      roles: ['qa'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: composite([
        keyword(ARTIFACTS.testReport, CONCLUSIONS.testPass, CONCLUSIONS.testFail),
        script(TEST_COMMAND, ARTIFACTS.testReport),
      ]),
    }),
    stage({
      id: 'deliver',
      name: '构建交付',
      roles: ['devops'],
      maxRounds: 2,
      gate: script(DELIVERY_CHECK_COMMAND, ARTIFACTS.startScript),
    }),
    stage({
      id: 'document',
      name: '文档与总验收',
      roles: ['devops'],
      maxRounds: 2,
      gate: dodGate(ARTIFACTS.readme, README_REQUIRED_SECTIONS),
    }),
  ],

  ml: [
    stage({
      id: 'requirement',
      name: '任务与指标定义',
      roles: ['pm'],
      humanApproval: true,
      maxRounds: 2,
      gate: checklist(ARTIFACTS.prd, ['业务目标', '数据与特征', '模型方案', '评估指标', '非目标']),
    }),
    stage({
      id: 'design',
      name: '方案设计',
      roles: ['sys_arch'],
      maxRounds: 2,
      gate: checklist(ARTIFACTS.architecture, ['数据流', '特征工程', '训练与推理架构']),
    }),
    stage({
      id: 'implement',
      name: '训练与推理实现',
      roles: ['be_dev'],
      maxRounds: 3,
      gate: script('python -m compileall -q src'),
    }),
    stage({
      id: 'review',
      name: '代码评审',
      roles: ['reviewer'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: keyword(ARTIFACTS.review, CONCLUSIONS.reviewPass, CONCLUSIONS.reviewFail),
    }),
    stage({
      id: 'sec_audit',
      name: '安全审计',
      roles: ['security_eng'],
      failGoto: 'implement',
      maxRounds: 2,
      gate: keyword(ARTIFACTS.securityAudit, CONCLUSIONS.secPass, CONCLUSIONS.secFail),
    }),
    stage({
      id: 'test',
      name: '评估验证',
      roles: ['qa'],
      failGoto: 'implement',
      maxRounds: 3,
      gate: composite([
        keyword(ARTIFACTS.testReport, CONCLUSIONS.testPass, CONCLUSIONS.testFail),
        script(TEST_COMMAND, ARTIFACTS.testReport),
      ]),
    }),
    stage({
      id: 'deliver',
      name: '构建交付',
      roles: ['devops'],
      maxRounds: 2,
      gate: script(DELIVERY_CHECK_COMMAND, ARTIFACTS.startScript),
    }),
    stage({
      id: 'document',
      name: '文档与总验收',
      roles: ['devops'],
      maxRounds: 2,
      gate: dodGate(ARTIFACTS.readme, README_REQUIRED_SECTIONS),
    }),
  ],
}

/* -------------------------------------------------------------- lookups */

/** True when `id` names a template. */
export function hasPipeline(id: PipelineId): boolean {
  return Object.prototype.hasOwnProperty.call(PIPELINES, id)
}

/** Template stages, or `[]` for an unknown id (callers validate separately). */
export function getPipeline(id: PipelineId): readonly StageDef[] {
  return PIPELINES[id] ?? []
}

/** All stage ids of one template, in order. */
export function stageIds(id: PipelineId): readonly string[] {
  return getPipeline(id).map((def) => def.id)
}

/** One stage by id. */
export function getStage(id: PipelineId, stageId: string): StageDef | undefined {
  return getPipeline(id).find((def) => def.id === stageId)
}

/** 0-based position of a stage, `-1` when unknown. */
export function stageIndex(id: PipelineId, stageId: string): number {
  return getPipeline(id).findIndex((def) => def.id === stageId)
}

/** The stage after `stageId`, if any. */
export function nextStageId(id: PipelineId, stageId: string): string | undefined {
  const index = stageIndex(id, stageId)
  if (index < 0) return undefined
  return getPipeline(id)[index + 1]?.id
}

/** True when `stageId` is the last stage of its template. */
export function isFinalStage(id: PipelineId, stageId: string): boolean {
  const stages = getPipeline(id)
  return stages.length > 0 && stages[stages.length - 1]?.id === stageId
}

/* ------------------------------------------------------------ staffing */

/** One role that had to be covered by somebody else. */
export interface StageSubstitution {
  readonly required: string
  readonly assigned: string
}

/** Resolution of one stage against the roster actually assembled. */
export interface StageStaffing {
  readonly stageId: string
  /** Distinct members who work this stage. */
  readonly assigned: readonly string[]
  /** Stage roles that are in the team. */
  readonly direct: readonly string[]
  readonly substituted: readonly StageSubstitution[]
  /** Stage roles with neither a member nor a fallback — dispatch must escalate. */
  readonly missing: readonly string[]
  readonly fallbackUsed: boolean
}

function pickSubstitute(role: string, members: readonly string[], taken: ReadonlySet<string>): string | undefined {
  for (const candidate of ROLE_FALLBACKS[role] ?? []) {
    const canonical = canonicalRoleId(candidate)
    if (members.includes(canonical) && !taken.has(canonical)) return canonical
  }
  return undefined
}

/**
 * Maps a stage onto the real roster. Direct members win; otherwise the stage
 * role walks its `ROLE_FALLBACKS` ladder (a capped/trimmed specialist is
 * covered by the nearest retained role). Reuse is allowed as a last resort so a
 * stage is never left empty while any candidate exists.
 */
export function resolveStageRoles(stageDef: StageDef, team: readonly string[]): StageStaffing {
  const members = team.map(canonicalRoleId)
  const required = stageDef.roles.map(canonicalRoleId)
  const taken = new Set<string>()
  const direct: string[] = []
  for (const role of required) {
    if (members.includes(role)) {
      direct.push(role)
      taken.add(role)
    }
  }
  const substituted: StageSubstitution[] = []
  const missing: string[] = []
  for (const role of required) {
    if (direct.includes(role)) continue
    const pick = pickSubstitute(role, members, taken) ?? pickSubstitute(role, members, new Set<string>())
    if (pick) {
      substituted.push({ required: role, assigned: pick })
      taken.add(pick)
    } else {
      missing.push(role)
    }
  }
  const assigned = [...new Set([...direct, ...substituted.map((item) => item.assigned)])]
  return {
    stageId: stageDef.id,
    assigned,
    direct,
    substituted,
    missing,
    fallbackUsed: substituted.length > 0,
  }
}

/** Staffing of every stage of a template against one roster. */
export function pipelineStaffing(id: PipelineId, team: readonly string[]): readonly StageStaffing[] {
  return getPipeline(id).map((def) => resolveStageRoles(def, team))
}

/* ---------------------------------------------------------- validation */

/** Result of validating one template. */
export interface PipelineValidation {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** Validates one template: ids, order, gate parameters, roles and back-edges. */
export function validatePipeline(id: PipelineId): PipelineValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const stages = getPipeline(id)
  if (!hasPipeline(id)) {
    return { ok: false, errors: [`未知流水线模板: ${String(id)}`], warnings }
  }
  if (stages.length === 0) errors.push(`${id}: 模板没有任何阶段`)

  const seen = new Set<string>()
  for (const def of stages) {
    const at = (message: string): void => {
      errors.push(`${id}/${def.id}: ${message}`)
    }
    if (!def.id || def.id.trim().length === 0) errors.push(`${id}: 存在空 id 的阶段`)
    if (seen.has(def.id)) at('阶段 id 重复')
    seen.add(def.id)
    if (!def.name || def.name.trim().length === 0) at('阶段名称为空')
    if (def.roles.length === 0) at('阶段没有任何角色')
    for (const role of def.roles) {
      if (!isRoleId(role)) at(`引用了未注册角色 ${role}`)
    }
    if (!Number.isInteger(def.maxRounds) || def.maxRounds < 1) at(`maxRounds 必须是 ≥1 的整数，实际 ${def.maxRounds}`)
    if (def.parallel !== undefined && def.parallel !== (def.roles.length > 1)) {
      at('parallel 与角色数量矛盾（多角色 = 并行，未声明则按角色数推导）')
    }
    const gate = validateGateDef(def.gate, `${id}/${def.id}.gate`)
    errors.push(...gate.errors)
    if (def.failGoto !== undefined) {
      const target = def.failGoto
      const targetIndex = stageIndex(id, target)
      if (targetIndex < 0) {
        at(`failGoto 指向不存在的阶段 ${target}`)
      } else if (targetIndex >= stageIndex(id, def.id)) {
        at(`failGoto 必须回退到更早的阶段（${target} 不在 ${def.id} 之前）`)
      }
      if (def.maxRounds < 2) at('给出 failGoto 却把 maxRounds 设为 1，打回没有意义')
    }
  }

  if (id === 'fullstack') {
    let cursor = 0
    for (const required of PROTOTYPE_STAGE_ORDER) {
      const found = stages.findIndex((def, index) => def.id === required && index >= cursor)
      if (found < 0) errors.push(`fullstack: 缺少原型阶段 ${required}（或顺序被打乱）`)
      else cursor = found + 1
    }
  }

  if (stages.length > 0 && stages[stages.length - 1]?.gate.type !== 'dod') {
    warnings.push(`${id}: 最后阶段建议使用 dod 门禁做总验收`)
  }
  if (!stages.some((def) => def.humanApproval)) {
    warnings.push(`${id}: 没有任何人工审批点`)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** Validates every template; `byPipeline` keeps the per-template verdicts. */
export function validateAllPipelines(): {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly byPipeline: Readonly<Record<string, PipelineValidation>>
} {
  const byPipeline: Record<string, PipelineValidation> = {}
  const errors: string[] = []
  const warnings: string[] = []
  for (const id of PIPELINE_IDS) {
    const verdict = validatePipeline(id)
    byPipeline[id] = verdict
    errors.push(...verdict.errors)
    warnings.push(...verdict.warnings)
  }
  return { ok: errors.length === 0, errors, warnings, byPipeline }
}
