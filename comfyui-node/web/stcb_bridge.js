/**
 * STCB Bridge — ComfyUI 侧前端脚本
 *
 * 由 ComfyUI 节点包通过 WEB_DIRECTORY 自动注入页面。
 *
 * 职责：接收桥接服务下发的任务，用「当前打开的工作流」生成图片并回传。
 *
 * 核心思路：
 *   app.graphToPrompt() 拿到当前图的 { workflow(UI格式), output(API格式) }
 *   → 在 output 上注入正面提示词 → api.queuePrompt(0, {output, workflow}) 排队
 *
 * 之所以不需要任何格式转换，是因为 ComfyUI 前端自己就是权威的转换器。
 * 之所以不需要保存工作流，是因为 graphToPrompt 读的是画布内存状态而非磁盘文件
 * （ComfyUI 自己的 Queue 按钮走的就是同一条路）。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { findPromptNodesByClass, PROMPT_NODE_TYPE } from "./stcb_locate.js";

// 注：stcb_locate.js 里还留着 findPositiveTextNodeIds（从采样器 positive 反向追溯）。
// 现在的主路径改用「酒馆提示词」节点了，不再调用它；
// 保留是为了万一需要回退，它的测试也仍在跑。

const TAG = "[STCB]";
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8765/ws";
const SETTING_ID = "STCB.BridgeUrl";

function log(...args) {
  console.log(TAG, ...args);
}
function warn(...args) {
  console.warn(TAG, ...args);
}
function err(...args) {
  console.error(TAG, ...args);
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

function getBridgeUrl() {
  try {
    const v = app?.ui?.settings?.getSettingValue?.(SETTING_ID);
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch (_) {
    /* 设置系统不可用时静默回退 */
  }
  return DEFAULT_BRIDGE_URL;
}

function registerSettings() {
  try {
    if (!app?.ui?.settings?.addSetting) return;
    app.ui.settings.addSetting({
      id: SETTING_ID,
      name: "桥接服务地址",
      tooltip: "STCB 桥接服务的 WebSocket 地址。默认 ws://127.0.0.1:8765/ws",
      type: "text",
      defaultValue: DEFAULT_BRIDGE_URL,
    });
  } catch (e) {
    warn("注册设置项失败（不影响使用）:", e);
  }
}

