/**
 * 正面提示词定位逻辑的测试
 *
 * 不依赖 ComfyUI，直接用 Node 跑：
 *     node test_locate.mjs
 */

import {
    findPositiveTextNodeIds,
    findPromptNodesByClass,
    widgetIndexOf,
    PROMPT_NODE_TYPE,
} from "./web/stcb_locate.js";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
    if (ok) {
        passed++;
        console.log(`  [通过] ${name}`);
    } else {
        failed++;
        console.log(`  [失败] ${name}  ${detail}`);
    }
}

function eq(name, actual, expected) {
    // 用 JSON 比较，这样数组和对象也能正确比对
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    check(name, a === b, `期望 ${b}，实际 ${a}`);
}

function sameSet(a, b) {
    const A = [...a].sort();
    const B = [...b].sort();
    return A.length === B.length && A.every((v, i) => v === B[i]);
}

/* ---------------- 案例 1：标准 SD1.5 文生图 ---------------- */
console.log("\n案例 1：标准文生图，应当只命中正面那条（不能碰负面）");
{
    const wf = {
        "3": {
            class_type: "KSampler",
            inputs: { positive: ["6", 0], negative: ["7", 0], model: ["4", 0], seed: 1, steps: 20 },
        },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5.safetensors" } },
        "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "a cat" } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "bad hands" } },
        "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
        "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("定位方式为反向追溯", via === "trace", `实际 ${via}`);
    check("命中节点 6", sameSet(ids, ["6"]), `实际 ${JSON.stringify(ids)}`);
    check("没有误伤负面节点 7", !ids.includes("7"));
}

/* ---------------- 案例 2：中间隔着 ConditioningCombine ---------------- */
console.log("\n案例 2：positive 经过 ConditioningCombine，应当穿过它继续往上游找");
{
    const wf = {
        "3": {
            class_type: "KSampler",
            inputs: { positive: ["10", 0], negative: ["7", 0], model: ["4", 0] },
        },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "main prompt" } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "negative" } },
        "10": {
            class_type: "ConditioningCombine",
            inputs: { conditioning_1: ["6", 0], conditioning_2: ["11", 0] },
        },
        "11": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "detail boost" } },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("定位方式为反向追溯", via === "trace", `实际 ${via}`);
    check("穿透中间节点命中 6 和 11", sameSet(ids, ["6", "11"]), `实际 ${JSON.stringify(ids)}`);
    check("没有误伤负面节点 7", !ids.includes("7"));
}

