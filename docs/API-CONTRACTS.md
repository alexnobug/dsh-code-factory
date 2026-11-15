# code-factory · DSH 插件 API 契约（已核实）

> **本文件是团队的唯一 API 权威。** 所有代码必须与本文件一致。
> 每条结论都通过以下三种途径之一核实过，标注在每节末尾：
> `[LIVE]` = live host 的 `cordis_inspect_query` 真实返回；
> `[REF]` = 本机已安装的参考插件 `@nanmicoder/dsh-agent-teams@0.1.22` 的真实产物（`lib/index.js`、`lib/types/*.d.ts`、`lib/client.js`）；
> `[CFG]` = 本机 DSH 运行时的配置文件。
>
> ⚠️ **绝对禁止**凭记忆或"看起来合理"猜测 API。不确定就去查（见文末「如何查证」）。

---

## 0. 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| DSH 核心版本 | **0.2.2-rc.3** | `[CFG]` `C:\Users\李北春\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json` |
| 运行 profile | `desktop` | `[CFG]` `D:\dsh-home\profiles\desktop\package.json` |
| Node / pnpm | v24.22.1 / 10.18.3 | 实测 |
| 核心包 `.d.ts` | ⚠️ **不在磁盘上**（打包在 `app.asar` 内） | 实测 |
| 类型来源 | 本项目 `devDependencies` 从 npm 装的同版本包 | `package.json` |

**含义**：本项目自带 `node_modules`（`pnpm install` 后），类型检查用的是这里装的 `@deepseek-ai/*@0.2.2-rc.3`。
不要试图从 `app.asar` 或 profile 的 `node_modules` 里链接类型——那里没有。

---

## 1. Host 半部

### 1.1 插件入口 `src/index.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'code-factory'
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents', 'sessions', 'webServer', 'commands']
export const Config = z.object({
  stateDir: z.string().default('.code-factory'),
  memberProvider: z.string().default('spawn'),
  memberMaxDepth: z.number().default(0),
  maxMembers: z.number().default(DEFAULT_MAX_MEMBERS), // = 最宽模板编制数，当前 11
  slashCommand: z.boolean().default(true),
})
export function apply(ctx: Context, config: Config): void { /* ... */ }
```

- `name` 是 loader 行 id 之外的插件名；`cordis.patch.yml` 的 `name` 字段必须是**包名** `dsh-code-factory`。`[REF]`
- `inject` 是**裸服务 key** 数组。注册 HTTP 路由必须 inject `webServer`；注册斜杠命令必须 inject `commands`。`[REF]`
- 用不到的 `inject` 不要写——会拖慢/阻塞激活。
- `Config` 用 schemastery。`z.object()` 有隐式 `{}` 默认值，可选字段要么给 `.default()`，要么显式 `z.const(undefined)`。`[REF]`

**服务 key 的 defensive 回退**（不同 composition 下 key 可能不同，参考实现就这么写的）：`[REF]`

```ts
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const
```

所有注册（工具、路由、命令、提示词段落、槽位）都必须用 `ctx.effect(...)` 或接收其返回的 disposer，
以保证 HMR 与插件卸载时干净回收。`[REF]`

### 1.2 工具注册

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'factory_plan',
  description: '…给模型看的说明，写清楚「何时用」和「返回什么」…',
  parameters: {                                   // 自定义 ValueSchemaSpec DSL
    brief: { type: 'string', required: true, description: '用户原始需求' },
    maxMembers: { type: 'number', description: '编制上限' },   // 可选参数 = 省略 required，见下
  },
  output: {                                       // ⚠️ output 是必填项
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        factoryId: { type: 'string', required: true },
        team: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    const caller = exec.agent                          // 调用者 Agent
    if (!caller) throw new Error('factory_plan requires a calling agent')
    const cwd = caller.session.header.cwd              // ⭐ 工作区根，永远用它，不要用 process.cwd()
    // ⛔ 这里**不要**写任何会话事件（连 try/catch 都不要包）：out-of-repo 插件
    //    无法合法 append 自定义事件类型，写进去会让该会话永久无法恢复。见 §1.7。
    return { factoryId: '…', team: ['pm'] }
  },
}))
```

- 参数 DSL 是**自定义形状**：`{ type, required, description }` —— **不是** schemastery，**不是**原始 JSON Schema。
  必需参数写 `required: true`；**可选参数就直接省略 `required`**（DSL 的类型是 `required?: true`，
  写 `required: false` 会编译失败）。`[实测]`
- `output.schema` 用同一套 DSL；`render` 返回 `ContentBlock[]`。
- ⚠️ **状态必须按 `caller.session.header.cwd` 解析**。多个会话可能有不同工作区，
  用 `process.cwd()` 会串台。参考骨架就踩了这个坑。`[LIVE]`
- ⛔ **不要写会话事件**（`Session.append('<自定义类型>', …)`）——见 §1.7 与 §3 陷阱 #1。

### 1.3 系统提示词段落

```ts
ctx.systemPrompt.section({
  name: 'code-factory',      // ⭐ 必填
  order: 118,                // 参考插件用 117；117=委派策略之后
  text: captainProtocolText, // ⭐ 字段名是 text，不是 content
})
```

⚠️ **单参数对象**。写成 `section('code-factory', {...})` 会直接编译失败。`[LIVE]`

### 1.4 子代理（成员）— 精确类型（0.2.2-rc.3）

> 0.2.2-rc.3 的 `SubagentActivationSpec` 是**扁平**结构：`SubagentStartRequest` 的字段直接
> 在 spec 顶层，旧的 `request` 嵌套对象已删除。`persona` / `toolFilter` 也不在公开 start
> 请求中：成员人设由初始 `prompt` 承载，队长工具用步骤准入条件隐藏，委派工具由父 preset 提供。

```ts
interface SubagentActivationSpec extends Omit<SubagentStartRequest, 'label' | 'signal'> {
  readonly provider: string                     // provider 名字符串，不是 provider 对象
  readonly label: string
  readonly name?: string                        // 可选，父级 children 内唯一
  readonly childId?: SessionId                  // 传了 ⇒ 本地 activation，messageId 必有
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'        // 完成通知回父模型 / 只回调用方
}

interface SubagentStartRequest {
  readonly cwd?: string
  readonly agentPreset?: string                 // 可选独立 preset；不传则加入父 revision
  readonly label?: string
  readonly prompt: ContentBlock[]               // ⭐ 初始提示（ContentBlock[]，不是 string）
  readonly parent: Agent                        // ⭐ 顶层 parent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions          // 成员级模型路由
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number                    // 本次创建的绝对深度上限
}

interface SubagentActivation {
  readonly childId: SessionId
  readonly name: string
  readonly messageId?: MessageId
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface AgentOptions { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }
```

