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
import type { RoleDef } from '../shared/types.js';
/** Title of the injected handbook block (also asserted by the offline check). */
export declare const DESIGN_PLAYBOOK_TITLE = "\u3010\u8BBE\u8BA1\u8D1F\u8D23\u4EBA\u624B\u518C\uFF08UI/UX Playbook\uFF09\u3011";
/** The one role the handbook applies to. */
export declare const DESIGN_PLAYBOOK_ROLE_ID = "ui_designer";
/**
 * The handbook body, as prompt-ready Markdown.
 *
 * Deterministic text only. It is injected verbatim by {@link renderDesignPlaybook}
 * and quoted by `ui_designer`'s iron rules, so wording changes here should be
 * mirrored in `roles.ts` (and vice versa).
 */
export declare const DESIGN_PLAYBOOK: string;
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
export declare function renderDesignPlaybook(role: RoleDef): string[];
