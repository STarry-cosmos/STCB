/**
 * 触发内容解析逻辑的测试
 *
 * 纯 Node 环境跑，不需要浏览器：
 *     node test_parse.mjs
 */

import {
    extractMarked,
    splitByMarkers,
    parseLangs,
    matchesLang,
    stableId,
    extractPromptsFromRaw,
    expectedSlotIds,
    flattenMarkers,
    latestIndexForSlot,
} from "./parse.js";

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
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    check(name, a === b, `期望 ${b}，实际 ${a}`);
}

const S = "image###";
const E = "###";

/* ---------------- 用户实际给的例子 ---------------- */
console.log("\n案例 1：用户实际使用的那一条");
{
    const line =
        "image###sfw, 1girl, from front, braided black hair, amber eyes, small tusks, " +
        "confident smirk, toned muscular build, leather chestplate, fur shoulder pads, " +
        "holding two-handed axe, snowy mountain background, jagged rocks, cloudy sky###";

    eq("extractMarked 取到完整提示词", extractMarked(line, S, E),
        "sfw, 1girl, from front, braided black hair, amber eyes, small tusks, " +
        "confident smirk, toned muscular build, leather chestplate, fur shoulder pads, " +
        "holding two-handed axe, snowy mountain background, jagged rocks, cloudy sky");

    eq("splitByMarkers 切出一个 prompt 片段",
        splitByMarkers(line, S, E),
        [{ type: "prompt", value: extractMarked(line, S, E) }]);
}

/* ---------------- 前后有正文 ---------------- */
console.log("\n案例 2：标记夹在正文中间，前后的文字要保留");
{
    const text = "她转过身来。image###1girl, solo, sunset### 然后笑了笑。";
    eq("切成三段", splitByMarkers(text, S, E), [
        { type: "text", value: "她转过身来。" },
        { type: "prompt", value: "1girl, solo, sunset" },
        { type: "text", value: " 然后笑了笑。" },
    ]);
}

/* ---------------- 多个标记 ---------------- */
console.log("\n案例 3：一条消息里出现多个标记，都要识别");
{
    const text = "image###first, one### 中间 image###second, two### 结尾";
    eq("切成五段", splitByMarkers(text, S, E), [
        { type: "prompt", value: "first, one" },
        { type: "text", value: " 中间 " },
        { type: "prompt", value: "second, two" },
        { type: "text", value: " 结尾" },
    ]);
}

/* ---------------- 空白与换行 ---------------- */
console.log("\n案例 4：内容前后的空白和换行要被去掉");
{
    const text = "image###\n  1girl, solo  \n###";
    eq("trim 后取出", extractMarked(text, S, E), "1girl, solo");
    eq("切出的片段也是干净的", splitByMarkers(text, S, E), [
        { type: "prompt", value: "1girl, solo" },
    ]);
}

/* ---------------- 空内容 ---------------- */
console.log("\n案例 5：空标记对不生成按钮，原文保留");
{
    const text = "前面 image###### 后面";
    eq("extractMarked 返回 null", extractMarked(text, S, E), null);
    eq("splitByMarkers 返回 null（不动这个节点）", splitByMarkers(text, S, E), null);
}

console.log("\n案例 5b：一个有效 + 一个空标记，空的那个要原样留着");
{
    const text = "image###good, one### 中间 image###### 结尾";
    eq("空标记作为文本保留", splitByMarkers(text, S, E), [
        { type: "prompt", value: "good, one" },
        { type: "text", value: " 中间 image###### 结尾" },
    ]);
}

/* ---------------- 不完整的标记 ---------------- */
console.log("\n案例 6：只有半个标记时不动它");
{
    eq("只有开始标记", splitByMarkers("前面 image###没有结束", S, E), null);
    eq("只有结束标记", splitByMarkers("前面 没有开始###", S, E), null);
    eq("完全没有标记", splitByMarkers("普通的一段话", S, E), null);
    eq("空字符串", splitByMarkers("", S, E), null);
    eq("null 输入", splitByMarkers(null, S, E), null);
}

/* ---------------- 自定义标记 ---------------- */
console.log("\n案例 7：标记可自定义");
{
    eq("换成 <<< >>>",
        extractMarked("<<<1girl, solo>>>", "<<<", ">>>"),
        "1girl, solo");
    eq("旧标记在新配置下不再触发",
        splitByMarkers("image###1girl###", "<<<", ">>>"),
        null);
    eq("标记为空时安全返回", splitByMarkers("image###1girl###", "", ""), null);
}

/* ---------------- 内容里含特殊字符 ---------------- */
console.log("\n案例 8：内容里含逗号、括号、中文、引号都不受影响");
{
    eq("含括号与冒号",
        extractMarked("image###1girl, (masterpiece:1.2), [depth]###", S, E),
        "1girl, (masterpiece:1.2), [depth]");
    eq("含中文",
        extractMarked("image###白发少女, 雪景###", S, E),
        "白发少女, 雪景");
    eq("含单双引号",
        extractMarked(`image###she said "hi", it's fine###`, S, E),
        `she said "hi", it's fine`);
}