**成员人设与可见性**：`role.systemPrompt` 现在与成员简报合并成一个
`prompt: [{ type:'text', text }]`。13 个队长工具在注册时带
`{ when: ({ agent }) => delegationDepthOf(agent) === 0 }`，delegated agent 看不到；
member tools（`factory_report` / `factory_inbox` / `factory_block`）保持可见。
`toolFilter` 的历史 deny 名单仍由 `runtime/tool-surface.ts` 计算用于审计/旧 host，
但 **0.2.2 不再随 start 请求发送**。委派形状工具由父 preset 提供，运行期由
`installMemberDelegationGuard` 拒绝成员再派生。契约背景见
[limitations.md](limitations.md) §5。

`delivery` 的选择（`src/runtime/members.ts` 里有同样的注释）：`'parent'` 把完成通知
以 user-role 消息回给父 agent（队长模型），`'caller'` 只把 result 返回调用方、不通知模型。
成员是队长所有的 durable worker，"成员回报 → 队长裁决"的自动推进依赖通知 ⇒ 选 **`'parent'`**。

正确用法：

```ts
const started = await ctx.subagents.startActivation({
  provider: config.memberProvider,                 // 'spawn' | 'fork'
  label: `${role.title}@${factoryId}`,
  parent: caller,
  prompt: [{ type: 'text', text: [role.systemPrompt, renderMemberBrief(role, state)].join('\n\n') }],
  // ⛔ 不要传 maxDepth —— 见下方「maxDepth 陷阱」
  agentOptions: { model: role.model },
  signal,
  delivery: 'parent',                                // 完成通知回队长模型
})
// started.childId 写入 factory.json 的 members[].sessionId
```

⚠️ **`messageId` 是可选的**：不传 `childId` 时 `startActivation` 命中 overload 2，
返回的 `SubagentActivation.messageId?` 可以缺失。本项目不传 `childId`（本地/外部由 provider
决定），所以 `MemberSpawnSuccess.messageId` 是 `string | undefined`：host 没给就**省略字段**，
不伪造空串。需要"必有 messageId"的调用方应显式传 `childId` 走 overload 1。

#### ⛔ maxDepth 陷阱：传 `0` 会让**每一次 spawn 都失败**

直觉写法 `maxDepth: 0`（想表达"成员不得再派生子代理"）是**致命错误**。证据链
（`node_modules/@deepseek-ai/dsh-subagent/lib/index.js`，本项目已实测核对）：

- `:279-282` — `resolveChildDepth(parent, maxDepth)`：`childDepth` = 父深度 + 1；
  `if (maxDepth !== undefined && childDepth > maxDepth) throw new SubagentDepthError(...)`
- `:3039` — `startActivation` 先 `assertSubagentMaxDepth(spec.maxDepth)`；
  `startLocal` 在 `:1396` / `:1398` 再断言并解析深度
- 队长处于顶层、深度 0 ⇒ 成员深度 1；`1 > 0` ⇒ **抛错，成员一个都起不来**

而且这个 cap **不继承**给成员自己的委派，所以它根本表达不了"成员不得再派生"这件事。

**正确做法：一个字节都不传 `maxDepth`**，改用两条真实约束：

1. **主约束** —— 父链守卫 `installMemberDelegationGuard`：成员作为 parent 的委派调用会被拒绝。
2. **可见性** —— 13 个队长工厂工具在注册时带 `{ when: delegationDepthOf(agent) === 0 }`，
   成员看不到；`subagent` / `workflow` 等委派形状工具来自父 preset，插件不能逐成员隐藏，
   只能由上面的守卫在调用入口拦截。

> 反直觉事实：host 服务级配置的 `maxDepth` **默认是 1**，即默认情况下成员**有能力**再派一层；
> 真正的封堵必须靠上面的守卫/可见性，不能用 `maxDepth: 0`。

⚠️ **骨架的错误写法**（不要照抄）：`startActivation({ parent: caller, brief })` —— 没有 `parent`/`brief` 顶层字段。`[LIVE]`

`AgentOptions.reasoningEffort` 是 `ReasoningEffortId`（品牌类型），不要传裸字符串除非类型允许。

**能力门控 —— 0.2.2 的四个启动开关 + continuable 判定**（已核对
`node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts:109-121` 原文注释）：

```ts
interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}
```

原文注释：

> "Start-time options supported by a registered backend. The manager checks every requested option
> before preparing a local child or starting an external execution. `depthLimit` controls `maxDepth`;
> the remaining flag names match `SubagentStartRequest` fields."

所以这四个开关描述的是**启动选项支持**（host 在每次 start 时校验），**不是** continuable 能力：

- ❌ **不要**用 capabilities 判断 continuable 是否可用（`persona` / `toolFilter` 已不在
  start 请求与 capabilities 类型中）。
- ✅ continuable 能力看 `prepareContinuable` 是否存在（types.d.ts:327-340 原文：
  "Method presence selects local activation execution. Providers without it execute through
  `start` and do not accept subsequent messages."）：

```ts
const provider = ctx.subagents.getProvider(config.memberProvider)
if (!provider) throw new Error(`no subagent provider "${config.memberProvider}"`)
if (typeof provider.prepareContinuable !== 'function') {
  throw new Error(`provider "${provider.name}" cannot establish continuable children`)
}
```

`prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>` 是 provider
对「如何给这个孩子播种历史」的贡献（`ContinuableCreateSpec = { seed?: readonly SessionEvent[] }`），
是**数据不是能力**——它不携带 Agent / prompt 投递 / 结果 / 回收，那些全由 manager 负责。

`getProvider` 的用途是**校验 provider 存在性与 continuable 支持**，不是取对象回传给
`startActivation`（后者收的是 provider **名字符串**）。`[LIVE + node_modules]`

**可见性约束**：13 个队长工具注册时带步骤准入条件，`delegationDepthOf(agent) > 0` 的成员看不到；
历史 `toolFilter` 名单仍做名称存活审计，但 0.2.2 不再把它发送给 host。`[LIVE + node_modules]`

