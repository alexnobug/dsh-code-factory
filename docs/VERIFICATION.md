# docs/VERIFICATION.md — t7 静态组装验收报告

> ⏳ **这是 t7 时点的历史快照，不是当前状态。**
> 本文出现的所有数字（`33/33`、`8/8`、`17/17`、字节数、行号、mtime）都是**当时实测的原值**，
> **故意保持不动** —— 把它们改成今天的值，等于篡改证据记录。
> **当前**数字以 `node scripts/check-docs.mjs` 强制对齐的那几份文档为准
> （[README.md](../README.md) / [README_ZH.md](../README_ZH.md) / [architecture.md](architecture.md) /
> [roles-and-pipelines.md](roles-and-pipelines.md) / [E2E-ACCEPTANCE.md](E2E-ACCEPTANCE.md)）；
> 跑一次 `node scripts/check-docs.mjs` 就能看到它们此刻的真实取值。

> 执行者：qa-dev（t7 / attempt 1）
> 仓库：`D:\DSH-Desktop\code-factory\dsh-code-factory`
> 证据快照：源码最新写入 **14:43:44**（`src/tools/engine.ts`），构建产物 **14:45:00–14:45:02**，复核复跑 **14:49:56**（三项均复现同一结论）
> 全部命令逐条实测；本文件只记录**跑过的命令与真实输出**，不做「应该没问题」式推断。

## 0. 范围、边界与方法

**做**：类型检查 → 构建 → 产物字节级检查 → L1 离线验证 + 安装自检 → 组合树/manifest 只读核对 → npm 打包面核对。

**不做（硬边界，已遵守）**：
- 未重启 / 停止 / 修改 / 以任何方式干扰运行中的 DSH GUI（`http://127.0.0.1:19387`）及其 `desktop` profile；
- 未执行任何写 profile 的命令（如 `dsh plugin --profile ... add`）；所有 `dsh` 调用都是只读子命令；
- 未按 Captain 已核实的事实去试 `dsh --profile desktop --dump-config`（Electron 独占，必然失败）；
- 未修改任何其他成员的文件；本次只新增本文件。

**方法**：PowerShell 只用于**执行命令与收集输出**，从不做文本往返读写源码（API-CONTRACTS §6.1）；产物检查一律用 Node 脚本按字节/正则直接读文件；编码结论均来自字节级判定，不看控制台字形（§6.2）。

**原始日志（仓库外，可复核）**：`D:\DSH-Desktop\code-factory\.tmp-qa\t7-*.log` 与 `t7-*.out.txt`（含本文件所有输出的完整原文）。

**§6.3 纪律说明（先复核再上报）**：首次类型检查（14:14:49）为红色，位于 `src/runtime/` 与 `src/prompt/`。当时 t3（runtime-dev）仍 `in_progress`、正持续写这两个目录（`src/runtime/compat.ts` mtime 14:12:56、`src/prompt/member-brief.ts` 14:14:5x），按 §6.3 记录为**瞬时态**并复测；全部任务完成后再测两次（14:44:46 / 14:45:00 / 14:49:56）**全部 exit 0**。详见 §1.3。

---

## 1. 步骤 1 · 类型检查

### 1.1 host 程序

```console
$ pnpm exec tsc -p tsconfig.json --noEmit
（无任何输出）
exit 0
```

### 1.2 client 程序

```console
$ pnpm exec tsc -p tsconfig.client.json --noEmit
（无任何输出）
exit 0
```

两次独立复跑（14:45:00、14:49:56）结果一致：**两个程序 0 error，exit 0**。

### 1.3 §6.3 瞬时态记录（非缺陷指控，仅留痕）

14:14:49 的同一对命令输出（第二次，仍为红）：

```console
> dsh-code-factory@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit

src/prompt/member-brief.ts(322,10): error TS2304: Cannot find name 'missingHeadings'.
src/runtime/compat.ts(78,46): error TS2540: Cannot assign to 'factoryId' because it is a read-only property.
src/runtime/compat.ts(79,42): error TS2540: Cannot assign to 'stage' because it is a read-only property.
src/runtime/compat.ts(80,41): error TS2540: Cannot assign to 'role' because it is a read-only property.
 ELIFECYCLE  Command failed with exit code 2.
exit 2
```

同一命令在 14:12:2x 曾为 exit 0；14:12:56 起 runtime-dev 正在写上述两个文件。**结论：这是并行成员写盘期间的瞬时红，不是 t6/t7/t4 交付物的缺陷**。全部任务 completed 之后复测两次均为 exit 0（§1.1/§1.2），故不列为失败项。

---

## 2. 步骤 2 · 构建与产物检查

### 2.1 `pnpm build`

