# 已知限制与能力边界（Known limitations）

> 这份文档是**能力边界的权威清单**：每条都给出机制与代码/文档出处（`file:line`），不是免责口号。
> 标记含义：**🚫 = 当前不支持**（会在真实使用中直接伤人）；**⚠️ = 已知语义边界**（可用，但必须知道它的行为）。
>
> 相关文档：[architecture.md](architecture.md)（分层与磁盘布局）、[roles-and-pipelines.md](roles-and-pipelines.md)
> （角色/流水线/DoD）、[API-CONTRACTS.md](API-CONTRACTS.md)（DSH 契约，含 §1.4 / §1.7 / §7）、
> [E2E-ACCEPTANCE.md](E2E-ACCEPTANCE.md)（真机验收规程）。

---

## 1. 🚫 不能接手半成品：brownfield / takeover 场景不支持

**一句话**：插件没有任何"工作区里已经有东西了"的概念。它不扫描现状、不承认既有资产，成员会按
**空工作区**的假设开工——**最大的风险不是"做得不好"，而是把你已有的成果直接覆盖掉**。

### 1.1 机制证据（四个环节，逐条可核）

| 环节 | 现状 | 证据 |
|---|---|---|
| 成员简报 | 只讲 岗位 / 工件边界 / 铁律 / 用户目标，**0 处**提到工作区里已有什么 | `src/prompt/member-brief.ts:167`（`renderMemberBrief`）；`:194` 原文是「【工件边界】你只能创建或修改下列工作区相对路径」——**创建或修改**，没有任何"先读 / 不得覆盖"的条款 |
| 计划阶段 | `factory_plan` 只产出 staged 计划，**不做工作区 inventory**；也不存在 recon / baseline 阶段 | `src/tools/captain.ts:353`（同一 brief 幂等复用 staged 计划）；`src/domain/pipeline.ts:76`（`PROTOTYPE_STAGE_ORDER`：requirement → design → contract → threat → implement → review → sec_audit → test → deliver → document，**没有侦察阶段**） |
| 路由关键词 | 全是**新建语义**：`网站 / web / 前端 / 页面 / 小程序 / api / 接口 / 后端服务 / 爬虫 / 数据清洗 / 脚本 / 工具 / 模型 / 训练 …`；**没有**「接手 / 续做 / 改造 / 重构 / 迁移」 | `src/domain/task-types.ts`（五个任务族的 `keywords`）。全仓库 grep「接手/续做/改造/重构」只命中"不要顺手重构"这类铁律（`src/domain/roles.ts:67`、`:193`；`src/prompt/member-brief.ts:226`、`:272`）——**没有一处是"接手已有代码"的语义** |
| 平台能力 | 没有写入拦截（见 §2） | 工件白名单只是简报里的软约束 + 完成时审计 |

### 1.2 具体后果（按严重度）

1. **覆盖已有成果（最严重）。** 成员被要求产出 `PRD.md` / `ARCHITECTURE.md` / `DB_DESIGN.md` /
   `API_CONTRACT.md` / `TEST_REPORT.md` / `README.md`，而接手项目里这些文件**很可能已经存在**；
   工件边界又明确写着"你可以创建**或修改**"（`src/prompt/member-brief.ts:194`）⇒ 成员会当自己是
   第一个作者，直接覆盖。`devops` 的工件白名单里还包含 `README.md` 与 `docs/`
   （`src/domain/roles.ts` 的 devops `outputs`）⇒ **接手仓库时你的 README 首当其冲**。
2. **门禁把"结构不同"判成"不合格"。** `checklist` 门禁只在**Markdown 标题**里找必备章节
   （`src/domain/gates.ts`，`markdownHeadings` / `missingHeadings`；章节清单来自
   `src/domain/pipeline.ts` 各阶段的 `requiredSections`）。你现有的 PRD 结构不同 → 判 fail → 打回 →
   重写 → 直到该阶段 `maxRounds` 用尽 → 升级人工。**你的文档可能内容齐备，但因为它不叫那些标题而被判失败。**