**其余可用面**：`[LIVE]`

| 方法 | 用途 |
|---|---|
| `sendMessage(sender, targetId, content, options)` | 投递给直属父/子。运行中的目标在最近 step 边界接入；**空闲目标起一轮**；**不在场的直属子代理冷恢复** —— 这是"打回后唤醒责任人"的实现基础 |
| `interrupt(targetSessionId, authority)` | `authority = { kind:'user' } \| { kind:'ancestor', agent }` |
| `listDescendants(rootSessionId, signal?)` | 递归枚举；本项目只取 `kind='child'` 且 `depth=1` 的直属成员 |
| `drainDescendants(parents)` | 关闭整棵子代理森林；halt/delete/archive 用 `drainDescendants([captain])` 回收成员 |
| `getProvider(name)` | 按名字校验已注册 provider；0.2.2 移除了 `list()`，不再枚举全部 provider |

### 1.5 HTTP 路由（面板数据通道）

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'

ctx.webServer.register({
  kind: 'prefix',                                  // 'exact' | 'prefix'
  path: '/plugins/code-factory/state',
  handler: async (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(snapshot))
  },
})
```

⚠️ **安全**：原始 WebServer 路由**不继承 Connection 的鉴权围栏**。参考插件为此提供了
`authenticatedWebRoutes(server, connection)` 包装与 `readJsonRequest(req, maxBytes)` 工具。
本项目必须做同等包装（或至少：只读、只接受已知 factoryId、路径剥离防穿越、拒绝 `..`）。`[REF]`

### 1.6 斜杠命令

`ctx.commands.register(definition: CommandDefinition): () => void`。`[LIVE + node_modules]`

本项目对应 `registerFactoryCommand(ctx, { enabled })`（`src/command.ts`，接口已冻结）。

**命令产生的激活消息用的是自定义 message source kind**（已于 t9 落地并验证）：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'code-factory-command': { readonly kind: 'code-factory-command'; readonly goal: string }
  }
}
// followup 时：source: { kind: 'code-factory-command', goal }
```

依据（三重）：live `Service.listService{service:'llm'}` 的 `MessageSourceMap { user; model; tool; 'system-prompt' }`
是**声明合并**的、`MessageBase.source: MessageSource`；`createUserMessage` 内部就是
`createMessage({...input, role:'user'})` → `deepFreeze(structuredClone({...input, id}))`，**source 原样透传、无白名单**；
参考插件 `lib/command.js` 用的是同款做法。`role` 与 `source` 是两个独立轴，所以自定义 source 不影响 user-role。

> **阴性对照已做**：同样的 kind 若不 import `command.ts`（即拿不到声明合并），编译报
> `TS2322: '"code-factory-command"' is not assignable to '"user" | "model" | "tool" | "system-prompt"'`。
> 证明合法性完全来自我们的声明，没有用 `as`/`any` 绕过。

**两条已知限制（记录在案，非缺陷）**：

1. `Agent.followup` 每回合只投递**一条**普通消息，因此 `goal` 与激活指令仍在同一条消息里，只是归属变为插件。
   用户原话不再作为用户气泡出现，而是存在 renderer 可读的 `source.goal` 中。要做到「用户气泡 + 独立插件指令」
   需要 pre-step 钩子（超出当前冻结接口），或用 `inject`（官方文档承认可能 miss 掉 pre-step 已领取的批次）。
   **→ 运行时 e2e 时必须实测：未知 source kind 在会话流里的渲染表现。**
2. `tsconfig.client.json` **不包含** `src/command.ts`，所以浏览器端类型空间看不到这个扩增。
   客户端若要按 kind 分派渲染，需自行声明同一个 kind。当前 `src/client/` 按工具事件渲染，
   不依赖该 kind，因此未做共享声明。

### 1.7 会话事件：**禁止写自定义事件类型**（不是风格问题，是机制限制）

> **规则：out-of-repo 插件不得用 `Session.append` 写任何自定义（非 surface）会话事件类型。**
> 本项目曾经这么做过（13 个自定义事件类型 + 一个 `SessionEventMap` 声明合并模块），
> 结果是**任何用过 code-factory 的会话都无法再被读取或恢复**；该机制已于 t18 全部删除。
> 现在 `src/` 里不存在任何事件词表、也不存在任何 append 调用。

**为什么这条路本身不通**（三条，逐条可核）：

1. `@deepseek-ai/dsh-session` 的 `known-event-types` 只收录**本仓库内**声明的事件类型。
   原文：*"Downstream (out-of-repo) plugin events are outside this list by construction"*
   —— 插件的事件按构造就在集合之外。
2. 持久化读取路径遇到集合外的事件类型时，**除非该事件带信封的 `ignorable` 标记，否则拒绝解释整个日志**。
3. 而 `Session.append` 构造信封时只写 `{ type, seq, time, data, ...surfaceMetadata }`
   （`surfaceMetadataSnapshot` 只有 `sourceEventSeqs` / `surfaceOp`），
   **没有任何途径设置 `ignorable`** —— 全仓库对 `ignorable` 只有读、没有写。

**后果（实测，非推断）**：写入当场没有报错，但那次会话**永久无法再被读取或恢复**：

```text
dsh: failed to observe session "session-ee6501d5-…": session contains event type
"<plugin-event-type>" (seq 20) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness
```

`dsh --session-id <id>` 直接失败，且日志已落盘、无法事后修复。

**正确替代物（本来就在，不需要新增任何东西）**：

| 需求 | 用什么 |
|---|---|
| 状态真相 | 磁盘：`factory.json` / `artifacts.json` / `inbox/*.jsonl`（面板与 `factory_status` 都读它） |
| "谁在什么时候调用了哪个工具" | 宿主**自己**记录第一方 `tool/call` + `tool/result` —— 每次 `factory_*` 调用都会落盘，我们什么都不用写 |
| 面板 feed / 对话卡片 | 快照里的邮箱消息（`inbox/*.jsonl`）+ 只读 HTTP 路由；不依赖会话事件 |

⛔ **不要用 surface 事件绕过**（`user/message` / `assistant/message` / `tool/result` / `system/message` /
`developer/message`）：它们参与消息投影与历史校验，伪装成 surface 会产生**错误的会话历史**。

⚠️ **两处易混点，不要误删**：

