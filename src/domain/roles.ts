/**
 * roles.ts — the role registry.
 *
 * The **canonical 12** are a 1:1 port of the prototype's 角色注册表 (实施方案
 * §1.2 角色表 / `app/src/lib/data.ts` AGENTS): same twelve jobs, same codenames,
 * tiers, colours and duties. Role ids follow the prototype table **except the
 * security job**, which this registry calls `security_eng` because the router
 * rule and the task contract name it that way — the prototype's `sec_eng` stays
 * valid through {@link ROLE_ALIASES}, and {@link PROTOTYPE_ROLE_ID_ALIASES}
 * records the full mapping so the deviation is explicit rather than accidental.
 *
 * Two groups sit outside that canonical 12:
 *  - {@link EXTRA_ROLES} — optional add-ons (`perf` / `po` / `tech_writer`) the
 *    cap trims first;
 *  - {@link SPECIALIST_ROLES} — platform-specific frontend jobs
 *    (`web_dev` / `flutter_dev` / `mini_program_dev`) that the router assigns
 *    automatically into the frontend slot, with the generic `fe_dev` kept as the
 *    back-compat fallback.
 *
 * Every other spelling used by the Kimi skeleton, the captain protocol or early
 * docs (`security_eng`, `architect`, `frontend_dev`, `backend_dev`, `DBA`, …) is
 * accepted through {@link ROLE_ALIASES} and normalised by
 * {@link canonicalRoleId}.
 *
 * PURITY CONTRACT (hard): this module is compiled by BOTH tsc programs and is
 * bundled into the browser half, so it has **no external imports** (only the
 * sibling `shared/types.js` type contract), no Node API, no side effects and
 * no non-determinism. `tools` is deliberately omitted on every role: the member
 * tool surface is computed by the runtime from the host's *registered* tool
 * names (API-CONTRACTS 陷阱 #6 — a single unregistered name makes every spawn
 * fail), so the domain layer must not guess tool names.
 *
 * @module dsh-code-factory/domain/roles
 */

import type { RoleDef, RoleTier } from '../shared/types.js'

/* ------------------------------------------------------------------ types */

/** Fields a role author fills in; the persona is derived from them. */
interface RoleSpec {
  readonly id: string
  readonly title: string
  readonly codename: string
  readonly tier: RoleTier
  readonly color: string
  readonly duties: string
  readonly outputs: readonly string[]
  readonly ironRules: readonly string[]
}

/**
 * Renders the member persona from the same fields the registry publishes, so a
 * role can never describe one duty to the cockpit and another to its member.
 */
function persona(spec: RoleSpec): string {
  const outputs =
    spec.outputs.length === 0
      ? '（无工件产出面：本岗位只做调度/裁决，工厂状态由队长落盘，不写工作区文件）'
      : spec.outputs.map((path) => `- ${path}`).join('\n')
  return [
    `你是 code-factory 流水线中的固定岗位「${spec.title}」（代号 ${spec.codename}，角色 id = ${spec.id}）。`,
    '',
    '【职责】',
    spec.duties,
    '',
    '【工件边界】你只能创建或修改下列路径；越界写入会在 DoD 审计阶段判失败：',
    outputs,
    '',
    '【铁律】',
    ...spec.ironRules.map((rule) => `- ${rule}`),
    '',
    '【协作协议】',
    '- 只做队长派发给你的阶段职责，不越阶段代工（评审员不修代码，安全工程师不改实现）。',
    '- 收到打回单时只修打回清单列出的问题，不做顺手重构，不擅自扩大改动面。',
    '- 上游工件有歧义或缺失时用 factory_block 上报 BLOCKED，写清卡点与所需决策；禁止靠猜继续。',
    '- 完成时用 factory_report 上报：产出清单 + 自检结论 + 证据（真实执行过的命令与输出摘要）。',
  ].join('\n')
}

/** Builds a `RoleDef` and derives its persona — keep in sync by construction. */
function role(spec: RoleSpec): RoleDef {
  return { ...spec, systemPrompt: persona(spec) }
}

/* ------------------------------------------------------------- the roster */

/**
 * The canonical roster, in prototype order (12 jobs).
 *
 * `router` is the captain's own dispatcher hat: it is registered so the cockpit
 * can render row 1 of the prototype roster and so routing vocabulary resolves,
 * but {@link import('./router.js').assembleTeam} never spawns it as a member.
 */