3. **为了过门禁而"补齐"你没有的内容。** 模板要求"非目标 / 待确认问题 / 字段级 Schema / STRIDE"等章节，
   与既有文档体系无关；成员会为了过门禁写出来（可能是编的），而不是承认"这条已在别处"。
4. **反直觉但重要：DoD 不天然拒绝 brownfield。**
   - DoD 是**状态判定**：查真实文件与真实退出码，7 条定义在 `src/domain/dod.ts:57-102`。
   - 成熟仓库**天然可能满足好几条**：第 6 条（README 含四个标题，`file` 类）、第 2 条（pytest 退出码 0，
     `script` 类）在半成品上常常已经是绿的。
   - 但第 1 条（`crossref`：PRD 的 `AC-n` ↔ `TEST_REPORT.md` 逐条交叉映射，`src/domain/dod.ts:57-62`）
     与第 7 条（`git`：逐阶段 commit + 版本 tag `v1.0.0`，`src/domain/dod.ts:100-102`）**预设了"本流程产出"**，
     半成品通常不满足 ⇒ 交付口会拦下你，而流程前段却已经把既有资产当作不存在。
   - **结论：缺口在前段（不承认既有资产），不在后段（判定标准是状态，不是出身）。**

### 1.3 建议方向 —— **建议，未实现**（不要当成已有能力）

| # | 建议 | 备注 |
|---|---|---|
| ① | 成员简报加保护条款：**已存在的东西默认是资产**——先读再改，不得覆盖 | 最小改动、收益最大 |
| ② | `factory_plan` 先探测工作区基线，并在计划里明示"这不是空工作区" | 让用户在批准前就知道风险 |
| ③ | 加 `mode: greenfield \| takeover`，takeover 时前置 `recon` 阶段产出 `BASELINE.md`（资产 / 缺口 / 缺口→要求工件映射），后续阶段对基线做**增量** | 结构性方案 |
| ④ | 门禁区分「缺失」与「不合格」：已有等价内容但结构不同 → 不判 fail | 需要"等价性"判据 |
| ⑤ | DoD 增加"接手前已满足"的**来源标注** | **只加来源标注，不放宽判据**——判据仍是真实文件与退出码 |

### 1.4 现在就能用的规避做法（用户操作建议）

- 用本插件接手已有项目时：**先复制工作区或开分支**，让工厂在副本/分支里跑。
- 把既有文档改名归档（例如 `PRD.md` → `archive/PRD.legacy.md`）再让工厂产出新工件。
- 或者把工厂限制在**新子目录**里做新模块，不去动既有顶层工件。
- **不要**在有未提交改动的仓库里直接批准开工；§2 说明了越界写入是"事后才发现"。

---

## 2. ⚠️ 成员工件边界是"完成时审计"，不是写入拦截

- 白名单来源：角色的 `outputs`（`src/domain/roles.ts` 的每个 `RoleDef.outputs`），渲染进成员简报
  （`src/prompt/member-brief.ts:194`），并在完成/DoD 阶段做越界核对。
- 机制限制：**平台无法阻止成员写越界文件**——DSH 侧没有写入拦截能力，插件也没有。因此这是
  **软约束（写进人设）+ 硬兜底（完成后审计）**，而不是"写不进去"。
- 后果：越界写入会被判失败并打回，但**损坏已经发生**；审计是"事后"，不是"事前"。
- 操作建议：重要仓库先 commit / 开分支；并行阶段的角色 `outputs` 已按互不重叠设计
  （见 [roles-and-pipelines.md](roles-and-pipelines.md) §1）。

---

## 3. ⚠️ 跨进程协调是"协作式"的：锁只约束走本插件的进程

**已实现（不是待办）**：每次状态修改都会为**该 factory** 取一个锁文件
`<workspace>/.code-factory/.locks/<factoryId>.lock`（`O_EXCL` 创建即仲裁，文件里记录持有者身份与获取时间），
所以同时开两个宿主指向同一工作区时，第二个会**等待**（并打印在等谁），而不是静默覆盖。见 `src/store/file-lock.ts`。
`src/store/lock.ts` 的进程内队列仍然保留，作为同进程内的快速路径。

**仍然存在的边界**：