- `'code-factory-command'`（`src/command.ts`）与 `'code-factory'`（`src/runtime/compat.ts`）是
  **`MessageSourceMap` 的消息来源 kind**，与会话事件是**两条不同的轴**。删掉它们会让
  `/factory` 注入的激活消息与成员派发消息失去归属（聊天气泡/渲染会退化为未知来源）。**保留。**
- 路由路径 `/plugins/code-factory/state`、插件名 `code-factory`、状态目录 `.code-factory`、
  错误文案前缀 `code-factory:` 等含 `code-factory` 字样的地方与本节无关。

**仍然需要知道的类型规则**（与事件无关，别一起删）：`@deepseek-ai/dsh-session` 的**根入口**
（`lib/types/index.d.ts`）带 `declare module '@deepseek-ai/cordis' { interface Context { sessions: SessionStore } }`，
而浏览器侧 `@deepseek-ai/dsh-api-session-controller/client` 声明的是 `sessions: ISessions`，
**两者同时进入一个 program 才会同名冲突**。所以：

| 导入 | 用在哪 |
|---|---|
| `@deepseek-ai/dsh-session`（根入口） | ✅ 只在 **host 且被 `tsconfig.client.json` exclude** 的文件里（当前唯一用处：`src/runtime/compat.ts` 取 `SessionId` 品牌类型） |
| `@deepseek-ai/dsh-session/types`（子路径） | ✅ 该子路径只声明 `SessionEventMap`、**不**增强 `Context`，因此在任意 program 都安全；`SessionId` 一类品牌类型也可以从这里取 |

当前 `src/` 对 `dsh-session` 只有一处 type-only import（`src/runtime/compat.ts`），
且该文件不在 client program 里。

---

## 2. Client 半部

