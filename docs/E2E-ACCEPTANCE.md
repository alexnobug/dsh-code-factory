# 运行时端到端验收规程（E2E Acceptance）

> **用途**：把 dsh-code-factory 装进**真实 DSH**，逐条判定"它到底能不能跑"。
> 本文是**动手前的检查单**，不是功能介绍；每一步都给：操作 / 预期观察 / 判定依据 / 失败取证。
>
> **事实来源**：本文所有命令都在本机实测过（`dsh 0.2.0-rc.2`、profile `desktop`、GUI
> http://127.0.0.1:19387），或来自 `docs/API-CONTRACTS.md`（已核实契约）、`src/`（代码真源）。
> 凡**未实测**的步骤都在第 6 节集中标为 **UNCONFIRMED**——那些地方请先查证再动手，不要照抄。
>
> ⚠️ 读文件一律用 UTF-8 方式（见 §4.3）：本机 PowerShell 5.1 的 `Get-Content` 默认按 ANSI 解码，
> 会把正常的 UTF-8 显示成乱码。**不要据此判断文件损坏。**

---

## 0. 现状门槛（截至本次刷新：可以进入第 2 节）

本项目早期的验证**全是离线的**（双 program 类型检查 / 打包 / `scripts/verify.mjs` / headless 渲染 /
文档↔代码比对）。此后已在 **headless profile**（`dsh factory-rehearsal`）里实测过插件激活与
`factory_plan` 真实落盘（见 `docs/VERIFICATION.md`），但**从未在带 GUI 的 `desktop` profile 里安装过**。
装进 `desktop` 会改写用户正在使用的 profile，并且必须重启 GUI 才生效——这仍是本项目不可逆风险最高的一步。

**门槛表（全部满足才进入第 2 节；缺任何一条，做了也会失败）：**

> ⚠️ 下表是**本次刷新（t24）的快照**。安装前请逐条复跑判定命令；其中绝大多数数字与工具实测
> 由 `node scripts/check-docs.mjs` 强制对齐（它住在仓库里，会把不一致报成 `file:line`）。

| # | 门槛 | 判定命令（在仓库根 `dsh-code-factory\` 下跑） | 本次快照（须复跑） |
|---|---|---|---|
| G1 | 宿主入口已落地：`src/index.ts` 存在并产出 `lib/index.js` | `pnpm run doctor:install` → 第 2 项 `host bundle lib/index.js exists` 必须是 OK（即 **9/9**） | ✅ **已满足**：实测 **9/9**，exit 0 |
| G2 | 构建链路绿 | `pnpm build` → exit 0；`lib/index.js` 与 `lib/client.js` 都存在 | ✅ exit 0；两个产物均存在 |
| G3 | 离线验证绿 | `node scripts/verify.mjs` → `SUCCESS: 103/103` | ✅ `SUCCESS: 103/103`，exit 0（A–J 十个分区） |
| G4 | `factory_*` 工具已注册（`src/tools/` 落地并接线） | 会话里能看到/调用 `factory_plan` | ✅ `src/tools/`（5 模块，16 个 `defineTool`：13 队长 + 3 成员）已接线到 `src/index.ts`；headless profile 实测可调用 |
| G5 | 状态路由已注册（`src/web/` 落地并接线，路径 `/plugins/code-factory/state`） | 对**磁盘上确实存在的** factoryId 请求 `?id=` 必须得到 200 + 快照 | 🟡 **代码就绪、待现场判定**：`src/web/{routes,snapshot}.ts` 已落地并接线；本机 desktop 未安装插件，所以 19387 上仍是 404（**未安装 ≠ 未实现**），安装后按 §3 场景 8 判定 |
| G6 | 成员运行时可用（`src/runtime/` 落地：唤醒 / 门禁执行器 / 调度） | 批准后成员能被子代理唤醒（`members[].sessionId` 非空） | 🟡 **离线已覆盖、真实 spawn 待现场**：headless harness 已跑通 spawn → 投递 → 报告 → 回收；**带真实子代理的端到端正是本次验收要做的事** |

**结论：门槛已可进入第 2 节**（G1–G4 已满足；G5/G6 的现场判定本来就是本次验收的第一个动作）。
建议顺序：**先按 §2.0 在隔离 profile 上跑一遍**（零风险，能覆盖 G5/G6 与全部 10 条场景），
确认无问题后再碰 `desktop`。

---

## 1. 前置条件与风险声明

### 1.1 环境事实（本机实测）

| 项 | 值 | 来源 |
|---|---|---|
| DSH 核心 | `0.2.0-rc.2` | `dsh --version` |
| dsh CLI | `D:\DeepSeek Harness Desktop\resources\runtime\cli\bin\dsh.cmd` | `where.exe dsh` |
| 目标 profile | `desktop`（**由 Electron 应用独占管理**，见 §2.3） | `dsh --profile desktop --dump-config` 的报错 |
| GUI | http://127.0.0.1:19387 | 运行环境（`DSH_WEB_URL`） |
| `DSH_HOME` | `C:\Users\15456\.dsh` | 环境变量 |
| `DSH_PROFILE_DIR` | `C:\Users\15456\.dsh\profiles\desktop` | 环境变量 |
| Node / pnpm | v24.12.0 / 10.32.1（pnpm 内建版本 11.7.0） | `node --version` / `pnpm --version` / `dsh plugin --profile desktop --help` |
| 插件包 | `dsh-code-factory`（bundle patch：`cordis.patch.yml`） | `package.json` |

### 1.2 安装会改什么（不可逆风险清单）