export const ROLES: readonly RoleDef[] = [
  role({
    id: 'router',
    title: '调度官',
    codename: 'ROUTER',
    tier: 'chat',
    color: '#22d3ee',
    duties: '任务分类 · 动态组队 · 流程模板加载。这是队长的调度帽，不产生工件。',
    outputs: [],
    ironRules: [
      '只做分类、组队与流程装载，不写任何实现代码',
      '铁三角（pm + qa + 至少一名 *_dev）不可裁剪，安全岗触发后不可裁剪',
      '阶段顺序不可跳，任何阶段都不能绕过门禁推进',
    ],
  }),
  role({
    id: 'pm',
    title: '产品经理',
    codename: 'PM',
    tier: 'chat',
    color: '#60a5fa',
    duties: '需求澄清 · PRD 撰写 · 验收标准（Given/When/Then）。不做技术选型、不写代码。',
    outputs: ['PRD.md'],
    ironRules: [
      '需求有歧义必须列入「待确认问题」，禁止自行假设',
      '每条验收标准必须编号 AC-1、AC-2…（DoD 交叉校验逐条依赖该编号）',
      '不做技术选型、不写实现代码、不修改他人工件',
    ],
  }),
  role({
    id: 'ui_designer',
    title: 'UI/UX 设计负责人',
    codename: 'UI',
    tier: 'reasoner',
    color: '#e879f9',
    duties: '视觉体系 · 交互流程 · 行业与用户研究 · 配色与设计令牌 · 高保真与设计验收。只产出设计文档。',
    outputs: ['UI_SPEC.md'],
    ironRules: [
      '只输出设计文档，不写实现代码',
      'UI_SPEC 必须按《设计负责人手册》的 7 段结构输出（视觉方向与行业依据 / 设计令牌 / 页面清单与信息架构 / 交互流程与全状态 / 组件规范 / 响应式与可访问性 / 设计自评表），缺段视为不合格',
      '禁止只写“科技感/高级感/简约/大气”等形容词；每个视觉决定必须落到命名 token（hex、字号/行高/字重、间距、圆角、阴影、动效时长/缓动）',
      '必须给出目标行业/用户/场景依据，并列出至少 2 个被否设计方向及原因；禁止套模板',
      '每个交互组件必须覆盖 default/hover/active/focus-visible/disabled/loading/empty/error/success 状态与键盘路径',
      '可访问性：正文对比度 ≥4.5:1、非文本 ≥3:1、焦点可见、支持 reduced-motion、200% 缩放不破；不达标不得交付',
      '设计自评表 10 项、每项 0–10 分，总分 <80 必须继续迭代；页面清单/交互流程覆盖 PRD 全部用户故事',
    ],
  }),
  role({
    id: 'sys_arch',
    title: '系统架构师',
    codename: 'ARCH',
    tier: 'reasoner',
    color: '#a78bfa',
    duties: '技术选型 · 模块划分 · 架构设计。只在 PRD 与设计文档之上工作。',
    outputs: ['ARCHITECTURE.md'],
    ironRules: [
      'PRD 的「待确认问题」非空时输出 BLOCKED 并停止，不猜需求',
      '必须给出模块依赖与接口清单，接口清单是契约阶段的输入',
    ],
  }),
  role({
    id: 'db_arch',
    title: '数据库架构师',
    codename: 'DBA',
    tier: 'reasoner',
    color: '#818cf8',
    duties: 'ER 设计 · 索引策略 · 迁移脚本。migration 必须真实执行验证。',
    outputs: ['DB_DESIGN.md', 'migrations/'],
    ironRules: [
      '迁移脚本必须经真实执行验证，禁止只写不跑',
      '索引策略必须对应具体查询路径，不做无依据加索引',
    ],
  }),
  role({
    id: 'api_designer',
    title: 'API设计师',
    codename: 'API',
    tier: 'chat',
    color: '#38bdf8',
    duties: '接口契约 · 字段级 Schema · 错误码。契约冻结后任何变更需走变更上报。',
    outputs: ['API_CONTRACT.md'],
    ironRules: [
      '契约必须精确到字段级 Schema，并给出统一错误码表',
      '契约冻结后不擅自修改；需要变更时上报队长走人工审批',
    ],
  }),
  role({
    id: 'security_eng',
    title: '安全工程师',
    codename: 'SEC',
    tier: 'reasoner',
    color: '#fbbf24',
    duties: '威胁建模 · 代码安全审计 · 持有一票否决权。只打回，不改代码。',
    outputs: ['THREAT_MODEL.md', 'SECURITY_AUDIT.md'],
    ironRules: [
      '密钥硬编码 / 明文密码 / 未鉴权写 / 注入风险 → 必须输出「结论: SEC_FAIL」',
      '只打回不修代码，修复由责任人自己做',
      '审计结论行固定为「结论: SEC_PASS」或「结论: SEC_FAIL」，禁止含糊表述',
    ],
  }),
  role({
    id: 'fe_dev',
    title: '前端工程师',
    codename: 'FE',
    tier: 'reasoner',
    color: '#34d399',
    duties: '页面组件实现 · 按 UI 稿与 API 契约开发 · 构建自检。',
    outputs: ['src/frontend/'],
    ironRules: [
      '禁止擅改接口契约；契约有疑义时用 factory_block 上报',
      '只写 src/frontend/ 子树，越界写入判失败',
      '被打回时只修打回清单列出的问题，不做顺手重构',
    ],
  }),
  role({
    id: 'be_dev',
    title: '后端工程师',
    codename: 'BE',
    tier: 'reasoner',
    color: '#2dd4bf',
    duties: '业务逻辑 · 接口实现 · 冒烟验证。按契约与数据库设计实现。',
    outputs: ['src/backend/'],
    ironRules: [
      '契约有疑义输出 BLOCKED 而非猜测',
      '只写 src/backend/ 子树，越界写入判失败',
      '完成即做冒烟验证，把真实命令与输出写进上报证据',
    ],
  }),
  role({
    id: 'reviewer',
    title: '代码评审员',
    codename: 'CR',
    tier: 'reasoner',
    color: '#fb923c',
    duties: '逐文件 Review · 阻塞级/建议级分级 · 结论只输出 APPROVED / REJECTED。',
    outputs: ['REVIEW.md'],
    ironRules: [
      '每条问题必须注明 文件:行号 与级别（阻塞级 / 建议级）',
      '只打回不修代码，修复由原责任人自己做',
      '结论行固定为「结论: APPROVED」或「结论: REJECTED」，且必须是文件的最后一条结论',
    ],
  }),
  role({
    id: 'qa',
    title: '测试工程师',
    codename: 'QA',
    tier: 'reasoner',
    color: '#f87171',
    duties: '用例设计 · 测试实测 · Bug 按 P0/P1/P2 分级 · 验收标准逐条映射。',
    outputs: ['tests/', 'TEST_REPORT.md'],
    ironRules: [
      '禁止目测通过：必须真实执行测试命令并记录退出码',
      'PRD 的每条 AC-n 必须有对应用例，并在 TEST_REPORT.md 逐条引用该编号',
      '存在 P0/P1 Bug 时必须输出「结论: FAIL」',
    ],
  }),
  role({
    id: 'devops',
    title: 'DevOps',
    codename: 'OPS',
    tier: 'chat',
    color: '#94a3b8',
    duties: '构建打包 · 启动脚本 · README/DELIVERY · 版本 tag。只在测试通过后工作。',
    outputs: ['Dockerfile', 'start.sh', 'DELIVERY.md', 'README.md', 'docs/'],
    ironRules: [
      'TEST_REPORT 结论不是 PASS 时输出 BLOCKED，不带着失败测试交付',
      'start.sh 必须支持 --check 且自检退出码为 0',
      'README 必含「简介 / 安装 / 启动 / 接口一览」四个 Markdown 标题',
    ],
  }),
]