/* ---------------- 相邻的两个标记 ---------------- */
console.log("\n案例 9：两个标记紧挨着，中间没有正文");
{
    eq("中间不产生空的 text 片段",
        splitByMarkers("image###one###image###two###", S, E),
        [
            { type: "prompt", value: "one" },
            { type: "prompt", value: "two" },
        ]);
}

/* ---------------- parseLangs ---------------- */
console.log("\n案例 10：语言列表解析");
{
    eq("逗号分隔", parseLangs("comfy, stcb"), ["comfy", "stcb"]);
    eq("带多余空格", parseLangs("  comfy ,  STCB  "), ["comfy", "stcb"]);
    eq("空字符串", parseLangs(""), []);
    eq("null", parseLangs(null), []);
    eq("多余逗号", parseLangs("comfy,,stcb,"), ["comfy", "stcb"]);
}

/* ---------------- matchesLang ---------------- */
console.log("\n案例 11：代码块语言匹配");
{
    check("language-comfy 命中", matchesLang("hljs language-comfy", ["comfy"]));
    check("单独一个 language-comfy 命中", matchesLang("language-comfy", ["comfy"]));
    check("language-comfy 不该误匹配到 comfyui 规则之外",
        matchesLang("hljs language-comfy", ["comfyui"]) === false);
    check("language-comfyui 在 comfy 规则下也不该命中（词边界）",
        matchesLang("hljs language-comfyui", ["comfy"]) === false);
    check("language-stcb 命中", matchesLang("language-stcb", ["comfy", "stcb"]));
    check("无关语言不命中", matchesLang("language-python", ["comfy"]) === false);
    check("空类名不命中", matchesLang("", ["comfy"]) === false);
    check("语言列表为空不命中", matchesLang("language-comfy", []) === false);
    check("普通类名里的独立 comfy 也能命中",
        matchesLang("code comfy highlighted", ["comfy"]));
}

/* ---------------- stableId ---------------- */
console.log("\n案例 12：插槽稳定 ID");
{
    const a = "1girl, solo, sunset";
    const b = "1girl, solo, sunset";
    const c = "1girl, solo, sunrise";

    check("同样的输入得到同样的 ID", stableId(a) === stableId(b), `${stableId(a)} vs ${stableId(b)}`);
    check("不同输入得到不同 ID", stableId(a) !== stableId(c));
    check("ID 有可读前缀", stableId(a).startsWith("stcb-id-"), stableId(a));
    check("ID 只含安全字符", /^stcb-id-[0-9a-z]+$/.test(stableId(a)), stableId(a));

    // 这两条是实际会遇到的
    const long =
        "sfw, 1girl, from front, braided black hair, amber eyes, small tusks, " +
        "confident smirk, toned muscular build, leather chestplate, fur shoulder pads, " +
        "holding two-handed axe, snowy mountain background, jagged rocks, cloudy sky";
    check("长提示词可用", /^stcb-id-/.test(stableId(long)));
    check("长提示词稳定", stableId(long) === stableId(long));
    check("中文可用", /^stcb-id-/.test(stableId("白发少女, 雪景")));

    check("空字符串不报错", /^stcb-id-/.test(stableId("")));
    check("null 不报错", /^stcb-id-/.test(stableId(null)));
    check("undefined 不报错", /^stcb-id-/.test(stableId(undefined)));

    // 相邻提示词不该碰撞（用于确认不同按钮不会串台）
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(stableId(`prompt number ${i}`));
    check("200 个不同提示词无碰撞", ids.size === 200, `实际 ${ids.size}`);
}

/* ---------------- extractPromptsFromRaw / expectedSlotIds ---------------- */
console.log("\n案例 13：从原始消息文本提取提示词（用于清理孤立图片）");
{
    eq("只有标记",
        extractPromptsFromRaw("正文 image###one, two### 结尾", S, E),
        ["one, two"]);

    eq("多个标记",
        extractPromptsFromRaw("a image###first### b image###second### c", S, E),
        ["first", "second"]);

    eq("代码块（语言匹配）",
        extractPromptsFromRaw("前言\n```comfy\n1girl, solo\n```\n后记", S, E, ["comfy"]),
        ["1girl, solo"]);

    eq("代码块（语言不匹配则不取）",
        extractPromptsFromRaw("```python\nprint(1)\n```", S, E, ["comfy"]),
        []);

    eq("代码块里又包了标记，取标记内的",
        extractPromptsFromRaw("```comfy\nimage###inner, prompt###\n```", S, E, ["comfy"]),
        ["inner, prompt"]);

    eq("标记 + 代码块混排",
        extractPromptsFromRaw(
            "image###first###\n\n```comfy\nsecond\n```",
            S, E,
            ["comfy"],
        ),
        ["first", "second"]);

    eq("没有提示词", extractPromptsFromRaw("普通的一段话", S, E, ["comfy"]), []);
    eq("空输入", extractPromptsFromRaw("", S, E, ["comfy"]), []);
    eq("null 输入", extractPromptsFromRaw(null, S, E, ["comfy"]), []);
    eq("不传语言列表时不解析代码块",
        extractPromptsFromRaw("```comfy\nx\n```", S, E),
        []);
}

