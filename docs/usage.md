# code-factory 操作者手册

> **读者**：要在会话里驱动 code-factory 这台「多 Agent 开发流水线」的人——说出目标、批准计划、在门禁与打回之间做决定、最后收货的人。这不是插件开发文档；开发视角见 `docs/architecture.md`，接口契约见 `docs/API-CONTRACTS.md`，角色与流水线模板见 `docs/roles-and-pipelines.md`。
>
> **数字口径**：本文出现的**所有数量都以代码为准**。工具清单取自 `src/tools/captain.ts` 与 `src/tools/member.ts` 里 `defineTool({ name, parameters })` 的定义；阶段 / 门禁 / 打回目标取自 `src/domain/pipeline.ts`；门禁语义取自 `src/domain/gates.ts`；DoD 条目取自 `src/domain/dod.ts`；状态取值取自 `src/shared/types.ts` 与 `src/store/state.ts`。凡涉及计数，本文都写成「数量（出处）」的形式；文档只是索引，与代码冲突时以代码为准。

## 目录

1. [快速开始](#1-快速开始)
2. [两阶段协议](#2-两阶段协议-plan-然后-approve)
3. [工具参考](#3-工具参考)
4. [状态模型](#4-状态模型)
5. [五类门禁](#5-五类门禁)
6. [打回循环](#6-打回循环)
7. [人工审批点](#7-人工审批点)
8. [常见操作剧本](#8-常见操作剧本)
9. [故障排查](#9-故障排查)
10. [已知限制](#10-已知限制)

---

## 1. 快速开始

### 1.1 两条入口

| 入口 | 你怎么说 | 适合什么场景 | 背后发生什么 |
|---|---|---|---|
| **自然语言** | 「用 code-factory 做 X」「让工厂团队把 X 做出来」 | 目标还在聊的过程中成形；你想先补充上下文、边聊边改 | 那一轮仍是你自己的消息。插件激活时会把队长协议作为 system prompt section 注入（`src/index.ts` 的 `ctx.systemPrompt.section`，文本在 `src/prompt/captain-protocol.ts`），所以队长看到你的意图后会自己走两阶段协议 |
| **斜杠命令** | `/factory <目标>` | 目标已经想清楚，想一次把协议钉死、少绕一轮 | `src/command.ts` 的 handler **不把你的命令行发给模型**，而是注入**一条** follow-up 消息：「你的目标原文 + 激活指令」。本轮第一次模型请求就带着「先 staged 规划、批准后才组队」的硬约束 |

两条入口的差别只有「怎么开场」。开场之后的推进方式完全一样（§2、§3）。

几个细节：

- `/factory` 后面不写目标也可以：激活指令会让队长先用一句话问你这次要做什么，**不会**自行 `factory_plan`。
- 注入的那条消息带自定义来源 `{ kind: 'code-factory-command', goal }`，所以它不会被渲染成"你打的字"；渲染面可以用 `goal` 字段恢复你的原话。
- 斜杠命令面由配置 `slashCommand` 控制，默认开启（`src/index.ts`）。关掉它以后自然语言入口不受影响。

### 1.2 第一次会看到什么

队长呼叫 `factory_plan` 之后，你会看到一份 **staged 计划**：

- **任务类型（taskType）**与它对应的流水线模板；
- **团队编制**：每个角色的职责与工件边界（`team` 行）；
- **阶段顺序**与每阶段的门禁类型、`failGoto`（打回目标）、`maxRounds`（打回轮次上限）；
- **安全岗是否被触发**（`securityTriggered`）；
- 以及 `nextAction`：当前唯一正确的下一步。

这时你只需要回一句话：**批准**，或者**指出要改哪里**。计划还没批准之前，工厂里**没有任何成员会话**——不会消耗成员的 token，也不会有人自作主张开工。

### 1.3 一分钟流程

```text
你说目标
  └─ 队长 factory_plan           → 只写盘，产出 staged 计划（不创建任何子会话）
       └─ 你说「批准」
            └─ 队长 factory_approve   → 唯一会创建成员会话的入口
                 └─ 反复：factory_dispatch 派发 → 成员干活 → factory_report 回报
                          → factory_gate 门禁裁决（advance / reject / escalate / await_approval）
                 └─ 全部阶段 passed → factory_dod_check（DoD 总验收全绿）
                      └─ factory_deliver 交付
```

---

## 2. 两阶段协议：plan 然后 approve

这两步**不可合并**，是这台工厂最重要的一条纪律。

### 2.1 阶段一：`factory_plan` 只写盘

`factory_plan` 把计划写进 `<workspace>/.code-factory/<factoryId>/factory.json`，**不创建任何子会话、不唤醒任何成员**。返回里的 `spawnedMembers` 与 `childSessions` 都是 `0`，可用它自证"这一步没有偷偷开工"。

它的用途是给你一个**否决点**：在花掉成员 token、开出好几个子会话之前，先看清目标怎么分解、由谁来做、每阶段怎么判定合格。

### 2.2 阶段二：`factory_approve` 是唯一的 spawn 入口

只有你说过「可以 / 批准 / 开始」之后，队长才允许调用 `factory_approve`。它把 `phase` 从 `staged` 推到 `running`，并且**只唤醒第一阶段真正要干活的成员**，而不是把所有人一次叫起来。重复调用是幂等的：已 `running` 的工厂返回 `alreadyApproved=true`，不会重复 spawn。

### 2.3 计划改到满意为止

对计划有意见时用 `factory_edit_plan`（brief / 名称 / 任务类型 / 编制 / 上限 / 一次说明）。改完 `planReviewState` 回到 `awaiting_review`：**必须重新等你批准**。

一旦批准（更准确地说：一旦有成员会话），`factory_edit_plan` 会拒绝执行——编制已冻结，此时只能走 `factory_message`（补指令）或门禁打回单（§6）来调整。

### 2.4 为什么这么设计

- **成本前置可见**：编制与阶段在开会话之前就摊开，错了只损失一轮文本。
- **批准即契约**：你批准的那份编制/门禁就是后面所有裁决的依据，队长不能中途即兴改编制。
- **审计可回溯**：`staged` 与 `running` 两个阶段都在磁盘上有记录，任何"我以为是那样"都能用 `factory_status` 核对。

---

## 3. 工具参考

### 3.1 总表

共 **16 个** `factory_*` 工具：**13 个**队长工具（`src/tools/captain.ts`）+ **3 个**成员工具（`src/tools/member.ts`）。队长工具**不外借给成员**；成员只有 `factory_report` / `factory_inbox` / `factory_block` 三个。表中 `*` 表示必填参数。

| 工具 | 用途 | 关键参数（代码派生） | 何时用 | 返回什么 | 幂等 |
|---|---|---|---|---|---|
| `factory_plan` | 生成 staged 计划（唯一规划入口） | `brief*`、`name`、`taskType`、`members[]`、`maxMembers` | 用户给了目标、还没有已批准的计划时 | 计划详情 + `factoryId` + `team` / `stages` + `notes` + `nextAction` | 是（同一 brief 复用已有 staged 计划，`reusedPlan=true`） |
| `factory_edit_plan` | 修改还没批准的 staged 计划 | `factoryId*`、`brief`、`name`、`taskType`、`members[]`、`maxMembers`、`note` | 用户对计划有意见、计划仍 staged、且没有成员会话 | 计划详情 + `changedFields` + `editedAt` | 否（每次写一条修订 feed；改完仍是 `awaiting_review`） |
| `factory_approve` | staged → running，按需唤醒成员（**唯一 spawn 入口**） | `factoryId*` | 用户明确说「可以 / 批准 / 开始」之后 | `decisions` / `spawned` / `missingRoles` + `nextAction` | 是（`alreadyApproved=true`，不重复 spawn） |
| `factory_dispatch` | 推进当前阶段：算出"现在谁有活"并派发 | `factoryId*`、`stageId`、`findings[]`、`note` | 刚批准之后；阶段通过或被打回之后要往下走时 | 每个角色的决策（spawn / wake / rework / wait / skip / escalate）+ `nextAction` | 是（不重复派发；当前没有派发项时返回 `wait`） |
| `factory_gate` | 对当前阶段做门禁裁决 | `factoryId*`、`stageId`、`findings[]`、`humanConfirm`、`minCommits` | 成员 `factory_report(status=done)` 之后；或阶段停在门禁要解封时 | `action`（advance / reject / escalate / await_approval / delivered）+ `detail` + `round` / `maxRounds` + `dod` | 否（裁决会推进/回退阶段并改轮次） |
| `factory_status` | 只读读磁盘真相 | `factoryId`、`sessionId`、`feedLimit` | **每次做推进决策之前**；不确定状态时；复盘/规划前顺带查看 `evolution.improvements`（反复教训 → 插件改进建议） | 工厂 / 成员 / 阶段 / DoD / 工件 / 未读 / feed + `executorAudit` + `evolution`（含 `improvements`：total/open/validated + 前 5 条建议）+ `nextAction` | 是（不写盘、不派发、不唤醒） |
| `factory_reuse` | 跨项目复用库：检索/沉淀/复制已交付系统的模块与文档 | `action*`（list / search / harvest / apply）、`query`、`taskType`、`tags[]`、`kind`、`limit`、`factoryId`、`paths[]`、`name`、`description`、`taskTypes[]`、`entryId`、`targetDir`、`overwrite` | 已交付工厂沉淀可复用资产；新项目规划命中时检索/复制到 `reuse/`；确认后按项目需求改造 | `entries[]` / `entry` / `appliedFiles[]` / `targetDir` / `notes` / `nextAction` | 否（harvest/apply 写库或工作区；search/list 只读） |
| `factory_message` | 往某个收件人的邮箱写一条消息，默认同时投递 | `factoryId*`、`to*`、`content*`、`kind`、`stage`、`round`、`deliver` | 给成员补指令或背景；给自己（`to=captain`）留审计记录 | `messageId`、`delivered`、`via` / `mode`、`error` | 否（每次新增一条消息） |
| `factory_dod_check` | 跑 DoD 总验收并把结果写进 `factory.json` | `factoryId*`、`minCommits` | 交付之前必跑；也可用来查看"还差哪几条" | `ok` / `passed` / `failed` / `pending` + `items` + `commands` + `missing` | 基本幂等（刷新同一批结果；会真实重跑命令） |
| `factory_halt` | 暂停工厂（磁盘状态保留） | `factoryId*`、`reason` | 用户说「先停一下」或需要人工介入时 | `phase=halted`、`interrupted` / `failed` | 是（`alreadyHalted=true`） |
| `factory_resume` | 恢复被暂停的工厂 | `factoryId*`、`reason*` | 用户明确要求继续时（要写明在哪儿说的） | `phase=running`、`currentStage` | 是（`alreadyRunning=true`）；它**不派发**工作 |
| `factory_deliver` | 交付（会重新跑一次 DoD） | `factoryId*`、`deliveryPath`、`note`、`minCommits` | `factory_dod_check` 全绿之后，作为最后一步 | `delivered`、`dodPassed` / `dodTotal`、`blocked` | 是（`alreadyDelivered=true`） |
| `factory_delete` | 结束工厂：默认归档，可选真删 | `factoryId*`、`mode`（archive / destroy）、`confirm` | 用户确认不再需要这个工厂时 | `mode`、`archived` / `removed`、`drained`、`path` | 基本幂等（已结束的工厂不会重复回收成员；`destroy` 必须 `confirm=true`） |
| `factory_report` | **成员**向队长回报本阶段进展 | `status*`（working / done / blocked / note）、`summary*`、`factoryId`、`stage`、`artifacts[]`、`commands[]`、`next` | 完成本阶段工件后（`done`）；说明进展（`working`）；卡住（`blocked`） | `settledAttempts`、`artifactsRegistered`、`artifactRejected`、`messageId` | 否（每次写一条回报并结算 attempt） |
| `factory_inbox` | **成员**读自己的邮箱 | `factoryId`、`limit`、`includeRead`、`markRead` | 被唤醒之后第一件事；或不确定下一步做什么时 | `messages[]`、`markedRead`、`remainingUnread` | 基本幂等（默认读后标已读；`markRead=false` 才是纯读） |
| `factory_block` | **成员**上报 BLOCKED 并升级给队长 | `reason*`、`need`、`factoryId`、`stage` | 缺必要输入 / 契约矛盾 / 环境不可用，且无法在不越界的前提下继续 | `blocked`、`messageId`、`need` | 否（每次写一条 BLOCKED） |

### 3.2 参数速查（逐工具，直接从 `parameters` 派生）

队长工具（`src/tools/captain.ts`）：

```text
factory_plan        brief*:string  name:string  taskType:enum  members:string[]  maxMembers:number
factory_edit_plan   factoryId*:string  brief:string  name:string  taskType:enum  members:string[]  maxMembers:number  note:string
factory_approve     factoryId*:string
factory_dispatch    factoryId*:string  stageId:string  findings:string[]  note:string
factory_gate        factoryId*:string  stageId:string  findings:string[]  humanConfirm:boolean  minCommits:number
factory_status      factoryId:string  sessionId:string  feedLimit:number
factory_reuse       action*:enum(list|search|harvest|apply)  query:string  taskType:string  tags:string[]  kind:enum  limit:number  factoryId:string  paths:string[]  name:string  description:string  taskTypes:string[]  entryId:string  targetDir:string  overwrite:boolean
factory_message     factoryId*:string  to*:string  content*:string  kind:enum  stage:string  round:number  deliver:boolean
factory_dod_check   factoryId*:string  minCommits:number
factory_halt        factoryId*:string  reason:string
factory_resume      factoryId*:string  reason*:string
factory_deliver     factoryId*:string  deliveryPath:string  note:string  minCommits:number
factory_delete      factoryId*:string  mode:enum(archive|destroy)  confirm:boolean
```

成员工具（`src/tools/member.ts`）：

```text
factory_report      status*:enum(working|done|blocked|note)  summary*:string  factoryId:string  stage:string  artifacts:string[]  commands:string[]  next:string
factory_inbox       factoryId:string  limit:number  includeRead:boolean  markRead:boolean
factory_block       reason*:string  need:string  factoryId:string  stage:string
```

几点解释：

- **队长工具的 `factoryId` 必填**，`factory_status` 例外：不带参数时列出本工作区的工厂索引，并回退到当前会话自己的工厂；也可以用 `sessionId` 按会话等值查它所属的工厂。
- **成员工具的 `factoryId` 可省略**：成员通常只属于一个工厂，省略时按 `members[].sessionId === 本会话` 自动解析。
- `stageId` 省略时取流水线里第一个未通过的阶段。
- `findings` 是**可执行的整改条目**（每条说清"哪里不合格 + 改成什么样"），打回时会原样写进责任角色的邮箱；`factory_dispatch` 与 `factory_gate` 共用这个参数。
- `minCommits` 只影响要求"逐阶段 commit"的门禁/DoD 条目的门限，默认 `1`。
- `factory_message` 的 `kind` 取 `dispatch` / `reject` / `handoff` / `report` / `blocked` / `approval` / `system`；`deliver=false` 表示只写邮箱、不投递给会话。

### 3.3 幂等与副作用

"幂等"在这里指**对同一份磁盘状态重复调用不会产生第二次副作用**。典型例子：

- `factory_approve` / `factory_halt` / `factory_resume` / `factory_deliver` 都会用 `alreadyXxx` 字段告诉你"这次调用没有改变任何东西"。
- `factory_dispatch` 不会重复派发：成员已在工作、或已有未完成的派发时，它返回 `wait`（这不是故障，见 §9.2）。
- `factory_status` 是纯读：它连"状态过期的成员"都只解释、不修（§9.4）。
- `factory_gate` **不是**幂等的：一次裁决会推进阶段、回退阶段、增加轮次或升级人工。
- `factory_message` / `factory_report` / `factory_block` **不是**幂等的：每次调用都会往邮箱追加一条新消息。

### 3.4 队长的推进循环

```text
factory_dispatch → 等成员用 factory_report（完成）或 factory_block（卡住）回报
                 → factory_gate 裁决
                 → advance / reject / escalate / await_approval / delivered
```

任何时候都可以用 `factory_status` 读磁盘真相来决策；需要留痕迹就用 `factory_message`。**不要凭记忆推进流水线**：每个工具返回里的 `nextAction` 才是权威指引（§9.1）。

---

## 4. 状态模型

真相源是磁盘上的 `factory.json`（`FactoryState`）；`factory_status` 只是它的只读投影。

### 4.1 工厂 `phase`

| 值 | 含义 | 什么时候变成它 |
|---|---|---|
| `staged` | 计划已写盘、等用户批准 | `factory_plan` / `factory_edit_plan` |
| `running` | 正在推进 | `factory_approve`；`factory_resume` |
| `halted` | 暂停（成员会话保留、磁盘状态保留） | `factory_halt` |
| `delivered` | 已交付（终态） | `factory_deliver` 在全阶段 passed + DoD 全绿之后 |
| `discarded` | 已结束（终态；目录已归档或删除） | `factory_delete` |

合法迁移由 `src/store/state.ts` 的 `FACTORY_PHASE_TRANSITIONS` 固定：`delivered` 与 `discarded` 是终态，不能再改。

### 4.2 `planReviewState`

- `awaiting_review`：计划已写好、正等用户批准。`factory_plan` 与 `factory_edit_plan` 都会写回这个值。
- `awaiting_feedback`：语义是"等用户说明要改什么"。类型定义在 `src/shared/types.ts`（`PlanReviewState`），`nextAction` 也认它；当前引擎的 plan / edit 路径都写 `awaiting_review`，所以**正常流程里你不会看到它**。

### 4.3 阶段状态

| 值 | 含义 | 什么时候变成它 |
|---|---|---|
| `pending` | 还没派发（或被 `failGoto` 回退重置） | 初始；打回回退重放时 |
| `active` | 正在做 | `factory_dispatch` 派发该阶段时 |
| `gate` | 等门禁裁决（含"门禁已过、等人工确认"） | 成员回报后、队长裁决之前；`humanApproval` 未确认时也停在这 |
| `passed` | 门禁通过 | `factory_gate` 判通过 |
| `rejected` | 门禁判不通过（可能原地返工或回退到 `failGoto`） | `factory_gate` 判不通过 |

合法迁移见 `src/store/state.ts` 的 `STAGE_STATUS_TRANSITIONS`；注意 `passed → active|pending` 是**故意**允许的：下游门禁失败时 `failGoto` 会把已通过的阶段拉回来重做。

### 4.4 成员状态

| 值 | 含义 | 什么时候变成它 |
|---|---|---|
| `staged` | 在编制里、但还没有会话（`staged` 工厂的常态） | `factory_plan` |
| `idle` | 有会话、手上没活 | 批准后创建；一个阶段结束后 |
| `working` | 正在做当前阶段的活 | 派发 / 唤醒 |
| `rework` | 被打回后返工中 | 门禁打回按 `failGoto` 唤醒 |
| `blocked` | 成员上报卡住 | `factory_block`（或 `factory_report(status=blocked)`） |
| `done` | 本阶段工件已完成、已回报 | `factory_report(status=done)` |
| `error` | 会话创建或执行出错（见成员行的 `spawnError`） | 派发失败 |
| `removed` | 已回收（终态） | `factory_delete` |

合法迁移见 `src/store/state.ts` 的 `MEMBER_STATUS_TRANSITIONS`（`removed` 是终态；`done` 可以被后续门禁重新打开）。

### 4.5 落盘布局

```text
<workspace>/.code-factory/<factoryId>/factory.json        工厂记录（FactoryState，pretty JSON，原子替换）
<workspace>/.code-factory/<factoryId>/inbox/<key>.jsonl   邮箱，一行一条 FactoryMessage（append-only）
<workspace>/.code-factory/<factoryId>/artifacts.json      工件登记 { version, updatedAt, artifacts[] }
<workspace>/.code-factory/archive/<factoryId>/            归档目录（factory_delete 默认把整个目录移到这里）
```

- `<key>` 是经 `sanitizeKey` 处理过的邮箱名（角色 id 或 `captain`），不是原始字符串。
- 邮箱三态用时间戳表达：**pending**（已写盘、还没投递给宿主 inbox）→ **delivered**（`deliveredAt`，宿主已接受）→ **read**（`readAt`，模型真的消费了）。看一条消息有没有被处理，先看这两个时间戳。
- 所有 read-modify-write 都由工具在进程内锁（`withFactoryLock`）串行化。**手工只读没问题，手工改写会把锁绕过去**——不要手写这些文件。

---

## 5. 五类门禁

门禁类型取自 `src/domain/gates.ts`（`GATE_TYPES`），每阶段的类型与参数来自 `src/domain/pipeline.ts` 的模板。裁决只认**真实证据**。

| 类型 | 实际检查什么 | 证据形态 | 不通过长什么样 |
|---|---|---|---|
| `checklist` | 工件文件**存在**，且含 `requiredSections` 里列的 **Markdown 标题**（逐节检查标题，不读语义） | 工件文本 | `工件不存在: X` / `X 缺 N 节: …`（列出缺哪几节） |
| `keyword` | 读工件的**结论行**：从文件头扫到尾，**最后**出现的 `passWord` / `failWord` 决定；同一行同时命中时判 fail（保守）；一个都没命中算"未发现结论行" | 工件文本 | `命中「FAIL…」: <原句>` / `未发现结论行（需含「APPROVED」…）` |
| `script` | 模板里给的 `run` 命令由执行器**真实执行**，取**退出码**；没有执行记录时是"待执行" | 命令退出码 | `待执行: <命令>` / 非 0 退出码 |
| `composite` | 逐个子门禁求值：任一子项**硬失败**就整体不通过（且不再要求执行剩余命令）；有子项待执行则整体"待执行"；全部通过才算通过 | 子门禁结果 | `组合门禁 N 项中 M 项未通过: …` |
| `dod` | 先做一次 README 标题检查（模板给了 artifact + requiredSections 时），再要求一份**已执行**的 DoD 总验收——`src/domain/dod.ts` 的 `DOD_ITEMS` 逐条机器校验（PRD↔用例交叉引用、pytest 实跑、REVIEW 结论、SEC_PASS、`start.sh --check`、README 四标题、git 逐阶段 commit 与版本 tag） | 工件 + 命令退出码 + git 状态 | `DoD 通过数/总数 通过，未达标: #id label；…` |

### 5.1 「模型自述不算通过」

这是贯穿全部门禁的一条原则：

- 成员在 `factory_report` 里写「已完成 / 已通过 / 没问题」**不是证据**；
- 队长也不能靠印象或对话内容判通过——它必须调用 `factory_gate`，让门禁去读文件、跑命令；
- 工件缺失、命令没跑、DoD 有条目未达标，一律算**未通过**，不接受文字解释；
- `humanApproval` 阶段也一样：先过门禁，**再**等人（§7）。

### 5.2 门禁停在 `gate` 是什么意思

阶段 `status=gate` 表示"活干完了，等裁决"：

- 门禁**还没跑过**（没有 `lastGate` 记录）：队长应该调 `factory_gate` 用当前工件核验；
- 门禁**已通过、但阶段是 `humanApproval`**：等用户确认，队长再调一次 `factory_gate(humanConfirm=true)`；
- 门禁**已通过、普通阶段**：等队长裁决 `advance`（最后一个阶段则是 `delivered`）。

这三种情况下 `factory_dispatch` 都**没有派发项**，它只会返回 `wait`。此时唯一正确的解封动作是 `factory_gate`（§9.3）。

---

## 6. 打回循环

打回不是失败，是设计里的返工环。

### 6.1 四个关键词

| 词 | 来自哪里 | 语义 |
|---|---|---|
| `round` | 阶段记录（阶段行里的 `round`） | 这个阶段被打回了几轮。门禁**失败**一次 +1；通过不变 |
| `maxRounds` | 流水线模板（`src/domain/pipeline.ts` 每阶段的 `maxRounds`） | 允许的打回上限。`round >= maxRounds` 时门禁动作变成 `escalate` |
| `failGoto` | 流水线模板（可省略） | 打回后**回退到哪个更早的阶段**重做。模板校验保证：目标必须更早、且给了 `failGoto` 的阶段 `maxRounds` 不会小于 `2`。省略 `failGoto` 就在本阶段原地返工 |
| `escalate` | 门禁动作 | 轮次用尽的升级信号：**不再自动返工**，交给人决定 |

### 6.2 一次打回发生了什么

1. 门禁判定不通过，阶段的 `round` +1，`status` 置为 `rejected`；
2. 按 `failGoto` 计算回退目标，并把中间那些已 `passed` 的阶段重置（`factory_gate` 返回里的 `resetStages`）；
3. 责任角色收到一条 `reject` 邮箱消息，正文含：门禁类型、判定原话、**整改清单**（`findings`，没给就用门禁 detail 兜底）、回退目标、被重置的阶段；
4. 若还有轮次，回退目标的成员按返工规则被唤醒（`rework`），并登记一条 attempt——所以随后 `factory_dispatch` 不会把同一份活重复派发；
5. 若轮次已用尽，动作是 `escalate`，不唤醒任何人。

### 6.3 打回单里写什么

给队长写 `findings` 时，每条都要**可执行**：

- ✅「`TEST_REPORT.md` 缺少失败用例的复现步骤：补上每条 FAIL 的命令、输入与期望/实际输出」
- ❌「测试不充分，再改改」

门禁的原话（`detail`）会原文出现在成员邮箱里，别把它翻译成结论。轮次用尽时，`nextAction` 会明确写"需要人工决定（放宽范围 / 手工修复 / 终止），不要再自动返工"——这时该做决定的是**你**。

---

## 7. 人工审批点

### 7.1 哪些阶段会停下等人

阶段模板里 `humanApproval: true` 的那些。当前各流水线模板里，**需求分析（`requirement`）**与 **API 契约冻结（`contract`）**带这个标记；以 `factory_status` 返回的阶段行里的 `humanApproval` 为准（模板与阶段定义在 `src/domain/pipeline.ts`）。

理由是这两个阶段决定"做什么"和"接口长什么样"：改起来最便宜的地方就在这两处。

### 7.2 停下长什么样

- 阶段 `status=gate`；
- `factory_gate` 返回 `action=await_approval`、`needsHumanConfirm=true`（门禁本身是**通过**的）；
- 此时 `factory_dispatch` 返回 `wait`——正常现象，不是卡死。

### 7.3 你该看什么

1. `nextAction`：它会把"要给人看什么"说清楚；
2. 阶段行的 `lastGate.detail`：门禁的原话（例如 `PRD.md 必备章节齐全`）；
3. 工件本身：`PRD.md` / `API_CONTRACT.md` ——**你自己读一遍**，门禁只检查标题，检查不了"这需求是不是我想要的"；
4. 工厂 `phase` / `round`：确认没有轮次用尽的升级在等你。

### 7.4 你该说什么

说清楚**同意**或**不同意**（不同意时直接说改哪儿）。之后：

- 同意 → 队长再调一次 `factory_gate` 并传 `humanConfirm=true`，阶段推进；这一步复用上一轮门禁证据，**不会**重跑命令；
- 不同意 → 队长用 `factory_message` 把你的意见落到责任角色的邮箱，或按门禁打回流程处理；计划层面的改动在批准前用 `factory_edit_plan`。

队长**不许替用户拍板**，也不该把"审批"和"规划"塞进同一轮。

---

## 8. 常见操作剧本

### 8.1 新建一个任务

- **你说**：「用 code-factory 做一个带登录的电商后端」或 `/factory 做一个带登录的电商后端`。
- **会发生**：队长 `factory_plan` → 你看到 staged 计划（类型 / 编制 / 阶段与门禁 / 安全岗）。
- **下一步**：看完说「批准」；想改就说哪里，队长 `factory_edit_plan` 改完仍等你批准。批准后队长 `factory_approve`，成员才开始被唤醒。

### 8.2 打回后返工

- **你会看到**：`factory_gate` 返回 `action=reject`，带 `findings`、`rejectedTo`（回退到哪）、`resetStages`、`round` / `maxRounds`。
- **你说的**：把整改清单按"哪里不合格 + 改成什么样"确认一遍；有新信息就补一条 `factory_message`。
- **会发生**：责任角色被唤醒返工；返工完成后回报，队长再 `factory_gate` 裁决。
- **什么时候该你出手**：`action=escalate`（轮次用尽）时——放宽范围、手工修复，还是终止，由你定。

### 8.3 暂停与恢复

- **你说**：「先停一下」，或说出需要人工介入的具体问题。
- **会发生**：`factory_halt` → `phase=halted`，正在工作的成员被中断，**磁盘状态与成员会话都保留**；重复调用返回 `alreadyHalted=true`。
- **恢复**：你说「继续」（队长会用 `factory_resume`，`reason` 必填：写清你在哪儿说要继续）→ `phase=running`。注意 `factory_resume` **不派发**任何工作，队长还要 `factory_dispatch` 才会重新动起来。

### 8.4 交付

- **前提**：所有阶段 `passed`，且 DoD 总验收全绿。
- **会发生**：`factory_dod_check` 真实跑一遍校验并把结果写进 `factory.json`（返回 `items`：每条的 `ok` / `evidence` / `needsExecution`）；全绿后 `factory_deliver` **再跑一次** DoD，通过才把 `phase=delivered` 并记下交付物路径（默认 `DELIVERY.md`）。
- **卡住时**：`factory_deliver` 返回 `delivered=false` 加 `blocked` 清单——那是"还差什么"，不是"通过了"。重复调用是幂等的（`alreadyDelivered=true`）。

### 8.5 归档与删除

- **你说**：「这个工厂不用了，收起来」（默认归档）或「彻底删掉它」（真删）。
- **会发生**：
  - `factory_delete` 默认 `mode=archive`：中断并回收成员，`phase=discarded`，整个目录移到 `<workspace>/.code-factory/archive/<factoryId>/`（`factory.json` + inbox + `artifacts.json` 都留着）；
  - `mode=destroy` 才真删目录，**必须显式 `confirm=true`**。
- **注意**：归档 ≠ 删除。默认选归档；要真删之前先跟用户说清两者区别。

---

## 9. 故障排查

### 9.1 先看 `nextAction`

每个工具（`plan` / `dispatch` / `gate` / `status` / `dod_check` / `deliver` / …）的返回里都有 `nextAction`，它是按**磁盘上的当前状态**算出来的唯一正确下一步。遇到任何"接下来干什么"的问题：先 `factory_status`，然后照着 `nextAction` 走。

它同时会把两种容易误判的情况写明白：门禁阶段的 `wait`、以及打回轮次用尽的升级。

### 9.2 `factory_dispatch` 返回 `wait` ≠ 工厂卡死

`wait` 的含义是**当前没有可派发的活**，常见原因：

| 看到 | 真实含义 | 该怎么办 |
|---|---|---|
| 阶段 `status=gate` | 活干完了、等门禁裁决 | 用 `factory_gate` 解封（§9.3） |
| 阶段 `status=active`，成员 `working` | 成员正在干 | 等 `factory_report`；用 `factory_status` 确认 |
| 已有未完成的派发记录 | 上一轮派发还没结算 | 等回报；不要重复派发 |
| 阶段 `humanApproval` 且门禁已过 | 等你确认 | 去看产出并明确表态（§7） |
| 所有阶段 `passed` | 没有阶段可派发 | 走 `factory_dod_check` → `factory_deliver` |

### 9.3 阶段停在门禁：唯一正确的解封动作是 `factory_gate`

停在 `gate` 时**不要**反复 `factory_dispatch`——它只会一直返回 `wait`。正确的动作：

```text
factory_gate(factoryId=<id>)              # 用当前工件做门禁裁决
  ├─ humanConfirm=true                     # 仅当这是 humanApproval 阶段且用户已明确确认
  ├─ action=advance / delivered            # 通过：推进（或最后一阶段直接交付判定）
  ├─ action=reject                          # 不通过：按 failGoto 回退、轮次 +1、写整改清单
  ├─ action=escalate                        # 轮次用尽：升级人工
  └─ action=await_approval                  # 人工审批点：等用户确认
```

如果阶段停在 `gate` 但**没有门禁记录**（`lastGate` 缺失），那更要用 `factory_gate` 重新核验一遍。

### 9.4 成员状态已过期（搁浅）与 `executorAudit`

`factory_status` 返回的 `executorAudit` 是**只读**解释（不写盘、不派发、不唤醒）：

- **`stale`**：状态已过期、**执行者不在场**（liveness 探针判定 `gone`）的成员。典型例子：上次宿主重启/中断后，名册里还写着 `working`，但那个会话早就不在了。
  修复动作在 `factory_dispatch`：它会把这种行收敛为 `idle`，并按 stranded 恢复重新派发。看到 `stale` 的正确反应是"**派发一次**"，不是"工厂卡死了"。
- **`uncertain`**：**无法判定**（本 composition 没有可用的 liveness 探针，或成员没有会话 id）。这不是"已过期"，只是"确认不了"——别把它当成 `stale` 处理。
- **`note`**：一句话说明本次审计的口径。
- 只有 `running` 的工厂才做这个解释；其它 `phase` 会返回空的 `stale` / `uncertain` 并在 `note` 里写明原因（§9.6 的"空集合"陷阱）。

**"成员状态已过期"和"成员真的在干活"的区别**：前者是名册与执行者**对不上**（探针说人不在）；后者是名册写着 `working` **且**探针说执行者在场。只看 `status` 字段分不出来，必须看 `executorAudit`。

### 9.5 状态在磁盘上，以及怎么直接读

```text
<workspace>/.code-factory/<factoryId>/factory.json        工厂 / 成员 / 阶段 / 门禁 / DoD / feed
<workspace>/.code-factory/<factoryId>/inbox/<key>.jsonl   邮箱（一行一条；坏行会被跳过，不会让整个工厂不可读）
<workspace>/.code-factory/<factoryId>/artifacts.json      工件登记
<workspace>/.code-factory/archive/<factoryId>/            归档
```

- 直接读文件没问题（**读**是诊断，最权威）；但**不要手工写**：所有写操作都在进程内锁下完成，手写会把锁绕过去，并可能让 `factory.json` 与 `inbox` 对不上。
- 读文件**只用 `read` / `grep` 工具**，不要用 PowerShell 文本管道：本机是中文 Windows + Windows PowerShell 5.1，`Get-Content` 默认按 ANSI（CP936）解码，UTF-8 的中文会被显示成乱码——**乱码 ≠ 文件损坏**。要判定编码必须做字节级检查（`docs/API-CONTRACTS.md` §6.1 / §6.2）。
- 一份 `.jsonl` 里出现坏行时，读取会**跳过该行并回调报告**，其余消息照常返回；因此"有坏行"不等于"这个邮箱不可用"。

### 9.6 常见误判清单

| 误判 | 事实 |
|---|---|
| `factory_dispatch` 返回 `wait` → 工厂卡死 | `wait` 只说明"当前没有可派发的活"；门禁阶段本来就该返回它（§9.2） |
| `executorAudit.stale = []` → 审计没跑 / 没有数据 | 也可能是"确实没有过期成员"，或工厂不在 `running`（此时 `note` 会写明）。空数组 ≠ 没有数据 = "这个集合里没有元素" |
| 成员 `status=working` → 它真的在干活 | 名册状态可能与执行者脱节，看 `executorAudit`（§9.4） |
| 邮箱 `messages: []` → 消息丢了 | 默认只返回**未读**；用 `includeRead=true` 重看历史，用 `markRead=false` 避免误标已读 |
| 成员说"已完成" → 阶段自动通过 | 门禁才判决；成员只能 `factory_report(status=done)` 请队长裁决（§5.1） |
| `artifacts: []` → 工件没登记 | 也可能只是这个阶段还没有登记任何工件；成员回报 `done` 之后再看 |
| `mode=archive` → 工厂被删了 | 归档只是把目录移进 `archive/`；只有 `mode=destroy` + `confirm=true` 才是真删 |
| 面板上看到的就是真相 | 面板读的是同一份磁盘状态，是**视图**不是真相源；有分歧以 `factory_status` / `factory.json` 为准 |
| `factory_resume` 之后就恢复工作了 | 它只把 `phase` 改回 `running`，还要 `factory_dispatch` 才会派活 |

### 9.7 卡住时，给队长（或给用户）说什么

一条有用的求助消息至少包含：`factoryId`、阶段 id、`factory_status` 返回的 `nextAction` 原文、阶段行的 `lastGate.detail`（如已裁决）、以及你希望的决定（放宽 / 返工 / 终止）。凭"感觉没动静"很难定位；带上这四样，队长可以立刻核对磁盘状态。

---

## 10. 已知限制

这台工厂在**单个宿主进程内**协调：跨进程并发、成员权限边界、面板只读等都有明确边界，本文只描述"怎么用"，不重复"哪里做不到"。完整清单见 [docs/limitations.md](limitations.md)——**限制是设计的一部分，不是隐藏故障**；遇到边界之外的需求，先看那份文档，再决定是绕过还是改设计。