```console
$ pnpm build
> dsh-code-factory@0.1.0 build D:\DSH-Desktop\code-factory\dsh-code-factory
> tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown -c tsdown.config.ts

ℹ tsdown v0.22.2 powered by rolldown v1.1.5
ℹ config file: D:\DSH-Desktop\code-factory\dsh-code-factory\tsdown.config.ts
ℹ [dsh-code-factory/client] entry: lib/client/client/index.js
ℹ [dsh-code-factory/client] target: es2022
ℹ [dsh-code-factory/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [dsh-code-factory/client] Hint: consider adding deps.onlyBundle option to avoid unintended bundling of dependencies, or set deps.onlyBundle: false to disable this hint.
See more at https://tsdown.dev/options/dependencies#deps-onlybundle
Detected dependencies in bundle:
- @deepseek-ai/dsh-brand
ℹ [dsh-code-factory/client] lib\client.js      102.68 kB │ gzip: 26.05 kB
ℹ [dsh-code-factory/client] lib\client.js.map  137.41 kB │ gzip: 33.91 kB
ℹ [dsh-code-factory/client] 2 files, total: 240.09 kB
✔ [dsh-code-factory/client] Build complete in 29ms
exit 0
```

`Detected dependencies in bundle: @deepseek-ai/dsh-brand` 是**预期**的：dsh-brand 无 `dsh.client` manifest、shell 不注册它，官方 client bundle 也把它内联（证据见 §4.5），因此必须打包进来而不是 external（详见 §4.5 的规则讨论与缺陷 F1）。

### 2.2 必需产物

| 文件 | 字节 | 说明 |
|---|---|---|
| `lib/index.js` | 14351 | host 入口（`apply` / `name` / `inject` / `Config`） |
| `lib/index.d.ts` | 6850 | 上面的类型声明 |
| `lib/command.js` / `lib/command.d.ts` | 10056 / 5702 | `/factory` 斜杠命令 |
| `lib/client.js` | 102677 | 浏览器半部（closure-factory 包裹） |

`lib/` 完整宿主面（顶层 + 目录）：`index.js/index.d.ts/index.js.map`、`command.js/.d.ts/.map`、
目录 `domain/ prompt/ runtime/ shared/ store/ tools/ web/`，以及浏览器面产物 `client.js` + 中间产物目录
`client/`（tsdown 输入）。

> ⚠️ t18 删除了自定义会话事件词表之后，`lib/` 里**不再有**该模块的 `.js` / `.d.ts` / `.map`（`lib/client/`
> 同理）：原因见 API-CONTRACTS §1.7（写入自定义事件类型会让整个会话永久无法读取）。
> 注意 `tsc` 与 `tsdown` 都**不会**清理旧产物，删源文件时必须手工删 `lib/` 里对应的 `.js/.d.ts/.map`。

### 2.3 `lib/client.js` 首行 / 第二行 / 末尾（字节级，JSON 转义展示）

```text
line 1 : "window.__ModuleLoader__.load({"
line 2 : "\tid: \"dsh-code-factory\","
line 3 : "\tfactory: (require) => {"
倒数第 3 行(代码) : "\t\treturn module.exports;"
倒数第 2 行(代码) : "\t}"
倒数第 1 行(代码) : "});"
（其后为 "//# sourceMappingURL=client.js.map"）
```

判定（逐条）：
- 首行**精确等于** `window.__ModuleLoader__.load({` → `true`
- 第二行**精确等于** `\tid: "dsh-code-factory",` → `true`
- 去掉 sourcemap 注释后，最后三行**精确等于** `["\t\treturn module.exports;","\t}","});"]` → `true`
- `contains 'return module.exports;'` → `true`
- `exports.apply = apply;` 在第 2670 行、`exports.inject = inject;` 在第 2673 行（共 2686 行）→ 导出面齐备

### 2.4 ⭐ 致命项：bundle 的 `require()` 全集

对 `lib/client.js` 全文做 `\brequire\(\s*["']([^"']+)["']\s*\)` 抽取，去重计数：

```text
== every require("...") specifier in lib/client.js (set + count) ==
  react	1
  react/jsx-runtime	1
require specifiers total=2 offenders=[]
```

- **只有 `react` 与 `react/jsx-runtime`**，与 Captain 的判据完全一致；
- 全文**没有**任何 `require("@deepseek-ai/...")`：`externalized @deepseek-ai require in bundle: NONE`；
- 反向核对：`require()` 的 2 个 specifier 都在官方 client bundle 的前导 require 里出现过（§4.5），即 shell 确实提供 → **external 集合正确**。

### 2.5 打包进来的外部包（内联面）

`//#region` 标记（容忍缩进后）共 6 条：1 条指向 `node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4/node_modules/@deepseek-ai/dsh-brand/lib/index.js`，其余 5 条是我们自己的 `lib/client/client/*.js`。

```text
distinct inlined packages: @deepseek-ai/dsh-brand
dsh-brand: 4 occurrence(s)      brandString: 3 occurrence(s)
dsh-client-store: 0   dsh-client-ui-primitives: 0   dsh-client-ui-dockkit: 0
dsh-client-ui-slots: 1  → 第 2202 行，位于 JSDoc 注释内（"…and is extended by declaration merging."），无任何 ui-slots 代码
```

即：**除 dsh-brand 外没有内联任何 `@deepseek-ai/*` 包**；`src/client` 对 ui-slots / renderer / sidebar / session / locale / layout 的引用经核对全部是 `import type`（表格见 §4.5），编译后不进 bundle。

