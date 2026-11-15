# 架构说明（Architecture）

> 本文描述 `dsh-code-factory` 的分层、目录职责、依赖方向、磁盘状态与构建模型。
> 事实来源：`docs/API-CONTRACTS.md`（已核实的 DSH 契约）、`src/domain/`（已冻结的领域真源）、
> `package.json` / `tsconfig*.json` / `tsdown.config.ts` / `cordis.patch.yml`。
> 模块落地状态（**已落地 / 在建 / 未落地**）与全部计数由 `node scripts/check-docs.mjs` 强制对齐，是
> **本次刷新（t24）**的快照，逐条可回仓库文件核对；
> 其余部分描述的是设计而非进度。

---

## 1. 一句话架构

> **领域层是唯一真源，运行时是唯一会动磁盘的人，面板只是磁盘真相的投影。**

- 角色 / 任务路由 / 流水线 / 门禁判定 / DoD **全部是纯函数**，零 `ctx`、零 Node API、零副作用，
  host 与浏览器两端共用同一份代码。
- 成员是 **durable 子代理**（`ctx.subagents.startActivation`），不是模拟动画。
- 所有交接只经由**标准工件文件**（PRD.md / REVIEW.md / TEST_REPORT.md …）。
- 门禁执行（跑命令）与磁盘写入只发生在**运行时层**；领域层只给出判定与"待执行"标记。

---