在 `C:\Users\15456\.dsh\profiles\desktop\` 下：

| 文件 / 目录 | 变化 |
|---|---|
| `package.json` | `dependencies` 增加 `dsh-code-factory`；**`dsh.profile.bundles` 必须出现该包名才会被挂载**（见 §2.2 注意） |
| `pnpm-lock.yaml` | 依赖树变化（本地路径依赖会写入 link/file 协议） |
| `node_modules/` | 新增/更新目录 |
| `cordis.patch.yml` / `cordis.yml` | 组合层与合成结果可能被应用重写 |
| `.dsh-market/` / `.plugin-manager/` | 应用自己的插件登记与操作日志（含 `logs/operation-*/pnpm.log`） |

**必须重启 GUI**：host 半部的插件在应用启动时装载，仅刷新浏览器页面**不会**加载宿主插件。
（client 半部只有在开发 watcher 在跑时才可能免刷新；生产安装请按重启处理。）

### 1.3 安全纪律（先读再动手）

1. **先隔离预演，再碰 desktop**（§2.0）。任何"看起来没问题"的判断都必须先在隔离 profile 上验证一遍。
2. **验收工作区必须是 scratch 目录**（例如 `D:\DSH-Desktop\code-factory\.e2e-workspace`），
   绝不要在真实项目目录里跑——成员会**真的写文件**（PRD.md / tests/ / start.sh …）。
3. **任何一步失败立即回滚**（§2.4），不要试图在用户的活动 profile 上就地修。
4. 全程**不要把 `/plugins/code-factory/state` 暴露到不可信网络**：该路由不继承 Connection 的鉴权围栏
   （API-CONTRACTS §1.5），只允许本机访问。

---

## 2. ⭐ 备份与回滚

### 2.0 先隔离预演（零风险，强烈推荐）

目的：在**不碰 desktop、不重启用户 GUI** 的前提下把"能不能加载"验一遍。

#### 2.0.1 自动化预演（先跑这个——它不碰你的家目录）

```powershell
cd D:\DSH-Desktop\code-factory\dsh-code-factory
pnpm run smoke:load
```

`scripts/load-smoke.mjs` 把 §2.0.2 的手工流程自动化，并且在**一次性 `DSH_HOME`** 里做：
用 CLI 从 `headless` 模板实体化一个临时 profile → 用真实插件管理器把本仓库以 `link:` 装进去 →
以真实 Cordis 加载器启动一次 → 断言每个 `factory_*` 工具**真的出现在活的工具注册表里**
（名字从 `src/runtime/tool-surface.ts` 读，不是手抄的）。

最后一步（阶段 F）再做一件 `link:` 覆盖不到的事：`npm pack` 出**真正的发布产物**，把那个
`.tgz` 装进第二个一次性 profile，然后断言它是**实体化拷贝而不是指回本仓库的链接**——
产物只带 `files[]` 里的东西、没有 `src/`、也解析不回 checkout。A–E 阶段装的是工作树，
所以它们全绿并不能说明用户装到的是什么。

它全程离线，`~/.dsh` 只读不写，临时目录在 `finally` 里清理，并且自带"插件缺失时必须变红"
与"产物混进 `src/` 时必须变红"的注入证据。

它**不能**替代 §2.0.2：这条证明的是"插件装得上、工具注册得到"，面板渲染与真实工作区
仍然要靠手工那一遍。

#### 2.0.2 手工预演（确实要碰 profile 时按这个来）

**不要直接对 `web` 或 `desktop` 动手**——它们是用户环境的一部分，装进去会留下真实的
`node_modules/`、`cordis.yml` 与插件登记。先实体化一个一次性 profile：

```powershell
# 1) 从模板建一个一次性 profile（只创建，不启动）
dsh --profile factory-dryrun --from-default-profile web
# 2) 把插件装进那个一次性 profile
dsh plugin --profile factory-dryrun add D:\DSH-Desktop\code-factory\dsh-code-factory
# 3) 只读校验组合树：必须出现 code-factory 行，且 name 为 dsh-code-factory
dsh --profile factory-dryrun --dump-config | Select-String -Pattern 'code-factory' -Context 2,2
# 4) 用另一个端口起一个独立 GUI（不影响 19387）
dsh --profile factory-dryrun --port 8099 --no-open
# 5) 验收完把它删掉，不要留着
```

- 预演也要先备份（一次性 profile 同样是用户环境的组成部分）：把下面的 `desktop` 换成
  `factory-dryrun` 即可。
- 预演能覆盖：装载、工具注册、staged 规划、斜杠命令、成员唤醒、门禁、DoD、状态路由、面板渲染。
- 预演**不能**覆盖：desktop 特有的其它插件共存冲突、用户实际工作区、以及"应用独占管理器"的安装路径差异。
- **已确认**（原先这里是 UNCONFIRMED）：`dsh --profile <新名> --from-default-profile <模板名>`
  就是"只创建不启动"，上面第 1 步可以直接照抄；§2.0.1 的自动化预演也依赖这一点。
  可用模板：`acp` / `headless` / `sdk` / `sdk-minimal` / `web`——本插件需要 `subagents`，
  而 `sdk-minimal` 太薄（会停在下发 `service: subagents`），所以要手工预演就用 `web`，
  自动化预演固定用 `headless`。

### 2.1 备份（逐条可复制）

**用仓库自带的工具，不要手写拷贝。** 手写拷贝正是 B4 的成因：它产出了 5 个文件、**没有 manifest、
没有任何校验和**，落在 runbook 声称的目录之外，而且没人能发现「备份当时就已经是错的」。

```powershell
cd D:\DSH-Desktop\code-factory\dsh-code-factory
node scripts/profile-backup.mjs backup --profile desktop --into D:\DSH-Desktop\code-factory\.e2e-backups
```

它写出一个带封印的目录：

| 内容 | 说明 |
| --- | --- |
| `payload/` | `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，以及 `.dsh-market/` 与 `.plugin-manager/`（registry 全量 + `logs/` 最近 20 份） |
| `manifest.json` | 每个文件的 `{path, bytes, sha256, mtimeMs}` |
| `manifest.sha256` | **对 manifest 本身的封印**（先验封印、再比文件） |
| `plugin-ls.txt` | 备份时刻 `dsh plugin --profile desktop ls` 的原始输出 |
| `hashes-before.txt`、`manifest-before.txt` | 老 runbook 点名的两个清单，保留兼容 |