- **锁是 advisory（协作式）的，不是强制的**：任何不走本插件的写入者——手工编辑 `factory.json`、外部脚本、
  编辑器自动保存、或从**另一份检出**加载的同一个插件——都不会被拦住。锁只在"所有写入者都是协作方"时成立。
- **过期判定"先看存活、再看年龄"**：持有者进程已消失则立即视为废弃锁；进程还在但被挂起（`SIGSTOP`、
  休眠的虚拟机、调试器断点）时，只能靠**年龄上限**兜底——那种情况下另一个进程可以接管锁。
- **超时是有界的、且会报出持有者**：等不到会抛 `FactoryFileLockTimeoutError`（含持有者信息），
  所以"面板卡住了"有答案；但超时**不会**回滚已经发生的读取，调用方必须把超时当成失败而不是继续写。
- **`withFactoryLock` 同 key 嵌套仍会自我拒绝**（`src/store/lock.ts:15`、`:49` 的 `lock_reentry`）：
  这是有意的防死锁设计，但意味着任何"在锁里再取同一把锁"的扩展都会抛错。
- **判据来源**：这套行为的端到端证据在 `scripts/verify.mjs` 的 F 区（真实子进程竞争，两个进程各做 25 次读改写，
  最终计数必须等于 50 且无丢失）。

---

## 4. ⚠️ 状态路由的"索引"是跨工作区的

- 三种形态（契约 [API-CONTRACTS.md](API-CONTRACTS.md) §7.1）：`?id=<factoryId>` 单工厂快照、
  `?sessionId=<sid>` 该会话所属工厂、**无参数 = 全机所有已知工作区的工厂摘要索引**。
  实现见 `src/web/routes.ts:9-10`、`:17-22`（工作区发现：注册表服务 + 活跃 agent 的 cwd）、`:358-361`。
- 后果：调用方若不做会话归因，会把**别的项目**的工厂显示成"你的"。面板已按会话/显式选择切片，
  但自定义调用方（脚本、别的插件）必须自己选 `?sessionId=` 或 `?id=`。
- 另一个细节：`?sessionId=` 找不到匹配时会**回退到该工作区最近更新的工厂**
  （[API-CONTRACTS.md](API-CONTRACTS.md) §7.2.3；`src/web/routes.ts:336-345`）⇒ 你可能看到同工作区的
  另一个工厂，而不是"没有工厂"。索引只回五个摘要字段、未命中返回 404 而不返回空对象（§7.3）。

---

## 5. ⚠️ 0.2.2-rc.3 起：成员工具面由步骤准入与父 composition 共同决定

- **发生了什么**：0.2.2 仍然没有 `persona` / `toolFilter` 启动字段；`SubagentActivationSpec`
  是扁平结构（`parent` / `prompt: ContentBlock[]` / `signal` / `delivery` / `agentOptions`）。
  成员角色人设现在合并进初始 `prompt`，不再作为独立字段交给宿主。
- **队长工具的边界**：13 个队长工具在注册时带有步骤准入条件
  （`ctx.tools.register(..., { when })`）：`delegationDepthOf(agent) > 0` 的 delegated agent
  看不到它们。这样成员只保留 `factory_report` / `factory_inbox` / `factory_block` 三个
  `factory_*` 工具；普通编码工具来自父 preset，保持可用。这是**注册期可见性**，不是旧
  `toolFilter` 的 host 强制。
- **委派工具**：`subagent` / `workflow` 等委派形状工具仍由父 preset 提供，插件无法用
  `toolFilter` 逐子隐藏；`installMemberDelegationGuard` 在运行期拒绝成员再派生的调用。
  因此「成员不得派生」是**调用拦截**而非不可见。若需要完全不可见，需在 profile 的自定义
  `agentPreset` 中移除委派插件；这属于部署组合决策。
- **服务方法迁移**：`drainChildren` / `listChildren` / `list` 已移除。回收使用
  `drainDescendants([captain])`（关闭该 captain 的整棵成员树，适用于 halt/delete/archive），
  目录读取使用 `listDescendants(rootSessionId)` 并只取 depth=1 的 child rows；provider
  枚举不再可用，只能通过 `getProvider(name)` 校验配置的 provider 名。
