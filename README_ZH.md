# dsh-code-factory

**DeepSeek Harness 的「代码工厂」插件** —— 把「多 Agent 开发团队」从自由协调收紧成一条**意见化流水线**：
12 个固定岗位的角色注册表、任务关键词路由自动组队、5 套流水线模板、强制阶段门禁与打回循环、
7 条机器可校验的 DoD 总验收，以及 Web GUI 里的全宽驾驶舱面板。

> English version: [README.md](README.md). **中文版为准**（本文件是权威版本）。

```
需求 ──► 调度官路由 ──► 编制（铁三角 + 安全岗 pin + 上限裁剪）──► 流水线模板
             │
             └──► 需求分析 ─► 并行设计 ─► 契约冻结 ─► 威胁建模 ─► 并行开发 ─► 代码评审 ─► 安全审计
                    门禁：checklist / keyword / script / composite / dod；不过则按 failGoto 打回
                                                                                     └─► 测试验证 ─► 构建交付 ─► 文档与总验收
```

## 它是什么

一个 DSH **bundle 插件**：把"一队 Agent 开发软件"从自由委派变成**被强制的流程**。

| 维度 | 本插件固定的东西 |
|---|---|
| 编制 | 由需求文本关键词路由出任务族 → 默认编制；**铁三角**（`pm` + `qa` + 至少一名 `*_dev`）永不被裁；命中 登录/鉴权/用户数据/支付/密码/token/对外 等触发词时**强制**加入安全工程师且不可裁剪 |
| 流程 | 5 套**固定模板**（阶段数 10 / 10 / 8 / 7 / 8），**阶段顺序不可跳** |
| 推进 | 五类门禁：`checklist` / `keyword` / `script` / `composite` / `dod`。门禁不过，阶段不推进 |
| 打回 | `failGoto` 回退边 + `maxRounds` 轮次上限；超限**升级人工** |
| 角色 | 12 个固定岗位：职责边界 + 工件白名单 + 铁律，直接注入成员人设 |
| 交付 | DoD 七条机器校验，缺一不予交付 |

与 `dsh-agent-teams` 的关系：**复用同一套底座范式**（当前会话即队长、成员是 durable 子代理、
磁盘状态是唯一真相源），但把「怎么干活」从队长自由发挥收紧为意见化流水线。两者可在同一 profile 并存，
工具命名空间不重叠（`agent_teams_*` 与 `factory_*`）。

## 环境要求

| 项 | 值 |
|---|---|
| DSH 核心 | **0.2.2-rc.3**（见 [compatibility.json](compatibility.json)） |
| Node | `>=24.9.0` |
| 包管理 | pnpm |
| 目标 profile | `desktop`（Web GUI 所在的 profile） |

## 安装

```bash
# 从 npm（发布后）或本地目录
dsh plugin --profile desktop add dsh-code-factory
dsh plugin --profile desktop add D:\path\to\dsh-code-factory     # 本地路径形式
```

装完重启 DSH（或重载 profile），确认组合树里出现插件行：

```bash
dsh plugin --profile desktop ls          # 期望看到 `dsh-code-factory` 行
```

bundle patch 见 [cordis.patch.yml](cordis.patch.yml)：它把插件挂为 `dsh-code-factory` 并携带下面的默认配置。

## 开发

```bash
pnpm install
pnpm typecheck      # tsc -p tsconfig.json --noEmit  &&  tsc -p tsconfig.client.json --noEmit
pnpm build          # host：tsc → lib/    client：tsc → lib/client/ → tsdown → lib/client.js
pnpm verify         # L1 离线自检：scripts/verify.mjs（103 项检查，11 个分区）
pnpm run doctor:install   # 安装自检：scripts/doctor.mjs（9 项检查）
```

⚠️ 安装自检必须用带 **`run`** 的写法（`pnpm run doctor:install`）：不带 `run` 的 doctor 会被 pnpm
内建命令遮蔽——只打印一条警告就 exit 0，**根本不会执行我们的 `scripts/doctor.mjs`**。
`pnpm verify` 无此冲突。