回滚步骤、校验顺序的理由、以及「还没做的那一半」，见仓库根目录的 **[`ROLLBACK.md`](../ROLLBACK.md)**
（该文件随包发布，所以装着插件的人手里也有）。

**`node_modules/` 要不要一起备份？** 不需要整棵树（体积大、耗时长），工具刻意不备份它。
只要 `package.json` + `pnpm-lock.yaml` 在，回滚后用 `dsh plugin --profile desktop install` 就能同步回原状
（该用法由 dsh CLI 自己的报错信息给出："run 'dsh plugin --profile <name> install' if its dependency is not installed"）。
只有在"离线且必须字节级一致"的极端情形下才整树拷贝（`$prof\node_modules` 可能上百 MB）——那种情形请手工拷贝，
并自行记录哈希；工具不会替你做，也不会假装做了。

**小抄**：应用自己也会在每次插件操作时留 `.bak-<ISO 时间戳>` 文件（本机实测存在
`package.json.bak-2026-10-10T13-17-42-223Z` 等 3 对），可作为**第二来源**，但它**不能替代**你的备份
（它只覆盖应用操作过的文件，不覆盖时间窗与 `.dsh-market/` 状态）。

### 2.2 安装

```powershell
cd D:\DSH-Desktop\code-factory\dsh-code-factory
pnpm build                  # 必须 exit 0，并产出 lib/index.js + lib/client.js
pnpm run doctor:install     # 必须全绿（9/9）；任何一项失败 → 立即停手，不要安装

# 装进 profile：dsh 的 plugin 子命令是 pnpm 直通（实测 dsh plugin --profile desktop ls 可跑通）
dsh plugin --profile desktop add D:\DSH-Desktop\code-factory\dsh-code-factory
```

⚠️ **两个必须人工确认的点（UNCONFIRMED）**：

1. `add` 只是 pnpm 直通，**未必**会把包名写进 `dsh.profile.bundles`——而只有 bundles 里的条目才会被挂载。
   装完请读一次 profile 的声明面确认：

   ```powershell
   [System.IO.File]::ReadAllText("$env:DSH_PROFILE_DIR\package.json", [System.Text.Encoding]::UTF8)
   ```

   需要同时看到：`dependencies` 里有 `dsh-code-factory`，且
   `"dsh": { "profile": { "bundles": [ … , "dsh-code-factory" ] } }` 里也有它。
   若缺后者，优先用**应用自己的插件管理入口**（GUI）安装；**不要**让模型手改 JSON——
   真要手改，必须先按 §2.1 备份，并只加这一行。
2. `pnpm add <本地目录>` 生成的协议（`link:` 还是 `file:`）取决于 pnpm 语义，请以 `package.json` 实际内容为准。

### 2.3 挂载校验（只读）

```powershell
# A) profile 里确实登记了（pnpm ls 直通，实测可用）
dsh plugin --profile desktop ls | Select-String -Pattern 'code-factory'
#    → 期望看到 dsh-code-factory@0.1.0 之类的行

# B) ⚠️ desktop 的 --dump-config 被应用独占，不可用（实测报错）
dsh --profile desktop --dump-config
#    → error: profile "desktop" is managed exclusively by the Electron application（exit 1）
#    这是预期行为，不是故障：desktop 的组合树请在 GUI 里看，或改用隔离 profile：
#    dsh --profile web --dump-config | Select-String -Pattern 'code-factory' -Context 2,2
```

desktop 的挂载判定改为**三条独立信号**（全部满足才算挂载成功）：

1. GUI 的插件列表里出现 `dsh-code-factory`（应用自己的登记面）；
2. 重启后在会话输入框敲 `/` 能看到 `factory` 命令（`src/command.ts` 注册面）；
3. 会话里能调用 `factory_plan`（`src/tools/` 注册面，G4 满足后）。

### 2.4 回滚（完整卸载）

执行顺序和理由写在仓库根的 **[`ROLLBACK.md`](../ROLLBACK.md)**；下面是本机的一次具体展开。

```powershell
cd D:\DSH-Desktop\code-factory\dsh-code-factory
$backup = 'D:\DSH-Desktop\code-factory\.e2e-backups\desktop-<stamp>'   # §2.1 产出的目录
$prof   = "$env:DSH_HOME\profiles\desktop"

# 0) 先彻底退出 DSH Desktop（见 UNCONFIRMED #6：确认托盘进程也退出），再执行下面步骤

# 1) 备份必须先过校验 —— 工具会拒绝校验不过的备份，这一步是给操作者看的
node scripts/profile-backup.mjs verify $backup

# 2) 卸载依赖（pnpm rm 直通：从 dependencies 与 node_modules 移除）
dsh plugin --profile desktop remove dsh-code-factory

# 3) 用备份覆盖回去（package.json 会连同 dsh.profile.bundles 一起恢复）
#    默认是干跑；确认列出的文件无误后加 --apply
node scripts/profile-backup.mjs restore $backup --into $prof
node scripts/profile-backup.mjs restore $backup --into $prof --apply

# 4) 按恢复后的锁文件同步 node_modules
dsh plugin --profile desktop install

# 5) 重启 GUI，确认一切如常
```

⚠️ `restore` **只覆盖备份里有的文件，不删除备份里没有的文件**。回滚不是「把目录变回那一刻」，
而是「把那一刻已知的内容放回去」。多出来的文件由 §2.5 的 `compare` 报出来，人工确认后再删。

### 2.5 回滚后自证已恢复

