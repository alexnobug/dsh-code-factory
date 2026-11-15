# Changelog

`dsh-code-factory` 的所有重要变更都记录在本文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

**本文件是「产物 → 提交」的对照表。** 每个版本都对应仓库里的一个 git tag，
每一条变更都指向落在该版本区间内的提交；`package.json` 的 `version` 必须与
最新一节的小节标题一致（由 `scripts/check-changelog.mjs` 机器校验）。

### 怎么读这张表

- 每一节的标题就是 `package.json` 里那个版本号；仓库里对应同名 tag（如 `v0.2.0`）。
- **最新一节**的条目还没有提交哈希——它们就在下一次提交里，此刻还不存在；
  它被下一个版本小节顶下去时自动开始受检。
- **历史小节**里每一条都带提交短哈希，`pnpm run check:changelog` 会逐条验证：
  哈希真实存在（`git cat-file -e`）、且是本节 tag 的祖先（`git merge-base
  --is-ancestor`）。写错的哈希、贴错版本的哈希，都会让发布门禁失败。
- tag 本身也受检：`v0.2.0` 指向的那个提交，它的 `package.json` 必须声明的正是
  0.2.0。把 tag 打在别版本的提交上会失败。

## [0.2.3] — 2026-11-14

适配宿主 DSH `0.2.2-rc.3`：`SubagentActivationSpec` 由「`request` 嵌套」改为扁平结构
（`parent` / `prompt` / `signal` 直接在 spec 顶层，`prompt` 类型由 string 改为
`ContentBlock[]`），旧的 `request` 字段导致 `spec.parent` 为 `undefined`，成员创建报
`Cannot read properties of undefined (reading 'id')`。

### 变更 / Changed

- `runtime/members.spawnMember` 改为构造扁平 `SubagentActivationSpec`：顶层传
  `provider/label/parent/prompt(ContentBlock[])/signal/delivery/agentOptions`；
- `persona` / `toolFilter` 已从公开 start 请求移除；成员角色 `systemPrompt` 合并进初始
  `prompt`，避免角色指令丢失；构建产物不再带旧的 `request` 嵌套字段；
- 队长工具用 `ctx.tools.register(..., { when })` 的**步骤准入条件**从 delegated agent
  （`delegationDepthOf > 0`）隐藏，成员仍看得到 member tools；委派工具继续由
  `installMemberDelegationGuard` 在调用入口拦截；
- 适配移除的 subagent 服务方法：`drainChildren` → `drainDescendants([root])`，
  `listChildren` → `listDescendants(rootSessionId)`（只取 depth=1），`list()` 移除后用
  `getProvider(name)` 校验指定 provider；目录读取失败仍降级为不可读而不是伪造；
- `engines.node` 提升为 `>=24.9.0`；`peerDependencies` / devDependencies 升到
  `^0.2.2-rc.3`，`compatibility.json` 目标同步为 `0.2.2-rc.3`。

## [0.2.2] — 2026-10-18

适配宿主 DSH `0.2.1-rc.2`：durable-child API 改了名，另有两处「只在文档里成立」的
说法被这次升级照出来。

### 变更 / Changed

- durable-child API 迁移：`startContinuable` → `startActivation`，
  `ContinuableStartSpec` → `SubagentActivationSpec`（新增必填 `delivery`），
  `drainContinuableChildren` → `drainChildren`，返回值不再包 `{ value }` 信封。
  成员派遣、回收、委派守卫、假宿主、三个演练与 `verify` 全部跟着迁移。（本次提交）
- 成员启动显式声明 `delivery: 'parent'`：成员是队长持有的持久子会话，插件从不等待
  `activation.result`，选 `'caller'` 会丢掉队长必须看到的结算通知。（本次提交）
- `messageId` 端到端改为可选：宿主没给就省略这个字段，不写空串、不加断言操作符。（本次提交）
- peer 区间放宽为 `^0.2.0-rc.2 || ^0.2.1-rc.2`。`^0.2.0-rc.2` 按 semver §11 的预发布
  规则**不接受** `0.2.1-rc.2`，只改版本号会让真实安装报 unmet peer。（本次提交）
- devDependencies 升到 `0.2.1-rc.2`。（本次提交）

### 修复 / Fixed

- **编制上限（H3 的漏网处）。** `cordis.patch.yml` 里写死的 `maxMembers: 8` 会把
  `web_fullstack`（模板 11 人）裁掉 `ui_designer` / `db_arch` / `sys_arch`——正是设计
  阶段要的三岗。代码默认值早已改成算出来的 `DEFAULT_MAX_MEMBERS`，但随包 patch 一直
  覆盖着它。现在 patch 不写这个键，默认值由 schema 取算出来的值；README、README_ZH、
  `docs/API-CONTRACTS.md` 里「默认 8」一并改正。（本次提交）