/**
 * Add-on jobs that are NOT part of the canonical 12 and are never auto-assigned
 * by the router. They exist because the roster cap has a defined trim order
 * (perf > po > tech_writer first) and because `factory_edit_plan` may add a
 * specialist to a running factory; they are trimmed before any canonical role.
 */
export const EXTRA_ROLES: readonly RoleDef[] = [
  role({
    id: 'perf',
    title: '性能工程师',
    codename: 'PERF',
    tier: 'reasoner',
    color: '#a3e635',
    duties: '压测 · 性能剖析 · 容量评估。只出报告与补丁建议。',
    outputs: ['PERF_REPORT.md'],
    ironRules: [
      '必须给出可复现的压测命令与基线数据，禁止凭感觉下结论',
      '只出报告与建议，不擅自重构实现',
    ],
  }),
  role({
    id: 'po',
    title: '产品负责人',
    codename: 'PO',
    tier: 'chat',
    color: '#f0abfc',
    duties: '范围裁剪 · 优先级排序 · 商业价值判断。',
    outputs: ['BACKLOG.md'],
    ironRules: [
      '范围裁剪必须写明被裁项与理由，并同步给 PM',
      '不改已冻结的接口契约',
    ],
  }),
  role({
    id: 'tech_writer',
    title: '技术文档工程师',
    codename: 'DOC',
    tier: 'chat',
    color: '#7dd3fc',
    duties: 'README · API 文档 · 交付说明。档案面与 devops 重叠，二者不并行。',
    outputs: ['README.md', 'docs/'],
    ironRules: [
      'README 必含「简介 / 安装 / 启动 / 接口一览」四个 Markdown 标题',
      '文档必须与已冻结契约一致，禁止臆造不存在的接口',
    ],
  }),
]

