# 回滚手册（DSH profile）

> 这份手册放在仓库根目录，并且**随包发布**（`package.json` 的 `files` 里含 `scripts/profile-backup.mjs`）。
> 装着本插件的人手里就有回滚步骤 —— 这正是评审报告 B4 指出的缺口：
> 原来的 runbook 躺在 `docs/` 里，而 `docs/` 不进包，出事的人根本看不到。

## 0. 什么时候用

- 插件升级后 GUI 起不来、面板空白、或本插件行为异常，需要退回上一份已知可用的 profile 配置；
- 手工改过 `cordis.yml` / `cordis.patch.yml` / `package.json`，想退回去；
- 例行巡检：确认「现在真的能回滚」。

## 1. 备份里有什么

一次 `backup` 产出一个目录，里面是：

| 内容 | 说明 |
| --- | --- |
| `payload/` | 逐个文件复制：`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，以及 `.dsh-market/` 与 `.plugin-manager/`（registry 全量 + `logs/` 最近 20 份） |
| `manifest.json` | 每个文件的 `{path, bytes, sha256, mtimeMs}` |
| `manifest.sha256` | **对 manifest 本身的封印**；校验顺序是先验封印、再比文件 |
| `plugin-ls.txt` | 备份时刻 `dsh plugin --profile <p> ls` 的原始输出 |
| `hashes-before.txt`、`manifest-before.txt` | 老 runbook 点名的两个清单，保留兼容 |

**不含 `node_modules/`**：它由 lockfile + `dsh plugin --profile <p> install` 重建。
把它塞进备份会让每次备份复制几百 MB，结果是没人备份。

## 2. 四个命令

插件源码检出里用 `pnpm`：

```bash
pnpm backup --profile desktop --into /path/to/backups   # 取一份备份
pnpm backup:verify -- /path/to/backups/desktop-<stamp>  # 校验一份备份
node scripts/profile-backup.mjs restore ...             # 见下；没有 pnpm 别名
pnpm backup:drill                                       # 一次性 profile 上自检 14 关
```

装成包的机器上直接调脚本（`scripts/` 里只发布 `doctor.mjs` 与 `profile-backup.mjs`）：

```bash
node node_modules/dsh-code-factory/scripts/profile-backup.mjs backup  --profile desktop --into ./backups
node node_modules/dsh-code-factory/scripts/profile-backup.mjs verify  ./backups/desktop-<stamp>
node node_modules/dsh-code-factory/scripts/profile-backup.mjs restore ./backups/desktop-<stamp> --into <profile-dir> --apply
node node_modules/dsh-code-factory/scripts/profile-backup.mjs drill
```

- `backup` 默认读 `$DSH_HOME`（缺省 `~/.dsh`）下的 `profiles/<name>`；`--profile` 默认 `desktop`。
- `verify` 会**先**验 manifest 封印，再逐文件重算 sha256，并报告「清单里有但负载里没有」
  和「负载里有但清单里没有」两种偏差。退出码 0 = 一致，1 = 有偏差。
- `restore` **默认是干跑**（只列文件、不写盘），必须显式 `--apply` 才落盘；
  而且**拒绝从校验不过的备份还原**。这条是为了避免「以为在回滚，其实在扩散一次坏备份」。

## 3. 真实回滚步骤（破坏性，含 GUI 会话中断）

```text
① node …/profile-backup.mjs verify <backup-dir>          # 必须先过
② node …/profile-backup.mjs backup --profile desktop --into ./backups   # 先给现状再取一份
③ 关闭 DSH GUI（或确认当前会话可中断）
④ node …/profile-backup.mjs restore <backup-dir> --into <profile-dir> --apply
⑤ 进入 profile 目录，按需重装依赖：dsh plugin --profile desktop install
   （只改了配置、没动依赖时可跳过；pnpm-lock.yaml 已在备份里，用于重建 node_modules）
⑥ 重启 GUI，确认面板可用
```

**RTO 估算 5–15 分钟**（含一次 GUI 重启）。依据：`.plugin-manager/logs/operation-*` 显示
安装类操作在 1 分钟内成功或失败。**这是一条估算，不是实测** —— 见第 5 节。

## 4. 校验顺序为什么是这个顺序

先比 `manifest.sha256` 与 `manifest.json` 的哈希，再用 manifest 去比负载。反过来的话，
任何一个能改负载的人也能顺手改 manifest 让自己的改动「通过校验」。同理，`restore`
在动手前重新跑一次完整校验，并在写完后**再跑一次**，写坏了自己会喊。

## 5. 证据边界（不要高估这套能力）

已经拿到的（`D:\DSH-Desktop\code-factory\.e2e-backups\ROUNDTRIP-PROOF.md` 有完整记录）：

- 四个 profile（desktop / web / factory-web / factory-rehearsal）都有带封印的备份；
- 每份都通过 `verify`；
- 每份都 `restore --apply` 到临时目录，且**逐字节等于它来自的那个活动 profile**；
- `drill` 的 14 关全部按设计表现：改一个字节、删一个文件、加一个文件、改 manifest、
  删封印，五种坏法都被抓住并点名。

**还没拿到的**：一次带计时的、真正破坏性的演练（remove → restore → install → 重启 GUI）。
执行者就是当前会话，重启会中断流程本身，所以它排在收尾阶段的一个专门重启窗口里。
在那之前，本手册的 RTO 数字请当作估算。

> B5「把 `link:` 换成真实 tgz 安装」已经补上：`pnpm run smoke:load` 的阶段 F 会 `npm pack`
> 出真正的发布产物，把它装进第二个一次性 profile，并断言它是**实体化拷贝而不是指回仓库的
> 链接**。A–E 装的是工作树，所以它们全绿并不能说明用户装到的是什么。