### 2.6 宿主半部：ESM 与浏览器专有全局

`lib/index.js`：

```text
  import statement count         : 13
  has 'require(' occurrences     : 0
  has 'module.exports'           : false
  has top-level export           : true
  export lines:
    export const name = 'code-factory';
    export const inject = ['tools','subagents','systemPrompt','agents','commands','webServer'];
    export const Config = z.object({
    export function apply(ctx, config) {
```

宿主图扫描（`lib/index.js` + 全部宿主 `.js`，**排除** `lib/client.js` 与 `lib/client/**`，共 33 个文件；先剥离 `//` 与 `/* */` 注释再匹配）：

| 浏览器专有 token | 命中 |
|---|---|
| `window` | **0** |
| `localStorage` / `sessionStorage` / `navigator` / `XMLHttpRequest` / `requestAnimationFrame` / `HTMLElement` / `HTMLStyleElement` | **0** |
| `document` | 6 处，全部是**字符串字面量**：`domain/pipeline.js` 的 78 / 202 / 285 / 353 / 411 / 476 行（`'document',` 与 `id: 'document',`，即流水线末阶段名） |

其余宿主 `.js` 里的 `window`/`document` 命中都在**浏览器半部**（`lib/client.js`、`lib/client/**`），属该半部正常运行环境。

### 2.7 宿主半部 import 面

```text
宿主半部 .js 文件: 33
相对 specifier: 48 —— 不以 .js 结尾的: []（全部合规，NodeNext 生效）
外部 specifier: 10
  @deepseek-ai/dsh-llm        -> command.js, runtime/members.js        (installed=true peerDependency=true)
  @deepseek-ai/dsh-subagent   -> runtime/compat.js                     (installed=true peerDependency=true)
  @deepseek-ai/dsh-tools      -> tools/captain.js, tools/member.js     (installed=true peerDependency=true)
  @deepseek-ai/schemastery    -> index.js                              (installed=true peerDependency=true)
  node:async_hooks / node:child_process / node:crypto×4 / node:fs / node:fs/promises / node:path×5
宿主半部 import 浏览器专有/客户端专有包: NONE
```

> 说明：`@deepseek-ai/cordis`、`dsh-session`、`dsh-agent` 等的引用是 `import type`，编译后被擦除，故不出现；它们仍在 `peerDependencies` 内。

---

## 3. 步骤 3 · L1 离线验证与安装自检

### 3.1 `node scripts/verify.mjs`（即 `pnpm verify`）

```console
$ node scripts/verify.mjs
dsh-code-factory - L1 offline verification
repo: D:\DSH-Desktop\code-factory\dsh-code-factory\
node: v24.12.0

--- A role registry & routing ---
  [ ok ] A1 the 12-job canonical registry self-audits clean
  [ ok ] A2 security job is security_eng; the prototype sec_eng spelling stays an alias
  [ ok ] A3 unknown roles do not exist anywhere in the pipeline
  [ ok ] A4 every task type ships a default roster that satisfies the iron triangle
  [ ok ] A5 routing every family brief yields the triangle + only registered members
  [ ok ] A6 the seven security triggers force a pinned security_eng
  [ ok ] A7 the roster cap holds and never cuts a triangle corner
  [ ok ] A8 trim order: perf > po > tech_writer first, last *_dev never

--- B pipeline integrity ---
  [ ok ] B1 all five templates self-audit clean
  [ ok ] B2 fullstack is the prototype 10-stage order, verbatim
  [ ok ] B3 stage ids unique, every stage staffed, every stage has a positive maxRounds
  [ ok ] B4 every failGoto targets an existing, strictly earlier stage of the same template
  [ ok ] B5 gate definitions inside the templates are structurally valid
  [ ok ] B6 every pipeline has a final DoD stage and one human approval gate
  [ ok ] B7 every stage of every template resolves to a real member under cap=8

--- C gate verdicts ---
  [ ok ] C1 checklist: a missing required section fails, a full set passes
  [ ok ] C2 keyword: the last conclusion line wins
  [ ok ] C3 composite: one failing child fails the whole gate
  [ ok ] C4 script gate: no evidence means needsExecution, injected result decides
  [ ok ] C5 dod gate follows the injected DoD results
  [ ok ] C6 gate verdicts are pure and total, and unsafe commands are rejected

--- D Definition of Done ---
  [ ok ] D1 the seven DoD items are defined and self-audit clean
  [ ok ] D2 with no evidence the audit invents nothing (only the skipped item passes)
  [ ok ] D3 full evidence turns the audit green, 7/7
  [ ok ] D4 the security-only item is skipped (not failed) without the security path

--- E store round-trip (throwaway temp workspace) ---
  [ ok ] E1 create -> load round-trips the whole record
  [ ok ] E2 save -> load persists the mutation and never rewinds updatedAt
  [ ok ] E3 mailbox append -> read round-trip, tri-state pending/delivered/read
  [ ok ] E4 a malformed JSONL line is skipped and survives rewrites verbatim
  [ ok ] E5 artifacts.json registry round-trips
  [ ok ] E6 path fences reject traversal, clobbering and escaping artifacts
  [ ok ] E7 atomic write leaves no temp file behind, archive/remove work
  [ ok ] E8 the temp workspace is cleaned up (no leftovers)

------------------------------------------------------------------
SUCCESS: 33/33 checks passed - L1 offline verification green
sections: A routing | B pipeline | C gates | D DoD | E store
subject: lib/domain/index.js + lib/store/store.js
exit 0
```