/**
 * Frontend specialists: platform-specific implementation jobs.
 *
 * They are **not** part of the canonical 12 (the prototype roster table stays
 * untouched) and they are not add-ons that get trimmed first either: the router
 * *auto-assigns* exactly one of them into the frontend slot (`fe_dev`) after
 * detecting the platform, and `ROLE_FALLBACKS` resolves the pipeline's generic
 * `fe_dev` stage slot to whichever specialist the team actually has.
 *
 * `fe_dev` survives as the generic/back-compat frontend role — an explicit old
 * roster, an old `factory.json` member row, and a brief whose platform cannot be
 * pinned down all still resolve to it.
 */
export const SPECIALIST_ROLES: readonly RoleDef[] = [
  role({
    id: 'web_dev',
    title: 'Web前端工程师',
    codename: 'WEB',
    tier: 'reasoner',
    color: '#10b981',
    duties: 'Web 页面与组件实现 · 响应式适配 · 构建自检。按 UI 稿与 API 契约开发。',
    outputs: ['src/frontend/'],
    ironRules: [
      '禁止擅改接口契约；契约有疑义时用 factory_block 上报',
      '只写 src/frontend/ 子树，越界写入判失败',
      '必须做响应式适配（移动端 / 桌面端断点），并真实执行构建命令、把退出码写进上报证据',
    ],
  }),
  role({
    id: 'flutter_dev',
    title: 'Flutter工程师',
    codename: 'FT',
    tier: 'reasoner',
    color: '#06b6d4',
    duties: 'Flutter 应用实现 · Dart / Widget 组合 · 平台通道与构建自检。',
    outputs: ['lib/', 'test/'],
    ironRules: [
      '禁止擅改接口契约；契约有疑义时用 factory_block 上报',
      '只写 lib/ 与 test/ 子树，越界写入判失败',
      'Dart 代码必须通过 flutter analyze / flutter test（或等价命令），真实退出码写进上报证据；平台通道须说明两端实现',
    ],
  }),
  role({
    id: 'mini_program_dev',
    title: '小程序工程师',
    codename: 'MP',
    tier: 'reasoner',
    color: '#ec4899',
    duties: '小程序页面与组件实现 · 包体积控制 · 真机自检。按目标框架的平台限制开发。',
    outputs: ['miniprogram/'],
    ironRules: [
      '禁止擅改接口契约；契约有疑义时用 factory_block 上报',
      '只写 miniprogram/ 子树，越界写入判失败',
      '必须说明目标框架（原生 / uni-app / Taro）并遵守其限制（包体积、真机预览、不可用 DOM/BOM）',
    ],
  }),
]

/* ---------------------------------------------------------------- indexes */

/** Canonical id → definition (12 entries). */
export const ROLE_BY_ID: Readonly<Record<string, RoleDef>> = indexRoles(ROLES)

