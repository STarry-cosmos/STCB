/**
 * 正面提示词节点的定位逻辑
 *
 * 单独抽出来是为了能脱离 ComfyUI 环境直接跑测试（见 test_locate.mjs）。
 *
 * 回退链：
 *   ① 节点标题被标为 @prompt / 正面提示词   —— 用户显式指定
 *   ② 从「带 positive 输入的节点」反向追溯   —— 自动，覆盖绝大多数工作流
 *   ③ 第一个 CLIPTextEncode                —— 兜底
 */

/** 标题标记匹配词（比较时忽略大小写与开头的 @） */
export const PROMPT_TITLES = ["prompt", "positive", "正面提示词", "正面"];

/** 什么样的节点值得注入：有字符串类型的 text 输入 */
export function isTextNode(node) {
    return Boolean(node) && typeof node?.inputs?.text === "string";
}

/** 「酒馆提示词」节点的 class_type */
export const PROMPT_NODE_TYPE = "STCBPrompt";

/**
 * 在 API 格式里找出「酒馆提示词」节点。
 *
 * 这是主路径：位置由用户在图上连出来，程序不需要猜。
 * 比反向追溯确定得多，也不会丢质量词和画师串。
 *
 * @param {Record<string, {class_type?: string}>} output
 * @param {string} [classType]
 * @returns {string[]} 节点 ID 数组，按出现顺序
 */
export function findPromptNodesByClass(output, classType = PROMPT_NODE_TYPE) {
    if (!output || typeof output !== "object") return [];
    const ids = [];
    for (const [id, node] of Object.entries(output)) {
        if (node?.class_type === classType) ids.push(id);
    }
    return ids;
}

/**
 * 从 nodeId 出发向上游递归，收集所有带 text 输入的节点。
 *
 * API 格式里连线是 [源节点ID, 输出槽位]，所以顺着 inputs 里的数组往下找即可。
 * 中间隔着 ConditioningCombine / ConditioningSetArea / ControlNetApply 之类的
 * 节点时会继续往上游走。
 */
export function collectTextNodesUpstream(output, nodeId, acc, seen) {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);

    const node = output[nodeId];
    if (!node) return;

    if (isTextNode(node)) {
        acc.add(nodeId);
        return; // 已经到提示词节点了，不必再往上
    }

    for (const value of Object.values(node.inputs ?? {})) {
        if (Array.isArray(value) && value.length >= 1 && typeof value[0] === "string") {
            collectTextNodesUpstream(output, value[0], acc, seen);
        }
    }
}

/**
 * 在 API 格式的工作流里找出正面提示词节点。
 *
 * @param {Record<string, {class_type?: string, inputs?: Record<string, unknown>, _meta?: {title?: string}}>} output
 * @returns {{ ids: string[], via: 'title' | 'trace' | 'fallback' | null }}
 */
export function findPositiveTextNodeIds(output) {
    if (!output || typeof output !== "object") {
        return { ids: [], via: null };
    }

    // ① 标题标记
    const marked = [];
    for (const [id, node] of Object.entries(output)) {
        const title = String(node?._meta?.title ?? "")
            .trim()
            .replace(/^@/, "")
            .toLowerCase();
        if (title && PROMPT_TITLES.includes(title) && isTextNode(node)) {
            marked.push(id);
        }
    }
    if (marked.length > 0) {
        return { ids: marked, via: "title" };
    }

    // ② 反向追溯
    const traced = new Set();
    for (const [, node] of Object.entries(output)) {
        const positive = node?.inputs?.positive;
        if (Array.isArray(positive) && positive.length >= 1 && typeof positive[0] === "string") {
            collectTextNodesUpstream(output, positive[0], traced, new Set());
        }
    }
    if (traced.size > 0) {
        return { ids: [...traced], via: "trace" };
    }

    // ③ 兜底
    for (const [id, node] of Object.entries(output)) {
        if (node?.class_type === "CLIPTextEncode" && isTextNode(node)) {
            return { ids: [id], via: "fallback" };
        }
    }

    return { ids: [], via: null };
}

/**
 * 算出某个 widget 在 `widgets_values` 数组里的下标。
 *
 * 用途：把注入的提示词同步进图片元数据时，需要按位置改 UI 格式的 widgets_values。
 *
 * 关键坑：`widgets_values` 是**位置数组**，而序列化时会跳过
 * `serialize === false` 的 widget（见 ComfyUI 前端的 serialiseWidgetValues），
 * 所以这里也必须跳过，否则下标会整体偏移。
 *
 * @param {{widgets?: Array<{name?: string, serialize?: boolean}>}} node 实时图上的节点
 * @param {string} name 要找的 widget 名
 * @returns {number} 下标；找不到返回 -1
 */
export function widgetIndexOf(node, name) {
    if (!node?.widgets) return -1;
    let index = -1;
    for (const widget of node.widgets) {
        if (widget?.serialize === false) continue;
        index++;
        if (widget?.name === name) return index;
    }
    return -1;
}
