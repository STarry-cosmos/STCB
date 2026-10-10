/**
 * 触发内容的解析逻辑
 *
 * 全是纯函数，不碰 DOM，所以可以脱离浏览器直接测试（见 test_parse.mjs）。
 */

/** 取出一段文本里第一个被标记包裹的内容；没有则返回 null */
export function extractMarked(text, startTag, endTag) {
    if (!text || !startTag || !endTag) return null;
    const start = text.indexOf(startTag);
    if (start < 0) return null;
    const end = text.indexOf(endTag, start + startTag.length);
    if (end < 0) return null;
    const inner = text.slice(start + startTag.length, end).trim();
    return inner || null;
}

/**
 * 把文本按标记切成片段，供渲染层拼成 DOM。
 *
 * 返回形如：
 *   [ { type: 'text',   value: '前面的文字' },
 *     { type: 'prompt', value: '1girl, solo' },
 *     { type: 'text',   value: '后面的文字' } ]
 *
 * 没有识别到任何标记时返回 null，表示这个文本节点不用动。
 *
 * 空标记对（image######）会被原样保留为文本，不生成按钮——
 * 既然后面没内容，就没必要动它。
 */
export function splitByMarkers(text, startTag, endTag) {
    if (!text || !startTag || !endTag) return null;

    const parts = [];
    let cursor = 0;      // 已经输出到的位置
    let searchFrom = 0;  // 下一次搜索的起点
    let found = false;

    for (;;) {
        const start = text.indexOf(startTag, searchFrom);
        if (start < 0) break;
        const end = text.indexOf(endTag, start + startTag.length);
        if (end < 0) break;

        const inner = text.slice(start + startTag.length, end).trim();
        if (!inner) {
            // 空内容：不生成按钮。这里只推进搜索位置，
            // 不推进 cursor —— 否则这一对标记和它前面的正文会被吞掉。
            searchFrom = end + endTag.length;
            continue;
        }

        if (start > cursor) {
            parts.push({ type: "text", value: text.slice(cursor, start) });
        }
        parts.push({ type: "prompt", value: inner });
        cursor = end + endTag.length;
        searchFrom = cursor;
        found = true;
    }

    if (!found) return null;
    if (cursor < text.length) {
        parts.push({ type: "text", value: text.slice(cursor) });
    }
    return parts;
}