### 2.1 manifest（`package.json` 的 `dsh` 字段）

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots", "…"]
  }
}
```

⚠️⚠️ **两个同名但语义完全不同的 `inject`，最容易踩的坑**：

| 位置 | 命名空间 | 内容 |
|---|---|---|
| `package.json` → `dsh.client.inject` | **npm 包名** | 哪些 client 包必须先加载 |
| `src/client/index.tsx` 的 `export const inject` | **裸服务 key** | 本模块需要哪些运行时服务（`'slots'`、`'sessions'`…） |

两者不可混用。`[REF]`

### 2.2 打包协议（已核实）

Client 半部**不是** ES module。它由经典 `<script>` 加载，在 `window.__ModuleLoader__`
上注册一个 CJS closure factory。参考产物的真实首尾：`[REF]`

```js
window.__ModuleLoader__.load({
	id: "@nanmicoder/dsh-agent-teams",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		// …打包进来的自有代码…
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

要点：
- `id` 是**包名**（本项目为 `dsh-code-factory`）。
- factory 内 `require()` 只解析 shell 已提供的外部包：`react`、`react-dom`、所有 `@deepseek-ai/*`。
- 必须导出 `apply` 与 `inject`。
- 产物路径必须是 **`lib/client.js`**。
- 本项目的 banner/footer 已在 `tsdown.config.ts` 里按上述形状配好。

#### ⚠️ 什么能被 `require()`：只能 external 声明了 `dsh.client` 的包

**这是本项目差点踩爆的一个致命坑，务必理解规则再改 `tsdown.config.ts`。**

直觉规则「凡是 `@deepseek-ai/` 开头的都是 shell 提供的」**是错的**：

- `@deepseek-ai/dsh-brand` 同属该 scope，但它的 `package.json` **没有 `dsh` 字段**，
  即没有 `dsh.client` manifest → shell **从不注册它**。
- 官方 client bundle 是把 brand **内联**进去的：`dsh-client-ui-chat/lib/client.js` 里能直接读到
  `function brandString(value) { return value; }`，而它的 require 集合里**没有** dsh-brand。
  本机全部已安装 client bundle 里，require dsh-brand 的数量是 **0**。
- 因此一旦 emit 出 `require("@deepseek-ai/dsh-brand")`，浏览器里会**抛错并导致整个插件激活失败**——
  不是某个按钮失灵，是整个插件起不来。

**正确规则**：shell 能 `require()` 的 id 是**两个证据来源的并集** ——

1. 该包 manifest 声明了 `dsh.client`（充分条件）。实测 **10 个**：
   `dsh-api-session-controller`、`dsh-client-connection`、`dsh-client-locale`、
   `dsh-client-ui-chat`、`-conversation`、`-layout`、`-renderer`、`-sidebar`、`-sidebar-right`、
   `dsh-client-ui-session`。
2. 该 id 出现在**真实已发布 client bundle 的工厂前导 `require()`** 里（同样充分——
   它证明 shell 注册了这个 id，无论有没有 manifest）。实测 5 个**不声明** `dsh.client` 但确实被注册：
   `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`、
   **`dsh-client-ui-slots`**（就是 `ctx.slots` 本身）。

> ⚠️ 两个方向的失败模式**都不是报错**，而是静默的：
> external 了 shell 不注册的 id → 浏览器 `require` 抛错 → **整个插件激活失败**；
> bundle 了 shell 注册的 id → 打进第二份共享实例（store / slot core / primitives）→
> 身份比较静默失效。所以两个方向都必须有断言。

`scripts/shell-modules.mjs` 是这条规则的**唯一真源**（构建与断言共用），
`tsdown.config.ts` 与 `scripts/check-bundle.mjs` 都从它取；
`check-bundle.mjs` 作为 `pnpm build` 的最后一步，把两个方向都变成构建失败。
它内含自检（解析器 + 历史 bug 的闭包回归守卫），所以断言本身也能失败。

> 另一条相关事实：我们目前对 `@deepseek-ai/*` 的引用**几乎全是 `import type`**，
> 构建期被完全擦除，所以当前产物的 require 集合只有 `react` 与 `react/jsx-runtime`。
> 哪天要引入某个 client 包的**运行时值**，先确认它在上面那 9 个里面。

### 2.3 客户端入口

```tsx
export const inject = ['slots']                    // 裸服务 key
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'code-factory',
    order: 60,
    locale: CODE_FACTORY_LOCALE_NAMESPACE,
    inject: () => ({ /* 传给组件的额外 props */ }),
  }, FactoryCockpit))
}
```

真实调用形状（取自参考产物尾部）：`ctx.slots.inject(slotName, () => ctx.slots.register(reg, Component))`。`[REF]`

⚠️ **注册字段随槽位 kind 而变，写错会被静默忽略**（`node_modules/@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:559` 原文）：

```ts
export type KindOptions<K extends keyof SlotMap & string, EntryKey extends EntryKeyOf<K>, M = never> =
  SlotMap[K]['kind'] extends 'keyed'
    ? { key: EntryKey; priority?: number; ... }   // ⭐ keyed：只有 key + priority
    : { id: string; order?: number; ... }         // list / chain：才是 id + order
```

| 槽位 kind | 必填 | 排序字段 | 本项目实例 |
|---|---|---|---|
| `keyed` | `key` | **`priority`**（升序，默认 0） | `main` |
| `list` | `id` | **`order`**（升序） | `sidebar.panellist`、`conversation.chat.turnTail` |
| `chain` | `select` | `priority` | —（本项目未用） |

> **踩坑记录**：`main` 是 keyed，最初写成 `{ key, order: 60 }` —— `order` 对 keyed **不报错也不生效**，
> 想要的遮蔽次序根本没应用。同类错误不会出现在类型检查里（多余属性在对象字面量上本应报错，
> 但注册对象经过了一层宽化），必须靠上表人工核对。

公共可选字段：`label`（字符串或 thunk）、`locale`（命名空间）、`inject`（`() => Record<string, unknown>`）。

⚠️ `inject` 的返回类型约束是 `Record<string, unknown>`（不是 `object`）：自定义 interface 因缺字符串索引
签名而不兼容，会报 TS2322。`[实测]`

**类型来源（必须装为 devDependency，否则 `ctx.slots` 不存在）**：`ctx.slots` 的服务面由
`@deepseek-ai/dsh-client-ui-renderer` 声明，`sidebar.panellist` 的 `SlotMap` 条目由
`@deepseek-ai/dsh-client-ui-sidebar` 声明。缺了它们就只能靠结构镜像 + cast，会**丢掉槽位选项与
SlotMap 之间的编译期交叉校验**。`[实测]`

### 2.4 槽位（已用 live `Slots.listSubTree` 核对）

| 槽位 key | kind / scope | 用途 | 占用情况 |
|---|---|---|---|
| **`main`** | keyed / root | 「Central panel selected by sidebar entry id」 | 仅 `conversation` 已占；keyDomain **开放** |
| **`sidebar.panellist`** | list / root | 「Global panel icons」 | 空 |
| `sidebar.right.pane.tab` | keyed / session | 右栏页签主体 | 空 |
| `sidebar.right.pane.tab.title` | keyed / session | 页签标题 chip | 空 |
| `conversation.chat.turnTail` | list / session | 回合尾部贡献点 | 有他人占用，追加即可 |
| `tool.call.toolview` | keyed / session | 按**线上工具名**分派工具卡 | keyDomain 开放 |
| `conversation.plan-review.actions` | list / session | 计划审批动作位 | 空 |
| `conversation.input.left` | list / session | 输入框工具行左侧 | 空 |
| `shell.overlay` | list / root | 框架级浮层 | 有他人占用，追加即可 |
| `settings.section` | list / root | 插件设置页 | 有他人占用 |

⚠️ **硬约束**：`conversation.chat.node` 的 key 表**固定闭合**（19 个：`assistant-step` / `tool-call` /
`turn-tail` / …）。插件**不能新增 ChatNodeKind**。对话内卡片走 `turnTail` 或 `tool.call.toolview`。`[LIVE]`

⚠️ `main` 的 `replaceRisk` 是 `shadows-shipped-ui` —— 注册**新 key** 是追加不是覆盖，但绝不能劫持 `conversation`。`[LIVE]`

### 2.5 主题 token（`Theme.listTokens` 实测，全部要求亮/暗双值）

| 用途 | token |
|---|---|
| 页面底 / 主面板 / 次级面板 / 浮层 | `--dsw-alias-bg-base` / `--dsw-alias-bg-layer-1` / `--dsw-alias-bg-layer-2` / `--dsw-alias-bg-overlay` |
| 分隔线（弱/强） | `--dsw-alias-border-l1` / `--dsw-alias-border-l2` |
| 品牌强调 | `--dsw-alias-brand-primary` |
| 主/次文字 | `--dsw-alias-label-primary` / `--dsw-alias-label-secondary` |
| 成功 / 错误 / 警告 / 空闲 | `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` / `--dsw-alias-state-warn-primary` / `--dsw-alias-state-idle-primary` |
| 左栏底 | `--dsw-specific-sidebar-fill` |

⚠️ **语义状态一律走 `state-*` token**。原型的青/紫角色分类色没有对应 token，属于插件自有色板，
亮色主题下需自行降饱和；**不得**用于语义状态，否则亮色下失去语义。`[LIVE]`

### 2.6 客户端服务

- `ctx.slots` —— 槽位。

- **`ctx.locale` —— ⚠️ 必须从 `./client` 子路径导入才会出现在 `Context` 上。**

  `LocaleRuntime` 的 `Context` 增强声明在 **`@deepseek-ai/dsh-client-locale/client`**
  （`lib/types/client/index.d.ts`），不在包的根入口。根入口导出的只是设置页类型。

  ```ts
  import type {} from '@deepseek-ai/dsh-client-locale/client'   // ⭐ 触发 Context.locale 增强
  import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

  ctx.locale.register('codeFactory', { zh, en })   // 返回 disposer
  const t = ctx.locale.bind('codeFactory')         // 同命名空间重复 bind 返回同一函数引用
  ```

  实测签名（`node_modules/@deepseek-ai/dsh-client-locale/lib/types/client/index.d.ts`）：

  ```ts
  declare module '@deepseek-ai/cordis' { interface Context { locale: LocaleRuntime } }

  interface LocaleRuntime {
    /** 类型化重载：ns 必须来自 LocaleNamespaceMap；dicts 必须覆盖全部内置语言（zh + en），
     *  少一种就编译失败；重复注册同一 (ns, locale) 会抛错。 */
    register<N extends Extract<keyof LocaleNamespaceMap, string>>(
      ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void
    bind<N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N): TranslateNS<N>
  }
  ```

  即：中英双语**都被强制要求**，这正好把"中文是真源、英文必须逐键覆盖"变成编译期约束。`[node_modules]`

- **槽位 `inject` 的返回类型必须是 `Record<string, unknown>`**（不是自定义 interface）：
  声明 `(): FactoryInjectedProps` 会报 TS2322 "Index signature for type 'string' is missing"。
  给自定义类型加索引签名，或在调用处注解为 `Record<string, unknown>`。`[实测]`

- 需要宿主数据的走 **HTTP 路由轮询**（参考实现的做法），不要假设有 Remote 可用。

### 2.7 客户端 program 的类型环境（实测得出，缺一项就编译不过）

**四条声明导入**——类型面分散在四个子路径，每个都必须是 devDependency（只作类型来源，运行时仍由 shell 提供）：

| 提供什么 | 包 / 子路径 | 缺了的后果 |
|---|---|---|
| `ctx.slots` 服务面 | `@deepseek-ai/dsh-client-ui-renderer` | `ctx.slots` 在 Context 上不存在 |
| `sidebar.panellist` 的 SlotMap 条目 | `@deepseek-ai/dsh-client-ui-sidebar` | 该 key 不在联合里 → **TS2769** |
| `conversation.chat.turnTail` 的 SlotMap 条目 | `@deepseek-ai/dsh-client-ui-chat/client` | 同上 → **TS2769** |
| `ctx.locale` | `@deepseek-ai/dsh-client-locale/client` | `ctx.locale` 不存在 |
| `sessionId` 进入会话作用域槽位 props | `@deepseek-ai/dsh-client-ui-session/client` | 只能靠**传递**引入（chat → conversation → ui-session），依赖隐式、易被上游重构打断 |

```ts
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
```

**品牌类型（名义类型）**：`MainPanelId = Branded<'MainPanelId'>` 这类不接受明文 `string`。
用 `@deepseek-ai/dsh-brand` 的 `brandString<T>(value)` / `brandNumber<T>(value)` 转换，
**不要用 `as` 绕过**。该包已装为 devDependency。`[实测]`

**`sidebar.panellist` 的 owner 契约**（易错且编译器不提醒）：

外壳（sidebar 自己）负责渲染那一行按钮并自己调用 `selectPanel`；插件条目**只提供图标**。
owner share 类型是 `SidebarPanelIconOwnerProps = { size, active }`。

> ⚠️ 在插件条目里再渲染一个 `<button onClick={...}>` 会造成 **button 嵌套 button**（HTML 非法），
> 且外壳已经处理了点击，多出来的 onClick 是冗余的。
> **两种写法都能通过 tsc**——它只能靠人工遵守这条契约来保证。`[实测]`

**类型逃逸自检**：`src/client/` 应保持零 `as` / `any`。改完扫
`as unknown as`、` as `、`: any`、结构镜像类型名，命中应为 0。

---

## 3. 硬性约束与陷阱清单

| # | 约束 | 后果 |
|---|---|---|
| 1 | **禁止用 `Session.append` 写自定义（非 surface）事件类型**：out-of-repo 插件的事件按构造不在宿主 `known-event-types` 集合内，且 `Session.append` 无法设置 `ignorable` 标记 | 写入即让该会话**永久无法读取/恢复**（`dsh --session-id <id>` 直接失败）。机制与替代物见 §1.7 |
| 2 | 所有相对 import 写 `.js` 扩展名（host 用 NodeNext） | 运行期 ERR_MODULE_NOT_FOUND |
| 3 | 状态路径一律用 `caller.session.header.cwd` | 多工作区串台 |
| 4 | **不要**用 `try/catch` 包一个自定义 append 来"降级"：写入本身已经污染日志，捕获异常救不回来 | 交付出去的会话永久损坏（§6.2 的编码纪律也救不了——问题不在编码，在事件类型） |
| 5 | Web 路由必须做鉴权包装 + 防路径穿越 | 任意本地进程可读工厂状态 |
| 6 | 旧的 `toolFilter` 名单仍须通过名称存活校验；0.2.2 不再把它发送给 host | 对仍消费该字段的旧 host，未注册名字会让每次 spawn 失败；当前 host 仅作审计 |
| 7 | `provider.capabilities` 的四个开关只描述**启动选项支持**；continuable 看 `prepareContinuable` | 用 capabilities 判断 continuable / 人设 → **误判并错误降级** |
| 14 | **绝不向 `startActivation` 传 `maxDepth`**（含 `0`） | 队长深度 0 ⇒ 成员深度 1 > 0 ⇒ `SubagentDepthError`，**每一次 spawn 都失败**。深度约束走步骤准入 + 父链守卫 |
| 15 | 队长工具用 `{ when: delegationDepthOf(agent) === 0 }` 隐藏；不要试图恢复旧 `toolFilter` | 成员会看到并可能调用 `factory_gate` 等队长工具，破坏裁决边界 |
| 8 | 并行阶段的角色 outputs 白名单必须互不重叠 | 工件互相覆盖 |
| 9 | 禁止把 `lib/` 提交进 git？→ 本项目**暂不提交**（本地链接开发） | 见 README 说明 |
| 10 | 门禁 script 命令只能来自流水线模板 | 绝不能由模型自由指定命令执行 |
| 11 | `tsconfig.client.json` **include 了 `src/domain`**（面板要读角色/阶段常量） | 队友写 domain 时出现语法错误，**client program 会一起打挂**。看到 client typecheck 突然爆错，先看 `src/domain` 是否正在被别人编辑——不要怀疑 client 侧。已真实发生过一次 |
| 12 | 编译期看不到 keyed 槽位写错 `order`（见 2.3） | 遮蔽次序静默失效；必须按 kind 对照 2.3 的表人工核对 |
| 13 | 插件自己注册的 `factory_*` 工具在 **t4 完成前不存在** | 成员不能用 `factory_report` 汇报；用 AgentTeams 的 `agent_teams_update_task` + `agent_teams_send_message` |

---

## 4. 如何查证 API

**不要猜。** 按优先级：

1. **live 查询**（权威）：
   - 服务契约：`cordis_inspect_query` → `platform:'host'`, `provider:'Service'`, `method:'listService'`, `input:{service:'<key>'}`
   - 服务目录：同上，不带 `input`
   - 事件目录：`provider:'Event'`, `method:'listEvents'`
   - 客户端槽位：`platform:'client'`, `provider:'Slots'`, `method:'listSubTree'`
   - 主题 token：`platform:'client'`, `provider:'Theme'`, `method:'listTokens'`
   - 大结果会 spill 到临时文件，用 `read` / `grep` 看。
2. **参考插件产物**（真实可运行）：
   `C:\Users\15456\.dsh\profiles\desktop\node_modules\@nanmicoder\dsh-agent-teams\lib\`
   —— `index.js`（host 真实用法）、`client.js`（client 真实用法）、`types/*.d.ts`（精确签名）。
3. **本项目 `node_modules`** 里 `@deepseek-ai/*@0.2.2-rc.3` 的 `.d.ts`（`pnpm install` 之后）。

---

## 5. 与原型的对应关系

原型站点 `https://qn4hzz2tzcnda.ok.kimi.link/` 的完整规格（12 角色 / 10 阶段 / 7 条 DoD /
三栏驾驶舱）见仓库 `docs/` 与方案文档
`D:\DSH-Desktop\code-factory\DSH-CodeFactory-插件实施方案.md`。

⚠️ 原型是**模拟器**（`useSimulation.ts` 的 `SCRIPT[]` 定时器链 + 预写死字符串）。
本项目要让 durable 子代理**真读文件、真跑命令、真写工件**；面板只是磁盘真相的投影。

### 5.1 角色 id 命名约定（已定稿，勿再变更）

原型的角色表用的是短 id（`sec_eng` / `sys_arch` / `db_arch` / `fe_dev` / `be_dev` / `qa` …），
本项目采用**更可读的规范 id**，原型短 id 全部作为**已文档化的别名**保留：

| 规范 id（本项目唯一真源） | 原型别名 |
|---|---|
| `security_eng` | `sec_eng` |
| `sys_architect` | `sys_arch` |
| `db_architect` | `db_arch` |
| `frontend_dev` | `fe_dev` |
| `backend_dev` | `be_dev` |
| `qa_engineer` | `qa` |
| …完整 12 条见 `src/domain/roles.ts` 的 `PROTOTYPE_ROLE_ID_ALIASES` | |

**写代码一律用规范 id。** 别名只用于读原型规格与兼容旧数据。
注意邮箱文件名会经 `sanitizeKey` 把 `_` 净化为 `-`（`security_eng` → `inbox/security-eng.jsonl`），
读写两侧走同一个转换函数即可，不要手工拼文件名。

---

## 6. 编码与工具纪律（项目级硬规则，已因真实事故加入）

### 6.1 绝不用 PowerShell 读写源码文件

本机是**中文 Windows + Windows PowerShell 5.1**，`Get-Content` / `Set-Content` / `Out-File` /
`Add-Content` **默认使用 ANSI（CP936/GBK）而不是 UTF-8**。

一旦用它们做「读出 → 改 → 写回」，UTF-8 的中文字节会被按 GBK 解码成乱码再以 UTF-8 写回，
产生 **U+FFFD 替换字符**，并可能吞掉收尾引号，直接把文件变成语法错误。

> **本项目已经真实发生过一次**：`src/domain/` 下三个文件被这样损坏（分别含 62 / 22 / 17 个
> U+FFFD），靠作者及时发现并重写才恢复。

**规则：**

| 场景 | 必须用 |
|---|---|
| 读文件内容 | `read` 工具（或 `grep`） |
| 新建 / 整体重写 | `write` 工具 |
| 局部修改 | `edit` 工具 |
| **禁止** | 任何 pwsh 文本管道（`Get-Content`/`Set-Content`/`Out-File`/`-replace` 后写回）作用于 `.ts`/`.tsx`/`.md` |

如果确实需要用脚本处理文本，必须显式指定编码：

```powershell
# 读：显式 UTF-8
[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
# 写：显式 UTF-8 无 BOM
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

### 6.2 验证编码是否损坏的正确方法

**不要**根据 pwsh 控制台里看到的乱码下结论——控制台本身的显示编码就会把正常的 UTF-8 显示成乱码。
必须做**字节级**判定：

```powershell
$b   = [System.IO.File]::ReadAllBytes($path)
$enc = New-Object System.Text.UTF8Encoding($false, $true)   # throwOnInvalidBytes
try { $null = $enc.GetString($b); 'VALID UTF-8' } catch { "INVALID: $($_.Exception.Message)" }
# 另外统计 U+FFFD 数量：正常源码应当为 0
([System.IO.File]::ReadAllText($path,[System.Text.Encoding]::UTF8)).Split([char]0xFFFD).Count - 1
```

### 6.3 不要在他人在写盘时报「跨模块阻塞」

仓库级 `tsc -p tsconfig.json --noEmit` 覆盖所有成员的目录。**当其他成员正在写文件时，
仓库级类型检查必然出现大量来自他们目录的瞬时错误**，这不能证明对方交付有问题。

规则：
- 报「别人的模块坏了」之前，先确认对方任务是否仍在 `in_progress`；
- 只报**你自己目录**的类型状态作为交付证据；
- 跨模块阻塞必须**复测一次**再上报，并附上文件字节级证据与 `tsc` 原始输出。

### 6.4 打包探针必须先用真实 emit，不能用 `--noEmit` 的陈旧产物

**这条是真实踩坑，且第一次结论是错的。**

要验证「某个 import 会不会让产物多出一条 `require(...)`」时，正确顺序是：

```sh
pnpm build          # 或至少 tsc 真 emit 到 lib/，让 lib/ 反映当前源码
# 然后再跑 tsdown / 检查 lib/client.js 的 require 集合
```

**错误做法**：`tsc --noEmit` + tsdown。`--noEmit` **不刷新 `lib/`**，于是 tsdown 打的是**上一次的陈旧
emit 文件**，结论会假阴性——本项目第一次探针就因此得出「没有新增 require」，与预期不符才复查 emit
链路，发现是打了旧文件。

任何"产物应该变了/没变"的结论，都必须建立在**刚跑过一次真实 emit** 的前提上。

### 6.5 行数口径：只有一种，且别去"修"那两处 `split('\n')`

**唯一口径：换行计数（`\n` 出现次数）= 编辑器行数。** 覆盖 `src/**`、`scripts/*.mjs`、JSON。
`scripts/check-docs.mjs` 里的 `editorLines()` 就是它，并有规则禁止退回另一种写法。

为什么：`content.split('\n').length` 对**以换行结尾**的文件会**多算 1**（尾部空元素）。
`scripts/verify.mjs` 换行计数是 **1381**，用 split 会报 1382。t19 与 t26 两次踩过同一个坑。

⚠️ **但不要据此全局搜索并"修掉"所有 `split('\n').length`。**
仓库里还有两处，它们**不是**文件行数统计，语义完全不同：

| 位置 | 在算什么 | 为什么是对的 |
|---|---|---|
| `scripts/verify.mjs:821` | `after.trimEnd().split('\n').length` 断言行数 | 主体已 `trimEnd()`，尾部空元素不存在 |
| `scripts/verify.mjs:1155` | `lineIndexAt(text, index)`：字符偏移 → 行号 | 数的是**某偏移之前**有多少换行，不是全文行数 |

`scripts/check-docs.mjs` 头部出现的那两处同理——是**禁止说明**，不是用法。

判别标准：**这个 `split` 的主语是"整个文件内容"吗？** 是 → 用 `editorLines()`；不是 → 保持原样。

---

## 7. Web 状态路由契约（client ↔ host 的唯一数据通道）

面板没有 Remote 可用，host 半部注册一条只读 HTTP 路由，client 半部轮询它。

### 7.1 路径与三种形态

路由路径（`src/client/api.ts` 的 `CODE_FACTORY_STATE_ROUTE`，已是既成事实，host 必须与之逐字符一致）：

```
/plugins/code-factory/state
```

| 请求 | 返回 | 谁在用 |
|---|---|---|
| `?id=<factoryId>` | 该工厂的 `FactorySnapshot` | 主面板在已选定工厂时 |
| `?sessionId=<sid>` | **该会话所属**工厂的快照 | 对话内 turnTail 摘要卡（它关心"本会话的工厂"） |
| 无参数 | **工厂索引**（全部已知工作区的非归档工厂摘要，按 `updatedAt` 倒序） | 主面板未选定工厂时；同时充当空态探测 |

client 的 `normalizeFactories()` 同时接受「索引」与「单快照」两种 payload，所以返回形态不要互相嵌套。

#### ⛔ 索引是**跨工作区**的：绝不能拿它的某一行当"我的工厂"

无参形态返回的是**全机所有已知工作区**的工厂摘要——因为 HTTP 路由没有会话上下文，
它无从知道请求方属于哪个工作区。这是**规格层面的既定事实**，不是实现缺陷。

后果（已在真机复现）：客户端把索引第 0 行（或上次记住的 id）当成"当前工厂"渲染，
于是**显示的是另一个工作区里某个完全无关项目的工厂**。用户看到的驾驶舱可能是别人的项目，
且因为拿的是摘要，成员/阶段/DoD 全是空集合——"顶部有名字、中间全空"。

**正确姿势（客户端唯一可接受的优先级）：**

1. **当前会话的工厂** —— 传 `?sessionId=`，让 host 解析工作区。**首选**。
2. 用户**显式**选择 —— 传 `?id=`，且选择动作必须真的改变轮询 URL。
3. 都没有 —— **显示"本会话还没有工厂"**，不要退化成显示别人的工厂。

**宁可空着，也不要显示错的项目。** 索引只应用于：
(1) 填充选择器选项；(2) 判断"有没有工厂"以决定空态文案。**不得**直接当快照渲染。

> 这条规格是 Captain 最初写漏的：原始 §7.1 只写了"返回工厂索引"，没有警告它跨工作区。
> 记录在此，避免下一个人重犯。

### 7.2 ⚠️ 工作区解析必须由 host 侧完成

**这是最容易做错的一点。** client 只发 `id` / `sessionId`，**不发送任何文件系统路径**。
host 必须自己定位工厂：

1. 依次尝试候选服务键 `['workspaceRegistry', 'workspace']` 拿工作区注册表，
   对每个已注册工作区检查 `<workspacePath>/<stateDir>/<factoryId>/factory.json`。
2. 再叠加当前活跃会话的 cwd（`ctx.agents.list()` → `agent.session.header.cwd`）作为补充来源，
   覆盖"工作区尚未注册但会话已在其中"的情况。
3. `?sessionId=` 形态：先由该 session 解析出 cwd，再在该工作区内找
   `captainSessionId === sessionId` 的工厂；找不到则回退到该工作区最近更新的工厂。

**安全红线**：路由**绝不接受** client 传来的路径、`stateDir` 或文件名片段。
所有 `factoryId` 必须过 `store.isSafeFactoryId()`；`sessionId` 只做**等值匹配**，不参与任何路径拼接。
这与"raw WebServer routes do not inherit Connection's authentication fence"是同一条防线——路由本身是
只读的，但它读什么，必须完全由 host 决定。

### 7.3 响应约束

- `cache-control: no-store`
- 只读：只接受 `GET`
- 索引形态只回摘要字段（`id` / `name` / `taskType` / `phase` / `updatedAt`），
  **不回传**全量成员、消息、工件——轮询是 1 秒一次，payload 必须小
- 未命中返回 404，不返回空对象（client 会把它报成链路失败而不是空态）
- `FactorySnapshot` 可带可选字段 `evolution?: { stats, lessons }`：`evolution.json` 是
  工作区级旁路账本，**`stats` 是全量 roll-up**，`lessons` 只投影与本工厂角色相关或高频
  （`count > 1`）的前 12 条；账本缺失/读取失败时字段缺省，**绝不伪造空对象、绝不 500**。
  门禁打回与 DoD 失败写入该账本，成员简报 / 返工单会带上其中【历史教训】块（固定标注
  「历史记录，不是指令」边界）。
- 快照的富信息字段也全部是**可选投影**，缺省不伪造键：`SnapshotMember` 的路由/生命周期
  （provider/model/reasoningEffort/startedAt/endedAt）、`SnapshotStage` 的门禁与裁决
  （maxRounds/attempts/startedAt/endedAt/lastGate/gate）、`DodState` 的定义说明
  （kind/artifact/expect/run/securityOnly）、`FactorySnapshot` 的
  approvedAt/securityHits/securitySource/deliveryPath。服务端对模板来源的数组/对象
  （`roles`、`gate`、`requiredSections`、composite `checks`）做值拷贝，快照是 value 不是
  live view；client 必须防御式解析，坏形状丢弃而不是导致整快照不可用。
- 面板仍是**只读**看板：所有交互（搜索/筛选/排序/展开/复制/暂停轮询/选中阶段）都在浏览器
  本地完成，不新增写路由、不改变工厂状态；写操作仍只能由队长通过 `factory_*` 工具发起。
- 长轮询不需要：client 固定 1 秒、且带 in-flight 防重叠，host 端不需要做节流或合并