/** Canonical id plus add-on and specialist id → definition (18 entries). */
export const ALL_ROLE_BY_ID: Readonly<Record<string, RoleDef>> = indexRoles([
  ...ROLES,
  ...EXTRA_ROLES,
  ...SPECIALIST_ROLES,
])

/** Canonical ids in roster order. */
export const ROLE_IDS: readonly string[] = ROLES.map((def) => def.id)

/** The prototype roster size, asserted by `validateRoleRegistry`. */
export const CANONICAL_ROLE_COUNT = 12

function indexRoles(defs: readonly RoleDef[]): Readonly<Record<string, RoleDef>> {
  const index: Record<string, RoleDef> = {}
  for (const def of defs) index[def.id] = def
  return index
}

/* ---------------------------------------------------------------- aliases */

/**
 * Loose spellings accepted on input and normalised to canonical ids.
 * Keys are matched case-insensitively (`canonicalRoleId` lower-cases first).
 * Canonical ids are never keys here — they win by definition.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  // 原型 1.2 表把安全工程师写作 sec_eng；本注册表的规范 id 是 security_eng
  // （任务书与 router 的安全触发规则都用这个写法），两者等价。
  sec_eng: 'security_eng',
  // Kimi 骨架 / 早期文档用的角色名
  security: 'security_eng',
  architect: 'sys_arch',
  sys_architect: 'sys_arch',
  db_architect: 'db_arch',
  frontend_dev: 'fe_dev',
  backend_dev: 'be_dev',
  coder: 'be_dev',
  api: 'api_designer',
  code_reviewer: 'reviewer',
  ops: 'devops',
  devops_engineer: 'devops',
  doc: 'tech_writer',
  doc_writer: 'tech_writer',
  performance: 'perf',
  perf_eng: 'perf',
  product_owner: 'po',
  // 代号（驾驶舱芯片上显示的那串大写字母）
  ui: 'ui_designer',
  arch: 'sys_arch',
  dba: 'db_arch',
  sec: 'security_eng',
  fe: 'fe_dev',
  be: 'be_dev',
  cr: 'reviewer',
  qa_eng: 'qa',
  // 中文名
  调度官: 'router',
  产品经理: 'pm',
  ui设计师: 'ui_designer',
  系统架构师: 'sys_arch',
  数据库架构师: 'db_arch',
  api设计师: 'api_designer',
  安全工程师: 'security_eng',
  前端工程师: 'fe_dev',
  后端工程师: 'be_dev',
  代码评审员: 'reviewer',
  测试工程师: 'qa',
  技术文档工程师: 'tech_writer',
  性能工程师: 'perf',
  产品负责人: 'po',
  // 前端平台细分：旧拼写仍然有效（canonicalRoleId 会先转小写，故中文键也用小写）。
  前端开发: 'fe_dev',
  web前端工程师: 'web_dev',
  flutter工程师: 'flutter_dev',
  小程序工程师: 'mini_program_dev',
  // 前端平台 specialist 的英文别名
  web_frontend: 'web_dev',
  webdev: 'web_dev',
  frontend_web: 'web_dev',
  flutter: 'flutter_dev',
  dart: 'flutter_dev',
  dart_dev: 'flutter_dev',
  mini_program: 'mini_program_dev',
  miniprogram: 'mini_program_dev',
  weapp: 'mini_program_dev',
  wechat_mini: 'mini_program_dev',
  mp_dev: 'mini_program_dev',
  // 平台简写也能直接作为角色输入（与「小程序工程师」等价）
  小程序: 'mini_program_dev',
}

/**
 * Prototype §1.2 role-table id → canonical id of this registry.
 *
 * All twelve entries are identity except the security job: the prototype table
 * writes `sec_eng`, while this registry (following the task's router rule) uses
 * `security_eng`. The map makes that single deviation explicit and
 * machine-checkable instead of a surprise — `validateRoleRegistry` asserts it
 * covers all twelve canonical ids exactly.
 */
export const PROTOTYPE_ROLE_ID_ALIASES: Readonly<Record<string, string>> = {
  router: 'router',
  pm: 'pm',
  ui_designer: 'ui_designer',
  sys_arch: 'sys_arch',
  db_arch: 'db_arch',
  api_designer: 'api_designer',
  sec_eng: 'security_eng',
  fe_dev: 'fe_dev',
  be_dev: 'be_dev',
  reviewer: 'reviewer',
  qa: 'qa',
  devops: 'devops',
}