/** 尽力获取当前打开的工作流名，取不到就返回 null */
function getCurrentWorkflowName() {
  const candidates = [
    () => app?.workflowManager?.activeWorkflow?.filename,
    () => app?.workflowManager?.activeWorkflow?.name,
    () => app?.extensionManager?.workflow?.activeWorkflow?.filename,
  ];
  for (const fn of candidates) {
    try {
      const v = fn();
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch (_) {
      /* 换下一个候选 */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 正面提示词节点的定位
 *
 * 具体算法在 stcb_locate.js 里（抽出来是为了能脱离 ComfyUI 环境跑测试）。
 * 回退链：标题标记 → 从采样器 positive 反向追溯 → 第一个 CLIPTextEncode
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 取图
 * ------------------------------------------------------------------ */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageAsBase64(imageInfo) {
  const params = new URLSearchParams({
    filename: imageInfo.filename ?? "",
    subfolder: imageInfo.subfolder ?? "",
    type: imageInfo.type ?? "output",
  });
  // apiURL 会拼成与 ComfyUI 页面同源的地址，因此不受跨域限制
  const url = api.apiURL(`/view?${params.toString()}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`取图失败：HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return { base64: await blobToBase64(blob), format: blob.type || "image/png" };
}

/* ------------------------------------------------------------------ *
 * 执行：排队 + 等待结果
 * ------------------------------------------------------------------ */

function describeExecError(detail) {
  return (
    detail?.exception_message ||
    detail?.exception_type ||
    "ComfyUI 执行失败"
  );
}

/** 把 PromptExecutionError 之类的异常转成人话 */
function toFriendlyError(e) {
  const resp = e?.response;
  if (resp) {
    const msg = resp?.error?.message ?? "排队被 ComfyUI 拒绝";
    const nodeErrors = resp?.node_errors;
    const extra =
      nodeErrors && Object.keys(nodeErrors).length
        ? " 详情：" + JSON.stringify(nodeErrors).slice(0, 500)
        : "";
    return new Error(msg + extra);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** 任务被取消时抛这个，调用方据此区分「失败」和「取消」 */
class CancelledError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

/**
 * 提交并等待执行结束，返回 { promise, cancel }。
 *
 * 注意三件事：
 *   1. api.queuePrompt 失败时是「抛异常」（PromptExecutionError），不是返回 error 字段
 *   2. 监听必须先于排队注册，否则可能漏掉事件；但 prompt_id 要等排队返回才知道，
 *      所以 prompt_id 未知期间到达的事件先缓冲，拿到 id 后再回放
 *   3. 每次调用都有自己的监听器和 prompt_id 过滤，所以**多个任务可以并行等待** ——
 *      这正是队列功能的基础
 *
 * @param {object} hooks
 * @param {(promptId: string) => void} [hooks.onQueued] 拿到 prompt_id 时回调
 * @returns {{ promise: Promise<any[]>, cancel: () => void }}
 */
function queueAndWait(output, workflow, hooks = {}) {
  let cancelFn = null;

  const promise = new Promise((resolve, reject) => {
    const images = [];
    const early = []; // prompt_id 已知之前到达的事件
    let promptId = null;
    let settled = false;

    const cleanup = () => {
      api.removeEventListener("executed", onExecuted);
      api.removeEventListener("execution_success", onSuccess);
      api.removeEventListener("execution_error", onError);
    };

    const settle = (fn, payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(payload);
    };

    // 供外部取消用：被删掉的任务不会再有任何事件，必须主动落地
    cancelFn = () => settle(reject, new CancelledError());

    const consumeExecuted = (detail) => {
      const out = detail?.output?.images;
      if (Array.isArray(out) && out.length > 0) {
        images.push(...out);
      }
    };

    /** 返回 true 表示这个事件已经让整个 Promise 落地了 */
    const consume = (kind, detail) => {
      if (kind === "executed") {
        consumeExecuted(detail);
      } else if (kind === "success") {
        settle(resolve, images);
        return true;
      } else {
        settle(reject, new Error(describeExecError(detail)));
        return true;
      }
      return false;
    };

    const onExecuted = (event) => {
      const detail = event?.detail;
      if (!detail) return;
      if (promptId === null) {
        early.push({ kind: "executed", detail });
        return;
      }
      if (detail.prompt_id !== promptId) return;
      consumeExecuted(detail);
    };

    const onSuccess = (event) => {
      const detail = event?.detail;
      if (!detail) return;
      if (promptId === null) {
        early.push({ kind: "success", detail });
        return;
      }
      if (detail.prompt_id !== promptId) return;
      settle(resolve, images);
    };

    const onError = (event) => {
      const detail = event?.detail;
      if (!detail) return;
      if (promptId === null) {
        early.push({ kind: "error", detail });
        return;
      }
      if (detail.prompt_id !== promptId) return;
      settle(reject, new Error(describeExecError(detail)));
    };

    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_success", onSuccess);
    api.addEventListener("execution_error", onError);

    api
      .queuePrompt(0, { output, workflow })
      .then((res) => {
        if (settled) return; // 排队期间就被取消了
        promptId = res?.prompt_id ?? null;
        if (!promptId) {
          settle(reject, new Error("排队成功但没拿到 prompt_id"));
          return;
        }
        log("已排队，prompt_id =", promptId);
        hooks.onQueued?.(promptId);

        // 排队成功后跑 afterQueued —— 种子随机化默认就发生在这里。
        // 时序和 ComfyUI 一致：本次跑用当前种子，跑完换成新种子给下一次。
        runAfterQueuedCallbacks();

        // 回放缓冲的事件（按到达顺序，executed 必然在 success 之前）
        for (const item of early) {
          if (item.detail?.prompt_id !== promptId) continue;
          if (consume(item.kind, item.detail)) return;
        }
        early.length = 0;
      })
      .catch((e) => settle(reject, toFriendlyError(e)));
  });

  return { promise, cancel: () => cancelFn?.() };
}

/* ------------------------------------------------------------------ *
 * 排队前后的 widget 回调
 *
 * ComfyUI 的种子「每次生成随机化」不是写死在种子控件上的，
 * 而是挂在同节点的 control_after_generate 控件上（frontend 的 widgets.ts）：
 *
 *   function controlValueRunBefore() {
 *     return settingStore.get('Comfy.WidgetControlMode') === 'before'
 *   }
 *   valueControl.beforeQueued = () => {
 *     if (controlValueRunBefore()) { ...applyWidgetControl() }
 *   }
 *   valueControl.afterQueued = () => {
 *     if (!controlValueRunBefore()) { applyWidgetControl() }   // ← 默认走这条
 *   }
 *
 * 也就是说：**默认情况下随机化发生在「排队之后」**，
 * 本次跑用当前种子，跑完才换成新种子给下一次。
 *
 * app.queuePrompt 会依次调用 beforeQueued（排队前）和 afterQueued（排队后）。
 * 我们绕过了 app.queuePrompt，所以两个都得自己补上 ——
 * 只补 beforeQueued 是不够的，那正是「每次出图都一样」的原因。
 * ------------------------------------------------------------------ */

function forEachNode(graph, fn) {
  if (!graph) return;
  const nodes = graph.nodes ?? graph._nodes ?? [];
  for (const node of nodes) {
    try {
      if (node?.isSubgraphNode?.call(node) && node.subgraph) {
        forEachNode(node.subgraph, fn);
      }
    } catch (_) {
      /* 子图遍历失败不影响主图 */
    }
    fn(node);
  }
}

function runWidgetCallback(name, when) {
  let count = 0;
  try {
    forEachNode(app?.rootGraph, (node) => {
      for (const widget of node.widgets ?? []) {
        if (typeof widget?.[name] === "function") {
          widget[name]({ isPartialExecution: false });
          count++;
        }
      }
    });
  } catch (e) {
    warn(`执行 ${name} 回调时出错（继续）:`, e);
  }
  if (count > 0) {
    log(`${when}：已执行 ${count} 个 ${name} 回调`);
  }
  return count;
}

/** 排队前跑（对应 app.queuePrompt 里的 beforeQueued 循环） */
function runBeforeQueuedCallbacks() {
  return runWidgetCallback("beforeQueued", "排队前");
}

/** 排队后跑 —— 种子随机化默认就发生在这里 */
function runAfterQueuedCallbacks() {
  return runWidgetCallback("afterQueued", "排队后");
}

/* ------------------------------------------------------------------ *
 * 单个任务的处理
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 并发与队列
 *
 * ComfyUI 自带队列（api.queuePrompt 就是往它里面塞），会按 FIFO 顺序执行。
 * 所以我们不需要自己实现队列，只要：
 *   · 去掉原来「一次只跑一个」的限制
 *   · 保证「写提示词 → 序列化工作流」这一段是串行的（否则会串图）
 *   · 每个任务各自等自己的 prompt_id（queueAndWait 本来就支持）
 * ------------------------------------------------------------------ */

/** 正在进行的任务：task_id → { promptId, state, cancel, cancelled, finished } */
const running = new Map();

/** 心跳间隔：给桥接服务的「无进展超时」续命，排队再久也不会被误判超时 */
const HEARTBEAT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 注入锁。
 *
 * 「写 widget」和「graphToPrompt」必须原子，否则两个任务交错时会串图：
 *
 *   任务A: 写 widget="A" ─────────────┐
 *   任务B:          写 widget="B" ──┐  │
 *   任务A:                          └──┴─→ graphToPrompt() ← 拿到 "B" ✗
 *
 * graphToPrompt 返回的是**独立的序列化副本**，之后 widget 再被改也不影响它，
 * 所以只要这一段是原子的，后面的执行完全可以并行。
 */
let injectLock = Promise.resolve();

function withInjectLock(fn) {
  const run = injectLock.then(fn, fn);
  injectLock = run.catch(() => {}); // 失败不能卡死后面的任务
  return run;
}

/** 把提示词写进节点并取回序列化结果 —— 全程持有注入锁 */
function injectAndSerialize(prompt) {
  return withInjectLock(async () => {
    const liveNodes = findLivePromptNodes();
    if (liveNodes.length === 0) {
      throw new Error(
        "当前工作流里没有找到「酒馆提示词」节点。\n" +
          "请在 ComfyUI 节点菜单里搜索「酒馆提示词」（分类 STCB）添加一个，" +
          "把它的输出接到你的字符串组合节点，或者直接接到 CLIPTextEncode 的 text 输入。",
      );
    }

    let written = 0;
    for (const node of liveNodes) {
      if (writePromptWidget(node, prompt)) written++;
    }
    if (written === 0) {
      throw new Error(
        `找到了 ${liveNodes.length} 个「酒馆提示词」节点，但都没拿到 prompt 输入框。` +
          "节点版本可能不匹配，试试重装节点包。",
      );
    }
    redrawCanvas();

    // 和 app.queuePrompt 的顺序保持一致：先 beforeQueued，再取图
    runBeforeQueuedCallbacks();
    const { workflow, output } = await app.graphToPrompt();

    // 被旁路（Bypass）/静音（Mute）的节点不会出现在 API 格式里
    if (findPromptNodesByClass(output).length === 0) {
      throw new Error(
        "「酒馆提示词」节点存在，但没出现在待执行的工作流里。\n" +
          "多半是被旁路（Bypass）或静音（Mute）了，或者它的下游没连到输出节点。",
      );
    }

    return { workflow, output };
  });
}

/**
 * 从 ComfyUI 队列里删掉一个任务。
 *
 * 用 POST /queue 的 delete —— 不管它排在第几位都能删掉。
 * 这里**不调 interrupt**：按设计「开始生成」之后就不允许取消了。
 */
async function removeFromQueue(promptId) {
  try {
    const res = await fetch("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
    if (!res.ok) {
      warn(`从 ComfyUI 队列删除失败：HTTP ${res.status}`);
    } else {
      log("已从 ComfyUI 队列删除", promptId);
    }
  } catch (e) {
    warn("从 ComfyUI 队列删除时出错", e);
  }
}

/**
 * 取消一个**排队中**的任务。
 * 已经开始生成的不允许取消。
 *
 * @returns {Promise<boolean>} 是否受理
 */
async function cancelRunningTask(taskId) {
  const entry = running.get(taskId);
  if (!entry || entry.cancelled || entry.finished) return false;
  if (entry.state !== "queued") return false; // 生成中不给取消

  entry.cancelled = true;

  // prompt_id 要等排队返回才有，稍等一下（最多 5 秒）
  for (let i = 0; i < 50 && !entry.promptId && !entry.finished; i++) {
    await sleep(100);
  }
  if (entry.finished) return true;

  // 等待期间可能已经开跑了，再确认一次
  if (entry.state !== "queued") {
    entry.cancelled = false;
    return false;
  }

  if (entry.promptId) {
    await removeFromQueue(entry.promptId);
  }
  // 主动让 queueAndWait 落地 —— 被删掉的任务不会再有任何事件
  entry.cancel?.();
  return true;
}

/** 在实时图里找「酒馆提示词」节点 */
function findLivePromptNodes() {
  const found = [];
  forEachNode(app?.rootGraph, (node) => {
    if (node?.type === PROMPT_NODE_TYPE) found.push(node);
  });
  return found;
}

/**
 * 把提示词写进节点的 prompt 输入框。
 *
 * 写的是**实时图上的 widget**，所以：
 *   · 界面上能直接看到当前提示词
 *   · 随后 graphToPrompt 序列化出来的 API 格式和 UI 格式天然都带上新值
 *     → 图片元数据也就自动正确，不需要额外同步
 */
function writePromptWidget(node, value) {
  const widget = (node.widgets ?? []).find((w) => w.name === "prompt");
  if (!widget) return false;

  widget.value = value;
  try {
    widget.callback?.(value);
  } catch (e) {
    warn("widget 回调出错（值已写入）:", e);
  }
  return true;
}

function redrawCanvas() {
  try {
    app?.canvas?.setDirty?.(true, true);
  } catch (_) {
    /* 重绘失败无所谓 */
  }
}

async function handleTask(task, send) {
  const taskId = task.task_id;

  // 不再有「一次只跑一个」的限制 —— 多个任务可以同时在跑。
  // 执行顺序由 ComfyUI 自己的队列保证（FIFO，和用户点的顺序一致）。
  const entry = {
    promptId: null,
    state: "queued",
    cancel: null,
    cancelled: false,
    finished: false,
  };
  running.set(taskId, entry);

  // 定期发心跳，让桥接服务的「无进展超时」重新计时。
  // 排队等很久也不会被误判超时；真的卡住（页面崩了）才会触发。
  const heartbeat = setInterval(() => {
    send({ type: "heartbeat", task_id: taskId });
  }, HEARTBEAT_MS);

  try {
    // ① 串行：写提示词 → 随机种子 → 序列化（持有注入锁）
    const { workflow, output } = await injectAndSerialize(task.prompt);

    send({ type: "progress", task_id: taskId, stage: "queued" });

    // ② 并行：提交进 ComfyUI 队列，各自等自己的 prompt_id
    const { promise, cancel } = queueAndWait(output, workflow, {
      onQueued: (promptId) => {
        entry.promptId = promptId;
      },
    });
    entry.cancel = cancel;

    // 排队期间就被取消了？补一次删除（此时 prompt_id 才刚拿到）
    if (entry.cancelled && entry.promptId) {
      await removeFromQueue(entry.promptId);
      cancel();
    }

    const images = await promise;

    if (images.length === 0) {
      throw new Error("执行完成但没有产出图片（工作流里有 SaveImage 之类的输出节点吗？）");
    }

    send({ type: "progress", task_id: taskId, stage: "fetching" });

    // 取最后一张，通常就是最终成品
    const { base64, format } = await fetchImageAsBase64(images[images.length - 1]);

    send({ type: "result", task_id: taskId, image: base64, format });
    log(`任务 ${taskId} 完成`);
  } catch (e) {
    if (e instanceof CancelledError || e?.cancelled) {
      log(`任务 ${taskId} 已取消`);
      send({ type: "cancelled", task_id: taskId });
    } else {
      err("任务失败:", e);
      send({
        type: "error",
        task_id: taskId,
        message: e?.message ? String(e.message) : String(e),
      });
    }
  } finally {
    entry.finished = true;
    clearInterval(heartbeat);
    running.delete(taskId);
  }
}

/* ------------------------------------------------------------------ *
 * 与桥接服务的连接
 * ------------------------------------------------------------------ */

let socket = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (e) {
    warn("发送失败:", e);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  // 退避，最长 15 秒
  reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
}

function connect() {
  const url = getBridgeUrl();

  try {
    socket = new WebSocket(url);
  } catch (e) {
    warn(`连接 ${url} 失败:`, e);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    log(`已连接桥接服务 ${url}`);
    reconnectDelay = 1000;
    send({
      type: "hello",
      role: "comfyui",
      workflow: getCurrentWorkflowName(),
    });
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      warn("收到无法解析的消息:", event.data);
      return;
    }

    if (msg.type === "task") {
      handleTask(msg, send);
    } else if (msg.type === "cancel") {
      // 取消请求：桥接服务已经校验过「还排在队列里」，这里再确认一次并执行
      void cancelRunningTask(msg.task_id).then((ok) => {
        if (!ok) {
          log(`取消 ${msg.task_id} 未受理（多半是已经开始生成，或已经结束）`);
        }
      });
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "query") {
      send({
        type: "hello",
        role: "comfyui",
        workflow: getCurrentWorkflowName(),
      });
    }
  };

  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose 会紧随其后，这里不重复处理
  };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 跟踪每个任务是否真的开始执行了。
 *
 * ComfyUI 的 execution_start 事件带着 prompt_id，据此把状态从「排队中」
 * 推进到「生成中」—— 这决定了按钮还能不能取消。
 */
function watchExecutionStart() {
  api.addEventListener("execution_start", (event) => {
    const pid = event?.detail?.prompt_id;
    if (!pid) return;

    for (const [taskId, entry] of running) {
      if (entry.promptId !== pid || entry.state !== "queued") continue;
      entry.state = "running";
      log(`任务 ${taskId} 开始执行，不再允许取消`);
      send({ type: "progress", task_id: taskId, stage: "running" });
    }
  });
}

app.registerExtension({
  name: "STCB.Bridge",
  async setup() {
    registerSettings();
    connect();
    watchExecutionStart();
    log("桥接脚本已加载，准备连接桥接服务");
  },
});