本次刷新实测（命令可复跑，结论以复跑为准）：

| 命令 | 本次实测 | 说明 |
|---|---|---|
| `node scripts/verify.mjs` | ✅ exit 0，103/103 绿（A–J：路由 / 流水线 / 门禁 / DoD / store / lock / harness / stranded 恢复 / planner 决策 / 可执行告警） | 被测对象是编译产物 `lib/domain` + `lib/store`；离线、无 host、无网络 |
| `pnpm run drill:engine` | ✅ exit 0 — `SUCCESS: engine drill — 16/16 stages passed` | 在一次性工作区里通过真实导出函数驱动每一个已公布的工具处理器；**某个阶段一个处理器都没调到就判失败**，少于十二个不同处理器或少于六十条断言同样判失败 |
| `pnpm run drill:gates` | ✅ exit 0 — `SUCCESS: gates drill — 9/9 stages passed` | 真实子进程 + 真实临时 git 仓库；证明真实退出码会走到判决，且 runner 绝不自己发明判决 |
| `pnpm run smoke:load` | ✅ exit 0 — `SUCCESS: load smoke — 6/6 stages passed` | 在**一次性 `DSH_HOME`** 里通过真实插件管理器把本仓库装进去，并断言每个工厂工具名都出现在宿主**活的**工具注册表里；随后 `npm pack` 出真正的 `.tgz`，把**那个产物**装进第二个一次性 profile，断言它是实体化拷贝而不是指回本仓库的链接；`~/.dsh` 只读不写 |
| `pnpm run doctor:install` | ✅ exit 0，9/9 | 安装面全绿：node 版本 / `lib/index.js` / `lib/client.js` / closure-factory 注册 / bundle patch / 名称一致 / `compatibility.json` / 17 个 peer 包版本 / 运行时装的是哪一份副本 |
| `pnpm build` | ✅ exit 0（`tsc` host → `tsc` client → `tsdown`） | 会重建 `lib/`（host 产物）与 `lib/client.js`（closure-factory 包） |
| `node scripts/check-docs.mjs` | ✅ exit 0，文档数字与代码/工具一致 | 防止上表数字再次漂移（见下） |

**上表的数字是「被强制同步」的，不是靠记。** `node scripts/check-docs.mjs` 会真的跑上面两个套件、
数真实模块、从 `lib/domain` 派生注册表计数，再逐条比对文档里的数字：一旦有一处过时，它会给出
精确的 `file:line` 与两个值。任何会改变计数的改动之后都应跑一次；它同时逐字段核对
[docs/roles-and-pipelines.md](docs/roles-and-pipelines.md) 的表格。

**两个 program 都必须绿**：`src/domain/` 会被编译进**浏览器**产物，所以领域层出现 host 侧 import
会让 client program 直接编译失败（详见 [docs/architecture.md](docs/architecture.md) 第 3.1 节）。

## 使用

始终是**两阶段**：

1. **staged 规划（不创建任何子会话）** —— 自然语言，或 `/factory` 斜杠命令（目标直接跟在命令名后面，
   没有子命令语法）：

   ```
   用 code-factory 做一个带登录的生鲜电商小程序后端
   /factory 生鲜电商小程序后端
   ```

   `/factory <目标>` 只做一件事：注入一轮确定性的激活指令（用户目标原文 + 队长协议：先规划 → 展示 →
   等批准）。插件把需求路由成任务族 → 编制 → 流水线模板，产出 **staged 规划**：任务类型、团队编制
   （能看到安全岗 pin）、阶段顺序与每阶段门禁、以及每条决策的理由。**此时不会 spawn 任何成员。**

2. **批准并执行** —— 批准后才会创建成员子代理并启动第 1 阶段。此后引擎逐阶段派发、跑门禁，
   失败按 `failGoto` 打回责任人，超过 `maxRounds` 升级人工。