/* ---------------- 案例 3：标题标记优先 ---------------- */
console.log("\n案例 3：有 @prompt 标题标记时，应当优先于连线推断");
{
    const wf = {
        "3": {
            class_type: "KSampler",
            // 故意把 positive 指到别的节点，标题标记应当压过它
            inputs: { positive: ["7", 0], negative: ["8", 0] },
        },
        "6": { class_type: "CLIPTextEncode", _meta: { title: "@prompt" }, inputs: { text: "x" } },
        "7": { class_type: "CLIPTextEncode", _meta: { title: "其他用途" }, inputs: { text: "y" } },
        "8": { class_type: "CLIPTextEncode", _meta: { title: "负面提示词" }, inputs: { text: "z" } },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("定位方式为标题标记", via === "title", `实际 ${via}`);
    check("命中节点 6", sameSet(ids, ["6"]), `实际 ${JSON.stringify(ids)}`);
}

/* ---------------- 案例 4：中文标题 ---------------- */
console.log("\n案例 4：中文标题「正面提示词」也应当被识别");
{
    const wf = {
        "2": { class_type: "CLIPTextEncode", _meta: { title: "正面提示词" }, inputs: { text: "a" } },
        "3": { class_type: "CLIPTextEncode", _meta: { title: "负面提示词" }, inputs: { text: "b" } },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("定位方式为标题标记", via === "title", `实际 ${via}`);
    check("只命中正面那个", sameSet(ids, ["2"]), `实际 ${JSON.stringify(ids)}`);
}

/* ---------------- 案例 5：没有采样器，走兜底 ---------------- */
console.log("\n案例 5：图里没有采样器时，回退到第一个 CLIPTextEncode");
{
    const wf = {
        "6": { class_type: "CLIPTextEncode", inputs: { text: "a" } },
        "7": { class_type: "CLIPTextEncode", inputs: { text: "b" } },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("定位方式为兜底", via === "fallback", `实际 ${via}`);
    check("命中第一个", sameSet(ids, ["6"]), `实际 ${JSON.stringify(ids)}`);
}

/* ---------------- 案例 6：环形引用不能死循环 ---------------- */
console.log("\n案例 6：连线成环时不能死循环");
{
    const wf = {
        "1": { class_type: "Foo", inputs: { x: ["2", 0] } },
        "2": { class_type: "Bar", inputs: { y: ["1", 0] } },
        "3": { class_type: "KSampler", inputs: { positive: ["1", 0] } },
    };
    const started = Date.now();
    const { ids, via } = findPositiveTextNodeIds(wf);
    const elapsed = Date.now() - started;
    check("没有卡死（1 秒内返回）", elapsed < 1000, `耗时 ${elapsed}ms`);
    check("没找到文本节点", ids.length === 0, `实际 ${JSON.stringify(ids)}`);
    check("定位方式为空", via === null, `实际 ${via}`);
}

/* ---------------- 案例 7：空输入与异常输入 ---------------- */
console.log("\n案例 7：异常输入应当安全返回");
{
    for (const [name, input] of [
        ["空对象", {}],
        ["null", null],
        ["undefined", undefined],
    ]) {
        const { ids, via } = findPositiveTextNodeIds(input);
        check(`${name} 不报错且返回空`, Array.isArray(ids) && ids.length === 0 && via === null);
    }
}

/* ---------------- 案例 8：Flux 风格（多个文本节点，非 CLIPTextEncode） ---------------- */
console.log("\n案例 8：非 CLIPTextEncode 的文本节点（如 Flux 的文本编码器）");
{
    const wf = {
        "6": { class_type: "CLIPTextEncodeFlux", inputs: { clip: ["4", 1], text: "flux prompt" } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["4", 1], text: "negative" } },
        "3": {
            class_type: "KSampler",
            inputs: { positive: ["6", 0], negative: ["7", 0], model: ["4", 0] },
        },
    };
    const { ids, via } = findPositiveTextNodeIds(wf);
    check("按连线找到 Flux 的文本节点", via === "trace" && sameSet(ids, ["6"]), `${via} ${JSON.stringify(ids)}`);
}

/* ---------------- 案例 9：文本节点同时也是 negative 来源时不应误判 ---------------- */
console.log("\n案例 9：同一个文本节点同时供 positive 和 negative，应当只算一次");
{
    const wf = {
        "3": {
            class_type: "KSampler",
            inputs: { positive: ["6", 0], negative: ["6", 0] },
        },
        "6": { class_type: "CLIPTextEncode", inputs: { text: "shared" } },
    };
    const { ids } = findPositiveTextNodeIds(wf);
    check("去重后只有一个", ids.length === 1 && ids[0] === "6", JSON.stringify(ids));
}

/* ---------------- 案例 10：widgetIndexOf ---------------- */
console.log("\n案例 10：算出 widget 在 widgets_values 里的下标（同步提示词到元数据要用）");
{
    eq("CLIPTextEncode：只有 text，下标 0",
        widgetIndexOf({ widgets: [{ name: "text" }] }, "text"),
        0);

    eq("前面有别的 widget",
        widgetIndexOf(
            { widgets: [{ name: "clip" }, { name: "text" }] },
            "text",
        ),
        1);

    eq("serialize === false 的 widget 要跳过",
        widgetIndexOf(
            {
                widgets: [
                    { name: "clip" },
                    { name: "hidden", serialize: false },
                    { name: "text" },
                ],
            },
            "text",
        ),
        1);

    eq("多个隐藏 widget 也要跳过",
        widgetIndexOf(
            {
                widgets: [
                    { name: "a", serialize: false },
                    { name: "b", serialize: false },
                    { name: "text" },
                ],
            },
            "text",
        ),
        0);

    eq("找不到返回 -1",
        widgetIndexOf({ widgets: [{ name: "other" }] }, "text"),
        -1);

    eq("没有 widgets 返回 -1", widgetIndexOf({}, "text"), -1);
    eq("null 节点返回 -1", widgetIndexOf(null, "text"), -1);
    eq("undefined 节点返回 -1", widgetIndexOf(undefined, "text"), -1);

    // 带 control_after_generate 的采样器：seed 是第 0 个
    eq("KSampler 的 seed",
        widgetIndexOf(
            {
                widgets: [
                    { name: "seed" },
                    { name: "control_after_generate" },
                    { name: "steps" },
                ],
            },
            "seed",
        ),
        0);
}

/* ---------------- 案例 11：findPromptNodesByClass ---------------- */
console.log("\n案例 11：按 class_type 找「酒馆提示词」节点（现在的主路径）");
{
    const wf = {
        "3": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
        "6": { class_type: "CLIPTextEncode", inputs: { text: "x" } },
        "20": { class_type: "STCBPrompt", inputs: { prompt: "from tavern" } },
        "30": { class_type: "string_combine_plus", inputs: { file1: ["20", 0] } },
    };

    eq("找到那一个节点", findPromptNodesByClass(wf), ["20"]);

    const two = {
        "20": { class_type: "STCBPrompt", inputs: { prompt: "a" } },
        "21": { class_type: "STCBPrompt", inputs: { prompt: "b" } },
    };
    eq("多个都要找到", findPromptNodesByClass(two), ["20", "21"]);

    eq("没有时返回空数组",
        findPromptNodesByClass({
            "3": { class_type: "KSampler" },
            "6": { class_type: "CLIPTextEncode" },
        }),
        []);
    eq("空对象", findPromptNodesByClass({}), []);
    eq("null", findPromptNodesByClass(null), []);
    eq("undefined", findPromptNodesByClass(undefined), []);

    eq("支持自定义类型名",
        findPromptNodesByClass(
            { "1": { class_type: "MyPromptNode" } },
            "MyPromptNode",
        ),
        ["1"]);

    check("默认类型名是 STCBPrompt", PROMPT_NODE_TYPE === "STCBPrompt", PROMPT_NODE_TYPE);

    // 关键：不能误伤普通文本节点，否则又会走回整段替换
    const onlyClip = { "6": { class_type: "CLIPTextEncode", inputs: { text: "x" } } };
    eq("不会把 CLIPTextEncode 当成提示词节点", findPromptNodesByClass(onlyClip), []);
}

console.log("\n" + "=".repeat(46));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("=".repeat(46));

process.exit(failed === 0 ? 0 : 1);
