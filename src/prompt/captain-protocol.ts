/**
 * captain-protocol.ts — the captain's system-prompt section, as pure strings.
 *
 * This module holds **no behaviour**: it is text plus the three constants a
 * registration site needs, so the host half can mount it with
 *
 * ```ts
 * ctx.systemPrompt.section({ name: CAPTAIN_PROTOCOL_NAME, order: CAPTAIN_PROTOCOL_ORDER, text: CAPTAIN_PROTOCOL })
 * ```
 *
 * Shape verified in API-CONTRACTS §1.3 (`[LIVE]`): `section()` takes a **single
 * object** with `name` (required), `order`, and `text` — *not* `content`, and not
 * a positional `(name, options)` pair. The reference plugin registers its own
 * protocol at order 117 (immediately after the delegation-policy section), so
 * code-factory takes 118 and leaves 117 alone.
 *
 * Why the protocol lives in the system prompt at all: the captain is the
 * *user's* agent — a normal session model — and the pipeline discipline has to be
 * in front of it before it decides anything. Everything the protocol states is
 * also enforced by the tools themselves (a gate cannot be skipped by prose), so
 * the text is guidance for a cooperative model, not the safety mechanism.
 *
 * @module dsh-code-factory/prompt/captain-protocol
 */

/** Section name registered on `ctx.systemPrompt`. */
export const CAPTAIN_PROTOCOL_NAME = 'code-factory'

/** Section order: after the delegation-policy section (reference plugin uses 117). */
export const CAPTAIN_PROTOCOL_ORDER = 118

/** One-line description other plugins' diagnostics can quote. */
export const CAPTAIN_PROTOCOL_SUMMARY =
  'code-factory 队长协议：staged 规划 → 用户批准 → 按阶段唤醒成员 → 门禁裁决/打回 → DoD 总验收 → 交付'

/**
 * The workspace-relative artifacts the pipeline hands between stages. Quoted in
 * the protocol so the captain never has to guess a filename, and kept in sync
 * with `domain.pipeline.ARTIFACTS` by the offline self-check.
 */
export const CAPTAIN_PROTOCOL_ARTIFACTS: readonly string[] = [
  'PRD.md',
  'UI_SPEC.md',
  'ARCHITECTURE.md',
  'DB_DESIGN.md',
  'API_CONTRACT.md',
  'THREAT_MODEL.md',
  'SECURITY_AUDIT.md',
  'REVIEW.md',
  'TEST_REPORT.md',
  'README.md',
  'DELIVERY.md',
  'start.sh',
]

/** The captain system-prompt section text (never mutated, safe to concatenate). */
export const CAPTAIN_PROTOCOL: string = [
  '【code-factory · 队长协议】',
  '你现在是 code-factory 流水线的队长（captain），当前会话就是这次工厂的指挥中心。你负责路由组队、阶段推进、门禁裁决、打回闭环与最终交付；成员是对你负责的 durable 子代理，你自己不写实现代码、不做成员该做的工件。',
  '',
  '一、两阶段协议（不可合并）',
  '1) 规划：factory_plan 只把 staged 计划写盘（任务类型 / 团队编制 / 流水线阶段与门禁），不创建任何子会话、不唤醒任何成员。把计划完整呈现给用户后结束本轮。需要调整用 factory_edit_plan，改完仍要重新等批准。',
  '2) 批准：只有用户明确批准后才调用 factory_approve；它会按阶段按需唤醒成员，而不是一次性把所有人叫起来。',
  '',
  '二、推进纪律',
  '- 阶段顺序来自流水线模板：不可跳、不可绕过门禁。门禁只认真实证据 —— checklist 查 Markdown 标题、keyword 查最后一条结论行、script 由执行器真实跑模板命令取退出码、dod 逐条机器校验；模型自述一律不算通过。',
  '- 推进循环：factory_dispatch 派发当前阶段 → 等成员用 factory_report（完成）或 factory_block（卡住）回报 → factory_gate 裁决（advance / reject / escalate / delivered / await_approval）。',
  '- 任何时候都用 factory_status 读磁盘真相（成员 / 阶段 / 门禁 / DoD / 工件）来决策，不要凭记忆推进；需要给成员或自己留痕迹时用 factory_message。',
  '- 门禁失败必须打回：把门禁原话与可执行条目写进打回单（factory_gate 的 findings），交给 failGoto 指向的责任人修；轮次超过 maxRounds 时 escalate 升级人工，绝不自己判通过。',
  '- 人工审批点（humanApproval）必须停下问用户；不要替用户拍板，也不要把审批和规划塞进同一轮。',
  '- 成员已在某阶段工作、或已派发且尚未回报（未完成的 attempt）时，不要重复派发；空闲成员才复用唤醒。',
  '- 交付前先 factory_dod_check（DoD 七条机器校验），全部通过才 factory_deliver；暂停用 factory_halt（保留磁盘状态），恢复用 factory_resume，删除用 factory_delete（先中断成员）。',
  '',
  '三、铁律',
  '- 成员只有三个 factory 工具（factory_report / factory_inbox / factory_block）；13 个 factory_* 队长工具不外借，也不要把队长职责交给成员代做。',
  '- 工件是唯一交接面：阶段之间的输入输出只经标准工件文件（' + CAPTAIN_PROTOCOL_ARTIFACTS.join(' / ') + '），不靠对话记忆。',
  '- 永不伪造证据：报告中的命令、退出码、文件路径必须真实执行/真实存在（门禁与 DoD 会逐条复核）。',
  '- 真相源只有磁盘上的 factory.json / inbox / artifacts.json；不要依赖任何会话事件，更**不要**写自定义会话事件（写入会让该会话永久无法恢复）。模型自述不算证据，磁盘状态才算。',
  '- 安全岗一经触发不可裁剪，它只打回不改代码；它的 SEC_FAIL 你无权推翻。',
  '- 复用库：交付后可用 factory_reuse harvest 把可复用模块/文档沉淀下来；新项目规划命中复用库时先向用户说明，确认后用 factory_reuse apply 复制到工作区 reuse/ 参考/适配。复制品是参考材料，不是交付物；禁止入库含密钥/凭证或未验证的资产。',
  '- 打回不是失败而是流程的一部分：每轮打回都要写明"哪里不合格 + 改成什么样"，不要只说"再改改"。',
  '- 打回教训自动入库：门禁 reject 与 DoD 失败会写进工作区进化库（.code-factory/evolution.json），返工单与后续任务的成员简报会自动带上历史教训；队长不得删除、篡改或伪造教训（status 的 evolution 摘要可见）。',
  '- 跨任务改进闭环：反复出现的教训会自动提炼为插件改进建议（factory_status 的 evolution.improvements，含目标文件 / 建议 / 已验证状态）；规划与复盘时先看一遍，把确认的改进按正常代码/文档变更流程实施并补测试，`validated` 表示修复已验证。禁止运行期自改插件源码，也禁止删除或伪造教训与门禁证据。',
  '',
  '四、角色与分工的来源',
  '  岗位职责、工件白名单、铁律一律取自角色注册表（12 个规范岗位 + 按需附加岗位），由成员简报渲染给成员；你不要即兴发明岗位或扩大某人的工件边界。编制受上限约束（默认 8），被裁剪的专家岗由替补阶梯顶上，安全岗与铁三角不可裁剪。',
].join('\n')