### 3.2 `pnpm run doctor:install`

```console
$ pnpm run doctor:install
> dsh-code-factory@0.1.0 doctor:install D:\DSH-Desktop\code-factory\dsh-code-factory
> node scripts/doctor.mjs

dsh-code-factory - installation doctor
repo: D:\DSH-Desktop\code-factory\dsh-code-factory\
node: v24.12.0
package: dsh-code-factory@0.1.0
  [ ok ] 1. node version satisfies engines.node
         node v24.12.0 against "^22.19.0 || >=24"
  [ ok ] 2. host bundle lib/index.js exists
         lib/index.js
  [ ok ] 3. web bundle lib/client.js exists
         lib/client.js
  [ ok ] 4. lib/client.js registers on window.__ModuleLoader__
         window.__ModuleLoader__.load({
  [ ok ] 5. dsh.bundle.patch target exists
         ./cordis.patch.yml (dsh.bundle.patch)
  [ ok ] 6. cordis.patch.yml name equals package.json name
         mounts "dsh-code-factory"
  [ ok ] 7. compatibility.json declares this plugin and a DSH target
         dsh 0.2.0-rc.2 · 17 packages
  [ ok ] 8. installed @deepseek-ai/* satisfy the declared versions
         17/17 packages match

------------------------------------------------------------------
SUCCESS: 8/8 installation checks passed (dsh-code-factory@0.1.0)
next: mount the bundle with `dsh plugin --profile <name> add <this package>`
exit 0
```

对照 t6 时的记录：第 2 项 `lib/index.js` 当时为 **FAIL**（t4 尚未交付 `src/index.ts`），现为 **OK** —— 与 Captain 的预期一致。

> ⚠️ 命令名：必须用 `pnpm run doctor:install`（或 `node scripts/doctor.mjs`）。裸 `pnpm doctor` 会被 pnpm 内建命令吞掉（t6 已实测并上报；M0 的 `"doctor"` 脚本名已改为 `"doctor:install"`，本次实测确认已修好，`pnpm run doctor:install` 正常 exit 0）。

---

## 4. 步骤 4 · 组合树与 manifest 一致性（全部只读）

### 4.1 `dsh` CLI（未做任何写 profile 的操作）

```console
$ dsh --version
0.2.0-rc.2
exit 0

$ dsh --profile web --dump-config
（stdout 1268 行；另有 1 条 stderr 警告，见下）
exit 0

$ dsh plugin --profile desktop ls
Legend: production dependency, optional only, dev only

dsh-profile-desktop C:\Users\15456\.dsh\profiles\desktop (PRIVATE)
│
│   dependencies:
├── @linxin666/dsh-client-ui-skill-explorer@0.4.5
├── @linxin666/dsh-client-ui-task-board@0.4.5
├── @linxin666/dsh-remote-web-ui@0.4.5
├── @michengai/dsh-agency-agents@1.0.11
├── @nanmicoder/dsh-agent-teams@0.1.22
├── billion-context@0.1.186
├── dsh-any-background@0.3.6
├── dsh-better-sidebar@0.25.0
├── dsh-whale-widget@0.3.18
├── dshmarket@1.66.9
└── oss-prompt-optimizer@1.9.0

11 packages
exit 0
```

`dsh --profile web --dump-config` 内容探针（对本次捕获的完整输出做计数，stdout+stderr 合并）:

| 探针 | 命中 |
|---|---|
| `code-factory` | 0 行 |
| `dsh-code-factory` | 0 行 |
| `insert` | 0 行 |
| `code-agent-teams` | 1 行（stderr 警告） |

stderr 原文（**与本插件无关**，是 web profile 自身的未安装依赖）：

```text
dsh: skipping profile bundle "code-agent-teams": Error: dsh: cannot resolve profile bundle "code-agent-teams" from the dsh installation or C:\Users\15456\.dsh\profiles\web; run 'dsh plugin --profile web install' if its dependency is not installed
```

**未验证 / 未尝试**：`dsh --profile desktop --dump-config`（Electron 独占，Captain 已核实必然失败）；`dsh plugin --profile desktop add`（写 profile，硬边界禁止）。因此**本插件挂到 desktop profile 的真实组合树不在本任务范围**，dump-config 只能证明 CLI 与组合树读取面正常（退出码 0，1268 行）。

### 4.2 `cordis.patch.yml` 结构（缩进解析，无 YAML 依赖）