## 2. 分层模型

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1 调度层  TaskRouter        matchTaskType → 任务族 → 流水线模板               │
│                              assembleTeam → 铁三角/安全岗/上限裁剪             │
├──────────────────────────────────────────────────────────────────────────────┤
│ L2 团队层  FactoryTeam       12 岗位注册表 → 本次编制 → durable 成员（子代理）  │
├──────────────────────────────────────────────────────────────────────────────┤
│ L3 引擎层  PipelineEngine    阶段推进 / 门禁裁决 / 打回轮次 / 人工审批 / DoD    │
├──────────────────────────────────────────────────────────────────────────────┤
│ L4 工件层  workspace/        所有交接只经由标准工件文件（角色有 outputs 白名单）│
├──────────────────────────────────────────────────────────────────────────────┤
│ 持久层  FactoryStore        <workspace>/.code-factory/<factoryId>/            │
│ 观测层  Panel + Card        Web 面板 & 对话卡片（只读 HTTP：/plugins/code-factory/state）│
└──────────────────────────────────────────────────────────────────────────────┘
```

| 层 | 职责 | 实现在哪 | 是否可以失败而不伤害真相源 |
|---|---|---|---|
| L1 调度层 | 任务分类、编制装配、模板选择；输出一份 **staged 计划**（不创建任何子会话） | `src/domain/router.ts` + `src/domain/task-types.ts`（纯函数） | 是（纯函数，无副作用） |
| L2 团队层 | 角色注册表 → 成员子代理；投递 / 唤醒 / 中断 / 回收 | `src/domain/roles.ts`（纯数据）+ `src/runtime/`（members / compat / tool-surface / provider-guard） | 否（子代理创建失败要记 `spawnError` 并可重试） |
| L3 引擎层 | 阶段推进、门禁调用、打回路由、轮次计数、超限升级人工、DoD 汇总 | `src/domain/pipeline.ts` + `gates.ts` + `dod.ts`（判定，纯）+ `src/store/` + `src/runtime/gates-runner.ts` + `src/tools/`（编排） | 是（判定幂等，重放安全） |
| L4 工件层 | 交接载体：PRD / 设计 / 契约 / 评审 / 测试报告 / 交付物 | 用户工作区（`<workspace>`），成员按 `outputs` 白名单写 | 否（工件是交付物本身） |
| 持久层 | 工厂状态唯一真相源 | `src/store/`（`factory.json` / `inbox/*.jsonl` / `artifacts.json`） | **是真相源**；观测层不可用时依然可读 |
| 观测层 | Web 面板 + 对话卡片，只读投影 | `src/web/`（HTTP 状态路由 + 快照投影）+ `src/client/`（面板 `lib/client.js`） | 是（面板只是磁盘真相的投影，路由不注册也不影响工具面）。⚠️ **不写会话事件**——见 §6 与 API-CONTRACTS §1.7 |

---

## 3. 目录职责与依赖方向

| 目录 | 职责 | 允许 import | 当前状态 |
|---|---|---|---|
| `src/shared/` | 双端共享的类型契约（`types.ts`：`RoleDef` / `TaskTypeDef` / `StageDef` / `GateDef` / `FactoryState` / `FactorySnapshot` …）。**零 import**，只有类型与少量纯常量 | 无 | ✅ 已落地（1 模块 924 行） |
| `src/domain/` | 纯逻辑真源：12 岗位注册表 + 3 个自动指派前端 specialist、任务族、5 套流水线、门禁判定、DoD 定义、路由组队、反复教训 → 插件改进建议的纯推导。**零外部 import**（只允许 `../shared/types.js` 与同目录 `./x.js`），无 Node API、无副作用、确定性 | `../shared/types.js`、同目录 `./*.js` | ✅ 已落地（`roles` / `task-types` / `pipeline` / `router` / `gates` / `dod` / `alerts` / `improvements` / `index`，10 模块 3871 行） |
| `src/store/` | 持久层：`factory.json` 读写、`inbox/*.jsonl` 追加与读取、`artifacts.json`、`archive/`；原子写 + 可选 fsync 与 Windows EPERM 降级；**跨进程**锁文件（`<root>/.locks/<id>.lock`，锁内 FIFO，持有者与过期均有记录） | `../shared/*`、`node:fs` 等 Node API | ✅ 已落地（`atomic.ts` / `file-lock.ts` / `lock.ts` / `state.ts` / `store.ts` / `evolution.ts`，7 模块 5108 行） |
| `src/runtime/` | 成员生命周期：`startActivation`（0.2.2 扁平 spec）→ 投递 / 唤醒 / 中断 / 回收；角色人设合并进 prompt；队长工具可见性 preflight；跨版本兼容缝；门禁命令的**真实执行器**；阶段调度 | `../shared/*`、`../domain/*`、`../store/*`、`@deepseek-ai/*` | ✅ 已落地（`members` / `compat` / `tool-surface` / `provider-guard` / `commands` / `gates-runner` / `scheduler` / `testing` / `tokens` / `index`，10 模块 5738 行） |
| `src/tools/` | 队长工具面（`factory_plan` / `approve` / `status` / `gate` / `dispatch` / `dod_check` …）与成员工具面（`factory_report` / `factory_inbox` / `factory_block`），共 13 + 3 个 `defineTool` 定义 | 上面全部 + `@deepseek-ai/dsh-tools` | ✅ 已落地（`context` / `engine` / `captain` / `member` / `index`，14 模块 6095 行） |
| `src/client/` | 浏览器半部：驾驶舱主面板、编制/流水线/动态/工件/DoD/进化视图、搜索/筛选/排序/展开/阶段检查器/复制/暂停轮询等只读交互、Photoshop 式可停靠布局（拖动重排/跨栏/栏宽与板块高度伸缩/隐藏/持久化）、locale、主题适配；只读 HTTP 快照（`?sessionId=` 定位本会话的工厂，`?id=` 为用户显式选定；跨工作区索引只喂下拉列表，绝不当作快照渲染） | `../shared/*`、`react`、`@deepseek-ai/dsh-client-*`（`tsconfig.client.json` 也允许 `../domain/*`；客户端只使用 `improvements` / `roles` 等纯函数，不引入 Node API） | ✅ 已落地（`index.tsx` / `FactoryCockpit.tsx` / `api.ts` / `locales.ts` / `styles.ts` / `layout.ts`，6 模块 8018 行；已打包出 `lib/client.js`） |
| `src/prompt/` | 注入给会话的系统提示词段落：队长协议、成员简报渲染 | `../domain/*`（只读注册表） | ✅ 已落地并接线（`captain-protocol.ts` / `member-brief.ts` / `index.ts`，4 模块 633 行；`src/index.ts` 在 order 118 注册） |
| `src/web/` | host 侧 HTTP 状态路由（只读、只接受已知 id、防路径穿越）+ 磁盘真相 → 面板快照投影 | `../store/*`、`../domain/*`、`node:http` | ✅ 已落地（`routes.ts` / `snapshot.ts`，2 模块 852 行；无 webServer 的 composition 里降级为不注册） |
| `src/index.ts` + `src/command.ts` | 插件入口（`apply` / `name` / `inject` / `Config`）与 `/factory` 斜杠命令 | 上面全部 + `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-commands` | ✅ 已落地（2 模块 622 行） |

依赖方向（箭头 = 允许 import）：

```
shared  ←  domain  ←  store/runtime/tools/web/prompt/client
```

**硬约束**

1. **`src/domain/` 零外部 import**：只用 `../shared/types.js` 与同目录 `./x.js`（相对 import 一律带
   `.js` 扩展名，host 用 NodeNext）。原因有二：它会被打进浏览器端；以及"纯函数"是门禁可离线断言的前提。
2. **⛔ 不许写会话事件**：`src/` 里不得出现自定义（非 surface）会话事件类型的声明或 `Session.append` 调用。
   out-of-repo 插件的事件按构造不在宿主 `known-event-types` 集合内，而 `Session.append` 无法设置
   `ignorable` 标记 ⇒ 一旦写入，该会话**永久无法再被读取或恢复**（实测 `dsh --session-id <id>` 直接失败）。
   状态真相一律落在磁盘（`factory.json` / `inbox/*.jsonl` / `artifacts.json`），"谁调用了哪个工具"
   由宿主自己记录的 `tool/call` + `tool/result` 负责，面板 feed 取快照里的邮箱消息。
   完整论证与实测报错见 API-CONTRACTS §1.7 与陷阱 #1/#4。
3. **`src/store/` 只被 host 侧使用**：`node:fs` 不能出现在 `src/domain` 或 `src/client` 里。

### 3.1 `tsconfig.client.json` include 了 `src/domain` 的传导效应

```jsonc
// tsconfig.client.json
"include": ["src/client", "src/shared", "src/domain"],
"exclude": ["src/store", "src/runtime", "src/tools", "src/prompt", "src/index.ts"]
```

意味着：

- 领域层任何一行代码、任何一次 import 都必须**在浏览器 program 下合法**：不允许 `node:*`、
  不允许 `@deepseek-ai/*` host 包、不允许依赖 `process` / `Buffer`。
- 领域层里**不能**给性能关键路径引入 host 依赖（哪怕只是类型 import）——它会被 `tsdown` 打进
  `lib/client.js`。
- 好处是：快照投影（`src/web/snapshot.ts`，host 侧）与门禁判定读的是**同一份注册表**，面板只渲染快照，
  不需要在浏览器侧复制数据。领域层的 5 套模板 / 12 岗位一变，门禁与面板同时变，不存在"两处漂移"。
  （`tsconfig.client.json` 允许 client 直接 import `../domain/*`；当前 5 个模块都只从 `../shared/types.js`
  取类型，注册表数据一律来自 HTTP 快照。）
- 代价是跨目录改动要跑**两个** typecheck：`pnpm typecheck` = `tsc -p tsconfig.json --noEmit`
  **且** `tsc -p tsconfig.client.json --noEmit`。任何一侧红都算红。

---

## 4. 磁盘状态布局

```
<session workspace>/                  ← ⚠️ 永远来自 caller.session.header.cwd，不是 process.cwd()
  .code-factory/                      ← 配置项 stateDir（默认 .code-factory）
    evolution.json                    ← 工作区级「进化教训库」：跨工厂共享、去重计次、有界 200 条
    <factoryId>/                      ← 8 位短 id，也是目录名
      factory.json                    ← 唯一真相源：brief/taskType/pipeline/phase/members/stages/dod
      artifacts.json                  ← 工件登记表：路径 / 产出角色 / 阶段 / 字节数 / 时间
      inbox/
        captain.jsonl                 ← 队长邮箱（模型/人类可读的追加日志）
        <role>.jsonl                  ← 每个角色的邮箱（角色 id 见 docs/roles-and-pipelines.md）
    archive/
      <factoryId>/                    ← 交付或废弃后整体归档（归档而非删除）
```

| 文件 | 内容要点 | 谁写 | 谁读 |
|---|---|---|---|
| `factory.json` | `id` / `brief` / `taskType` / `pipeline` / `captainSessionId` / `phase: staged\|running\|halted\|delivered\|discarded` / `securityTriggered` / `members[]`（`role`/`sessionId`/`status`/`provider`/`model`/`spawnError`/`tokens`）/ `stages[]`（`id`/`status`/`round`/`attempts`/`lastGate`）/ `dod[]` | store（原子写 + 锁） | store / tools / web 快照 |
| `artifacts.json` | 工件登记（路径 / 产出角色 / 阶段 / 字节数 / 时间），供 DoD 的"越界写入审计"与面板工件 Tab | store | 面板 / DoD 审计 |
| `evolution.json` | 工作区级进化教训库：`LessonRecord[]`，按 `role\|stage\|gateType\|kind\|text` 去重计次、上限 200 条；门禁打回 / DoD 失败时写入，同一工厂+阶段通过后标记 `resolvedAt` | gate / DoD 裁决（try/catch，失败不影响裁决） | 快照投影（按角色∪高频筛 ≤12 条 + 全量 stats）/ `factory_status` 摘要 |
| `inbox/<role>.jsonl` | 阶段派发、打回清单、报告、阻塞上报。每行一条 JSON，**一行损坏不能让整个邮箱不可读** | store（追加） | 成员（`factory_inbox`）/ 面板事件流 |
| `archive/<factoryId>/` | 交付/废弃工厂的整体快照 | store | 运维与复盘 |

**邮箱三态**：`pending`（已落盘未投递）→ `deliveredAt`（已进入成员 live inbox）→ `readAt`
（成员真的消费了）。区分"投递成功"与"模型真的读到"是打回闭环能否收敛的关键。

---

## 5. 构建模型：双 program + 客户端 closure-factory

```
src/                                  tsc（NodeNext）        tsc（bundler + JSX）
  index.ts ────────────────────────►  lib/index.js           （exclude）
  command.ts ──────────────────────►  lib/command.js          （exclude）
  shared/ domain/ ─────────────────►  lib/{shared,domain}/    ✔ ──┐
  store/ runtime/ tools/ prompt/ web ► lib/{...}/             （exclude）
  client/ ─────────────────────────►  （exclude）              lib/client/{...}.js
                                                                  │
                                                       tsdown -c tsdown.config.ts
                                                                  ▼
                                                          lib/client.js  ← 经典 <script> 加载
```

> `lib/` 由 `tsc`（**不 clean**）+ `tsdown`（`clean: false`）累加写入，所以**删掉一个源文件后必须手工
> 删掉它的旧产物**，否则发布包里会留下已删源码的 `.js/.d.ts`（t18 删除事件词表时就踩到过这一点）。
> `lib/` 顶层 = `index.js` / `index.d.ts` / `command.js` / `command.d.ts` / `client.js`（各带 `.map`），
> 目录 = `client/ domain/ prompt/ runtime/ shared/ store/ tools/ web/`。

### 5.1 产物与入口

| 半部 | 入口 | 产物 | 加载方式 |
|---|---|---|---|
| host | `src/index.ts`（`apply(ctx, config)` + `name` + `inject` + `Config`） | `lib/index.js` + `lib/**/*.d.ts` | Node ESM，由 `cordis.patch.yml` 挂进 profile composition |
| client | `src/client/index.tsx` | `lib/client/client/index.js` → 打包为 **`lib/client.js`** | 由 Web shell 作为**经典 script** 加载 |

`package.json` 的 `dsh` 字段声明了 bundle patch 与 client 平台/依赖包（`dsh.client.inject` 是**npm 包名**，
不是服务 key——这两个 `inject` 命名空间完全不同，是历史踩坑点）。

### 5.2 `window.__ModuleLoader__` CJS closure-factory 协议

客户端产物不是 ES module。它注册一个 CJS 闭包工厂：

```js
window.__ModuleLoader__.load({
  id: "dsh-code-factory",              // 包名
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    // …被打进来的自有代码…
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

- `require()` **只能**解析 shell 已经提供的外部包：`react`、`react-dom` 以及所有 `@deepseek-ai/*`。
  其余一律 inline（由 `tsdown.config.ts` 的 `neverBundle` / `alwaysBundle` 决定）。
- 必须导出 `apply` 与 `inject`：`inject` 是**裸服务 key** 数组（如 `'slots'`），与 manifest 里的包名列表不是一回事。
- banner/footer 已由 `tsdown.config.ts` 按上述形状生成，产物路径固定 `lib/client.js`。
- HMR：只有 DSH 的 Web 构建 watcher（`pnpm run dev:web`）在跑时才免刷新；否则必须刷新页面。

---

## 6. 运行时契约要点（来自 API-CONTRACTS，均已核实）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | 状态路径一律用 `caller.session.header.cwd` | 多会话/多工作区共存时用 `process.cwd()` 会串台 |
| 2 | ⛔ **不得写自定义（非 surface）会话事件**（`Session.append` 无法设置 `ignorable`，写进去的会话永久无法恢复）；真相源只有磁盘 | 见 API-CONTRACTS §1.7 与陷阱 #1/#4；"谁调用了哪个工具"由宿主自己的 `tool/call` + `tool/result` 记录 |
| 3 | 成员 `toolFilter` 只做名称存活审计；0.2.2 不再发送，队长工具靠步骤准入隐藏 | 若误以为旧 filter 仍生效，成员会看到并可能调用队长工具，破坏裁决边界 |
| 4 | continuable 成员不能靠 `provider.capabilities` 判断，看 `prepareContinuable`；`maxDepth` 一个字节都不要传 | capability 开关只描述**一次性** `start` 路径；拿它判断 continuable 会**误判并错误降级**。`maxDepth: 0` 会让成员本身创建失败；深度约束走可见性 + 父链守卫 |
| 5 | Web 路由必须做鉴权包装 + 防路径穿越 | 原始 `webServer` 路由不继承鉴权围栏，本地任意进程可读工厂状态 |
| 6 | 门禁 `script` 命令只能来自流水线模板 | 绝不允许模型自由指定命令执行；`domain/gates.ts` 还会拒绝命令拼接 |
| 7 | 并行阶段的角色 `outputs` 必须互不重叠 | 否则并行成员互相覆盖工件（`roles.ts` 已按此设计） |
| 8 | 引擎与面板都不得把模型文本当通过证据 | 五类门禁 + 7 条 DoD 全部机器可校验（文件/标题/结论行/退出码/git） |

---

## 7. 已知限制（如实声明）

1. **单进程内串行，多进程不协调。** `withFactoryLock` 只保证一个 Node 进程内的串行写；
   两个 DSH 进程同时操作同一个 `.code-factory/<id>/` 不受保护。与参考插件同边界。
2. **成员工件边界是"完成时审计"，不是写入拦截。** DSH 无法阻止子代理写任意路径；因此
   `roles.ts` 的 `outputs` 白名单是**软约束（写进人设）+ 硬兜底（DoD 阶段核对实际改动路径）**，
   越界写入判失败并打回，但损坏已经发生。需要更强隔离时只能靠宿主沙箱策略。
3. **`tsconfig.client.json` include 了 `src/domain`**：领域层任何 host 依赖都会让浏览器 program 编译失败，
   也就是说领域层没有"只在 host 用一下"的余地（见 3.1）。
4. **门禁脚本有栈假设。** 模板里的 `npm run build --if-present` / `python -m compileall` /
   `python -m pytest -q` / `bash start.sh --check` 是**意见化**的：工作区不匹配该栈时门禁会失败或空过。
   命令只来自模板、不接受模型指定，这是有意的取舍；栈不匹配时由人调整模板（改代码，不是改运行时行为）。
5. **平台差异**：`bash start.sh --check` 假定有 POSIX 风格 shell（Windows 上需 Git Bash 之类），
   首个端到端样例建议在同类环境下验证。
6. **面板可观测性依赖 JSONL 完整性**：邮箱或 `factory.json` 损坏时，读取端必须降级（跳过坏行 /
   回退到部分状态），不得让整个工厂不可读。
7. **当前落地程度（截至本次刷新 t24：**全部模块已落地**）**：真源（`src/domain/`）、持久层（`src/store/`）、
   成员运行时与门禁执行器（`src/runtime/`）、工具面与插件入口（`src/tools/` + `src/index.ts`，16 个 `factory_*` 工具）、
   Web 状态路由（`src/web/`）、驾驶舱客户端（`src/client/` → `lib/client.js`）、
   `/factory` 命令与验证工具链（`scripts/verify.mjs` / `scripts/doctor.mjs` / `scripts/check-docs.mjs` / `compatibility.json`）
   均已就位：`pnpm build` exit 0、`node scripts/verify.mjs` 103/103、`pnpm run doctor:install` 9/9，
   且在 headless profile（`dsh factory-rehearsal`）里实测激活、`factory_plan` 真实落盘。
   多进程协调亦已落地：所有状态修改都在 `<root>/.locks/<factoryId>.lock` 上串行化（锁内 FIFO、持有者与过期可查），
   因此同一工作区上的第二个宿主会等待而不是静默覆盖；`factory.json` 的写入同时报告自己是否真的 fsync。
   操作者向的用法手册已落地：[usage.md](usage.md)
   （16 个工具 / 状态模型 / 五类门禁 / 打回循环 / 人工审批点 / 故障排查）；能力边界见 [limitations.md](limitations.md)。

---

## 8. 里程碑对照（实现现状）

> 下表是**本次刷新（t24）**的快照（行数/产物取值自当前工作区，且由 `scripts/check-docs.mjs` 强制对齐）；仓库实际文件列表为准。

| 里程碑 | 内容 | 现状 |
|---|---|---|
| M0 | 工程骨架 / 双 tsconfig / tsdown / patch / 类型环境 | ✅ `package.json` / `tsconfig*.json` / `tsdown.config.ts` / `cordis.patch.yml` |
| M1 | 领域层（角色 / 路由 / 5 套流水线 / 门禁判定 / DoD） | ✅ `src/domain/`（10 模块 3871 行：12 岗位 / 5 模板 43 阶段 / 7 条 DoD，纯函数） |
| M2 | 持久层（`factory.json` / 邮箱 / 工件表 / 归档 / 原子写 / 锁） | ✅ `src/store/`（7 模块 5108 行）；`node scripts/verify.mjs` 的 E 区往返检查全绿 |
| M3 | Host 工具面与 staged 流程 | ✅ `src/tools/`（14 模块 6095 行，13 队长 + 3 成员工具）+ `src/index.ts`（入口）+ `src/prompt/`（order 118 已接线）；`/factory` 命令已就位 |
| M4 | 真实成员执行（子代理生命周期 / 兼容缝 / 工具面收窄） | ✅ `src/runtime/`（10 模块 5738 行：`members` / `compat` / `tool-surface` / `provider-guard` / `commands` / `gates-runner` / `scheduler` / `testing` / `tokens` / `index`）。**已核实到什么程度**：离线 harness（79 项）用真实 `defineTool` 定义 + mock subagents 跑通 spawn→首轮投递→报告→回收与六态派发决策；headless profile 里实测的是**插件激活 + `factory_plan` 真实落盘**（staged 阶段不创建子会话，所以真实 spawn 仍待在带成员的端到端里复核） |
| M5 | 门禁执行器（`script` / `dod` 真跑 + 打回闭环 + 人工审批） | ✅ 判定侧（`domain/gates.ts` / `domain/dod.ts`，`verify.mjs` C/D 区全绿）+ 执行侧 `runtime/gates-runner.ts`（模板白名单 + 超时 + **拒绝执行即未达标**）。**已核实到什么程度**：离线 harness 覆盖 checklist/keyword 打回（failGoto 回退 + round+1 + 邮箱整改清单 + steer 唤醒）、`humanApproval` 挂起与确认后复用证据、轮次用尽升级、无执行器时脚本门禁绝不通过；**未做**：真实工作区里跑 `pytest` / `npm run build` 这类命令的端到端 |
| M6 | Web 面板（状态路由 + 快照投影 + 客户端槽位） | ✅ 客户端面板已打包为 `lib/client.js`（`pnpm run doctor:install` 第 4 项验证 closure-factory 注册）；host 状态路由 `src/web/`（`/plugins/code-factory/state`，只读、防穿越）已落地，无 webServer 的 composition 里降级为不注册 |
| M7 | 打包 / 兼容矩阵 / README / 验证工具链 | ✅ `scripts/verify.mjs`（4370 行，`node scripts/verify.mjs` → 103/103 exit 0）、`scripts/doctor.mjs`（552 行，9 项自检，`pnpm run doctor:install` → 9/9 exit 0）、`scripts/check-docs.mjs`（文档数字强制同步；行数口径=编辑器语义，见脚本头部）、`compatibility.json`（140 行）、README/README_ZH/本文件；[usage.md](usage.md)（操作者手册：16 个工具 / 状态模型 / 五类门禁 / 打回循环 / 人工审批点 / 故障排查） |

---

## 9. 相关文档

- [API-CONTRACTS.md](API-CONTRACTS.md) —— DSH 插件契约（唯一 API 权威，含编码与工具纪律 §6）
- [roles-and-pipelines.md](roles-and-pipelines.md) —— 12 岗位 / 5 套流水线 / 组队规则 / DoD 七条
- [usage.md](usage.md) —— 操作者手册（两阶段协议 / 16 个工具 / 状态模型 / 五类门禁 / 打回循环 / 人工审批点 / 故障排查）
- [limitations.md](limitations.md) —— 能力边界与已知限制（首要一条：不支持接手既有代码库，即 brownfield / takeover）
