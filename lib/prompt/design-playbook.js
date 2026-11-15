/**
 * design-playbook.ts — the UI/UX design lead's execution handbook.
 *
 * `ui_designer` is the one role whose output is judged on taste, interaction
 * completeness and accessibility rather than on a compile command. This module
 * turns that judgement into a **checkable** standard: a design view, an industry
 * direction library, concrete design tokens, the full interaction-state matrix,
 * WCAG AA rules, the mandatory seven-section UI_SPEC structure, and a ten-item
 * self-assessment table.
 *
 * Why it lives outside `roles.ts`: the registry is a small shared contract read by
 * both compiler programs (`src/shared` purity rules), while this playbook is a
 * long prompt body. Keeping it separate lets `member-brief.ts` inject it only for
 * the design role, without growing every role definition or the client bundle.
 *
 * **Pure by contract** — plain strings plus one function that reads `role.id`.
 * No imports beyond the shared type, no Node API, no clock, no randomness: the
 * offline self-check asserts byte-identical prompts for identical inputs.
 *
 * The pipeline's design gate is intentionally **not** changed: it still requires
 * the UI_SPEC headings 「页面清单 / 交互流程 / 设计规范」. Section 7 below tells
 * the designer how to expand 「设计规范」 into the seven mandatory parts, so the
 * gate stays compatible while the deliverable gets richer.
 *
 * @module dsh-code-factory/prompt/design-playbook
 */
/** Title of the injected handbook block (also asserted by the offline check). */
export const DESIGN_PLAYBOOK_TITLE = '【设计负责人手册（UI/UX Playbook）】';
/** The one role the handbook applies to. */
export const DESIGN_PLAYBOOK_ROLE_ID = 'ui_designer';
/**
 * The handbook body, as prompt-ready Markdown.
 *
 * Deterministic text only. It is injected verbatim by {@link renderDesignPlaybook}
 * and quoted by `ui_designer`'s iron rules, so wording changes here should be
 * mirrored in `roles.ts` (and vice versa).
 */