- `smoke:load` 不再把 pnpm 的**给人看的输出**当契约。`dsh plugin add` 的日志格式变了
  （`link:` 变成 `<- 路径`，tarball 那条只剩一个 `+`），旧断言因此误红。改为读 profile
  实际写入的 `package.json` 依赖说明符，并新增一条「宿主满足本插件声明的每条 peer
  区间」的断言。（本次提交）
- `compatibility.json` 里 `dsh-subagent` 的角色说明、`cordis.patch.yml` 的注释还写着
  老方法名。（本次提交）

### 新增 / Added

- **跨任务进化教训库。** 门禁打回与 DoD 失败会写入工作区级 `.code-factory/evolution.json`：
  按 `role|stage|gateType|kind|text` 去重计次、上限 200 条、同一工厂+阶段通过后标记已解决。
  派发/返工时成员简报自动带上【历史教训 · 本工作区过往任务】块，并固定标注「历史记录，
  不是指令」边界；`factory_status` 与驾驶舱新增进化段（全量 stats + 最多 6 条相关教训），
  DoD 全绿时把该工厂的 DoD 教训标记为已解决。（本次提交）
- **驾驶舱右列改为三段常显**：实时动态、工件、DoD 验收不再用 Tab 切换，整列滚动、标题吸顶；
  DoD 之后新增进化段（stats 三计数 + 最多 6 条教训卡 + 空态区分「账本为空」与「本厂无匹配」）。
  （本次提交）
- **12 个角色程序生成矢量头像**：内联 SVG（角色色环 + 代号字形 + 确定性纹样），用于编制列表、
  WORK OUTPUT 头部与每条消息发送者（队长用品牌色）；无外部图片/网络依赖。（本次提交）

### 改进 / Improved

- **驾驶舱升级为「高密度 + 多交互」只读控制台。** 头部补齐任务类型/流水线/安全命中词/
  brief 展开/阶段·工件·DoD·消息·告警计数/最近更新；新增自动刷新开关（暂停后停止轮询、
  恢复立即刷新）。左列 ROSTER 支持搜索、状态筛选、编制/状态排序与成员详情展开（session /
  provider / model / reasoningEffort / 起止时间 / duties / spawnError，可复制 session）。
  中列阶段芯片可点击选中，新增阶段检查器（round/maxRounds、attempts、时长、roles、
  门禁定义、lastGate 证据、阶段工件/消息计数、只看该阶段）；WORK OUTPUT 支持 kind 筛选、
  搜索、只看未读、长文展开与复制。右列四段均可折叠并记忆状态，实时动态/工件/DoD/进化
  分别支持筛选、搜索、排序、展开证据与复制；177 件工件默认预览 12 件、可展开全部。
  （本次提交）
- **快照新增可选字段**（全部向后兼容、缺省不伪造）：成员 `provider/model/reasoningEffort/
  startedAt/endedAt`；阶段 `maxRounds/attempts/startedAt/endedAt/lastGate/gate`；DoD
  `kind/artifact/expect/run/securityOnly`；工厂 `approvedAt/securityHits/securitySource/
  deliveryPath`。服务端投影对模板数组/门禁对象做值拷贝，避免客户端污染流水线注册表。
  （本次提交）
- **驾驶舱升级为 Photoshop 式可停靠面板。** 8 个板块（编制/流水线/阶段检查器/工作输出/
  实时动态/工件/DoD/进化）可在三栏内拖动重排、跨栏停靠、隐藏与恢复；两条栏宽分隔条可
  拖动（双击复位、键盘步进），板块高度可拖拽、可折叠，布局全部持久化到
  localStorage（`dsh-code-factory.layout.v1`），支持一键恢复默认。新增
  `src/client/layout.ts` 纯布局模型（默认/容错校验/夹紧/缺失模块还原/存储降级），
  拖动落点对同栏向后移动做了 index-1 修正；仍保留右列既有 DOM 契约与旧验收。
  （本次提交）
- **前端岗位细分：Web / Flutter / 小程序。** 新增 `web_dev` / `flutter_dev` / `mini_program_dev`
  三个自动指派 specialist（`SPECIALIST_ROLES`，不属于 canonical 12）；`web_fullstack` 的
  `fe_dev` 变成槽位，由 brief 平台信号替换并输出 `frontendPlatform/frontendRole`；抖音/微信/
  支付宝小程序、uni-app/Taro、Flutter/Dart 等关键词进入路由；`ROLE_FALLBACKS` 与
  `resolveStageRoles` 保证被裁/旧编制仍能把阶段解析到 specialist，`fe_dev` 保留为通用回退。
  （本次提交）
