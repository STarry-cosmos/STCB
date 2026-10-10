/**
 * STCB 桥接 — SillyTavern 侧扩展
 *
 * 做的事：
 *   1. 扫描 AI 回复里的 comfy 代码块，替换成「生成图片」按钮
 *   2. 点按钮 → 把提示词发给桥接服务 → 轮询结果
 *   3. 拿到图片 → 挂到该条消息上（用酒馆原生的媒体系统）
 *
 * 不做的事：不碰工作流、不管负面提示词、不管模型参数——
 * 那些全部由 ComfyUI 里当前打开的工作流决定。
 */

import {
    extractMarked,
    splitByMarkers,
    parseLangs,
    matchesLang,
    stableId,
    expectedSlotIds,
    flattenMarkers,
    latestIndexForSlot,
} from "./parse.js";

const MODULE_NAME = "stcb";
const LOG = "[STCB]";

const DEFAULT_SETTINGS = {
    bridgeUrl: "http://127.0.0.1:8765",
    // 与 st-chatu8 一致的触发标记，方便从那边迁移过来
    startTag: "image###",
    endTag: "###",
    // 备选方式：用这些语言标记的代码块也会变成按钮
    codeLangs: "comfy, stcb",
    confirmBeforeSend: true,
    // 同时最多允许几个任务在跑/排队。0 表示不限制。
    // 排队本身由 ComfyUI 自己的队列完成（FIFO），这里只是防手滑点太多。
    maxQueue: 5,
    pollIntervalMs: 800,
    timeoutMs: 300000,
    // 图片怎么存：
    //   private —— 存进 message.extra.stcb_media，自己渲染。图片不会进提示词。
    //   native  —— 用酒馆原生媒体系统。有画廊/滑动/全屏，
    //              但会被当成 image_url 发给支持视觉的模型（默认设置下如此）。
    attachMode: "private",
    // 图片显示在哪：
    //   inline —— 紧跟按钮（标记在哪，图就出现在哪）
    //   bottom —— 消息末尾（st-chatu8 的默认行为）
    mediaPosition: "inline",
    // 酒馆的 /api/images/upload 在不同版本里对 image 字段的期望不一样，
    // 这里记住哪种可用，免得每次都先失败一次再重试。
    //   "base64"  —— 1.14+ ：image 是纯 base64，format 单独给
    //   "dataUrl" —— 1.12 及更早：image 是完整 data URL
    //   ""        —— 还没探测过
    imageUploadMode: "",
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const log = (...a) => console.log(LOG, ...a);
const warn = (...a) => console.warn(LOG, ...a);
const err = (...a) => console.error(LOG, ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    // 补齐新增字段
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extensionSettings[MODULE_NAME][k] === undefined) {
            extensionSettings[MODULE_NAME][k] = v;
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function bridgeBase() {
    return getSettings().bridgeUrl.replace(/\/+$/, "");
}

function toast(kind, msg) {
    const fn = globalThis.toastr?.[kind];
    if (typeof fn === "function") {
        fn.call(globalThis.toastr, msg);
    } else if (kind === "error") {
        err(msg);
    } else {
        log(msg);
    }
}

/* ------------------------------------------------------------------ *
 * 识别触发内容
 *
 * 支持两种写法，任选其一：
 *
 *   ① 标记包裹（默认，与 st-chatu8 一致）
 *        image###sfw, 1girl, from front, ... ###
 *      取两个标记之间的内容作为提示词。裸文本和代码块里都认。
 *
 *   ② 代码块语言标记
 *        ```comfy
 *        1girl, solo
 *        ```
 *      酒馆会渲染成 <pre><code class="language-comfy">，并加 hljs 类和复制按钮。
 *
 * 具体的字符串解析在 parse.js 里（纯函数，可脱离浏览器测试）。
 * ------------------------------------------------------------------ */

function activeLangs() {
    return parseLangs(getSettings().codeLangs);
}

/** 取出代码块的纯文本（剔除酒馆加的复制按钮） */
function codeBlockText(codeEl) {
    const clone = codeEl.cloneNode(true);
    clone.querySelectorAll(".code-copy, i.fa-copy").forEach((n) => n.remove());
    return (clone.textContent ?? "").trim();
}

/* ------------------------------------------------------------------ *
 * 按钮
 * ------------------------------------------------------------------ */

function setButtonState(button, state, label) {
    button.dataset.state = state;
    button.classList.remove("stcb-busy", "stcb-queued", "stcb-done", "stcb-error");
    if (state === "busy") button.classList.add("stcb-busy");
    if (state === "queued") button.classList.add("stcb-queued");
    if (state === "done") button.classList.add("stcb-done");
    if (state === "error") button.classList.add("stcb-error");

    const text = button.querySelector(".stcb-btn-text");
    if (text) text.textContent = label;
}

/** 按钮上显示的阶段文案 */
function stageButtonLabel(stage) {
    if (stage === "queued") return "排队中 · 点击取消";
    if (stage === "fetching") return "取图中…";
    if (stage === "running") return "生成中…";
    return "生成中…";
}

/** 还没结束的任务 id —— 用来限制队列长度 */
const inFlightTasks = new Set();

const LONG_PRESS_MS = 1200;

/**
 * 创建一个"插槽"：按钮 + 它的图片容器。
 *
 * 用插槽而不是裸按钮，是为了让图片能跟着按钮走 ——
 * 标记在哪，按钮就在哪，生成的图也就显示在哪。
 */
function createGenSlot(prompt, messageElement) {
    const slot = document.createElement("span");
    slot.className = "stcb-slot";
    slot.dataset.prompt = prompt;
    // 稳定 ID：只取决于提示词，所以消息重渲染后还是同一个值，
    // 图片就能靠它重新找到自己该待的插槽。
    slot.dataset.slotId = stableId(prompt);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "stcb-gen-button";
    button.innerHTML =
        '<i class="fa-solid fa-wand-magic-sparkles stcb-btn-icon"></i>' +
        '<span class="stcb-btn-text">生成图片</span>';

    const media = document.createElement("span");
    media.className = "stcb-media stcb-media-slot";

    let pressTimer = null;
    let longPressed = false;

    const startPress = (e) => {
        if (e.type === "mousedown" && e.button !== 0) return;
        longPressed = false;
        pressTimer = setTimeout(async () => {
            longPressed = true;
            pressTimer = null;
            const edited = await askForPrompt(slot.dataset.prompt);
            if (edited !== null) {
                slot.dataset.prompt = edited;
                slot.dataset.slotId = stableId(edited);
                toast("info", "提示词已更新");
            }
        }, LONG_PRESS_MS);
    };

    const endPress = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    };

    button.addEventListener("mousedown", startPress);
    button.addEventListener("touchstart", startPress, { passive: true });
    button.addEventListener("mouseup", endPress);
    button.addEventListener("mouseleave", endPress);
    button.addEventListener("touchend", endPress);
    button.addEventListener("touchcancel", endPress);

    button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (longPressed) {
            longPressed = false;
            return;
        }
        // 排队中的按钮，再点一次是取消
        if (button.dataset.state === "queued") {
            void cancelGeneration(button);
            return;
        }
        void runGeneration(slot, messageElement);
    });

    slot.appendChild(button);
    slot.appendChild(media);
    return slot;
}