/* ------------------------------------------------------------ conventions */

/** The id of the dispatcher role (the captain's hat; never a member). */
export const ROUTER_ROLE_ID = 'router'

/** The security specialist: pinned into any roster that triggered the security path. */
export const SECURITY_ROLE_ID = 'security_eng'

/** Every id that denotes the security specialist. */
export const SECURITY_ROLE_IDS: readonly string[] = [SECURITY_ROLE_ID, 'sec_eng']

/**
 * The generic frontend role: a stage slot and a back-compat id, not the default
 * assignment any more. New rosters get one of {@link FRONTEND_SPECIALIST_ROLE_IDS}
 * and resolve the pipeline's `fe_dev` slot through `ROLE_FALLBACKS`.
 */
export const GENERIC_FRONTEND_ROLE_ID = 'fe_dev'

/** Platform-specific frontend specialists, in detection preference order. */
export const FRONTEND_SPECIALIST_ROLE_IDS: readonly string[] = ['web_dev', 'flutter_dev', 'mini_program_dev']

/** Suffix that marks an implementation job (`fe_dev`, `be_dev`, …). */
export const DEV_ROLE_SUFFIX = '_dev'

/** The two always-pinned corners of the iron triangle; the dev corner is dynamic. */
export const TRIAD_BASE_ROLES: readonly string[] = ['pm', 'qa']

/**
 * Substitution ladder used by `pipeline.resolveStageRoles` when the roster cap
 * trimmed a stage's specialist (or the factory never staffed it): walk the list
 * left to right and take the first id present in the team. Never self-referent.
 * `[]` means "only the role itself can do it" (pinned roles).
 */
export const ROLE_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  pm: [],
  router: [],
  ui_designer: ['web_dev', 'flutter_dev', 'mini_program_dev', 'fe_dev', 'pm'],
  sys_arch: ['be_dev', 'pm'],
  db_arch: ['be_dev', 'sys_arch', 'pm'],
  api_designer: ['sys_arch', 'be_dev', 'pm'],
  fe_dev: ['web_dev', 'flutter_dev', 'mini_program_dev', 'be_dev'],
  web_dev: ['fe_dev', 'be_dev'],
  flutter_dev: ['fe_dev', 'be_dev'],
  mini_program_dev: ['fe_dev', 'be_dev'],
  be_dev: ['web_dev', 'flutter_dev', 'mini_program_dev', 'fe_dev'],
  reviewer: ['qa', 'pm'],
  security_eng: ['reviewer', 'qa'],
  qa: ['reviewer'],
  devops: ['be_dev', 'pm'],
  perf: ['reviewer'],
  po: ['pm'],
  tech_writer: ['devops', 'pm'],
}

/* ---------------------------------------------------------------- helpers */

/** Normalises any accepted spelling to a canonical role id (lower-cased, trimmed). */
export function canonicalRoleId(id: string): string {
  const key = id.trim().toLowerCase()
  if (ROLE_BY_ID[key]) return key
  const alias = ROLE_ALIASES[key]
  if (alias && ALL_ROLE_BY_ID[alias]) return alias
  return key
}

/** Definition for any accepted spelling, canonical or add-on. */
export function getRole(id: string): RoleDef | undefined {
  const canonical = canonicalRoleId(id)
  return ROLE_BY_ID[canonical] ?? ALL_ROLE_BY_ID[canonical]
}

/** True when the spelling resolves to a registered job (canonical or add-on). */
export function isRoleId(id: string): boolean {
  return getRole(id) !== undefined
}

/** True when the spelling is one of the canonical 12. */
export function isCanonicalRoleId(id: string): boolean {
  return ROLE_BY_ID[canonicalRoleId(id)] !== undefined
}

/** True for `*_dev` implementation jobs (accepts aliases such as `backend_dev`). */
export function isDevRoleId(id: string): boolean {
  return canonicalRoleId(id).endsWith(DEV_ROLE_SUFFIX)
}

/** True for the security specialist under any spelling. */
export function isSecurityRole(id: string): boolean {
  return SECURITY_ROLE_IDS.includes(canonicalRoleId(id))
}

