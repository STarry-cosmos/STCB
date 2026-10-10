#!/usr/bin/env python3
"""
STCB Bridge — SillyTavern x ComfyUI 桥接服务

夹在酒馆和 ComfyUI 之间的一个轻量中转，职责：

  · 给酒馆扩展提供 HTTP 接口（提交任务 / 查询结果 / 查状态）
  · 给 ComfyUI 页面里的脚本提供 WebSocket 通道（下发任务 / 接收结果）
  · 维护任务队列与状态

它不碰工作流格式、不碰 ComfyUI 的 API 格式转换——
那些都由 ComfyUI 前端脚本自己做（app.graphToPrompt + api.queuePrompt）。

运行方式（推荐用 ComfyUI 自带的 Python，它已经内置 aiohttp）：

    python bridge_server.py --port 8765

如果用的是系统 Python 且没装 aiohttp：

    pip install aiohttp
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

try:
    from aiohttp import WSMsgType, web
except ImportError:  # pragma: no cover
    raise SystemExit(
        "缺少 aiohttp。请用 ComfyUI 自带的 Python 运行，或先执行：pip install aiohttp"
    )


LOG = logging.getLogger("stcb")


# --------------------------------------------------------------------------- #
# 任务
# --------------------------------------------------------------------------- #

@dataclass
class Task:
    id: str
    prompt: str
    # pending —— 刚创建，页面还没接手
    # running —— 页面已接手（看 stage 区分是排队还是真在跑）
    # done / error / cancelled
    status: str = "pending"
    # queued   —— 已提交进 ComfyUI 队列，还没轮到执行（此时可以取消）
    # running  —— 正在执行（按用户要求，不可取消）
    # fetching —— 执行完了，正在取图
    stage: str = ""
    image: Optional[str] = None      # base64，直接回传给酒馆扩展
    image_format: str = "image/png"
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @property
    def cancellable(self) -> bool:
        """只有排在队列里、还没开始执行的任务允许取消。"""
        return self.status == "running" and self.stage == "queued"

    def to_public(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "task_id": self.id,
            "status": self.status,
            "stage": self.stage,
            "cancellable": self.cancellable,
        }
        if self.status == "done":
            data["image"] = self.image
            data["format"] = self.image_format
        elif self.status in ("error", "cancelled"):
            data["error"] = self.error
        return data


# --------------------------------------------------------------------------- #
# 中枢
# --------------------------------------------------------------------------- #

class Hub:
    """维护 ComfyUI 页面连接与任务状态。"""

    def __init__(
        self,
        task_timeout: float,
        task_ttl: float,
        image_dir: Path,
    ) -> None:
        self.tasks: dict[str, Task] = {}
        self.page_ws: Optional[web.WebSocketResponse] = None
        self.page_workflow: Optional[str] = None
        self.task_timeout = task_timeout
        self.task_ttl = task_ttl
        self.image_dir = image_dir
        self._timeout_handles: dict[str, asyncio.Task] = {}

    # -- 旧图片的静态托管 -------------------------------------------------- #
    #
    # 新生成的图片已经改成由酒馆自己托管（POST /api/images/upload），
    # 桥接服务不再保存图片，只做消息中转。
    #
    # 但这里保留 /images/{name} 路由：早期版本把图存到了 image_dir，
    # 迁移那些旧图时需要能通过原 URL 取回来。
    # 全部迁完之后，这个目录和路由都可以删掉。

    # -- 页面连接 ---------------------------------------------------------- #

    @property
    def page_connected(self) -> bool:
        return self.page_ws is not None and not self.page_ws.closed

    def attach_page(self, ws: web.WebSocketResponse) -> None:
        if self.page_ws is not None and not self.page_ws.closed:
            LOG.warning("已有 ComfyUI 页面连接，新的连接将替换旧连接")
            asyncio.create_task(self.page_ws.close(code=1000, message=b"replaced"))
        self.page_ws = ws
        LOG.info("ComfyUI 页面已连接")

    def detach_page(self, ws: web.WebSocketResponse) -> None:
        if self.page_ws is ws:
            self.page_ws = None
            self.page_workflow = None
            LOG.info("ComfyUI 页面已断开")

    async def send_to_page(self, payload: dict[str, Any]) -> bool:
        if not self.page_connected:
            return False
        try:
            await self.page_ws.send_str(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception as exc:  # noqa: BLE001
            LOG.warning("向 ComfyUI 页面发送失败: %s", exc)
            return False

    # -- 任务 -------------------------------------------------------------- #

    def create_task(self, prompt: str) -> Task:
        task = Task(id=uuid.uuid4().hex[:12], prompt=prompt, status="pending")
        self.tasks[task.id] = task
        self.touch(task)
        LOG.info("新任务 %s（提示词 %d 字）", task.id, len(prompt))
        return task

    def touch(self, task: Task) -> None:
        """
        标记任务「有进展」，并把看门狗重新计时。

        这是**无进展超时**的核心：只要页面还在报状态（进度、心跳），
        计时器就一直往后推。所以排队等多久都不会被误判超时，
        真正卡住（页面崩了/断线了）才会触发。
        """
        task.updated_at = time.time()
        self._arm_watchdog(task)

    def _arm_watchdog(self, task: Task) -> None:
        handle = self._timeout_handles.pop(task.id, None)
        if handle and not handle.done():
            handle.cancel()

        # 轮询间隔取超时的 1/4，最多 5 秒 —— 这样超时判定不会拖太久，
        # 测试里用很小的超时也能跑。
        interval = max(0.05, min(5.0, self.task_timeout / 4))

        async def watchdog() -> None:
            try:
                while True:
                    await asyncio.sleep(interval)
                    if task.status not in ("pending", "running"):
                        return
                    if time.time() - task.updated_at < self.task_timeout:
                        continue  # 期间有进展，继续等
                    task.status = "error"
                    task.error = f"超时：{self.task_timeout:.0f} 秒没有收到任何进展"
                    LOG.warning("任务 %s 无进展超时", task.id)
                    return
            except asyncio.CancelledError:
                pass
            finally:
                self._timeout_handles.pop(task.id, None)

        self._timeout_handles[task.id] = asyncio.create_task(watchdog())

    def cancel_task(self, task_id: str) -> Optional[str]:
        """
        请求取消一个任务。

        @returns None 表示已受理；否则返回拒绝原因。
        """
        task = self.tasks.get(task_id)
        if task is None:
            return "任务不存在（可能已经过期清理）"
        if task.status in ("done", "error", "cancelled"):
            return "任务已经结束了"
        if not task.cancellable:
            return "任务已经开始生成，不能取消了"
        return None

    def finish_task(self, task_id: str) -> None:
        handle = self._timeout_handles.pop(task_id, None)
        if handle and not handle.done():
            handle.cancel()

    def update_from_page(self, msg: dict[str, Any]) -> None:
        task_id = msg.get("task_id")
        if not task_id:
            return
        task = self.tasks.get(task_id)
        if task is None:
            LOG.warning("收到未知任务 %s 的消息，忽略", task_id)
            return

        kind = msg.get("type")

        if kind == "heartbeat":
            # 只用来续命，不改状态
            self.touch(task)
            return

        if kind == "progress":
            task.status = "running"
            task.stage = str(msg.get("stage") or "")
            self.touch(task)
        elif kind == "cancelled":
            task.status = "cancelled"
            task.error = str(msg.get("message") or "已取消")
            LOG.info("任务 %s 已取消", task_id)
            self.finish_task(task_id)
        elif kind == "result":
            task.status = "done"
            task.image = msg.get("image")
            task.image_format = str(msg.get("format") or "image/png")
            self.touch(task)
            # base64 大约膨胀 4/3，这里换算回原始大小
            size_kb = len(task.image) * 3 / 4 / 1024 if task.image else 0
            LOG.info("任务 %s 完成（约 %.0f KB），已回传", task_id, size_kb)
            self.finish_task(task_id)
        elif kind == "error":
            task.status = "error"
            task.error = str(msg.get("message") or "未知错误")
            self.touch(task)
            LOG.warning("任务 %s 失败: %s", task_id, task.error)
            self.finish_task(task_id)

    def gc(self) -> None:
        """清理过期任务，避免内存无限增长。"""
        cutoff = time.time() - self.task_ttl
        stale = [
            tid
            for tid, t in self.tasks.items()
            if t.status in ("done", "error", "cancelled") and t.updated_at < cutoff
        ]
        for tid in stale:
            self.tasks.pop(tid, None)
            self.finish_task(tid)
        if stale:
            LOG.debug("清理了 %d 个过期任务", len(stale))


# --------------------------------------------------------------------------- #
# HTTP 接口
# --------------------------------------------------------------------------- #

@web.middleware
async def cors_middleware(request: web.Request, handler):
    """酒馆页面与桥接服务不同源，这里统一放开。"""
    if request.method == "OPTIONS":
        response: web.StreamResponse = web.Response()
    else:
        response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def make_app(hub: Hub) -> web.Application:
    # 迁移内联图片时单次请求可能带好几 MB 的 base64，
    # aiohttp 默认上限只有 1MB，这里放宽。
    app = web.Application(
        middlewares=[cors_middleware],
        client_max_size=64 * 1024 * 1024,
    )

    async def status(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "comfy_page": hub.page_connected,
                "current_workflow": hub.page_workflow,
                "pending_tasks": sum(
                    1 for t in hub.tasks.values() if t.status in ("pending", "running")
                ),
                "image_dir": str(hub.image_dir),
            }
        )

    async def generate(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response(
                {"ok": False, "error": "请求体不是合法 JSON"}, status=400
            )

        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return web.json_response(
                {"ok": False, "error": "prompt 不能为空"}, status=400
            )

        if not hub.page_connected:
            return web.json_response(
                {
                    "ok": False,
                    "error": "ComfyUI 页面未连接。请打开 ComfyUI 的浏览器标签页，"
                             "并确认 STCB 桥接脚本已加载。",
                },
                status=503,
            )

        task = hub.create_task(prompt)
        delivered = await hub.send_to_page(
            {"type": "task", "task_id": task.id, "prompt": prompt}
        )
        if not delivered:
            task.status = "error"
            task.error = "向 ComfyUI 页面下发任务失败"
            hub.finish_task(task.id)
            return web.json_response({"ok": False, "error": task.error}, status=503)

        return web.json_response({"ok": True, "task_id": task.id})

    async def cancel(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response(
                {"ok": False, "error": "请求体不是合法 JSON"}, status=400
            )

        task_id = str(body.get("task_id") or "").strip()
        if not task_id:
            return web.json_response({"ok": False, "error": "task_id 不能为空"}, status=400)

        reason = hub.cancel_task(task_id)
        if reason is not None:
            # 409：状态冲突（已经结束、或已经开始生成不能取消）
            return web.json_response({"ok": False, "error": reason}, status=409)

        if not hub.page_connected:
            return web.json_response(
                {"ok": False, "error": "ComfyUI 页面未连接，无法取消"}, status=503
            )

        # 真正的删除动作由页面做（它才知道 prompt_id）
        delivered = await hub.send_to_page({"type": "cancel", "task_id": task_id})
        if not delivered:
            return web.json_response({"ok": False, "error": "下发取消指令失败"}, status=503)

        LOG.info("已请求取消任务 %s", task_id)
        return web.json_response({"ok": True, "task_id": task_id})

    async def task_state(request: web.Request) -> web.Response:
        task_id = request.match_info["task_id"]
        task = hub.tasks.get(task_id)
        if task is None:
            return web.json_response(
                {"ok": False, "error": "任务不存在或已过期"}, status=404
            )
        return web.json_response({"ok": True, **task.to_public()})

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        hub.attach_page(ws)

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(msg.data)
                    except Exception:  # noqa: BLE001
                        LOG.warning("收到无法解析的 WS 消息")
                        continue
                    if payload.get("type") == "hello":
                        hub.page_workflow = payload.get("workflow")
                        LOG.info("页面报告当前工作流: %s", hub.page_workflow)
                    else:
                        hub.update_from_page(payload)
                elif msg.type == WSMsgType.ERROR:
                    LOG.warning("WS 出错: %s", ws.exception())
        finally:
            hub.detach_page(ws)
        return ws

    async def serve_image(request: web.Request) -> web.StreamResponse:
        """把落盘的图片发出去，供酒馆页面 <img> 加载。"""
        name = request.match_info["name"]
        # 只允许纯文件名，挡掉目录穿越
        if "/" in name or "\\" in name or name.startswith("."):
            return web.Response(status=403)
        path = hub.image_dir / name
        if not path.is_file():
            return web.Response(status=404)
        return web.FileResponse(path)

    app.router.add_get("/api/status", status)
    app.router.add_post("/api/generate", generate)
    app.router.add_post("/api/cancel", cancel)
    app.router.add_get("/api/task/{task_id}", task_state)
    app.router.add_get("/images/{name}", serve_image)
    app.router.add_get("/ws", websocket)

    async def gc_loop() -> None:
        while True:
            await asyncio.sleep(60)
            hub.gc()

    async def on_startup(_app: web.Application) -> None:
        # 注意：on_startup 的回调会被 aiohttp await，
        # 所以这里必须「创建任务后立刻返回」，不能直接把 gc_loop 交出去，
        # 否则启动会永远挂在这个永不结束的循环上。
        _app["gc_task"] = asyncio.create_task(gc_loop())

    async def on_cleanup(_app: web.Application) -> None:
        task = _app.get("gc_task")
        if task and not task.done():
            task.cancel()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def main() -> None:
    parser = argparse.ArgumentParser(description="STCB 桥接服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    parser.add_argument(
        "--timeout", type=float, default=300.0, help="单个任务的超时秒数（默认 300）"
    )
    parser.add_argument(
        "--task-ttl", type=float, default=1800.0, help="已完成任务的保留秒数（默认 1800）"
    )
    parser.add_argument(
        "--image-dir",
        default=None,
        help="早期版本的图片目录（只用于迁移旧图，默认是本脚本旁边的 images 文件夹）",
    )
    parser.add_argument("--verbose", action="store_true", help="输出调试日志")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    image_dir = (
        Path(args.image_dir).expanduser().resolve()
        if args.image_dir
        else Path(__file__).resolve().parent / "images"
    )

    # 注意：新图片已经改为由酒馆自己托管（POST /api/images/upload），
    # 桥接服务不再往这里写文件。这个目录只用于迁移早期版本存下的图，
    # 所以**不主动创建** —— 不存在就说明没有旧图。
    hub = Hub(task_timeout=args.timeout, task_ttl=args.task_ttl, image_dir=image_dir)
    app = make_app(hub)

    LOG.info("STCB 桥接服务已启动")
    LOG.info("  酒馆扩展请连: http://%s:%d", args.host, args.port)
    LOG.info("  ComfyUI 页面请连: ws://%s:%d/ws", args.host, args.port)
    LOG.info("  状态查询: http://%s:%d/api/status", args.host, args.port)
    LOG.info("  旧图片目录: %s", image_dir)
    if image_dir.is_dir():
        legacy = len(list(image_dir.glob("*")))
        LOG.info("    里面有 %d 个文件，迁移完旧图后可以整个删掉", legacy)

    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