/** 弹出编辑框，返回新提示词；取消则返回 null */
async function askForPrompt(initial) {
    const context = ctx();
    try {
        if (context.Popup?.show?.input) {
            const result = await context.Popup.show.input(
                "提示词",
                "确认或修改要发送给 ComfyUI 的提示词",
                initial,
            );
            return typeof result === "string" ? result.trim() : null;
        }
    } catch (e) {
        warn("调用酒馆弹窗失败，回退到浏览器弹窗", e);
    }
    const result = globalThis.prompt?.("要发送给 ComfyUI 的提示词：", initial);
    return typeof result === "string" ? result.trim() : null;
}

/* ------------------------------------------------------------------ *
 * 与桥接服务通信
 * ------------------------------------------------------------------ */

async function fetchJson(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try {
        body = await res.json();
    } catch (_) {
        /* 忽略解析失败，下面按状态码处理 */
    }
    if (!res.ok) {
        const msg = body?.error || `${res.status} ${res.statusText}`;
        throw new Error(msg);
    }
    return body;
}

async function checkBridge() {
    return fetchJson(`${bridgeBase()}/api/status`);
}

async function submitTask(prompt) {
    const body = await fetchJson(`${bridgeBase()}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
    });
    if (!body?.task_id) throw new Error("桥接服务没有返回 task_id");
    return body.task_id;
}

/** 任务被用户取消 */
class TaskCancelled extends Error {
    constructor(message = "已取消") {
        super(message);
        this.name = "TaskCancelled";
        this.cancelled = true;
    }
}

/**
 * 轮询任务状态直到结束。
 * @param {(info: object) => void} [onUpdate] 每次拿到状态都回调，用来更新按钮
 */
async function waitForTask(taskId, onUpdate) {
    const { pollIntervalMs, timeoutMs } = getSettings();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const body = await fetchJson(`${bridgeBase()}/api/task/${taskId}`);
        if (body.status === "done") return body;
        if (body.status === "cancelled") throw new TaskCancelled(body.error || "已取消");
        if (body.status === "error") throw new Error(body.error || "生成失败");
        onUpdate?.(body);
        await sleep(pollIntervalMs);
    }
    throw new Error(`等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
}

/* ------------------------------------------------------------------ *
 * 生成流程
 * ------------------------------------------------------------------ */

async function runGeneration(slot, messageElement) {
    const button = slot.querySelector(".stcb-gen-button");
    const state = button?.dataset.state;
    if (!button || state === "busy" || state === "queued") return;

    // 队列上限：数一下自己还有几个任务没结束
    const maxQueue = Math.max(0, Number(getSettings().maxQueue) || 0);
    if (maxQueue > 0 && inFlightTasks.size >= maxQueue) {
        toast("warning", `队列已满（${inFlightTasks.size}/${maxQueue}），等前面的跑完再试`);
        return;
    }

    let prompt = slot.dataset.prompt || "";

    if (getSettings().confirmBeforeSend) {
        const edited = await askForPrompt(prompt);
        if (edited === null) return;
        if (!edited) {
            toast("warning", "提示词为空，已取消");
            return;
        }
        prompt = edited;
        slot.dataset.prompt = edited;
        slot.dataset.slotId = stableId(edited);
    }

    setButtonState(button, "queued", "提交中…");

    let taskId = null;
    try {
        taskId = await submitTask(prompt);
        inFlightTasks.add(taskId);
        button.dataset.taskId = taskId;

        const result = await waitForTask(taskId, (info) => {
            // stage=queued 时按钮可点击取消；一旦开始生成就只剩展示
            const queued = info.stage === "queued";
            setButtonState(button, queued ? "queued" : "busy", stageButtonLabel(info.stage));
        });

        // 拿到图之后先存进酒馆，再挂到消息上
        const imageUrl = await storeImage(result, slot.dataset.slotId);
        if (!imageUrl) throw new Error("桥接服务没有返回图片");
        await attachImage(messageElement, imageUrl, prompt, slot.dataset.slotId);
        setButtonState(button, "done", "再生成一张");
        toast("success", "图片已生成");
    } catch (e) {
        if (e?.cancelled) {
            setButtonState(button, "idle", "生成图片");
            toast("info", "已取消");
        } else {
            err("生成失败", e);
            setButtonState(button, "error", "重试");
            toast("error", `生成失败：${e.message}`);
        }
    } finally {
        if (taskId) inFlightTasks.delete(taskId);
        delete button.dataset.taskId;
    }
}

/**
 * 点击「排队中」的按钮 → 取消该任务。
 * 已经开始生成的任务桥接服务会拒绝（按钮那时也早就不是这个状态了）。
 */
async function cancelGeneration(button) {
    const taskId = button.dataset.taskId;
    if (!taskId) return;

    setButtonState(button, "queued", "取消中…");
    try {
        await fetchJson(`${bridgeBase()}/api/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: taskId }),
        });
        // 按钮的真正恢复交给轮询 —— 任务变成 cancelled 后 waitForTask 会抛出
    } catch (e) {
        warn("取消失败", e);
        toast("warning", `取消失败：${e.message}`);
        // 恢复到可再次尝试的状态
        setButtonState(button, "queued", "排队中 · 点击取消");
    }
}

/* ------------------------------------------------------------------ *
 * 图片存储与显示
 *
 * 两种模式（见 DEFAULT_SETTINGS.attachMode）：
 *
 *   private —— 存进 message.extra.stcb_media 这个自定义字段，自己渲染。
 *              酒馆不认识这个字段，所以图片不会被当成 image_url 发给模型。
 *              默认用这个：一张 1024×1024 的图要吃掉 1000+ token，
 *              而且让角色"看到"自己刚生成的插图往往会把对话带偏。
 *
 *   native  —— 用酒馆原生的 message.extra.media，画廊/滑动/全屏都是现成的，
 *              但酒馆默认会把媒体内联进提示词（openai.js 的 media_inlining 默认 true）。
 *              想让角色"看见"插图时可以切到这个模式。
 * ------------------------------------------------------------------ */

function getMessageByElement(messageElement) {
    const context = ctx();
    const messageId = Number(messageElement.getAttribute("mesid"));
    const message = context.chat?.[messageId];
    if (!message) throw new Error("找不到对应的消息对象");
    return message;
}

function ensureExtra(message) {
    if (!message.extra || typeof message.extra !== "object") {
        message.extra = {};
    }
    return message.extra;
}

/** private 模式：存自定义字段，不进提示词 */
function attachImagePrivate(message, url, prompt, slotId) {
    const extra = ensureExtra(message);
    if (!Array.isArray(extra.stcb_media)) extra.stcb_media = [];
    extra.stcb_media.push({ url, prompt, slotId, ts: Date.now() });

    // 把该插槽的当前索引挪到最后一张 —— 否则重复生成时界面还停在旧图上，
    // 新图要手动点右箭头才看得到。
    // 顺带取消隐藏：用户刚点了生成，就是想看新图。
    if (slotId) {
        setSlotState(message, slotId, {
            index: latestIndexForSlot(extra.stcb_media, slotId),
            hidden: false,
        });
    }
}

/** native 模式：交给酒馆原生媒体系统 */
function attachImageNative(message, messageElement, url) {
    const context = ctx();
    const extra = ensureExtra(message);
    if (!Array.isArray(extra.media)) extra.media = [];
    extra.media.push({ url, type: "image" });
    extra.media_index = extra.media.length - 1;

    if (typeof context.appendMediaToMessage !== "function") {
        warn("appendMediaToMessage 不可用，图片已写入数据但未渲染");
        return;
    }
    // 注意：酒馆这个函数期望 jQuery 对象，传原生 DOM 元素会在内部 .find() 处报错
    context.appendMediaToMessage(message, jQuery(messageElement));
}

/** 按 mesid 重新取一次元素，避免用到已被重渲染替换掉的旧引用 */
function resolveMessageElement(messageElement) {
    const id = messageElement?.getAttribute?.("mesid");
    if (id === null || id === undefined) return messageElement;
    const fresh = document.querySelector(`.mes[mesid="${id}"]`);
    if (!fresh) {
        warn(`按 mesid=${id} 找不到消息元素，退回旧引用（可能已脱离文档）`);
        return messageElement;
    }
    return fresh;
}

/* ------------------------------------------------------------------ *
 * 图片存储：交给酒馆托管
 *
 * 用酒馆自带的 POST /api/images/upload 把图存进用户图片目录，
 * 返回的路径（/user/images/stcb/xxx.png）由酒馆自己托管
 * （服务端在 src/users.js 里挂了 router.use('/user/images/*', ...)）。
 *
 * 好处：看图不再依赖桥接服务，聊天记录里也只留一个短路径。
 *
 * 接口用法参考酒馆自己的 public/scripts/utils.js：
 *   body: { image: <data URL>, ch_name, filename }
 *   headers: getRequestHeaders() + Content-Type
 *
 * ⚠️ image 必须是**完整的 data URL** —— 服务端是按
 *   "data:image/png;base64,xxx" 这个格式 split(',') 解析的。
 *   只发纯 base64 会撞 400 Invalid image format。
 * ------------------------------------------------------------------ */

/**
 * 酒馆的 /api/images/upload 在不同版本里对 image 字段的期望不一样：
 *
 *   · 1.14+ ：image 是**纯 base64**，format 单独给一个字段
 *   · 1.12 及更早：image 是**完整 data URL**，format 从里面 split 出来
 *
 * 两者互斥 —— 发错格式会被回 400 Invalid image format。
 * 所以先按记住的那种发，没记住就先用新版格式；失败再试另一种并记住。
 */
function buildUploadAttempts(dataUrl, safeName) {
    const mime = /^data:([^;,]*)/.exec(dataUrl)?.[1] || "";
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const format = mime.split("/")[1] || "png";

    const modes = {
        base64: {
            label: "纯 base64",
            body: { image: base64, format, ch_name: "stcb", filename: safeName },
        },
        dataUrl: {
            label: "data URL",
            body: { image: dataUrl, ch_name: "stcb", filename: safeName },
        },
    };

    const remembered = getSettings().imageUploadMode;
    const order =
        remembered && modes[remembered]
            ? [remembered, remembered === "base64" ? "dataUrl" : "base64"]
            : ["base64", "dataUrl"];

    return { mime, attempts: order.map((key) => ({ key, ...modes[key] })) };
}

/** 把一张图片（data URL）存进酒馆，返回可直接用作 <img src> 的路径 */
async function uploadImageToTavern(dataUrl, filename) {
    const safeName = String(filename).replace(/\./g, "_");
    const { mime, attempts } = buildUploadAttempts(dataUrl, safeName);

    let lastError = null;

    for (const [index, attempt] of attempts.entries()) {
        const headers = {
            ...ctx().getRequestHeaders(),
            "Content-Type": "application/json",
        };

        log(
            `上传图片（${attempt.label}）：mime=${mime || "?"}，` +
                `${dataUrl.length} 字符，带 token=${Boolean(headers["X-CSRF-Token"])}`,
        );

        let res;
        try {
            res = await fetch("/api/images/upload", {
                method: "POST",
                headers,
                body: JSON.stringify(attempt.body),
            });
        } catch (e) {
            lastError = e;
            continue;
        }

        if (res.ok) {
            const data = await res.json();
            if (data?.path) {
                // 记住哪种格式可用，下次直接用
                if (getSettings().imageUploadMode !== attempt.key) {
                    getSettings().imageUploadMode = attempt.key;
                    saveSettings();
                    log(`这个酒馆要的是「${attempt.label}」，已记住`);
                }
                if (index > 0) {
                    log(`换用「${attempt.label}」成功了`);
                }
                return data.path;
            }
            lastError = new Error("酒馆没有返回图片路径");
            continue;
        }

        // 把服务端的说明读出来 —— 否则只有一个 400，完全没法排查
        let detail = "";
        try {
            detail = (await res.text()).slice(0, 300);
        } catch (_) {
            /* 读不出来就算了 */
        }

        lastError = new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
        warn(`上传失败（${attempt.label}）`, lastError.message);
    }

    throw lastError ?? new Error("上传失败");
}

/**
 * 把桥接服务返回的结果存进酒馆。
 * 存失败就退回内联 data URL —— 图还是能看，只是聊天记录会变大。
 */
async function storeImage(result, slotId) {
    const base64 = result?.image;
    if (!base64) return null;

    const format = result.format || "image/png";
    const dataUrl = `data:${format};base64,${base64}`;
    const filename = `${Date.now()}-${String(slotId || "img").replace(/^stcb-id-/, "")}`;

    try {
        const path = await uploadImageToTavern(dataUrl, filename);
        log(`图片已存进酒馆：${path}`);
        return path;
    } catch (e) {
        err("存进酒馆失败，改用内联图片", e);
        toast("warning", "图片没能存进酒馆，已改用内联方式（聊天记录会变大）");
        return dataUrl;
    }
}

async function attachImage(messageElement, imageUrl, prompt, slotId) {
    const context = ctx();
    // 出图可能花几十秒，期间消息可能被重渲染过，所以重新解析一次元素
    const host = resolveMessageElement(messageElement);
    const message = getMessageByElement(host);

    if (getSettings().attachMode === "native") {
        attachImageNative(message, host, imageUrl);
    } else {
        attachImagePrivate(message, imageUrl, prompt, slotId);
        renderStcbMedia(host, message);
    }
    await context.saveChat?.();
}

/* ------------------------------------------------------------------ *
 * private 模式的渲染
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 插槽状态（当前显示第几张、是否隐藏）
 *
 * 存在 message.extra.stcb_slot_state 里，跟着聊天记录持久化。
 * ------------------------------------------------------------------ */

let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            ctx().saveChat?.();
        } catch (e) {
            warn("保存聊天失败", e);
        }
    }, 500);
}

function getSlotState(message, slotId) {
    const states = message?.extra?.stcb_slot_state;
    const raw = states && typeof states === "object" ? states[slotId] : null;
    return {
        index: Number.isInteger(raw?.index) ? raw.index : 0,
        hidden: Boolean(raw?.hidden),
    };
}

function setSlotState(message, slotId, patch) {
    if (!slotId) return;
    const extra = ensureExtra(message);
    if (!extra.stcb_slot_state || typeof extra.stcb_slot_state !== "object") {
        extra.stcb_slot_state = {};
    }
    extra.stcb_slot_state[slotId] = { ...getSlotState(message, slotId), ...patch };
    scheduleSave();
}

/* ------------------------------------------------------------------ *
 * 全屏查看（支持左右切换）
 * ------------------------------------------------------------------ */

function makeNavButton(label, onClick, extraClass = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `stcb-nav ${extraClass}`.trim();
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
    });
    return btn;
}

/**
 * 打开全屏查看。
 * @param {Array<{url:string}>} items 同一个插槽下的所有图片
 * @param {number} startIndex 从第几张开始看
 */
function openLightbox(items, startIndex = 0) {
    const list = Array.isArray(items) ? items.filter((it) => it?.url) : [];
    if (list.length === 0) return;

    let index = Math.min(Math.max(startIndex, 0), list.length - 1);

    const overlay = document.createElement("div");
    overlay.className = "stcb-lightbox";

    const img = document.createElement("img");
    img.alt = "生成的图片";
    overlay.appendChild(img);

    const counter = document.createElement("div");
    counter.className = "stcb-lightbox-count";
    overlay.appendChild(counter);

    const render = () => {
        img.src = list[index].url;
        counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : "";
    };
    render();

    const go = (delta) => {
        index = (index + delta + list.length) % list.length;
        render();
    };

    const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowLeft") {
            e.preventDefault();
            go(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            go(1);
        }
    };

    if (list.length > 1) {
        overlay.appendChild(makeNavButton("‹", () => go(-1), "stcb-lightbox-prev"));
        overlay.appendChild(makeNavButton("›", () => go(1), "stcb-lightbox-next"));
    }

    // 点背景关闭；点图片本身不关
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay || e.target === counter) close();
    });
    img.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
}

/** 当前消息里实际存在的插槽 ID */
function liveSlotIds(host) {
    const ids = new Set();
    host.querySelectorAll(".stcb-slot").forEach((slot) => {
        if (slot.dataset.slotId) ids.add(slot.dataset.slotId);
    });
    return ids;
}

/**
 * 渲染一个插槽里的画廊。
 * 同一提示词生成的多张图**一次只显示一张**，用 ‹ n/N › 切换，也可以整个隐藏。
 */
function renderSlotGallery(box, items, message, slotId, host) {
    box.innerHTML = "";
    if (!items || items.length === 0) return;

    const state = getSlotState(message, slotId);
    const rerender = () => renderStcbMedia(host, message);

    // 隐藏状态：只留一个小按钮
    if (state.hidden) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "stcb-show-btn";
        btn.textContent = `显示图片 (${items.length})`;
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            setSlotState(message, slotId, { hidden: false });
            rerender();
        });
        box.appendChild(btn);
        return;
    }

    const index = Math.min(Math.max(state.index, 0), items.length - 1);
    const current = items[index];

    const img = document.createElement("img");
    img.className = "stcb-media-img";
    img.src = current.url;
    img.alt = "生成的图片";
    img.title = items.length > 1 ? "点击放大（可左右切换）" : "点击放大";
    img.addEventListener("error", () => {
        err("图片加载失败（桥接服务在运行吗？）", String(current.url).slice(0, 120));
    });
    img.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox(items, index);
    });
    box.appendChild(img);

    const bar = document.createElement("div");
    bar.className = "stcb-gallery-bar";

    if (items.length > 1) {
        bar.appendChild(
            makeNavButton("‹", () => {
                setSlotState(message, slotId, {
                    index: (index - 1 + items.length) % items.length,
                });
                rerender();
            }),
        );
        const count = document.createElement("span");
        count.className = "stcb-count";
        count.textContent = `${index + 1}/${items.length}`;
        bar.appendChild(count);
        bar.appendChild(
            makeNavButton("›", () => {
                setSlotState(message, slotId, { index: (index + 1) % items.length });
                rerender();
            }),
        );
    }

    bar.appendChild(
        makeNavButton(
            "隐藏",
            () => {
                setSlotState(message, slotId, { hidden: true });
                rerender();
            },
            "stcb-hide-btn",
        ),
    );

    box.appendChild(bar);
}

/**
 * 把存储的图片渲染到消息里。
 * 每次消息重渲染都会重建容器，所以天然幂等，不会重复插入。
 *
 * 归位规则：图片带着生成它的插槽 slotId，渲染时按 slotId 放回对应插槽。
 * **找不到归属的图片不再显示**（提示词被改过、标记被删了都会导致这种情况），
 * 想彻底清掉可以用扩展设置里的「清理孤立图片」。
 */
function renderStcbMedia(messageElement, message) {
    const host = resolveMessageElement(messageElement);
    if (!host) return;

    // 先清空所有旧容器（插槽内的 + 消息末尾的）
    host.querySelectorAll(".stcb-media").forEach((el) => {
        el.innerHTML = "";
    });
    host.querySelector(".stcb-media-bottom")?.remove();

    const list = message?.extra?.stcb_media;
    if (!Array.isArray(list) || list.length === 0) return;

    const live = liveSlotIds(host);
    const groups = new Map();
    let orphanCount = 0;

    for (const item of list) {
        if (!item?.url) continue;
        if (!item.slotId || !live.has(item.slotId)) {
            orphanCount++;
            continue;
        }
        if (!groups.has(item.slotId)) groups.set(item.slotId, []);
        groups.get(item.slotId).push(item);
    }

    const position = getSettings().mediaPosition;

    if (position === "inline") {
        host.querySelectorAll(".stcb-slot").forEach((slot) => {
            const id = slot.dataset.slotId;
            const box = slot.querySelector(".stcb-media");
            if (id && box) {
                renderSlotGallery(box, groups.get(id) ?? [], message, id, host);
            }
        });
    } else {
        // bottom 模式：有归属的图都堆到消息末尾
        const all = [];
        for (const items of groups.values()) all.push(...items);
        if (all.length > 0) {
            const box = document.createElement("div");
            box.className = "stcb-media stcb-media-bottom";
            const parent = host.querySelector(".mes_text")?.parentElement;
            (parent ?? host).appendChild(box);
            all.forEach((item, i) => {
                const img = document.createElement("img");
                img.className = "stcb-media-img";
                img.src = item.url;
                img.alt = "生成的图片";
                img.title = "点击放大（可左右切换）";
                img.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openLightbox(all, i);
                });
                box.appendChild(img);
            });
        }
    }

    if (orphanCount > 0) {
        log(
            `有 ${orphanCount} 张图片找不到归属的插槽（提示词被改过？）已隐藏；` +
                `可在扩展设置里点「清理孤立图片」删除`,
        );
    }
}

/* ------------------------------------------------------------------ *
 * 扫描消息
 * ------------------------------------------------------------------ */

/**
 * 把一个文本节点里所有 image###...### 替换成按钮。
 * 用 DocumentFragment 一次性换掉，避免边遍历边改 DOM 的麻烦。
 */
function replaceMarkedInTextNode(node, messageElement) {
    const { startTag, endTag } = getSettings();
    const parts = splitByMarkers(node.nodeValue ?? "", startTag, endTag);
    if (!parts) return;

    const frag = document.createDocumentFragment();
    for (const part of parts) {
        frag.appendChild(
            part.type === "prompt"
                ? createGenSlot(part.value, messageElement)
                : document.createTextNode(part.value),
        );
    }
    node.parentNode?.replaceChild(frag, node);
}

/** 扫描裸文本里的触发标记 */
function processTextNodes(textEl, messageElement) {
    const { startTag } = getSettings();
    if (!startTag) return;

    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
        if (!node.nodeValue?.includes(startTag)) continue;
        // 别动我们自己生成的按钮里的文字
        if (node.parentElement?.closest(".stcb-gen-button")) continue;
        targets.push(node);
    }
    for (const target of targets) {
        replaceMarkedInTextNode(target, messageElement);
    }
}

/** 扫描代码块 */
function processCodeBlocks(textEl, messageElement) {
    const { startTag, endTag } = getSettings();
    const langs = activeLangs();

    for (const pre of textEl.querySelectorAll("pre")) {
        const code = pre.querySelector("code") ?? pre;
        const content = codeBlockText(code);
        if (!content) continue;

        // 优先：代码块里写了标记，取标记之间的内容
        const marked = extractMarked(content, startTag, endTag);
        if (marked) {
            pre.replaceWith(createGenSlot(marked, messageElement));
            continue;
        }

        // 其次：代码块的语言标记匹配
        if (matchesLang(`${pre.className ?? ""} ${code.className ?? ""}`, langs)) {
            pre.replaceWith(createGenSlot(content, messageElement));
        }
    }
}

function processMessage(messageElement) {
    if (!messageElement) return;
    const textEl = messageElement.querySelector(".mes_text");
    if (!textEl) return;

    processCodeBlocks(textEl, messageElement);
    processTextNodes(textEl, messageElement);

    // 消息重渲染后，把自定义存储的图片补回来
    try {
        renderStcbMedia(messageElement, getMessageByElement(messageElement));
    } catch (e) {
        warn("补渲染图片失败", e);
    }
}

function processMessageById(messageId) {
    const el = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (el) processMessage(el);
}

function processAllMessages() {
    document.querySelectorAll(".mes").forEach((el) => processMessage(el));
}

/* ------------------------------------------------------------------ *
 * 清理孤立图片
 * ------------------------------------------------------------------ */

/**
 * 扫描整个聊天，删掉已经没有归属的图片。
 *
 * 「没有归属」= 图片的 slotId 不在这条消息当前应有的插槽 ID 集合里，
 * 通常是提示词被改过、或者标记被删掉了。
 * 判断基于 message.mes 的原始文本，所以不用等消息渲染出来。
 */
async function cleanupOrphans() {
    const context = ctx();
    const { startTag, endTag } = getSettings();
    const langs = activeLangs();

    let scannedMessages = 0;
    let removedImages = 0;
    let touchedMessages = 0;

    for (const message of context.chat ?? []) {
        const list = message?.extra?.stcb_media;
        if (!Array.isArray(list) || list.length === 0) continue;

        scannedMessages++;
        const valid = expectedSlotIds(message.mes ?? "", startTag, endTag, langs);

        const kept = list.filter((item) => item?.slotId && valid.has(item.slotId));
        const removed = list.length - kept.length;

        if (removed > 0) {
            removedImages += removed;
            touchedMessages++;
            if (kept.length === 0) {
                delete message.extra.stcb_media;
            } else {
                message.extra.stcb_media = kept;
            }
        }

        // 顺带清掉失效的插槽状态
        const states = message.extra?.stcb_slot_state;
        if (states && typeof states === "object") {
            for (const key of Object.keys(states)) {
                if (!valid.has(key)) delete states[key];
            }
        }
    }

    if (touchedMessages > 0) {
        await context.saveChat?.();
        processAllMessages();
    }

    log(`清理完成：扫描 ${scannedMessages} 条消息，删除 ${removedImages} 张孤立图片`);
    return { scannedMessages, removedImages };
}

/* ------------------------------------------------------------------ *
 * 把旧图片迁移到酒馆托管
 *
 * 有两种"旧"图片需要迁：
 *   ① data:image/png;base64,...            —— 最早的内联图片
 *   ② http://127.0.0.1:8765/images/xxx     —— 桥接服务托管的
 * 迁完都变成 /user/images/stcb/xxx.png，由酒馆托管。
 *
 * ⚠️ 迁 ② 的时候要能把原图取回来，所以**桥接服务必须开着**。
 * ------------------------------------------------------------------ */

/** 这个地址需要迁移吗？（已经是酒馆托管的相对路径就不用） */
function needsMigration(url) {
    if (typeof url !== "string" || !url) return false;
    return url.startsWith("data:") || /^https?:\/\//i.test(url);
}

/** 把任意图片地址转成 data URL */
async function toDataUrl(url) {
    if (url.startsWith("data:")) return url;

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`取原图失败：HTTP ${res.status}（旧图由桥接服务托管，需要先把它开起来）`);
    }
    const blob = await res.blob();

    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取图片数据失败"));
        reader.readAsDataURL(blob);
    });
}

/** 数一数聊天里还剩多少张需要迁移的图片 */
function countMigratableImages() {
    let count = 0;
    for (const message of ctx().chat ?? []) {
        const list = message?.extra?.stcb_media;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (needsMigration(item?.url)) count++;
        }
    }
    return count;
}

/**
 * 把所有旧图片迁移到酒馆托管。
 * 单张失败不影响其他，原样保留（不会丢图）。
 *
 * @param {(done: number, total: number) => void} [onProgress]
 */
async function migrateImages(onProgress) {
    const context = ctx();
    const chat = context.chat ?? [];

    const jobs = [];
    for (let i = 0; i < chat.length; i++) {
        const list = chat[i]?.extra?.stcb_media;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (needsMigration(item?.url)) jobs.push({ messageId: i, item });
        }
    }

    let done = 0;
    let failed = 0;
    const touched = new Set();

    for (const job of jobs) {
        try {
            const dataUrl = await toDataUrl(job.item.url);
            const filename = `${Date.now()}-${String(job.item.slotId || "img").replace(/^stcb-id-/, "")}`;
            const path = await uploadImageToTavern(dataUrl, filename);

            // 成功才替换，失败就保持原样，不会丢图
            job.item.url = path;
            touched.add(job.messageId);
            done++;
        } catch (e) {
            err("迁移一张图片失败", e);
            failed++;
        }
        onProgress?.(done + failed, jobs.length);
    }

    if (done > 0) {
        await context.saveChat?.();
        // 只重绘图片区，不动正文
        for (const id of touched) {
            const el = document.querySelector(`.mes[mesid="${id}"]`);
            if (el) renderStcbMedia(el, chat[id]);
        }
    }

    log(`图片迁移完成：成功 ${done}，失败 ${failed}，共 ${jobs.length}`);
    return { total: jobs.length, done, failed };
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

async function renderSettings() {
    const context = ctx();
    let html;
    try {
        html = await context.renderExtensionTemplateAsync(
            `third-party/${MODULE_NAME}`,
            "settings",
        );
    } catch (e) {
        err("加载设置模板失败", e);
        return;
    }

    const host = document.querySelector("#extensions_settings2");
    if (!host) {
        warn("找不到设置面板容器 #extensions_settings2");
        return;
    }
    host.insertAdjacentHTML("beforeend", html);

    const s = getSettings();

    const urlInput = document.querySelector("#stcb_bridge_url");
    urlInput.value = s.bridgeUrl;
    urlInput.addEventListener("input", () => {
        s.bridgeUrl = urlInput.value.trim();
        saveSettings();
        setStatus("未检查", "");
    });

    const startInput = document.querySelector("#stcb_start_tag");
    startInput.value = s.startTag;
    startInput.addEventListener("input", () => {
        s.startTag = startInput.value;
        saveSettings();
        processAllMessages();
    });

    const endInput = document.querySelector("#stcb_end_tag");
    endInput.value = s.endTag;
    endInput.addEventListener("input", () => {
        s.endTag = endInput.value;
        saveSettings();
        processAllMessages();
    });

    const langInput = document.querySelector("#stcb_code_langs");
    langInput.value = s.codeLangs;
    langInput.addEventListener("input", () => {
        s.codeLangs = langInput.value;
        saveSettings();
        processAllMessages();
    });

    const confirmBox = document.querySelector("#stcb_confirm");
    confirmBox.checked = Boolean(s.confirmBeforeSend);
    confirmBox.addEventListener("change", () => {
        s.confirmBeforeSend = confirmBox.checked;
        saveSettings();
    });

    const maxQueueInput = document.querySelector("#stcb_max_queue");
    maxQueueInput.value = String(s.maxQueue ?? 5);
    maxQueueInput.addEventListener("change", () => {
        const n = Number(maxQueueInput.value);
        s.maxQueue = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
        maxQueueInput.value = String(s.maxQueue);
        saveSettings();
    });

    const attachSelect = document.querySelector("#stcb_attach_mode");
    attachSelect.value = s.attachMode;
    attachSelect.addEventListener("change", () => {
        s.attachMode = attachSelect.value;
        saveSettings();
    });

    const posSelect = document.querySelector("#stcb_media_position");
    posSelect.value = s.mediaPosition;
    posSelect.addEventListener("change", () => {
        s.mediaPosition = posSelect.value;
        saveSettings();
        processAllMessages();
    });

    document.querySelector("#stcb_check_btn").addEventListener("click", async () => {
        setStatus("检查中…", "");
        try {
            const st = await checkBridge();
            if (st.comfy_page) {
                setStatus(
                    `已连通${st.current_workflow ? " · " + st.current_workflow : ""}`,
                    "ok",
                );
            } else {
                setStatus("桥接服务在，但 ComfyUI 页面没连上", "warn");
            }
        } catch (e) {
            setStatus(`连不上：${e.message}`, "err");
        }
    });

    document.querySelector("#stcb_cleanup_btn").addEventListener("click", async () => {
        const label = document.querySelector("#stcb_cleanup_text");
        const setCleanup = (text, kind = "") => {
            if (!label) return;
            label.textContent = text;
            label.dataset.kind = kind;
        };
        setCleanup("清理中…");
        try {
            const { scannedMessages, removedImages } = await cleanupOrphans();
            if (removedImages > 0) {
                setCleanup(`已删除 ${removedImages} 张（扫描 ${scannedMessages} 条消息）`, "ok");
                toast("success", `已清理 ${removedImages} 张孤立图片`);
            } else {
                setCleanup(`没有孤立图片（扫描 ${scannedMessages} 条消息）`, "");
            }
        } catch (e) {
            err("清理失败", e);
            setCleanup(`失败：${e.message}`, "err");
        }
    });

    document.querySelector("#stcb_flatten_btn").addEventListener("click", async () => {
        const label = document.querySelector("#stcb_flatten_text");
        const setText = (text, kind = "") => {
            if (!label) return;
            label.textContent = text;
            label.dataset.kind = kind;
        };
        setText("处理中…");
        try {
            const changed = await normalizeAllMessages();
            processAllMessages();
            if (changed > 0) {
                setText(`已修复 ${changed} 条消息`, "ok");
                toast("success", `已修复 ${changed} 条消息的标记换行`);
            } else {
                setText("没有需要修复的消息", "");
            }
        } catch (e) {
            err("修复失败", e);
            setText(`失败：${e.message}`, "err");
        }
    });

    document.querySelector("#stcb_migrate_btn").addEventListener("click", async () => {
        const label = document.querySelector("#stcb_migrate_text");
        const setText = (text, kind = "") => {
            if (!label) return;
            label.textContent = text;
            label.dataset.kind = kind;
        };

        const pending = countMigratableImages();
        if (pending === 0) {
            setText("没有需要迁移的图片", "");
            return;
        }

        const ok = globalThis.confirm(
            `找到 ${pending} 张旧图片，将迁移到酒馆自己的图片目录。\n\n` +
                "迁移后：\n" +
                "· 看这些图不再需要桥接服务\n" +
                "· 图片跟着酒馆数据一起备份\n\n" +
                "注意：如果里面有旧版桥接服务托管的图，\n" +
                "迁移时要把桥接服务开着才能取回原图。\n\n继续吗？",
        );
        if (!ok) {
            setText("已取消", "");
            return;
        }

        setText(`迁移中… 0/${pending}`);
        try {
            const { total, done, failed } = await migrateImages((n, t) => {
                setText(`迁移中… ${n}/${t}`);
            });
            if (failed === 0) {
                setText(`完成，已迁移 ${done} 张`, "ok");
                toast("success", `已迁移 ${done} 张图片到酒馆`);
            } else {
                setText(`完成：成功 ${done}，失败 ${failed}`, done === 0 ? "err" : "warn");
                toast("warning", `迁移完成：成功 ${done}，失败 ${failed}`);
            }
            log(`迁移结果：共 ${total}，成功 ${done}，失败 ${failed}`);
        } catch (e) {
            err("迁移失败", e);
            setText(`失败：${e.message}`, "err");
        }
    });
}

function setStatus(text, kind) {
    const el = document.querySelector("#stcb_status_text");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || "";
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 扫描调度
 *
 * 只挂 CHARACTER_MESSAGE_RENDERED 不够用 —— 那个事件触发时，
 * 消息的 DOM 往往还没渲染完，扫描自然扫不到东西。
 * st-chatu8 的做法是在 GENERATION_ENDED 上处理，并延迟再补一次，
 * 这里照做，另外加一个 DOM 监听兜底。
 * ------------------------------------------------------------------ */

function scheduleScan(delays = [0, 120, 400]) {
    for (const delay of delays) {
        setTimeout(() => {
            try {
                processAllMessages();
            } catch (e) {
                err("扫描消息失败", e);
            }
        }, delay);
    }
}

let scanTimer = null;

/** 只有还存在"没被替换的标记文本"时才需要重扫 */
function hasPendingWork() {
    const { startTag } = getSettings();
    if (!startTag) return false;
    for (const el of document.querySelectorAll(".mes_text")) {
        if (el.textContent?.includes(startTag)) return true;
    }
    return false;
}

function setupChatObserver() {
    const chat = document.getElementById("chat");
    if (!chat) {
        warn("找不到 #chat，跳过 DOM 监听（事件驱动的扫描仍然有效）");
        return;
    }

    const observer = new MutationObserver(() => {
        // 只处理"确实有活干"的情况。
        // 否则我们自己改 DOM 会再次触发这个回调，形成死循环。
        if (!hasPendingWork() || scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            try {
                processAllMessages();
            } catch (e) {
                err("扫描消息失败", e);
            }
        }, 250);
    });

    observer.observe(chat, { childList: true, subtree: true });
    log("已挂上聊天区 DOM 监听");
}

/* ------------------------------------------------------------------ *
 * 重新渲染一条消息
 *
 * ⚠️ 不要用 context.updateMessageBlock —— 它内部是：
 *
 *     messageFormatting(text, ..., messageId, {}, false)
 *                                          ↑ 空的净化器覆盖
 *
 * 而 ST 正常渲染走的是 getMessageTextHTML，会带上
 * `{ MESSAGE_ALLOW_SYSTEM_UI: true }`（当消息有 extra.uses_system_ui 时）。
 * 用 updateMessageBlock 重绘会把这类标签洗掉 —— 表现为状态栏/HTML 块
 * 变成一堆源码，而"手动编辑再保存"又能恢复正常。
 *
 * 所以这里用 ST 自己的 updateMessageElement（它内部走 getMessageTextHTML）。
 * 拿不到就退回不重绘：新消息本来就会在事件之后正常渲染，不影响。
 * ------------------------------------------------------------------ */

let updateElementFn; // undefined = 还没查过；null = 查过但不可用

async function loadUpdateMessageElement() {
    if (updateElementFn !== undefined) return updateElementFn;
    try {
        const mod = await import("../../../script.js");
        updateElementFn =
            typeof mod?.updateMessageElement === "function" ? mod.updateMessageElement : null;
        if (!updateElementFn) {
            warn("script.js 里没有 updateMessageElement，将不主动重绘消息");
        }
    } catch (e) {
        warn("拿不到 updateMessageElement，将不主动重绘消息", e);
        updateElementFn = null;
    }
    return updateElementFn;
}

/**
 * 按 ST 的正常渲染路径重绘一条消息。
 * @returns {Promise<boolean>} 是否真的重绘了
 */
async function reRenderMessage(messageId, message) {
    const fn = await loadUpdateMessageElement();
    if (!fn) return false;

    const el = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!el) return false; // 还没渲染出来，交给 ST 自己渲染即可

    try {
        fn(message, { messageId, messageElement: jQuery(el) });
        return true;
    } catch (e) {
        warn("重绘消息失败", e);
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * 渲染前压平标记内的换行
 *
 * 为什么必须改 message.mes：
 * Markdown 会把**行首**的 ### 当成三级标题。于是
 *
 *     image###1girl, solo
 *     ###
 *
 * 会被渲染成 <p>image###1girl, solo</p><h3></h3> ——
 * 标记被拆到两个元素里，而且 ### 这三个字符被当成语法吃掉了，
 * DOM 里根本没有它们，解析自然找不到。
 *
 * 所以必须在渲染之前改掉。这和 st-chatu8 的「换行修复」是同一个思路。
 *
 * 副作用说明：这会改到实际存下来的消息内容，也就影响下一轮发给 AI 的文本。
 * 但用户本来就会用正则把 image###...### 整段剔掉（省 token），所以没有影响。
 * ------------------------------------------------------------------ */

/**
 * 压平一条消息里的标记换行。
 * @returns {Promise<boolean>} 是否改动过
 */
async function normalizeMessageMarkers(id) {
    try {
        const context = ctx();
        const message = context.chat?.[id];
        if (!message || typeof message.mes !== "string") return false;

        const { startTag, endTag } = getSettings();
        const after = flattenMarkers(message.mes, startTag, endTag);
        if (after === message.mes) return false;

        message.mes = after;
        await context.saveChat?.();
        // 可能已经渲染过了，按正常渲染路径重画一遍
        await reRenderMessage(id, message);
        log(`消息 ${id} 的标记换行已压平`);
        return true;
    } catch (e) {
        err("压平标记失败", e);
        return false;
    }
}

/**
 * 把聊天里所有历史消息都过一遍。
 * 用于处理之前已经存下来的、带着换行的消息。
 */
async function normalizeAllMessages() {
    try {
        const context = ctx();
        const chat = context.chat ?? [];
        const { startTag, endTag } = getSettings();
        if (!startTag || !endTag) return 0;

        const changedIds = [];
        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];
            if (typeof message?.mes !== "string" || !message.mes.includes(startTag)) {
                continue;
            }
            const after = flattenMarkers(message.mes, startTag, endTag);
            if (after !== message.mes) {
                message.mes = after;
                changedIds.push(i);
            }
        }

        if (changedIds.length === 0) return 0;

        await context.saveChat?.();
        for (const id of changedIds) {
            await reRenderMessage(id, chat[id]);
        }
        log(`已压平 ${changedIds.length} 条历史消息里的标记换行`);
        return changedIds.length;
    } catch (e) {
        err("批量压平失败", e);
        return 0;
    }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

jQuery(async () => {
    try {
        const context = ctx();
        await renderSettings();

        const t = context.event_types;
        const on = (name, handler) => {
            if (name && context.eventSource?.on) {
                context.eventSource.on(name, handler);
            }
        };

        on(t.CHARACTER_MESSAGE_RENDERED, processMessageById);
        on(t.USER_MESSAGE_RENDERED, processMessageById);

        // 新消息一进来就把标记里的换行压平 —— 必须在渲染之前，
        // 否则 Markdown 已经把行首的 ### 当标题吃掉了。
        on(t.MESSAGE_RECEIVED, (id) => {
            void normalizeMessageMarkers(id);
        });

        // 生成刚结束时消息可能还在渲染，多补几次
        on(t.GENERATION_ENDED, () => scheduleScan([0, 120, 400]));
        on(t.MESSAGE_SWIPED, () => scheduleScan([80, 300]));

        // 换聊天时把历史消息也过一遍（处理之前存下来的、带换行的消息）
        on(t.CHAT_CHANGED, () => {
            void normalizeAllMessages().then(() => scheduleScan([100, 500]));
        });

        // 编辑过的消息也可能引入换行
        on(t.MESSAGE_EDITED, (id) => {
            void normalizeMessageMarkers(id).then(() => {
                setTimeout(() => processMessageById(id), 80);
            });
        });

        setupChatObserver();

        // 首次加载：先修历史消息，再扫描
        void normalizeAllMessages().then(() => scheduleScan([300]));

        log("扩展已加载");
    } catch (e) {
        err("扩展初始化失败", e);
    }
});