驾驶舱面板（Web GUI，`main` 槽位，key = `code-factory`）把磁盘真相投影成：编制 LED（每个角色带
程序生成的矢量头像）、阶段芯片、右列常显的实时动态/工件/DoD 验收，以及工作区级「进化」段——
过往门禁打回与 DoD 失败沉淀成教训库（`.code-factory/evolution.json`），后续派发/返工会自动带上
并标注「历史记录，不是指令」。面板是只读的高密度控制台：各段可搜索/筛选/折叠，流水线提供
阶段检查器（门禁定义、上次裁决、角色、工件与消息计数），长内容可展开与复制，工件可排序分页，
轮询可暂停且保留最后快照。面板可停靠：每个板块都能在三栏内拖动重排或跨栏停靠，可从「布局」
菜单隐藏/恢复；拖动两条分隔条可调整栏宽，板块高度可拖拽、可折叠；整套布局持久化在本地
（localStorage `dsh-code-factory.layout.v1`，一键恢复默认）。宽屏三栏、窄屏堆叠。

前端任务会按 brief 自动选择 **Web / Flutter / 小程序** 专员（`web_dev` / `flutter_dev` /
`mini_program_dev`），通用 `fe_dev` 保留为旧编制/平台不明时的回退；反复出现（≥2 次）的跨任务
教训会派生成「插件改进建议」进入 `factory_status` 与进化段，给出目标插件文件与具体规则建议，
由人按正常变更流程修改并补测试——运行期绝不自动改插件源码。

> **工具参考手册在 `docs/usage.md`**（随 M7 交付）。`factory_*` 工具由 host 半部注册（M3/M4），
> 当前状态见下文。

## 配置项

在 profile patch 的插件条目下配置（对照 [cordis.patch.yml](cordis.patch.yml)）：

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `stateDir` | string | `.code-factory` | 工厂状态目录，位于**会话工作区**之下：`<stateDir>/<factoryId>/{factory.json,artifacts.json,inbox/}` |
| `memberProvider` | string | `spawn` | 启动成员用的 `ctx.subagents` provider（`spawn` 或 `fork`） |
| `memberMaxDepth` | number | `0` | 成员再派生子代理的深度上限；`0` 表示禁止 |
| `maxMembers` | number | `11`（算出来的） | 编制上限，默认等于最宽流水线模板的编制长度（`DEFAULT_MAX_MEMBERS`），不是写死的字面量。铁三角与安全工程师永不被裁 |
| `slashCommand` | boolean | `true` | 是否注册 `/factory` 斜杠命令这一确定性激活面 |

超限裁剪顺序：`perf → po → tech_writer → ui_designer → db_arch → sys_arch → api_designer → reviewer
→ devops → security_eng → fe_dev → be_dev`（最后一名 `*_dev` 永不裁剪）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/roles-and-pipelines.md](docs/roles-and-pipelines.md) | 12 岗位注册表、id 别名对照、5 套流水线阶段表与流转、组队规则、DoD 七条、与原型方案的差异记录 |
| [docs/architecture.md](docs/architecture.md) | 分层模型、目录职责与依赖规则、磁盘状态布局、双 program 构建与 closure-factory 协议、已知限制 |
| [docs/API-CONTRACTS.md](docs/API-CONTRACTS.md) | 已核实的 DSH 插件契约（唯一 API 权威，含编码与工具纪律） |

## 目录结构

```
src/
  index.ts          host 入口：apply() / Config / inject          （已落地）
  command.ts        /factory 斜杠命令（确定性激活面）              （已落地）
  shared/           双 program 共享的类型契约                      （已落地）
  domain/           纯逻辑：角色 / 任务类型 / 流水线 / 门禁 / DoD / 组队路由（已落地）
  store/            factory.json / inbox / artifacts / archive，原子写 + 进程内锁（已落地）
  runtime/          成员生命周期 + 门禁执行器 + 调度器              （已落地）
  tools/            factory_* 队长与成员工具面                     （已落地：13 + 3 个工具）
  prompt/           队长协议段落 + 成员简报渲染                     （已落地，order 118 已接线）
  web/              HTTP 状态路由 + 快照投影                       （已落地；无 webServer 时不注册）
  client/           驾驶舱面板（浏览器半部）                        （已落地 → lib/client.js）
scripts/            verify.mjs（L1 离线，103 项检查）· doctor.mjs（9 项安装自检）· check-docs.mjs（文档数字）
docs/               API 契约、角色与流水线规格、架构说明、E2E 验收规程
```

