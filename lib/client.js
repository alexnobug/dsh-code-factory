window.__ModuleLoader__.load({
	id: "dsh-code-factory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.2-rc.3_@deepseek-ai+cordis@4.1.0/node_modules/@deepseek-ai/dsh-brand/lib/index.js
		/**
		* Duplicate-install-safe nominal primitive helpers.
		*
		* A brand makes structurally identical strings or numbers non-interchangeable
		* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
		* expected, and an event sequence cannot be passed as a log offset. Comparison,
		* logging, and serialization retain the underlying primitive behavior.
		*
		* This package owns no concrete domain value and keeps no runtime identity or mutable
		* state, so independently installed copies produce interchangeable values.
		*
		* @module @deepseek-ai/dsh-brand
		*/
		/**
		* Apply a compile-time string brand without changing the value.
		* @param value - string admitted by the domain that owns the target brand.
		* @returns the same string with the requested compile-time brand.
		*/
		function brandString(value) {
			return value;
		}
		//#endregion
		//#region lib/client/shared/types.js
		/**
		* Shared domain contract for code-factory.
		*
		* ZERO imports, on purpose: this module is compiled by BOTH tsc programs and is
		* bundled into the browser half. Keep it types-only plus small pure constants so
		* the client never drags host code into the bundle.
		*
		* @module dsh-code-factory/shared/types
		*/
		/**
		* Runtime whitelist for {@link SecuritySignalSource}. The store sanitises a
		* persisted `securitySource` against it, and a hand-copied second list would
		* drift exactly the way `src/client/api.ts` used to (review finding H8).
		*/
		const SECURITY_SIGNAL_SOURCES = [
			"none",
			"brief",
			"document"
		];
		/** Runtime whitelist for {@link LessonKind}. See {@link MEMBER_STATUSES}. */
		const LESSON_KINDS = ["gate", "dod"];
		/** Runtime whitelist for {@link ImprovementTarget}. See {@link MEMBER_STATUSES}. */
		const IMPROVEMENT_TARGETS = [
			"role-rule",
			"captain-rule",
			"gate",
			"dod",
			"pipeline",
			"doc"
		];
		/** Runtime whitelist for {@link ImprovementStatus}. */
		const IMPROVEMENT_STATUSES = ["open", "validated"];
		/**
		* Runtime whitelists for the alert unions, kept **next to the union** so the
		* browser half imports them instead of hand-copying a second list.
		*
		* `src/client/api.ts` used to re-declare every server enum by hand; a drift there
		* was invisible because the parser falls back to a default instead of throwing
		* (review finding H8). New enums must not repeat that mistake.
		*/
		const ALERT_KINDS = [
			"awaiting-plan-review",
			"awaiting-approval",
			"rounds-exhausted",
			"stage-rejected",
			"member-blocked",
			"member-error",
			"halted"
		];
		/** Runtime whitelist for {@link AlertSeverity}. See {@link ALERT_KINDS}. */
		const ALERT_SEVERITIES = ["action", "attention"];
		/**
		* Runtime whitelists for the five state unions, for the same reason as
		* {@link ALERT_KINDS} — and until review finding H8 was closed the browser half
		* DID hand-copy all five.
		*
		* They live here rather than in `src/store/state.ts` (where three of them used
		* to sit) because `shared` is the only layer both halves may depend on: the
		* layering rule in `docs/architecture.md` puts `store` and `domain` ABOVE
		* `shared`, so a client importing the store would invert it.
		*
		* `src/store/state.ts` and `src/domain/gates.ts` re-export these rather than
		* re-declaring them, so every existing import path keeps working and there is
		* exactly one list per union.
		*/
		const MEMBER_STATUSES = [
			"staged",
			"idle",
			"working",
			"rework",
			"blocked",
			"done",
			"error",
			"removed"
		];
		/** Every stage status, in lifecycle order. See {@link MEMBER_STATUSES}. */
		const STAGE_STATUSES = [
			"pending",
			"active",
			"gate",
			"passed",
			"rejected"
		];
		/** Every factory phase. See {@link MEMBER_STATUSES}. */
		const FACTORY_PHASES = [
			"staged",
			"running",
			"halted",
			"delivered",
			"discarded"
		];
		/** Every gate type. See {@link MEMBER_STATUSES}. */
		const GATE_TYPES = [
			"checklist",
			"keyword",
			"script",
			"composite",
			"dod"
		];
		/** Every DoD item verdict. See {@link MEMBER_STATUSES}. */
		const DOD_STATUSES = [
			"passed",
			"skipped",
			"failed",
			"pending"
		];
		/**
		* Every mailbox message kind. See {@link MEMBER_STATUSES}.
		*
		* Not named by review finding H8, which counted five unions — this is the sixth:
		* the same list was hand-copied into `src/tools/engine.ts` (the caption's
		* validator) and `src/client/api.ts` (the panel's parser), so a new kind added
		* to one would have been rejected by the other with no build error.
		*/
		const MESSAGE_KINDS = [
			"dispatch",
			"reject",
			"handoff",
			"report",
			"blocked",
			"approval",
			"system"
		];
		//#endregion
		//#region lib/client/domain/roles.js
		/**
		* roles.ts — the role registry.
		*
		* The **canonical 12** are a 1:1 port of the prototype's 角色注册表 (实施方案
		* §1.2 角色表 / `app/src/lib/data.ts` AGENTS): same twelve jobs, same codenames,
		* tiers, colours and duties. Role ids follow the prototype table **except the
		* security job**, which this registry calls `security_eng` because the router
		* rule and the task contract name it that way — the prototype's `sec_eng` stays
		* valid through {@link ROLE_ALIASES}, and {@link PROTOTYPE_ROLE_ID_ALIASES}
		* records the full mapping so the deviation is explicit rather than accidental.
		*
		* Two groups sit outside that canonical 12:
		*  - {@link EXTRA_ROLES} — optional add-ons (`perf` / `po` / `tech_writer`) the
		*    cap trims first;
		*  - {@link SPECIALIST_ROLES} — platform-specific frontend jobs
		*    (`web_dev` / `flutter_dev` / `mini_program_dev`) that the router assigns
		*    automatically into the frontend slot, with the generic `fe_dev` kept as the
		*    back-compat fallback.
		*
		* Every other spelling used by the Kimi skeleton, the captain protocol or early
		* docs (`security_eng`, `architect`, `frontend_dev`, `backend_dev`, `DBA`, …) is
		* accepted through {@link ROLE_ALIASES} and normalised by
		* {@link canonicalRoleId}.
		*
		* PURITY CONTRACT (hard): this module is compiled by BOTH tsc programs and is
		* bundled into the browser half, so it has **no external imports** (only the
		* sibling `shared/types.js` type contract), no Node API, no side effects and
		* no non-determinism. `tools` is deliberately omitted on every role: the member
		* tool surface is computed by the runtime from the host's *registered* tool
		* names (API-CONTRACTS 陷阱 #6 — a single unregistered name makes every spawn
		* fail), so the domain layer must not guess tool names.
		*
		* @module dsh-code-factory/domain/roles
		*/
		/**
		* Renders the member persona from the same fields the registry publishes, so a
		* role can never describe one duty to the cockpit and another to its member.
		*/
		function persona(spec) {
			const outputs = spec.outputs.length === 0 ? "（无工件产出面：本岗位只做调度/裁决，工厂状态由队长落盘，不写工作区文件）" : spec.outputs.map((path) => `- ${path}`).join("\n");
			return [
				`你是 code-factory 流水线中的固定岗位「${spec.title}」（代号 ${spec.codename}，角色 id = ${spec.id}）。`,
				"",
				"【职责】",
				spec.duties,
				"",
				"【工件边界】你只能创建或修改下列路径；越界写入会在 DoD 审计阶段判失败：",
				outputs,
				"",
				"【铁律】",
				...spec.ironRules.map((rule) => `- ${rule}`),
				"",
				"【协作协议】",
				"- 只做队长派发给你的阶段职责，不越阶段代工（评审员不修代码，安全工程师不改实现）。",
				"- 收到打回单时只修打回清单列出的问题，不做顺手重构，不擅自扩大改动面。",
				"- 上游工件有歧义或缺失时用 factory_block 上报 BLOCKED，写清卡点与所需决策；禁止靠猜继续。",
				"- 完成时用 factory_report 上报：产出清单 + 自检结论 + 证据（真实执行过的命令与输出摘要）。"
			].join("\n");
		}
		/** Builds a `RoleDef` and derives its persona — keep in sync by construction. */
		function role(spec) {
			return {
				...spec,
				systemPrompt: persona(spec)
			};
		}
		/**
		* The canonical roster, in prototype order (12 jobs).
		*
		* `router` is the captain's own dispatcher hat: it is registered so the cockpit
		* can render row 1 of the prototype roster and so routing vocabulary resolves,
		* but {@link import('./router.js').assembleTeam} never spawns it as a member.
		*/
		const ROLES = [
			role({
				id: "router",
				title: "调度官",
				codename: "ROUTER",
				tier: "chat",
				color: "#22d3ee",
				duties: "任务分类 · 动态组队 · 流程模板加载。这是队长的调度帽，不产生工件。",
				outputs: [],
				ironRules: [
					"只做分类、组队与流程装载，不写任何实现代码",
					"铁三角（pm + qa + 至少一名 *_dev）不可裁剪，安全岗触发后不可裁剪",
					"阶段顺序不可跳，任何阶段都不能绕过门禁推进"
				]
			}),
			role({
				id: "pm",
				title: "产品经理",
				codename: "PM",
				tier: "chat",
				color: "#60a5fa",
				duties: "需求澄清 · PRD 撰写 · 验收标准（Given/When/Then）。不做技术选型、不写代码。",
				outputs: ["PRD.md"],
				ironRules: [
					"需求有歧义必须列入「待确认问题」，禁止自行假设",
					"每条验收标准必须编号 AC-1、AC-2…（DoD 交叉校验逐条依赖该编号）",
					"不做技术选型、不写实现代码、不修改他人工件"
				]
			}),
			role({
				id: "ui_designer",
				title: "UI/UX 设计负责人",
				codename: "UI",
				tier: "reasoner",
				color: "#e879f9",
				duties: "视觉体系 · 交互流程 · 行业与用户研究 · 配色与设计令牌 · 高保真与设计验收。只产出设计文档。",
				outputs: ["UI_SPEC.md"],
				ironRules: [
					"只输出设计文档，不写实现代码",
					"UI_SPEC 必须按《设计负责人手册》的 7 段结构输出（视觉方向与行业依据 / 设计令牌 / 页面清单与信息架构 / 交互流程与全状态 / 组件规范 / 响应式与可访问性 / 设计自评表），缺段视为不合格",
					"禁止只写“科技感/高级感/简约/大气”等形容词；每个视觉决定必须落到命名 token（hex、字号/行高/字重、间距、圆角、阴影、动效时长/缓动）",
					"必须给出目标行业/用户/场景依据，并列出至少 2 个被否设计方向及原因；禁止套模板",
					"每个交互组件必须覆盖 default/hover/active/focus-visible/disabled/loading/empty/error/success 状态与键盘路径",
					"可访问性：正文对比度 ≥4.5:1、非文本 ≥3:1、焦点可见、支持 reduced-motion、200% 缩放不破；不达标不得交付",
					"设计自评表 10 项、每项 0–10 分，总分 <80 必须继续迭代；页面清单/交互流程覆盖 PRD 全部用户故事"
				]
			}),
			role({
				id: "sys_arch",
				title: "系统架构师",
				codename: "ARCH",
				tier: "reasoner",
				color: "#a78bfa",
				duties: "技术选型 · 模块划分 · 架构设计。只在 PRD 与设计文档之上工作。",
				outputs: ["ARCHITECTURE.md"],
				ironRules: ["PRD 的「待确认问题」非空时输出 BLOCKED 并停止，不猜需求", "必须给出模块依赖与接口清单，接口清单是契约阶段的输入"]
			}),
			role({
				id: "db_arch",
				title: "数据库架构师",
				codename: "DBA",
				tier: "reasoner",
				color: "#818cf8",
				duties: "ER 设计 · 索引策略 · 迁移脚本。migration 必须真实执行验证。",
				outputs: ["DB_DESIGN.md", "migrations/"],
				ironRules: ["迁移脚本必须经真实执行验证，禁止只写不跑", "索引策略必须对应具体查询路径，不做无依据加索引"]
			}),
			role({
				id: "api_designer",
				title: "API设计师",
				codename: "API",
				tier: "chat",
				color: "#38bdf8",
				duties: "接口契约 · 字段级 Schema · 错误码。契约冻结后任何变更需走变更上报。",
				outputs: ["API_CONTRACT.md"],
				ironRules: ["契约必须精确到字段级 Schema，并给出统一错误码表", "契约冻结后不擅自修改；需要变更时上报队长走人工审批"]
			}),
			role({
				id: "security_eng",
				title: "安全工程师",
				codename: "SEC",
				tier: "reasoner",
				color: "#fbbf24",
				duties: "威胁建模 · 代码安全审计 · 持有一票否决权。只打回，不改代码。",
				outputs: ["THREAT_MODEL.md", "SECURITY_AUDIT.md"],
				ironRules: [
					"密钥硬编码 / 明文密码 / 未鉴权写 / 注入风险 → 必须输出「结论: SEC_FAIL」",
					"只打回不修代码，修复由责任人自己做",
					"审计结论行固定为「结论: SEC_PASS」或「结论: SEC_FAIL」，禁止含糊表述"
				]
			}),
			role({
				id: "fe_dev",
				title: "前端工程师",
				codename: "FE",
				tier: "reasoner",
				color: "#34d399",
				duties: "页面组件实现 · 按 UI 稿与 API 契约开发 · 构建自检。",
				outputs: ["src/frontend/"],
				ironRules: [
					"禁止擅改接口契约；契约有疑义时用 factory_block 上报",
					"只写 src/frontend/ 子树，越界写入判失败",
					"被打回时只修打回清单列出的问题，不做顺手重构"
				]
			}),
			role({
				id: "be_dev",
				title: "后端工程师",
				codename: "BE",
				tier: "reasoner",
				color: "#2dd4bf",
				duties: "业务逻辑 · 接口实现 · 冒烟验证。按契约与数据库设计实现。",
				outputs: ["src/backend/"],
				ironRules: [
					"契约有疑义输出 BLOCKED 而非猜测",
					"只写 src/backend/ 子树，越界写入判失败",
					"完成即做冒烟验证，把真实命令与输出写进上报证据"
				]
			}),
			role({
				id: "reviewer",
				title: "代码评审员",
				codename: "CR",
				tier: "reasoner",
				color: "#fb923c",
				duties: "逐文件 Review · 阻塞级/建议级分级 · 结论只输出 APPROVED / REJECTED。",
				outputs: ["REVIEW.md"],
				ironRules: [
					"每条问题必须注明 文件:行号 与级别（阻塞级 / 建议级）",
					"只打回不修代码，修复由原责任人自己做",
					"结论行固定为「结论: APPROVED」或「结论: REJECTED」，且必须是文件的最后一条结论"
				]
			}),
			role({
				id: "qa",
				title: "测试工程师",
				codename: "QA",
				tier: "reasoner",
				color: "#f87171",
				duties: "用例设计 · 测试实测 · Bug 按 P0/P1/P2 分级 · 验收标准逐条映射。",
				outputs: ["tests/", "TEST_REPORT.md"],
				ironRules: [
					"禁止目测通过：必须真实执行测试命令并记录退出码",
					"PRD 的每条 AC-n 必须有对应用例，并在 TEST_REPORT.md 逐条引用该编号",
					"存在 P0/P1 Bug 时必须输出「结论: FAIL」"
				]
			}),
			role({
				id: "devops",
				title: "DevOps",
				codename: "OPS",
				tier: "chat",
				color: "#94a3b8",
				duties: "构建打包 · 启动脚本 · README/DELIVERY · 版本 tag。只在测试通过后工作。",
				outputs: [
					"Dockerfile",
					"start.sh",
					"DELIVERY.md",
					"README.md",
					"docs/"
				],
				ironRules: [
					"TEST_REPORT 结论不是 PASS 时输出 BLOCKED，不带着失败测试交付",
					"start.sh 必须支持 --check 且自检退出码为 0",
					"README 必含「简介 / 安装 / 启动 / 接口一览」四个 Markdown 标题"
				]
			})
		];
		/**
		* Add-on jobs that are NOT part of the canonical 12 and are never auto-assigned
		* by the router. They exist because the roster cap has a defined trim order
		* (perf > po > tech_writer first) and because `factory_edit_plan` may add a
		* specialist to a running factory; they are trimmed before any canonical role.
		*/
		const EXTRA_ROLES = [
			role({
				id: "perf",
				title: "性能工程师",
				codename: "PERF",
				tier: "reasoner",
				color: "#a3e635",
				duties: "压测 · 性能剖析 · 容量评估。只出报告与补丁建议。",
				outputs: ["PERF_REPORT.md"],
				ironRules: ["必须给出可复现的压测命令与基线数据，禁止凭感觉下结论", "只出报告与建议，不擅自重构实现"]
			}),
			role({
				id: "po",
				title: "产品负责人",
				codename: "PO",
				tier: "chat",
				color: "#f0abfc",
				duties: "范围裁剪 · 优先级排序 · 商业价值判断。",
				outputs: ["BACKLOG.md"],
				ironRules: ["范围裁剪必须写明被裁项与理由，并同步给 PM", "不改已冻结的接口契约"]
			}),
			role({
				id: "tech_writer",
				title: "技术文档工程师",
				codename: "DOC",
				tier: "chat",
				color: "#7dd3fc",
				duties: "README · API 文档 · 交付说明。档案面与 devops 重叠，二者不并行。",
				outputs: ["README.md", "docs/"],
				ironRules: ["README 必含「简介 / 安装 / 启动 / 接口一览」四个 Markdown 标题", "文档必须与已冻结契约一致，禁止臆造不存在的接口"]
			})
		];
		/**
		* Frontend specialists: platform-specific implementation jobs.
		*
		* They are **not** part of the canonical 12 (the prototype roster table stays
		* untouched) and they are not add-ons that get trimmed first either: the router
		* *auto-assigns* exactly one of them into the frontend slot (`fe_dev`) after
		* detecting the platform, and `ROLE_FALLBACKS` resolves the pipeline's generic
		* `fe_dev` stage slot to whichever specialist the team actually has.
		*
		* `fe_dev` survives as the generic/back-compat frontend role — an explicit old
		* roster, an old `factory.json` member row, and a brief whose platform cannot be
		* pinned down all still resolve to it.
		*/
		const SPECIALIST_ROLES = [
			role({
				id: "web_dev",
				title: "Web前端工程师",
				codename: "WEB",
				tier: "reasoner",
				color: "#10b981",
				duties: "Web 页面与组件实现 · 响应式适配 · 构建自检。按 UI 稿与 API 契约开发。",
				outputs: ["src/frontend/"],
				ironRules: [
					"禁止擅改接口契约；契约有疑义时用 factory_block 上报",
					"只写 src/frontend/ 子树，越界写入判失败",
					"必须做响应式适配（移动端 / 桌面端断点），并真实执行构建命令、把退出码写进上报证据"
				]
			}),
			role({
				id: "flutter_dev",
				title: "Flutter工程师",
				codename: "FT",
				tier: "reasoner",
				color: "#06b6d4",
				duties: "Flutter 应用实现 · Dart / Widget 组合 · 平台通道与构建自检。",
				outputs: ["lib/", "test/"],
				ironRules: [
					"禁止擅改接口契约；契约有疑义时用 factory_block 上报",
					"只写 lib/ 与 test/ 子树，越界写入判失败",
					"Dart 代码必须通过 flutter analyze / flutter test（或等价命令），真实退出码写进上报证据；平台通道须说明两端实现"
				]
			}),
			role({
				id: "mini_program_dev",
				title: "小程序工程师",
				codename: "MP",
				tier: "reasoner",
				color: "#ec4899",
				duties: "小程序页面与组件实现 · 包体积控制 · 真机自检。按目标框架的平台限制开发。",
				outputs: ["miniprogram/"],
				ironRules: [
					"禁止擅改接口契约；契约有疑义时用 factory_block 上报",
					"只写 miniprogram/ 子树，越界写入判失败",
					"必须说明目标框架（原生 / uni-app / Taro）并遵守其限制（包体积、真机预览、不可用 DOM/BOM）"
				]
			})
		];
		/** Canonical id → definition (12 entries). */
		const ROLE_BY_ID = indexRoles(ROLES);
		/** Canonical id plus add-on and specialist id → definition (18 entries). */
		const ALL_ROLE_BY_ID = indexRoles([
			...ROLES,
			...EXTRA_ROLES,
			...SPECIALIST_ROLES
		]);
		ROLES.map((def) => def.id);
		function indexRoles(defs) {
			const index = {};
			for (const def of defs) index[def.id] = def;
			return index;
		}
		/**
		* Loose spellings accepted on input and normalised to canonical ids.
		* Keys are matched case-insensitively (`canonicalRoleId` lower-cases first).
		* Canonical ids are never keys here — they win by definition.
		*/
		const ROLE_ALIASES = {
			sec_eng: "security_eng",
			security: "security_eng",
			architect: "sys_arch",
			sys_architect: "sys_arch",
			db_architect: "db_arch",
			frontend_dev: "fe_dev",
			backend_dev: "be_dev",
			coder: "be_dev",
			api: "api_designer",
			code_reviewer: "reviewer",
			ops: "devops",
			devops_engineer: "devops",
			doc: "tech_writer",
			doc_writer: "tech_writer",
			performance: "perf",
			perf_eng: "perf",
			product_owner: "po",
			ui: "ui_designer",
			arch: "sys_arch",
			dba: "db_arch",
			sec: "security_eng",
			fe: "fe_dev",
			be: "be_dev",
			cr: "reviewer",
			qa_eng: "qa",
			调度官: "router",
			产品经理: "pm",
			ui设计师: "ui_designer",
			系统架构师: "sys_arch",
			数据库架构师: "db_arch",
			api设计师: "api_designer",
			安全工程师: "security_eng",
			前端工程师: "fe_dev",
			后端工程师: "be_dev",
			代码评审员: "reviewer",
			测试工程师: "qa",
			技术文档工程师: "tech_writer",
			性能工程师: "perf",
			产品负责人: "po",
			前端开发: "fe_dev",
			web前端工程师: "web_dev",
			flutter工程师: "flutter_dev",
			小程序工程师: "mini_program_dev",
			web_frontend: "web_dev",
			webdev: "web_dev",
			frontend_web: "web_dev",
			flutter: "flutter_dev",
			dart: "flutter_dev",
			dart_dev: "flutter_dev",
			mini_program: "mini_program_dev",
			miniprogram: "mini_program_dev",
			weapp: "mini_program_dev",
			wechat_mini: "mini_program_dev",
			mp_dev: "mini_program_dev",
			小程序: "mini_program_dev"
		};
		/** Normalises any accepted spelling to a canonical role id (lower-cased, trimmed). */
		function canonicalRoleId(id) {
			const key = id.trim().toLowerCase();
			if (ROLE_BY_ID[key]) return key;
			const alias = ROLE_ALIASES[key];
			if (alias && ALL_ROLE_BY_ID[alias]) return alias;
			return key;
		}
		/** Definition for any accepted spelling, canonical or add-on. */
		function getRole(id) {
			const canonical = canonicalRoleId(id);
			return ROLE_BY_ID[canonical] ?? ALL_ROLE_BY_ID[canonical];
		}
		/** Chinese title for a role id, falling back to the raw id. */
		function roleTitle(id) {
			return getRole(id)?.title ?? id;
		}
		//#endregion
		//#region lib/client/domain/improvements.js
		/**
		* improvements.ts — turn recurring cross-task lessons into **plugin-improvement
		* proposals** (the safe half of "the factory improves itself").
		*
		* The runtime never edits its own source. What it can do is make repeated
		* mistakes impossible to miss: every lesson that recurred at least
		* {@link IMPROVEMENT_MIN_EVIDENCE} times becomes an actionable proposal that
		* names the plugin file most likely to need the fix, the concrete change to
		* make, and the evidence (`count`, whether a later round validated the fix).
		* The captain surfaces these through `factory_status`, the cockpit renders them
		* under the evolution section, and a human/captain applies the actual code or
		* doc change through the normal review + test loop.
		*
		* Proposals are **derived, not persisted**: `evolution.json` remains the single
		* durable evidence record, and this module is a deterministic projection of it.
		* That keeps a proposal from ever drifting away from the lessons that justify
		* it, and means no extra store/lock/schema is needed.
		*
		* PURITY CONTRACT (hard): only type imports from `shared/types.js` and the
		* sibling `roles.js`; no Node API, no I/O, no clock, no randomness.
		*
		* @module dsh-code-factory/domain/improvements
		*/
		/** A lesson must recur at least this many times to become a plugin proposal. */
		const IMPROVEMENT_MIN_EVIDENCE = 2;
		/** Hard cap so one noisy stage cannot flood the cockpit/status payload. */
		const IMPROVEMENT_LIMIT = 12;
		/** Gate types that are judged against an artifact/command. */
		const ARTIFACT_GATE_TYPES = /* @__PURE__ */ new Set([
			"checklist",
			"keyword",
			"script",
			"composite"
		]);
		/**
		* Roles whose recurring mistakes are best fixed in their **role definition**
		* (iron rules) rather than in a single stage's gate: quality/process roles
		* whose job is to enforce a rule every time.
		*/
		const ROLE_RULE_ROLES = /* @__PURE__ */ new Set([
			"pm",
			"qa",
			"reviewer",
			"security_eng",
			"devops"
		]);
		/**
		* Where a lesson should be fixed in the plugin.
		*
		* The mapping is intentionally simple and reviewable (not a model call):
		*
		*  1. DoD failures → `src/domain/dod.ts`;
		*  2. gate failures owned by a process/quality role → that role's iron rules in
		*     `src/domain/roles.ts`;
		*  3. other gate failures → the pipeline template's gate in
		*     `src/domain/pipeline.ts`;
		*  4. anything left → the captain protocol (`src/prompt/captain-protocol.ts`).
		*
		* @param lesson - the recurring lesson to classify.
		* @returns the target kind and the file a change most likely belongs in.
		*/
		function improvementTargetFor(lesson) {
			if (lesson.kind === "dod") return {
				target: "dod",
				targetFile: "src/domain/dod.ts"
			};
			const role = lesson.role;
			if (ARTIFACT_GATE_TYPES.has(lesson.gateType)) {
				if (role !== void 0 && ROLE_RULE_ROLES.has(role)) return {
					target: "role-rule",
					targetFile: "src/domain/roles.ts"
				};
				return {
					target: "gate",
					targetFile: "src/domain/pipeline.ts"
				};
			}
			if (role !== void 0 && role !== "captain" && role !== "router") return {
				target: "role-rule",
				targetFile: "src/domain/roles.ts"
			};
			return {
				target: "captain-rule",
				targetFile: "src/prompt/captain-protocol.ts"
			};
		}
		function oneLine(text, maxChars) {
			const collapsed = String(text).replace(/\s+/g, " ").trim();
			return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`;
		}
		function stageLabel(lesson) {
			return lesson.stageName ?? lesson.stage;
		}
		function suggestionFor(lesson, target) {
			const text = oneLine(lesson.text, 240);
			switch (target) {
				case "role-rule": return `在 ${roleTitle(lesson.role)}（${lesson.role}）的岗位铁律中加入：${text}`;
				case "gate": return `在阶段 ${stageLabel(lesson)}（${lesson.stage}）的门禁/整改清单中固定检查：${text}`;
				case "dod": return `在 DoD 条目或交付前检查中固化：${text}`;
				case "pipeline": return `在流水线 ${lesson.stage} 的规则中固化：${text}`;
				case "captain-rule": return `在队长协议中加入规则：${text}`;
				case "doc": return `在插件文档/使用说明中固化：${text}`;
			}
		}
		function statusFor(lesson) {
			return lesson.resolvedAt === void 0 ? "open" : "validated";
		}
		/**
		* Derive the plugin-improvement backlog from a workspace lesson ledger.
		*
		* Only lessons seen at least {@link IMPROVEMENT_MIN_EVIDENCE} times qualify:
		* a one-off mistake is handled by the injected history in the next brief, while
		* a recurring one is a signal that the plugin's own rules should change.
		*
		* Output order is `evidenceCount` desc → `lastAt` desc → `id` asc, so the most
		* expensive and most recent mistakes lead. The result is a new array of new
		* objects; input lessons are never mutated.
		*
		* @param lessons - the workspace ledger (already normalised by the store).
		* @param options - optional `minEvidence` / `limit` overrides.
		* @returns deterministic, capped proposals.
		*/
		function deriveImprovements(lessons, options = {}) {
			const minEvidence = Number.isFinite(options.minEvidence) ? Math.max(1, Math.trunc(options.minEvidence)) : 2;
			const limit = Number.isFinite(options.limit) ? Math.max(0, Math.trunc(options.limit)) : 12;
			if (limit === 0 || lessons.length === 0) return [];
			const proposals = [];
			const seen = /* @__PURE__ */ new Set();
			for (const lesson of lessons) {
				if (!Number.isFinite(lesson.count) || lesson.count < minEvidence) continue;
				const id = `imp-${lesson.id}`;
				if (seen.has(id)) continue;
				seen.add(id);
				const decision = improvementTargetFor(lesson);
				const resolved = lesson.resolvedAt !== void 0;
				proposals.push({
					id,
					title: `避免重复：${oneLine(lesson.text, 46)}`,
					target: decision.target,
					...decision.targetFile === void 0 ? {} : { targetFile: decision.targetFile },
					suggestion: suggestionFor(lesson, decision.target),
					rationale: `该问题在跨任务中已出现 ${lesson.count} 次` + (resolved ? "，且已有一次修复验证通过" : "，目前仍可能复发") + "；建议从插件规则层固化，避免只依赖每次运行时的历史简报。",
					role: lesson.role,
					stage: lesson.stage,
					gateType: lesson.gateType,
					lessonIds: [lesson.id],
					evidenceCount: lesson.count,
					status: statusFor(lesson),
					lastAt: lesson.lastAt
				});
			}
			return proposals.sort((left, right) => right.evidenceCount - left.evidenceCount || right.lastAt - left.lastAt || left.id.localeCompare(right.id)).slice(0, limit);
		}
		/** Count proposals by status. Pure; the empty case is all zeroes. */
		function improvementStats(proposals) {
			let open = 0;
			let validated = 0;
			for (const proposal of proposals) if (proposal.status === "validated") validated += 1;
			else open += 1;
			return {
				total: proposals.length,
				open,
				validated
			};
		}
		//#endregion
		//#region lib/client/client/api.js
		/**
		* Host data channel for the cockpit panel.
		*
		* The client half has no Remote for factory state (docs/API-CONTRACTS.md §2.6),
		* so the panel polls the host's read-only HTTP projection:
		*
		*   GET <route>?id=<fid>       → one factory's full snapshot (explicit pick)
		*   GET <route>?sessionId=<s>  → the factory owned by that session (§7.2)
		*   GET <route>                → the cross-workspace factory **index** (§7.3)
		*
		* Design rules baked in here:
		*
		*   - **1 s interval, never overlapping.** The tick is skipped while a request
		*     is still in flight, so a slow or wedged host can never build a queue.
		*   - **Shape validation.** The payload is untrusted input: the top level is
		*     checked before anything is accepted, and each array item is normalized
		*     item by item. A malformed payload is reported as a link failure, not
		*     rendered.
		*   - **Last-known-good retention.** A host restart drops the route for a few
		*     seconds. The previous snapshot stays on screen and the link reports
		*     `stale` instead of blanking the panel.
		*   - **The index is not a snapshot.** §7.3 gives the bare route five summary
		*     fields per factory and no collections. It feeds the picker; it can never
		*     supply the panel body, because promoting one of its rows would put an
		*     unrelated workspace's project on screen.
		*   - **No data yet is a state, not an error.** An empty index is `idle`, which
		*     the cockpit renders as its waiting empty state.
		*
		* @module dsh-code-factory/client/api
		*/
		/** HTTP projection registered by the host half (`cordis.patch.yml` companion). */
		const CODE_FACTORY_STATE_ROUTE = "/plugins/code-factory/state";
		/** Polling cadence. One second is the documented cockpit contract. */
		const FACTORY_POLL_MS = 1e3;
		/** Query parameter carrying the selected factory id. */
		const FACTORY_ID_PARAM = "id";
		/** Query parameter carrying the session whose factory should be reported. */
		const SESSION_ID_PARAM = "sessionId";
		/**
		* Build the projection URL for one polling scope (docs/API-CONTRACTS.md §7.1).
		*
		* The three shapes are deliberately exclusive, and the client never sends a
		* filesystem path: workspace resolution belongs entirely to the host (§7.2).
		*
		* - `factoryId`  → `?id=<factoryId>`    one factory's snapshot
		* - `sessionId`  → `?sessionId=<sid>`   the factory owned by that session
		* - neither      → the bare route        the cross-workspace factory index
		*
		* @param route - projection route.
		* @param factoryId - explicit factory selection, when one was made.
		* @param sessionId - session scope, used by session-bound surfaces.
		* @returns the request URL.
		*/
		function factoryStateUrl(route, factoryId, sessionId) {
			if (factoryId !== void 0 && factoryId !== "") return `${route}?id=${encodeURIComponent(factoryId)}`;
			if (sessionId !== void 0 && sessionId !== "") return `${route}?${SESSION_ID_PARAM}=${encodeURIComponent(sessionId)}`;
			return route;
		}
		function isRecord$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function asString(value) {
			return typeof value === "string" ? value : void 0;
		}
		function asNumber(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : void 0;
		}
		/**
		* Accept a rendered counter: a whole, non-negative number.
		*
		* Counters are printed directly ("总教训 -1" / "×0.5" would be nonsense), so a
		* finite number is not enough — a fractional or negative one is a shape we do
		* not understand and is treated as unreadable rather than coerced.
		*
		* @param value - untrusted wire value.
		* @returns the value when it is a non-negative integer, else `undefined`.
		*/
		function asCount(value) {
			return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
		}
		function asArray(value) {
			return Array.isArray(value) ? value : void 0;
		}
		/**
		* DoD check kinds, kept local because `src/shared/types.ts` exports the
		* {@link DodKind} union but no runtime whitelist for it (unlike the state
		* unions). Used only to narrow display text: an unknown kind is dropped rather
		* than rendered as a guessed check.
		*/
		const DOD_KINDS = [
			"file",
			"keyword",
			"script",
			"git",
			"crossref"
		];
		/**
		* How deep a composite gate's nested checks are followed. A self-referential or
		* pathologically nested payload must not recurse forever in the browser.
		*/
		const GATE_DEPTH_LIMIT = 4;
		/**
		* Validate one gate rule, including the nested checks of a composite.
		*
		* A gate whose `type` is unknown is not a rule the panel can explain, so it is
		* dropped (`undefined`); every other field is optional and kept only when
		* readable. Composite children are normalized recursively under
		* {@link GATE_DEPTH_LIMIT}.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @param depth - current nesting depth (0 for the stage's own gate).
		* @returns the normalized gate, or `undefined` when the shape is wrong.
		*/
		function normalizeGateDef(raw, depth = 0) {
			if (depth > GATE_DEPTH_LIMIT || !isRecord$1(raw)) return void 0;
			const type = knownOf(GATE_TYPES, raw.type);
			if (type === void 0) return void 0;
			const gate = { type };
			const artifact = asString(raw.artifact);
			const rawSections = asArray(raw.requiredSections);
			const requiredSections = rawSections === void 0 ? void 0 : rawSections.filter((section) => typeof section === "string" && section.trim() !== "");
			const passWord = asString(raw.passWord);
			const failWord = asString(raw.failWord);
			const run = asString(raw.run);
			const rawChecks = asArray(raw.checks);
			const checks = rawChecks === void 0 ? void 0 : rawChecks.map((check) => normalizeGateDef(check, depth + 1)).filter((check) => check !== void 0);
			return {
				...gate,
				...artifact === void 0 ? {} : { artifact },
				...requiredSections === void 0 ? {} : { requiredSections },
				...passWord === void 0 ? {} : { passWord },
				...failWord === void 0 ? {} : { failWord },
				...run === void 0 ? {} : { run },
				...checks === void 0 ? {} : { checks }
			};
		}
		/**
		* Validate one recorded gate verdict.
		*
		* The verdict is audit evidence, so `type` / `detail` / `at` must be readable;
		* `ok` defaults to false (never a passed gate by accident) and the optional
		* exit code / artifact are kept only when present.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized verdict, or `undefined` when the shape is wrong.
		*/
		function normalizeGateResult(raw) {
			if (!isRecord$1(raw)) return void 0;
			const type = knownOf(GATE_TYPES, raw.type);
			const detail = asString(raw.detail);
			const at = asNumber(raw.at);
			if (type === void 0 || detail === void 0 || at === void 0) return void 0;
			const exitCode = asNumber(raw.exitCode);
			const artifact = asString(raw.artifact);
			return {
				type,
				ok: raw.ok === true,
				detail,
				at,
				...exitCode === void 0 ? {} : { exitCode },
				...artifact === void 0 ? {} : { artifact }
			};
		}
		/**
		* Accept a wire value that must be one of a fixed vocabulary.
		*
		* The lookup walks the allowed union, so no cast is needed to compare an
		* incoming `string` against it and the result keeps the union's literal type.
		*
		* @param allowed - the closed vocabulary.
		* @param value - untrusted wire value.
		* @param fallback - value used when the wire value is absent or unknown.
		* @returns a member of `allowed`.
		*/
		function oneOf(allowed, value, fallback) {
			if (typeof value !== "string") return fallback;
			return allowed.find((candidate) => candidate === value) ?? fallback;
		}
		/**
		* Narrow an untrusted wire value to one of a fixed vocabulary.
		*
		* @param allowed - the closed vocabulary.
		* @param value - untrusted wire value.
		* @returns the matching member, or `undefined` when the value is unknown.
		*/
		function knownOf(allowed, value) {
			if (typeof value !== "string") return void 0;
			return allowed.find((candidate) => candidate === value);
		}
		function normalizeMember(raw) {
			if (!isRecord$1(raw)) return void 0;
			const role = asString(raw.role);
			if (!role) return void 0;
			return attachOptionals({
				role,
				title: asString(raw.title) ?? role,
				codename: asString(raw.codename) ?? role.toUpperCase(),
				color: asString(raw.color) ?? "",
				duties: asString(raw.duties) ?? "",
				tier: raw.tier === "reasoner" ? "reasoner" : "chat",
				status: oneOf(MEMBER_STATUSES, raw.status, "staged"),
				tokens: asNumber(raw.tokens) ?? 0
			}, raw);
		}
		/** Copy the optional fields without ever writing an explicit `undefined`. */
		function attachOptionals(member, raw) {
			const currentStage = asString(raw.currentStage);
			const sessionId = asString(raw.sessionId);
			const spawnError = asString(raw.spawnError);
			const provider = asString(raw.provider);
			const model = asString(raw.model);
			const reasoningEffort = asString(raw.reasoningEffort);
			const startedAt = asNumber(raw.startedAt);
			const endedAt = asNumber(raw.endedAt);
			return {
				...member,
				...currentStage === void 0 ? {} : { currentStage },
				...sessionId === void 0 ? {} : { sessionId },
				...spawnError === void 0 ? {} : { spawnError },
				...provider === void 0 ? {} : { provider },
				...model === void 0 ? {} : { model },
				...reasoningEffort === void 0 ? {} : { reasoningEffort },
				...startedAt === void 0 ? {} : { startedAt },
				...endedAt === void 0 ? {} : { endedAt }
			};
		}
		function normalizeStage(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asString(raw.id);
			if (!id) return void 0;
			const failGoto = asString(raw.failGoto);
			const maxRounds = asCount(raw.maxRounds);
			const attempts = asCount(raw.attempts);
			const startedAt = asNumber(raw.startedAt);
			const endedAt = asNumber(raw.endedAt);
			const lastGate = normalizeGateResult(raw.lastGate);
			const gate = normalizeGateDef(raw.gate);
			return {
				id,
				name: asString(raw.name) ?? id,
				status: oneOf(STAGE_STATUSES, raw.status, "pending"),
				round: asNumber(raw.round) ?? 0,
				roles: (asArray(raw.roles) ?? []).filter((role) => typeof role === "string"),
				parallel: raw.parallel === true,
				humanApproval: raw.humanApproval === true,
				gateType: knownOf(GATE_TYPES, raw.gateType) ?? "unknown",
				...failGoto === void 0 ? {} : { failGoto },
				...maxRounds === void 0 ? {} : { maxRounds },
				...attempts === void 0 ? {} : { attempts },
				...startedAt === void 0 ? {} : { startedAt },
				...endedAt === void 0 ? {} : { endedAt },
				...lastGate === void 0 ? {} : { lastGate },
				...gate === void 0 ? {} : { gate }
			};
		}
		function normalizeDod(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asNumber(raw.id);
			if (id === void 0) return void 0;
			const evidence = asString(raw.evidence);
			const status = DOD_STATUSES.find((candidate) => candidate === raw.status);
			const kind = knownOf(DOD_KINDS, raw.kind);
			const artifact = asString(raw.artifact);
			const expect = asString(raw.expect);
			const run = asString(raw.run);
			const item = {
				id,
				label: asString(raw.label) ?? String(id),
				ok: raw.ok === true,
				...status === void 0 ? {} : { status },
				...kind === void 0 ? {} : { kind },
				...artifact === void 0 ? {} : { artifact },
				...expect === void 0 ? {} : { expect },
				...run === void 0 ? {} : { run },
				...raw.securityOnly === true ? { securityOnly: true } : {}
			};
			return evidence === void 0 ? item : {
				...item,
				evidence
			};
		}
		function normalizeArtifact(raw) {
			if (!isRecord$1(raw)) return void 0;
			const path = asString(raw.path);
			if (!path) return void 0;
			return {
				path,
				by: asString(raw.by) ?? "",
				stage: asString(raw.stage) ?? "",
				bytes: asNumber(raw.bytes) ?? 0,
				at: asNumber(raw.at) ?? 0
			};
		}
		/**
		* Endpoint shown for a feed row whose `from`/`to` could not be read.
		*
		* A feed row is the one place the panel speaks for two parties at once, and a
		* malformed one used to be attributed to `system → captain`: names the durable
		* record never contained, rendered as an authoritative sender and recipient.
		* A row that cannot be attributed carries this marker instead — the row is still
		* shown (something did arrive, and its body may still be readable), but the
		* endpoint renders as unparsed rather than as a party that never wrote.
		*/
		const UNKNOWN_ENDPOINT = "unknown";
		/**
		* Read one feed endpoint.
		*
		* Unlike the other optional fields, `from`/`to` must not be defaulted to a
		* plausible value: `system` and `captain` are real senders, so substituting one
		* would invent the fact the row is missing.
		*
		* @param value - untrusted wire value.
		* @returns the recorded endpoint, or {@link UNKNOWN_ENDPOINT} when it is absent
		*   or blank.
		*/
		function endpointOf(value) {
			const text = asString(value);
			if (text === void 0 || text.trim() === "") return UNKNOWN_ENDPOINT;
			return text;
		}
		function normalizeMessage(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asString(raw.id);
			const ts = asNumber(raw.ts);
			if (!id || ts === void 0) return void 0;
			const message = {
				id,
				from: endpointOf(raw.from),
				to: endpointOf(raw.to),
				content: asString(raw.content) ?? "",
				ts
			};
			const kind = knownOf(MESSAGE_KINDS, raw.kind);
			const stage = asString(raw.stage);
			const round = asNumber(raw.round);
			const deliveredAt = asNumber(raw.deliveredAt);
			const readAt = asNumber(raw.readAt);
			return {
				...message,
				...kind === void 0 ? {} : { kind },
				...stage === void 0 ? {} : { stage },
				...round === void 0 ? {} : { round },
				...deliveredAt === void 0 ? {} : { deliveredAt },
				...readAt === void 0 ? {} : { readAt }
			};
		}
		/**
		* Validate one payload entry as an alert.
		*
		* An alert with an unknown `kind` or `severity` is dropped rather than coerced:
		* a banner that says nothing useful is worse than no banner, and the whitelists
		* come from `src/shared/types.ts` so they cannot drift from the server.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized alert, or `undefined` when the shape is wrong.
		*/
		function normalizeAlert(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asString(raw.id);
			const title = asString(raw.title);
			const detail = asString(raw.detail);
			const next = asString(raw.next);
			const kind = knownOf(ALERT_KINDS, raw.kind);
			const severity = knownOf(ALERT_SEVERITIES, raw.severity);
			if (!id || !title || kind === void 0 || severity === void 0) return void 0;
			const stage = asString(raw.stage);
			const role = asString(raw.role);
			return {
				id,
				kind,
				severity,
				title,
				detail: detail ?? "",
				next: next ?? "",
				...stage === void 0 ? {} : { stage },
				...role === void 0 ? {} : { role }
			};
		}
		function normalizeList(value, item) {
			const list = asArray(value);
			if (!list) return [];
			const out = [];
			for (const raw of list) {
				const normalized = item(raw);
				if (normalized !== void 0) out.push(normalized);
			}
			return out;
		}
		/**
		* Validate one payload entry as an evolution lesson.
		*
		* The ledger is a durable file written by hosts of different plugin versions,
		* so a row lacking its identity (`id` / `role` / `stage` / `text`) is dropped:
		* it cannot name a role, a stage, or the action to take, so showing it would
		* be a card that says nothing. Optional audit fields are kept only when the
		* wire value is readable — never written back as an explicit `undefined`.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized lesson, or `undefined` when the shape is wrong.
		*/
		function normalizeLesson(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asString(raw.id);
			const role = asString(raw.role);
			const stage = asString(raw.stage);
			const text = asString(raw.text);
			if (id === void 0 || role === void 0 || stage === void 0 || text === void 0) return void 0;
			const lesson = {
				id,
				role,
				stage,
				gateType: asString(raw.gateType) ?? "",
				kind: knownOf(LESSON_KINDS, raw.kind) ?? "gate",
				text,
				count: asNumber(raw.count) ?? 1,
				firstAt: asNumber(raw.firstAt) ?? 0,
				lastAt: asNumber(raw.lastAt) ?? 0
			};
			const stageName = asString(raw.stageName);
			const detail = asString(raw.detail);
			const resolvedAt = asNumber(raw.resolvedAt);
			const factoryId = asString(raw.factoryId);
			const taskType = asString(raw.taskType);
			return {
				...lesson,
				...stageName === void 0 ? {} : { stageName },
				...detail === void 0 ? {} : { detail },
				...resolvedAt === void 0 ? {} : { resolvedAt },
				...factoryId === void 0 ? {} : { factoryId },
				...taskType === void 0 ? {} : { taskType }
			};
		}
		/**
		* Validate the evolution roll-up counters.
		*
		* The three counters are the only reason the section exists without lessons;
		* a payload missing any of them — or carrying a negative/fractional one — is a
		* shape we do not know how to render, so the whole projection is rejected (and
		* the section omitted) rather than shown as zeroes that would read as "nothing
		* was ever learned", or as a literal "-1 lessons".
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized stats, or `undefined` when the shape is wrong.
		*/
		function normalizeEvolutionStats(raw) {
			if (!isRecord$1(raw)) return void 0;
			const total = asCount(raw.total);
			const recurring = asCount(raw.recurring);
			const resolved = asCount(raw.resolved);
			if (total === void 0 || recurring === void 0 || resolved === void 0) return void 0;
			const lastAt = asNumber(raw.lastAt);
			return lastAt === void 0 ? {
				total,
				recurring,
				resolved
			} : {
				total,
				recurring,
				resolved,
				lastAt
			};
		}
		/**
		* Validate one evolution payload entry as a plugin-improvement proposal.
		*
		* A proposal without its actionable core (`id` / `title` / `suggestion` /
		* `rationale`), or with an unknown `target`/`status`, is dropped: it cannot tell
		* a human where to change the plugin or what state the evidence is in. The
		* optional fields are kept only when readable.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized proposal, or `undefined` when the shape is wrong.
		*/
		function normalizeImprovement(raw) {
			if (!isRecord$1(raw)) return void 0;
			const id = asString(raw.id);
			const title = asString(raw.title);
			const suggestion = asString(raw.suggestion);
			const rationale = asString(raw.rationale);
			const target = knownOf(IMPROVEMENT_TARGETS, raw.target);
			const status = knownOf(IMPROVEMENT_STATUSES, raw.status);
			if (id === void 0 || title === void 0 || suggestion === void 0 || rationale === void 0 || target === void 0 || status === void 0) return;
			const targetFile = asString(raw.targetFile);
			const role = asString(raw.role);
			const stage = asString(raw.stage);
			const gateType = asString(raw.gateType);
			const rawLessonIds = asArray(raw.lessonIds);
			const lessonIds = rawLessonIds === void 0 ? [] : rawLessonIds.filter((lessonId) => typeof lessonId === "string" && lessonId.trim() !== "");
			return {
				id,
				title,
				target,
				...targetFile === void 0 ? {} : { targetFile },
				suggestion,
				rationale,
				...role === void 0 ? {} : { role },
				...stage === void 0 ? {} : { stage },
				...gateType === void 0 ? {} : { gateType },
				lessonIds,
				evidenceCount: asCount(raw.evidenceCount) ?? 0,
				status,
				lastAt: asNumber(raw.lastAt) ?? 0
			};
		}
		/**
		* Defensively parse the cockpit's read-only evolution projection.
		*
		* `evolution` is optional on the wire (an older host omits it entirely), and a
		* malformed one must never blank the cockpit: anything unreadable becomes
		* `undefined`, which the panel renders as "no evolution section" while the
		* three columns keep working.
		*
		* `improvements` follows a narrower rule: a missing/non-array value is simply
		* omitted (the panel derives proposals from the lessons instead), while an array
		* keeps its readable rows and drops malformed ones — a bad proposal must never
		* take the evolution section down with it.
		*
		* @param raw - decoded JSON value of unknown provenance.
		* @returns the normalized projection, or `undefined` when the shape is wrong.
		*/
		function normalizeEvolution(raw) {
			if (!isRecord$1(raw)) return void 0;
			const stats = normalizeEvolutionStats(raw.stats);
			const lessons = asArray(raw.lessons);
			if (stats === void 0 || lessons === void 0) return void 0;
			const rawImprovements = asArray(raw.improvements);
			const improvements = rawImprovements === void 0 ? void 0 : normalizeList(rawImprovements, normalizeImprovement);
			return {
				stats,
				lessons: normalizeList(lessons, normalizeLesson),
				...improvements === void 0 ? {} : { improvements }
			};
		}
		/**
		* Validate one payload entry as a factory snapshot.
		*
		* Strict on identity and phase (`id`, `phase`), lenient on the collections:
		* a single malformed member row must not blank the whole cockpit. The optional
		* `evolution` projection follows the same rule — unreadable becomes absent
		* ({@link normalizeEvolution}), never a thrown poll or a blank panel.
		*
		* @param value - decoded JSON value of unknown provenance.
		* @returns the normalized snapshot, or `undefined` when the shape is wrong.
		*/
		function normalizeSnapshot(value) {
			if (!isRecord$1(value)) return void 0;
			const id = asString(value.id);
			if (!id) return void 0;
			const phase = oneOf(FACTORY_PHASES, value.phase, "staged");
			const createdAt = asNumber(value.createdAt) ?? 0;
			const snapshot = {
				id,
				name: asString(value.name) ?? id,
				brief: asString(value.brief) ?? "",
				taskType: asString(value.taskType) ?? "",
				pipeline: asString(value.pipeline) ?? "",
				phase,
				securityTriggered: value.securityTriggered === true,
				members: normalizeList(value.members, normalizeMember),
				stages: normalizeList(value.stages, normalizeStage),
				dod: normalizeList(value.dod, normalizeDod),
				artifacts: normalizeList(value.artifacts, normalizeArtifact),
				feed: normalizeList(value.feed, normalizeMessage),
				alerts: normalizeList(value.alerts, normalizeAlert),
				createdAt,
				updatedAt: asNumber(value.updatedAt) ?? createdAt
			};
			const planReviewState = asString(value.planReviewState);
			let result = snapshot;
			if (planReviewState === "awaiting_review" || planReviewState === "awaiting_feedback") result = {
				...result,
				planReviewState
			};
			const evolution = normalizeEvolution(value.evolution);
			if (evolution !== void 0) result = {
				...result,
				evolution
			};
			const approvedAt = asNumber(value.approvedAt);
			if (approvedAt !== void 0) result = {
				...result,
				approvedAt
			};
			const rawHits = asArray(value.securityHits);
			if (rawHits !== void 0) result = {
				...result,
				securityHits: rawHits.filter((hit) => typeof hit === "string" && hit.trim() !== "")
			};
			const securitySource = knownOf(SECURITY_SIGNAL_SOURCES, value.securitySource);
			if (securitySource !== void 0) result = {
				...result,
				securitySource
			};
			const deliveryPath = asString(value.deliveryPath);
			if (deliveryPath !== void 0) result = {
				...result,
				deliveryPath
			};
			return result;
		}
		/**
		* Collections a full `FactorySnapshot` always carries and an index summary
		* never does.
		*
		* docs/API-CONTRACTS.md §7.3 pins the index shape to five fields
		* (`id` / `name` / `taskType` / `phase` / `updatedAt`) precisely so a 1-second
		* poll stays cheap. These two are the ones the cockpit cannot render without,
		* so their absence is what separates "a factory with no members yet" from
		* "a summary of a factory we have not read yet".
		*/
		const SNAPSHOT_MARKERS = ["members", "stages"];
		/**
		* Whether a payload entry is a full snapshot rather than an index summary.
		*
		* @param value - one decoded payload entry.
		* @returns true when the entry carries the snapshot-only collections.
		*/
		function isFullSnapshot(value) {
			return isRecord$1(value) && SNAPSHOT_MARKERS.every((key) => Array.isArray(value[key]));
		}
		/**
		* Normalize a payload while keeping the summary/snapshot distinction.
		*
		* Accepts the shapes the host projection may legitimately use — a bare
		* snapshot, `{ snapshot }`, or an index (`{ factories: [...] }` / a top-level
		* array) — so the panel keeps working while the route's envelope settles.
		*
		* @param value - decoded JSON value of unknown provenance.
		* @returns entries newest first, each flagged complete or summary.
		*/
		function normalizePayload(value) {
			const candidates = Array.isArray(value) ? value : isRecord$1(value) ? asArray(value.factories) ?? asArray(value.items) ?? (value.snapshot !== void 0 ? [value.snapshot] : [value]) : [];
			const entries = [];
			for (const candidate of candidates) {
				const snapshot = normalizeSnapshot(candidate);
				if (snapshot) entries.push({
					snapshot,
					complete: isFullSnapshot(candidate)
				});
			}
			entries.sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt);
			return {
				entries,
				factories: entries.map((entry) => entry.snapshot)
			};
		}
		/**
		* Extract every factory a payload describes, shape information discarded.
		*
		* @param value - decoded JSON value of unknown provenance.
		* @returns normalized snapshots, newest first.
		*/
		function normalizeFactories(value) {
			return normalizePayload(value).factories;
		}
		/** Newest first, by the timestamp the header shows for each factory. */
		function sortNewestFirst(list) {
			return [...list].sort((left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt));
		}
		/**
		* Identity of the evolution projection for the poll's "nothing moved" check.
		*
		* `updatedAt` belongs to the factory record, but the lesson ledger is
		* workspace-scoped: a lesson recorded (or resolved) while another factory runs
		* changes what this panel projects without touching this factory's
		* `updatedAt`. Folding the roll-up into the comparison keeps the evolution
		* section live without dropping the last-known-good snapshot every tick.
		*
		* @param snapshot - the snapshot last accepted, when there is one.
		* @returns a string that changes exactly when the projection's summary moves.
		*/
		function evolutionSignature(snapshot) {
			const evolution = snapshot?.evolution;
			if (!evolution) return "—";
			const { total, recurring, resolved, lastAt } = evolution.stats;
			return `${total}/${recurring}/${resolved}/${lastAt ?? 0}/${evolution.lessons.length}`;
		}
		function isBlank(value) {
			return value === void 0 || value === "";
		}
		/**
		* Whether a target names a factory at all.
		*
		* Only a naming request may supply the panel's displayed factory. The bare route
		* returns the **cross-workspace** index (§7.1), so displaying one of its rows
		* would show an unrelated project's factory — the defect this rule removes.
		*
		* @param target - the scope a request used.
		* @returns true when the request asked for one specific factory.
		*/
		function namesFactory(target) {
			return !isBlank(target.factoryId) || !isBlank(target.sessionId);
		}
		/**
		* The session the Conversation is currently showing.
		*
		* A root-scoped slot (`main`) has no session binding of its own, so the identity
		* is read off the session list: the row the main view holds a reference to. This
		* is the modern equivalent of the older `state.current` and the same derivation
		* the reference plugin uses; `mainView` is contributed by
		* `@deepseek-ai/dsh-client-ui-session`.
		*
		* It matters because the panel must speak for **this** session: the host turns
		* `?sessionId=` into that session's workspace and factory (§7.2), which is the
		* only way the client can get at its own project without ever sending a path.
		*
		* @param state - the session list snapshot.
		* @returns the current session id, or `undefined` while none is selected.
		*/
		function currentSessionId(state) {
			return Object.values(state.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
		}
		function describeError(error) {
			if (error instanceof Error) return error.message || error.name;
			return String(error);
		}
		const INITIAL = {
			status: "connecting",
			snapshot: void 0,
			complete: false,
			factories: [],
			lastOkAt: void 0,
			error: void 0,
			refreshing: true
		};
		/**
		* Union one snapshot read into the known factory list.
		*
		* A `?id=` read returns ONE factory, so replacing the list with it would drop
		* every other entry and take the header's picker away right after the panel
		* upgraded. Entries are keyed by id, with the fresh read winning.
		*/
		function mergeFactoryLists(previous, incoming) {
			const byId = new Map(previous.map((factory) => [factory.id, factory]));
			for (const factory of incoming) byId.set(factory.id, factory);
			return sortNewestFirst([...byId.values()]);
		}
		/** Fold one successful read into the previous state, keeping identity when nothing moved. */
		function mergeSuccess(previous, read, at) {
			const factories = read.indexRead ? sortNewestFirst(read.entries.map((entry) => entry.snapshot)) : mergeFactoryLists(previous.factories, read.entries.map((entry) => entry.snapshot));
			const wanted = read.requestedId ?? previous.snapshot?.id;
			const chosen = read.named ? (wanted ? read.entries.find((entry) => entry.snapshot.id === wanted) : void 0) ?? read.entries[0] : void 0;
			const snapshot = chosen?.snapshot;
			const complete = chosen?.complete === true;
			const reset = {
				status: snapshot ? "live" : "idle",
				snapshot,
				complete,
				factories,
				lastOkAt: at,
				error: void 0,
				refreshing: false
			};
			return previous.error === void 0 && previous.refreshing === false && previous.status === reset.status && previous.complete === complete && previous.snapshot?.id === snapshot?.id && previous.snapshot?.updatedAt === snapshot?.updatedAt && evolutionSignature(previous.snapshot) === evolutionSignature(snapshot) && previous.factories.length === factories.length ? previous : reset;
		}
		/** Fold one failed read into the previous state: never drop a snapshot. */
		function mergeFailure(previous, message) {
			const status = previous.snapshot ? "stale" : "error";
			if (previous.status === status && previous.error === message && !previous.refreshing) return previous;
			return {
				...previous,
				status,
				error: message,
				refreshing: false
			};
		}
		/** True for the abort we raise ourselves when the effect tears down. */
		function isAbort(error) {
			return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
		}
		/**
		* Poll the host's factory projection.
		*
		* @param options - polling scope (factory id or session id), cadence, route, and enablement.
		* @returns the current feed state plus a manual `reload`.
		*/
		function useFactoryState(options = {}) {
			const { factoryId, sessionId, pollMs = FACTORY_POLL_MS, route = CODE_FACTORY_STATE_ROUTE, enabled = true } = options;
			const [state, setState] = (0, react.useState)(INITIAL);
			const [nonce, setNonce] = (0, react.useState)(0);
			const inFlight = (0, react.useRef)(false);
			const alive = (0, react.useRef)(true);
			const mounted = (0, react.useRef)(false);
			const scope = (0, react.useRef)({
				factoryId,
				sessionId
			});
			scope.current = {
				factoryId,
				sessionId
			};
			const reload = (0, react.useCallback)(() => setNonce((value) => value + 1), []);
			(0, react.useEffect)(() => {
				alive.current = true;
				let controller;
				const read = async () => {
					if (inFlight.current) return;
					inFlight.current = true;
					controller = new AbortController();
					const target = scope.current;
					const url = factoryStateUrl(route, target.factoryId, target.sessionId);
					try {
						const response = await fetch(url, {
							method: "GET",
							cache: "no-store",
							credentials: "same-origin",
							headers: { accept: "application/json" },
							signal: controller.signal
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = normalizePayload(await response.json());
						if (!alive.current) return;
						setState((previous) => mergeSuccess(previous, {
							entries: payload.entries,
							indexRead: !namesFactory(target),
							named: namesFactory(target),
							requestedId: target.factoryId
						}, Date.now()));
					} catch (error) {
						if (!alive.current || isAbort(error)) return;
						setState((previous) => mergeFailure(previous, describeError(error)));
					} finally {
						inFlight.current = false;
					}
				};
				read();
				if (!enabled) return () => {
					alive.current = false;
					controller?.abort();
					inFlight.current = false;
				};
				const timer = window.setInterval(() => {
					read();
				}, Math.max(200, pollMs));
				return () => {
					alive.current = false;
					window.clearInterval(timer);
					controller?.abort();
					inFlight.current = false;
				};
			}, [
				enabled,
				pollMs,
				route,
				nonce
			]);
			(0, react.useEffect)(() => {
				if (!mounted.current) {
					mounted.current = true;
					return;
				}
				setState((previous) => ({
					...previous,
					status: previous.snapshot ? "live" : "connecting",
					refreshing: true
				}));
				setNonce((value) => value + 1);
			}, [factoryId, sessionId]);
			return {
				...state,
				reload
			};
		}
		/**
		* A wall clock that ticks on its own schedule.
		*
		* The cockpit needs a live clock and elapsed time even while the poll result is
		* unchanged, and the poll must stay free to keep its previous snapshot identity.
		*
		* @param intervalMs - tick period; 1000 by default.
		* @returns the current epoch ms, refreshed every `intervalMs`.
		*/
		function useNow(intervalMs = 1e3) {
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				const timer = window.setInterval(() => setNow(Date.now()), Math.max(200, intervalMs));
				return () => window.clearInterval(timer);
			}, [intervalMs]);
			return now;
		}
		//#endregion
		//#region lib/client/client/layout.js
		/**
		* Panel layout model for the cockpit — a small, pure "dockable board" layer.
		*
		* The cockpit used to be three fixed columns with fixed sections. This module
		* turns it into a layoutable board: every section is a **module**, modules live
		* in one of three columns (`left` / `mid` / `right`) or are hidden, columns have
		* persisted widths, and modules have optional persisted heights and collapsed
		* state. The UI can therefore be dragged/reordered/docked, resized and folded
		* like a Photoshop panel stack — without a layout library and without touching
		* the host half.
		*
		* PURITY CONTRACT: no imports, no I/O in the transforms, no clock, no
		* randomness. The only functions that touch storage are {@link readLayout} /
		* {@link writeLayout}, and both guard `window` so the module stays SSR-safe.
		* Every transform returns a new layout; callers never mutate the input.
		*
		* @module dsh-code-factory/client/layout
		*/
		/** Every module, in canonical order (also the order of the layout menu). */
		const PANEL_MODULE_IDS = [
			"roster",
			"pipeline",
			"inspector",
			"work",
			"feed",
			"artifacts",
			"dod",
			"evolution"
		];
		/** Every column, left to right. */
		const PANEL_COLUMN_IDS = [
			"left",
			"mid",
			"right"
		];
		/** localStorage key for the persisted layout. */
		const LAYOUT_STORAGE_KEY = "dsh-code-factory.layout.v1";
		/** Default width of the two side columns, in px. */
		const DEFAULT_COLUMN_WIDTHS = {
			left: 248,
			right: 380
		};
		/** Column width bounds; the middle column always takes the remaining space. */
		const MIN_COLUMN_WIDTH = 190;
		const MAX_COLUMN_WIDTH = 640;
		/** Module height bounds for a manually resized module. */
		const MIN_MODULE_HEIGHT = 96;
		const MAX_MODULE_HEIGHT = 1200;
		/** Default dock positions; also where a hidden module returns on "show". */
		const DEFAULT_MODULE_COLUMN = {
			roster: "left",
			pipeline: "mid",
			inspector: "mid",
			work: "mid",
			feed: "right",
			artifacts: "right",
			dod: "right",
			evolution: "right"
		};
		/** The default module order per column. */
		const DEFAULT_COLUMN_MODULES = {
			left: ["roster"],
			mid: [
				"pipeline",
				"inspector",
				"work"
			],
			right: [
				"feed",
				"artifacts",
				"dod",
				"evolution"
			]
		};
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/** True when `value` is one of the eight known module ids. */
		function isPanelModuleId(value) {
			return typeof value === "string" && PANEL_MODULE_IDS.includes(value);
		}
		/** True when `value` is one of the three known columns. */
		function isPanelColumnId(value) {
			return typeof value === "string" && PANEL_COLUMN_IDS.includes(value);
		}
		/** A fresh default layout (deep clone; safe to mutate by the caller). */
		function createDefaultLayout() {
			return {
				version: 1,
				columns: {
					left: [...DEFAULT_COLUMN_MODULES.left],
					mid: [...DEFAULT_COLUMN_MODULES.mid],
					right: [...DEFAULT_COLUMN_MODULES.right]
				},
				hidden: [],
				widths: { ...DEFAULT_COLUMN_WIDTHS },
				heights: {},
				collapsed: {}
			};
		}
		/** Reset to the default layout. */
		function resetLayout() {
			return createDefaultLayout();
		}
		function clampDimension(value, min, max, fallback) {
			if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
			return Math.min(max, Math.max(min, Math.round(value)));
		}
		function emptyColumns() {
			return {
				left: [],
				mid: [],
				right: []
			};
		}
		function cloneLayout(layout) {
			return {
				version: 1,
				columns: {
					left: [...layout.columns.left],
					mid: [...layout.columns.mid],
					right: [...layout.columns.right]
				},
				hidden: [...layout.hidden],
				widths: {
					left: layout.widths.left,
					right: layout.widths.right
				},
				heights: { ...layout.heights },
				collapsed: { ...layout.collapsed }
			};
		}
		/**
		* Coerce an untrusted persisted value into a valid layout.
		*
		* The rules are deliberately forgiving — this runs on data the user (or an
		* older plugin) wrote to localStorage, and a broken preference must never take
		* the panel down:
		*
		*  - unknown module ids, non-array columns and duplicate ids are dropped;
		*  - every known module missing from both `columns` and `hidden` is restored to
		*    its default column, so a schema change can never make a module disappear;
		*  - widths/heights are clamped to the published bounds; non-finite values fall
		*    back to the default;
		*  - a value that is not an object at all returns the default layout.
		*
		* @param raw - anything read from storage or passed by a caller.
		* @returns a new, valid layout.
		*/
		function normaliseLayout(raw) {
			const defaults = createDefaultLayout();
			if (!isRecord(raw)) return defaults;
			const columns = emptyColumns();
			const seen = /* @__PURE__ */ new Set();
			const rawColumns = isRecord(raw.columns) ? raw.columns : void 0;
			for (const column of PANEL_COLUMN_IDS) {
				const list = rawColumns?.[column];
				if (!Array.isArray(list)) continue;
				for (const candidate of list) {
					if (!isPanelModuleId(candidate) || seen.has(candidate)) continue;
					seen.add(candidate);
					columns[column].push(candidate);
				}
			}
			const hidden = [];
			if (Array.isArray(raw.hidden)) for (const candidate of raw.hidden) {
				if (!isPanelModuleId(candidate) || seen.has(candidate)) continue;
				seen.add(candidate);
				hidden.push(candidate);
			}
			for (const moduleId of PANEL_MODULE_IDS) {
				if (seen.has(moduleId)) continue;
				seen.add(moduleId);
				columns[DEFAULT_MODULE_COLUMN[moduleId]].push(moduleId);
			}
			const rawWidths = isRecord(raw.widths) ? raw.widths : void 0;
			const widths = {
				left: clampDimension(rawWidths?.left, 190, 640, DEFAULT_COLUMN_WIDTHS.left),
				right: clampDimension(rawWidths?.right, 190, 640, DEFAULT_COLUMN_WIDTHS.right)
			};
			const heights = {};
			const rawHeights = isRecord(raw.heights) ? raw.heights : void 0;
			if (rawHeights !== void 0) for (const moduleId of PANEL_MODULE_IDS) {
				const value = rawHeights[moduleId];
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				heights[moduleId] = clampDimension(value, 96, MAX_MODULE_HEIGHT, 96);
			}
			const collapsed = {};
			const rawCollapsed = isRecord(raw.collapsed) ? raw.collapsed : void 0;
			if (rawCollapsed !== void 0) for (const moduleId of PANEL_MODULE_IDS) {
				const value = rawCollapsed[moduleId];
				if (typeof value === "boolean") collapsed[moduleId] = value;
			}
			return {
				version: 1,
				columns,
				hidden,
				widths,
				heights,
				collapsed
			};
		}
		/** Column a module currently lives in, or `'hidden'`, or `undefined` if unknown. */
		function modulePlacement(layout, moduleId) {
			for (const column of PANEL_COLUMN_IDS) if (layout.columns[column].includes(moduleId)) return column;
			return layout.hidden.includes(moduleId) ? "hidden" : void 0;
		}
		/** Every visible module id, left to right / top to bottom. */
		function visibleModuleIds(layout) {
			return PANEL_COLUMN_IDS.flatMap((column) => layout.columns[column]);
		}
		/** True when the module is visible (in a column) rather than hidden. */
		function isModuleVisible(layout, moduleId) {
			return modulePlacement(layout, moduleId) !== "hidden" && modulePlacement(layout, moduleId) !== void 0;
		}
		function removeEverywhere(layout, moduleId) {
			const next = cloneLayout(layout);
			const columns = {
				left: next.columns.left.filter((id) => id !== moduleId),
				mid: next.columns.mid.filter((id) => id !== moduleId),
				right: next.columns.right.filter((id) => id !== moduleId)
			};
			return {
				...next,
				columns,
				hidden: next.hidden.filter((id) => id !== moduleId)
			};
		}
		/**
		* Move a module into `column` at `index` (insertion index after removal).
		*
		* A hidden module becomes visible again as part of the move. An out-of-range
		* index is clamped; omitting it appends. Moving a module to its current place
		* still returns an equal layout (callers can cheaply skip a write).
		*
		* @param layout - current layout.
		* @param moduleId - module to move.
		* @param column - destination column.
		* @param index - insertion index after the module is removed (default: append).
		* @returns a new layout.
		*/
		function moveModule(layout, moduleId, column, index) {
			const base = removeEverywhere(normaliseLayout(layout), moduleId);
			const target = [...base.columns[column]];
			const at = typeof index === "number" && Number.isFinite(index) ? Math.min(target.length, Math.max(0, Math.trunc(index))) : target.length;
			target.splice(at, 0, moduleId);
			return {
				...base,
				columns: {
					...base.columns,
					[column]: target
				}
			};
		}
		/** Hide a module (it can be restored from the layout menu). */
		function hideModule(layout, moduleId) {
			const base = removeEverywhere(normaliseLayout(layout), moduleId);
			return {
				...base,
				hidden: [...base.hidden, moduleId]
			};
		}
		/** Restore a hidden module to its default column (append position). */
		function showModule(layout, moduleId) {
			const normal = normaliseLayout(layout);
			if (isModuleVisible(normal, moduleId)) return normal;
			const base = removeEverywhere(normal, moduleId);
			const column = DEFAULT_MODULE_COLUMN[moduleId];
			return {
				...base,
				columns: {
					...base.columns,
					[column]: [...base.columns[column], moduleId]
				}
			};
		}
		/** Fold/unfold one module (only the header remains when folded). */
		function setModuleCollapsed(layout, moduleId, collapsed) {
			const base = normaliseLayout(layout);
			return {
				...base,
				collapsed: {
					...base.collapsed,
					[moduleId]: collapsed
				}
			};
		}
		/** Toggle the folded state of one module. */
		function toggleModuleCollapsed(layout, moduleId) {
			return setModuleCollapsed(layout, moduleId, !layout.collapsed[moduleId]);
		}
		/** Resize one side column (the middle column takes the remaining space). */
		function setColumnWidth(layout, side, width) {
			const base = normaliseLayout(layout);
			return {
				...base,
				widths: {
					...base.widths,
					[side]: clampDimension(width, 190, 640, base.widths[side])
				}
			};
		}
		/** Persist one module's height; the column scrolls when its modules exceed it. */
		function setModuleHeight(layout, moduleId, height) {
			const base = normaliseLayout(layout);
			return {
				...base,
				heights: {
					...base.heights,
					[moduleId]: clampDimension(height, 96, MAX_MODULE_HEIGHT, 96)
				}
			};
		}
		/** Drop a persisted height so the module returns to flexible sizing. */
		function clearModuleHeight(layout, moduleId) {
			const base = normaliseLayout(layout);
			const heights = { ...base.heights };
			delete heights[moduleId];
			return {
				...base,
				heights
			};
		}
		/** Copy a layout into a stable JSON string (order-stable for tests/diffs). */
		function serializeLayout(layout) {
			const normal = normaliseLayout(layout);
			return JSON.stringify({
				version: normal.version,
				columns: {
					left: normal.columns.left,
					mid: normal.columns.mid,
					right: normal.columns.right
				},
				hidden: normal.hidden,
				widths: normal.widths,
				heights: normal.heights,
				collapsed: normal.collapsed
			});
		}
		function browserStorage() {
			try {
				if (typeof window === "undefined") return void 0;
				return window.localStorage;
			} catch {
				return;
			}
		}
		/**
		* Read the persisted layout.
		*
		* Missing storage, a missing key, malformed JSON, a throwing storage
		* implementation and an out-of-date shape all fall back to the default layout —
		* a broken preference must never blank the cockpit.
		*
		* @param storage - optional storage face (tests); defaults to `window.localStorage`.
		* @returns a validated layout.
		*/
		function readLayout(storage) {
			try {
				const source = storage === void 0 ? browserStorage() : storage;
				if (source === null || source === void 0) return createDefaultLayout();
				const raw = source.getItem(LAYOUT_STORAGE_KEY);
				if (raw === null || raw === "") return createDefaultLayout();
				return normaliseLayout(JSON.parse(raw));
			} catch {
				return createDefaultLayout();
			}
		}
		/**
		* Persist the layout.
		*
		* Storage failures (quota, disabled cookies, a throwing test double) are
		* swallowed: the in-memory layout is still correct, and the next read simply
		* falls back to the default.
		*
		* @param layout - layout to persist.
		* @param storage - optional storage face (tests); defaults to `window.localStorage`.
		*/
		function writeLayout(layout, storage) {
			try {
				const target = storage === void 0 ? browserStorage() : storage;
				if (target === null || target === void 0) return;
				target.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout));
			} catch {}
		}
		//#endregion
		//#region lib/client/client/styles.js
		/**
		* Cockpit styling: theme tokens + a small scoped stylesheet.
		*
		* Two hard rules from docs/API-CONTRACTS.md §2.5:
		*
		*   1. **Every semantic colour is a `--dsw-alias-*` token.** The panel must
		*      render correctly in both light and dark themes, so no status is ever
		*      expressed with a hard-coded hex value.
		*   2. **The 12 role colours are the prototype's classification palette.** They
		*      have no token because they carry no meaning; they are decoration. They
		*      are always mixed toward `--dsw-alias-label-primary`, which keeps the
		*      chip legible on a light background too. If `color-mix()` is unavailable
		*      the declaration is dropped and the text falls back to the inherited
		*      label colour — the chip never becomes unreadable.
		*
		* Layout is CSS-in-JS over a fixed set of `.cf-*` class names: inline style
		* objects cannot express media queries. Responsive behaviour follows the
		* **browser viewport**, never the width the host hands to the panel: the DSH
		* app sidebar can expand/collapse without changing the cockpit's column mode.
		* Do not reintroduce container queries here — see {@link FACTORY_CSS}.
		*
		* @module dsh-code-factory/client/styles
		*/
		/**
		* The verified theme tokens this panel uses (docs/API-CONTRACTS.md §2.5).
		*
		* Values are `string`: every consumer interpolates them into a `var(...)`
		* expression or hands them to an inline style, where the literal identity of
		* each token adds nothing but a const assertion.
		*/
		const TOKEN = {
			bgBase: "var(--dsw-alias-bg-base)",
			bgLayer1: "var(--dsw-alias-bg-layer-1)",
			bgLayer2: "var(--dsw-alias-bg-layer-2)",
			bgOverlay: "var(--dsw-alias-bg-overlay)",
			borderL1: "var(--dsw-alias-border-l1)",
			borderL2: "var(--dsw-alias-border-l2)",
			brand: "var(--dsw-alias-brand-primary)",
			labelPrimary: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			success: "var(--dsw-alias-state-success-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			idle: "var(--dsw-alias-state-idle-primary)",
			sidebarFill: "var(--dsw-specific-sidebar-fill)"
		};
		/** Member lifecycle → semantic token. `working` is the only "live" state. */
		const MEMBER_STATUS_COLOR = {
			staged: TOKEN.idle,
			idle: TOKEN.idle,
			working: TOKEN.brand,
			rework: TOKEN.warn,
			blocked: TOKEN.error,
			done: TOKEN.success,
			error: TOKEN.error,
			removed: TOKEN.idle
		};
		/** Members whose LED pulses (still owed work). */
		const PULSING_MEMBER_STATUS = {
			staged: false,
			idle: false,
			working: true,
			rework: true,
			blocked: false,
			done: false,
			error: false,
			removed: false
		};
		/** Stage lifecycle → semantic token. */
		const STAGE_STATUS_COLOR = {
			pending: TOKEN.idle,
			active: TOKEN.brand,
			gate: TOKEN.warn,
			passed: TOKEN.success,
			rejected: TOKEN.error
		};
		/** Mailbox message kind → semantic token (the feed's left rule). */
		const FEED_KIND_COLOR = {
			system: TOKEN.idle,
			dispatch: TOKEN.brand,
			handoff: TOKEN.brand,
			report: TOKEN.success,
			approval: TOKEN.warn,
			blocked: TOKEN.warn,
			reject: TOKEN.error
		};
		/** Factory phase → semantic token. */
		const PHASE_COLOR = {
			staged: TOKEN.warn,
			running: TOKEN.brand,
			halted: TOKEN.warn,
			delivered: TOKEN.success,
			discarded: TOKEN.idle
		};
		/** Host link status → semantic token. */
		const LINK_COLOR = {
			idle: TOKEN.idle,
			connecting: TOKEN.warn,
			live: TOKEN.success,
			stale: TOKEN.warn,
			error: TOKEN.error
		};
		/** Alert severity → semantic token: `action` is the danger colour, `attention` the warning colour. */
		const ALERT_SEVERITY_COLOR = {
			action: TOKEN.error,
			attention: TOKEN.warn
		};
		/**
		* Decorative palette keyed by the registry's **canonical** role ids.
		*
		* Keys mirror `src/domain/roles.ts` exactly — the registry roster (including the
		* frontend specialists) plus the add-on jobs — so a lesson card for a role this
		* factory never staffed still gets that role's own colour. Two non-roster parties (`captain` / `system`)
		* are parties the feed can name but the roster never contains; the legacy
		* `sec_eng` spelling is kept as the one alias still found in records written
		* before the registry renamed the security job. Purely decorative: never a
		* status signal.
		*/
		const FALLBACK_ROLE_COLORS = {
			captain: "#22d3ee",
			system: "#94a3b8",
			router: "#22d3ee",
			pm: "#60a5fa",
			ui_designer: "#e879f9",
			sys_arch: "#a78bfa",
			db_arch: "#818cf8",
			api_designer: "#38bdf8",
			security_eng: "#fbbf24",
			fe_dev: "#34d399",
			be_dev: "#2dd4bf",
			reviewer: "#fb923c",
			qa: "#f87171",
			devops: "#94a3b8",
			perf: "#a3e635",
			po: "#f0abfc",
			tech_writer: "#7dd3fc",
			web_dev: "#10b981",
			flutter_dev: "#06b6d4",
			mini_program_dev: "#ec4899",
			sec_eng: "#fbbf24"
		};
		/** Resolve a role's decorative swatch from the snapshot, falling back to the palette. */
		function roleSwatch(role, color) {
			if (color && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
			return FALLBACK_ROLE_COLORS[role] ?? "#7c8db0";
		}
		/** Legible role ink: the swatch pulled toward the theme's label colour. */
		function roleInk(swatch) {
			return `color-mix(in oklab, ${swatch} 72%, ${TOKEN.labelPrimary})`;
		}
		/**
		* A translucent wash of any colour — a token or a role swatch.
		*
		* @param color - any CSS colour, including a `--dsw-*` token reference.
		* @param percent - how much of it to keep.
		* @returns a `color-mix()` expression; engines without support drop the
		*   declaration and fall back to whatever the cascade already provided.
		*/
		function wash(color, percent) {
			return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
		}
		/**
		* One scoped stylesheet for the cockpit, its sidebar entry, and the turn card.
		*
		* Responsive layout follows the **viewport**, not the host panel width. The DSH
		* app sidebar changes the width the host gives this panel; if the rules below
		* reacted to that width, expanding the sidebar would sink the right column while
		* collapsing it restored the wide three-column board — a layout the user cannot
		* control from inside the cockpit. Only the browser-window `@media` breakpoints
		* may stack the columns. (Container queries were removed for exactly this
		* reason: `.cf-root` no longer declares itself a query container.)
		*/
		const FACTORY_CSS = `
.cf-root{
  position:relative;display:flex;flex-direction:column;box-sizing:border-box;
  width:100%;height:100%;min-height:0;flex:1 1 auto;overflow:hidden;
  background:${TOKEN.bgBase};color:${TOKEN.labelPrimary};
  font-size:12px;line-height:1.5;
}
.cf-mono{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono','Cascadia Mono',Menlo,Consolas,'Noto Sans SC',monospace}
.cf-scan{
  position:absolute;inset:0;z-index:4;pointer-events:none;
  background:repeating-linear-gradient(to bottom,transparent 0 2px,color-mix(in oklab,${TOKEN.labelPrimary} 3%,transparent) 3px);
  opacity:.55;
}
.cf-scroll{scrollbar-width:thin;scrollbar-color:${TOKEN.borderL2} transparent}
.cf-scroll::-webkit-scrollbar{width:6px;height:6px}
.cf-scroll::-webkit-scrollbar-track{background:transparent}
.cf-scroll::-webkit-scrollbar-thumb{background:${TOKEN.borderL2};border-radius:3px}

/* ---------------------------------------------------------------- header */
.cf-header{
  flex:none;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:8px 14px;border-bottom:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer1};
}
.cf-brand{display:flex;align-items:center;gap:9px;min-width:0}
.cf-brand-name{font-size:13px;font-weight:700;letter-spacing:.18em;color:${TOKEN.brand}}
.cf-brand-sub{font-size:9px;letter-spacing:.2em;color:${TOKEN.labelSecondary};white-space:nowrap}
.cf-badge{
  display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:4px;
  border:1px solid ${TOKEN.borderL1};
  font-size:10px;letter-spacing:.16em;white-space:nowrap;
}
.cf-chip{
  display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border-radius:3px;
  border:1px solid ${TOKEN.borderL2};font-size:9px;white-space:nowrap;
}
.cf-mission{flex:1 1 260px;min-width:180px}
.cf-mission-line{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:9px;letter-spacing:.12em;color:${TOKEN.labelSecondary}}
.cf-mission-text{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  font-size:11px;font-weight:600;letter-spacing:.06em;color:${TOKEN.labelPrimary};
  max-width:100%;word-break:break-word;
}
.cf-mission-text-open{display:block;-webkit-line-clamp:unset;overflow:visible}
.cf-mission-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-hits{
  flex:none;display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  padding:4px 14px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
  font-size:9px;color:${TOKEN.labelSecondary};
}
.cf-bar{height:6px;border-radius:3px;background:${TOKEN.bgLayer2};overflow:hidden;margin-top:5px;border:1px solid ${TOKEN.borderL1}}
.cf-bar-fill{height:100%;border-radius:3px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.cf-metrics{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.cf-metric{display:flex;flex-direction:column;gap:1px;min-width:54px}
.cf-metric-k{font-size:8px;letter-spacing:.18em;color:${TOKEN.labelSecondary}}
.cf-metric-v{font-size:12px;color:${TOKEN.labelPrimary}}
.cf-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.cf-select{
  appearance:none;padding:4px 22px 4px 8px;border-radius:4px;font-size:10px;
  color:${TOKEN.labelPrimary};background:${TOKEN.bgLayer2};
  border:1px solid ${TOKEN.borderL1};max-width:190px;
  background-image:linear-gradient(45deg,transparent 50%,${TOKEN.labelSecondary} 50%),linear-gradient(135deg,${TOKEN.labelSecondary} 50%,transparent 50%);
  background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;
  background-size:4px 4px,4px 4px;background-repeat:no-repeat;
}
.cf-select:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-btn{
  display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:4px;cursor:pointer;
  font-size:10px;letter-spacing:.06em;color:${TOKEN.labelPrimary};
  background:${TOKEN.bgLayer2};border:1px solid ${TOKEN.borderL1};
}
.cf-btn:hover{border-color:${TOKEN.brand};color:${TOKEN.brand}}
.cf-btn-on{border-color:${wash(TOKEN.brand, 50)};color:${TOKEN.brand};background:${wash(TOKEN.brand, 10)}}
.cf-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-linkish{
  display:inline-flex;align-items:center;gap:5px;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font-size:10px;letter-spacing:.08em;
}
.cf-linkish:hover{text-decoration:underline}

/* ---------------------------------------------------------------- alerts */
.cf-alerts{
  flex:none;display:flex;flex-direction:column;gap:4px;
  padding:7px 14px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-alert{
  display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
  padding:4px 8px;border-radius:4px;border:1px solid;border-left-width:3px;
}
.cf-alert-title{font-size:11px;font-weight:700}
.cf-alert-detail{font-size:10px;color:${TOKEN.labelSecondary}}
.cf-alert-next{font-size:10px;color:${TOKEN.labelPrimary}}
.cf-alert-chip{
  display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border-radius:3px;
  border:1px solid ${TOKEN.borderL2};font-size:9px;white-space:nowrap;color:${TOKEN.labelSecondary};
}
.cf-alert-more{font-size:9px;color:${TOKEN.labelSecondary}}

/* ------------------------------------------------------------------ body */
.cf-body{
  flex:1 1 auto;min-height:0;display:grid;
  grid-template-columns:var(--cf-left-w,248px) 6px minmax(0,1fr) 6px var(--cf-right-w,380px);
}
.cf-col{display:flex;flex-direction:column;min-width:0;min-height:0;background:${TOKEN.bgLayer1}}
.cf-left{border-right:1px solid ${TOKEN.borderL1};background:${TOKEN.sidebarFill}}
.cf-mid{background:${TOKEN.bgBase}}
.cf-right{border-left:1px solid ${TOKEN.borderL1}}
.cf-col-head{
  flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 12px;border-bottom:1px solid ${TOKEN.borderL1};
}
.cf-col-title{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary}}
.cf-col-note{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-fill{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}

/* ---------------------------------------------------------------- roster */
.cf-role{width:100%;border-left:2px solid transparent;color:inherit}
.cf-role:hover{background:${TOKEN.bgLayer2}}
.cf-role-on{background:${TOKEN.bgLayer2};border-left-color:${TOKEN.brand}}
.cf-role-row{display:flex;align-items:flex-start;gap:2px;padding-right:6px}
.cf-role-main{
  flex:1 1 auto;min-width:0;display:block;text-align:left;padding:7px 0 7px 12px;cursor:pointer;
  background:none;border:0;color:inherit;font:inherit;
}
.cf-role-main:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:-2px}
.cf-role-expand{align-self:flex-start;margin:6px 6px 0 0}
.cf-role-details{
  padding:3px 12px 8px 25px;display:flex;flex-direction:column;gap:3px;
  font-size:9px;color:${TOKEN.labelSecondary};border-top:1px dashed ${TOKEN.borderL1};
}
.cf-roster-tools{
  flex:none;display:flex;flex-direction:column;gap:5px;padding:7px 10px;
  border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-roster-tools .cf-chips{flex-wrap:nowrap;overflow-x:auto;padding-bottom:1px}
/* The roster tools stack vertically, so .cf-search's horizontal flex-basis
   (130px) would otherwise become a growable HEIGHT and stretch the field into a
   tall block. Pin it to one line here; the horizontal toolbar rules stay intact. */
.cf-roster-tools .cf-search{
  flex:0 0 auto;align-self:stretch;width:100%;max-width:none;
  box-sizing:border-box;height:26px;min-height:26px;max-height:26px;
}
.cf-roster-tools .cf-search input{height:100%;box-sizing:border-box}
.cf-role-top{display:flex;align-items:center;gap:7px}
.cf-role-name{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-role-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;padding-left:25px;font-size:9px}
.cf-role-state{display:inline-flex;align-items:center;gap:5px;min-width:0}
.cf-role-note{margin-top:3px;padding-left:25px;font-size:9px;color:${TOKEN.labelSecondary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-avatar{
  display:block;flex:none;
  font-family:ui-monospace,SFMono-Regular,'JetBrains Mono','Cascadia Mono',Menlo,Consolas,'Noto Sans SC',monospace;
}
.cf-led{width:8px;height:8px;border-radius:9999px;flex:none;background:currentColor}
.cf-led-pulse{animation:cf-led-pulse 1.5s ease-in-out infinite}
@keyframes cf-led-pulse{
  0%,100%{opacity:1;box-shadow:0 0 6px 1px currentColor}
  50%{opacity:.45;box-shadow:0 0 2px 0 currentColor}
}
.cf-legend{
  flex:none;padding:8px 12px;border-top:1px solid ${TOKEN.borderL1};
  font-size:9px;color:${TOKEN.labelSecondary};display:flex;flex-direction:column;gap:4px;
}
.cf-legend-row{display:flex;align-items:center;justify-content:space-between;gap:8px}

/* -------------------------------------------------------------- pipeline */
.cf-pipe{flex:none;padding:10px 14px 8px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1}}
.cf-pipe-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.cf-pipe-track{display:flex;align-items:center;gap:0;overflow-x:auto;padding-bottom:4px}
.cf-stage{
  position:relative;display:flex;align-items:center;gap:5px;flex:none;
  padding:5px 9px;border-radius:4px;border:1px solid;font-size:10px;white-space:nowrap;
  transition:border-color .3s ease,color .3s ease,background-color .3s ease;
}
.cf-stage-name{max-width:130px;overflow:hidden;text-overflow:ellipsis}
.cf-stage-status{font-size:8px;opacity:.8;white-space:nowrap}
.cf-stage-btn{cursor:pointer;font:inherit;font-family:inherit;appearance:none}
.cf-stage-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-stage-on{box-shadow:inset 0 0 0 1px currentColor}
.cf-stage-goto{font-size:10px;opacity:.85}
.cf-conn{flex:none;margin:0 2px}
.cf-flow{stroke-dasharray:5 5;animation:cf-flow-dash 1.2s linear infinite}
@keyframes cf-flow-dash{to{stroke-dashoffset:-10}}
.cf-sweep{animation:cf-sweep 4.2s linear infinite;transform-origin:center}
@keyframes cf-sweep{to{transform:rotate(360deg)}}
.cf-pipe-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:8px;letter-spacing:.1em;color:${TOKEN.labelSecondary}}
.cf-pipe-legend-item{display:inline-flex;align-items:center;gap:5px}

/* ----------------------------------------------------------- work output */
.cf-work{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.cf-work-head{flex:none;display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid ${TOKEN.borderL1}}
.cf-work-avatar{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px}
.cf-work-code{font-size:8px;letter-spacing:.1em;line-height:1;white-space:nowrap}
.cf-work-id{flex:1 1 auto;min-width:0}
.cf-work-name{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.cf-work-duties{font-size:9px;color:${TOKEN.labelSecondary};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-work-side{flex:none;text-align:right;font-size:9px;color:${TOKEN.labelSecondary};display:flex;flex-direction:column;gap:3px;align-items:flex-end}
.cf-stream{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 14px 16px;background:${TOKEN.bgBase}}
.cf-stream-head{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary};margin-bottom:8px}
.cf-msg{
  border-left:3px solid;border-radius:0 4px 4px 0;padding:5px 8px;margin-bottom:7px;
  background:${TOKEN.bgLayer1};animation:cf-ev-in .35s cubic-bezier(.22,1,.36,1) both;
}
@keyframes cf-ev-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.cf-msg-meta{display:flex;align-items:center;gap:8px;font-size:8px;letter-spacing:.1em;color:${TOKEN.labelSecondary};flex-wrap:wrap}
.cf-msg-sender{display:inline-flex;align-items:center;gap:4px;min-width:0}
.cf-msg-body{margin-top:3px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:${TOKEN.labelPrimary}}
.cf-cursor::after{content:'▊';margin-left:2px;color:${TOKEN.brand};animation:cf-cursor-blink .9s steps(1) infinite}
@keyframes cf-cursor-blink{50%{opacity:0}}
.cf-halt{flex:none;display:flex;align-items:center;gap:10px;padding:7px 14px;border-top:1px solid ${TOKEN.borderL1};font-size:9px;color:${TOKEN.labelSecondary}}
.cf-meter{flex:1 1 auto;height:4px;border-radius:2px;background:${TOKEN.bgLayer2};overflow:hidden;border:1px solid ${TOKEN.borderL1}}
.cf-meter-fill{height:100%;transition:width .5s cubic-bezier(.22,1,.36,1)}

/* ------------------------------------------------------------ right column
   One scroll container holds all three always-on sections. Each header sticks
   to the top of the scrollport while its own rows scroll under it; the section
   boundary supplies the divider so a pinned header still reads as a header. */
.cf-right-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column}
.cf-right-section{display:flex;flex-direction:column;min-width:0;min-height:0;flex:0 0 auto}
.cf-right-section + .cf-right-section{border-top:1px solid ${TOKEN.borderL1}}
.cf-right-head{
  position:sticky;top:0;z-index:2;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:7px 12px;background:${TOKEN.bgLayer1};border-bottom:1px solid ${TOKEN.borderL1};
}
.cf-pad{padding:10px}
.cf-dod-summary{text-align:center;margin-top:12px;font-size:10px;color:${TOKEN.labelSecondary}}

/* --------------------------------------------------------------- evolution */
.cf-evo-stats{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.cf-evo-stat{
  padding:2px 7px;border-radius:3px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};font-size:9px;color:${TOKEN.labelSecondary};white-space:nowrap;
}
.cf-evo-stat-recurring{border-color:${wash(TOKEN.warn, 40)};color:${TOKEN.warn}}
.cf-evo-stat-resolved{border-color:${wash(TOKEN.success, 40)};color:${TOKEN.success}}
.cf-lesson-resolved{border-color:${wash(TOKEN.success, 30)}}
.cf-lesson-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-lesson-meta .cf-ellipsis{min-width:0;max-width:130px}
.cf-lesson-count{color:${TOKEN.warn};font-weight:700}
.cf-lesson-count-once{color:${TOKEN.labelSecondary};font-weight:400}
.cf-lesson-ok{color:${TOKEN.success};border-color:${wash(TOKEN.success, 45)}}
.cf-evo-empty{padding:10px;border:1px dashed ${TOKEN.borderL1};border-radius:4px;color:${TOKEN.labelSecondary}}
.cf-evo-empty-title{font-size:10px;color:${TOKEN.labelPrimary};margin-bottom:3px}
.cf-evo-empty-body{font-size:9px;line-height:1.65}
.cf-evo-more{font-size:9px;color:${TOKEN.labelSecondary};text-align:center;margin-top:2px}
.cf-card{
  display:flex;align-items:flex-start;gap:9px;padding:7px 9px;border-radius:4px;
  background:${TOKEN.bgLayer2};border:1px solid ${TOKEN.borderL1};margin-bottom:6px;
  animation:cf-ev-in .35s cubic-bezier(.22,1,.36,1) both;
}
.cf-card-main{flex:1 1 auto;min-width:0}
.cf-card-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-card-sub{font-size:8px;color:${TOKEN.labelSecondary};margin-top:2px}
.cf-card-num{flex:none;font-size:9px;color:${TOKEN.labelSecondary}}
.cf-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------------------------------------------------------------- empty */
.cf-empty{
  margin:18px 12px;padding:22px 16px;border:1px dashed ${TOKEN.borderL1};border-radius:6px;
  text-align:center;color:${TOKEN.labelSecondary};
}
.cf-empty-title{font-size:11.5px;color:${TOKEN.labelPrimary};margin-bottom:5px}
.cf-empty-body{font-size:10px;line-height:1.7}
.cf-empty-wide{margin:0;border:0;border-radius:0}

/* ------------------------------------------------------------- turn card */
.cf-card-shell{
  margin:8px 0;padding:9px 11px;border-radius:6px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer1};display:flex;flex-direction:column;gap:7px;
}
.cf-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cf-card-stats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:9px;color:${TOKEN.labelSecondary}}
/* The sidebar renders the panel row and its button; this package contributes
   the glyph only, so the wrapper carries no interactive affordances of its own
   (no cursor, no hover, no focus ring) — the shell's button owns all three.
   Edge length comes from the owner's requested size, so none is set here. */
.cf-entry-icon{
  display:inline-flex;align-items:center;justify-content:center;position:relative;
  line-height:0;flex:none;
}
.cf-entry-dot{
  position:absolute;top:1px;right:1px;width:6px;height:6px;border-radius:9999px;
  background:currentColor;color:${TOKEN.success};
}

/* ---------------------------------------------------- interactive chrome */
.cf-sr{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0;
}
.cf-chev{flex:none;color:${TOKEN.labelSecondary};transition:transform .18s ease}
.cf-chev-closed{transform:rotate(-90deg)}
.cf-sec-toggle,.cf-module-toggle{
  flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;
  padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;
}
.cf-sec-toggle:hover .cf-col-title,.cf-module-toggle:hover .cf-col-title{color:${TOKEN.labelPrimary}}
.cf-sec-toggle:focus-visible,.cf-module-toggle:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:2px}
.cf-sec-body{min-width:0;display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.cf-toolbar{
  flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:6px 10px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-toolbar .cf-chips{flex-wrap:wrap}
.cf-search{
  display:inline-flex;align-items:center;gap:4px;min-width:110px;flex:1 1 130px;max-width:230px;
  max-height:26px;
  padding:2px 6px;border-radius:4px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};color:${TOKEN.labelSecondary};
}
.cf-search input{
  flex:1 1 auto;min-width:0;border:0;background:none;outline:none;
  color:${TOKEN.labelPrimary};font:inherit;font-size:10px;padding:2px 0;
}
.cf-search input::placeholder{color:${TOKEN.labelSecondary}}
.cf-search:focus-within{border-color:${TOKEN.brand}}
.cf-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.cf-chip-btn{
  display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL2};background:none;color:${TOKEN.labelSecondary};
  font:inherit;font-size:9px;letter-spacing:.04em;white-space:nowrap;
}
.cf-chip-btn:hover{color:${TOKEN.labelPrimary};border-color:${TOKEN.labelSecondary}}
.cf-chip-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-chip-btn-on{color:${TOKEN.brand};border-color:${wash(TOKEN.brand, 45)};background:${wash(TOKEN.brand, 10)}}
.cf-chip-num{font-size:8px;opacity:.75;margin-left:1px}
.cf-tool-note{font-size:8px;color:${TOKEN.labelSecondary};margin-left:auto;white-space:nowrap}
.cf-tool-btn{
  display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer2};color:${TOKEN.labelPrimary};
  font:inherit;font-size:9px;white-space:nowrap;
}
.cf-tool-btn:hover{border-color:${TOKEN.brand};color:${TOKEN.brand}}
.cf-tool-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-tool-btn-on{border-color:${wash(TOKEN.brand, 50)};color:${TOKEN.brand};background:${wash(TOKEN.brand, 10)}}
.cf-tool-btn-danger{border-color:${wash(TOKEN.error, 45)};color:${TOKEN.error};background:${wash(TOKEN.error, 8)}}
.cf-tool-select{
  max-width:150px;padding:2px 16px 2px 5px;border-radius:3px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};color:${TOKEN.labelPrimary};font:inherit;font-size:9px;
}
.cf-icon-btn{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:20px;height:20px;padding:0;border-radius:3px;cursor:pointer;
  background:none;border:1px solid transparent;color:${TOKEN.labelSecondary};
}
.cf-icon-btn:hover{color:${TOKEN.labelPrimary};border-color:${TOKEN.borderL1};background:${TOKEN.bgLayer2}}
.cf-icon-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-icon-btn-on{color:${TOKEN.brand};border-color:${wash(TOKEN.brand, 40)};background:${wash(TOKEN.brand, 10)}}
.cf-copy,.cf-improvement-copy{
  display:inline-flex;align-items:center;gap:3px;padding:0 5px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL2};background:none;color:${TOKEN.labelSecondary};
  font:inherit;font-size:8px;line-height:16px;white-space:nowrap;
}
.cf-copy:hover,.cf-improvement-copy:hover{color:${TOKEN.brand};border-color:${TOKEN.brand}}
.cf-copy:focus-visible,.cf-improvement-copy:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-copy-done,.cf-improvement-copy-done{color:${TOKEN.success};border-color:${wash(TOKEN.success, 45)}}
.cf-kv{display:flex;align-items:baseline;gap:6px;min-width:0}
.cf-kv-k{flex:none;color:${TOKEN.labelSecondary};font-size:8px;letter-spacing:.08em;min-width:58px}
.cf-kv-v{min-width:0;color:${TOKEN.labelPrimary};font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-kv-v-wrap{white-space:normal;word-break:break-word}
.cf-kv-v-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* --------------------------------------------------------------- inspector */
.cf-inspector{
  flex:none;display:flex;flex-direction:column;min-height:0;max-height:36%;
  border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-inspector-head{flex:none;display:flex;align-items:center;gap:7px;padding:6px 12px;border-bottom:1px solid ${TOKEN.borderL1}}
.cf-inspector-title{
  flex:1 1 auto;min-width:0;font-size:9px;letter-spacing:.18em;color:${TOKEN.labelSecondary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-inspector-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 12px 10px}
.cf-inspect-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:3px 10px;margin-bottom:6px}
.cf-inspect-flags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
.cf-inspect-section{margin-top:6px;padding-top:5px;border-top:1px dashed ${TOKEN.borderL1}}
.cf-inspect-heading{font-size:8px;letter-spacing:.14em;color:${TOKEN.labelSecondary};margin-bottom:3px}
.cf-inspect-roles{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.cf-role-inline{
  display:inline-flex;align-items:center;gap:4px;padding:1px 6px 1px 1px;border-radius:9999px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer2};font-size:8px;color:${TOKEN.labelPrimary};
}
.cf-gate-line{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:9px;line-height:1.65}
.cf-gate-k{flex:none;min-width:64px;color:${TOKEN.labelSecondary};font-size:8px}
.cf-gate-v{
  min-width:0;color:${TOKEN.labelPrimary};word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.cf-gate-checks{margin-top:3px;padding-left:8px;border-left:1px solid ${TOKEN.borderL1}}
.cf-inspect-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}

/* ---------------------------------------------------------------- messages */
.cf-msg-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.cf-msg-flag{font-size:8px;color:${TOKEN.labelSecondary}}
.cf-msg-flag-on{color:${TOKEN.success}}
.cf-unread-dot{width:5px;height:5px;border-radius:9999px;background:${TOKEN.brand};flex:none}
.cf-msg-body-clamp{
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;
}
.cf-msg-more{
  align-self:flex-start;margin-top:2px;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font:inherit;font-size:8px;letter-spacing:.06em;
}
.cf-msg-more:hover{text-decoration:underline}

/* --------------------------------------------------------------- artifacts */
.cf-art-head{
  flex:1 1 auto;min-width:0;display:flex;align-items:flex-start;gap:9px;padding:0;
  border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;
}
.cf-art-expanded{padding:5px 0 0;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-art-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:3px}
.cf-showmore{
  display:block;width:100%;margin:4px 0 2px;padding:4px 8px;border-radius:3px;cursor:pointer;
  border:1px dashed ${TOKEN.borderL1};background:none;color:${TOKEN.brand};font:inherit;font-size:9px;
}
.cf-showmore:hover{background:${TOKEN.bgLayer2}}
.cf-showmore:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}

/* --------------------------------------------------------------------- DoD */
.cf-dod-progress{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-dod-progress .cf-meter{height:4px}
.cf-dod-detail{
  display:flex;flex-direction:column;gap:2px;margin-top:4px;padding-top:4px;
  border-top:1px dashed ${TOKEN.borderL1};font-size:8px;color:${TOKEN.labelSecondary};
}
.cf-kind-chip{
  display:inline-flex;align-items:center;padding:0 4px;border-radius:2px;
  border:1px solid ${TOKEN.borderL2};font-size:8px;color:${TOKEN.labelSecondary};
}

/* --------------------------------------------------------------- evolution */
.cf-evo-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.cf-evo-detail{
  display:flex;flex-direction:column;gap:2px;margin-top:4px;padding-top:4px;
  border-top:1px dashed ${TOKEN.borderL1};font-size:8px;color:${TOKEN.labelSecondary};
}

/* ------------------------------------------------- plugin improvements */
.cf-improvements{margin-top:10px;padding-top:8px;border-top:1px solid ${TOKEN.borderL1}}
.cf-improvements-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.cf-improvements-title{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary}}
.cf-improvements-note{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-improvement-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.cf-improvement{
  display:flex;align-items:flex-start;gap:8px;padding:7px 9px;margin-bottom:6px;
  border:1px solid ${TOKEN.borderL1};border-radius:4px;background:${TOKEN.bgLayer1};
}
.cf-improvement-main{flex:1 1 auto;min-width:0}
.cf-improvement-status{
  display:inline-flex;align-items:center;padding:0 5px;border-radius:3px;border:1px solid;
  font-size:8px;white-space:nowrap;
}
.cf-improvement-toggle{
  align-self:flex-start;margin:0;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font:inherit;font-size:8px;letter-spacing:.06em;
}
.cf-improvement-toggle:hover{text-decoration:underline}
.cf-improvement-toggle:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-improvement-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cf-improvement-title{
  flex:1 1 auto;min-width:0;font-size:10px;font-weight:600;color:${TOKEN.labelPrimary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-improvement-evidence{font-size:8px;font-weight:700;color:${TOKEN.warn};white-space:nowrap}
.cf-improvement-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-improvement-target{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:4px}
.cf-improvement-target-label{flex:none;font-size:8px;letter-spacing:.08em;color:${TOKEN.labelSecondary}}
.cf-improvement-target-none{font-size:8px;color:${TOKEN.labelSecondary}}
.cf-improvement-file{
  min-width:0;font-size:8px;color:${TOKEN.labelPrimary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.cf-improvement-suggestion{
  margin-top:3px;font-size:10px;line-height:1.55;color:${TOKEN.labelPrimary};
  white-space:pre-wrap;word-break:break-word;
}
.cf-improvement-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cf-improvement-rationale{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  margin-top:3px;font-size:8px;line-height:1.5;color:${TOKEN.labelSecondary};
}
.cf-improvement-actions{display:flex;align-items:center;gap:6px;margin-top:4px}
.cf-improvement-empty{
  padding:7px 9px;border:1px dashed ${TOKEN.borderL1};border-radius:4px;
  font-size:9px;color:${TOKEN.labelSecondary};
}
.cf-improvement-more{
  display:block;width:100%;margin:3px 0 2px;padding:4px 8px;border-radius:3px;cursor:pointer;
  border:1px dashed ${TOKEN.borderL1};background:none;color:${TOKEN.brand};font:inherit;font-size:9px;
}
.cf-improvement-more:hover{background:${TOKEN.bgLayer2}}
.cf-improvement-more:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}

/* ------------------------------------------------------- dockable modules */
.cf-board{position:relative}
.cf-board-stack{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;
}
.cf-board-stack.cf-right-scroll{overflow-y:auto;overflow-x:hidden}
.cf-left .cf-board-stack{overflow-y:auto;overflow-x:hidden}
.cf-module{
  display:flex;flex-direction:column;min-width:0;min-height:0;
  flex:0 0 auto;position:relative;background:inherit;
}
.cf-module + .cf-module{border-top:1px solid ${TOKEN.borderL1}}
.cf-module[data-grow="true"],.cf-right-section[data-grow="true"]{flex:1 1 0}
.cf-module[data-collapsed="true"],.cf-right-section[data-collapsed="true"]{flex:0 0 auto}
.cf-module[data-dragging="true"],.cf-right-section[data-dragging="true"]{opacity:.55}
.cf-module-drop-before{box-shadow:inset 0 2px 0 ${TOKEN.brand}}
.cf-module-drop-after{box-shadow:inset 0 -2px 0 ${TOKEN.brand}}
.cf-board-col-over{outline:1px dashed ${wash(TOKEN.brand, 60)};outline-offset:-2px}
.cf-board-empty{
  display:flex;align-items:center;justify-content:center;flex:none;
  min-height:72px;margin:6px;padding:12px;border:1px dashed ${TOKEN.borderL1};
  border-radius:4px;color:${TOKEN.labelSecondary};font-size:9px;text-align:center;
}
.cf-drop-line{
  flex:none;height:3px;margin:0 6px;border-radius:2px;
  background:${TOKEN.brand};box-shadow:0 0 8px ${wash(TOKEN.brand, 55)};
}
.cf-module-head{
  flex:none;display:flex;align-items:center;gap:6px;
  padding:6px 9px;background:${TOKEN.bgLayer1};border-bottom:1px solid ${TOKEN.borderL1};
  cursor:grab;
}
.cf-module-head:active{cursor:grabbing}
.cf-module-grip{
  flex:none;color:${TOKEN.labelSecondary};font-size:10px;letter-spacing:2px;
  line-height:1;opacity:.75;user-select:none;
}
.cf-module-head .cf-col-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-module-body{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;
}
.cf-module[data-grow="false"] .cf-module-body,
.cf-right-section[data-grow="false"] .cf-module-body{flex:0 0 auto;overflow:visible}
/* The inspector was sized against the old fixed middle column; inside a dock
   module it simply fills the module body. */
.cf-module-body .cf-inspector,.cf-sec-body .cf-inspector{max-height:none;flex:1 1 auto;min-height:0;border-bottom:0}
.cf-module-empty{
  flex:1 1 auto;display:flex;align-items:center;justify-content:center;
  padding:12px;color:${TOKEN.labelSecondary};font-size:9px;text-align:center;
}
.cf-module-resize{
  flex:none;height:7px;cursor:row-resize;background:none;border:0;border-top:1px solid ${TOKEN.borderL1};
  padding:0;margin:0;
}
.cf-module-resize:hover,.cf-module-resize:focus-visible{background:${wash(TOKEN.brand, 22)};outline:none}
.cf-module-resize:focus-visible{box-shadow:inset 0 0 0 1px ${TOKEN.brand}}
.cf-module-menu-root{position:relative;flex:none;display:flex;align-items:center}
.cf-module-menu{
  position:absolute;right:0;top:calc(100% + 4px);z-index:40;
  display:flex;flex-direction:column;min-width:158px;padding:4px;border-radius:4px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgOverlay};
  box-shadow:0 10px 26px ${wash(TOKEN.labelPrimary, 20)};
}
.cf-module-menu button{
  display:block;width:100%;text-align:left;padding:4px 7px;border:0;border-radius:3px;
  background:none;color:${TOKEN.labelPrimary};font:inherit;font-size:9px;cursor:pointer;white-space:nowrap;
}
.cf-module-menu button:hover,.cf-module-menu button:focus-visible{background:${TOKEN.bgLayer2};outline:none}
.cf-module-menu button:disabled{color:${TOKEN.labelSecondary};cursor:default;opacity:.55}
.cf-module-menu-sep{height:1px;margin:3px 2px;background:${TOKEN.borderL1}}
.cf-splitter{
  position:relative;flex:1 1 auto;min-width:6px;cursor:col-resize;background:none;border:0;
  padding:0;margin:0;align-self:stretch;
}
.cf-splitter::after{
  content:'';position:absolute;left:2px;top:0;bottom:0;width:2px;border-radius:1px;
  background:${TOKEN.borderL1};
}
.cf-splitter:hover::after,.cf-splitter:focus-visible::after{background:${TOKEN.brand}}
.cf-splitter:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:-2px}
.cf-layout-menu-root{position:relative;display:inline-flex}
.cf-layout-pop{
  position:absolute;right:0;top:calc(100% + 6px);z-index:60;
  width:360px;max-width:min(360px,calc(100vw - 28px));max-height:min(68vh,520px);
  overflow-y:auto;padding:8px;border-radius:6px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgOverlay};
  box-shadow:0 14px 34px ${wash(TOKEN.labelPrimary, 22)};
}
.cf-layout-group{margin-bottom:6px}
.cf-layout-heading{font-size:8px;letter-spacing:.16em;color:${TOKEN.labelSecondary};padding:2px 3px 4px}
.cf-layout-row{
  display:flex;align-items:center;gap:3px;padding:3px 2px;
  border-top:1px dashed ${TOKEN.borderL1};
}
.cf-layout-row:first-of-type{border-top:0}
.cf-layout-name{
  flex:1 1 auto;min-width:0;font-size:10px;color:${TOKEN.labelPrimary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-layout-row .cf-icon-btn{width:18px;height:18px;font-size:10px}
.cf-layout-footer{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid ${TOKEN.borderL1}}
.cf-layout-muted{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-layout-hidden-row{display:flex;align-items:center;gap:5px;padding:2px 2px}
.cf-layout-hidden-row .cf-layout-name{flex:1 1 auto}

/* ------------------------------------------------------------ responsive
   Viewport-only by contract: the host sidebar must never change the column
   mode. Keep these @media rules as the single source of responsive layout. */
@media (max-width:1180px){
  .cf-body{grid-template-columns:222px minmax(0,1fr)}
  .cf-splitter{display:none}
  .cf-right{grid-column:1/-1;border-left:0;border-top:1px solid ${TOKEN.borderL1};max-height:44vh}
}
@media (max-width:820px){
  .cf-body{grid-template-columns:minmax(0,1fr)}
  .cf-splitter{display:none}
  .cf-left,.cf-right{border-right:0;border-left:0;border-bottom:1px solid ${TOKEN.borderL1}}
  .cf-left{max-height:34vh}
  .cf-mid{min-height:52vh}
  .cf-inspector{max-height:40vh}
  .cf-right{max-height:48vh}
  .cf-header{gap:10px}
  .cf-actions{width:100%;margin-left:0;justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
  .cf-led-pulse,.cf-flow,.cf-cursor::after,.cf-msg,.cf-card,.cf-sweep{animation:none}
}
`;
		//#endregion
		//#region lib/client/client/FactoryCockpit.js
		/**
		* Code Factory cockpit — the full-width `main` panel, its sidebar entry icon,
		* and the per-turn summary card.
		*
		* Layout: the prototype's three columns (ROSTER / PIPELINE + WORK OUTPUT /
		* the always-on details column: live feed, artifacts, DoD, and the evolution
		* ledger when the snapshot carries one) projected onto real data. Everything on
		* screen is a projection of one `FactorySnapshot` read from the host route;
		* nothing is simulated. The prototype's 1x/2x/4x speed control is deliberately
		* absent — real members execute at exactly one speed.
		*
		* Roles are drawn, not illustrated: every avatar is a deterministic inline SVG
		* (palette swatch + codename glyph + hashed ornament), so the panel needs no
		* image assets and no network at all.
		*
		* WORK OUTPUT shows the selected role's **actual collaboration messages**
		* (dispatch / rejection / handoff / report) rather than a pre-written script;
		* when the role is mid-work the last line carries the prototype's typing
		* cursor.
		*
		* Degradation: with no factory on the host the panel renders the header strip
		* plus a waiting empty state, and it keeps showing the last snapshot while the
		* host restarts instead of blanking out.
		*
		* @module dsh-code-factory/client/FactoryCockpit
		*/
		function IconRadar() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "26",
				height: "26",
				viewBox: "0 0 26 26",
				"aria-hidden": "true",
				style: {
					color: TOKEN.brand,
					flex: "none"
				},
				children: [
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "13",
						cy: "13",
						r: "11",
						fill: "none",
						stroke: "currentColor",
						strokeOpacity: "0.35",
						strokeWidth: "1.2"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "13",
						cy: "13",
						r: "6.5",
						fill: "none",
						stroke: "currentColor",
						strokeOpacity: "0.55",
						strokeWidth: "1"
					}),
					(0, react_jsx_runtime.jsx)("line", {
						className: "cf-sweep",
						x1: "13",
						y1: "13",
						x2: "13",
						y2: "3",
						stroke: "currentColor",
						strokeWidth: "1.5"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "13",
						cy: "13",
						r: "2",
						fill: "currentColor"
					})
				]
			});
		}
		function IconGrid({ size }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				children: [
					(0, react_jsx_runtime.jsx)("rect", {
						x: "1.5",
						y: "1.5",
						width: "5",
						height: "5",
						rx: "1",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}),
					(0, react_jsx_runtime.jsx)("rect", {
						x: "9.5",
						y: "1.5",
						width: "5",
						height: "5",
						rx: "1",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}),
					(0, react_jsx_runtime.jsx)("rect", {
						x: "1.5",
						y: "9.5",
						width: "5",
						height: "5",
						rx: "1",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}),
					(0, react_jsx_runtime.jsx)("rect", {
						x: "9.5",
						y: "9.5",
						width: "5",
						height: "5",
						rx: "1",
						fill: "currentColor",
						fillOpacity: "0.55"
					})
				]
			});
		}
		function IconBranch() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "3",
						cy: "2.5",
						r: "1.4",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.1"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "9",
						cy: "2.5",
						r: "1.4",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.1"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "6",
						cy: "9.5",
						r: "1.4",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.1"
					}),
					(0, react_jsx_runtime.jsx)("path", {
						d: "M3 3.9v1.6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V3.9",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.1"
					})
				]
			});
		}
		function IconShield() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M6 1.2 10 2.7v3.4c0 2.3-1.7 4.1-4 4.7-2.3-.6-4-2.4-4-4.7V2.7z",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.1"
				})
			});
		}
		function IconCheck() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M2 6.4 4.6 9 10 3.4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round"
				})
			});
		}
		function IconCross() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M3 3l6 6M9 3l-6 6",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round"
				})
			});
		}
		function IconRefresh() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "11",
				height: "11",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M10 6a4 4 0 1 1-1.3-2.9",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M10 1.6V4H7.6",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		function IconChevron({ open }) {
			return (0, react_jsx_runtime.jsx)("svg", {
				className: open ? "cf-chev" : "cf-chev cf-chev-closed",
				width: "9",
				height: "9",
				viewBox: "0 0 10 10",
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M2 3.4 5 6.5 8 3.4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				})
			});
		}
		function IconCopy() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "9",
				height: "9",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [(0, react_jsx_runtime.jsx)("rect", {
					x: "4",
					y: "4",
					width: "6.5",
					height: "6.5",
					rx: "1",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.1"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M8 3V2.2A1.2 1.2 0 0 0 6.8 1H2.2A1.2 1.2 0 0 0 1 2.2v4.6A1.2 1.2 0 0 0 2.2 8H3",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.1"
				})]
			});
		}
		function IconSearch() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [(0, react_jsx_runtime.jsx)("circle", {
					cx: "5",
					cy: "5",
					r: "3.4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.2"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M7.6 7.6 10.4 10.4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.2",
					strokeLinecap: "round"
				})]
			});
		}
		function IconClose() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "9",
				height: "9",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M3 3l6 6M9 3l-6 6",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.5",
					strokeLinecap: "round"
				})
			});
		}
		function IconPause() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [(0, react_jsx_runtime.jsx)("rect", {
					x: "3",
					y: "2.2",
					width: "2.2",
					height: "7.6",
					rx: "0.6",
					fill: "currentColor"
				}), (0, react_jsx_runtime.jsx)("rect", {
					x: "6.8",
					y: "2.2",
					width: "2.2",
					height: "7.6",
					rx: "0.6",
					fill: "currentColor"
				})]
			});
		}
		function IconPlay() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: "10",
				height: "10",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M3.4 2.4v7.2L9.6 6z",
					fill: "currentColor"
				})
			});
		}
		function IconLayout() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "11",
				height: "11",
				viewBox: "0 0 14 14",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [(0, react_jsx_runtime.jsx)("rect", {
					x: "1.5",
					y: "1.5",
					width: "11",
					height: "11",
					rx: "1.5",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.1"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M5.5 1.5v11M8.5 1.5v11",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.1"
				})]
			});
		}
		/** Dispatch priority for auto-selecting the role whose output is most useful. */
		const MEMBER_RANK = {
			working: 0,
			rework: 1,
			blocked: 2,
			error: 3,
			idle: 4,
			staged: 5,
			done: 6,
			removed: 7
		};
		function pad2(value) {
			return value < 10 ? `0${value}` : String(value);
		}
		/** 24-hour wall clock, locale-independent. */
		function formatClock(ts) {
			const date = new Date(ts);
			return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
		}
		/** `12.4K` above a thousand, plain digits below. */
		function formatTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			return value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(Math.round(value));
		}
		/** Coarse byte size for the artifact rows. */
		function formatBytes(value) {
			if (!Number.isFinite(value) || value <= 0) return "0 B";
			if (value < 1024) return `${Math.round(value)} B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
			return `${(value / (1024 * 1024)).toFixed(1)} MB`;
		}
		/** `42s` / `3m 12s` / `1h 04m`. */
		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0s";
			const seconds = Math.round(ms / 1e3);
			if (seconds < 60) return `${seconds}s`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
			return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
		}
		/** Locale-aware "how long ago", for the header's last-updated stamp. */
		function formatAgo(ms, t) {
			if (!Number.isFinite(ms) || ms < 1e4) return t("ago.justNow");
			const seconds = Math.floor(ms / 1e3);
			if (seconds < 60) return t("ago.seconds", { count: seconds });
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return t("ago.minutes", { count: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return t("ago.hours", { count: hours });
			return t("ago.days", { count: Math.floor(hours / 24) });
		}
		/**
		* Copy helper with a silent fallback.
		*
		* `navigator.clipboard` is unavailable outside a secure context and can reject
		* (permissions, no focus), and the panel is decorative here: a failed copy must
		* never throw into React or open a dialog. The fallback selects a temporary
		* textarea and uses the legacy command; if that fails too, nothing happens.
		*/
		function copyText(text) {
			const clipboard = typeof navigator === "undefined" ? void 0 : navigator.clipboard;
			if (clipboard !== void 0 && typeof clipboard.writeText === "function") {
				clipboard.writeText(text).catch(() => fallbackCopy(text));
				return;
			}
			fallbackCopy(text);
		}
		function fallbackCopy(text) {
			if (typeof document === "undefined") return;
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				document.execCommand("copy");
				document.body.removeChild(area);
			} catch {}
		}
		/**
		* Verdict of one DoD row.
		*
		* A row persisted before `status` existed carries only `ok`, which cannot tell
		* a skipped audit from a passed one — `ok` is all we have for those.
		*/
		function dodVerdict(item) {
			return item.status ?? (item.ok ? "passed" : "failed");
		}
		/** One pass over the snapshot for everything the header and meters show. */
		function aggregate(snapshot, now) {
			let tokens = 0;
			let activeMembers = 0;
			for (const member of snapshot.members) {
				tokens += member.tokens || 0;
				if (member.status === "working" || member.status === "rework") activeMembers += 1;
			}
			let units = 0;
			let stagesPassed = 0;
			for (const stage of snapshot.stages) if (stage.status === "passed") {
				stagesPassed += 1;
				units += 1;
			} else if (stage.status === "active" || stage.status === "gate") units += .5;
			const stagesTotal = snapshot.stages.length;
			const dodPassed = snapshot.dod.filter((item) => dodVerdict(item) === "passed").length;
			const settled = snapshot.phase === "delivered" || snapshot.phase === "discarded";
			const overall = snapshot.phase === "delivered" ? 100 : stagesTotal > 0 ? Math.round(units / stagesTotal * 100) : 0;
			const start = snapshot.createdAt || now;
			const end = settled ? snapshot.updatedAt || now : now;
			return {
				tokens,
				artifacts: snapshot.artifacts.length,
				dodPassed,
				dodTotal: snapshot.dod.length,
				stagesPassed,
				stagesTotal,
				activeMembers,
				totalMembers: snapshot.members.length,
				overall,
				elapsedMs: Math.max(0, end - start)
			};
		}
		/** Auto-selection: whoever the pipeline is actually blocked on, most urgent first. */
		function pickMember(members) {
			let best;
			for (const member of members) {
				if (member.status === "removed") continue;
				if (!best || MEMBER_RANK[member.status] < MEMBER_RANK[best.status]) best = member;
			}
			return best;
		}
		/** Resolve any role id (member, captain, or unknown sender) into chip-ready parts. */
		function roleView(snapshot, roleId, t) {
			const member = snapshot.members.find((item) => item.role === roleId);
			if (member) return {
				id: roleId,
				title: member.title,
				codename: member.codename,
				swatch: roleSwatch(member.role, member.color)
			};
			if (roleId === "unknown") return {
				id: roleId,
				title: t("feed.endpoint.unparsed"),
				codename: "???",
				swatch: TOKEN.labelSecondary,
				hint: t("feed.endpoint.unparsedHint")
			};
			return {
				id: roleId,
				title: roleId === "captain" ? t("role.captain") : roleId === "system" ? t("feed.kind.system") : roleId,
				codename: roleId.slice(0, 3).toUpperCase(),
				swatch: roleId === "captain" ? TOKEN.brand : roleSwatch(roleId)
			};
		}
		function stageName(snapshot, stageId) {
			if (!stageId) return void 0;
			return snapshot.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
		}
		/** Every ROSTER status chip, in reading order. */
		const MEMBER_STATUS_FILTERS = [
			"all",
			"working",
			"rework",
			"blocked",
			"error",
			"done",
			"idle"
		];
		/** WORK OUTPUT / live-feed kind chips, in reading order. */
		const FEED_KIND_FILTERS = [
			"all",
			"dispatch",
			"report",
			"reject",
			"blocked",
			"approval",
			"other"
		];
		/** Every artifact sort mode, in reading order. */
		const ARTIFACT_SORTS = [
			"newest",
			"oldest",
			"path",
			"size"
		];
		/** Every DoD chip, in reading order (outcome first, then the two non-outcomes). */
		const DOD_FILTERS = [
			"all",
			"failed",
			"pending",
			"passed",
			"skipped"
		];
		/** Every evolution chip, in reading order. */
		const LESSON_FILTERS = [
			"all",
			"open",
			"resolved"
		];
		/** Case-insensitive substring match over any readable field; blank matches all. */
		function matchesQuery(values, query) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return true;
			return values.some((value) => value !== void 0 && value.toLowerCase().includes(needle));
		}
		/** ROSTER search (title / codename / role id) + status chip + ordering. */
		function filterMembers(members, query, status, sort) {
			const filtered = members.filter((member) => {
				if (status !== "all" && member.status !== status) return false;
				return matchesQuery([
					member.title,
					member.codename,
					member.role
				], query);
			});
			if (sort === "roster") return filtered;
			return [...filtered].sort((left, right) => {
				const rank = MEMBER_RANK[left.status] - MEMBER_RANK[right.status];
				return rank !== 0 ? rank : left.title.localeCompare(right.title);
			});
		}
		/** Filter a message list by kind / search text / unread / stage. Order is preserved. */
		function filterFeedMessages(messages, options = {}) {
			const { query = "", kind = "all", unreadOnly = false, stageId } = options;
			return messages.filter((message) => {
				if (unreadOnly && message.readAt !== void 0) return false;
				if (stageId !== void 0 && message.stage !== stageId) return false;
				if (kind !== "all") {
					const actual = message.kind ?? "system";
					if (kind === "other") {
						if (actual !== "handoff" && actual !== "system") return false;
					} else if (actual !== kind) return false;
				}
				return matchesQuery([
					message.content,
					message.from,
					message.to
				], query);
			});
		}
		/** Filter artifacts by path / stage / owner text and (optionally) one stage id. */
		function filterArtifacts(artifacts, options = {}) {
			const { query = "", stageId } = options;
			return artifacts.filter((artifact) => {
				if (stageId !== void 0 && artifact.stage !== stageId) return false;
				return matchesQuery([
					artifact.path,
					artifact.stage,
					artifact.by
				], query);
			});
		}
		/** Order artifacts newest / oldest / path / size. Returns a new array. */
		function sortArtifacts(artifacts, sort) {
			const ordered = [...artifacts];
			switch (sort) {
				case "oldest": return ordered.sort((left, right) => left.at - right.at || left.path.localeCompare(right.path));
				case "path": return ordered.sort((left, right) => left.path.localeCompare(right.path));
				case "size": return ordered.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
				default: return ordered.sort((left, right) => right.at - left.at || left.path.localeCompare(right.path));
			}
		}
		/** Filter DoD rows by verdict; `all` returns a copy in its original order. */
		function filterDod(dod, filter = "all") {
			if (filter === "all") return [...dod];
			return dod.filter((item) => dodVerdict(item) === filter);
		}
		/** Filter lessons by resolution and (optionally) owning role. Order is preserved. */
		function filterLessons(lessons, filter = "all", role) {
			return lessons.filter((lesson) => {
				if (filter === "open" && lesson.resolvedAt !== void 0) return false;
				if (filter === "resolved" && lesson.resolvedAt === void 0) return false;
				if (role !== void 0 && role !== "" && role !== "all" && lesson.role !== role) return false;
				return true;
			});
		}
		/**
		* Resolve a lesson-role filter against the roles currently present.
		*
		* A role can leave the roster/ledger between snapshots. The `<select>` must
		* never show "all roles" while the rows are still filtered by the stale id, so
		* both the visible value and {@link filterLessons} use this resolved value.
		*
		* @param snapshot - snapshot supplying the roster and lesson roles.
		* @param role - requested role id, or `'all'`.
		* @returns the requested role when present, else `'all'`.
		*/
		function resolveLessonRole(snapshot, role) {
			if (role === "all") return "all";
			if (snapshot.members.some((member) => member.role === role)) return role;
			if ((snapshot.evolution?.lessons ?? []).some((lesson) => lesson.role === role)) return role;
			return "all";
		}
		/** Every improvement filter chip, in reading order. */
		const IMPROVEMENT_FILTERS = [
			"all",
			"open",
			"validated"
		];
		/** How many improvement proposals show before "show all". */
		const IMPROVEMENT_PREVIEW_LIMIT = 6;
		/**
		* Resolve the plugin-improvement proposals for one snapshot.
		*
		* The host's projection is authoritative when it carries the field (even an
		* empty array means "nothing to change"); otherwise the same proposals are
		* derived from the recurring lessons with the shared pure domain function, so an
		* older host still renders the backlog.
		*
		* @param snapshot - the factory snapshot.
		* @returns the proposals, most expensive/most recent first per the derivation.
		*/
		function improvementProposals(snapshot) {
			const evolution = snapshot.evolution;
			if (!evolution) return [];
			return evolution.improvements !== void 0 ? evolution.improvements : deriveImprovements(evolution.lessons);
		}
		/** Filter proposals by resolution status. Returns a new array. */
		function filterImprovements(proposals, filter = "all") {
			if (filter === "all") return [...proposals];
			return proposals.filter((proposal) => proposal.status === filter);
		}
		/**
		* Resolve one stage into everything the inspector shows.
		*
		* Pure: it only reads the snapshot and its stage id. Counts are direct scans of
		* the snapshot's own artifacts/feed, so a malformed or sparsely projected row
		* simply counts as absent instead of throwing.
		*/
		function buildStageInspector(snapshot, stageId) {
			const stage = snapshot.stages.find((item) => item.id === stageId);
			if (!stage) return void 0;
			const roles = [];
			const seen = /* @__PURE__ */ new Set();
			for (const roleId of stage.roles) {
				if (seen.has(roleId)) continue;
				seen.add(roleId);
				const member = snapshot.members.find((item) => item.role === roleId);
				roles.push(member ? {
					id: member.role,
					title: member.title,
					codename: member.codename,
					swatch: roleSwatch(member.role, member.color),
					resolved: true
				} : {
					id: roleId,
					title: roleId,
					codename: roleId.slice(0, 3).toUpperCase(),
					swatch: roleSwatch(roleId),
					resolved: false
				});
			}
			return {
				stage,
				roles,
				...stage.gate === void 0 ? {} : { gate: stage.gate },
				...stage.lastGate === void 0 ? {} : { lastGate: stage.lastGate },
				artifactCount: snapshot.artifacts.filter((artifact) => artifact.stage === stageId).length,
				messageCount: snapshot.feed.filter((message) => message.stage === stageId).length,
				attempts: stage.attempts ?? 0,
				...stage.maxRounds === void 0 ? {} : { maxRounds: stage.maxRounds },
				gateType: stage.gateType
			};
		}
		/** Stable, non-cryptographic hash: identity of the drawing, not a secret. */
		function avatarSeed(role) {
			let hash = 0;
			for (let index = 0; index < role.length; index += 1) hash = hash * 31 + role.charCodeAt(index) | 0;
			return Math.abs(hash);
		}
		/**
		* The glyph: two codename letters (`PM`, `FE`, `QA`), or one when the codename
		* is a single character. Punctuation is stripped so `???` (an unparsed
		* endpoint) still yields a readable mark instead of an empty plate.
		*/
		function avatarGlyph(codename) {
			const letters = codename.replace(/[^0-9A-Za-z]/g, "");
			return letters.length >= 2 ? letters.slice(0, 2).toUpperCase() : letters.toUpperCase() || "?";
		}
		/** One of four fixed ornaments, chosen by {@link avatarSeed}. */
		function AvatarOrnament({ seed, color }) {
			switch (seed % 4) {
				case 0: return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "16",
						cy: "16",
						r: "11",
						fill: "none",
						stroke: color,
						strokeOpacity: "0.32",
						strokeWidth: "1",
						strokeDasharray: "2 3"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "16",
						cy: "5.4",
						r: "1.3",
						fill: color,
						opacity: "0.5"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "16",
						cy: "26.6",
						r: "1.3",
						fill: color,
						opacity: "0.5"
					})
				] });
				case 1: return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M7 22.5 16 9.5l9 13",
					fill: "none",
					stroke: color,
					strokeOpacity: "0.3",
					strokeWidth: "1.2",
					strokeLinecap: "round"
				}), (0, react_jsx_runtime.jsx)("circle", {
					cx: "16",
					cy: "9.5",
					r: "1.5",
					fill: color,
					opacity: "0.45"
				})] });
				case 2: return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: (0, react_jsx_runtime.jsx)("path", {
					d: "M8.5 24 24 8.5M8.5 16 16 8.5M16 24 24 16",
					fill: "none",
					stroke: color,
					strokeOpacity: "0.26",
					strokeWidth: "1.1",
					strokeLinecap: "round"
				}) });
				default: return (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: (0, react_jsx_runtime.jsx)("path", {
					d: "M16 5.8 26 16 16 26.2 6 16z",
					fill: "none",
					stroke: color,
					strokeOpacity: "0.28",
					strokeWidth: "1.1",
					strokeLinejoin: "round"
				}) });
			}
		}
		/**
		* One role avatar (inline SVG).
		*
		* Colour rules follow the panel's theme contract: the ring/plate come from the
		* role swatch (a host colour or the prototype palette) and a `wash()` of it,
		* and the glyph uses `roleInk()` through `currentColor` — so an engine without
		* `color-mix()` falls back to the inherited label colour instead of drawing an
		* invisible letter. No status token is used, because a role colour is
		* decoration and must never read as a status.
		*
		* @param props - role id (stable seed), swatch, codename glyph, display title, edge size.
		* @returns the avatar markup, hidden from assistive tech because every call
		*   site already renders the role's name next to it.
		*/
		function RoleAvatar({ role, swatch, codename, title, size = 24 }) {
			const glyph = avatarGlyph(codename);
			return (0, react_jsx_runtime.jsxs)("svg", {
				className: "cf-avatar",
				width: size,
				height: size,
				viewBox: "0 0 32 32",
				"aria-hidden": "true",
				focusable: "false",
				children: [
					(0, react_jsx_runtime.jsx)("title", { children: title }),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "16",
						cy: "16",
						r: "15",
						fill: wash(swatch, 14),
						stroke: swatch,
						strokeOpacity: "0.72",
						strokeWidth: "1.5"
					}),
					(0, react_jsx_runtime.jsx)(AvatarOrnament, {
						seed: avatarSeed(role),
						color: swatch
					}),
					(0, react_jsx_runtime.jsx)("text", {
						x: "16",
						y: "16.5",
						textAnchor: "middle",
						dominantBaseline: "middle",
						fontSize: glyph.length > 1 ? 11 : 14,
						fontWeight: "700",
						letterSpacing: "0.4",
						fill: "currentColor",
						style: { color: roleInk(swatch) },
						children: glyph
					})
				]
			});
		}
		function Led({ color, pulse }) {
			return (0, react_jsx_runtime.jsx)("span", {
				className: pulse ? "cf-led cf-led-pulse" : "cf-led",
				style: { color },
				"aria-hidden": "true"
			});
		}
		function EmptyBlock({ title, body, action, wide }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: wide ? "cf-empty cf-empty-wide" : "cf-empty",
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: "cf-empty-title cf-mono",
						children: title
					}),
					body ? (0, react_jsx_runtime.jsx)("div", {
						className: "cf-empty-body",
						children: body
					}) : null,
					action ? (0, react_jsx_runtime.jsx)("div", {
						style: { marginTop: 12 },
						children: action
					}) : null
				]
			});
		}
		/**
		* Copy control with a visually hidden `aria-live` confirmation.
		*
		* The confirmation is the only feedback: a failed clipboard write degrades
		* silently by design (see {@link copyText}), because a read-only cockpit has no
		* recovery action to offer.
		*/
		function CopyButton({ t, text, label, className = "cf-copy" }) {
			const [copied, setCopied] = (0, react.useState)(false);
			const timer = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				if (timer.current !== void 0 && typeof window !== "undefined") window.clearTimeout(timer.current);
			}, []);
			const handleCopy = () => {
				copyText(text);
				setCopied(true);
				if (typeof window !== "undefined") {
					if (timer.current !== void 0) window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => setCopied(false), 1600);
				}
			};
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: copied ? `${className} ${className}-done` : className,
				onClick: handleCopy,
				title: copied ? t("copy.done") : t("copy.aria", { label }),
				"aria-label": t("copy.aria", { label }),
				children: [
					(0, react_jsx_runtime.jsx)(IconCopy, {}),
					(0, react_jsx_runtime.jsx)("span", { children: copied ? t("copy.done") : t("copy.action") }),
					(0, react_jsx_runtime.jsx)("span", {
						className: "cf-sr",
						role: "status",
						"aria-live": "polite",
						children: copied ? t("copy.done") : ""
					})
				]
			});
		}
		/** Controlled search box shared by the roster, feed, artifacts, and work output. */
		function SearchField({ value, onChange, placeholder, ariaLabel, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-search",
				children: [
					(0, react_jsx_runtime.jsx)(IconSearch, {}),
					(0, react_jsx_runtime.jsx)("input", {
						type: "search",
						value,
						placeholder,
						"aria-label": ariaLabel,
						spellCheck: false,
						onChange: (event) => onChange(event.target.value)
					}),
					value !== "" ? (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "cf-icon-btn",
						onClick: () => onChange(""),
						"aria-label": t("filter.clear"),
						title: t("filter.clear"),
						children: (0, react_jsx_runtime.jsx)(IconClose, {})
					}) : null
				]
			});
		}
		/** One toggleable filter chip; `count` renders the badge number when given. */
		function FilterChip({ active, label, count, onClick }) {
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: active ? "cf-chip-btn cf-chip-btn-on" : "cf-chip-btn",
				"aria-pressed": active,
				onClick,
				children: [(0, react_jsx_runtime.jsx)("span", { children: label }), count === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
					className: "cf-chip-num",
					children: count
				})]
			});
		}
		/** The collapsible shell every right-column section sits in. */
		function SectionShell({ t, id, title, titleHint, note, collapsed, onToggle, children }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "cf-right-section",
				"aria-label": title,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-right-head cf-mono",
					children: [(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "cf-sec-toggle",
						"aria-expanded": !collapsed,
						"aria-controls": collapsed ? void 0 : `cf-sec-${id}`,
						title: t("aria.sectionToggle", { section: title }),
						onClick: onToggle,
						children: [(0, react_jsx_runtime.jsx)(IconChevron, { open: !collapsed }), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-col-title",
							title: titleHint,
							children: title
						})]
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "cf-col-note",
						children: note
					})]
				}), collapsed ? null : (0, react_jsx_runtime.jsx)("div", {
					className: "cf-sec-body",
					id: `cf-sec-${id}`,
					children
				})]
			});
		}
		/**
		* One collaboration message.
		*
		* Long bodies clamp to four lines; expansion is per-row local state because it
		* is a reading aid, not a filter the rest of the panel needs to know about. The
		* copy control and the delivered/read marker live in the meta row.
		*/
		function MessageRow({ snapshot, t, message, caret = false }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const kind = message.kind ?? "system";
			const from = roleView(snapshot, message.from, t);
			const to = roleView(snapshot, message.to, t);
			const stage = stageName(snapshot, message.stage);
			const isCommand = /^\s*\$/.test(message.content);
			const long = message.content.length > 240 || message.content.split("\n").length > 4;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-msg",
				style: { borderLeftColor: FEED_KIND_COLOR[kind] },
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-msg-meta cf-mono",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: formatClock(message.ts) }),
							(0, react_jsx_runtime.jsxs)("span", {
								className: "cf-msg-sender",
								title: from.hint,
								children: [(0, react_jsx_runtime.jsx)(RoleAvatar, {
									role: message.from,
									swatch: from.swatch,
									codename: from.codename,
									title: from.title,
									size: 18
								}), (0, react_jsx_runtime.jsx)("span", {
									style: { color: roleInk(from.swatch) },
									children: from.title
								})]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								"aria-hidden": "true",
								children: "→"
							}),
							(0, react_jsx_runtime.jsxs)("span", {
								className: "cf-msg-sender",
								title: to.hint,
								children: [(0, react_jsx_runtime.jsx)("span", {
									style: { color: roleInk(to.swatch) },
									children: to.title
								}), (0, react_jsx_runtime.jsx)(RoleAvatar, {
									role: message.to,
									swatch: to.swatch,
									codename: to.codename,
									title: to.title,
									size: 18
								})]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-chip",
								style: {
									color: FEED_KIND_COLOR[kind],
									borderColor: wash(FEED_KIND_COLOR[kind], 40)
								},
								children: t(`feed.kind.${kind}`)
							}),
							stage ? (0, react_jsx_runtime.jsx)("span", { children: t("feed.stage", { stage }) }) : null,
							message.round ? (0, react_jsx_runtime.jsx)("span", { children: t("feed.round", { round: message.round }) }) : null,
							message.readAt !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-msg-flag cf-msg-flag-on",
								children: t("work.read")
							}) : message.deliveredAt !== void 0 ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-msg-flag",
								children: t("work.delivered")
							}) : (0, react_jsx_runtime.jsxs)("span", {
								className: "cf-msg-flag",
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: "cf-unread-dot",
										"aria-hidden": "true"
									}),
									" ",
									t("work.unread")
								]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-msg-actions",
								children: (0, react_jsx_runtime.jsx)(CopyButton, {
									t,
									text: message.content,
									label: t("copy.message")
								})
							})
						]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: `cf-msg-body${long && !expanded ? " cf-msg-body-clamp" : ""}${caret ? " cf-cursor" : ""}`,
						style: isCommand ? {
							color: TOKEN.brand,
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
						} : void 0,
						children: message.content
					}),
					long ? (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "cf-msg-more",
						"aria-expanded": expanded,
						onClick: () => setExpanded((value) => !value),
						children: expanded ? t("work.collapse") : t("work.expand")
					}) : null
				]
			});
		}
		function StageChip({ stage, t, snapshot, selected, onSelect }) {
			const color = STAGE_STATUS_COLOR[stage.status];
			const style = {
				color,
				borderColor: selected ? color : wash(color, 50),
				background: wash(color, selected ? 18 : stage.status === "pending" ? 4 : 12)
			};
			const failGotoName = stageName(snapshot, stage.failGoto);
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: selected ? "cf-stage cf-stage-btn cf-stage-on cf-mono" : "cf-stage cf-stage-btn cf-mono",
				style,
				title: `${stage.name} · ${t(`stage.status.${stage.status}`)}`,
				"aria-label": t("aria.stageChip", { stage: stage.name }),
				"aria-pressed": selected,
				onClick: onSelect,
				children: [
					stage.status === "active" ? (0, react_jsx_runtime.jsx)(Led, {
						color,
						pulse: true
					}) : null,
					stage.status === "gate" ? (0, react_jsx_runtime.jsx)(Led, {
						color,
						pulse: true
					}) : null,
					stage.status === "passed" ? (0, react_jsx_runtime.jsx)(IconCheck, {}) : null,
					stage.status === "rejected" ? (0, react_jsx_runtime.jsx)(IconCross, {}) : null,
					(0, react_jsx_runtime.jsx)("span", {
						className: "cf-stage-name",
						children: stage.name
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: "cf-stage-status",
						children: t(`stage.status.${stage.status}`)
					}),
					stage.parallel ? (0, react_jsx_runtime.jsx)(IconBranch, {}) : null,
					stage.humanApproval ? (0, react_jsx_runtime.jsx)(IconShield, {}) : null,
					stage.round > 0 ? (0, react_jsx_runtime.jsx)("span", {
						style: { opacity: .85 },
						children: t("work.round", { round: stage.round })
					}) : null,
					failGotoName ? (0, react_jsx_runtime.jsx)("span", {
						className: "cf-stage-goto",
						title: t("pipeline.failGoto", { stage: failGotoName }),
						children: "↩"
					}) : null,
					stage.gateType === "unknown" ? (0, react_jsx_runtime.jsx)("span", {
						className: "cf-chip",
						style: { color: TOKEN.labelSecondary },
						title: t("pipeline.gate.unknownHint"),
						children: t("pipeline.gate.unknown")
					}) : null
				]
			});
		}
		function PipelineConnector({ previous }) {
			const live = previous.status === "active" || previous.status === "gate";
			const stroke = previous.status === "active" ? TOKEN.brand : previous.status === "passed" ? TOKEN.success : TOKEN.borderL1;
			return (0, react_jsx_runtime.jsx)("svg", {
				className: "cf-conn",
				width: "22",
				height: "10",
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("line", {
					className: live ? "cf-flow" : void 0,
					x1: "0",
					y1: "5",
					x2: "22",
					y2: "5",
					stroke,
					strokeWidth: "1.2"
				})
			});
		}
		/**
		* How many alert rows the strip shows before the rest collapse into a count.
		*
		* Three is the most that fits above the columns without pushing the pipeline
		* they are about out of the panel; the remainder is counted rather than dropped,
		* so "more than three" stays visible.
		*/
		const ALERT_LIMIT = 3;
		/**
		* The panel's one "a human is needed" surface: the snapshot's alerts, most
		* urgent first, as a strip spanning the full width above the three columns.
		*
		* The host exposes no notification API, so this strip *is* the notification:
		* severity drives the colour, the clearing step is prefixed with an arrow, and
		* the whole thing is `null` — not an empty box — when the factory is green.
		*
		* @param props - translation seat and the alerts to render, already ordered.
		* @returns the strip, or `null` when there is nothing to raise.
		*/
		function AlertStrip({ t, alerts }) {
			if (alerts.length === 0) return null;
			const shown = alerts.slice(0, ALERT_LIMIT);
			const hidden = alerts.length - shown.length;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-alerts",
				role: "alert",
				"aria-label": t("alert.aria"),
				children: [shown.map((alert) => {
					const color = ALERT_SEVERITY_COLOR[alert.severity];
					const chip = alert.stage ?? alert.role;
					return (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-alert",
						style: {
							color,
							borderColor: wash(color, 40),
							background: wash(color, 12)
						},
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-alert-title",
								children: alert.title
							}),
							alert.detail ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-alert-detail cf-mono",
								children: alert.detail
							}) : null,
							alert.next ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-alert-next",
								children: `→ ${alert.next}`
							}) : null,
							chip ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-alert-chip cf-mono",
								children: chip
							}) : null
						]
					}, alert.id);
				}), hidden > 0 ? (0, react_jsx_runtime.jsx)("div", {
					className: "cf-alert-more cf-mono",
					children: t("alert.more", { count: hidden })
				}) : null]
			});
		}
		/**
		* How many lessons the right column shows before "show all".
		*
		* The host projection is already scoped to this factory's roster and its
		* hottest mistakes; six is what fits beside the other sections without turning
		* the cockpit into a copy of the whole ledger archive.
		*/
		const EVOLUTION_LESSON_LIMIT = 6;
		/** Artifacts rendered before "show all": a running factory can register ~180. */
		const ARTIFACT_PREVIEW_LIMIT = 12;
		/** Verdict label for a DoD row. */
		function dodVerdictLabel(verdict, t) {
			switch (verdict) {
				case "passed": return t("dod.itemOk");
				case "skipped": return t("dod.itemSkip");
				case "pending": return t("dod.itemPending");
				default: return t("dod.itemFail");
			}
		}
		/** Semantic colour for a DoD verdict. */
		function dodVerdictColor(verdict) {
			switch (verdict) {
				case "passed": return TOKEN.success;
				case "failed": return TOKEN.error;
				case "skipped": return TOKEN.labelSecondary;
				default: return TOKEN.idle;
			}
		}
		/** Chips for every message-kind filter, in the shared reading order. */
		function FeedKindChips({ t, kind, onKind }) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: "cf-chips",
				children: FEED_KIND_FILTERS.map((option) => (0, react_jsx_runtime.jsx)(FilterChip, {
					active: kind === option,
					label: option === "all" ? t("work.kind.all") : option === "other" ? t("work.kind.other") : t(`feed.kind.${option}`),
					onClick: () => onKind(option)
				}, option))
			});
		}
		/**
		* One cross-task lesson card.
		*
		* The headline stays a single ellipsised line (the full text is the tooltip);
		* expansion reveals the audit fields — gate detail, source factory, task family,
		* first/last seen — and the stage's own copy control copies the lesson text.
		*/
		function LessonCard({ snapshot, t, lesson }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const owner = roleView(snapshot, lesson.role, t);
			const stage = lesson.stageName || stageName(snapshot, lesson.stage) || lesson.stage;
			const resolved = lesson.resolvedAt !== void 0;
			const hasAudit = lesson.detail !== void 0 || lesson.factoryId !== void 0 || lesson.taskType !== void 0 || lesson.firstAt > 0 || lesson.lastAt > 0;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: resolved ? "cf-card cf-lesson cf-lesson-resolved" : "cf-card cf-lesson",
				children: [(0, react_jsx_runtime.jsx)(RoleAvatar, {
					role: lesson.role,
					swatch: owner.swatch,
					codename: owner.codename,
					title: owner.title,
					size: 24
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: "cf-card-main",
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-lesson-meta cf-mono",
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									style: { color: roleInk(owner.swatch) },
									children: owner.title
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-ellipsis",
									title: t("feed.stage", { stage }),
									children: t("feed.stage", { stage })
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: lesson.count > 1 ? "cf-lesson-count cf-mono" : "cf-lesson-count cf-lesson-count-once cf-mono",
									title: t("evolution.countHint", { count: lesson.count }),
									children: t("evolution.count", { count: lesson.count })
								}),
								resolved ? (0, react_jsx_runtime.jsxs)("span", {
									className: "cf-chip cf-lesson-ok cf-mono",
									children: [(0, react_jsx_runtime.jsx)(IconCheck, {}), t("evolution.resolved")]
								}) : null,
								hasAudit ? (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cf-msg-more",
									"aria-expanded": expanded,
									onClick: () => setExpanded((value) => !value),
									children: expanded ? t("evolution.collapse") : t("evolution.expand")
								}) : null,
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-msg-actions",
									children: (0, react_jsx_runtime.jsx)(CopyButton, {
										t,
										text: lesson.text,
										label: t("copy.lesson")
									})
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "cf-card-name cf-ellipsis",
							title: lesson.text,
							children: lesson.text
						}),
						expanded ? (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-evo-detail cf-mono",
							children: [
								lesson.detail ? (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("evolution.detail")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v cf-kv-v-wrap",
										children: lesson.detail
									})]
								}) : null,
								lesson.factoryId ? (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("evolution.factory")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v cf-kv-v-mono",
										children: lesson.factoryId
									})]
								}) : null,
								lesson.taskType ? (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("evolution.taskType")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v",
										children: lesson.taskType
									})]
								}) : null,
								lesson.gateType ? (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("inspector.gateType")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v",
										children: lesson.gateType
									})]
								}) : null,
								lesson.firstAt > 0 ? (0, react_jsx_runtime.jsx)("div", {
									className: "cf-kv",
									children: (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("evolution.firstSeen", { time: formatClock(lesson.firstAt) })
									})
								}) : null,
								lesson.lastAt > 0 ? (0, react_jsx_runtime.jsx)("div", {
									className: "cf-kv",
									children: (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("evolution.lastSeen", { time: formatClock(lesson.lastAt) })
									})
								}) : null
							]
						}) : null
					]
				})]
			});
		}
		/**
		* One plugin-improvement proposal card.
		*
		* No avatar: proposals are about the plugin's own files, not about a party in
		* the factory. Every card carries exactly one copy control (target file +
		* suggestion), so the section adds no chrome-level copy/avatar noise.
		*/
		function ImprovementCard({ snapshot, t, now, proposal }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const role = proposal.role === void 0 ? void 0 : roleView(snapshot, proposal.role, t);
			const stage = stageName(snapshot, proposal.stage);
			const statusColor = proposal.status === "validated" ? TOKEN.success : TOKEN.warn;
			const lastAt = proposal.lastAt > 0 ? now === void 0 ? formatClock(proposal.lastAt) : formatAgo(now - proposal.lastAt, t) : void 0;
			const copyValue = proposal.targetFile === void 0 ? proposal.suggestion : `${proposal.targetFile}\n${proposal.suggestion}`;
			return (0, react_jsx_runtime.jsx)("div", {
				className: "cf-improvement",
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: "cf-improvement-main",
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-improvement-head cf-mono",
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-improvement-title",
									title: proposal.title,
									children: proposal.title
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-improvement-status cf-mono",
									style: {
										color: statusColor,
										borderColor: wash(statusColor, 45)
									},
									children: t(`evolution.improvements.status.${proposal.status}`)
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-improvement-evidence",
									title: t("evolution.countHint", { count: proposal.evidenceCount }),
									children: t("evolution.count", { count: proposal.evidenceCount })
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-improvement-meta cf-mono",
							children: [
								role ? (0, react_jsx_runtime.jsx)("span", {
									style: { color: roleInk(role.swatch) },
									children: role.title
								}) : null,
								stage ? (0, react_jsx_runtime.jsx)("span", { children: t("feed.stage", { stage }) }) : null,
								lastAt ? (0, react_jsx_runtime.jsx)("span", { children: t("evolution.improvements.lastAt", { ago: lastAt }) }) : null
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-improvement-target cf-mono",
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: "cf-improvement-target-label",
								children: t("evolution.improvements.target")
							}), proposal.targetFile ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-improvement-file",
								title: proposal.targetFile,
								children: proposal.targetFile
							}) : (0, react_jsx_runtime.jsx)("span", {
								className: "cf-improvement-target-none",
								children: t("format.none")
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: expanded ? "cf-improvement-suggestion" : "cf-improvement-suggestion cf-improvement-clamp",
							children: proposal.suggestion
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-improvement-toggle",
							"aria-expanded": expanded,
							onClick: () => setExpanded((value) => !value),
							children: expanded ? t("evolution.improvements.collapse") : t("evolution.improvements.expand")
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "cf-improvement-rationale cf-mono",
							title: proposal.rationale,
							children: proposal.rationale
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "cf-improvement-actions",
							children: (0, react_jsx_runtime.jsx)(CopyButton, {
								t,
								text: copyValue,
								label: t("evolution.improvements.copy"),
								className: "cf-improvement-copy"
							})
						})
					]
				})
			});
		}
		/**
		* "Plugin improvements": the recurring-lesson backlog as actionable proposals.
		*
		* Owns only the preview/expansion state; the filter and the proposal list are
		* explicit props so an offline check can render every state (all / open /
		* validated / empty) without a browser.
		*/
		function ImprovementsPanel({ snapshot, t, now, proposals, filter, onFilter }) {
			const [showAll, setShowAll] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				setShowAll(false);
			}, [filter]);
			const openCount = proposals.filter((proposal) => proposal.status === "open").length;
			const validatedCount = proposals.length - openCount;
			const filtered = filterImprovements(proposals, filter);
			const shown = showAll ? filtered : filtered.slice(0, 6);
			const hidden = filtered.length - shown.length;
			return (0, react_jsx_runtime.jsxs)("section", {
				className: "cf-improvements",
				"aria-label": t("aria.improvements"),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-improvements-head cf-mono",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-improvements-title",
							children: t("evolution.improvements.title")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-improvements-note",
							children: t("evolution.improvements.count", { count: proposals.length })
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: "cf-improvement-toolbar cf-chips",
						children: IMPROVEMENT_FILTERS.map((option) => (0, react_jsx_runtime.jsx)(FilterChip, {
							active: filter === option,
							label: option === "all" ? t("evolution.improvements.filter.all") : option === "open" ? t("evolution.improvements.filter.open") : t("evolution.improvements.filter.validated"),
							count: option === "all" ? proposals.length : option === "open" ? openCount : validatedCount,
							onClick: () => onFilter(option)
						}, option))
					}),
					proposals.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: "cf-improvement-empty cf-mono",
						children: t("evolution.improvements.empty")
					}) : filtered.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: "cf-improvement-empty cf-mono",
						children: t("evolution.improvements.noMatch")
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						shown.map((proposal) => (0, react_jsx_runtime.jsx)(ImprovementCard, {
							snapshot,
							t,
							now,
							proposal
						}, proposal.id)),
						hidden > 0 ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-improvement-more",
							onClick: () => setShowAll(true),
							children: t("evolution.improvements.showAll", { count: filtered.length })
						}) : null,
						showAll && filtered.length > 6 ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-improvement-more",
							onClick: () => setShowAll(false),
							children: t("evolution.improvements.showLess")
						}) : null
					] })
				]
			});
		}
		/**
		* The evolution section body: stats, resolution/role filters, lesson cards and
		* the two distinguishable empty states. The section header/collapse chrome is
		* supplied by {@link SectionShell} (standalone) or by a dock module (board).
		*/
		function EvolutionContent({ snapshot, t, filter, onFilter, role, onRole, now }) {
			const [showAll, setShowAll] = (0, react.useState)(false);
			const [improvementFilter, setImprovementFilter] = (0, react.useState)("all");
			const evolution = snapshot.evolution;
			(0, react.useEffect)(() => {
				setShowAll(false);
			}, [filter, role]);
			if (!evolution) return null;
			const roleOptions = [];
			for (const member of snapshot.members) roleOptions.push(member.role);
			for (const lesson of evolution.lessons) if (!roleOptions.includes(lesson.role)) roleOptions.push(lesson.role);
			roleOptions.sort((left, right) => left.localeCompare(right));
			const effectiveRole = resolveLessonRole(snapshot, role);
			const filtered = filterLessons(evolution.lessons, filter, effectiveRole);
			const shown = showAll ? filtered : filtered.slice(0, EVOLUTION_LESSON_LIMIT);
			const hidden = filtered.length - shown.length;
			const emptyLedger = evolution.lessons.length === 0;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-pad",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-evo-stats cf-mono",
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-evo-stat",
								children: t("evolution.stat.total", { count: evolution.stats.total })
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-evo-stat cf-evo-stat-recurring",
								children: t("evolution.stat.recurring", { count: evolution.stats.recurring })
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-evo-stat cf-evo-stat-resolved",
								children: t("evolution.stat.resolved", { count: evolution.stats.resolved })
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-evo-toolbar",
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: "cf-chips",
							children: LESSON_FILTERS.map((option) => (0, react_jsx_runtime.jsx)(FilterChip, {
								active: filter === option,
								label: option === "all" ? t("evolution.filter.all") : option === "open" ? t("evolution.filter.open") : t("evolution.filter.resolved"),
								onClick: () => onFilter(option)
							}, option))
						}), (0, react_jsx_runtime.jsxs)("select", {
							className: "cf-tool-select",
							"aria-label": t("evolution.roleFilter"),
							value: effectiveRole,
							onChange: (event) => onRole(event.target.value),
							children: [(0, react_jsx_runtime.jsx)("option", {
								value: "all",
								children: t("evolution.roleAll")
							}), roleOptions.map((option) => (0, react_jsx_runtime.jsx)("option", {
								value: option,
								children: roleView(snapshot, option, t).title
							}, option))]
						})]
					}),
					shown.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-evo-empty",
						children: [(0, react_jsx_runtime.jsx)("div", {
							className: "cf-evo-empty-title",
							children: emptyLedger ? evolution.stats.total > 0 ? t("evolution.emptyFiltered", { total: evolution.stats.total }) : t("evolution.empty") : t("evolution.noMatch")
						}), (0, react_jsx_runtime.jsx)("div", {
							className: "cf-evo-empty-body",
							children: emptyLedger ? evolution.stats.total > 0 ? t("evolution.emptyFilteredBody") : t("evolution.emptyBody") : t("evolution.noMatchBody")
						})]
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						shown.map((lesson) => (0, react_jsx_runtime.jsx)(LessonCard, {
							snapshot,
							t,
							lesson
						}, lesson.id)),
						hidden > 0 ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-showmore",
							onClick: () => setShowAll(true),
							children: t("evolution.showAll", { count: filtered.length })
						}) : null,
						showAll && filtered.length > EVOLUTION_LESSON_LIMIT ? (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-showmore",
							onClick: () => setShowAll(false),
							children: t("evolution.showLess")
						}) : null
					] }),
					(0, react_jsx_runtime.jsx)(ImprovementsPanel, {
						snapshot,
						t,
						now,
						proposals: improvementProposals(snapshot),
						filter: improvementFilter,
						onFilter: setImprovementFilter
					})
				]
			});
		}
		/**
		* Standalone evolution section (shell + content), kept for the offline checks
		* that render each right-column section directly.
		*/
		function EvolutionSection({ snapshot, t, collapsed, onToggleCollapsed, filter, onFilter, role, onRole, now }) {
			if (!snapshot.evolution) return null;
			const lessons = snapshot.evolution.lessons;
			const count = filterLessons(lessons, filter, resolveLessonRole(snapshot, role)).length;
			return (0, react_jsx_runtime.jsx)(SectionShell, {
				t,
				id: "evolution",
				title: t("section.evolution"),
				note: t("section.evolutionNote", { count }),
				collapsed,
				onToggle: onToggleCollapsed,
				children: (0, react_jsx_runtime.jsx)(EvolutionContent, {
					snapshot,
					t,
					filter,
					onFilter,
					role,
					onRole,
					now
				})
			});
		}
		/** Live feed body: chronological list, kind chips, search, copy, expand. */
		function FeedContent({ snapshot, t, query, onQuery, kind, onKind }) {
			const ordered = (0, react.useMemo)(() => snapshot.feed.slice().sort((left, right) => left.ts - right.ts), [snapshot.feed]);
			const filtered = filterFeedMessages(ordered, {
				query,
				kind
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
				className: "cf-toolbar",
				children: [(0, react_jsx_runtime.jsx)(SearchField, {
					t,
					value: query,
					onChange: onQuery,
					placeholder: t("feed.search"),
					ariaLabel: t("aria.feedSearch")
				}), (0, react_jsx_runtime.jsx)(FeedKindChips, {
					t,
					kind,
					onKind
				})]
			}), (0, react_jsx_runtime.jsx)("div", {
				className: "cf-pad",
				children: ordered.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("feed.empty.title"),
					body: t("feed.empty.body")
				}) : filtered.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("feed.filteredEmptyTitle"),
					body: t("feed.filteredEmptyBody")
				}) : filtered.map((message) => (0, react_jsx_runtime.jsx)(MessageRow, {
					snapshot,
					t,
					message
				}, message.id))
			})] });
		}
		/** Standalone feed section (shell + content), kept for direct offline rendering. */
		function FeedSection({ snapshot, t, collapsed, onToggleCollapsed, query, onQuery, kind, onKind }) {
			return (0, react_jsx_runtime.jsx)(SectionShell, {
				t,
				id: "feed",
				title: t("section.feed"),
				note: t("section.feedNote", { count: filterFeedMessages(snapshot.feed, {
					query,
					kind
				}).length }),
				collapsed,
				onToggle: onToggleCollapsed,
				children: (0, react_jsx_runtime.jsx)(FeedContent, {
					snapshot,
					t,
					query,
					onQuery,
					kind,
					onKind
				})
			});
		}
		/**
		* The artifact registry body: search, sort, stage filter, owner avatar,
		* path/size/ago, click-to-expand full path + copy. A running factory can
		* register ~180 artifacts, so the default view is a bounded preview with an
		* explicit "show all"; filtering/sorting resets the expansion window.
		*/
		function ArtifactsContent({ snapshot, t, now, query, onQuery, sort, onSort, stageId, onClearStage }) {
			const [showAll, setShowAll] = (0, react.useState)(false);
			const [openPath, setOpenPath] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				setShowAll(false);
				setOpenPath(void 0);
			}, [
				query,
				sort,
				stageId
			]);
			const filtered = filterArtifacts(snapshot.artifacts, {
				query,
				stageId
			});
			const ordered = sortArtifacts(filtered, sort);
			const visible = showAll ? ordered : ordered.slice(0, ARTIFACT_PREVIEW_LIMIT);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
				className: "cf-toolbar",
				children: [
					(0, react_jsx_runtime.jsx)(SearchField, {
						t,
						value: query,
						onChange: onQuery,
						placeholder: t("artifacts.search"),
						ariaLabel: t("aria.artifactSearch")
					}),
					(0, react_jsx_runtime.jsx)("select", {
						className: "cf-tool-select",
						"aria-label": t("artifacts.sortLabel"),
						value: sort,
						onChange: (event) => onSort(event.target.value),
						children: ARTIFACT_SORTS.map((option) => (0, react_jsx_runtime.jsx)("option", {
							value: option,
							children: t(`artifacts.sort.${option}`)
						}, option))
					}),
					stageId !== void 0 ? (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "cf-tool-btn cf-tool-btn-on",
						onClick: onClearStage,
						children: [t("artifacts.stageFilter", { stage: stageName(snapshot, stageId) ?? stageId }), " ×"]
					}) : null
				]
			}), (0, react_jsx_runtime.jsx)("div", {
				className: "cf-pad",
				children: snapshot.artifacts.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("artifacts.empty"),
					wide: true
				}) : filtered.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("artifacts.emptyFiltered"),
					wide: true
				}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [visible.map((artifact) => {
					const owner = roleView(snapshot, artifact.by, t);
					const open = openPath === artifact.path;
					return (0, react_jsx_runtime.jsx)("div", {
						className: "cf-card cf-art",
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-card-main",
							children: [(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "cf-art-head",
								"aria-expanded": open,
								onClick: () => setOpenPath(open ? void 0 : artifact.path),
								children: [
									(0, react_jsx_runtime.jsx)(RoleAvatar, {
										role: artifact.by,
										swatch: owner.swatch,
										codename: owner.codename,
										title: owner.title,
										size: 18
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "cf-card-main",
										style: { textAlign: "left" },
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-card-name cf-mono cf-ellipsis",
											title: artifact.path,
											style: { display: "block" },
											children: artifact.path
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: "cf-card-sub cf-mono",
											style: { display: "block" },
											children: [
												t("artifacts.by", { role: owner.title }),
												" · ",
												t("artifacts.stage", { stage: stageName(snapshot, artifact.stage) ?? artifact.stage }),
												" · ",
												formatBytes(artifact.bytes),
												" · ",
												formatAgo(now - artifact.at, t)
											]
										})]
									}),
									(0, react_jsx_runtime.jsx)(IconChevron, { open })
								]
							}), open ? (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-art-expanded cf-mono",
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("artifacts.title")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap cf-kv-v-mono",
											children: artifact.path
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("inspector.at")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: formatClock(artifact.at)
										})]
									}),
									(0, react_jsx_runtime.jsx)("div", {
										className: "cf-art-actions",
										children: (0, react_jsx_runtime.jsx)(CopyButton, {
											t,
											text: artifact.path,
											label: t("copy.path")
										})
									})
								]
							}) : null]
						})
					}, artifact.path);
				}), ordered.length > ARTIFACT_PREVIEW_LIMIT ? (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "cf-showmore",
					onClick: () => setShowAll((value) => !value),
					children: showAll ? t("artifacts.showLess") : t("artifacts.showAll", { count: ordered.length })
				}) : null] })
			})] });
		}
		/** Standalone artifacts section (shell + content), kept for direct offline rendering. */
		function ArtifactsSection({ snapshot, t, now, collapsed, onToggleCollapsed, query, onQuery, sort, onSort, stageId, onClearStage }) {
			return (0, react_jsx_runtime.jsx)(SectionShell, {
				t,
				id: "artifacts",
				title: t("section.artifacts"),
				titleHint: t("artifacts.title"),
				note: t("section.artifactsNote", { count: filterArtifacts(snapshot.artifacts, {
					query,
					stageId
				}).length }),
				collapsed,
				onToggle: onToggleCollapsed,
				children: (0, react_jsx_runtime.jsx)(ArtifactsContent, {
					snapshot,
					t,
					now,
					query,
					onQuery,
					sort,
					onSort,
					stageId,
					onClearStage
				})
			});
		}
		/** DoD checks body: status chips with counts, progress bar, expandable definitions. */
		function DodContent({ snapshot, t, filter, onFilter }) {
			const [openId, setOpenId] = (0, react.useState)(void 0);
			const verdicts = snapshot.dod.map((item) => dodVerdict(item));
			const passed = verdicts.filter((verdict) => verdict === "passed").length;
			const counts = {
				passed,
				skipped: verdicts.filter((verdict) => verdict === "skipped").length,
				failed: verdicts.filter((verdict) => verdict === "failed").length,
				pending: verdicts.filter((verdict) => verdict === "pending").length
			};
			const filtered = filterDod(snapshot.dod, filter);
			const progress = snapshot.dod.length > 0 ? Math.round(passed / snapshot.dod.length * 100) : 0;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", {
				className: "cf-toolbar",
				children: (0, react_jsx_runtime.jsx)("div", {
					className: "cf-chips",
					children: DOD_FILTERS.map((option) => (0, react_jsx_runtime.jsx)(FilterChip, {
						active: filter === option,
						label: option === "all" ? t("dod.filter.all") : option === "failed" ? t("dod.filter.failed") : option === "pending" ? t("dod.filter.pending") : option === "passed" ? t("dod.filter.passed") : t("dod.filter.skipped"),
						count: option === "all" ? snapshot.dod.length : counts[option],
						onClick: () => onFilter(option)
					}, option))
				})
			}), (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-pad",
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-dod-progress cf-mono",
					children: [(0, react_jsx_runtime.jsx)("span", { children: t("dod.passed", {
						passed,
						total: snapshot.dod.length
					}) }), (0, react_jsx_runtime.jsx)("div", {
						className: "cf-meter",
						role: "progressbar",
						"aria-label": t("dod.passed", {
							passed,
							total: snapshot.dod.length
						}),
						"aria-valuenow": passed,
						"aria-valuemin": 0,
						"aria-valuemax": snapshot.dod.length,
						children: (0, react_jsx_runtime.jsx)("div", {
							className: "cf-meter-fill",
							style: {
								width: `${progress}%`,
								background: TOKEN.success
							}
						})
					})]
				}), snapshot.dod.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("dod.empty"),
					wide: true
				}) : filtered.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("dod.emptyFiltered"),
					wide: true
				}) : filtered.map((item) => {
					const verdict = dodVerdict(item);
					const color = dodVerdictColor(verdict);
					const open = openId === item.id;
					const detail = item.kind !== void 0 || item.artifact !== void 0 || item.expect !== void 0 || item.run !== void 0 || item.securityOnly === true;
					return (0, react_jsx_runtime.jsx)("div", {
						className: "cf-card",
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-card-main",
							children: [(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "cf-art-head",
								"aria-expanded": open,
								onClick: () => setOpenId(open ? void 0 : item.id),
								title: item.evidence,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										style: {
											color,
											flex: "none",
											marginTop: 1
										},
										children: verdict === "passed" ? (0, react_jsx_runtime.jsx)(IconCheck, {}) : verdict === "failed" ? (0, react_jsx_runtime.jsx)(IconCross, {}) : (0, react_jsx_runtime.jsx)(Led, {
											color,
											pulse: false
										})
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: "cf-card-main",
										style: { textAlign: "left" },
										children: [(0, react_jsx_runtime.jsxs)("span", {
											className: "cf-card-name",
											style: {
												display: "block",
												whiteSpace: "normal",
												color: verdict === "passed" ? TOKEN.labelPrimary : TOKEN.labelSecondary
											},
											children: [
												item.id,
												". ",
												item.label
											]
										}), item.evidence ? (0, react_jsx_runtime.jsxs)("span", {
											className: "cf-card-sub cf-mono cf-ellipsis",
											title: item.evidence,
											style: { display: "block" },
											children: [
												t("dod.evidence"),
												": ",
												item.evidence
											]
										}) : null]
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: "cf-chip cf-mono",
										style: {
											color,
											borderColor: wash(color, 45)
										},
										children: dodVerdictLabel(verdict, t)
									}),
									(0, react_jsx_runtime.jsx)(IconChevron, { open })
								]
							}), open ? (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-dod-detail cf-mono",
								children: [
									item.kind ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("dod.field.kind")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: (0, react_jsx_runtime.jsx)("span", {
												className: "cf-kind-chip",
												children: t(`dod.kind.${item.kind}`)
											})
										})]
									}) : null,
									item.securityOnly ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("dod.field.securityOnly")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: t("format.yes")
										})]
									}) : null,
									item.artifact ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("dod.field.artifact")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap cf-kv-v-mono",
											children: item.artifact
										})]
									}) : null,
									item.expect ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("dod.field.expect")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap cf-kv-v-mono",
											children: item.expect
										})]
									}) : null,
									item.run ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("dod.field.run")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap cf-kv-v-mono",
											children: item.run
										})]
									}) : null,
									item.evidence ? (0, react_jsx_runtime.jsx)("div", {
										className: "cf-art-actions",
										children: (0, react_jsx_runtime.jsx)(CopyButton, {
											t,
											text: item.evidence,
											label: t("copy.evidence")
										})
									}) : null,
									!detail && !item.evidence ? (0, react_jsx_runtime.jsx)("div", {
										className: "cf-kv-v",
										children: t("format.none")
									}) : null
								]
							}) : null]
						})
					}, item.id);
				})]
			})] });
		}
		/** Standalone DoD section (shell + content), kept for direct offline rendering. */
		function DodSection({ snapshot, t, collapsed, onToggleCollapsed, filter, onFilter }) {
			const passed = snapshot.dod.filter((item) => dodVerdict(item) === "passed").length;
			return (0, react_jsx_runtime.jsx)(SectionShell, {
				t,
				id: "dod",
				title: t("section.dod"),
				titleHint: t("dod.title"),
				note: t("section.dodNote", {
					passed,
					total: snapshot.dod.length
				}),
				collapsed,
				onToggle: onToggleCollapsed,
				children: (0, react_jsx_runtime.jsx)(DodContent, {
					snapshot,
					t,
					filter,
					onFilter
				})
			});
		}
		/**
		* The roster body: search, status chips with counts, ordering, expandable rows.
		*
		* Selecting a row still drives WORK OUTPUT; the expand control is a sibling
		* button (never nested) so both actions stay keyboard-reachable. The column
		* title/head is supplied by the dock module (or by {@link RosterPanel} when it
		* is rendered standalone by an offline check).
		*/
		function RosterContent({ snapshot, t, selectedRole, onSelectRole, query, onQuery, statusFilter, onStatusFilter, sort, onSort }) {
			const [expandedRole, setExpandedRole] = (0, react.useState)(void 0);
			const filtered = filterMembers(snapshot.members, query, statusFilter, sort);
			const counts = (0, react.useMemo)(() => {
				const byStatus = {
					staged: 0,
					idle: 0,
					working: 0,
					rework: 0,
					blocked: 0,
					done: 0,
					error: 0,
					removed: 0
				};
				for (const member of snapshot.members) byStatus[member.status] += 1;
				return byStatus;
			}, [snapshot.members]);
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-roster-tools",
					children: [
						(0, react_jsx_runtime.jsx)(SearchField, {
							t,
							value: query,
							onChange: onQuery,
							placeholder: t("roster.search"),
							ariaLabel: t("aria.rosterSearch")
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "cf-chips",
							children: MEMBER_STATUS_FILTERS.map((option) => (0, react_jsx_runtime.jsx)(FilterChip, {
								active: statusFilter === option,
								label: option === "all" ? t("roster.filter.all") : t(`member.status.${option}`),
								count: option === "all" ? snapshot.members.length : counts[option],
								onClick: () => onStatusFilter(option)
							}, option))
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-chips",
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-col-note cf-mono",
									style: { marginRight: 2 },
									children: t("roster.sortLabel")
								}),
								(0, react_jsx_runtime.jsx)(FilterChip, {
									active: sort === "roster",
									label: t("roster.sort.roster"),
									onClick: () => onSort("roster")
								}),
								(0, react_jsx_runtime.jsx)(FilterChip, {
									active: sort === "status",
									label: t("roster.sort.status"),
									onClick: () => onSort("status")
								})
							]
						})
					]
				}),
				(0, react_jsx_runtime.jsx)("div", {
					className: "cf-fill cf-scroll",
					children: snapshot.members.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
						title: t("roster.empty"),
						body: t("work.empty.body")
					}) : filtered.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
						title: t("roster.filteredEmpty"),
						body: t("work.filteredEmptyBody")
					}) : filtered.map((member) => {
						const color = MEMBER_STATUS_COLOR[member.status];
						const swatch = roleSwatch(member.role, member.color);
						const isActive = selectedRole === member.role;
						const expanded = expandedRole === member.role;
						const belongs = snapshot.stages.find((stage) => stage.id === member.currentStage);
						const startedAt = member.startedAt;
						const endedAt = member.endedAt;
						return (0, react_jsx_runtime.jsxs)("div", {
							className: isActive ? "cf-role cf-role-on" : "cf-role",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-role-row",
								children: [(0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "cf-role-main",
									"aria-label": t("aria.role", { role: member.title }),
									title: member.duties,
									onClick: () => onSelectRole(member.role),
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											className: "cf-role-top",
											children: [
												(0, react_jsx_runtime.jsx)(RoleAvatar, {
													role: member.role,
													swatch,
													codename: member.codename,
													title: member.title,
													size: 18
												}),
												(0, react_jsx_runtime.jsx)("span", {
													className: "cf-role-name",
													children: member.title
												}),
												(0, react_jsx_runtime.jsx)("span", {
													className: "cf-chip cf-mono",
													style: {
														color: roleInk(swatch),
														borderColor: wash(swatch, 45),
														background: wash(swatch, 12)
													},
													children: member.codename
												})
											]
										}),
										(0, react_jsx_runtime.jsxs)("div", {
											className: "cf-role-meta cf-mono",
											children: [(0, react_jsx_runtime.jsxs)("span", {
												className: "cf-role-state",
												style: { color },
												children: [(0, react_jsx_runtime.jsx)(Led, {
													color,
													pulse: PULSING_MEMBER_STATUS[member.status]
												}), (0, react_jsx_runtime.jsx)("span", { children: t(`member.status.${member.status}`) })]
											}), (0, react_jsx_runtime.jsxs)("span", {
												style: { color: TOKEN.labelSecondary },
												children: [t(member.tier === "reasoner" ? "roster.tier.reasoner" : "roster.tier.chat"), member.tokens > 0 ? ` · ${formatTokens(member.tokens)}` : ""]
											})]
										}),
										(0, react_jsx_runtime.jsx)("div", {
											className: "cf-role-note cf-mono",
											children: member.spawnError ? `${t("work.spawnError")}: ${member.spawnError}` : belongs ? `${belongs.name}${belongs.round > 0 ? ` · ${t("work.round", { round: belongs.round })}` : ""}` : t("roster.stageNone")
										})
									]
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cf-icon-btn cf-role-expand",
									"aria-expanded": expanded,
									"aria-label": expanded ? t("roster.collapse") : t("roster.expand"),
									title: expanded ? t("roster.collapse") : t("roster.expand"),
									onClick: () => setExpandedRole(expanded ? void 0 : member.role),
									children: (0, react_jsx_runtime.jsx)(IconChevron, { open: expanded })
								})]
							}), expanded ? (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-role-details cf-mono",
								children: [
									member.sessionId ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.session")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-mono",
											title: member.sessionId,
											children: member.sessionId
										})]
									}) : null,
									member.provider || member.model ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: member.provider ?? t("roster.details.model")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: member.model ?? t("format.none")
										})]
									}) : null,
									member.reasoningEffort ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.effort")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: member.reasoningEffort
										})]
									}) : null,
									startedAt !== void 0 ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.started")
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: "cf-kv-v cf-kv-v-mono",
											children: [formatClock(startedAt), endedAt !== void 0 ? ` · ${formatDuration(endedAt - startedAt)}` : ""]
										})]
									}) : null,
									endedAt !== void 0 && startedAt === void 0 ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.ended")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-mono",
											children: formatClock(endedAt)
										})]
									}) : null,
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.tokens")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-mono",
											children: formatTokens(member.tokens)
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("roster.details.stage")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v",
											children: belongs ? belongs.name : t("roster.stageNone")
										})]
									}),
									member.spawnError ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											style: { color: TOKEN.error },
											children: t("work.spawnError")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap",
											style: { color: TOKEN.error },
											children: member.spawnError
										})]
									}) : null,
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-kv",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-k",
											children: t("work.duties")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-kv-v cf-kv-v-wrap",
											children: member.duties || t("format.none")
										})]
									}),
									member.sessionId ? (0, react_jsx_runtime.jsx)("div", {
										className: "cf-art-actions",
										children: (0, react_jsx_runtime.jsx)(CopyButton, {
											t,
											text: member.sessionId,
											label: t("copy.session")
										})
									}) : null
								]
							}) : null]
						}, member.role);
					})
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-legend cf-mono",
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-legend-row",
						children: [(0, react_jsx_runtime.jsx)("span", { children: t("roster.tier.reasoner") }), (0, react_jsx_runtime.jsx)("span", { children: t("roster.legend.reasoner") })]
					}), (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-legend-row",
						children: [(0, react_jsx_runtime.jsx)("span", { children: t("roster.tier.chat") }), (0, react_jsx_runtime.jsx)("span", { children: t("roster.legend.chat") })]
					})]
				})
			] });
		}
		/**
		* Standalone left column (column chrome + content), kept for direct offline
		* rendering by the checks that assert the roster column structure.
		*/
		function RosterPanel(props) {
			const { snapshot, t } = props;
			const active = snapshot.members.filter((member) => member.status === "working" || member.status === "rework").length;
			return (0, react_jsx_runtime.jsxs)("aside", {
				className: "cf-col cf-left",
				"aria-label": t("aria.roster"),
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-col-head",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "cf-col-title cf-mono",
						children: t("roster.title")
					}), (0, react_jsx_runtime.jsx)("span", {
						className: "cf-col-note cf-mono",
						children: t("roster.active", {
							active,
							total: snapshot.members.length
						})
					})]
				}), (0, react_jsx_runtime.jsx)(RosterContent, { ...props })]
			});
		}
		/** One gate rule line; composite children render recursively, indented. */
		function GateRuleView({ gate, t, depth }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: depth > 0 ? "cf-gate-checks" : void 0,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateType")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: t(`pipeline.gate.${gate.type}`)
						})]
					}),
					gate.artifact ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateArtifact")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.artifact
						})]
					}) : null,
					gate.requiredSections !== void 0 && gate.requiredSections.length > 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateSections")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.requiredSections.join(" · ")
						})]
					}) : null,
					gate.passWord ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gatePassWord")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.passWord
						})]
					}) : null,
					gate.failWord ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateFailWord")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.failWord
						})]
					}) : null,
					gate.run ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateRun")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.run
						})]
					}) : null,
					gate.checks !== void 0 && gate.checks.length > 0 ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-gate-line",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-k",
							children: t("inspector.gateChecks")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: "cf-gate-v",
							children: gate.checks.length
						})]
					}), gate.checks.map((check, index) => (0, react_jsx_runtime.jsx)(GateRuleView, {
						gate: check,
						t,
						depth: depth + 1
					}, index))] }) : null
				]
			});
		}
		/**
		* The stage inspector under the pipeline: every projected stage fact in one
		* place, plus the "only this stage" switch that drives the work-output message
		* filter and the artifacts section.
		*/
		function StageInspectorPanel({ snapshot, t, now, inspector, stageOnly, onToggleStageOnly, onClose }) {
			const { stage } = inspector;
			const color = STAGE_STATUS_COLOR[stage.status];
			const lastGate = inspector.lastGate;
			const failGotoName = stageName(snapshot, stage.failGoto);
			const duration = stage.startedAt === void 0 ? void 0 : formatDuration((stage.endedAt ?? now) - stage.startedAt);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-inspector",
				"aria-label": t("aria.inspector"),
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "cf-inspector-head cf-mono",
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: "cf-col-title",
							children: t("inspector.title")
						}),
						(0, react_jsx_runtime.jsxs)("span", {
							className: "cf-chip",
							style: {
								color,
								borderColor: wash(color, 45)
							},
							children: [
								stage.name,
								" · ",
								t(`stage.status.${stage.status}`)
							]
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cf-icon-btn",
							onClick: onClose,
							"aria-label": t("inspector.close"),
							title: t("inspector.close"),
							children: (0, react_jsx_runtime.jsx)(IconClose, {})
						})
					]
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: "cf-inspector-body",
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-inspect-flags cf-mono",
							children: [
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										t("inspector.status"),
										": ",
										t(`stage.status.${stage.status}`)
									]
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "cf-inspect-flag",
									children: t("inspector.rounds", {
										round: stage.round,
										max: inspector.maxRounds ?? t("format.none")
									})
								}),
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										t("inspector.attempts"),
										": ",
										inspector.attempts
									]
								}),
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										t("inspector.artifacts"),
										": ",
										inspector.artifactCount
									]
								}),
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										t("inspector.messages"),
										": ",
										inspector.messageCount
									]
								}),
								stage.humanApproval ? (0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										(0, react_jsx_runtime.jsx)(IconShield, {}),
										" ",
										t("inspector.humanApproval")
									]
								}) : null,
								stage.parallel ? (0, react_jsx_runtime.jsxs)("span", {
									className: "cf-inspect-flag",
									children: [
										(0, react_jsx_runtime.jsx)(IconBranch, {}),
										" ",
										t("inspector.parallel")
									]
								}) : null,
								failGotoName ? (0, react_jsx_runtime.jsx)("span", {
									className: "cf-inspect-flag",
									children: t("inspector.failGoto", { stage: failGotoName })
								}) : null
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-inspect-grid cf-mono",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("inspector.started")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v cf-kv-v-mono",
										children: stage.startedAt === void 0 ? t("format.none") : formatClock(stage.startedAt)
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("inspector.ended")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v cf-kv-v-mono",
										children: stage.endedAt === void 0 ? t("format.none") : formatClock(stage.endedAt)
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("inspector.duration")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v cf-kv-v-mono",
										children: duration ?? t("format.none")
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "cf-kv",
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-k",
										children: t("inspector.gateType")
									}), (0, react_jsx_runtime.jsx)("span", {
										className: "cf-kv-v",
										children: inspector.gateType === "unknown" ? t("pipeline.gate.unknown") : t(`pipeline.gate.${inspector.gateType}`)
									})]
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-inspect-section",
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-inspect-heading cf-mono",
								children: t("inspector.roles")
							}), (0, react_jsx_runtime.jsx)("div", {
								className: "cf-inspect-roles",
								children: inspector.roles.map((role) => (0, react_jsx_runtime.jsxs)("span", {
									className: "cf-role-inline",
									title: role.resolved ? role.title : t("inspector.unresolvedRole"),
									children: [
										(0, react_jsx_runtime.jsx)(RoleAvatar, {
											role: role.id,
											swatch: role.swatch,
											codename: role.codename,
											title: role.title,
											size: 18
										}),
										(0, react_jsx_runtime.jsx)("span", {
											style: { color: roleInk(role.swatch) },
											children: role.title
										}),
										!role.resolved ? (0, react_jsx_runtime.jsx)("span", {
											className: "cf-chip cf-mono",
											style: { color: TOKEN.labelSecondary },
											children: t("inspector.unresolvedRole")
										}) : null
									]
								}, role.id))
							})]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-inspect-section",
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-inspect-heading cf-mono",
								children: t("inspector.gate")
							}), inspector.gate ? (0, react_jsx_runtime.jsx)(GateRuleView, {
								gate: inspector.gate,
								t,
								depth: 0
							}) : (0, react_jsx_runtime.jsx)("div", {
								className: "cf-kv-v",
								children: t("inspector.noGate")
							})]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-inspect-section",
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-inspect-heading cf-mono",
								children: t("inspector.lastGate")
							}), lastGate ? (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-mono",
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-gate-line",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-gate-k",
											children: t("inspector.status")
										}), (0, react_jsx_runtime.jsxs)("span", {
											className: "cf-gate-v",
											style: { color: lastGate.ok ? TOKEN.success : TOKEN.error },
											children: [
												lastGate.ok ? t("inspector.lastGatePass") : t("inspector.lastGateFail"),
												" · ",
												lastGate.detail
											]
										})]
									}),
									lastGate.exitCode !== void 0 ? (0, react_jsx_runtime.jsxs)("div", {
										className: "cf-gate-line",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-gate-k",
											children: t("inspector.exitCode")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-gate-v",
											children: lastGate.exitCode
										})]
									}) : null,
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-gate-line",
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: "cf-gate-k",
											children: t("inspector.at")
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-gate-v",
											children: formatClock(lastGate.at)
										})]
									})
								]
							}) : (0, react_jsx_runtime.jsx)("div", {
								className: "cf-kv-v",
								children: t("inspector.noVerdict")
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "cf-inspect-actions",
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: stageOnly ? "cf-tool-btn cf-tool-btn-on" : "cf-tool-btn",
								onClick: onToggleStageOnly,
								children: stageOnly ? t("inspector.stageOnlyOff") : t("inspector.stageOnlyOn")
							})
						})
					]
				})]
			});
		}
		/** Drag payload type for a panel module; `text/plain` carries a fallback id. */
		const PANEL_MODULE_MIME = "application/x-code-factory-module";
		/**
		* One dockable module shell: draggable header, fold button, per-module ⋯ menu,
		* body (omitted while folded) and a bottom height grip.
		*
		* The shell owns its transient UI state (menu open, pointer-resize listeners)
		* and receives the persisted layout through props; all mutations go back to the
		* board via the callbacks. `legacySection` keeps the right column's historical
		* `.cf-right-section` / `.cf-right-head` / `.cf-sec-toggle` / `cf-sec-<id>`
		* contract that the offline checks assert.
		*/
		function DockModule({ t, id, title, titleHint, note, collapsed, height, grow, legacySection, dragging, onToggleCollapsed, onMove, onHide, onClearHeight, onResizeHeight, onDragStart, onDragEnd, children }) {
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const menuRef = (0, react.useRef)(null);
			const resizeCleanup = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				if (!menuOpen || typeof window === "undefined") return void 0;
				const onPointerDown = (event) => {
					const root = menuRef.current;
					if (root !== null && !root.contains(event.target)) setMenuOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setMenuOpen(false);
				};
				window.addEventListener("pointerdown", onPointerDown);
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("pointerdown", onPointerDown);
					window.removeEventListener("keydown", onKeyDown);
				};
			}, [menuOpen]);
			(0, react.useEffect)(() => () => {
				resizeCleanup.current?.();
			}, []);
			const currentHeight = () => {
				if (height !== void 0) return height;
				const measured = rootRef.current?.getBoundingClientRect().height;
				return typeof measured === "number" && measured > 0 ? measured : 96;
			};
			const handleResizePointerDown = (event) => {
				if (typeof window === "undefined") return;
				event.preventDefault();
				const startY = event.clientY;
				const startHeight = currentHeight();
				const move = (moveEvent) => {
					onResizeHeight(startHeight + moveEvent.clientY - startY);
				};
				const cleanup = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", cleanup);
					resizeCleanup.current = void 0;
				};
				resizeCleanup.current = cleanup;
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", cleanup);
			};
			const handleResizeKeyDown = (event) => {
				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					event.preventDefault();
					const step = event.key === "ArrowUp" ? -24 : 24;
					const next = currentHeight() + step;
					onResizeHeight(Math.min(MAX_MODULE_HEIGHT, Math.max(96, next)));
					return;
				}
				if (event.key === "Home") {
					event.preventDefault();
					onResizeHeight(96);
				} else if (event.key === "End") {
					event.preventDefault();
					onResizeHeight(MAX_MODULE_HEIGHT);
				}
			};
			const handleDragStart = (event) => {
				event.dataTransfer.effectAllowed = "move";
				try {
					event.dataTransfer.setData(PANEL_MODULE_MIME, id);
					event.dataTransfer.setData("text/plain", id);
				} catch {}
				onDragStart(event);
			};
			const headClass = legacySection ? "cf-right-head cf-mono" : "cf-module-head cf-mono";
			const toggleClass = legacySection ? "cf-sec-toggle" : "cf-module-toggle";
			const bodyId = `cf-sec-${id}`;
			return (0, react_jsx_runtime.jsxs)("section", {
				ref: rootRef,
				className: legacySection ? "cf-right-section" : "cf-module",
				style: !collapsed && height !== void 0 ? {
					flex: "0 0 auto",
					height: `${height}px`
				} : void 0,
				"aria-label": title,
				"data-cf-module": id,
				"data-grow": grow ? "true" : "false",
				"data-collapsed": collapsed ? "true" : "false",
				"data-dragging": dragging ? "true" : "false",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: headClass,
						draggable: true,
						title: t("layout.dragHint"),
						onDragStart: handleDragStart,
						onDragEnd,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-module-grip",
								"aria-hidden": "true",
								children: "⠿"
							}),
							(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: toggleClass,
								"aria-expanded": !collapsed,
								"aria-controls": collapsed ? void 0 : bodyId,
								title: t("aria.sectionToggle", { section: title }),
								onClick: onToggleCollapsed,
								children: [(0, react_jsx_runtime.jsx)(IconChevron, { open: !collapsed }), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-col-title",
									title: titleHint,
									children: title
								})]
							}),
							note ? (0, react_jsx_runtime.jsx)("span", {
								className: "cf-col-note",
								children: note
							}) : null,
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-module-menu-root",
								ref: menuRef,
								children: [(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cf-icon-btn",
									"aria-haspopup": "menu",
									"aria-expanded": menuOpen,
									"aria-label": t("layout.menu"),
									title: t("layout.menu"),
									onClick: () => setMenuOpen((value) => !value),
									children: "⋯"
								}), menuOpen ? (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-module-menu",
									role: "menu",
									"aria-label": t("layout.menu"),
									children: [
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onMove("up");
												setMenuOpen(false);
											},
											children: `↑ ${t("layout.moveUp", { module: title })}`
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onMove("down");
												setMenuOpen(false);
											},
											children: `↓ ${t("layout.moveDown", { module: title })}`
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onMove("left");
												setMenuOpen(false);
											},
											children: `← ${t("layout.moveLeft", { module: title })}`
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onMove("right");
												setMenuOpen(false);
											},
											children: `→ ${t("layout.moveRight", { module: title })}`
										}),
										(0, react_jsx_runtime.jsx)("div", {
											className: "cf-module-menu-sep",
											"aria-hidden": "true"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onToggleCollapsed();
												setMenuOpen(false);
											},
											children: collapsed ? t("layout.unfold") : t("layout.fold")
										}),
										height !== void 0 ? (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onClearHeight();
												setMenuOpen(false);
											},
											children: t("layout.customHeight")
										}) : null,
										(0, react_jsx_runtime.jsx)("div", {
											className: "cf-module-menu-sep",
											"aria-hidden": "true"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "menuitem",
											onClick: () => {
												onHide();
												setMenuOpen(false);
											},
											children: t("layout.hideModule", { module: title })
										})
									]
								}) : null]
							})
						]
					}),
					collapsed ? null : legacySection ? (0, react_jsx_runtime.jsx)("div", {
						className: "cf-sec-body",
						id: bodyId,
						children: (0, react_jsx_runtime.jsx)("div", {
							className: "cf-module-body",
							children
						})
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: "cf-module-body",
						id: bodyId,
						children
					}),
					collapsed ? null : (0, react_jsx_runtime.jsx)("div", {
						className: "cf-module-resize",
						role: "separator",
						"aria-orientation": "horizontal",
						"aria-label": t("layout.heightHint"),
						"aria-valuemin": 96,
						"aria-valuemax": MAX_MODULE_HEIGHT,
						"aria-valuenow": height === void 0 ? void 0 : Math.round(height),
						tabIndex: 0,
						title: t("layout.heightHint"),
						onPointerDown: handleResizePointerDown,
						onKeyDown: handleResizeKeyDown,
						onDoubleClick: onClearHeight
					})
				]
			});
		}
		/** One column-width splitter: pointer drag, arrow keys, double-click reset. */
		function ColumnSplitter({ t, side, value, onChange, onReset }) {
			const cleanupRef = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				cleanupRef.current?.();
			}, []);
			const handlePointerDown = (event) => {
				if (typeof window === "undefined") return;
				event.preventDefault();
				const rect = event.currentTarget.parentElement?.getBoundingClientRect();
				if (rect === void 0) return;
				const move = (moveEvent) => {
					onChange(side === "left" ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX);
				};
				const cleanup = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", cleanup);
					cleanupRef.current = void 0;
				};
				cleanupRef.current = cleanup;
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", cleanup);
			};
			const handleKeyDown = (event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const delta = event.key === "ArrowRight" ? 16 : -16;
				onChange(value + (side === "left" ? delta : -delta));
			};
			return (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "cf-splitter",
				role: "separator",
				"aria-orientation": "vertical",
				"aria-label": side === "left" ? t("layout.resizeLeft") : t("layout.resizeRight"),
				"aria-valuenow": value,
				"aria-valuemin": 190,
				"aria-valuemax": 640,
				title: t("layout.resizeHint"),
				onPointerDown: handlePointerDown,
				onKeyDown: handleKeyDown,
				onDoubleClick: onReset
			});
		}
		/** Resolve the localized header title for one module. */
		function panelModuleTitle(t, id) {
			switch (id) {
				case "roster": return t("roster.title");
				case "pipeline": return t("pipeline.title");
				case "inspector": return t("inspector.title");
				case "work": return t("work.title");
				case "feed": return t("section.feed");
				case "artifacts": return t("section.artifacts");
				case "dod": return t("section.dod");
				case "evolution": return t("section.evolution");
				default: return id;
			}
		}
		/** Optional title tooltip text for one module (the long registry names). */
		function panelModuleHint(t, id) {
			if (id === "artifacts") return t("artifacts.title");
			if (id === "dod") return t("dod.title");
		}
		/**
		* The three-column dockable board.
		*
		* Owns only layout mechanics: HTML5 drag/drop (same-column reorder and
		* cross-column docking), the two column-width splitters, and the mapping from a
		* persisted {@link PanelLayout} to {@link DockModule} shells. Content rendering
		* is injected through `renderModule`, so the board is SSR-renderable with any
		* layout and any module bodies.
		*/
		function PanelBoard({ t, layout, onChangeLayout, renderModule, moduleNote }) {
			const [dragging, setDragging] = (0, react.useState)(void 0);
			const [dropTarget, setDropTarget] = (0, react.useState)(void 0);
			const boardRef = (0, react.useRef)(null);
			const commit = (next) => onChangeLayout(next);
			const moveByDirection = (moduleId, direction) => {
				const placement = modulePlacement(layout, moduleId);
				if (placement === void 0 || placement === "hidden") return;
				const index = layout.columns[placement].indexOf(moduleId);
				if (direction === "up") {
					if (index > 0) commit(moveModule(layout, moduleId, placement, index - 1));
					return;
				}
				if (direction === "down") {
					if (index >= 0 && index < layout.columns[placement].length - 1) commit(moveModule(layout, moduleId, placement, index + 1));
					return;
				}
				const target = direction === "left" ? placement === "right" ? "mid" : placement === "mid" ? "left" : void 0 : placement === "left" ? "mid" : placement === "mid" ? "right" : void 0;
				if (target !== void 0) commit(moveModule(layout, moduleId, target));
			};
			/** Insertion index drawn from the pointer's half-of-module position. */
			const computeDropIndex = (column, clientY) => {
				const modules = layout.columns[column];
				const board = boardRef.current;
				if (board === null) return modules.length;
				const columnElement = board.querySelector(`[data-cf-column="${column}"]`);
				if (columnElement === null) return modules.length;
				const elements = [...columnElement.querySelectorAll("[data-cf-module]")];
				for (let index = 0; index < elements.length; index += 1) {
					const rect = elements[index].getBoundingClientRect();
					if (clientY < rect.top + rect.height / 2) return index;
				}
				return modules.length;
			};
			/**
			* Drop a dragged module at a *visual* insertion index.
			*
			* `layout.moveModule` removes the module first and then inserts at `index`, so
			* a same-column move to a later visual position must shift the index back by
			* one (without this, dragging a module below itself lands it back in place).
			* Cross-column and upward moves need no correction.
			*/
			const dropModule = (moduleId, column, visualIndex) => {
				commit(planModuleDrop(layout, moduleId, column, visualIndex));
			};
			const columnDragHandlers = (column) => ({
				onDragOver: (event) => {
					if (!(dragging !== void 0 || Array.from(event.dataTransfer.types).includes("application/x-code-factory-module"))) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					const index = computeDropIndex(column, event.clientY);
					setDropTarget((previous) => previous !== void 0 && previous.column === column && previous.index === index ? previous : {
						column,
						index
					});
				},
				onDrop: (event) => {
					event.preventDefault();
					let raw = "";
					try {
						raw = event.dataTransfer.getData("application/x-code-factory-module") || event.dataTransfer.getData("text/plain");
					} catch {
						raw = "";
					}
					const moduleId = isPanelModuleId(raw) ? raw : dragging;
					const index = computeDropIndex(column, event.clientY);
					if (moduleId !== void 0) dropModule(moduleId, column, index);
					setDragging(void 0);
					setDropTarget(void 0);
				}
			});
			const renderColumn = (column) => {
				const modules = layout.columns[column];
				const isOver = dragging !== void 0 && dropTarget?.column === column;
				const stack = (0, react_jsx_runtime.jsxs)("div", {
					className: "cf-board-stack",
					children: [
						modules.length === 0 && !isOver ? (0, react_jsx_runtime.jsx)("div", {
							className: "cf-board-empty",
							children: t("layout.emptyColumn")
						}) : null,
						isOver && modules.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
							className: "cf-drop-line",
							"aria-hidden": "true"
						}) : null,
						modules.map((moduleId, index) => (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [isOver && dropTarget?.index === index ? (0, react_jsx_runtime.jsx)("div", {
							className: "cf-drop-line",
							"aria-hidden": "true"
						}) : null, (0, react_jsx_runtime.jsx)(DockModule, {
							t,
							id: moduleId,
							title: panelModuleTitle(t, moduleId),
							titleHint: panelModuleHint(t, moduleId),
							note: moduleNote?.(moduleId),
							collapsed: layout.collapsed[moduleId] === true,
							height: layout.heights[moduleId],
							grow: moduleId !== "pipeline",
							legacySection: column === "right",
							dragging: dragging === moduleId,
							onToggleCollapsed: () => commit(toggleModuleCollapsed(layout, moduleId)),
							onMove: (direction) => moveByDirection(moduleId, direction),
							onHide: () => commit(hideModule(layout, moduleId)),
							onClearHeight: () => commit(clearModuleHeight(layout, moduleId)),
							onResizeHeight: (next) => commit(setModuleHeight(layout, moduleId, next)),
							onDragStart: () => {
								setDragging(moduleId);
								setDropTarget(void 0);
							},
							onDragEnd: () => {
								setDragging(void 0);
								setDropTarget(void 0);
							},
							children: renderModule(moduleId)
						})] }, moduleId)),
						isOver && dropTarget?.index === modules.length && modules.length > 0 ? (0, react_jsx_runtime.jsx)("div", {
							className: "cf-drop-line",
							"aria-hidden": "true"
						}) : null
					]
				});
				const handlers = columnDragHandlers(column);
				const overClass = isOver ? " cf-board-col-over" : "";
				if (column === "left") return (0, react_jsx_runtime.jsx)("aside", {
					className: `cf-col cf-left${overClass}`,
					"aria-label": t("aria.roster"),
					"data-cf-column": "left",
					...handlers,
					children: stack
				});
				if (column === "mid") return (0, react_jsx_runtime.jsx)("section", {
					className: `cf-col cf-mid${overClass}`,
					"aria-label": t("aria.pipeline"),
					"data-cf-column": "mid",
					...handlers,
					children: stack
				});
				return (0, react_jsx_runtime.jsx)("aside", {
					className: `cf-col cf-right${overClass}`,
					"aria-label": t("aria.detail"),
					"data-cf-column": "right",
					...handlers,
					children: (0, react_jsx_runtime.jsx)("div", {
						className: "cf-right-scroll cf-scroll",
						children: stack
					})
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: boardRef,
				className: "cf-body cf-board",
				style: {
					"--cf-left-w": `${layout.widths.left}px`,
					"--cf-right-w": `${layout.widths.right}px`
				},
				onDragLeave: (event) => {
					if (event.currentTarget.contains(event.relatedTarget)) return;
					setDropTarget(void 0);
				},
				children: [
					renderColumn("left"),
					(0, react_jsx_runtime.jsx)(ColumnSplitter, {
						t,
						side: "left",
						value: layout.widths.left,
						onChange: (width) => commit(setColumnWidth(layout, "left", width)),
						onReset: () => commit(setColumnWidth(layout, "left", DEFAULT_COLUMN_WIDTHS.left))
					}),
					renderColumn("mid"),
					(0, react_jsx_runtime.jsx)(ColumnSplitter, {
						t,
						side: "right",
						value: layout.widths.right,
						onChange: (width) => commit(setColumnWidth(layout, "right", width)),
						onReset: () => commit(setColumnWidth(layout, "right", DEFAULT_COLUMN_WIDTHS.right))
					}),
					renderColumn("right")
				]
			});
		}
		/**
		* Plan one dock drop for a *visual* insertion index.
		*
		* `layout.moveModule` removes the module first and then inserts at `index`, so
		* a same-column move to a later visual position must shift the index back by
		* one (without this, dragging a module below itself lands it back in place).
		* Cross-column and upward moves need no correction. Exported so the HTML5 drop
		* handler and the offline checks share one implementation.
		*
		* @param layout - current layout.
		* @param moduleId - dragged module.
		* @param column - target column.
		* @param visualIndex - insertion index as seen by the user (0..length).
		* @returns the new layout (or an equal one for a no-op).
		*/
		function planModuleDrop(layout, moduleId, column, visualIndex) {
			let index = visualIndex;
			if (modulePlacement(layout, moduleId) === column) {
				const sourceIndex = layout.columns[column].indexOf(moduleId);
				if (sourceIndex !== -1 && sourceIndex < index) index -= 1;
			}
			return moveModule(layout, moduleId, column, index);
		}
		/** Expand every folded module in one layout, without touching positions. */
		function expandAllModules(layout) {
			return PANEL_MODULE_IDS.reduce((next, moduleId) => next.collapsed[moduleId] === true ? setModuleCollapsed(next, moduleId, false) : next, layout);
		}
		/**
		* The header's layout popover: per-column module controls (visibility, ↑↓←→,
		* fold), the hidden-module restore list, expand-all and reset. Escape and an
		* outside pointer both close it; every control is a real keyboard-reachable
		* button/checkbox.
		*/
		function LayoutMenu({ t, layout, onChangeLayout }) {
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open || typeof window === "undefined") return void 0;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root !== null && !root.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("pointerdown", onPointerDown);
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("pointerdown", onPointerDown);
					window.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			const moduleLabel = (moduleId) => t(`module.${moduleId}`);
			const moveColumn = (moduleId, column) => onChangeLayout(moveModule(layout, moduleId, column));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-layout-menu-root",
				ref: rootRef,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: open ? "cf-btn cf-btn-on cf-mono" : "cf-btn cf-mono",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": t("aria.layoutMenu"),
					title: t("layout.open"),
					onClick: () => setOpen((value) => !value),
					children: [(0, react_jsx_runtime.jsx)(IconLayout, {}), t("layout.title")]
				}), open ? (0, react_jsx_runtime.jsxs)("div", {
					className: "cf-layout-pop",
					role: "dialog",
					"aria-label": t("aria.layoutMenu"),
					children: [
						PANEL_COLUMN_IDS.map((column) => (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-layout-group",
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-layout-heading cf-mono",
								children: t(`layout.column.${column}`)
							}), layout.columns[column].map((moduleId, index) => {
								const collapsed = layout.collapsed[moduleId] === true;
								const label = moduleLabel(moduleId);
								return (0, react_jsx_runtime.jsxs)("div", {
									className: "cf-layout-row",
									children: [
										(0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: true,
											"aria-label": t("layout.hideModule", { module: label }),
											title: t("layout.hideModule", { module: label }),
											onChange: () => onChangeLayout(hideModule(layout, moduleId))
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "cf-layout-name",
											title: label,
											children: label
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "cf-icon-btn",
											disabled: index === 0,
											"aria-label": t("layout.moveUp", { module: label }),
											title: t("layout.moveUp", { module: label }),
											onClick: () => onChangeLayout(moveModule(layout, moduleId, column, index - 1)),
											children: "↑"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "cf-icon-btn",
											disabled: index === layout.columns[column].length - 1,
											"aria-label": t("layout.moveDown", { module: label }),
											title: t("layout.moveDown", { module: label }),
											onClick: () => onChangeLayout(moveModule(layout, moduleId, column, index + 1)),
											children: "↓"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "cf-icon-btn",
											disabled: column === "left",
											"aria-label": t("layout.moveLeft", { module: label }),
											title: t("layout.moveLeft", { module: label }),
											onClick: () => moveColumn(moduleId, column === "right" ? "mid" : "left"),
											children: "←"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "cf-icon-btn",
											disabled: column === "right",
											"aria-label": t("layout.moveRight", { module: label }),
											title: t("layout.moveRight", { module: label }),
											onClick: () => moveColumn(moduleId, column === "left" ? "mid" : "right"),
											children: "→"
										}),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "cf-icon-btn",
											"aria-pressed": collapsed,
											"aria-label": collapsed ? t("layout.unfoldModule", { module: label }) : t("layout.foldModule", { module: label }),
											title: collapsed ? t("layout.unfold") : t("layout.fold"),
											onClick: () => onChangeLayout(toggleModuleCollapsed(layout, moduleId)),
											children: collapsed ? "▸" : "▾"
										})
									]
								}, moduleId);
							})]
						}, column)),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-layout-group",
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-layout-heading cf-mono",
								children: t("layout.hidden")
							}), layout.hidden.length === 0 ? (0, react_jsx_runtime.jsx)("div", {
								className: "cf-layout-muted",
								children: t("layout.noHidden")
							}) : layout.hidden.map((moduleId) => (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-layout-hidden-row",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-layout-name",
									children: moduleLabel(moduleId)
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cf-tool-btn",
									"aria-label": t("layout.showModule", { module: moduleLabel(moduleId) }),
									onClick: () => onChangeLayout(showModule(layout, moduleId)),
									children: t("layout.show")
								})]
							}, moduleId))]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "cf-layout-footer",
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cf-tool-btn",
								onClick: () => onChangeLayout(expandAllModules(layout)),
								children: t("layout.expandAll")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cf-tool-btn cf-tool-btn-danger",
								onClick: () => onChangeLayout(createDefaultLayout()),
								children: t("layout.reset")
							})]
						})
					]
				}) : null]
			});
		}
		/**
		* The three dockable columns, as a pure projection of one snapshot.
		*
		* Exported separately from {@link FactoryCockpit} so the board can be rendered
		* against a fixture without a host (offline verification, story-style specs).
		*
		* @param props - translation seat, snapshot, clock, completeness, and layout override/control.
		* @returns the alert strip above the dockable board, or the "waiting for the
		*   full snapshot" notice while only a summary is known.
		*/
		function FactoryCockpitBody({ t, snapshot, now, complete, initialLayout, layout, onChangeLayout }) {
			const stats = aggregate(snapshot, now);
			const [choice, setChoice] = (0, react.useState)(void 0);
			const [selectedStageId, setSelectedStageId] = (0, react.useState)(void 0);
			const [stageOnly, setStageOnly] = (0, react.useState)(false);
			const [rosterQuery, setRosterQuery] = (0, react.useState)("");
			const [rosterStatus, setRosterStatus] = (0, react.useState)("all");
			const [rosterSort, setRosterSort] = (0, react.useState)("roster");
			const [workQuery, setWorkQuery] = (0, react.useState)("");
			const [workKind, setWorkKind] = (0, react.useState)("all");
			const [workUnread, setWorkUnread] = (0, react.useState)(false);
			const [feedQuery, setFeedQuery] = (0, react.useState)("");
			const [feedKind, setFeedKind] = (0, react.useState)("all");
			const [artifactQuery, setArtifactQuery] = (0, react.useState)("");
			const [artifactSort, setArtifactSort] = (0, react.useState)("newest");
			const [dodFilter, setDodFilter] = (0, react.useState)("all");
			const [lessonFilter, setLessonFilter] = (0, react.useState)("all");
			const [lessonRole, setLessonRole] = (0, react.useState)("all");
			const [internalLayout, setInternalLayout] = (0, react.useState)(() => normaliseLayout(initialLayout ?? readLayout()));
			const activeLayout = layout === void 0 ? internalLayout : normaliseLayout(layout);
			const commitLayout = (0, react.useCallback)((next) => {
				const normal = normaliseLayout(next);
				if (onChangeLayout !== void 0) {
					onChangeLayout(normal);
					return;
				}
				setInternalLayout(normal);
			}, [onChangeLayout]);
			(0, react.useEffect)(() => {
				if (layout !== void 0 || initialLayout !== void 0 || typeof window === "undefined") return void 0;
				const timer = window.setTimeout(() => writeLayout(internalLayout), 50);
				return () => window.clearTimeout(timer);
			}, [
				internalLayout,
				layout,
				initialLayout
			]);
			const selected = (0, react.useMemo)(() => {
				return (choice && choice.factoryId === snapshot.id ? snapshot.members.find((m) => m.role === choice.role) : void 0) ?? pickMember(snapshot.members);
			}, [choice, snapshot]);
			const roleMessages = (0, react.useMemo)(() => {
				if (!selected) return [];
				return snapshot.feed.filter((message) => message.from === selected.role || message.to === selected.role).slice().sort((left, right) => left.ts - right.ts);
			}, [selected, snapshot.feed]);
			const inspector = (0, react.useMemo)(() => selectedStageId === void 0 ? void 0 : buildStageInspector(snapshot, selectedStageId), [snapshot, selectedStageId]);
			(0, react.useEffect)(() => {
				if (selectedStageId !== void 0 && inspector === void 0) {
					setSelectedStageId(void 0);
					setStageOnly(false);
				}
			}, [selectedStageId, inspector]);
			const effectiveStageId = stageOnly ? inspector?.stage.id : void 0;
			const messages = (0, react.useMemo)(() => filterFeedMessages(roleMessages, {
				query: workQuery,
				kind: workKind,
				unreadOnly: workUnread,
				stageId: effectiveStageId
			}), [
				roleMessages,
				workQuery,
				workKind,
				workUnread,
				effectiveStageId
			]);
			if (!complete) return (0, react_jsx_runtime.jsx)("div", {
				className: "cf-fill cf-scroll",
				children: (0, react_jsx_runtime.jsx)(EmptyBlock, {
					title: t("state.summary.title"),
					body: t("state.summary.body")
				})
			});
			const activeStages = snapshot.stages.filter((stage) => stage.status === "active" || stage.status === "gate");
			const progressColor = snapshot.phase === "delivered" ? TOKEN.success : TOKEN.brand;
			const liveWork = selected ? PULSING_MEMBER_STATUS[selected.status] : false;
			const selectedSwatch = selected ? roleSwatch(selected.role, selected.color) : "";
			const workFiltering = workQuery.trim() !== "" || workKind !== "all" || workUnread || effectiveStageId !== void 0;
			const activeMembers = snapshot.members.filter((member) => member.status === "working" || member.status === "rework").length;
			const passedDod = snapshot.dod.filter((item) => dodVerdict(item) === "passed").length;
			const handleSelectStage = (stageId) => {
				if (selectedStageId === stageId) {
					setSelectedStageId(void 0);
					setStageOnly(false);
					return;
				}
				setSelectedStageId(stageId);
			};
			const renderModule = (moduleId) => {
				switch (moduleId) {
					case "roster": return (0, react_jsx_runtime.jsx)(RosterContent, {
						snapshot,
						t,
						selectedRole: selected?.role,
						onSelectRole: (role) => setChoice({
							factoryId: snapshot.id,
							role
						}),
						query: rosterQuery,
						onQuery: setRosterQuery,
						statusFilter: rosterStatus,
						onStatusFilter: setRosterStatus,
						sort: rosterSort,
						onSort: setRosterSort
					});
					case "pipeline": return (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-pipe",
						children: [snapshot.stages.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, { title: t("pipeline.empty") }) : (0, react_jsx_runtime.jsx)("div", {
							className: "cf-pipe-track cf-scroll",
							role: "list",
							children: snapshot.stages.map((stage, index) => (0, react_jsx_runtime.jsxs)("div", {
								role: "listitem",
								style: {
									display: "flex",
									alignItems: "center",
									flex: "none"
								},
								children: [index > 0 ? (0, react_jsx_runtime.jsx)(PipelineConnector, { previous: snapshot.stages[index - 1] }) : null, (0, react_jsx_runtime.jsx)(StageChip, {
									stage,
									t,
									snapshot,
									selected: selectedStageId === stage.id,
									onSelect: () => handleSelectStage(stage.id)
								})]
							}, stage.id))
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-pipe-legend cf-mono",
							children: [
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-pipe-legend-item",
									children: [
										(0, react_jsx_runtime.jsx)(IconBranch, {}),
										" ",
										t("pipeline.legend.parallel")
									]
								}),
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-pipe-legend-item",
									children: [
										(0, react_jsx_runtime.jsx)(IconShield, {}),
										" ",
										t("pipeline.legend.approval")
									]
								}),
								(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-pipe-legend-item",
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: "cf-led",
											style: { color: TOKEN.error }
										}),
										" ",
										t("pipeline.legend.rework")
									]
								})
							]
						})]
					});
					case "inspector": return inspector ? (0, react_jsx_runtime.jsx)(StageInspectorPanel, {
						snapshot,
						t,
						now,
						inspector,
						stageOnly,
						onToggleStageOnly: () => setStageOnly((value) => !value),
						onClose: () => {
							setSelectedStageId(void 0);
							setStageOnly(false);
						}
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: "cf-module-empty cf-mono",
						children: t("inspector.empty")
					});
					case "work": return (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-work",
						children: [selected ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-work-head",
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-work-avatar",
										children: [(0, react_jsx_runtime.jsx)(RoleAvatar, {
											role: selected.role,
											swatch: selectedSwatch,
											codename: selected.codename,
											title: selected.title,
											size: 32
										}), (0, react_jsx_runtime.jsx)("span", {
											className: "cf-work-code cf-mono",
											style: { color: roleInk(selectedSwatch) },
											children: selected.codename
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-work-id",
										children: [(0, react_jsx_runtime.jsxs)("div", {
											className: "cf-work-name",
											children: [(0, react_jsx_runtime.jsx)("span", { children: selected.title }), (0, react_jsx_runtime.jsx)("span", {
												className: "cf-chip cf-mono",
												style: {
													color: MEMBER_STATUS_COLOR[selected.status],
													borderColor: wash(MEMBER_STATUS_COLOR[selected.status], 45)
												},
												children: t(`member.status.${selected.status}`)
											})]
										}), (0, react_jsx_runtime.jsx)("div", {
											className: "cf-work-duties",
											children: selected.duties || t("format.none")
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "cf-work-side cf-mono",
										children: [
											(0, react_jsx_runtime.jsxs)("span", { children: [
												t("roster.model"),
												": ",
												selected.model ?? t(selected.tier === "reasoner" ? "roster.tier.reasoner" : "roster.tier.chat")
											] }),
											selected.provider ? (0, react_jsx_runtime.jsxs)("span", { children: [
												t("roster.details.provider"),
												": ",
												selected.provider
											] }) : null,
											selected.reasoningEffort ? (0, react_jsx_runtime.jsxs)("span", { children: [
												t("roster.details.effort"),
												": ",
												selected.reasoningEffort
											] }) : null,
											selected.sessionId ? (0, react_jsx_runtime.jsxs)("span", { children: [
												t("work.session"),
												": ",
												selected.sessionId.slice(0, 12)
											] }) : null,
											(0, react_jsx_runtime.jsx)("span", { children: t("work.messages", { count: messages.length }) })
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-toolbar",
								children: [
									(0, react_jsx_runtime.jsx)(SearchField, {
										t,
										value: workQuery,
										onChange: setWorkQuery,
										placeholder: t("work.search"),
										ariaLabel: t("work.search")
									}),
									(0, react_jsx_runtime.jsx)(FeedKindChips, {
										t,
										kind: workKind,
										onKind: setWorkKind
									}),
									(0, react_jsx_runtime.jsx)(FilterChip, {
										active: workUnread,
										label: t("work.unreadOnly"),
										onClick: () => setWorkUnread((value) => !value)
									}),
									effectiveStageId !== void 0 ? (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "cf-tool-btn cf-tool-btn-on",
										onClick: () => setStageOnly(false),
										children: [t("inspector.stageFilter", { stage: stageName(snapshot, effectiveStageId) ?? effectiveStageId }), " ×"]
									}) : null
								]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-stream cf-scroll",
								children: [(0, react_jsx_runtime.jsx)("div", {
									className: "cf-stream-head cf-mono",
									children: t("work.title")
								}), roleMessages.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
									title: t("work.streamEmpty"),
									body: t("work.empty.body")
								}) : messages.length === 0 ? (0, react_jsx_runtime.jsx)(EmptyBlock, {
									title: t("work.filteredEmptyTitle"),
									body: t("work.filteredEmptyBody")
								}) : messages.map((message, index) => (0, react_jsx_runtime.jsx)(MessageRow, {
									snapshot,
									t,
									message,
									caret: liveWork && !workFiltering && index === messages.length - 1
								}, message.id))]
							}),
							selected.spawnError ? (0, react_jsx_runtime.jsxs)("div", {
								className: "cf-halt cf-mono",
								style: { color: TOKEN.error },
								children: [
									t("work.spawnError"),
									": ",
									selected.spawnError
								]
							}) : null
						] }) : (0, react_jsx_runtime.jsx)("div", {
							className: "cf-fill cf-scroll",
							children: (0, react_jsx_runtime.jsx)(EmptyBlock, {
								title: t("work.none"),
								body: t("work.empty.body")
							})
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: "cf-halt cf-mono",
							children: [
								(0, react_jsx_runtime.jsxs)("span", { children: [
									t("header.progress"),
									" ",
									stats.overall,
									"%"
								] }),
								(0, react_jsx_runtime.jsx)("div", {
									className: "cf-meter",
									role: "progressbar",
									"aria-label": t("aria.progress", { percent: stats.overall }),
									"aria-valuenow": stats.overall,
									"aria-valuemin": 0,
									"aria-valuemax": 100,
									children: (0, react_jsx_runtime.jsx)("div", {
										className: "cf-meter-fill",
										style: {
											width: `${stats.overall}%`,
											background: progressColor
										}
									})
								}),
								(0, react_jsx_runtime.jsxs)("span", { children: [
									t("header.tokens"),
									" ",
									formatTokens(stats.tokens)
								] }),
								(0, react_jsx_runtime.jsx)("span", { children: activeStages.length > 0 ? `${activeStages[0]?.name ?? ""}` : t("format.none") })
							]
						})]
					});
					case "feed": return (0, react_jsx_runtime.jsx)(FeedContent, {
						snapshot,
						t,
						query: feedQuery,
						onQuery: setFeedQuery,
						kind: feedKind,
						onKind: setFeedKind
					});
					case "artifacts": return (0, react_jsx_runtime.jsx)(ArtifactsContent, {
						snapshot,
						t,
						now,
						query: artifactQuery,
						onQuery: setArtifactQuery,
						sort: artifactSort,
						onSort: setArtifactSort,
						stageId: effectiveStageId,
						onClearStage: () => setStageOnly(false)
					});
					case "dod": return (0, react_jsx_runtime.jsx)(DodContent, {
						snapshot,
						t,
						filter: dodFilter,
						onFilter: setDodFilter
					});
					case "evolution": return (0, react_jsx_runtime.jsx)(EvolutionContent, {
						snapshot,
						t,
						filter: lessonFilter,
						onFilter: setLessonFilter,
						role: lessonRole,
						onRole: setLessonRole,
						now
					});
					default: return null;
				}
			};
			const moduleNote = (moduleId) => {
				switch (moduleId) {
					case "roster": return t("roster.active", {
						active: activeMembers,
						total: snapshot.members.length
					});
					case "pipeline": return `${snapshot.pipeline || t("format.none")} · ${t("pipeline.subtitle")}`;
					case "inspector": return inspector ? inspector.stage.name : t("format.none");
					case "work": return selected ? t("work.messages", { count: messages.length }) : t("format.none");
					case "feed": return t("section.feedNote", { count: filterFeedMessages(snapshot.feed, {
						query: feedQuery,
						kind: feedKind
					}).length });
					case "artifacts": return t("section.artifactsNote", { count: filterArtifacts(snapshot.artifacts, {
						query: artifactQuery,
						stageId: effectiveStageId
					}).length });
					case "dod": return t("section.dodNote", {
						passed: passedDod,
						total: snapshot.dod.length
					});
					case "evolution": return t("section.evolutionNote", { count: filterLessons(snapshot.evolution?.lessons ?? [], lessonFilter, resolveLessonRole(snapshot, lessonRole)).length });
					default: return;
				}
			};
			const displayLayout = snapshot.evolution !== void 0 ? activeLayout : {
				...activeLayout,
				columns: {
					left: activeLayout.columns.left.filter((id) => id !== "evolution"),
					mid: activeLayout.columns.mid.filter((id) => id !== "evolution"),
					right: activeLayout.columns.right.filter((id) => id !== "evolution")
				}
			};
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(AlertStrip, {
				t,
				alerts: snapshot.alerts
			}), (0, react_jsx_runtime.jsx)(PanelBoard, {
				t,
				layout: displayLayout,
				onChangeLayout: commitLayout,
				renderModule,
				moduleNote
			})] });
		}
		/** Per-scope chip colour. `picked` is amber: an override of the session scope. */
		const SCOPE_COLOR = {
			session: TOKEN.brand,
			picked: TOKEN.warn,
			index: TOKEN.idle
		};
		/**
		* The cockpit's top strip: identity, phase, link state, scope, mission brief,
		* runtime metrics, and the auto-refresh / picker actions. Exported so a headless
		* check can render it against a fixture feed.
		*
		* The brief clamps to two lines and expands on demand; security hits are a
		* separate full-width row (a header child would squeeze the metric strip), and
		* both are local UI state so the pure data path stays unchanged.
		*
		* @param props - translation seat, snapshot, feed state, clock, completeness, scope, and control wiring.
		* @returns the header markup plus the expandable security-hits row.
		*/
		function FactoryCockpitHeader({ t, snapshot, feed, now, selectedId, onSelect, complete, scope, paused = false, onTogglePause, layout, onChangeLayout }) {
			const [briefOpen, setBriefOpen] = (0, react.useState)(false);
			const [hitsOpen, setHitsOpen] = (0, react.useState)(false);
			const stats = snapshot && complete ? aggregate(snapshot, now) : void 0;
			const phaseColor = snapshot ? PHASE_COLOR[snapshot.phase] : TOKEN.idle;
			const linkColor = LINK_COLOR[feed.status];
			const progress = stats?.overall ?? 0;
			const alerts = snapshot?.alerts ?? [];
			const actions = alerts.filter((alert) => alert.severity === "action").length;
			const alertColor = actions > 0 ? TOKEN.error : TOKEN.warn;
			const firstAlert = alerts[0];
			const hits = snapshot?.securityHits ?? [];
			const securityTriggered = snapshot?.securityTriggered === true;
			const securitySource = snapshot?.securitySource;
			const brief = snapshot?.brief || t("empty.body");
			const briefLong = brief.length > 120 || brief.includes("\n");
			const updatedAgo = snapshot ? formatAgo(now - (snapshot.updatedAt || snapshot.createdAt), t) : t("format.none");
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("header", {
				className: "cf-header",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-brand",
						children: [(0, react_jsx_runtime.jsx)(IconRadar, {}), (0, react_jsx_runtime.jsxs)("div", {
							style: { minWidth: 0 },
							children: [(0, react_jsx_runtime.jsx)("div", {
								className: "cf-brand-name cf-mono",
								children: t("app.brand")
							}), (0, react_jsx_runtime.jsx)("div", {
								className: "cf-brand-sub cf-mono",
								children: t("app.brandSub")
							})]
						})]
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: "cf-badge cf-mono",
						style: {
							color: phaseColor,
							borderColor: wash(phaseColor, 40)
						},
						children: [(0, react_jsx_runtime.jsx)(Led, {
							color: phaseColor,
							pulse: snapshot?.phase === "running"
						}), snapshot ? t(`header.phase.${snapshot.phase}`) : t("header.factoryNone")]
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: "cf-badge cf-mono",
						style: {
							color: linkColor,
							borderColor: wash(linkColor, 40)
						},
						title: feed.error,
						children: [(0, react_jsx_runtime.jsx)(Led, {
							color: linkColor,
							pulse: feed.status === "connecting" || feed.status === "stale"
						}), t(`header.link.${feed.status}`)]
					}),
					paused ? (0, react_jsx_runtime.jsx)("span", {
						className: "cf-badge cf-mono",
						style: {
							color: TOKEN.warn,
							borderColor: wash(TOKEN.warn, 40)
						},
						children: t("header.paused")
					}) : null,
					firstAlert ? (0, react_jsx_runtime.jsx)("span", {
						className: "cf-badge cf-mono",
						style: {
							color: alertColor,
							borderColor: wash(alertColor, 40),
							background: wash(alertColor, 12)
						},
						title: t("alert.badgeTitle", {
							title: firstAlert.title,
							next: firstAlert.next
						}),
						children: t("alert.badge", { count: actions > 0 ? actions : alerts.length })
					}) : null,
					(0, react_jsx_runtime.jsx)("span", {
						className: "cf-chip cf-mono",
						style: {
							color: SCOPE_COLOR[scope],
							borderColor: wash(SCOPE_COLOR[scope], 40)
						},
						title: t("header.scope.hint"),
						children: t(`header.scope.${scope}`)
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-mission",
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-mission-line cf-mono",
								children: [(0, react_jsx_runtime.jsxs)("span", {
									className: "cf-ellipsis",
									children: [
										t("header.mission"),
										": ",
										snapshot ? snapshot.name : t("header.factoryNone")
									]
								}), (0, react_jsx_runtime.jsxs)("span", {
									className: "cf-ellipsis",
									children: [
										snapshot?.taskType ? `${t("header.taskType")} ${snapshot.taskType}` : "",
										snapshot?.pipeline ? ` · ${t("header.pipeline")} ${snapshot.pipeline}` : "",
										securityTriggered ? ` · ${t("header.security")} ${t("header.securityOn")}` : ""
									]
								})]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: briefOpen ? "cf-mission-text cf-mission-text-open cf-mono" : "cf-mission-text cf-mono",
								title: brief,
								children: brief
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-mission-tools cf-mono",
								children: [
									briefLong ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "cf-linkish",
										"aria-expanded": briefOpen,
										onClick: () => setBriefOpen((value) => !value),
										children: briefOpen ? t("header.briefCollapse") : t("header.briefExpand")
									}) : null,
									securityTriggered && hits.length > 0 ? (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "cf-chip-btn",
										"aria-expanded": hitsOpen,
										onClick: () => setHitsOpen((value) => !value),
										children: [
											t("header.securityHits"),
											" (",
											hits.length,
											")"
										]
									}) : null,
									snapshot?.approvedAt ? (0, react_jsx_runtime.jsxs)("span", {
										className: "cf-chip cf-mono",
										style: {
											color: TOKEN.success,
											borderColor: wash(TOKEN.success, 40)
										},
										children: [
											t("header.approved"),
											" · ",
											formatClock(snapshot.approvedAt)
										]
									}) : null,
									snapshot?.deliveryPath ? (0, react_jsx_runtime.jsxs)("span", {
										className: "cf-chip cf-mono cf-ellipsis",
										style: { maxWidth: 200 },
										title: snapshot.deliveryPath,
										children: [
											t("header.deliveryPath"),
											": ",
											snapshot.deliveryPath
										]
									}) : null,
									(0, react_jsx_runtime.jsx)("span", {
										className: "cf-chip cf-mono",
										style: { color: TOKEN.labelSecondary },
										children: t("header.updatedAgo", { ago: updatedAgo })
									})
								]
							}),
							stats ? (0, react_jsx_runtime.jsx)("div", {
								className: "cf-bar",
								role: "progressbar",
								"aria-label": t("aria.progress", { percent: progress }),
								"aria-valuenow": progress,
								"aria-valuemin": 0,
								"aria-valuemax": 100,
								children: (0, react_jsx_runtime.jsx)("div", {
									className: "cf-bar-fill",
									style: {
										width: `${progress}%`,
										background: snapshot?.phase === "delivered" ? TOKEN.success : TOKEN.brand
									}
								})
							}) : null
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-metrics cf-mono",
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.stages")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: stats ? `${stats.stagesPassed}/${stats.stagesTotal}` : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.tokens")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: stats ? formatTokens(stats.tokens) : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.artifacts")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: stats ? stats.artifacts : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.dod")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: stats ? `${stats.dodPassed}/${stats.dodTotal}` : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.messages")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: snapshot?.feed.length ?? t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.alerts")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									style: alerts.length > 0 ? { color: alertColor } : void 0,
									children: snapshot ? alerts.length : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.elapsed")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									children: stats ? formatDuration(stats.elapsedMs) : t("format.none")
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "cf-metric",
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-k",
									children: t("header.clock")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: "cf-metric-v",
									style: { color: TOKEN.brand },
									children: formatClock(now)
								})]
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-actions",
						children: [
							feed.factories.length > 0 ? (0, react_jsx_runtime.jsxs)("select", {
								className: "cf-select cf-mono",
								"aria-label": t("header.pickFactory"),
								value: selectedId ?? "",
								onChange: (event) => onSelect(event.target.value || void 0),
								children: [(0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("header.pickFactoryHint")
								}), feed.factories.map((factory) => (0, react_jsx_runtime.jsxs)("option", {
									value: factory.id,
									children: [
										factory.name,
										" · ",
										factory.id
									]
								}, factory.id))]
							}) : null,
							layout !== void 0 && onChangeLayout !== void 0 ? (0, react_jsx_runtime.jsx)(LayoutMenu, {
								t,
								layout,
								onChangeLayout
							}) : null,
							(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: paused ? "cf-btn cf-btn-on cf-mono" : "cf-btn cf-mono",
								onClick: onTogglePause,
								"aria-pressed": paused,
								"aria-label": t("aria.autoRefresh"),
								title: paused ? t("header.resume") : t("header.pause"),
								children: [paused ? (0, react_jsx_runtime.jsx)(IconPlay, {}) : (0, react_jsx_runtime.jsx)(IconPause, {}), paused ? t("header.resume") : t("header.pause")]
							}),
							(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "cf-btn cf-mono",
								onClick: feed.reload,
								title: t("header.refresh"),
								children: [(0, react_jsx_runtime.jsx)(IconRefresh, {}), t("header.refresh")]
							})
						]
					})
				]
			}), securityTriggered && hitsOpen ? (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-hits cf-mono",
				"aria-label": t("aria.hits"),
				children: [
					(0, react_jsx_runtime.jsx)("span", { children: t("header.securityHits") }),
					hits.length === 0 ? (0, react_jsx_runtime.jsx)("span", { children: t("format.none") }) : hits.map((hit) => (0, react_jsx_runtime.jsx)("span", {
						className: "cf-chip",
						style: {
							color: TOKEN.warn,
							borderColor: wash(TOKEN.warn, 40)
						},
						children: hit
					}, hit)),
					(0, react_jsx_runtime.jsx)("span", { children: securitySource ? t(`header.securitySource.${securitySource}`) : t("header.securitySource.none") })
				]
			}) : null] });
		}
		/**
		* The waiting-state headline for a link that has no snapshot to show.
		*
		* The headline stays "no factory yet" from the first tick onward — only the
		* sub-line reports transport progress — so a slow first read cannot flash a
		* different message and then swap it out.
		*/
		function waitingTitle(t, feed) {
			switch (feed.status) {
				case "error": return t("empty.error", { message: feed.error ?? "" });
				case "stale": return t("empty.stale");
				default: return t("empty.title");
			}
		}
		/**
		* The poll scope the cockpit actually asks for.
		*
		* This is the one place the panel's request scope is decided, and it is exported
		* so the offline harness can hold it to the contract. The defect it encodes is a
		* main panel that only ever polled the bare route: that route returns the
		* cross-workspace **index** (docs/API-CONTRACTS.md §7.1/§7.3), five summary
		* fields with no members, stages, DoD or feed — so the header filled in while
		* everything else rendered as empty collections. Naming this session upgrades
		* the request to the full snapshot, exactly like the turn card does it.
		*
		* An explicit pick from the header picker outranks the session: `factoryStateUrl`
		* gives `?id=` precedence, so the derivation can never override a user's choice.
		*
		* @param selectedId - the user's explicit pick, or `undefined` for none.
		* @param sessionId - the session this panel speaks for, or `undefined` if unknown.
		* @returns the scope `useFactoryState` polls with.
		*/
		function cockpitPollTarget(selectedId, sessionId) {
			return {
				factoryId: selectedId,
				sessionId
			};
		}
		/**
		* The cockpit's `main`-slot occupant.
		*
		* @param props - the injected business face plus the framework's `t` seat.
		* @returns the full-width three-column cockpit, or its waiting empty state.
		*/
		function FactoryCockpit(props) {
			const { t, route, pollMs, useSessions } = props;
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const [paused, setPaused] = (0, react.useState)(false);
			const [layout, setLayout] = (0, react.useState)(() => readLayout());
			(0, react.useEffect)(() => {
				if (typeof window === "undefined") return void 0;
				const timer = window.setTimeout(() => writeLayout(layout), 50);
				return () => window.clearTimeout(timer);
			}, [layout]);
			const pollTarget = cockpitPollTarget(selectedId, useSessions(currentSessionId));
			const feed = useFactoryState({
				route,
				pollMs,
				...pollTarget,
				enabled: !paused
			});
			const scope = pollTarget.factoryId ? "picked" : pollTarget.sessionId ? "session" : "index";
			const now = useNow(1e3);
			const snapshot = feed.snapshot;
			const togglePause = () => {
				if (paused) {
					setPaused(false);
					feed.reload();
					return;
				}
				setPaused(true);
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-root",
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: "cf-scan",
						"aria-hidden": "true"
					}),
					(0, react_jsx_runtime.jsx)(FactoryCockpitHeader, {
						t,
						snapshot,
						feed,
						now,
						selectedId,
						onSelect: setSelectedId,
						complete: feed.complete,
						scope,
						paused,
						onTogglePause: togglePause,
						layout,
						onChangeLayout: setLayout
					}),
					snapshot ? (0, react_jsx_runtime.jsx)(FactoryCockpitBody, {
						t,
						snapshot,
						now,
						complete: feed.complete,
						layout,
						onChangeLayout: setLayout
					}, snapshot.id) : (0, react_jsx_runtime.jsx)("div", {
						className: "cf-fill cf-scroll",
						children: (0, react_jsx_runtime.jsx)(EmptyBlock, {
							title: waitingTitle(t, feed),
							body: feed.status === "error" ? t("empty.body") : t("empty.waiting"),
							action: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "cf-btn cf-mono",
								onClick: feed.reload,
								children: [(0, react_jsx_runtime.jsx)(IconRefresh, {}), t("empty.retry")]
							})
						})
					})
				]
			});
		}
		/**
		* `sidebar.panellist` entry: the icon for this plugin's `main` panel.
		*
		* The sidebar owns the row: it declares `sidebar.panellist` as a list whose
		* *"each list id addresses the matching main panel; the sidebar owns the button
		* and resolves its label from list metadata"*. So this component renders the
		* glyph only — no `<button>`, no `onClick`, no accessible name (a nested
		* interactive element inside the shell's button would be invalid HTML, and the
		* row already performs `selectPanel` for the matching `main` key).
		*
		* The owner share drives the two things the shell wants the glyph to express:
		*
		*   `size`   — the requested square edge in pixels, so the icon matches the
		*              rail's other panel glyphs at whatever geometry the column is in.
		*   `active` — whether this panel is the selected one in the main column.
		*              Selected: the brand token, so the choice is unambiguous.
		*              Otherwise `currentColor`, which lets the shell's own hover and
		*              rail styling show through instead of fighting it.
		*
		* A small dot still marks a running factory; it is decorative and carries no
		* interactive semantics of its own.
		*
		* @param props - the owner share plus the injected business face and `t` seat.
		* @returns the panel glyph, sized and tinted for the sidebar row.
		*/
		function FactorySidebarEntry(props) {
			const { route, pollMs, size, active } = props;
			const running = useFactoryState({
				route,
				pollMs
			}).snapshot?.phase === "running";
			return (0, react_jsx_runtime.jsxs)("span", {
				className: "cf-entry-icon",
				style: {
					width: size,
					height: size,
					color: active ? TOKEN.brand : "currentColor"
				},
				children: [(0, react_jsx_runtime.jsx)(IconGrid, { size }), running ? (0, react_jsx_runtime.jsx)("span", {
					className: "cf-entry-dot",
					"aria-hidden": "true"
				}) : null]
			});
		}
		/**
		* `conversation.chat.turnTail` contribution: a compact summary of **this
		* session's** factory that opens the cockpit. Renders nothing while the host
		* reports no factory for the session, so the turn tail stays clean in ordinary
		* conversations.
		*
		* The poll is scoped by `sessionId` (`?sessionId=`, docs/API-CONTRACTS.md §7.1):
		* the card must show the factory this conversation is driving, not whichever
		* factory happens to be the most recently updated in the cross-workspace index.
		* The host resolves the workspace from the session itself; no path is ever sent.
		*
		* @param props - the session-scope standard seat, the injected business face, and `t`.
		* @returns the summary card, or `null` when there is no factory for this session.
		*/
		function FactoryTurnCard(props) {
			const { t, route, pollMs, openCockpit, sessionId } = props;
			const feed = useFactoryState({
				route,
				pollMs,
				sessionId
			});
			const now = useNow(5e3);
			const snapshot = feed.snapshot;
			if (!snapshot) return null;
			const stats = aggregate(snapshot, now);
			const phaseColor = PHASE_COLOR[snapshot.phase];
			const stage = snapshot.stages.find((item) => item.status === "active" || item.status === "gate");
			const detailed = feed.complete;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cf-card-shell",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-card-head",
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-brand-name cf-mono",
								style: {
									fontSize: 11,
									letterSpacing: ".16em"
								},
								children: t("card.title")
							}),
							(0, react_jsx_runtime.jsxs)("span", {
								className: "cf-badge cf-mono",
								style: {
									color: phaseColor,
									borderColor: wash(phaseColor, 40)
								},
								children: [(0, react_jsx_runtime.jsx)(Led, {
									color: phaseColor,
									pulse: snapshot.phase === "running"
								}), t(`header.phase.${snapshot.phase}`)]
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-chip cf-mono cf-ellipsis",
								style: { maxWidth: 220 },
								title: snapshot.brief,
								children: snapshot.name
							})
						]
					}),
					detailed ? (0, react_jsx_runtime.jsxs)("div", {
						className: "cf-card-stats cf-mono",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: t("card.stage", {
								done: stats.stagesPassed,
								total: stats.stagesTotal
							}) }),
							(0, react_jsx_runtime.jsx)("span", { children: t("card.members", { count: stats.totalMembers }) }),
							(0, react_jsx_runtime.jsx)("span", { children: t("card.dod", {
								passed: stats.dodPassed,
								total: stats.dodTotal
							}) }),
							(0, react_jsx_runtime.jsx)("span", { children: t("card.artifacts", { count: stats.artifacts }) }),
							stage ? (0, react_jsx_runtime.jsx)("span", {
								style: { color: STAGE_STATUS_COLOR[stage.status] },
								children: stage.name
							}) : (0, react_jsx_runtime.jsx)("span", { children: t("card.waiting") })
						]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: "cf-card-stats cf-mono",
						children: (0, react_jsx_runtime.jsx)("span", { children: t("card.waiting") })
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "cf-card-head",
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								className: "cf-bar",
								style: {
									flex: "1 1 120px",
									marginTop: 0
								},
								children: (0, react_jsx_runtime.jsx)("div", {
									className: "cf-bar-fill",
									style: {
										width: `${detailed ? stats.overall : 0}%`,
										background: snapshot.phase === "delivered" ? TOKEN.success : TOKEN.brand
									}
								})
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cf-linkish cf-mono",
								onClick: openCockpit,
								children: t("card.open")
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: "cf-card-sub cf-mono",
								children: t("card.updated", { time: formatClock(snapshot.updatedAt || snapshot.createdAt) })
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region lib/client/client/locales.js
		/**
		* `codeFactory` dictionary namespace for every plugin-owned Web surface.
		*
		* Locale contract (docs/API-CONTRACTS.md §2.6): the namespace table lives on
		* `@deepseek-ai/dsh-client-ui-slots` and is extended by declaration merging.
		* Declaring it here has two effects:
		*
		*   1. `ctx.locale.register('codeFactory', { zh, en })` becomes the *typed*
		*      overload — each dictionary is checked against the merged key union, so a
		*      missing or extra key is a compile error and the two languages can never
		*      drift apart.
		*   2. Every slot entry registered with `locale: CODE_FACTORY_LOCALE_NAMESPACE`
		*      receives the framework-synthesized `t` seat, typed to exactly this key
		*      union (plus the shared `common` vocabulary).
		*
		* Chinese is the source of truth for the key set; `en` is constrained by
		* `Record<CodeFactoryLocaleKey, string>` so it must cover it exactly.
		*
		* @module dsh-code-factory/client/locales
		*/
		/** Dictionary namespace owned by the code-factory client plugin. */
		const CODE_FACTORY_LOCALE_NAMESPACE = "codeFactory";
		/** Simplified Chinese dictionary — the key-set source of truth. */
		const zh = {
			"app.brand": "CODE FACTORY",
			"app.brandSub": "多AGENT开发团队指挥中心",
			"app.title": "工厂驾驶舱",
			"header.factory": "工厂",
			"header.factoryNone": "暂无工厂",
			"header.pickFactory": "选择工厂",
			"header.pickFactoryHint": "本会话的工厂（可选看全部工作区）",
			"header.mission": "MISSION",
			"header.taskType": "任务类型",
			"header.pipeline": "流水线",
			"header.security": "安全触发",
			"header.securityOn": "已触发",
			"header.tokens": "TOKENS",
			"header.artifacts": "工件",
			"header.dod": "DoD",
			"header.elapsed": "已用时",
			"header.clock": "时钟",
			"header.progress": "总进度",
			"header.refresh": "立即刷新",
			"header.updatedAt": "更新于 {time}",
			"header.phase.staged": "待审批",
			"header.phase.running": "运行中",
			"header.phase.halted": "已暂停",
			"header.phase.delivered": "已交付",
			"header.phase.discarded": "已废弃",
			"header.link.idle": "未连接",
			"header.link.connecting": "连接中",
			"header.link.live": "实时",
			"header.link.stale": "宿主重启中",
			"header.link.error": "连接失败",
			"header.scope.session": "本会话",
			"header.scope.picked": "手动选定",
			"header.scope.index": "全部工作区索引",
			"header.scope.hint": "面板当前请求的是：本会话的工厂（?sessionId=）／你手动选定的工厂（?id=）／跨工作区索引（索引只用于下拉列表，不会当快照显示）",
			"alert.badge": "⚠ {count}",
			"alert.badgeTitle": "最要紧的一条：{title} → {next}",
			"alert.aria": "需要人工处理的事项",
			"alert.more": "还有 {count} 条",
			"roster.title": "团队编制 ROSTER",
			"roster.active": "{active}/{total} 活跃",
			"roster.empty": "暂无成员编制",
			"roster.tokens": "tokens",
			"roster.stage": "阶段",
			"roster.stageNone": "未分配阶段",
			"roster.model": "模型",
			"roster.legend.reasoner": "编码/审查岗",
			"roster.legend.chat": "非编码岗",
			"roster.tier.reasoner": "reasoner",
			"roster.tier.chat": "chat",
			"member.status.staged": "已入编",
			"member.status.idle": "待命",
			"member.status.working": "工作中",
			"member.status.rework": "返修中",
			"member.status.blocked": "已打回",
			"member.status.done": "已完成",
			"member.status.error": "启动失败",
			"member.status.removed": "已移除",
			"role.captain": "队长",
			"work.title": "WORK OUTPUT · workspace/ 真实产出",
			"work.duties": "职责",
			"work.route": "路由",
			"work.session": "会话",
			"work.spawnError": "启动失败",
			"work.messages": "协作消息 {count}",
			"work.none": "从左侧编制中选择一个角色",
			"work.empty.title": "该 Agent 尚未被调度",
			"work.empty.body": "等待流程引擎到达其负责阶段",
			"work.streamEmpty": "该角色暂无协作消息",
			"work.round": "R{round}",
			"pipeline.title": "流程流水线 PIPELINE",
			"pipeline.subtitle": "门禁强制 · 阶段顺序不可跳",
			"pipeline.empty": "暂无流水线",
			"pipeline.roles": "{count} 角色",
			"pipeline.legend.parallel": "并行阶段",
			"pipeline.legend.approval": "人工审批门禁",
			"pipeline.legend.rework": "打回循环 (R=轮次)",
			"stage.status.pending": "待办",
			"stage.status.active": "进行中",
			"stage.status.gate": "门禁中",
			"stage.status.passed": "已通过",
			"stage.status.rejected": "被打回",
			"pipeline.gate.checklist": "清单门禁",
			"pipeline.gate.keyword": "关键词门禁",
			"pipeline.gate.script": "脚本门禁",
			"pipeline.gate.composite": "复合门禁",
			"pipeline.gate.dod": "DoD 门禁",
			"pipeline.gate.unknown": "门禁未知",
			"pipeline.gate.unknownHint": "该阶段的门禁类型无法解析：流水线模板已缺失，也没有最后一次门禁记录",
			"tabs.feed": "实时动态",
			"tabs.artifacts": "工件 {count}",
			"tabs.dod": "DoD 验收",
			"section.feed": "实时动态",
			"section.feedNote": "{count} 条",
			"section.artifacts": "工件",
			"section.artifactsNote": "{count} 件",
			"section.dod": "DoD 验收",
			"section.dodNote": "{passed}/{total} 通过",
			"section.evolution": "进化 · 跨任务教训",
			"section.evolutionNote": "{count} 条",
			"feed.empty.title": "等待第一条工厂事件",
			"feed.empty.body": "factory_plan 建立工厂后，协作事件会实时出现在这里",
			"feed.round": "R{round}",
			"feed.stage": "阶段 {stage}",
			"feed.endpoint.unparsed": "无法解析",
			"feed.endpoint.unparsedHint": "这条记录的来源/收件人无法解析，工厂记录里没有这一方（不做替换，按原样显示）",
			"feed.kind.system": "系统",
			"feed.kind.dispatch": "派发",
			"feed.kind.reject": "打回",
			"feed.kind.handoff": "交接",
			"feed.kind.report": "汇报",
			"feed.kind.blocked": "阻塞",
			"feed.kind.approval": "审批",
			"artifacts.title": "ARTIFACTS · 工件登记表",
			"artifacts.empty": "workspace/ 暂无产出",
			"artifacts.by": "by {role}",
			"artifacts.stage": "阶段 {stage}",
			"dod.title": "DEFINITION OF DONE · 机器校验 · 缺一不予交付",
			"dod.empty": "尚未生成 DoD 清单",
			"dod.passed": "通过 {passed}/{total}",
			"dod.itemOk": "通过",
			"dod.itemFail": "未通过",
			"dod.itemSkip": "未触发",
			"dod.evidence": "证据",
			"evolution.stat.total": "总教训 {count}",
			"evolution.stat.recurring": "反复出现 {count}",
			"evolution.stat.resolved": "已解决 {count}",
			"evolution.count": "×{count}",
			"evolution.countHint": "同一教训已出现 {count} 次",
			"evolution.resolved": "已解决",
			"evolution.empty": "还没有教训记录",
			"evolution.emptyBody": "门禁打回与 DoD 未通过会沉淀为跨任务教训，派发给后续任务时自动带上",
			"evolution.emptyFiltered": "本工厂暂无相关教训（工作区共 {total} 条）",
			"evolution.emptyFilteredBody": "工作区已有教训，但暂无与本厂角色/阶段匹配的条目；后续任务仍会带上这些经验",
			"evolution.more": "还有 {count} 条",
			"empty.title": "暂无工厂任务",
			"empty.body": "在对话中让队长调用 factory_plan，工厂计划就会显示在这里",
			"empty.waiting": "等待宿主返回工厂快照…",
			"empty.error": "无法读取工厂状态：{message}",
			"empty.stale": "宿主正在重启，显示最后一份快照",
			"empty.retry": "重试",
			"state.summary.title": "正在读取完整快照…",
			"state.summary.body": "宿主返回的是工厂索引摘要（只含 id / 名称 / 任务类型 / 阶段 / 更新时间），成员、流水线、工件与 DoD 详情会在下一次轮询后显示",
			"entry.label": "Code Factory 驾驶舱",
			"entry.aria": "打开 Code Factory 驾驶舱",
			"entry.badge": "{count}",
			"card.title": "CODE FACTORY",
			"card.stage": "{done}/{total} 阶段",
			"card.members": "{count} 成员",
			"card.dod": "DoD {passed}/{total}",
			"card.artifacts": "{count} 工件",
			"card.open": "打开驾驶舱",
			"card.updated": "更新于 {time}",
			"card.waiting": "工厂准备中…",
			"aria.roster": "团队编制",
			"aria.pipeline": "流程流水线",
			"aria.detail": "工厂详情",
			"aria.progress": "总进度 {percent}%",
			"aria.tabs": "工厂详情页签",
			"aria.role": "角色 {role}",
			"header.paused": "自动刷新已暂停",
			"header.pause": "暂停刷新",
			"header.resume": "恢复刷新",
			"header.updatedAgo": "最近更新 {ago}",
			"header.approved": "计划已批准",
			"header.securityHits": "命中词",
			"header.hitsExpand": "展开命中词",
			"header.hitsCollapse": "收起命中词",
			"header.securitySource.none": "来源未记录",
			"header.securitySource.brief": "来源 brief",
			"header.securitySource.document": "来源文档",
			"header.briefExpand": "展开 brief",
			"header.briefCollapse": "收起 brief",
			"header.deliveryPath": "交付路径",
			"header.messages": "消息",
			"header.alerts": "告警",
			"header.stages": "阶段",
			"ago.justNow": "刚刚",
			"ago.seconds": "{count}s 前",
			"ago.minutes": "{count}m 前",
			"ago.hours": "{count}h 前",
			"ago.days": "{count}d 前",
			"roster.search": "搜索标题 / 代号 / 角色 id",
			"roster.filter.all": "全部",
			"roster.sort.roster": "编制顺序",
			"roster.sort.status": "按状态",
			"roster.sortLabel": "排序",
			"roster.expand": "展开详情",
			"roster.collapse": "收起详情",
			"roster.filteredEmpty": "没有匹配的角色",
			"roster.details.session": "会话",
			"roster.details.provider": "Provider",
			"roster.details.model": "模型",
			"roster.details.effort": "推理强度",
			"roster.details.started": "开始",
			"roster.details.ended": "结束",
			"roster.details.duration": "用时",
			"roster.details.tokens": "tokens",
			"roster.details.stage": "当前阶段",
			"pipeline.failGoto": "打回至 {stage}",
			"pipeline.stageSelect": "查看阶段详情",
			"inspector.title": "阶段检查器 STAGE INSPECTOR",
			"inspector.close": "关闭检查器",
			"inspector.empty": "点击上方阶段芯片查看详情",
			"inspector.status": "状态",
			"inspector.rounds": "轮次 {round}/{max}",
			"inspector.attempts": "派发次数",
			"inspector.started": "开始",
			"inspector.ended": "结束",
			"inspector.duration": "用时",
			"inspector.gate": "门禁规则",
			"inspector.gateType": "类型",
			"inspector.gateArtifact": "检查工件",
			"inspector.gateSections": "必需章节",
			"inspector.gatePassWord": "通过关键词",
			"inspector.gateFailWord": "失败关键词",
			"inspector.gateRun": "运行命令",
			"inspector.gateChecks": "复合子项",
			"inspector.lastGate": "最近门禁",
			"inspector.lastGatePass": "通过",
			"inspector.lastGateFail": "未通过",
			"inspector.exitCode": "退出码",
			"inspector.at": "时间",
			"inspector.roles": "负责角色",
			"inspector.artifacts": "该阶段工件",
			"inspector.messages": "该阶段消息",
			"inspector.humanApproval": "人工审批",
			"inspector.parallel": "并行阶段",
			"inspector.failGoto": "打回至 {stage}",
			"inspector.noGate": "流水线模板已缺失，无法展示门禁规则",
			"inspector.noVerdict": "尚未记录门禁裁决",
			"inspector.stageOnlyOn": "只看该阶段工件/消息",
			"inspector.stageOnlyOff": "取消该阶段筛选",
			"inspector.stageFilter": "阶段筛选：{stage}",
			"inspector.unresolvedRole": "未在编制中",
			"work.search": "搜索消息内容 / 角色",
			"work.kind.all": "全部",
			"work.kind.other": "其他",
			"work.unreadOnly": "只看未读",
			"work.expand": "展开全文",
			"work.collapse": "收起",
			"work.filteredEmptyTitle": "筛选后无消息",
			"work.filteredEmptyBody": "调整类型、搜索词或阶段筛选",
			"work.delivered": "已送达",
			"work.unread": "未读",
			"work.read": "已读",
			"feed.search": "搜索动态内容 / 角色",
			"feed.filteredEmptyTitle": "筛选后无动态",
			"feed.filteredEmptyBody": "调整类型或搜索词",
			"artifacts.search": "搜索工件路径 / 阶段 / 产出角色",
			"artifacts.sort.newest": "最新",
			"artifacts.sort.oldest": "最早",
			"artifacts.sort.path": "路径",
			"artifacts.sort.size": "大小",
			"artifacts.sortLabel": "排序",
			"artifacts.showAll": "显示全部 {count}",
			"artifacts.showLess": "收起",
			"artifacts.expand": "展开详情",
			"artifacts.collapse": "收起详情",
			"artifacts.emptyFiltered": "没有匹配的工件",
			"artifacts.stageFilter": "阶段：{stage}",
			"artifacts.ago": "{ago}",
			"dod.filter.all": "全部",
			"dod.filter.failed": "失败",
			"dod.filter.pending": "待办",
			"dod.filter.passed": "通过",
			"dod.filter.skipped": "跳过",
			"dod.itemPending": "待定",
			"dod.expand": "展开定义",
			"dod.collapse": "收起定义",
			"dod.field.kind": "校验方式",
			"dod.field.artifact": "工件",
			"dod.field.expect": "期望",
			"dod.field.run": "命令",
			"dod.field.securityOnly": "仅安全路径",
			"dod.emptyFiltered": "没有匹配的 DoD 项",
			"dod.kind.file": "文件",
			"dod.kind.keyword": "关键词",
			"dod.kind.script": "脚本",
			"dod.kind.git": "Git",
			"dod.kind.crossref": "交叉校验",
			"evolution.filter.all": "全部",
			"evolution.filter.open": "未解决",
			"evolution.filter.resolved": "已解决",
			"evolution.roleAll": "全部角色",
			"evolution.roleFilter": "按角色筛选",
			"evolution.showAll": "显示全部 {count}",
			"evolution.showLess": "收起",
			"evolution.noMatch": "没有匹配的教训",
			"evolution.noMatchBody": "调整解决状态或角色筛选",
			"evolution.expand": "展开详情",
			"evolution.collapse": "收起详情",
			"evolution.factory": "工厂",
			"evolution.taskType": "任务类型",
			"evolution.firstSeen": "首次 {time}",
			"evolution.lastSeen": "最近 {time}",
			"evolution.gateMeta": "门禁 {gate}",
			"evolution.detail": "详情",
			"evolution.improvements.title": "插件改进建议",
			"evolution.improvements.count": "{count} 条",
			"evolution.improvements.filter.all": "全部",
			"evolution.improvements.filter.open": "待改进",
			"evolution.improvements.filter.validated": "已验证",
			"evolution.improvements.status.open": "待改进",
			"evolution.improvements.status.validated": "已验证",
			"evolution.improvements.target": "目标文件",
			"evolution.improvements.suggestion": "建议",
			"evolution.improvements.rationale": "理由",
			"evolution.improvements.lastAt": "最近 {ago}",
			"evolution.improvements.empty": "暂无反复出现的教训，暂时没有插件改进建议",
			"evolution.improvements.noMatch": "没有匹配的改进建议",
			"evolution.improvements.showAll": "显示全部 {count}",
			"evolution.improvements.showLess": "收起",
			"evolution.improvements.expand": "展开建议",
			"evolution.improvements.collapse": "收起建议",
			"evolution.improvements.copy": "复制改进建议",
			"aria.improvements": "插件改进建议",
			"copy.action": "复制",
			"copy.done": "已复制",
			"copy.aria": "复制 {label}",
			"copy.session": "复制会话 id",
			"copy.path": "复制路径",
			"copy.evidence": "复制证据",
			"copy.message": "复制消息内容",
			"copy.lesson": "复制教训文本",
			"filter.clear": "清除筛选",
			"section.expand": "展开",
			"section.collapse": "折叠",
			"layout.title": "布局",
			"layout.open": "打开布局菜单",
			"layout.board": "可停靠面板",
			"layout.column.left": "左栏",
			"layout.column.mid": "中栏",
			"layout.column.right": "右栏",
			"layout.hidden": "已隐藏模块",
			"layout.noHidden": "没有隐藏模块",
			"layout.show": "恢复",
			"layout.showModule": "恢复 {module}",
			"layout.hideModule": "隐藏 {module}",
			"layout.visible": "显示 {module}",
			"layout.fold": "折叠",
			"layout.unfold": "展开",
			"layout.foldModule": "折叠 {module}",
			"layout.unfoldModule": "展开 {module}",
			"layout.moveUp": "上移 {module}",
			"layout.moveDown": "下移 {module}",
			"layout.moveLeft": "左移 {module}",
			"layout.moveRight": "右移 {module}",
			"layout.expandAll": "全部展开",
			"layout.reset": "恢复默认布局",
			"layout.customHeight": "清除自定义高度",
			"layout.dragHint": "拖动标题栏移动模块",
			"layout.menu": "模块菜单",
			"layout.resizeLeft": "调整左栏宽度",
			"layout.resizeRight": "调整右栏宽度",
			"layout.resizeHint": "拖动调整宽度 · 双击复位 · 方向键微调",
			"layout.heightHint": "拖动调整高度 · 双击复位",
			"layout.emptyColumn": "把模块拖到这里",
			"layout.dropHint": "松开以停靠到该位置",
			"module.roster": "团队编制",
			"module.pipeline": "流水线",
			"module.inspector": "阶段检查器",
			"module.work": "工作产出",
			"module.feed": "实时动态",
			"module.artifacts": "工件",
			"module.dod": "DoD 验收",
			"module.evolution": "进化",
			"aria.layoutMenu": "布局菜单",
			"aria.autoRefresh": "自动刷新开关",
			"aria.hits": "安全触发命中词",
			"aria.inspector": "阶段检查器",
			"aria.rosterSearch": "搜索团队编制",
			"aria.feedSearch": "搜索实时动态",
			"aria.artifactSearch": "搜索工件",
			"aria.lessonRole": "按角色筛选教训",
			"aria.sectionToggle": "展开或折叠 {section}",
			"aria.stageChip": "查看阶段 {stage} 的检查器",
			"format.none": "—",
			"format.roleUnknown": "未知角色",
			"format.by": "由 {name} 提供",
			"format.yes": "是",
			"format.no": "否"
		};
		/** English dictionary, checked complete against the Chinese source key set. */
		const en = {
			"app.brand": "CODE FACTORY",
			"app.brandSub": "Multi-agent dev team command centre",
			"app.title": "Factory cockpit",
			"header.factory": "Factory",
			"header.factoryNone": "No factory",
			"header.pickFactory": "Select factory",
			"header.pickFactoryHint": "this session's factory (or pick from all workspaces)",
			"header.mission": "MISSION",
			"header.taskType": "Task type",
			"header.pipeline": "Pipeline",
			"header.security": "Security risk",
			"header.securityOn": "triggered",
			"header.tokens": "TOKENS",
			"header.artifacts": "Artifacts",
			"header.dod": "DoD",
			"header.elapsed": "Elapsed",
			"header.clock": "Clock",
			"header.progress": "Progress",
			"header.refresh": "Refresh now",
			"header.updatedAt": "Updated {time}",
			"header.phase.staged": "Staged",
			"header.phase.running": "Running",
			"header.phase.halted": "Halted",
			"header.phase.delivered": "Delivered",
			"header.phase.discarded": "Discarded",
			"header.link.idle": "Idle",
			"header.link.connecting": "Connecting",
			"header.link.live": "Live",
			"header.link.stale": "Host restarting",
			"header.link.error": "Unreachable",
			"header.scope.session": "this session",
			"header.scope.picked": "manual pick",
			"header.scope.index": "all workspaces (index)",
			"header.scope.hint": "What the panel is requesting: this session's factory (?sessionId=) / the factory you picked (?id=) / the cross-workspace index (the index only feeds the picker and is never shown as a snapshot)",
			"alert.badge": "⚠ {count}",
			"alert.badgeTitle": "Most urgent: {title} → {next}",
			"alert.aria": "Items needing a human",
			"alert.more": "{count} more",
			"roster.title": "TEAM ROSTER",
			"roster.active": "{active}/{total} active",
			"roster.empty": "No members on the roster yet",
			"roster.tokens": "tokens",
			"roster.stage": "Stage",
			"roster.stageNone": "no stage",
			"roster.model": "Model",
			"roster.legend.reasoner": "coding & review",
			"roster.legend.chat": "non-coding",
			"roster.tier.reasoner": "reasoner",
			"roster.tier.chat": "chat",
			"member.status.staged": "Staged",
			"member.status.idle": "Idle",
			"member.status.working": "Working",
			"member.status.rework": "Rework",
			"member.status.blocked": "Rejected",
			"member.status.done": "Done",
			"member.status.error": "Spawn failed",
			"member.status.removed": "Removed",
			"role.captain": "Captain",
			"work.title": "WORK OUTPUT · real output under workspace/",
			"work.duties": "Duties",
			"work.route": "Route",
			"work.session": "Session",
			"work.spawnError": "Spawn failed",
			"work.messages": "{count} messages",
			"work.none": "Pick a role from the roster on the left",
			"work.empty.title": "This agent has not been dispatched yet",
			"work.empty.body": "Waiting for the pipeline to reach the stage it owns",
			"work.streamEmpty": "No collaboration messages for this role yet",
			"work.round": "R{round}",
			"pipeline.title": "PIPELINE",
			"pipeline.subtitle": "gates enforced · stages cannot be skipped",
			"pipeline.empty": "No pipeline",
			"pipeline.roles": "{count} roles",
			"pipeline.legend.parallel": "parallel stage",
			"pipeline.legend.approval": "human approval gate",
			"pipeline.legend.rework": "rework loop (R = round)",
			"stage.status.pending": "Pending",
			"stage.status.active": "Active",
			"stage.status.gate": "At gate",
			"stage.status.passed": "Passed",
			"stage.status.rejected": "Rejected",
			"pipeline.gate.checklist": "checklist gate",
			"pipeline.gate.keyword": "keyword gate",
			"pipeline.gate.script": "script gate",
			"pipeline.gate.composite": "composite gate",
			"pipeline.gate.dod": "DoD gate",
			"pipeline.gate.unknown": "gate unknown",
			"pipeline.gate.unknownHint": "this stage's gate type could not be resolved: the pipeline template is gone and no gate verdict was recorded",
			"tabs.feed": "Live feed",
			"tabs.artifacts": "Artifacts {count}",
			"tabs.dod": "DoD",
			"section.feed": "Live feed",
			"section.feedNote": "{count} events",
			"section.artifacts": "Artifacts",
			"section.artifactsNote": "{count} files",
			"section.dod": "DoD checks",
			"section.dodNote": "{passed}/{total} passed",
			"section.evolution": "Evolution · cross-task lessons",
			"section.evolutionNote": "{count} lessons",
			"feed.empty.title": "Waiting for the first factory event",
			"feed.empty.body": "Once factory_plan stages a factory, collaboration events land here live",
			"feed.round": "R{round}",
			"feed.stage": "stage {stage}",
			"feed.endpoint.unparsed": "unparsed",
			"feed.endpoint.unparsedHint": "this record's sender/recipient could not be parsed — no such party exists in the factory record, so it is shown as-is",
			"feed.kind.system": "system",
			"feed.kind.dispatch": "dispatch",
			"feed.kind.reject": "reject",
			"feed.kind.handoff": "handoff",
			"feed.kind.report": "report",
			"feed.kind.blocked": "blocked",
			"feed.kind.approval": "approval",
			"artifacts.title": "ARTIFACTS · registry",
			"artifacts.empty": "No artifacts under workspace/ yet",
			"artifacts.by": "by {role}",
			"artifacts.stage": "stage {stage}",
			"dod.title": "DEFINITION OF DONE · machine-checked · nothing ships until all pass",
			"dod.empty": "No DoD checklist yet",
			"dod.passed": "Passed {passed}/{total}",
			"dod.itemOk": "pass",
			"dod.itemFail": "fail",
			"dod.itemSkip": "n/a",
			"dod.evidence": "Evidence",
			"evolution.stat.total": "Total {count}",
			"evolution.stat.recurring": "Recurring {count}",
			"evolution.stat.resolved": "Resolved {count}",
			"evolution.count": "×{count}",
			"evolution.countHint": "Seen {count} times",
			"evolution.resolved": "resolved",
			"evolution.empty": "No lessons recorded yet",
			"evolution.emptyBody": "Gate rejections and failed DoD checks become cross-task lessons, injected into later dispatches automatically",
			"evolution.emptyFiltered": "No lessons match this factory yet ({total} in the workspace)",
			"evolution.emptyFilteredBody": "The workspace has lessons, but none apply to this factory's roles or stages yet; later tasks still carry them",
			"evolution.more": "{count} more",
			"empty.title": "No factory yet",
			"empty.body": "Ask the captain to call factory_plan in chat and the staged plan shows up here",
			"empty.waiting": "Waiting for the host snapshot…",
			"empty.error": "Cannot read factory state: {message}",
			"empty.stale": "Host is restarting — showing the last snapshot",
			"empty.retry": "Retry",
			"state.summary.title": "Reading the full snapshot…",
			"state.summary.body": "The host returned the factory index summary (id / name / task type / phase / updatedAt only); members, pipeline, artifacts and DoD appear after the next poll",
			"entry.label": "Code Factory cockpit",
			"entry.aria": "Open the Code Factory cockpit",
			"entry.badge": "{count}",
			"card.title": "CODE FACTORY",
			"card.stage": "{done}/{total} stages",
			"card.members": "{count} members",
			"card.dod": "DoD {passed}/{total}",
			"card.artifacts": "{count} artifacts",
			"card.open": "Open cockpit",
			"card.updated": "Updated {time}",
			"card.waiting": "Factory warming up…",
			"aria.roster": "Team roster",
			"aria.pipeline": "Pipeline",
			"aria.detail": "Factory details",
			"aria.progress": "Overall progress {percent}%",
			"aria.tabs": "Factory detail tabs",
			"aria.role": "Role {role}",
			"header.paused": "Auto-refresh paused",
			"header.pause": "Pause refresh",
			"header.resume": "Resume refresh",
			"header.updatedAgo": "Updated {ago}",
			"header.approved": "Plan approved",
			"header.securityHits": "security hits",
			"header.hitsExpand": "Show security hits",
			"header.hitsCollapse": "Hide security hits",
			"header.securitySource.none": "source not recorded",
			"header.securitySource.brief": "source brief",
			"header.securitySource.document": "source document",
			"header.briefExpand": "Expand brief",
			"header.briefCollapse": "Collapse brief",
			"header.deliveryPath": "Delivery path",
			"header.messages": "Messages",
			"header.alerts": "Alerts",
			"header.stages": "Stages",
			"ago.justNow": "just now",
			"ago.seconds": "{count}s ago",
			"ago.minutes": "{count}m ago",
			"ago.hours": "{count}h ago",
			"ago.days": "{count}d ago",
			"roster.search": "Search title / codename / role id",
			"roster.filter.all": "All",
			"roster.sort.roster": "Roster order",
			"roster.sort.status": "By status",
			"roster.sortLabel": "Sort",
			"roster.expand": "Expand details",
			"roster.collapse": "Collapse details",
			"roster.filteredEmpty": "No matching members",
			"roster.details.session": "Session",
			"roster.details.provider": "Provider",
			"roster.details.model": "Model",
			"roster.details.effort": "Reasoning effort",
			"roster.details.started": "Started",
			"roster.details.ended": "Ended",
			"roster.details.duration": "Duration",
			"roster.details.tokens": "tokens",
			"roster.details.stage": "Current stage",
			"pipeline.failGoto": "rework goes to {stage}",
			"pipeline.stageSelect": "Inspect stage",
			"inspector.title": "STAGE INSPECTOR",
			"inspector.close": "Close inspector",
			"inspector.empty": "Pick a stage chip above to inspect it",
			"inspector.status": "Status",
			"inspector.rounds": "Round {round}/{max}",
			"inspector.attempts": "Dispatches",
			"inspector.started": "Started",
			"inspector.ended": "Ended",
			"inspector.duration": "Duration",
			"inspector.gate": "Gate rule",
			"inspector.gateType": "Type",
			"inspector.gateArtifact": "Artifact",
			"inspector.gateSections": "Required sections",
			"inspector.gatePassWord": "Pass keyword",
			"inspector.gateFailWord": "Fail keyword",
			"inspector.gateRun": "Command",
			"inspector.gateChecks": "Composite checks",
			"inspector.lastGate": "Last gate",
			"inspector.lastGatePass": "passed",
			"inspector.lastGateFail": "failed",
			"inspector.exitCode": "Exit code",
			"inspector.at": "At",
			"inspector.roles": "Roles",
			"inspector.artifacts": "Artifacts in stage",
			"inspector.messages": "Messages in stage",
			"inspector.humanApproval": "Human approval",
			"inspector.parallel": "Parallel",
			"inspector.failGoto": "Rework goes to {stage}",
			"inspector.noGate": "the pipeline template is gone, so the gate rule cannot be shown",
			"inspector.noVerdict": "no gate verdict recorded yet",
			"inspector.stageOnlyOn": "Only this stage’s artifacts/messages",
			"inspector.stageOnlyOff": "Clear the stage filter",
			"inspector.stageFilter": "Stage filter: {stage}",
			"inspector.unresolvedRole": "not on the roster",
			"work.search": "Search message text / parties",
			"work.kind.all": "All",
			"work.kind.other": "Other",
			"work.unreadOnly": "Unread only",
			"work.expand": "Expand full text",
			"work.collapse": "Collapse",
			"work.filteredEmptyTitle": "No messages match the filter",
			"work.filteredEmptyBody": "Adjust the kind, search text, or stage filter",
			"work.delivered": "delivered",
			"work.unread": "unread",
			"work.read": "read",
			"feed.search": "Search feed text / parties",
			"feed.filteredEmptyTitle": "No feed events match",
			"feed.filteredEmptyBody": "Adjust the kind or search text",
			"artifacts.search": "Search artifact path / stage / owner",
			"artifacts.sort.newest": "Newest",
			"artifacts.sort.oldest": "Oldest",
			"artifacts.sort.path": "Path",
			"artifacts.sort.size": "Size",
			"artifacts.sortLabel": "Sort",
			"artifacts.showAll": "Show all {count}",
			"artifacts.showLess": "Show less",
			"artifacts.expand": "Expand details",
			"artifacts.collapse": "Collapse details",
			"artifacts.emptyFiltered": "No matching artifacts",
			"artifacts.stageFilter": "Stage: {stage}",
			"artifacts.ago": "{ago}",
			"dod.filter.all": "All",
			"dod.filter.failed": "Failed",
			"dod.filter.pending": "Pending",
			"dod.filter.passed": "Passed",
			"dod.filter.skipped": "Skipped",
			"dod.itemPending": "pending",
			"dod.expand": "Expand definition",
			"dod.collapse": "Collapse definition",
			"dod.field.kind": "Check",
			"dod.field.artifact": "Artifact",
			"dod.field.expect": "Expect",
			"dod.field.run": "Command",
			"dod.field.securityOnly": "Security path only",
			"dod.emptyFiltered": "No matching DoD items",
			"dod.kind.file": "file",
			"dod.kind.keyword": "keyword",
			"dod.kind.script": "script",
			"dod.kind.git": "git",
			"dod.kind.crossref": "crossref",
			"evolution.filter.all": "All",
			"evolution.filter.open": "Open",
			"evolution.filter.resolved": "Resolved",
			"evolution.roleAll": "All roles",
			"evolution.roleFilter": "Filter by role",
			"evolution.showAll": "Show all {count}",
			"evolution.showLess": "Show less",
			"evolution.noMatch": "No lessons match the filter",
			"evolution.noMatchBody": "Adjust the resolution or role filter",
			"evolution.expand": "Expand details",
			"evolution.collapse": "Collapse details",
			"evolution.factory": "Factory",
			"evolution.taskType": "Task type",
			"evolution.firstSeen": "first {time}",
			"evolution.lastSeen": "last {time}",
			"evolution.gateMeta": "gate {gate}",
			"evolution.detail": "Detail",
			"evolution.improvements.title": "Plugin improvements",
			"evolution.improvements.count": "{count} proposals",
			"evolution.improvements.filter.all": "All",
			"evolution.improvements.filter.open": "Open",
			"evolution.improvements.filter.validated": "Validated",
			"evolution.improvements.status.open": "Open",
			"evolution.improvements.status.validated": "Validated",
			"evolution.improvements.target": "Target file",
			"evolution.improvements.suggestion": "Suggestion",
			"evolution.improvements.rationale": "Rationale",
			"evolution.improvements.lastAt": "last {ago}",
			"evolution.improvements.empty": "No recurring lessons yet — no plugin-improvement proposals",
			"evolution.improvements.noMatch": "No proposals match the filter",
			"evolution.improvements.showAll": "Show all {count}",
			"evolution.improvements.showLess": "Show less",
			"evolution.improvements.expand": "Expand suggestion",
			"evolution.improvements.collapse": "Collapse suggestion",
			"evolution.improvements.copy": "Copy proposal",
			"aria.improvements": "Plugin improvements",
			"copy.action": "Copy",
			"copy.done": "Copied",
			"copy.aria": "Copy {label}",
			"copy.session": "Copy session id",
			"copy.path": "Copy path",
			"copy.evidence": "Copy evidence",
			"copy.message": "Copy message text",
			"copy.lesson": "Copy lesson text",
			"filter.clear": "Clear filter",
			"section.expand": "Expand",
			"section.collapse": "Collapse",
			"layout.title": "Layout",
			"layout.open": "Open layout menu",
			"layout.board": "Dockable board",
			"layout.column.left": "Left column",
			"layout.column.mid": "Middle column",
			"layout.column.right": "Right column",
			"layout.hidden": "Hidden modules",
			"layout.noHidden": "No hidden modules",
			"layout.show": "Show",
			"layout.showModule": "Show {module}",
			"layout.hideModule": "Hide {module}",
			"layout.visible": "Show {module}",
			"layout.fold": "Collapse",
			"layout.unfold": "Expand",
			"layout.foldModule": "Collapse {module}",
			"layout.unfoldModule": "Expand {module}",
			"layout.moveUp": "Move {module} up",
			"layout.moveDown": "Move {module} down",
			"layout.moveLeft": "Move {module} left",
			"layout.moveRight": "Move {module} right",
			"layout.expandAll": "Expand all",
			"layout.reset": "Reset layout",
			"layout.customHeight": "Clear custom height",
			"layout.dragHint": "Drag the title bar to move this module",
			"layout.menu": "Module menu",
			"layout.resizeLeft": "Resize left column",
			"layout.resizeRight": "Resize right column",
			"layout.resizeHint": "Drag to resize · double-click to reset · arrow keys to nudge",
			"layout.heightHint": "Drag to resize · double-click to reset",
			"layout.emptyColumn": "Drop modules here",
			"layout.dropHint": "Release to dock here",
			"module.roster": "Roster",
			"module.pipeline": "Pipeline",
			"module.inspector": "Stage inspector",
			"module.work": "Work output",
			"module.feed": "Live feed",
			"module.artifacts": "Artifacts",
			"module.dod": "DoD checks",
			"module.evolution": "Evolution",
			"aria.layoutMenu": "Layout menu",
			"aria.autoRefresh": "Auto-refresh switch",
			"aria.hits": "Security trigger words",
			"aria.inspector": "Stage inspector",
			"aria.rosterSearch": "Search the team roster",
			"aria.feedSearch": "Search the live feed",
			"aria.artifactSearch": "Search artifacts",
			"aria.lessonRole": "Filter lessons by role",
			"aria.sectionToggle": "Expand or collapse {section}",
			"aria.stageChip": "Open the inspector for stage {stage}",
			"format.none": "—",
			"format.roleUnknown": "unknown role",
			"format.by": "by {name}",
			"format.yes": "yes",
			"format.no": "no"
		};
		//#endregion
		//#region lib/client/client/index.js
		/**
		* Browser half of the Code Factory plugin.
		*
		* The DSH Web shell does not import this entry as an ES module. `lib/client.js`
		* is loaded as a classic script that registers one CJS closure factory on
		* `window.__ModuleLoader__` (docs/API-CONTRACTS.md §2.2); the factory must
		* export `apply` and `inject`, and its `require()` resolves only the packages
		* the shell already provides (`react`, `react-dom`, `@deepseek-ai/*`).
		*
		* Layout contributions (docs/API-CONTRACTS.md §2.4):
		*
		*   `main`                        keyed/root   — the full-width cockpit panel
		*   `sidebar.panellist`           list/root    — the entry icon that opens it
		*   `conversation.chat.turnTail`  list/session — the per-turn factory summary
		*
		* Windows must never hijack another key: `main`'s reserved `conversation` key is
		* untouched, and every list entry uses a fresh `id`.
		*
		* ---------------------------------------------------------------------------
		* Type environment: declaration-only imports
		*
		* `Context.slots` is declared by `@deepseek-ai/dsh-client-ui-renderer`, and the
		* `sidebar.panellist` `SlotMap` entry by `@deepseek-ai/dsh-client-ui-sidebar`.
		* The shell provides both at runtime, so they stay `devDependencies`; they are
		* imported below purely for their declaration merging, and every one of these
		* `import type` statements is erased at build time (the bundle still `require`s
		* only `react` and `react/jsx-runtime`).
		*
		* With those declarations in the program, each `register()` call in this file is
		* checked against the real `SlotCore.register` overloads. That is what enforces
		* the kind/field split instead of leaving it to a comment: a keyed slot accepts
		* `key` + `priority`, a list slot accepts `id` + `order`, and a field the slot's
		* kind does not know is now a compile error rather than a silently ignored one.
		* ---------------------------------------------------------------------------
		*
		* @module dsh-code-factory/client
		*/
		/**
		* Required services, as bare cordis service keys.
		*
		* `slots` is the renderer-provided composition registry this plugin contributes
		* to, `locale` backs the `codeFactory` dictionaries and the `t` seat, and
		* `layout` is what lets the entry points bring the panel to the front. The
		* shell provides all three; the type-only imports above are what make their
		* declarations visible to this program.
		*/
		const inject = [
			"slots",
			"locale",
			"layout"
		];
		/** `main`-slot key of the cockpit panel; shared with the sidebar entry id. */
		const CODE_FACTORY_MAIN_KEY = "code-factory";
		/**
		* The single rank this plugin registers at, expressed in each slot's own
		* vocabulary: `priority` for the keyed `main` slot (cell shadow rank) and
		* `order` for the two list entries (ascending row order). One number, because
		* the cockpit and its entry points belong to the same visual rank.
		*/
		const CODE_FACTORY_PANEL_RANK = 60;
		/** Stable id of the turn-tail contribution. */
		const CODE_FACTORY_TURN_CARD_ID = "code-factory-summary";
		/** Element id of the injected stylesheet, so HMR reloads reuse one node. */
		const CODE_FACTORY_STYLE_ID = "dsh-code-factory-styles";
		/**
		* Publish the cockpit stylesheet into `document.head`.
		*
		* A single owned node keeps the three contributions deduplicated and lets the
		* plugin disposer take the styles back out. HMR replaces the contents in place
		* so a reload does not flash the panel unstyled.
		*
		* @returns disposer removing the node this call created.
		*/
		function installStylesheet() {
			if (typeof document === "undefined") return () => void 0;
			const existing = document.getElementById(CODE_FACTORY_STYLE_ID);
			const created = existing === null;
			const style = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
			if (created || !(existing instanceof HTMLStyleElement)) {
				style.id = CODE_FACTORY_STYLE_ID;
				style.setAttribute("data-plugin", "dsh-code-factory");
				document.head.appendChild(style);
			}
			style.textContent = FACTORY_CSS;
			return () => {
				if (created) style.remove();
			};
		}
		/**
		* Apply the layout's compile-time panel brand to a `main` key.
		*
		* `ILayout.selectPanel` takes a `MainPanelId`, i.e. `Branded<'MainPanelId'>`
		* (`string & { readonly [BRAND]: … }`), so a plain `string` cannot be passed.
		* The value really is the registered `main` key — {@link CODE_FACTORY_MAIN_KEY}
		* is what the panel is registered under — and `brandString` is the framework's
		* own brander for exactly this bridge.
		*
		* `@deepseek-ai/dsh-brand` is intentionally bundled rather than required: it
		* declares no `dsh.client` manifest, so the shell never registers it with
		* `window.__ModuleLoader__` (see the computed external list in
		* `tsdown.config.ts`). Requiring it would throw in the browser and abort
		* activation of the whole plugin.
		*
		* @param key - a registered `main` key.
		* @returns the same string as a `MainPanelId`.
		*/
		function mainPanelId(key) {
			return brandString(key);
		}
		/**
		* Bring this plugin's central panel to the front.
		*
		* `selectPanel` throws when the key is not registered (for example while this
		* plugin is being torn down), so the click handler contains it.
		*
		* @param layout - the panel-navigation face published by `ctx.layout`.
		*/
		function openCockpitPanel(layout) {
			try {
				layout?.selectPanel(mainPanelId(CODE_FACTORY_MAIN_KEY));
			} catch (error) {
				console.warn("code-factory: cannot select the cockpit panel", error);
			}
		}
		/**
		* Client plugin body: register the typed dictionaries, publish the stylesheet,
		* and mount the cockpit plus its two entry points.
		*
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(CODE_FACTORY_LOCALE_NAMESPACE);
			ctx.effect(() => ctx.locale.register(CODE_FACTORY_LOCALE_NAMESPACE, {
				zh,
				en
			}), "code-factory: dictionaries");
			ctx.effect(() => installStylesheet(), "code-factory: stylesheet");
			const injected = () => ({
				route: CODE_FACTORY_STATE_ROUTE,
				pollMs: FACTORY_POLL_MS,
				openCockpit: () => openCockpitPanel(ctx.layout)
			});
			ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: CODE_FACTORY_MAIN_KEY,
				priority: 60,
				locale: CODE_FACTORY_LOCALE_NAMESPACE,
				inject: injected
			}, FactoryCockpit)), "code-factory: cockpit panel");
			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: CODE_FACTORY_MAIN_KEY,
				order: 60,
				label: () => t("entry.label"),
				locale: CODE_FACTORY_LOCALE_NAMESPACE,
				inject: injected
			}, FactorySidebarEntry)), "code-factory: sidebar entry");
			ctx.effect(() => ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: CODE_FACTORY_TURN_CARD_ID,
				order: 50,
				locale: CODE_FACTORY_LOCALE_NAMESPACE,
				inject: injected
			}, FactoryTurnCard)), "code-factory: turn summary");
		}
		//#endregion
		exports.ArtifactsContent = ArtifactsContent;
		exports.ArtifactsSection = ArtifactsSection;
		exports.CODE_FACTORY_LOCALE_NAMESPACE = CODE_FACTORY_LOCALE_NAMESPACE;
		exports.CODE_FACTORY_MAIN_KEY = CODE_FACTORY_MAIN_KEY;
		exports.CODE_FACTORY_PANEL_RANK = CODE_FACTORY_PANEL_RANK;
		exports.CODE_FACTORY_STATE_ROUTE = CODE_FACTORY_STATE_ROUTE;
		exports.CODE_FACTORY_STYLE_ID = CODE_FACTORY_STYLE_ID;
		exports.CODE_FACTORY_TURN_CARD_ID = CODE_FACTORY_TURN_CARD_ID;
		exports.CopyButton = CopyButton;
		exports.DEFAULT_COLUMN_WIDTHS = DEFAULT_COLUMN_WIDTHS;
		exports.DEFAULT_MODULE_COLUMN = DEFAULT_MODULE_COLUMN;
		exports.DockModule = DockModule;
		exports.DodContent = DodContent;
		exports.DodSection = DodSection;
		exports.EvolutionContent = EvolutionContent;
		exports.EvolutionSection = EvolutionSection;
		exports.FACTORY_CSS = FACTORY_CSS;
		exports.FACTORY_ID_PARAM = FACTORY_ID_PARAM;
		exports.FACTORY_POLL_MS = FACTORY_POLL_MS;
		exports.FALLBACK_ROLE_COLORS = FALLBACK_ROLE_COLORS;
		exports.FEED_KIND_COLOR = FEED_KIND_COLOR;
		exports.FactoryCockpit = FactoryCockpit;
		exports.FactoryCockpitBody = FactoryCockpitBody;
		exports.FactoryCockpitHeader = FactoryCockpitHeader;
		exports.FactorySidebarEntry = FactorySidebarEntry;
		exports.FactoryTurnCard = FactoryTurnCard;
		exports.FeedContent = FeedContent;
		exports.FeedSection = FeedSection;
		exports.FilterChip = FilterChip;
		exports.IMPROVEMENT_FILTERS = IMPROVEMENT_FILTERS;
		exports.IMPROVEMENT_LIMIT = IMPROVEMENT_LIMIT;
		exports.IMPROVEMENT_MIN_EVIDENCE = IMPROVEMENT_MIN_EVIDENCE;
		exports.IMPROVEMENT_PREVIEW_LIMIT = IMPROVEMENT_PREVIEW_LIMIT;
		exports.ImprovementsPanel = ImprovementsPanel;
		exports.LAYOUT_STORAGE_KEY = LAYOUT_STORAGE_KEY;
		exports.LINK_COLOR = LINK_COLOR;
		exports.LayoutMenu = LayoutMenu;
		exports.MAX_COLUMN_WIDTH = MAX_COLUMN_WIDTH;
		exports.MAX_MODULE_HEIGHT = MAX_MODULE_HEIGHT;
		exports.MEMBER_STATUS_COLOR = MEMBER_STATUS_COLOR;
		exports.MIN_COLUMN_WIDTH = MIN_COLUMN_WIDTH;
		exports.MIN_MODULE_HEIGHT = MIN_MODULE_HEIGHT;
		exports.MessageRow = MessageRow;
		exports.PANEL_COLUMN_IDS = PANEL_COLUMN_IDS;
		exports.PANEL_MODULE_IDS = PANEL_MODULE_IDS;
		exports.PANEL_MODULE_MIME = PANEL_MODULE_MIME;
		exports.PHASE_COLOR = PHASE_COLOR;
		exports.PanelBoard = PanelBoard;
		exports.RoleAvatar = RoleAvatar;
		exports.RosterContent = RosterContent;
		exports.RosterPanel = RosterPanel;
		exports.SESSION_ID_PARAM = SESSION_ID_PARAM;
		exports.STAGE_STATUS_COLOR = STAGE_STATUS_COLOR;
		exports.StageInspectorPanel = StageInspectorPanel;
		exports.TOKEN = TOKEN;
		exports.apply = apply;
		exports.buildStageInspector = buildStageInspector;
		exports.clearModuleHeight = clearModuleHeight;
		exports.cockpitPollTarget = cockpitPollTarget;
		exports.createDefaultLayout = createDefaultLayout;
		exports.currentSessionId = currentSessionId;
		exports.deriveImprovements = deriveImprovements;
		exports.en = en;
		exports.factoryStateUrl = factoryStateUrl;
		exports.filterArtifacts = filterArtifacts;
		exports.filterDod = filterDod;
		exports.filterFeedMessages = filterFeedMessages;
		exports.filterImprovements = filterImprovements;
		exports.filterLessons = filterLessons;
		exports.filterMembers = filterMembers;
		exports.hideModule = hideModule;
		exports.improvementProposals = improvementProposals;
		exports.improvementStats = improvementStats;
		exports.inject = inject;
		exports.isFullSnapshot = isFullSnapshot;
		exports.isModuleVisible = isModuleVisible;
		exports.isPanelColumnId = isPanelColumnId;
		exports.isPanelModuleId = isPanelModuleId;
		exports.modulePlacement = modulePlacement;
		exports.moveModule = moveModule;
		exports.namesFactory = namesFactory;
		exports.normaliseLayout = normaliseLayout;
		exports.normalizeEvolution = normalizeEvolution;
		exports.normalizeFactories = normalizeFactories;
		exports.normalizeImprovement = normalizeImprovement;
		exports.normalizePayload = normalizePayload;
		exports.normalizeSnapshot = normalizeSnapshot;
		exports.planModuleDrop = planModuleDrop;
		exports.readLayout = readLayout;
		exports.resetLayout = resetLayout;
		exports.resolveLessonRole = resolveLessonRole;
		exports.roleInk = roleInk;
		exports.roleSwatch = roleSwatch;
		exports.serializeLayout = serializeLayout;
		exports.setColumnWidth = setColumnWidth;
		exports.setModuleCollapsed = setModuleCollapsed;
		exports.setModuleHeight = setModuleHeight;
		exports.showModule = showModule;
		exports.sortArtifacts = sortArtifacts;
		exports.toggleModuleCollapsed = toggleModuleCollapsed;
		exports.useFactoryState = useFactoryState;
		exports.useNow = useNow;
		exports.visibleModuleIds = visibleModuleIds;
		exports.wash = wash;
		exports.writeLayout = writeLayout;
		exports.zh = zh;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map