```text
insert entries: 1
  id=code-factory (line 12)  name=dsh-code-factory  config={"stateDir":".code-factory","memberProvider":"spawn","maxMembers":"8","slashCommand":"true"}
any 'disabled:' key in patch: false
raw patch byte length: 1736
```

- `name=dsh-code-factory` == `package.json.name` → **`true`**
- `dsh.bundle.patch` = `./cordis.patch.yml`，文件存在 → **`true`**
- 无 `disabled:` → 挂载后是启用状态
- `config` 里的 4 个键都是 `Config` schema 的合法键（见 §4.3）

### 4.3 patch 配置 ↔ `Config` schema ↔ 运行时常量

`src/index.ts` 的 `Config`（z.object）逐条：

```text
Config.stateDir           = z.string().default(DEFAULT_STATE_DIR)
Config.memberProvider     = z.string().default(DEFAULT_MEMBER_PROVIDER)
Config.memberMaxDepth     = z.natural().default(0)
Config.maxMembers         = z.natural().min(1).default(DEFAULT_MAX_MEMBERS)
Config.promptSectionOrder = z.natural().default(CAPTAIN_PROTOCOL_ORDER)
Config.slashCommand       = z.boolean().default(true)
Config.feedLimit          = z.natural().default(DEFAULT_TOOL_FEED_LIMIT)
Config.allowNodeFallback  = z.boolean().default(false)

patch keys NOT in Config schema: NONE
Config keys NOT set by the patch (schema default applies): ["memberMaxDepth","promptSectionOrder","feedLimit","allowNodeFallback"]
Config interface fields == schema keys set-equal: true
```

跨层常量核对（`lib/domain`、`lib/store` 运行时取值）：

```text
patch maxMembers = 8            | domain DEFAULT_MAX_MEMBERS = 8            | equal=true
patch stateDir   = .code-factory| store  DEFAULT_STATE_DIR  = .code-factory| equal=true
patch id         = code-factory | plugin name export = code-factory
```

`memberMaxDepth` 的语义核对（patch 特意不写它，并留了长注释解释为什么不能写 `maxDepth: 0`）：

```text
代码里真正把 "maxDepth:" 传进请求的地方: 0 处
memberMaxDepth 的流向（静态）:
  src/index.ts:128  memberMaxDepth: z.natural().default(0)
  src/index.ts:156  memberMaxDepth: config.memberMaxDepth ?? 0   -> FactoryToolConfig
  src/index.ts:183  memberDepth: toolConfig.memberMaxDepth
  src/tools/engine.ts:1154 / 1320   memberDepth: call.config.memberMaxDepth
  src/runtime/tool-surface.ts:291   const memberDepth = input.memberDepth ?? 0
  src/runtime/tool-surface.ts:306   if (memberDepth < 1) candidates.push(...delegationCandidates)   // candidates 是“要拒绝”的名单
  src/runtime/compat.ts:433/454     const memberDepth = options.memberDepth ?? 0; if (depth !== undefined && depth > memberDepth) throw
```

即：`memberMaxDepth` 只作为**成员委派预算**（队长工具步骤准入 + 父链守卫）使用，从不作为 `SubagentStartRequest.maxDepth` 下发；patch 省略它 → 取默认 0 → 成员不能委派任何子代理，与代码注释一致。

### 4.4 `dsh.client.inject` 逐个包的真实性

```text
package.json dsh.client.inject (7):
  @deepseek-ai/dsh-client-locale          node_modules 存在? 是  version=0.2.0-rc.2  dsh.client 有  peerDep=true
  @deepseek-ai/dsh-client-ui-slots        node_modules 存在? 是  version=0.2.0-rc.2  dsh.client **无**  peerDep=true
  @deepseek-ai/dsh-client-ui-layout       node_modules 存在? 是  version=0.2.0-rc.2  dsh.client 有  peerDep=true
  @deepseek-ai/dsh-client-ui-conversation node_modules 存在? 是  version=0.2.0-rc.2  dsh.client 有  peerDep=true
  @deepseek-ai/dsh-client-ui-chat         node_modules 存在? 是  version=0.2.0-rc.2  dsh.client 有  peerDep=true
  @deepseek-ai/dsh-client-ui-sidebar-right node_modules 存在? 是 version=0.2.0-rc.2  dsh.client 有  peerDep=true
  @deepseek-ai/dsh-api-session-controller node_modules 存在? 是  version=0.2.0-rc.2  dsh.client 有  peerDep=true
```

「每个包名都在 node_modules/@deepseek-ai/ 下真实存在」→ **7/7 通过**。

### 4.5 ⭐ 交叉核对：inject vs tsdown 的 external 集合（含一次「查证后否定」）

Captain 给的判据是「inject 里列的包应当都是**声明了 `dsh.client`** 的包」。按这个判据，7 条里有 1 条不合：`@deepseek-ai/dsh-client-ui-slots` 的 `package.json` **完全没有 `dsh` 字段**，`files` 只有 `lib/index.js` 与 `lib/types/**/*.d.ts`（**不含** `lib/client.js`）。这看起来是一条**可疑缺陷**，于是我不止于此，继续取第二份独立证据 —— 官方 client bundle 到底 `require` 了谁：