console.log("\n案例 14：算出消息应有的插槽 ID");
{
    const raw = "a image###one### b image###two###";
    const ids = expectedSlotIds(raw, S, E);
    check("得到两个 ID", ids.size === 2, `实际 ${ids.size}`);
    check("包含 one 的 ID", ids.has(stableId("one")));
    check("包含 two 的 ID", ids.has(stableId("two")));
    check("不包含无关 ID", !ids.has(stableId("three")));

    // 这正是"改了提示词之后旧图变孤儿"的场景
    const after = expectedSlotIds("a image###one CHANGED### b image###two###", S, E);
    check("提示词改掉后旧 ID 不再出现", !after.has(stableId("one")));
    check("没改的那个还在", after.has(stableId("two")));
}

/* ---------------- flattenMarkers ---------------- */
console.log("\n案例 15：压平标记内的换行（修「行首 ### 被 Markdown 当标题」）");
{
    // 用户实际报的那个 bug
    eq("行首的 ### 被拉回上一行",
        flattenMarkers("image###1girl, solo\n###", S, E),
        "image###1girl, solo ###");

    eq("本来就在同一行的不受影响",
        flattenMarkers("image###1girl, solo ###", S, E),
        "image###1girl, solo ###");

    eq("前面有字符时也正常",
        flattenMarkers("image###1girl, solo\n1###", S, E),
        "image###1girl, solo 1###");

    eq("内容内部的换行也压平",
        flattenMarkers("image###1girl,\nsolo,\nstanding###", S, E),
        "image###1girl, solo, standing###");

    eq("CRLF 也处理",
        flattenMarkers("image###a\r\nb###", S, E),
        "image###a b###");

    eq("前后正文原样保留",
        flattenMarkers("前面\nimage###a\nb###\n后面", S, E),
        "前面\nimage###a b###\n后面");

    eq("多个标记都处理",
        flattenMarkers("image###a\nb### x image###c\nd###", S, E),
        "image###a b### x image###c d###");

    eq("没有标记时原样返回",
        flattenMarkers("普通的一段话\n第二行", S, E),
        "普通的一段话\n第二行");

    eq("空输入", flattenMarkers("", S, E), "");
    eq("null 输入", flattenMarkers(null, S, E), "");
    eq("标记为空时原样返回",
        flattenMarkers("image###a\nb###", "", ""),
        "image###a\nb###");

    // 压平之后必须还能被正常解析出提示词
    const flat = flattenMarkers("image###1girl, solo\n###", S, E);
    eq("压平后能被解析出提示词",
        extractMarked(flat, S, E),
        "1girl, solo");
}

/* ---------------- latestIndexForSlot ---------------- */
console.log("\n案例 16：新图追加后该显示第几张（修「重复生成不切换」）");
{
    const A = "stcb-id-aaa";
    const B = "stcb-id-bbb";

    eq("只有一张时显示第 0 张", latestIndexForSlot([{ slotId: A }], A), 0);

    eq("追加第二张后显示第 1 张",
        latestIndexForSlot([{ slotId: A }, { slotId: A }], A),
        1);

    eq("追加第三张后显示第 2 张",
        latestIndexForSlot([{ slotId: A }, { slotId: A }, { slotId: A }], A),
        2);

    // 别的插槽的图不能算进来
    eq("只数自己插槽的",
        latestIndexForSlot(
            [{ slotId: A }, { slotId: B }, { slotId: A }, { slotId: B }],
            A,
        ),
        1);

    eq("别的插槽也一样",
        latestIndexForSlot(
            [{ slotId: A }, { slotId: B }, { slotId: A }, { slotId: B }],
            B,
        ),
        1);

    eq("没有匹配项时返回 0", latestIndexForSlot([{ slotId: B }], A), 0);
    eq("空列表返回 0", latestIndexForSlot([], A), 0);
    eq("null 列表返回 0", latestIndexForSlot(null, A), 0);
    eq("没有 slotId 参数返回 0", latestIndexForSlot([{ slotId: A }], ""), 0);
    eq("item 缺 slotId 不影响", latestIndexForSlot([{ url: "x" }], A), 0);
}

console.log("\n" + "=".repeat(46));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("=".repeat(46));

process.exit(failed === 0 ? 0 : 1);