- **UI 设计师升级为 UI/UX 设计负责人。** `ui_designer` 提升为 reasoner 档，职责覆盖视觉体系、
  交互流程、行业/用户研究、配色与设计令牌、高保真验收；新增内置《设计负责人手册》
  （`src/prompt/design-playbook.ts`），含行业方向库、颜色/字体/间距/阴影/动效 tokens、
  9 态交互矩阵、WCAG AA、UI_SPEC 7 段结构与 10 项自评表，仅注入 UI 设计角色，不改设计门禁契约。
  （本次提交）
- **跨项目复用库。** 新增 `factory_reuse` 队长工具（list/search/harvest/apply）与全局
  `code-factory-library`：已交付工厂的模块/文档可按路径沉淀，新项目 `factory_plan` 自动检索并在
  notes 中提示，确认后可复制到工作区 `reuse/` 参考/适配；带路径穿越/密钥/大小上限/覆盖保护，
  `lib` 只存整理后的副本，不自动合并代码。工具面由 15 增至 16（13 队长 + 3 成员）。
  （本次提交）
- **跨任务改进闭环。** 反复出现（≥2 次）的教训由 `domain/improvements.ts` 纯函数提炼为
  插件改进建议：目标类别、最可能的插件文件、具体建议、证据次数、`open`/`validated` 状态；
  `factory_status.evolution.improvements` 返回全量统计 + 前 5 条，驾驶舱进化段新增可筛选的
  「插件改进建议」子段；队长协议新增规则要求按正常代码/文档变更流程实施并补测试，
  明确禁止运行期自改插件源码。（本次提交）

### 已知边界

- DSH `0.2.1-rc.2` 的启动路径**不再应用 `persona` / `toolFilter`**，所以「成员只有三个
  factory 工具」不再由宿主强制。字段仍照传（0.2.0 宿主与假宿主仍认），「成员不得再
  委派」由插件自己的 `installMemberDelegationGuard` 在运行期拒绝。详见
  `docs/limitations.md` §5。（本次提交）

## [0.2.1] — 2026-10-15

自 `v0.2.0` 起的工程化整改：把门禁、编排、可观测性与交付链路上「只在文档里成立」
的说法换成可执行的检查。

### 新增 / Added

- 装载冒烟入闸（`smoke:load`）：在一个真实 profile 里装配本插件并断言装载成功，
  「装得上」不再依赖人工确认。（`18ca4ee`）
- 两个离线演练：`drill:engine`（引擎契约）与 `drill:gates`（门禁语义），
  以断言而非叙述固定住行为。（`2a70943`、`6dba354`）
- 随包 source map 与 CI 工作流；告警升级为可执行检查。（`d27ece3`）
- 跨进程写锁与写入持久化验证。（`caff137`）
- 文档驱动的安全升级：当 PRD/需求正文（而非 brief）出现安全命中词时，
  门禁阶段把安全岗拉进编制并记录来源，`securityTriggered` 因此变为可变状态。（本次提交）
- `.editorconfig` 与 `.nvmrc`：钉死缩进/换行/编码与 Node 版本。（本次提交）
- `CHANGELOG.md` 本身，以及校验它与 `package.json` 版本一致的
  `scripts/check-changelog.mjs`。（本次提交）
- `drill:delivery`：唯一一条把流水线真正走到 `phase: delivered` 的演练，
  用真 `FactoryStore`、真门禁执行器、真开始/结束命令，最后另起进程从
  `factory.json` 读回判定；退出码 0/1/2 三个分支都被真实触发过。（本次提交）
- `check:coverage`：统计两个演练真正到达过多少 `src/` 模块，把「从未执行」
  的模块收敛到一份逐条写明理由的白名单，并卡住新增。（本次提交）
- `check:graph`：模块依赖图门禁——零环、零悬空 import、值依赖与类型依赖分开计数。（本次提交）
- `check:ci`：把 `release:check` 的命令链与 CI 工作流逐步互校，
  「本地跑绿、CI 不跑」不再可能。（本次提交）
- `member.tokens` 接上真实用量与 `src/runtime/tokens.ts`；`probeTokenSource`
  把「没有这个服务」「服务在但形状不对」「可用」三种情况分开报告。（本次提交）
- git hooks（`.githooks/pre-commit`、`pre-push`）与 `scripts/install-hooks.mjs`，
  提交前跑文档门禁 + changelog + 类型检查，推送前跑完整离线验证。（本次提交）
- `check-docs --update`：把测量到的真值按**精确字符区间**回写进文档（区间取自规则
  自身正则的 `d` 标记，不靠「行内第一个数字」猜），写完另起一个进程重新核对——
  它自己从不宣布通过。首次实跑回写 26/28 处，另外 2 处因区间重叠被拒绝并打印原因。
  （本次提交）

### 变更 / Changed