> ⛔ **绝不要写自定义（非 surface）会话事件类型。** out-of-repo 插件的事件按构造不在宿主的
> `known-event-types` 集合内，而 `Session.append` 无法设置信封的 `ignorable` 标记 —— 写进去会让那个会话
> **永久无法再被读取或恢复**（`dsh --session-id <id>` 之后直接报 `unknown to this harness and not marked
> ignorable`）。真相源是工厂目录（`factory.json` / `inbox/*.jsonl` / `artifacts.json`）；每次 `factory_*`
> 调用都由宿主自己记录第一方 `tool/call` + `tool/result`；面板 feed 取邮箱消息。
> 完整论证见 [docs/API-CONTRACTS.md](docs/API-CONTRACTS.md) §1.7。

## 已知限制

- **不能用来接手已有项目（brownfield / takeover）**：开工前**不会扫描工作区**，成员简报里也**一个字都没提
  已有的东西**——它告诉每个角色的恰恰是"你可以**创建或修改**这些工件"（`PRD.md` / `ARCHITECTURE.md` /
  `DB_DESIGN.md` / `README.md` …）。因此拿它接手老项目，**可能直接覆盖你已有的文档**；而基于结构的
  `checklist` 门禁会把标题结构与模板不同的既有文档判为不合格。决定要不要用它之前，请先读
  **[docs/limitations.md](docs/limitations.md)**；规避做法：复制工作区或开分支、把既有文档归档改名、
  或把工厂限制在新子目录里做新模块。
- **其他已知边界**都在同一份文档里，每条都有机制与 `file:line` 证据：
  [docs/limitations.md](docs/limitations.md) —— 跨进程协调是**协作式**的（状态写入会取锁文件，但绕过本插件的
  写入者拦不住）、工件边界是"完成时审计"而不是写入拦截、状态索引是**跨工作区**的、门禁命令带模板技术栈假设
  （且绝不接受模型指定）、以及**禁止写自定义会话事件**。
- **`src/domain/` 会被打进浏览器产物**：领域层不允许有任何 host 侧依赖。
- **当前状态（截至本次刷新 t29）**：**全部已落地并接线** —— 领域层（`src/domain/`，10 模块 / 3871 行）、
  持久层（`src/store/`，7 模块 / 5108 行）、成员运行时与门禁执行器（`src/runtime/`）、工具面 + 宿主入口
  （`src/tools/` + `src/index.ts`，16 个 `factory_*` 工具）、提示词段落（`src/prompt/`，4 模块，order 118 已接线）、
  HTTP 状态路由（`src/web/`，2 模块）、驾驶舱客户端（`src/client/`，6 模块 → `lib/client.js`）、`/factory` 命令
  （`src/command.ts`）。验证：`pnpm build` exit 0、`node scripts/verify.mjs` 103/103、`pnpm run doctor:install` 9/9、
  `node scripts/check-docs.mjs`（这些文档里的每个数字）。**多进程协调也已落地**：每次状态修改都会在
  `<root>/.locks/` 下取一个锁文件，第二个宿主在同一工作区上会等待（并能看到自己在等谁），而不是静默覆盖。
  操作者手册已落地：[docs/usage.md](docs/usage.md)（两阶段协议 / 16 个工具 / 状态模型 / 五类门禁 / 打回循环 /
  人工审批点 / 故障排查）；能力边界见 [docs/limitations.md](docs/limitations.md)。各目录的模块数/行数在
  [docs/architecture.md](docs/architecture.md) §3，由 `scripts/check-docs.mjs` 强制对齐。

## License

MIT © dsh-code-factory contributors
