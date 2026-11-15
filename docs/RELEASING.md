# 发布流程（dsh-code-factory）

这份文件描述**一次发布必须走过的每一步**，以及每一步失败时的处置。它存在的理由见
`REVIEW-工程评审报告.md` 的 B1 / B5 / B6：这个插件的发布链路曾经断成三截 ——
全新 clone 打出来的包是空的、装进 profile 的其实是 `link:` 指向的开发检出、
而打出来的 tgz 无法对应到任何一个提交。

`lib/` 是构建产物且**不进 git**（`.gitignore:3`、`git ls-files lib` 为空），
所以「检出的树」和「别人拿到的包」天生是两样东西。全流程的设计目标只有一个：
**让这两样东西的差异在发布前变成一条红色命令，而不是发布后的一次事故。**

---

## 0. 前置

```bash
pnpm install
pnpm build          # tsc x2 + tsdown + check-bundle
```

## 1. 门禁必须全绿

```bash
pnpm release:check
```

**一条命令，全部离线门禁。** 这里**故意不再抄一遍**它包含哪些步骤、每步有几项断言 ——
抄一遍就会过期一次，而这份文档此前正是这么烂掉的（它曾经写着「verify 67 项」）。唯一真源是
`package.json` 的 `release:check`，而 `pnpm run check:ci` 会强制它和
`.github/workflows/ci.yml` 的步骤**逐条对齐**：链条里多一步、少一步，或者顺序不一致，
`check:ci` 立刻变红。每一步各自有几项断言，看它自己的输出。

任何一条红都不要往下走。`test:self*` 是**对门禁本身**的测试：它故意把规则改坏，
要求门禁确实变红 —— 一个不会红的门禁不算门禁。

```bash
pnpm doctor:install # 安装自检：插件是否真的能被宿主认出
```

### 1.1 有一条门禁**故意不在** `release:check` 里

`pnpm smoke:load` 要求 PATH 上有 `dsh`：它真的把插件装进一个临时 profile 再卸掉，
观察 39 个工具的注册面。CI runner 上没有 `dsh`，所以它进不了 `release:check`
（`check:ci` 会立刻判链条不一致）。

**发布时在拥有宿主的机器上跑这条**——它就是 `release:check` 后面接上冒烟：

```bash
pnpm release:publish   # = release:check && smoke:load
```

把它的结果当作发布的一部分来对待：它是唯一一条真正回答「装得上吗」的检查，
`doctor` 回答的是「装上的那一份对不对」。

## 2. 同步版本号

`package.json` 与 `compatibility.json` 各有一份 `version`，**必须一起改**
（`doctor` 的第 7 项会比对两者，不一致直接判失败）。

```bash
# 两个文件里的 version 改成同一个值，例如 0.2.1
```

## 3. 打包并记录产物指纹

```bash
pnpm check:pack
```

这条命令会跑**真实的** `npm pack`（因此会触发 `prepack` → `pnpm build`），
然后逐条校验：必需条目齐全、`lib/client/**` 与 `*.map` 未被打进去、
`main` / `types` / `exports` 的每个目标都能在**包内**解析、
包内每个文件与检出**逐字节相同**。成功时它会打印：

```
record this in the release note: dsh-code-factory-<version>.tgz sha256 <64 位十六进制>
```

把这行 sha256 抄进 `release-notes/<version>.md`。

## 4. 写发布说明

`release-notes/<version>.md` 是**机器可读的发布记录**，不是给人看的散文。
`pnpm check:pack` 会回来读它，并强制以下四条：

| 要求 | 不满足时的表现 |
| --- | --- |
| 文件存在 | 只提示「尚未发布」，不算失败（开发中可以没有） |
| 记录 `sha256 <64 位十六进制>` | 失败：`does not record the artifact sha256` |
| 该 sha256 与本次打包**逐字节一致** | 失败：`records sha256 …… but this tree packs to ……` |
| `HEAD` 上有 `v<version>` 标签，且与 `package.json` 版本一致 | 提示未打标签；标签不一致则失败 |

写清三件事：这次发布了什么、产物的 sha256、以及它对应的提交。

## 5. 提交并打标签

```bash
git add -A
git commit -m "release: v<version>"
git tag v<version>
pnpm release:check   # 见 §1
```

**标签打在承载发布说明的那个提交上** —— 这是「产物 → 提交」这条链的最后一环，
也是 B6 的原始症状所在（当时 0.1.0 的 tgz 比两个提交都早约 3 天，
没有任何东西能指出它是从哪棵树上打出来的）。

## 6. 从产物本身安装（发布前的最后一道）

`link:` 安装验证的是开发检出，**不是产物**。要验证产物，必须从 tgz 装：

```bash
npm pack                       # 或直接用上一步 check:pack 留下的 tgz
dsh plugin --profile <name> remove dsh-code-factory
dsh plugin --profile <name> add ./dsh-code-factory-<version>.tgz
dsh plugin --profile <name> ls  # 期望看到版本号，而不是 link:D:/...
```

装完**重启 DSH**（插件在启动时加载），然后用
`npx dsh-code-factory-doctor --against <profile>/node_modules/dsh-code-factory`
自检 —— 这条路径不需要 `src/`、`docs/`、`scripts/`，因为安装态根本拿不到它们。

## 7. 失败处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `check:pack` 报 `entries` 极少 | `prepack` 没跑（例如 `--ignore-scripts`） | 去掉该开关重跑；脚本会明确警告「本次只证明了文件清单」 |
| `artifact == checkout` 失败 | 打包用的是另一棵树，或 `lib/` 已过期 | `pnpm build` 后重跑 |
| 包内 `exports` 目标解析失败 | `files[]` 漏了某个目录 | 收紧/放宽 `files`，`pnpm test:self:pack` 会证明规则仍然会红 |
| 发布说明 sha256 不匹配 | 说明写完之后又动了会被打包的文件 | 重新打包、更新说明、重新提交、**移动标签** |
| `doctor` 报「同一版本、不同副本」 | 运行时加载的不是你以为的那一份 | 先确认装的是产物还是 `link:`，再重装 |

---

## 为什么这些门禁值得相信

`pnpm test:self` 与 `pnpm test:self:pack` 会**故意破坏**规则再运行门禁，
要求门禁确实报错并指出具体条目。也就是说：这些门禁不是「跑起来是绿的」，
而是「**被证明会红**」。改动 `check-docs.mjs` / `check-pack.mjs` 里的规则时，
请同步补一个变异用例 —— 否则下一个人无法区分「规则通过了」和「规则没生效」。