```powershell
cd D:\DSH-Desktop\code-factory\dsh-code-factory
$backup = 'D:\DSH-Desktop\code-factory\.e2e-backups\desktop-<stamp>'
$prof   = "$env:DSH_HOME\profiles\desktop"

# 备份自身仍然完好（封印 + 逐文件哈希）
node scripts/profile-backup.mjs verify $backup

# 活动 profile 现在与备份逐字节一致；多出来的文件也会被点名
node scripts/profile-backup.mjs compare $backup --against $prof

# 依赖面已无插件残留
dsh plugin --profile desktop ls | Select-String -Pattern 'code-factory'     # 期望：无输出

# 组合树不再挂载（隔离 profile 场景才有 --dump-config 可用）
dsh --profile web --dump-config | Select-String -Pattern 'code-factory'     # 期望：无输出
```

四条全绿才算恢复：**备份可校验 + profile 与备份一致 + 依赖面干净 + 组合树无条目**。
任何一条不满足 → 继续排查，不要开始第二次安装。

### 2.6 纪律

> **任何一步失败都应立即回滚（§2.4），不要在用户的活动 profile 上就地试修。**
> 就地修的风险是把"一个可回滚的改动"变成"一堆无法归因的改动"，并让哈希自证失效。

---

## 3. 验收场景清单（10 条，按依赖顺序）

统一约定：

- **工作区**：先把一个 scratch 目录作为会话工作区（例如 `D:\DSH-Desktop\code-factory\.e2e-workspace`），
  工厂状态会落在 `<工作区>\.code-factory\<factoryId>\{factory.json, artifacts.json, inbox\*.jsonl}`。
- **状态读取**（所有场景共用）：

  ```powershell
  $ws = 'D:\DSH-Desktop\code-factory\.e2e-workspace'
  $fj = Get-ChildItem "$ws\.code-factory\*\factory.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $s  = [System.IO.File]::ReadAllText($fj.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $s.id; $s.phase; $s.taskType; $s.pipeline; $s.securityTriggered
  $s.members | Select-Object role, status, sessionId, spawnError
  $s.stages  | Select-Object id, status, round, attempts
  $s.dod     | Select-Object id, label, ok, evidence
  ```

- **前提**：每条场景都标了它需要哪些门槛（G1…G6，见第 0 节）。G 未满足时该条**跳过并记"阻塞"**，
  不要记成"失败"。

### 场景 1 —— 加载（前置：G1、G2）

- **操作**：装好后**完全退出并重启 DSH Desktop**；打开 GUI；在会话里随便问一句。
- **预期观察**：GUI 正常出现（不是白屏）；没有插件激活错误；`/` 列表里有 `factory`。
- **判定依据**（全部满足才算通过）：
  1. `cd D:\DSH-Desktop\code-factory\dsh-code-factory; pnpm run doctor:install` → **9/9**（第 2 项
     `host bundle lib/index.js exists` OK）；
  2. 浏览器 DevTools Console 无红色错误、无 "plugin failed / cannot resolve profile bundle" 字样；
  3. 会话可用（能正常收发一条消息）。
- **失败取证**：DevTools Console 全量截图；`dsh plugin --profile desktop ls` 输出；
  `$env:DSH_PROFILE_DIR\.plugin-manager\logs\operation-*\pnpm.log` 最新一份；回滚（§2.4）。

### 场景 2 —— staged 规划（前置：G1、G4）

- **操作**：在工作区会话里说：`用 code-factory 做一个带登录的电商后端`（或 `/factory 带登录的电商后端`）。
- **预期观察**：模型调用 `factory_plan`，回报 **任务类型**（这里应为 `api_only` 或 `web_fullstack`）、
  **团队编制**（含 `pm`、`qa`、至少一名 `*_dev`；命中"登录"→ 必须含 `security_eng`）、
  **阶段顺序**与每阶段门禁；**此时不创建任何子会话**。
- **判定依据（关键断言：零子会话）**——三条同时成立：

  ```powershell
  # ① 磁盘状态：phase 仍为 staged，成员没有任何 sessionId，阶段全未开始
  $s.phase                                  # 期望 'staged'
  ($s.members | Where-Object sessionId).Count   # 期望 0
  ($s.stages  | Where-Object status -ne 'pending').Count  # 期望 0
  $s.approvedAt                             # 期望为空/null

  # ② 会话存储：没有新增会话目录（每个会话 = $DSH_HOME\sessions\<工作区slug>\<sessionId>\ 一个目录）
  $slug = (Get-ChildItem "$env:DSH_HOME\sessions" -Directory | Where-Object Name -like '*e2e-workspace*').FullName
  (Get-ChildItem $slug -Directory).Count    # 与触发前记录的计数比较，期望不变
  ```

  ③ 界面上子代理/成员列表为空。
- **失败取证**：`factory.json` 全文 + 触发前后两次会话目录列表（`Get-ChildItem $slug -Directory | Select Name`）
  + 该轮工具调用截图。

### 场景 3 —— 斜杠命令（前置：G1、G4）

- **操作**：在输入框敲 `/`，选中 `factory`，输入 `/factory 给脚本加个批量重命名功能` 回车。
- **预期观察**：命令被直接执行（不是把 `/factory ...` 当普通聊天发给模型）；随后**恰好一轮**普通回合被排队，
  内容 = 目标原文 + 一段"先 staged 规划、等批准"的协议文本；命令结果卡显示激活成功文案。
- **判定依据**：① 命令发现列表里有 `factory`；② 目标文本出现在会话流中；③ 该轮回合里模型**先规划**，
  不出现 `factory_approve`、不出现任何子会话（复用场景 2 的断言）。
- **失败取证**：命令结果卡与随后的第一条助手回复截图；Console 错误；`factory.json`。

### 场景 4 —— 批准开工（前置：G1、G4、G6）

- **操作**：明确回复"批准/开始"（或按面板上的批准动作）。
- **预期观察**：`factory_approve` 被调用；成员被真正唤醒（每个成员一个 durable 子代理会话）；
  阶段 1 变 active，界面 LED/阶段芯片随之变化。