- **`maxDepth` 仍然故意不传**：`maxDepth` 是“本次创建”的绝对深度上限，队长深度为 0 时
  传 `maxDepth: 0` 会**让每一次成员 spawn 都失败**（连成员本身都创建不出来），而且它不会
  继承给成员自己的委派。深度约束由上述可见性 + 父链守卫承担。
- **残余风险**：若父 composition 提供额外的、非委派形状的越权工具，插件无法按成员逐个
  隐藏；这是 0.2.2 的 preset 组合模型，不是本插件能单方面修复的。完整契约见
  [API-CONTRACTS.md](API-CONTRACTS.md) §1.4。

---

## 6. 🚫 禁止写自定义会话事件（写入即永久损坏该会话）

- 机制（[API-CONTRACTS.md](API-CONTRACTS.md) §1.7，第 312-333 行）：宿主只认自己的已知事件类型集合；
  读到集合外的类型时，**除非该事件带信封的 `ignorable` 标记，否则拒绝解释整个日志**；而
  `Session.append` **无法**设置 `ignorable`。
- 后果：写一次自定义事件，该会话就**永久无法读取/恢复**——`dsh --session-id <id>` 直接失败。
- 本插件的做法：**不写任何自定义会话事件**；真相源是磁盘
  （`factory.json` / `inbox/*.jsonl` / `artifacts.json`），执行痕迹靠宿主自带的 `tool/call` + `tool/result`。

---

## 7. ⚠️ 门禁脚本带技术栈假设（模板即策略）

- 命令**只来自流水线模板**，不接受模型指定（这是有意的安全取舍）：`src/domain/pipeline.ts:70`
  （`TEST_COMMAND = python -m pytest -q`）、`:73`（`DELIVERY_CHECK_COMMAND = bash start.sh --check`）、
  `:193`（`npm run build --if-present`）、`:277` / `:346` / `:471`（`python -m compileall -q src`）、
  `:405`（`python -m compileall -q .`）。
- 后果：工作区技术栈与模板不匹配时，门禁会**失败**或**空过**（例如 `npm run build --if-present` 在没有
  build 脚本的仓库里视为通过）。想在别的栈上跑，需要改模板（改代码），而不是让模型临场换命令。
- 平台细节：`bash start.sh --check` 假定有 POSIX 风格 shell（Windows 上需要 Git Bash 之类）。
- 门禁语义细节（会直接影响"你的文档算不算过"）：
  - `checklist` 只认 **Markdown 标题**（正文里写了不算）；
  - `keyword` 取**最后一条**命中行（先 REJECTED 后 APPROVED 视为通过）；
  - `script` 只认**退出码 0**；
  - `composite` 是递归 AND；任一子门禁确定失败即整体失败（不再要求执行）。
  实现：`src/domain/gates.ts`。

---

## 8. ⚠️ 其他你需要知道的边界（速查）