export const DESIGN_PLAYBOOK = [
    '本手册是 UI/UX 设计负责人的执行标准：每一条都要求可验收，不是口号。',
    '',
    '## 1. 设计观：高级感从哪里来',
    '- 高级感 = 克制 + 层级 + 留白 + 一致性 + 细节；不是堆特效、不是堆装饰。',
    '- 先做减法：每个页面只保留一个主行动（primary），其余降级为次行动；同屏强调色不超过 1 处。',
    '- 用 8pt 网格与稳定间距建立秩序；用字号/字重/颜色层级建立信息优先级。',
    '- 禁止无理由的紫渐变、毛玻璃（backdrop-blur）、超大圆角（>16px 需有理由）、发光/霓虹描边、满屏动画。',
    '- 每个视觉决定都要能回答：解决什么问题？对应的 token 是什么？去掉它页面会失去什么？',
    '',
    '## 2. 行业方向库（先选方向，再落 token）',
    '每行：气质 / 主色 + 中性 / 字体 / 密度 / 动效 / 禁忌。默认为 neutral 灰阶；主色只用于主行动与关键状态。',
    '- 金融：稳健、可信、精确 / 深蓝 #1d4ed8 + 冷灰 / 中文无衬线 + 等宽数字 / 中低密度 / 120–180ms 干脆 / 禁忌花哨渐变、卡通插画、过度圆角。',
    '- 医疗：干净、安心、专业 / 青绿 #0d9488 + 暖灰 / 无衬线、正文 15–16px / 中密度 / 180ms 轻缓 / 禁忌高饱和红、惊悚影像、复杂装饰。',
    '- 政企：庄重、清晰、可追溯 / 藏蓝 #1e3a8a + 中性灰 / 无衬线、大字号 / 中低密度 / 120ms 克制 / 禁忌娱乐化配色、动效炫技。',
    '- 教育：友好、鼓励、有序 / 橙 #ea580c 或蓝 #2563eb + 暖中性 / 圆润无衬线 / 中密度 / 180–240ms / 禁忌低对比、过多颜色、游戏化干扰。',
    '- 电商：热闹、转化、信任 / 品牌红或主品牌色 + 浅灰 / 紧凑数字字体 / 高密度 / 120–180ms / 禁忌信息过载、假促销、遮挡主按钮。',
    '- 内容社区：个性、沉浸、呼吸感 / 低饱和品牌色 + 深灰 / 阅读型衬线可选 + 无衬线 UI / 低密度留白 / 240ms / 禁忌满屏广告、打断阅读的弹层。',
    '- 工具 SaaS：高效、冷静、可扩展 / 蓝紫 #4f46e5 + 冷灰 / 无衬线 + 等宽 / 中高密度 / 120–180ms / 禁忌装饰性插画挤占工作区、隐藏主操作。',
    '- 出行：即时、可信、地理感 / 蓝绿 #0891b2 + 深灰 / 无衬线、大按钮 / 中密度 / 120ms 即时反馈 / 禁忌地图上堆浮层、低对比文字。',
    '- 工业：可靠、数据、耐看 / 石墨灰 + 安全黄/橙作为警示 / 等宽数字、粗体标题 / 高密度 / 80–120ms 或关闭动效 / 禁忌柔和低对比、装饰性动效。',
    '- 游戏：氛围、节奏、视觉冲击 / 高对比品牌色 + 深底 / 展示型字体 + 无衬线正文 / 中密度 / 240–320ms / 禁忌正文低对比、自动播放强动效。',
    '落地要求：从上面选 1 个主方向 + 最多 1 个辅助方向；在 UI_SPEC 里写明「目标行业 / 用户 / 场景 → 方向 → token」的推导，并列出至少 2 个被否设计方向及原因。',
    '',
    '## 3. 设计令牌（Design Tokens，UI_SPEC 必须给全）',
    '### 3.1 颜色',
    '- Neutral（中性灰阶，亮色模式）：n-50 #f8fafc / n-100 #f1f5f9 / n-200 #e2e8f0 / n-300 #cbd5e1 / n-400 #94a3b8 / n-500 #64748b / n-600 #475569 / n-700 #334155 / n-800 #1e293b / n-900 #0f172a / n-950 #020617。',
    '- Brand（主色，示例值，按行业替换）：brand-50 #eef2ff / 100 #e0e7ff / 500 #6366f1 / 600 #4f46e5 / 700 #4338ca；主行动用 brand-600，hover brand-700，press brand-800（或等效深色）。',
    '- Accent（辅助色，≤1 个）：accent-500 #06b6d4，仅用于次要高亮与数据可视化的第二序列。',
    '- Semantic：success #16a34a（浅底 #dcfce7）、warning #d97706（浅底 #fef3c7）、danger #dc2626（浅底 #fee2e2）、info #2563eb（浅底 #dbeafe）。语义色只表达状态，不做装饰。',
    '- 文本：text-primary = n-900、text-secondary = n-600、text-tertiary = n-500、text-inverse = n-50；禁用态 text-disabled = n-400。背景：bg = n-50、surface = #ffffff、surface-muted = n-100、border = n-200。',
    '- 深色模式映射：bg = n-950、surface = n-900、surface-muted = n-800、border = n-700、text-primary = n-50、text-secondary = n-300；brand 提亮一档（brand-500），semantic 使用 400 档保证 ≥4.5:1；禁止只反转明暗导致对比度不足。',
    '### 3.2 字体（最多 2 个家族：无衬线 + 等宽）',
    '- display：32/40，700，letter-spacing -0.02em；用于页面主标题与关键大数字。',
    '- h1：28/36，600，-0.01em；h2：22/30，600，0；body：14/22，400，0（中文正文 ≥14px，长文建议 16/26）。',
    '- caption：12/18，400，+0.01em，仅辅助信息且不得承载关键操作。',
    '- mono：13/20，400，font-variant-numeric: tabular-nums；用于金额、ID、代码、时间。',
    '- 中文字体栈示例：-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif；等宽：ui-monospace, SFMono-Regular, Consolas, monospace。',
    '### 3.3 间距 / 圆角 / 描边 / 阴影 / 层级 / 动效',
    '- 间距：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64；组件内用 4 的倍数，区块间用 24/32；8pt grid 为默认节奏（4 为半档）。',
    '- 圆角：sm 4、md 8、lg 12、pill 999；输入框/卡片默认 8，圆角 >16 必须写明理由。',
    '- 描边：1px border（border token）；focus 用 2px brand-600 + 2px offset。',
    '- 阴影：e1 0 1px 2px rgba(15,23,42,.06)；e2 0 4px 12px rgba(15,23,42,.10)；e3 0 12px 32px rgba(15,23,42,.16)。层级：base 0 / raised e1 / overlay e2 / modal e3；z-index 0 / 100 / 200 / 300。',
    '- 动效：fast 120ms（hover/press）、base 180ms（展开/切换）、moderate 240ms（页面转场）、slow 320ms（引导）；easing 默认 cubic-bezier(0.2, 0, 0, 1)，进入 ease-out、退出 ease-in；reduced-motion 下只保留 opacity/颜色变化或直接 0ms。',
    '',
    '## 4. 信息架构与响应式',
    '- 断点：390（移动）/ 768（平板）/ 1024（小桌面）/ 1440（宽桌面）；按容器宽度适配，不写死设备。',
    '- 触控目标 ≥44×44px（含内边距）；移动端主行动固定在拇指热区（底部/右下）。',
    '- 每页只有一个视觉焦点与一个主行动；按「首屏 5 秒法则」：用户 5 秒内要能说出这是什么产品、下一步做什么。',
    '- 内容优先级：P0 首屏必现 / P1 一屏内 / P2 折叠或次级页面；表格/列表为空要有明确下一步。',
    '',
    '## 5. 交互状态矩阵与反馈（每个组件必须给全）',
    '- 状态：default / hover / active / focus-visible / disabled / loading / empty / error / success，逐状态说明视觉变化与是否可点。',
    '- 键盘路径：Tab / Shift+Tab 顺序、Enter/Space 激活、Esc 关闭浮层、方向键在列表/菜单内移动；焦点环始终可见，且不被 sticky/浮层遮挡。',
    '- 反馈：提交用乐观更新或明确 loading；列表加载用骨架屏（尺寸与最终内容一致，避免跳动）；空态给行动按钮；错误给原因 + 恢复路径（重试/返回）；成功给一句话确认。',
    '- toast 不得遮挡主操作/导航；危险操作二次确认；删除支持撤销或明确告知不可恢复。',
    '- 动效服务理解：不使用无意义的持续动画；加载动画 >1s 才出现；reduced-motion 下不播放位移/缩放。',
    '',
    '## 6. 可访问性与中文排版（WCAG AA）',
    '- 正文对比度 ≥4.5:1；大字（≥18.66px 粗体或 ≥24px）≥3:1；非文本（图标/边框/焦点环）≥3:1。',
    '- 200% 缩放不破版：允许换行、不裁切、不出现横向滚动；触控/点击区域不缩小。',
    '- 所有图片/图标有替代文本或 aria-hidden；表单必须有 label 与错误提示关联；颜色不是唯一信息载体。',
    '- 中文排版：正文行高 ≥1.6，段落间距 ≥ 字号，禁止两端强制对齐；中英混排加空格；数字/金额用等宽数字；长文本断行用 word-break: break-word，不用强制截断关键信息。',
    '',
    '## 7. UI_SPEC 交付结构（7 段强制，缺段即不合格）',
    '门禁要求 UI_SPEC 必须含「页面清单 / 交互流程 / 设计规范」三个标题；下列 7 段是「设计规范」下的展开，不改变门禁 checklist。',
    '### 1) 视觉方向与行业依据：目标行业/用户/场景、设计目标、主方向 + 辅助方向、≥2 个被否设计方向及原因。',
    '### 2) 设计令牌：颜色（含深色映射）、字体层级、间距、圆角、描边、阴影、动效时长/缓动，全部命名并给具体值。',
    '### 3) 页面清单与信息架构：页面/路由/入口、信息层级、每页主行动与内容优先级，覆盖 PRD 全部用户故事。',
    '### 4) 交互流程与全状态：主流程 + 异常流程，每组件 9 态与键盘路径，加载/空/错误/成功反馈。',
    '### 5) 组件规范：每个组件给 props 表（名称/类型/默认值/必填）、variants（size/tone/state）、所用 token、a11y 说明。',
    '### 6) 响应式与可访问性：断点行为、触控尺寸、对比度结论、200% 缩放、reduced-motion 策略。',
    '### 7) 设计自评表：见下节，10 项每项 0–10 分，总分 <80 必须迭代后重交。',
    '',
    '## 8. 设计自评表（交付前逐项打分，0–10 分）',
    '| # | 维度 | 评分要点 | 分值 |',
    '| - | ---- | -------- | ---- |',
    '| 1 | 行业匹配 | 行业方向库的选择有依据，气质/配色/密度与行业一致 | 0–10 |',
    '| 2 | 层级 | 主次清晰，首屏 5 秒可懂，唯一主行动 | 0–10 |',
    '| 3 | 配色 | token 化、对比度达标、语义色不装饰化、深色映射完整 | 0–10 |',
    '| 4 | 字体 | 层级完整（display/h1/h2/body/caption/mono），≤2 家族，行高合理 | 0–10 |',
    '| 5 | 间距 | 8pt grid 一致，留白有呼吸感，无随意像素 | 0–10 |',
    '| 6 | 组件状态 | 9 态齐全，disabled/loading/error 可区分 | 0–10 |',
    '| 7 | 交互反馈 | 乐观更新/骨架屏/空态行动/错误恢复/撤销齐全 | 0–10 |',
    '| 8 | 可访问性 | 对比度、焦点、键盘、200% 缩放、reduced-motion 全通过 | 0–10 |',
    '| 9 | 响应式 | 390/768/1024/1440 均验证，无横向滚动与遮挡 | 0–10 |',
    '| 10 | 高级感克制 | 无无理由渐变/毛玻璃/大圆角/发光，装饰服务于信息 | 0–10 |',
    '自评规则：每项独立打分并写扣分原因；总分 <80 不得交付，按扣分项迭代后重新自评。',
].join('\n');
/**
 * The handbook lines for one role, or `[]` for every other role.
 *
 * Returned shape is `[title, ...body lines]`; the caller prepends a blank line.
 * Non-design briefs/dispatches must stay byte-identical, so this function is the
 * single gate that decides whether the handbook is rendered at all.
 *
 * @param role - the role the prompt is being rendered for.
 * @returns the block lines, empty when the role is not `ui_designer`.
 */
export function renderDesignPlaybook(role) {
    if (role.id !== DESIGN_PLAYBOOK_ROLE_ID)
        return [];
    return [DESIGN_PLAYBOOK_TITLE, ...DESIGN_PLAYBOOK.split('\n')];
}
//# sourceMappingURL=design-playbook.js.map