- **判定依据**：

  ```powershell
  $s.phase                                    # 期望 'running'
  $s.approvedAt                               # 有值
  ($s.members | Where-Object { $_.sessionId }).Count   # 期望 = 编制人数（>0）
  $s.members | Where-Object spawnError         # 期望为空：任何 spawnError 都算失败
  ($s.stages | Where-Object status -ne 'pending').Count  # 期望 >= 1（至少第 1 阶段 active/passed）
  ```

  并从 `$DSH_HOME\sessions\<slug>\` 观察到**新增会话目录数 = 成员数**（这是"真唤醒"的独立旁证；
  两者数量不一致时以 `factory.json` 的 `sessionId` 为准并记取证）。
- **失败取证**：`members[].spawnError` 逐条抄录；`$slug` 下会话目录列表；工具返回原文；Console 错误。

### 场景 5 —— 成员真干活（前置：G1、G4、G6）

- **操作**：让第 1 阶段（`requirement`，角色 `pm`）跑完。
- **预期观察**：工作区出现**真实文件**（例如 `PRD.md`）；`artifacts.json` 登记了它；
  文件 mtime 晚于派发时刻。
- **判定依据（区分"真写"与"模型自称写了"）**——只认磁盘，不认汇报文本：

  ```powershell
  $prd = "$ws\PRD.md"
  Test-Path $prd                       # 必须 True
  (Get-Item $prd).LastWriteTime        # 必须晚于阶段派发时间
  (Get-Item $prd).Length               # 必须 > 0，且与 artifacts.json 里的 bytes 一致
  [System.IO.File]::ReadAllText($prd, [System.Text.Encoding]::UTF8).Substring(0, 200)
  ```

  **反例控制（必做）**：把 `PRD.md` 临时改名（`Rename-Item $prd prd.bak`），然后请队长再跑一次该阶段门禁——
  门禁必须判 **fail**。这一步证明"判定读的是磁盘"，而不是成员的自我汇报；验完把文件改回来。
- **失败取证**：目录清单（`Get-ChildItem $ws -Recurse | Select FullName, Length, LastWriteTime`）、
  `artifacts.json` 全文、成员 `factory_report` 原文（若汇报了什么但磁盘没有，直接判 fail）。

### 场景 6 —— 门禁真实拦截（前置：G1、G4、G6）

- **操作**：故意破坏一个门禁输入。最快的一招：删掉 `PRD.md` 里某个必备标题
  （`背景与目标` / `用户故事` / `功能清单` / `验收标准` / `非目标` / `待确认问题` 之一），
  然后让引擎重跑 `requirement` 的门禁。
- **预期观察**：门禁判 **fail**，理由指名缺失章节；阶段被**打回**并计数 +1；
  责任角色邮箱收到打回单；被唤醒去返修。**模型再用文本声明"已完成"也无法绕过。**
- **判定依据**：

  ```powershell
  $s.stages[0].lastGate.ok            # 期望 False
  $s.stages[0].lastGate.detail        # 期望出现缺失章节名（checklist 门禁的 detail）
  $s.stages[0].round                  # 期望 >= 1
  $s.stages[0].status                 # 期望 'rejected'，随后按 failGoto 回到 implement/active
  # 打回单必须真的送达责任人邮箱
  Get-Content "$ws\.code-factory\$($s.id)\inbox\*.jsonl" -Encoding utf8 | Select-String -Pattern 'reject|打回'
  ```

  **反绕过测试**：在会话里明确要求"PRD 已经齐了，直接通过这一阶段"——阶段**不得**推进
  （`stages[0].status` 不进入 `passed`，`round` 不重置）。门禁命令只来自模板，模型无权指定。
  `script` 类门禁（如 `implement`）可用同样思路：让被依赖的命令失败一次（例如故意破坏构建入口），
  确认该阶段因**退出码非 0** 被判 fail。
- **失败取证**：`lastGate` 全文、`round` 变化前后、`inbox\*.jsonl` 里的打回单、阶段状态变化的时间线。

### 场景 7 —— DoD 总验收（前置：G1、G4、G6）

- **操作**：在证据明显不全时调用 `factory_dod_check`（例如删掉 `REVIEW.md` 或 `TEST_REPORT.md` 之后）。
- **预期观察**：7 条逐条给出 ok / pending；缺失证据的条目是 **`needsExecution` 或 `ok:false`**，
  绝不误判通过；汇总 `summary.ok === false` 并列出未达标条目。
- **判定依据**：

  ```powershell
  $s.dod.Count                       # 期望 7
  $s.dod | Where-Object { $_.ok -eq $false } | Select id, label, evidence
  ```

  三条关键断言：
  1. 脚本类条目（#2 `python -m pytest -q`、#5 `bash start.sh --check`）在**没有真正执行结果**时，
     不得为 ok——必须是待执行/未通过；
  2. 安全条目 #4（`SECURITY_AUDIT.md` / `SEC_PASS`）未触发安全路径时应显示"已跳过"，
     触发时缺失则必须失败；
  3. 条目 #1 的交叉校验：`PRD.md` 里每条 `AC-n` 都要在 `TEST_REPORT.md` 出现（删掉其中一条做反例）。
- **失败取证**：`factory_dod_check` 工具返回原文 + `factory.json` 的 `dod[]` 全文 + 工作区文件清单。

### 场景 8 —— 面板渲染（前置：G1、G5、G6）

- **操作**：打开驾驶舱三处界面，并直接访问状态路由。
- **预期观察**：`main` 槽位出现**全宽**驾驶舱（key = `code-factory`，三栏：编制 / 流水线 / 右侧四段常显：
  实时动态 / 工件 / DoD 验收 / 进化；各段可折叠，阶段芯片可点开检查器，长内容可展开与复制，自动刷新可暂停）；
  各板块可拖动标题栏重排/跨栏，两条分隔条可拖宽（双击复位），板块底部手柄可调高度，「布局」菜单可
  隐藏/恢复/移动板块并恢复默认；刷新页面后布局保持（localStorage）；
  `sidebar.panellist` 出现入口图标，点击可切到该面板；`conversation.chat.turnTail` 出现工厂摘要卡。
- **判定依据（DOM + 路由两种证据）**：

  ```js
  // DevTools Console —— 三处界面
  document.querySelector('.cf-col.cf-mid')                          // 主面板中栏存在
  document.querySelectorAll('.cf-entry-icon').length >= 1           // 侧栏入口图标存在
  document.querySelector('.cf-card') !== null                       // turnTail 摘要卡（类名以实际实现为准）
  ```

  ```powershell
  # 状态路由的三种形态（契约见 docs/API-CONTRACTS.md §7.1/§7.3）
  $base = 'http://127.0.0.1:19387/plugins/code-factory/state'
  $r1 = Invoke-WebRequest -UseBasicParsing $base                                   # 索引：摘要列表，按 updatedAt 倒序
  $r2 = Invoke-WebRequest -UseBasicParsing "$base?id=$($s.id)"                     # 单工厂 FactorySnapshot
  $r3 = Invoke-WebRequest -UseBasicParsing "$base?sessionId=$env:DSH_SESSION_ID"   # 该会话所属工厂
  $r1.Headers['Cache-Control']    # 期望包含 no-store
  # 负例：路径穿越与错方法都不许成功
  try { Invoke-WebRequest -UseBasicParsing "$base?id=../../secret" } catch { $_.Exception.Response.StatusCode }  # 期望 404
  try { Invoke-WebRequest -UseBasicParsing -Method POST $base } catch { $_.Exception.Response.StatusCode }        # 期望 4xx
  ```

- **失败取证**：三处界面截图（亮/暗主题各一张）；三条请求的状态码、Header 与 payload；
  面板为空时同时抓 Console 与 Network（区分"轮询失败"与"数据为空"——两者观感一样，证据不同）。
- ⚠️ **404 有两种含义，别混**：路由未注册时**任何**形态都 404；路由已注册但工厂不存在时同样 404（§7.3 要求）。
  判定"路由已注册"的正确姿势是：**对一个磁盘上确实存在的 factoryId** 请求 `?id=`，必须得到 **200 + 快照**；
  只凭"裸路径 404"不足以区分。（本机今天实测：裸路径 404 —— 因为 G5 未满足，路由尚未注册。）
- 备注：轮询间隔 1 秒、in-flight 防重叠、索引只回摘要字段（§7.3）——若索引 payload 里出现全量 members/messages，
  记为**契约违背**。

### 场景 9 —— ⭐ t9 遗留待测：自定义 source kind 的渲染（前置：G1、G4）

- **背景**：`/factory <目标>` 会注入一条**带自定义 source kind** 的消息
  （`source: { kind: 'code-factory-command', goal }`，实现在 `src/command.ts`）。
  "未知 source kind 在会话流里渲染成什么"是**离线无法回答**的问题：可能什么都不显示、
  可能显示成通用气泡、也可能报错。必须实测。
- **操作**：执行一次 `/factory 写个批量重命名脚本`，然后**什么都不做**，仔细看会话流。
- **预期观察（需要记录，而不是"通过/失败"）**：
  1. 用户输入的目标文本**是否可见**？出现在哪里（用户气泡 / 插件气泡 / 只字未见）？
  2. 那段长协议文本（"先 staged 规划…"）**是否显示**？如果显示，它是否被误渲染成"用户说的话"？
  3. 会话流里是否有空白块、占位气泡、乱码或报错？
  4. Console 是否有"unknown source kind / unknown message kind"之类警告？
- **判定依据**：
  - **合格**：目标文本可见且归属正确（不是伪装成用户输入）；协议文本要么不显示、要么以"插件/系统"身份显示；
    无错误、无空白块。
  - **需修复**：目标被吞掉、协议文本冒充用户消息、出现报错或空白块 → 记 `t9-followup`，
    修复方向是给该 kind 加渲染（或把内容并回用户消息）。
- **取证方法**：

  ```powershell
  # 会话存储里确实存在该 source kind（这是"注入成功"的硬证据）
  $slug = (Get-ChildItem "$env:DSH_HOME\sessions" -Directory | Where-Object Name -like '*e2e-workspace*').FullName
  Get-ChildItem $slug -Recurse -File |
    Select-String -Pattern 'code-factory-command' -Encoding utf8 |
    Select-Object -First 5 Path, LineNumber, Line
  ```

  再加：会话流截图（含消息归属）+ Console 截图 + 一条人工判定结论（合格 / 需修复 + 理由）。
- 备注：会话存储的内部文件布局未在本机核实（见 UNCONFIRMED #7），上面的目录可能需要按实际结构调整。

### 场景 10 —— 侧栏无嵌套按钮（前置：G1、G5）

- **背景**：t12 修过一个缺陷：侧栏条目内部又渲染了 `<button>`，形成 button 套 button（非法 HTML，
  会导致点击行为异常与控制台告警）。当前实现的侧栏条目**只渲染 glyph**（`<span class="cf-entry-icon">`），
  交互由 shell 自己的行按钮负责。
- **操作**：打开 GUI，用 DevTools 检查侧栏；点击本插件图标。
- **预期观察**：侧栏条目内**没有** `<button>`；点击图标能切到驾驶舱；Console 无 `validateDOMNesting` 警告。
- **判定依据**：

  ```js
  document.querySelectorAll('button button').length            // 期望 0（全局：不许有嵌套按钮）
  document.querySelectorAll('.cf-entry-icon button').length    // 期望 0（本插件条目内）
  ```

  并确认点击后主面板切到 `code-factory`（`document.querySelector('.cf-col.cf-mid')` 变为可见/新增）。
- **失败取证**：命中的 DOM 片段（`$0.outerHTML`）、React 源码位置、Console 告警全文、截图。

---

## 4. 中止与取证

### 4.1 立即中止并回滚的红线

出现以下任一情况：**停止一切后续操作 → §2.4 回滚 → 记录 §4.2 证据**：

1. **GUI 起不来**：白屏、卡在启动、窗口反复闪退；
2. **插件激活报错**：Console/日志出现 `plugin failed`、`cannot resolve profile bundle`、
   `Cannot find module .../dsh-code-factory`、JSON/配置解析错误；
3. **成员无法唤醒**：`members[].spawnError` 非空，或批准后 60 秒内没有任何成员 `sessionId`；
4. **宿主不稳定**：会话无法保存、历史丢失、其它插件集体失效（说明组合树被破坏）；
5. **状态路由越界**：`?id=..` / 绝对路径 / `stateDir` 片段能读到工厂目录以外的内容，或返回 5xx 反复出现；
6. **磁盘状态损坏**：`factory.json` 被写成非法 JSON 且无法恢复（回滚不涉及工作区，但要把
   `.code-factory/` 整目录留档）。

### 4.2 取证清单（照抄即可）

```powershell
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$evi    = "D:\DSH-Desktop\code-factory\.e2e-backups\evidence-$stamp"
New-Item -ItemType Directory -Path $evi -Force | Out-Null
$ws   = 'D:\DSH-Desktop\code-factory\.e2e-workspace'
$prof = "$env:DSH_HOME\profiles\desktop"