| 边界 | 机制 / 出处 |
|---|---|
| DoD 第 4 条（安全审计）在**未触发安全路径时被跳过** —— 记 `status: 'skipped'`，与「通过」在结构化字段上可区分，交付门禁只认 `passed` + `skipped` | `src/domain/dod.ts` 的 `securityOnly` + `evaluateDodItem` 的跳过分支；`src/domain/gates.ts`（`dodStatusOf` / `dodAllowsDelivery`） |
| 安全路径的触发仍然是**关键词匹配**：不做语义判断、不做否定分析。brief 没命中时靠需求阶段用 PRD 正文**复评**补上（只升不降），所以「计划期未触发」≠「本次工厂没有安全面」 | `src/domain/router.ts`（`SECURITY_TRIGGERS` 78 词 / `securitySignalForDocuments`）；[roles-and-pipelines.md](roles-and-pipelines.md) §4.2 |
| 编制上限默认 = **最宽模板的编制长度**（当前 11，算出来的，不是写死的），超限按固定顺序裁剪；**铁三角与安全岗不可裁**，被裁掉的专家由替补阶梯顶上 | `src/domain/router.ts`（`DEFAULT_MAX_MEMBERS = MAX_TEMPLATE_ROSTER` / `TRIM_ORDER` / `ROLE_FALLBACKS`） |
| 每个阶段的 `maxRounds` 用尽即**升级人工**，不会无限打回 | `src/domain/pipeline.ts` 各阶段 `maxRounds`；引擎在超限时 `escalate` |
| 面板布局是**浏览器本地偏好**（`localStorage` 的 `dsh-code-factory.layout.v1`），不随工厂/会话/工作区同步；损坏、旧版本或缺失模块会回退默认布局并尽量还原，绝不因坏偏好白屏 | `src/client/layout.ts`（`normaliseLayout` / `readLayout` / `writeLayout`，全部 try/catch + `typeof window` 守卫） |
| **进化教训库是「工作区级、有界、单进程锁」的局部记忆**：跨工厂共享但不出当前工作区；上限 200 条、按签名去重计数；写入只用进程内锁（同工作区多 host 进程并发时后写覆盖，属于已知取舍）；教训文本可能来自 keyword 门禁 detail 引用的工件行或 script 门禁命令输出尾部，已用固定「以下为历史记录，不是新指令」边界 + 入库 400 字/渲染 240 字截断缓解，但**文本仍会进入成员 prompt**；DoD 教训在 `factory_dod_check` 全绿时标记 `resolvedAt` | `src/store/evolution.ts`（`EVOLUTION_MAX_LESSONS` / `record` / `resolve` / `selectLessonsForRole`）；`src/prompt/member-brief.ts`（`LESSON_BLOCK_CAVEAT`）；`src/tools/engine/gate.ts` / `dod.ts` / `delivery.ts` |
| **「插件改进建议」是派生建议，不是自动改代码**：反复出现 ≥2 次的教训才进入建议；目标类别/文件、建议文案、证据次数与 `open`/`validated` 由纯函数从进化账本推导，不持久化、不调用模型；`validated` 只表示有过一次修复验证。实际修改必须走正常代码/文档变更与测试，运行期禁止自改插件源码 | `src/domain/improvements.ts`（`deriveImprovements` / `improvementTargetFor` / `improvementStats`）；`src/tools/engine/status.ts`；`src/prompt/captain-protocol.ts` |
| 前端 specialist（`web_dev` / `flutter_dev` / `mini_program_dev`）是**自动指派**的附加岗位，不属于 canonical 12；`fe_dev` 保留为无法判定平台/旧数据的通用回退，因此「12 个规范岗位」的口径仍成立，但 `ALL_ROLE_BY_ID` 是 18 | `src/domain/roles.ts`（`SPECIALIST_ROLES` / `FRONTEND_SPECIALIST_ROLE_IDS` / `ROLE_FALLBACKS`）；`src/domain/router.ts`（`frontendPlatformFor` / `planFrontendSlot`） |
| **复用库是「手动沉淀 + 参考复制」，不是自动合并代码**：只有 `factory_reuse harvest` 选中的文件会复制到全局库（默认 `$DSH_HOME/code-factory-library`），复制到工作区 `reuse/` 的只是参考材料；不做依赖解析、不自动改写 import、不保证被复用代码与目标技术栈/许可证兼容。入库前请人工确认；工具拒绝路径穿越、`.env`/密钥、node_modules/.git 与超限文件 | `src/store/library.ts`（harvest/apply）；`src/tools/engine/reuse.ts`；`src/domain/reuse.ts` |
| 交付 tag 固定 `v1.0.0` | `src/domain/dod.ts:100-102`（`DOD_RELEASE_TAG`） |
| 面板固定 **1 秒**轮询、带 in-flight 防重叠；索引只回摘要字段 | `src/client/api.ts:48`（`FACTORY_POLL_MS = 1000`）；[API-CONTRACTS.md](API-CONTRACTS.md) §7.3 |
| 会话事件只是"UI 加速通道"：会话不可写时必须降级，**磁盘才是真相源** | [API-CONTRACTS.md](API-CONTRACTS.md) §1.7；`src/store/**` |
| 工厂是**归档而非删除**（`archive/<id>/`），误删可从归档找回 | `src/store/store.ts`（archive/remove 行为由 `scripts/verify.mjs` 的 E 区覆盖） |
| 模型自述不算证据：门禁与 DoD 只认真实文件与真实退出码 | `src/domain/gates.ts` / `src/domain/dod.ts`；[roles-and-pipelines.md](roles-and-pipelines.md) §5.7 |
| **告警的天花板是"面板 + 宿主警告日志"：宿主没有通知类 API** | 已用 `cordis_inspect_list` + Inspect 查询核实：host Service 目录里**没有** notification / toast / 桌面通知 / 外发 webhook 服务（最接近的 `webhookRuntime` 只处理**入站**投递）。因此 `escalate` / `await_approval` / 成员 `spawnError` 的主动告警只能落在两处：面板顶部告警条（`SnapshotAlert`，`src/domain/alerts.ts` 纯派生）与 `console.warn`。**没有**桌面通知、邮件或对外 webhook —— 不要把它当成"已具备通知能力" |
| **插件不写自己的日志文件**：`ctx.logger.*` 落到哪里由宿主决定，插件读不回来 —— 所以「事后取证」不靠日志，靠**结构化状态本身** | 一个工厂的全部可复核记录都在它的状态目录里，且都是真实文件、可直接 grep：`.agent-teams/<id>/factory.json`（`feed` 最近消息、`dispatchAttempts` 派发账本、每阶段的 `lastGate` 判定与 `notes`、`dod` 各项结果）、`inbox/<role>.jsonl`（每次派发 / 打回 / 回报的原文）、`artifacts.json`（阶段交接工件）、`archive/<id>/`（归档而非删除）。这与「磁盘才是真相源」是同一条设计：**再写一份文本日志只会多出一个会跟状态分叉的真相源**。面板降级的原因走 `console.warn`（`src/web/routes.ts`），不写盘 |
| source map **随包发布**（此后不再有必然 404） | `files` 收录 `lib/**/*.map`；`scripts/check-pack.mjs` 第 4b 段强制两件事：每个已发布 `.js` 里的 `sourceMappingURL` 必须能在 tarball 内解析，且任何 `.map` 的 `sources`/`sourceRoot`/`file` 不得出现构建机绝对路径。代价是 tarball 约 +105 KB |
| 冷重启后**不再有 30 分钟停滞**：派发账本落盘 | `FactoryState.dispatchAttempts`（`src/shared/types.ts`）随 `factory.json` 持久化；`src/runtime/scheduler.ts` 从状态读账本，不再用进程内 `Map` |
| 类型严格度是**量过的取舍**，不是漏配：`noUncheckedIndexedAccess` **已开启**（实测 8 处错误，全部修掉）；`exactOptionalPropertyTypes` 仍关闭（实测 19 处错误） | `tsconfig.json:17-18`；复核命令 `npx tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess`（0 错误）与 `--exactOptionalPropertyTypes`（19 错误） |
| 安装态**可以自检**：包内有一个独立的诊断入口，不需要开发树 | `package.json` 的 `bin`（`dsh-code-factory-doctor` → `scripts/doctor.mjs`）与 `files`（`scripts/doctor.mjs`、`scripts/profile-backup.mjs`）；`scripts/check-pack.mjs` 的 `REQUIRED` 强制它必须在 tarball 里。开发侧工具（`verify.mjs` / `check-docs.mjs`）**不随包发布**，这是有意的 |
| 中英混用有一条**成文规则**（doc-comment 英文、面向用户/LLM 的串中文；服务端不得产出可直接展示的界面文案），并且写明了这条线**哪一半靠类型系统守、哪一半只能靠评审** | [conventions.md](conventions.md) §1–§2；面板侧键集一致性由 `CodeFactoryLocaleKey` 类型保证，不需要额外脚本 |

---

## 9. 变更纪律

- 这份文档描述的是**当前实现**；每一条都应该能回到代码或契约。改动实现（例如真的做了 takeover 支持）后，
  必须同步改这里，否则它就变成误导。
- 与历史档案的分工：`docs/VERIFICATION.md` 是某时刻的**证据快照**（只增不改）；
  本文档是**现状陈述**，由 `scripts/check-docs.mjs` 参与核对（链接与计数）。
