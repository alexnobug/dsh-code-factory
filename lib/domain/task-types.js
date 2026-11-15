/**
 * task-types.ts — the five routable task families.
 *
 * Port of the prototype's 任务类型 → 编制映射 (Kimi 骨架 `TASK_TYPES`, extended
 * to the five families this project promises): `web_fullstack`, `api_only`,
 * `data_pipeline`, `script_tool`, `ml_model`.
 *
 * `team` is the **default** roster in suggested join order. It is a starting
 * point, not a promise: `router.assembleTeam` adds the mandatory iron triangle
 * and the security specialist, then enforces the roster cap.
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects.
 *
 * @module dsh-code-factory/domain/task-types
 */
/** The five families, most expensive pipeline first (the last entry is the fallback). */
export const TASK_TYPES = [
    {
        id: 'web_fullstack',
        label: 'Web 全栈应用',
        keywords: [
            '网站',
            '网页',
            'web',
            '前端',
            '页面',
            '小程序',
            '后台管理',
            '管理后台',
            '全栈',
            'fullstack',
            '电商',
            '商城',
            'dashboard',
            '控制台',
            // 前端平台细分：Flutter / 小程序系 brief 也要落到 web_fullstack 家族，
            // 再由 router.frontendPlatformFor 选出对应 specialist。
            'flutter',
            'dart',
            '微信小程序',
            'uni-app',
            'uniapp',
            'taro',
            'weapp',
            'mp-weixin',
            '支付宝小程序',
            '快应用',
            '抖音小程序',
        ],
        team: ['pm', 'ui_designer', 'sys_arch', 'db_arch', 'api_designer', 'security_eng', 'fe_dev', 'be_dev', 'reviewer', 'qa', 'devops'],
        pipeline: 'fullstack',
    },
    {
        id: 'api_only',
        label: '后端 API 服务',
        keywords: ['api', '接口', '后端服务', '微服务', 'restful', '服务端', '后端', 'endpoint', 'sdk'],
        team: ['pm', 'sys_arch', 'api_designer', 'db_arch', 'security_eng', 'be_dev', 'reviewer', 'qa', 'devops'],
        pipeline: 'api',
    },
    {
        id: 'data_pipeline',
        label: '数据管道',
        keywords: [
            '爬虫',
            'etl',
            '数据清洗',
            '数据采集',
            '数据处理',
            '数据管道',
            '数据同步',
            '数据仓库',
            '报表',
            '数据源',
            '批量导入',
        ],
        team: ['pm', 'sys_arch', 'db_arch', 'be_dev', 'reviewer', 'qa', 'devops'],
        pipeline: 'data',
    },
    {
        id: 'ml_model',
        label: '机器学习模型',
        keywords: [
            '模型',
            '训练',
            '机器学习',
            '深度学习',
            '神经网络',
            '推荐算法',
            '预测',
            '微调',
            'llm',
            '推理服务',
            'embedding',
            'rag',
            '特征工程',
        ],
        team: ['pm', 'sys_arch', 'be_dev', 'reviewer', 'qa', 'devops'],
        pipeline: 'ml',
    },
    {
        id: 'script_tool',
        label: '脚本 / 工具',
        keywords: ['脚本', '小工具', '工具', '自动化', 'cli', '命令行', '批处理', '定时任务', 'rename', '转换器'],
        team: ['pm', 'be_dev', 'reviewer', 'qa', 'devops'],
        pipeline: 'lightweight',
    },
];
/**
 * Fallback family when no keyword matches: the cheapest pipeline. The router
 * guarantees this id is the **last** entry of {@link TASK_TYPES}, so "no match"
 * and "weakest match" resolve the same way.
 */
export const DEFAULT_TASK_TYPE_ID = 'script_tool';
/** All family ids, in registry order. */
export const TASK_TYPE_IDS = TASK_TYPES.map((def) => def.id);
/** Every family id the project promises to route (schema for the self-check). */
export const REQUIRED_TASK_TYPE_IDS = [
    'web_fullstack',
    'api_only',
    'data_pipeline',
    'script_tool',
    'ml_model',
];
/** One family by id. */
export function getTaskType(id) {
    const key = id.trim().toLowerCase();
    return TASK_TYPES.find((def) => def.id === key);
}
/**
 * How many members one family's roster needs: its declared `team` plus the
 * corners the router guarantees (two of which every roster already lists, so
 * this is `team.length` today — the computation keeps it honest if a roster ever
 * forgets one). This is the number a roster cap must never fall below, which is
 * why {@link import('./router.js').DEFAULT_MAX_MEMBERS} is derived from it.
 */
export function requiredTeamSize(task) {
    if (task === undefined)
        return 0;
    return new Set([...task.team, 'pm', 'qa']).size;
}
/** The widest family roster — the smallest cap that trims nothing, ever. */
export function widestTeamSize() {
    return TASK_TYPES.reduce((widest, def) => Math.max(widest, requiredTeamSize(def)), 0);
}
/**
 * The fallback family. `DEFAULT_TASK_TYPE_ID` is ordinarily registered; if a
 * registry edit ever unregisters it, the last entry stands in, because planning
 * must still produce a pipeline. An empty registry is not a fallback case — it
 * is a broken build, so it says so instead of returning `undefined` under a
 * non-optional return type.
 */
export function defaultTaskType() {
    const registered = getTaskType(DEFAULT_TASK_TYPE_ID);
    if (registered !== undefined)
        return registered;
    const last = TASK_TYPES[TASK_TYPES.length - 1];
    if (last === undefined) {
        throw new Error('code-factory: 任务类型注册表是空的 —— 没有可用的流水线，请修 TASK_TYPES 注册表。');
    }
    return last;
}
//# sourceMappingURL=task-types.js.map