对本项目 `node_modules` 里**全部 10 个自带 `lib/client.js` 的官方包**抽取 `require()` 并区分位置（工厂前导 vs 内联代码）：

```text
packages declaring dsh.client (10):
  @deepseek-ai/dsh-api-session-controller, dsh-client-connection, dsh-client-locale,
  dsh-client-ui-chat, -conversation, -layout, -renderer, -session, -sidebar, -sidebar-right   (platform 全为 web)

官方 client bundle 的 require()（**代码位置**；除 `dsh-client-ui-renderer` 第 88 行还有一处 `var h = require("react")` 的真实代码 require 外，其余全部位于工厂前导）：
  dsh-api-session-controller : @deepseek-ai/cordis, @deepseek-ai/dsh-api-gateway/client, @deepseek-ai/dsh-client-store
  dsh-client-connection      : （无）
  dsh-client-locale          : @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives, react, react/jsx-runtime
  dsh-client-ui-chat         : @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives, react, react-dom, react/jsx-runtime
  dsh-client-ui-conversation : @deepseek-ai/cordis, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives, **@deepseek-ai/dsh-client-ui-slots**, react, react-dom, react/jsx-runtime
  dsh-client-ui-layout       : @deepseek-ai/dsh-client-store, react, react/jsx-runtime
  dsh-client-ui-renderer     : @deepseek-ai/cordis, **@deepseek-ai/dsh-client-ui-slots**, react, react-dom, react-dom/client, react/jsx-runtime
  dsh-client-ui-session      : @deepseek-ai/cordis, @deepseek-ai/dsh-client-store, **@deepseek-ai/dsh-client-ui-slots**, react/jsx-runtime
  dsh-client-ui-sidebar      : @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives, **@deepseek-ai/dsh-client-ui-slots**, react, react/jsx-runtime
  dsh-client-ui-sidebar-right: @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-dockkit, @deepseek-ai/dsh-client-ui-primitives, react, react-dom, react/jsx-runtime
```

关键行（原文，含行号/总行数）：

```text
dsh-client-ui-renderer   line 14/1859 : let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
dsh-client-ui-session    line  9/499  : let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
dsh-client-ui-sidebar    line  8/536  : let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
dsh-client-ui-conversation line 31/18478: let _deepseek_ai_dsh_client_ui_slots = require("@deepseek-ai/dsh-client-ui-slots");
```

**结论（否定了一条候选缺陷）**：`@deepseek-ai/dsh-client-ui-slots` 虽然不声明 `dsh.client`，但**4 个官方 client bundle 在前导 import 里 `require` 了它** → shell 注册并可提供该模块 id → 我们的 `dsh.client.inject` 条目**合法且需要**（我们的 `export const inject = ['slots','locale','layout']` 里 `slots` 正是它提供的服务）。**这条不是缺陷，不需要改 inject。**

同时得到一条**真的**发现（见 §6 F1）：tsdown / API-CONTRACTS §2.2 表述的规则「shell 能 `require()` ⟺ 该包声明 `dsh.client`」是**低估**——至少 `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`、`dsh-client-ui-slots` 这 5 个 id 被官方前导 require 引用却没有 `dsh.client` manifest（另有 `dsh-client-ui-session` 声明了 manifest，但 API-CONTRACTS §2.2 的「9 个」清单里漏了它，实测是 10 个）。

对本产物的影响：**当前零影响** —— 我们 bundle 的 require 集合只有 `react` 家族（§2.4），唯一内联的 `@deepseek-ai/*` 是 dsh-brand（未被任何官方 bundle require，官方同样内联，§2.5）。但若将来有人把 ui-slots / store / primitives 改成**运行时** import（而非 `import type`），按现在的规则它们会被**内联**，从而产生「同一共享模块两份实例」的隐患。

方法学备注（避免误导）：对官方 bundle 直接做正则 `require()` 抽取会把注释里的示例代码算进来（`dsh-client-ui-sidebar-right` 里有 6 处 `* const picomatch = require('picomatch');` 出现在 JSDoc 注释中）。本报告只把**工厂前导位置的真实代码**作为 shell 提供的证据，`picomatch` 属注释噪声、已排除。

### 4.6 打包面（`npm pack --dry-run`，只读）

```console
$ npm pack --dry-run --json
name=dsh-code-factory version=0.1.0 files=134 tarballBytes=378006 unpackedBytes=1689259
exit 0
```

必需条目全部在包内：`lib/index.js` ✓、`lib/index.d.ts` ✓、`lib/client.js` ✓、`cordis.patch.yml` ✓、`compatibility.json` ✓、`package.json` ✓、`README.md` ✓、`README_ZH.md` ✓。目录前缀只有 `lib` + 5 个顶层文件；`src/`、`docs/`、`scripts/` 均不在包内（= `files[]` 白名单生效）。附带事实：包内含 48 个 `.map` 文件，以及 28 个 `lib/client/**` 中间产物（320922 字节），后者运行时用不到（只 `lib/client.js` 被加载）——见 §6 F2，纯卫生问题。