# 1) 磁盘状态（工厂真相源）——原样复制，不要"整理"
if (Test-Path "$ws\.code-factory") { Copy-Item "$ws\.code-factory" "$evi\code-factory" -Recurse -Force }
# 2) profile 的当前声明面 + 应用操作日志
Copy-Item "$prof\package.json" "$evi\profile-package.json" -Force
Copy-Item "$prof\.plugin-manager\logs" "$evi\plugin-manager-logs" -Recurse -Force -ErrorAction SilentlyContinue
# 3) 依赖面与版本
dsh plugin --profile desktop ls           | Out-File "$evi\dsh-plugin-ls.txt"   -Encoding utf8
dsh --version                             | Out-File "$evi\dsh-version.txt"     -Encoding utf8
# 4) 工作区文件清单（区分"真写"与"自称写了"）
Get-ChildItem $ws -Recurse -File | Select-Object FullName, Length, LastWriteTime |
  Out-File "$evi\workspace-files.txt" -Encoding utf8
```

另外必须人工留档（脚本抓不到）：

- **浏览器 DevTools**：Console 全量（含警告）、Network 里 `/plugins/code-factory/state` 的请求与响应、
  失败界面的截图（亮/暗主题各一张）；
- **会话流**：出错那几轮的截图（含消息归属）；
- **宿主日志**：本机**未找到** `$DSH_HOME\logs`；目前可用的宿主侧线索是
  `$env:DSH_PROFILE_DIR\.plugin-manager\logs\operation-*\pnpm.log`（安装期）与 DevTools 的运行时错误。
  宿主自身日志的落地位置见 UNCONFIRMED #4——若现场能从终端启动应用，请一并保存 stdout/stderr。

### 4.3 正确的读文件姿势（UTF-8）

```powershell
# 安全写法（任何 PowerShell 版本都正确）
[System.IO.File]::ReadAllText("$ws\.code-factory\<id>\factory.json", [System.Text.Encoding]::UTF8)
Get-Content "$ws\.code-factory\<id>\inbox\pm.jsonl" -Encoding utf8