/** 把逗号分隔的语言列表解析成数组 */
export function parseLangs(str) {
    return String(str ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * 新图追加之后，某个插槽应当显示第几张（0 基）。
 *
 * 每个插槽会记住"当前显示第几张"（`stcb_slot_state[slotId].index`），
 * 重复生成时如果不更新这个索引，界面上就会一直显示最早那张 ——
 * 新图明明存进去了，却要手动点右箭头才看得到。
 *
 * 放在这里（而不是 index.js）是为了能脱离 DOM 单测。
 *
 * @param {Array<{slotId?: string}>} mediaList message.extra.stcb_media
 * @param {string} slotId
 * @returns {number} 该插槽最后一张的下标；没有匹配项时返回 0
 */
export function latestIndexForSlot(mediaList, slotId) {
    if (!slotId || !Array.isArray(mediaList)) return 0;
    let count = 0;
    for (const item of mediaList) {
        if (item?.slotId === slotId) count++;
    }
    return Math.max(0, count - 1);
}

/**
 * 把触发标记内部的换行压平成空格。
 *
 * 为什么需要：Markdown 会把**行首**的 `###` 当成三级标题。于是
 *
 *     image###1girl, solo
 *     ###
 *
 * 会被渲染成 `<p>image###1girl, solo</p><h3></h3>` ——
 * 标记被拆到两个元素里，而且 `###` 被当成语法吃掉了。
 * 结果就是解析找不到标记，按钮出不来。
 *
 * 压平成一行后既不会变成标题，也不会被 `<br>` 拆开。
 * 反正整段标记最后会变成按钮，视觉上没有影响。
 *
 * 注意：这个函数只用于「渲染前」的显示文本处理，不要用在 message.mes 上 ——
 * 那会改到实际存下来的消息内容。
 *
 * @param {string} text
 * @param {string} startTag
 * @param {string} endTag
 * @returns {string} 压平后的文本；没有标记时原样返回
 */
export function flattenMarkers(text, startTag, endTag) {
    const src = String(text ?? "");
    if (!src || !startTag || !endTag || !src.includes(startTag)) return src;

    const pattern = new RegExp(
        `${escapeRegExp(startTag)}([\\s\\S]*?)${escapeRegExp(endTag)}`,
        "g",
    );
    return src.replace(
        pattern,
        (_match, inner) => `${startTag}${String(inner).replace(/\s*\n\s*/g, " ")}${endTag}`,
    );
}

/**
 * 由字符串算出一个稳定的短 ID。
 *
 * 用途：给每个「插槽」（按钮 + 它的图片容器）一个标识，
 * 这样消息重渲染后，还能把图片重新关联回正确的按钮。
 * 因为 ID 只取决于提示词本身，重渲染不会变。
 *
 * 算法照搬 st-chatu8 的 generateStableId（djb2 变体）。
 */
export function stableId(str) {
    const text = String(str ?? "");
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
        hash |= 0; // 保持在 32 位有符号整数范围
    }
    return "stcb-id-" + Math.abs(hash).toString(36);
}

/**
 * 从消息的**原始 markdown 文本**里提取所有提示词。
 *
 * 和 splitByMarkers 的区别：那个工作在渲染后的 DOM 文本上，
 * 这个直接吃 message.mes，所以不用等渲染就能算出「这条消息应该有哪些插槽」。
 * 清理孤立图片时靠它来判断哪些图片已经没有归属了。
 *
 * @param {string} raw 原始消息文本
 * @param {string} startTag
 * @param {string} endTag
 * @param {string[]} langs 代码块语言列表（可选）
 * @returns {string[]} 提示词数组，按出现顺序
 */
export function extractPromptsFromRaw(raw, startTag, endTag, langs = []) {
    const out = [];
    const text = String(raw ?? "");
    if (!text) return out;

    // ① 标记包裹的。
    //    注意：无论标记在不在代码块里都算 —— 这和渲染侧 processCodeBlocks
    //    的行为保持一致（那边也是先看标记、再看语言）。
    let cursor = 0;
    for (;;) {
        if (!startTag || !endTag) break;
        const start = text.indexOf(startTag, cursor);
        if (start < 0) break;
        const end = text.indexOf(endTag, start + startTag.length);
        if (end < 0) break;
        const inner = text.slice(start + startTag.length, end).trim();
        if (inner) out.push(inner);
        cursor = end + endTag.length;
    }

    // ② 带语言标记的代码块。
    //    如果块里已经有标记，说明 ① 已经取过了，这里跳过，免得重复计数。
    if (langs.length > 0) {
        const fence = /^```([^\n`]*)\r?\n([\s\S]*?)^```[ \t]*$/gm;
        let match;
        while ((match = fence.exec(text)) !== null) {
            const lang = match[1].trim().toLowerCase();
            const body = match[2].trim();
            if (!body || !langs.includes(lang)) continue;
            if (extractMarked(body, startTag, endTag)) continue;
            out.push(body);
        }
    }

    return out;
}

/**
 * 算出这条消息「应该」有哪些插槽 ID。
 * 清理孤立图片时，不在这个集合里的图片就是孤儿。
 */
export function expectedSlotIds(raw, startTag, endTag, langs = []) {
    const ids = new Set();
    for (const prompt of extractPromptsFromRaw(raw, startTag, endTag, langs)) {
        ids.add(stableId(prompt));
    }
    return ids;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 判断一个元素的 class 串是否匹配给定的语言标记。
 *
 * 主要看 language-xxx（要求词边界，避免 "comfy" 误匹配 "comfyui"），
 * 也容忍语言名直接出现在其它类名里。
 */
export function matchesLang(className, langs) {
    if (!langs || langs.length === 0) return false;
    const cls = String(className ?? "").toLowerCase();
    return langs.some((lang) => {
        const escaped = escapeRegExp(lang);
        if (new RegExp(`(^|\\s)language-${escaped}($|\\s)`).test(cls)) return true;
        return new RegExp(`(^|[\\s-])${escaped}($|[\\s-])`).test(cls);
    });
}