---

## 5. 三张清单

### 5.1 通过项（22 条，全部有真实输出支撑）

| # | 项 | 证据 |
|---|---|---|
| P1 | host 类型检查 0 error | §1.1 exit 0（复跑 3 次一致） |
| P2 | client 类型检查 0 error | §1.2 exit 0（复跑 3 次一致） |
| P3 | `pnpm build` exit 0 | §2.1 |
| P4 | 三个必需产物存在 | §2.2（8333 / 5319 / 102677 字节） |
| P5 | `lib/client.js` 首行 / 第二行 id / 末尾 `return module.exports;` | §2.3 四项判定全 true |
| P6 | bundle 导出 `apply` 与 `inject` | §2.3（2670 / 2673 行） |
| P7 | ⭐ 无任何 `@deepseek-ai/*` 被外部化 | §2.4 require 全集 = `react`,`react/jsx-runtime` |
| P8 | 仅 dsh-brand 被内联（符合官方做法） | §2.5 region 标记 + `brandString` |
| P9 | bundle 内无 ui-slots/store/primitives/dockkit 代码 | §2.5（ui-slots 仅 1 处注释命中） |
| P10 | `lib/index.js` 是 ESM | §2.6（13 import / 0 require / 0 module.exports） |
| P11 | 宿主图无浏览器专有全局 | §2.6（`document` 6 处均为阶段名字符串） |
| P12 | 宿主相对 import 全部带 `.js`；外部 import 均已声明且已安装 | §2.7 |
| P13 | 宿主半部不 import 客户端专有包 | §2.7（NONE） |
| P14 | `node scripts/verify.mjs` = 33/33，exit 0 | §3.1 |
| P15 | `pnpm run doctor:install` = 8/8，exit 0（第 2 项 FAIL→OK） | §3.2 |
| P16 | `dsh --version` / `--profile web --dump-config` / `plugin --profile desktop ls` 均 exit 0 | §4.1 |
| P17 | patch `name` == package `name`；`dsh.bundle.patch` 指向文件存在；`exports`/`files[]` 指向均存在 | §4.2、§4.6 |
| P18 | patch config 4 键 ⊆ Config schema 8 键（无未知键）；interface == schema | §4.3 |
| P19 | patch 值与 domain/store 常量一致（maxMembers 8、stateDir） | §4.3 |
| P20 | `dsh.client.inject` 7/7 在 node_modules 真实存在且都是 peerDependency | §4.4 |
| P21 | ⭐ inject 7 条**全部**是 shell 可 require 的模块（ui-slots 由 4 个官方前导 require 证实） | §4.5 |
| P22 | 全程未写 profile、未干扰运行中的 GUI | §0（本报告全部 `dsh` 调用均为只读子命令） |

### 5.2 失败项

**无阻断性失败项。** 两条非阻断发现（详见 §6），均不改变「本插件静态组装可用」这一结论：

- **F1（文档/规则精度，低-中）**：`tsdown.config.ts` 注释与 `docs/API-CONTRACTS.md` §2.2 的「shell 可 require ⟺ 声明 `dsh.client`」是低估，且 §2.2 的「本机实测有 9 个」实为 10 个（漏 `dsh-client-ui-session`）。当前产物零影响，属**潜在**隐患 + 文档事实错误。
- **F2（打包卫生，低）**：npm 包内含 28 个 `lib/client/**` 中间产物与 48 个 sourcemap（合计约 320 KB 中间产物），运行时均不需要。

### 5.3 未验证项（含原因）

| # | 未验证内容 | 原因 / 需要什么 |
|---|---|---|
| U1 | 真实 GUI 里 `lib/client.js` 被 `__ModuleLoader__` 加载、`inject` 全部满足、面板真的渲染出来 | 硬边界禁止干扰运行中的 GUI；需 Captain 按 `docs/E2E-ACCEPTANCE.md` 在同一用户确认后单独安排 |
| U2 | shell 对 `dsh.client.inject` 里「未注册 id」的容错行为（即：inject 写错会不会激活失败） | 只能由真实加载器验证；本例 7 条都可满足，故不影响本产物（与 F1 的建议相关） |
| U3 | desktop profile 的真实组合树（patch 挂载、Config 校验、`insert` 生效） | `dsh --profile desktop --dump-config` 为 Electron 独占（Captain 已核实）；`dsh plugin --profile desktop add` 写 profile，禁止 |
| U4 | `/factory` 命令、`factory_*` 工具、子代理 spawn/fork 的真实运行时行为 | 运行时 e2e 不在 t7 范围 |
| U5 | 门禁真实执行脚本 / DoD 七条在真实仓库上的判决 | 同上（L1 只覆盖纯判定层） |
| U6 | 「成员不能委派」在运行时确实被守卫拦住（`memberDepth=0`） | 静态证据充分（0 处 `maxDepth:` + `tool-surface.ts:306` deny 规则），但真跑一次才能确认 |
| U7 | 从 npm 包安装到干净 profile 后 doctor 是否 8/8 | 未做真实安装（会写 profile）；只做了 `npm pack --dry-run` 的打包面核对 |
| U8 | `lib/client/**` 中间产物与 sourcemap 对发布的实际影响 | §4.6 只测了「在不在包里」，没有测消费侧影响 |