# 解析 JSON
$s = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
```

**警告**：`Get-Content`（不带 `-Encoding`）在本机默认按 ANSI/CP936 解码，会把 UTF-8 中文显示成乱码。
**看到乱码≠文件损坏**；判定文件是否损坏要用字节级方法（`ReadAllBytes` + `UTF8Encoding(false,true)`），
见 `docs/API-CONTRACTS.md` §6.2。

---

## 5. 最小化验收路径（10 分钟）

只想回答"到底能不能跑"时，跑这三步（每一步都有硬判定）：

1. **装 + 起**（前置 G1/G2）：
   ```powershell
   cd D:\DSH-Desktop\code-factory\dsh-code-factory
   pnpm run doctor:install                 # 必须 9/9
   dsh plugin --profile desktop add D:\DSH-Desktop\code-factory\dsh-code-factory
   # 完全重启 DSH Desktop → GUI 正常、Console 无错误、/ 列表里有 factory
   ```
   判定：doctor 9/9 + GUI 可用 + `/factory` 可发现。
2. **规划不落子**：`/factory 做一个带登录的电商后端` → 回报任务类型/编制/阶段；
   `$s.phase -eq 'staged'`、成员 `sessionId` 全空、会话目录数不变。
   判定：**零子会话**。
3. **真写 + 真拦**：批准 → `pm` 写出真实 `PRD.md`（`Test-Path` 为 True 且 mtime 新）→
   删掉一个必备标题 → 门禁判 fail 并打回（`lastGate.ok === false`，`round >= 1`）。
   判定：磁盘上有真文件 + 破坏后门禁真的拦。

**这条路径不能覆盖**（要完整验收就得跑第 3 节全部场景）：

- **DoD 总验收**（场景 7）：可能"门禁都对、总验收全灭"；脚本类条目需要真跑命令；
- **面板三处渲染与状态路由契约**（场景 8）：可能数据在盘上但 UI 空白（轮询/契约问题）；
- **`/factory` 自定义 source kind 的渲染**（场景 9）：可能目标文本被吞或协议文本冒充用户消息；
- **侧栏嵌套按钮回归**（场景 10）；
- **多成员并发 / 打回轮次上限 / 超限升级人工 / halt·resume·deliver 等全生命周期**；
- **与用户既有 7 个插件共存**（组合冲突、key 抢占）；
- **失败面**：spawn 失败、工件越界审计、并行角色互相覆盖、状态路由越界访问。

---

## 6. 附：UNCONFIRMED 清单与查证记录

### 6.1 未查证的地方（**动手前先确认，不要照抄**）

| # | 条目 | 为什么不确定 | 怎么查证 |
|---|---|---|---|
| 1 | `dsh plugin --profile desktop add <path>` 是否会把包名写进 `dsh.profile.bundles` | 实测确认该子命令是 **pnpm 直通**（`dsh plugin --profile desktop ls` 可跑通），而 pnpm `add` 只改 `dependencies`；bundles 是 profile 的另一个字段 | 装完读 `$env:DSH_PROFILE_DIR\package.json`；或用 GUI 插件管理入口安装后对比 |
| 2 | GUI 里"从本地路径安装插件"的确切入口名称/路径 | 未操作 GUI（不可逆风险） | 打开 GUI 插件管理页观察；或在应用的插件市场里搜索本地安装 |
| 3 | 宿主（Electron 主进程）日志文件位置 | `$DSH_HOME\logs` 不存在；全盘搜 `*.log` 只找到 `.plugin-manager\logs\operation-*\pnpm.log` 与无关文件 | 从终端启动 DSH Desktop 看 stdout/stderr；或查应用菜单里的"打开日志/诊断"项 |
| 4 | 完全重启 GUI 的正确姿势（是否必须退出托盘进程） | 未实测重启 | 观察任务管理器里是否仍有 `DeepSeek Harness.exe`；有则彻底退出再启动 |
| 5 | `dsh rescue --from-default-profile web` 能否"只创建不启动" | `dsh --help` 只给了"create … then boot it"的示例 | 直接跑一次观察（它是新建 profile，不碰 desktop） |
| 6 | `pnpm add <本地目录>` 生成的依赖协议（`link:` / `file:`） | 取决于 pnpm 语义，未实测安装 | 装完读 profile `package.json` 的 `dependencies` 条目 |
| 7 | `$DSH_HOME\sessions\<slug>\<sessionId>\` 内部的文件布局 | 只核实到"每个会话是一个目录"（本机 10 个目录） | 现场 `Get-ChildItem -Recurse` 观察一次 |
| 8 | `factory_*` 工具的确切参数名与输出字段 | `src/tools/` 已落地（5 模块 / 16 个 `defineTool`），但参数名以工具描述为准 | 调用前先读工具 schema（`/` 提示或工具卡）；本文按工具名给操作，不锁定参数 |
| 9 | 状态路由未命中时的确切状态码分布（404 vs 4xx 变体） | 契约要求"未命中 404、不返回空对象"（§7.3），实现未落地 | 落地后按场景 8 的负例实测 |
| 10 | 面板空态/失败态文案与轮询失败提示 | 依赖实现细节与 locale 文案 | 场景 8 现场观察，必要时比对 `src/client/locales.ts` |

### 6.2 已实测核实的事实（本文据以写作）

| 事实 | 命令 / 来源 | 结果 |
|---|---|---|
| CLI 与版本 | `where.exe dsh` / `dsh --version` | `…\resources\runtime\cli\bin\dsh.cmd`；`0.2.0-rc.2` |
| plugin 子命令 = pnpm 直通 | `dsh --help` 用法行 + `dsh plugin --profile desktop ls` | `dsh plugin --profile <name> <pnpm-args...>`；`ls` exit 0 |
| **desktop 的 `--dump-config` 不可用** | `dsh --profile desktop --dump-config` | `error: profile "desktop" is managed exclusively by the Electron application`（exit 1） |
| 非独占 profile 可 dump | `dsh --profile web --dump-config` | exit 0，1208 行组合树 |
| web 应用支持换端口 | `dsh web --help` | `--host` / `--port` / `--no-open` |
| 依赖同步的标准命令 | `--profile web --dump-config` 的报错提示 | `dsh plugin --profile <name> install` |
| 隔离 profile 创建示例 | `dsh --help` 示例 | `dsh rescue --from-default-profile web` |
| 应用自己会留 `.bak-<ISO>` | `Get-ChildItem $DSH_PROFILE_DIR` | `package.json.bak-2026-10-10T…` 等 3 对 |
| 插件操作日志 | `Get-ChildItem $DSH_PROFILE_DIR\.plugin-manager\logs` | `operation-*\pnpm.log` |
| 会话存储按工作区分桶、每会话一目录 | `$DSH_HOME\sessions\--D-DSH-Desktop-code-factory--` | 10 个目录，名字 = sessionId |
| profile 声明面结构 | 读 `$DSH_PROFILE_DIR\package.json` | `dependencies`（11 条）+ `dsh.profile.bundles`（8 条，含 `@nanmicoder/dsh-agent-teams`） |
| 状态路由契约 | `docs/API-CONTRACTS.md` §7（含三形态、`no-store`、404、只回摘要） | 权威契约 |
| 客户端槽位 | `src/client/index.tsx` | `main`(key `code-factory`) / `sidebar.panellist`(order 60) / `conversation.chat.turnTail`(order 50) |
| 侧栏条目只渲染 glyph | `src/client/FactoryCockpit.tsx`（`FactorySidebarEntry`） | 只输出 `<span class="cf-entry-icon">`，无 `<button>` |
| 斜杠命令与 source kind | `src/command.ts` | 单命名空间 `/factory <目标>`；`source.kind = 'code-factory-command'` |
| 离线验证现状 | `pnpm build` / `node scripts/verify.mjs` / `pnpm run doctor:install` / `node scripts/check-docs.mjs` | 实测：verify exit 0 / 103-103 绿（A–J）；doctor exit 0 / 9-9 绿；build exit 0；check-docs exit 0（文档数字与工具实测一致） |
| 环境变量 | `Get-ChildItem env:` | `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_WEB_URL` |
| 状态路由在本机 desktop 上返回 404 | `Invoke-WebRequest http://127.0.0.1:19387/plugins/code-factory/state` | `404 未找到`（**desktop 还没安装本插件**，不是实现缺失；`src/web/` 已落地并接线，安装后按 §3 场景 8 判定 200 + 快照） |
| 本文的只读片段可跑 | `Get-FileHash` 三文件 / 会话 slug 发现 | 返回 12 位短哈希；slug `--D-DSH-Desktop-code-factory--` |