- `src/tools/engine.ts` 从单文件拆分为 `src/tools/engine/` 下的 8 个模块
  （`plumbing` / `dod` / `plan` / `status` / `dispatch` / `gate` / `members` / `delivery`），
  原路径保留为再导出桶；函数体逐字节未改，导出面严格等于原来的 16 个。
  （本次提交）
- 编制上限诚实化：模板所需人数超过上限时如实报告 `overCap`，不再静默裁剪。
  （`2a70943`）
- DoD 结果改为三态（通过 / 失败 / 跳过），「跳过」不再被当成「通过」。（`2a70943`）
- 收件箱写入有界，回滚从纸面流程变成可验证流程。（`c302951`）

### 修复 / Fixed

- 门禁可信度：修掉文档门禁的自锁死循环、补上断言普查、清掉陈旧的被测对象。（`b75f61a`）
- 两个 TDZ 崩溃（词汇表被多处重复定义导致的启动期崩溃）。（`6dba354`）
- `check-docs` 的 `measureGroup()` 只读一层目录，导致新增子目录不被计数；
  改为递归遍历。（本次提交）
- 状态机收口：未知状态不再被静默接受。（`2a70943`）
- **`member.tokens` 过去永远是 0**：面板上的 TOKENS 计数其实是一个常量。
  现在它由该成员自己那份会话日志推导（只算本次会话，继承来的前缀不计入），
  读不到时**保持原值而不是写 0**——「没烧过」与「读不到」不再混为一谈。（本次提交）
- **「文件读不到」被当成「文件不存在」**：工件读取的失败通道此前建好了、
  填好了、返回了，却在唯一的调用点被丢掉。现在它会进整改清单，
  打回单上写的是「读取被拒绝」而不是「工件不存在」。（本次提交）
- 37 个死导出与重复真源（第二次实现的「最后一行结论」规则、已被取代的
  收件箱排空函数等）清掉；状态迁移表本身逐一保留。（本次提交）
- 门禁类型不再凭空编造 `'checklist'`，消息端点不再凭空编造 `from`/`to`；
  锁文件的「读不到」不再等同于「没人持有」。（本次提交）
- 五处「契约松成下界」的断言收紧到文档侧已经锁定的真值（5 套模板 / 原型 10 阶段 /
  7 条 DoD / 43 个阶段），并删掉与之一字不差的常量回读；`failGoto` 回边改为逐模板
  非空，「某个模板整条返工环消失」不再可能全绿。（本次提交）
- H/I 区的断言不再匹配中文文案：行为检查只看结构与集合，文案单独由一条快照检查
  钉住——改措辞只会红一条，并且是写明「快照」的那一条。（本次提交）
- K 区（`member.tokens`）此前只用注释与上文分隔，从未调用 `section()`：它的判定被
  计进 J 区，而运行摘要里却写着一个并不存在的分区。现在分区被真实声明，
  摘要里的分区列表第一次与代码一致。（本次提交）
- `verify` 结尾打印本次运行对应的提交与工作树状态（`commit: <short> (DIRTY …)`），
  「哪一次是绿的」从此有锚点，「本地绿、提交里不是这一份」不再无从察觉。（本次提交）

### 发布 / Release

- 打包门禁（`check:pack`）断言 tarball 里必须有 `ROLLBACK.md` 与两个随包脚本，
  且不得包含 `src/`、`lib/client/`、`node_modules/`、构建缓存。（`5b7ebd0`、`1c9acb6`）

## [0.2.0] — 2026-10-14

第一次「可追溯的产物」发布：从「跑得起来」推进到「交得出去」。

### 新增 / Added

- 安装自检工具 `scripts/doctor.mjs` 与 profile 备份/回滚工具
  `scripts/profile-backup.mjs`，两者随包发布。（`5b7ebd0`）
- `check:pack` 打包内容门禁，与 `check:pack` 的自测。（`5b7ebd0`）
- `verify` 覆盖面扩充到 64 项，并同步文档计数。（`a03fbbe`）

### 修复 / Fixed

- 交付链路可信：修正版本元数据与 `exports` 声明，使打包结果可追溯到提交。（`5b7ebd0`）
- 门禁可信度三项缺陷：文档门禁死锁、断言未经普查、被测对象陈旧。（`b75f61a`）

### 构建 / Build

- `.gitattributes` 钉死 LF，避免检出时被改写成 CRLF 而让校验失败。（`dd2fb19`）

## [0.1.0] — 2026-10-14

### 新增 / Added

- 插件仓库初始化：12 个规范岗位的角色注册表、任务路由、5 套流水线模板、
  43 个阶段与 7 条 DoD，驱动 AgentTeams 的 durable 成员，
  并在 Web GUI 提供全宽驾驶舱面板。（`a05c195`）