---

## 6. 缺陷清单

### F1（低-中，文档/规则精度）shell 可 require 集合的判据低估

- **文件**：`tsdown.config.ts`（第 20-41 行注释与 `shellClientModules()`）、`docs/API-CONTRACTS.md` §2.2（第 412-431 行）。
- **事实**：二者断言「shell 能 `require()` 的包 ⟺ 该包 manifest 声明了 `dsh.client`」，并称本机实测 9 个。实测（§4.5）：
  - 官方 client bundle 的**前导 require** 里还出现 5 个**不声明** `dsh.client` 的 id：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`、`@deepseek-ai/dsh-client-ui-slots`；
  - 声明 `dsh.client` 的包是 **10 个**，不是 9 个（漏列 `@deepseek-ai/dsh-client-ui-session`）。
- **影响**：**当前无影响**。我们的 bundle require 集合只有 `react` 家族，唯一内联的 `@deepseek-ai/*` 是 dsh-brand（官方同样内联、无 bundle require 它）。隐患方向是「把 shell 已提供的共享模块**内联**成第二份实例」——只要有人把 ui-slots/store/primitives 从 `import type` 改成运行时 import，现在的规则就会内联它们（多份 slot registry / store 实例），而不是 require shell 的那一份。
- **建议修法（二选一或同时）**：
  1. 把 `shellClientModules()` 的判据从「声明 `dsh.client`」扩成「声明 `dsh.client` ∪ 官方 client bundle 前导 require 观测集合」（观测集合可像本次一样从 `node_modules/@deepseek-ai/*/lib/client.js` 的前导区算出）；
  2. 构建后加一条断言：`lib/client.js` 的 require 全集 ⊆ 观测集合，且「被内联的 `@deepseek-ai/*` 包 ∩ 观测集合 = ∅」，任一不满足即让 `pnpm build` 失败（这正是本次人工做的检查，值得固化）。
  3. 顺手把 §2.2 的「9 个」更正为 10 个并补 `dsh-client-ui-session`。
- **不修也不影响本次验收**；但 2 和 3 成本极低、收益明确。**我未改任何非本任务文件。**

### F2（低，打包卫生）发布的包内含运行时不用的中间产物

- **事实**：`npm pack --dry-run` 显示 134 个文件里有 28 个 `lib/client/**`（tsc 的浏览器面中间产物，320922 字节）与 48 个 `.map`；运行时只有 `lib/client.js` 会被 shell 加载。
- **影响**：仅体积/噪音，无功能影响（`files[]` 白名单已排除 `src/`、`docs/`、`scripts/`）。
- **建议**：如要瘦身，可在 `files` 里改成显式列举必要文件（或发布前删 `lib/client/**`），但需确认 tsdown 的 `entry: lib/client/client/index.js` 不依赖发布包内容（它只在构建时需要）。**未修改。**

### 已查证并**否定**的候选缺陷（留痕，避免重复上报）

- **候选**：`dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-slots`，而该包不声明 `dsh.client` → 疑似无效 inject 条目。
- **否定证据**：4 个官方 client bundle 在工厂前导位置 `require("@deepseek-ai/dsh-client-ui-slots")`（renderer:14/1859、session:9/499、sidebar:8/536、conversation:31/18478）→ shell 确实注册该 id；我们的 `inject = ['slots','locale','layout']` 里 `slots` 正由它提供。**保留该条目，不要删。**

---

## 7. 复现方式

```console
# 步骤 1
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.client.json --noEmit

# 步骤 2
pnpm build
# 产物检查（本报告用的脚本，仓库外）
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-artifacts.mjs      # 首行/id/末尾/require 全集/ESM
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-artifacts2.mjs     # 注释剥离后的宿主图/import 面
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-hostglobals.mjs    # 宿主图浏览器全局（精确口径）
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-regions.mjs        # 内联了哪些包

# 步骤 3
node scripts/verify.mjs
pnpm run doctor:install        # 注意：不要用裸 pnpm doctor

# 步骤 4（全部只读）
dsh --version
dsh --profile web --dump-config
dsh plugin --profile desktop ls
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-step4.mjs          # 半部拆分/inject/manifest 一致性
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-step4b.mjs         # dump-config 探针 + Config schema
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-step4c.mjs         # patch 结构 + 常量跨层核对
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-shell-provides.mjs # 官方 bundle require 全量（shell 提供面）
node D:\DSH-Desktop\code-factory\.tmp-qa\t7-require-context.mjs# require 位置（前导 vs 内联）
npm pack --dry-run --json
```

> `.tmp-qa\` 在仓库外，属一次性取证明细（域脚本 `t7-*.mjs` + 原始日志 `t7-*.log/.out.txt`），任务结束后可整体删除；本文件保留了所有结论所需的原始输出。