/** Chinese title for a role id, falling back to the raw id. */
export function roleTitle(id: string): string {
  return getRole(id)?.title ?? id
}

/* -------------------------------------------------------------- integrity */

/** Result of a registry self-audit. */
export interface RegistryAudit {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/**
 * Pure registry audit, run by the offline self-check (and cheap enough for the
 * captain tool surface). Catches the class of bug that otherwise only shows up
 * as a missing member at spawn time.
 */
export function validateRoleRegistry(): RegistryAudit {
  const errors: string[] = []
  if (ROLES.length !== CANONICAL_ROLE_COUNT) {
    errors.push(`规范岗位应为 ${CANONICAL_ROLE_COUNT} 个，实际 ${ROLES.length} 个`)
  }
  const seen = new Set<string>()
  for (const def of [...ROLES, ...EXTRA_ROLES, ...SPECIALIST_ROLES]) {
    if (seen.has(def.id)) errors.push(`角色 id 重复: ${def.id}`)
    seen.add(def.id)
    for (const field of ['id', 'title', 'codename', 'color', 'duties', 'systemPrompt'] as const) {
      if (!def[field] || def[field].trim().length === 0) errors.push(`${def.id}: 字段 ${field} 为空`)
    }
    if (def.tier !== 'chat' && def.tier !== 'reasoner') errors.push(`${def.id}: 未知档位 ${def.tier}`)
    if (def.ironRules.length === 0) errors.push(`${def.id}: 铁律为空`)
    for (const path of def.outputs) {
      if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
        errors.push(`${def.id}: 工件路径必须是工作区相对 POSIX 路径: ${path}`)
      }
    }
  }
  // Frontend specialists are deliberately NOT canonical (the prototype table has
  // 12 rows), but every declared one must exist and every registered one must be
  // declared — the two lists are asserted against each other instead of trusted.
  if (SPECIALIST_ROLES.length !== FRONTEND_SPECIALIST_ROLE_IDS.length) {
    errors.push(
      `前端 specialist 列表与注册表数量不一致: ${FRONTEND_SPECIALIST_ROLE_IDS.length} vs ${SPECIALIST_ROLES.length}`,
    )
  }
  for (const id of FRONTEND_SPECIALIST_ROLE_IDS) {
    if (ROLE_BY_ID[id]) errors.push(`前端 specialist ${id} 不能属于规范 12 岗位`)
    if (getRole(id) === undefined) errors.push(`前端 specialist ${id} 未注册`)
  }
  if (ROLE_BY_ID[GENERIC_FRONTEND_ROLE_ID] === undefined) {
    errors.push(`通用前端回退岗位 ${GENERIC_FRONTEND_ROLE_ID} 必须是规范岗位`)
  }
  for (const [alias, target] of Object.entries(ROLE_ALIASES)) {
    if (ROLE_BY_ID[alias]) errors.push(`别名 ${alias} 与规范 id 冲突`)
    if (!ALL_ROLE_BY_ID[target]) errors.push(`别名 ${alias} 指向未知角色 ${target}`)
  }
  const prototypeTargets = new Set(Object.values(PROTOTYPE_ROLE_ID_ALIASES))
  for (const [prototypeId, canonical] of Object.entries(PROTOTYPE_ROLE_ID_ALIASES)) {
    if (!ALL_ROLE_BY_ID[canonical]) errors.push(`原型 id 映射 ${prototypeId} 指向未知角色 ${canonical}`)
    if (!ROLE_BY_ID[prototypeId] && !ROLE_ALIASES[prototypeId]) {
      errors.push(`原型 id ${prototypeId} 既不是规范 id 也不能解析`)
    }
  }
  for (const def of ROLES) {
    if (!prototypeTargets.has(def.id)) errors.push(`原型 id 映射未覆盖规范岗位 ${def.id}`)
  }
  for (const [id, chain] of Object.entries(ROLE_FALLBACKS)) {
    if (!ALL_ROLE_BY_ID[id]) errors.push(`替补表含未知角色 ${id}`)
    for (const target of chain) {
      if (!ALL_ROLE_BY_ID[target]) errors.push(`替补表 ${id} 指向未知角色 ${target}`)
      if (target === id) errors.push(`替补表 ${id} 指向自身`)
    }
  }
  return { ok: errors.length === 0, errors }
}
