#!/usr/bin/env python3
"""
STCB 桥接服务自测

不依赖 ComfyUI，用一个假的「ComfyUI 页面」连上来，走一遍完整链路：
    提交任务 → 下发到页面 → 页面回传结果 → 轮询取到图片

用法：
    python test_bridge.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import tempfile
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).parent))
from bridge_server import Hub, make_app  # noqa: E402

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}/ws"

FAKE_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-image-bytes"
FAKE_PNG = base64.b64encode(FAKE_BYTES).decode()

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  [通过] {name}")
    else:
        failed += 1
        print(f"  [失败] {name}  {detail}")


async def fake_comfyui_page(session: aiohttp.ClientSession, received: list) -> None:
    """模拟 ComfyUI 页面里的桥接脚本。"""
    async with session.ws_connect(WS) as ws:
        await ws.send_str(json.dumps({"type": "hello", "role": "comfyui", "workflow": "测试工作流.json"}))
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            payload = json.loads(msg.data)
            received.append(payload)
            if payload.get("type") == "task":
                task_id = payload["task_id"]
                await ws.send_str(json.dumps({"type": "progress", "task_id": task_id, "stage": "queued"}))
                await asyncio.sleep(0.05)
                await ws.send_str(json.dumps({"type": "progress", "task_id": task_id, "stage": "fetching"}))
                await ws.send_str(
                    json.dumps(
                        {"type": "result", "task_id": task_id, "image": FAKE_PNG, "format": "image/png"}
                    )
                )
                return  # 一个任务就够了


async def persistent_fake_page(
    session: aiohttp.ClientSession, inbox: list, ready: asyncio.Event
) -> None:
    """一直连着的假页面，用来测取消。收到的消息都塞进 inbox。"""
    async with session.ws_connect(WS) as ws:
        await ws.send_str(
            json.dumps({"type": "hello", "role": "comfyui", "workflow": "测试.json"})
        )
        ready.set()
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            inbox.append(json.loads(msg.data))


async def main() -> int:
    image_dir = Path(tempfile.mkdtemp(prefix="stcb-test-images-"))
    hub = Hub(task_timeout=10, task_ttl=60, image_dir=image_dir)
    app = make_app(hub)

    from aiohttp import web

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()

    try:
        async with aiohttp.ClientSession() as session:
            print("\n1. 页面未连接时的状态")
            async with session.get(f"{BASE}/api/status") as r:
                data = await r.json()
            check("status 返回 ok", data.get("ok") is True)
            check("comfy_page 为 false", data.get("comfy_page") is False)

            print("\n2. 页面未连接时提交任务，应当被拒绝")
            async with session.post(f"{BASE}/api/generate", json={"prompt": "1girl"}) as r:
                body = await r.json()
            check("返回 503", r.status == 503, f"实际 {r.status}")
            check("错误信息可读", "ComfyUI 页面未连接" in (body.get("error") or ""))

            print("\n3. 空提示词应当被拒绝")
            async with session.post(f"{BASE}/api/generate", json={"prompt": "   "}) as r:
                check("返回 400", r.status == 400, f"实际 {r.status}")

            print("\n4. 非法 JSON 应当被拒绝")
            async with session.post(
                f"{BASE}/api/generate", data="not json", headers={"Content-Type": "application/json"}
            ) as r:
                check("返回 400", r.status == 400, f"实际 {r.status}")

            print("\n5. 启动假的 ComfyUI 页面并跑通完整链路")
            received: list = []
            page = asyncio.create_task(fake_comfyui_page(session, received))

            # 等页面连上
            for _ in range(50):
                await asyncio.sleep(0.05)
                async with session.get(f"{BASE}/api/status") as r:
                    if (await r.json()).get("comfy_page"):
                        break
            async with session.get(f"{BASE}/api/status") as r:
                st = await r.json()
            check("页面已连接", st.get("comfy_page") is True)
            check("拿到当前工作流名", st.get("current_workflow") == "测试工作流.json", str(st))

            async with session.post(f"{BASE}/api/generate", json={"prompt": "1girl, solo, sunset"}) as r:
                body = await r.json()
            check("提交成功", body.get("ok") is True, str(body))
            task_id = body.get("task_id")
            check("拿到 task_id", bool(task_id))

            await page  # 等假页面处理完

            check("任务已下发到页面", any(m.get("type") == "task" for m in received))
            check(
                "提示词正确送达",
                any(m.get("prompt") == "1girl, solo, sunset" for m in received),
            )

            print("\n6. 轮询任务状态")
            final = None
            for _ in range(50):
                async with session.get(f"{BASE}/api/task/{task_id}") as r:
                    final = await r.json()
                if final.get("status") in ("done", "error"):
                    break
                await asyncio.sleep(0.05)
            check("任务完成", final.get("status") == "done", str(final))
            check("格式正确", final.get("format") == "image/png")

            print("\n6b. 结果里应当直接带回 base64（桥接服务不再存图）")
            b64 = final.get("image")
            check("返回了 base64 图片", bool(b64), str(final)[:120])
            check("返回的 base64 与回传的一致", b64 == FAKE_PNG, f"{len(b64 or '')} 字符")
            check("不再返回 /images URL", "url" not in final, str(final)[:120])
            if b64:
                check(
                    "解码后与原始字节一致",
                    base64.b64decode(b64) == FAKE_BYTES,
                )

            print("\n6c. 旧图片的静态路由仍然可用（迁移旧图要用）")
            image_dir.mkdir(parents=True, exist_ok=True)
            legacy = image_dir / "legacy-sample.png"
            legacy.write_bytes(FAKE_BYTES)
            async with session.get(f"{BASE}/images/{legacy.name}") as r:
                body = await r.read()
                status = r.status
            check("HTTP 200", status == 200, f"实际 {status}")
            check("内容与原始字节一致", body == FAKE_BYTES)

            print("\n6d. 图片接口不该能被目录穿越")
            async with session.get(f"{BASE}/images/..%2Fbridge_server.py") as r:
                check("被拒绝或找不到", r.status in (403, 404), f"实际 {r.status}")
            async with session.get(f"{BASE}/images/nope.png") as r:
                check("不存在的文件返回 404", r.status == 404, f"实际 {r.status}")

            print("\n7. 查询不存在的任务")
            async with session.get(f"{BASE}/api/task/deadbeef") as r:
                check("返回 404", r.status == 404, f"实际 {r.status}")

            print("\n8. CORS 头")
            async with session.get(f"{BASE}/api/status") as r:
                check(
                    "带 Access-Control-Allow-Origin",
                    r.headers.get("Access-Control-Allow-Origin") == "*",
                    str(dict(r.headers)),
                )
            async with session.options(f"{BASE}/api/generate") as r:
                check("OPTIONS 预检通过", r.status == 200, f"实际 {r.status}")

            print("\n9. 排队中可取消 / 生成中不可取消")
            inbox: list = []
            ready = asyncio.Event()
            page_task = asyncio.create_task(persistent_fake_page(session, inbox, ready))
            await asyncio.wait_for(ready.wait(), timeout=3)
            await asyncio.sleep(0.15)

            # —— 刚创建、页面还没接手 → 不可取消
            async with session.post(f"{BASE}/api/generate", json={"prompt": "a"}) as r:
                tid = (await r.json())["task_id"]
            await asyncio.sleep(0.1)

            async with session.get(f"{BASE}/api/task/{tid}") as r:
                st = await r.json()
            check("刚创建（还没接手）时不可取消", st.get("cancellable") is False, str(st))

            # —— 页面接手并报「排队中」→ 可取消
            hub.update_from_page({"type": "progress", "task_id": tid, "stage": "queued"})
            async with session.get(f"{BASE}/api/task/{tid}") as r:
                st = await r.json()
            check("排队中可取消", st.get("cancellable") is True, str(st))

            inbox.clear()
            async with session.post(f"{BASE}/api/cancel", json={"task_id": tid}) as r:
                check("取消返回 200", r.status == 200, f"实际 {r.status}")
            await asyncio.sleep(0.15)
            check(
                "页面收到了 cancel 指令",
                any(m.get("type") == "cancel" for m in inbox),
                str(inbox),
            )

            hub.update_from_page({"type": "cancelled", "task_id": tid})
            async with session.get(f"{BASE}/api/task/{tid}") as r:
                st = await r.json()
            check("状态变成 cancelled", st.get("status") == "cancelled", str(st))

            async with session.post(f"{BASE}/api/cancel", json={"task_id": tid}) as r:
                check("已结束的任务再取消返回 409", r.status == 409, f"实际 {r.status}")

            # —— 已经开始生成 → 不可取消
            async with session.post(f"{BASE}/api/generate", json={"prompt": "b"}) as r:
                rid = (await r.json())["task_id"]
            await asyncio.sleep(0.1)
            hub.update_from_page({"type": "progress", "task_id": rid, "stage": "running"})

            async with session.get(f"{BASE}/api/task/{rid}") as r:
                st = await r.json()
            check("生成中不可取消", st.get("cancellable") is False, str(st))

            async with session.post(f"{BASE}/api/cancel", json={"task_id": rid}) as r:
                code = r.status
                body = await r.json()
            check("拒绝取消返回 409", code == 409, f"实际 {code}")
            check("并且说明了原因", "生成" in (body.get("error") or ""), str(body))

            async with session.post(f"{BASE}/api/cancel", json={}) as r:
                check("缺 task_id 返回 400", r.status == 400, f"实际 {r.status}")
            async with session.post(f"{BASE}/api/cancel", json={"task_id": "nope"}) as r:
                check("不存在的任务返回 409", r.status == 409, f"实际 {r.status}")

            page_task.cancel()

            print("\n10. 无进展超时（心跳能续命）")
            quick = Hub(task_timeout=0.4, task_ttl=60, image_dir=image_dir)
            qt = quick.create_task("x")
            quick.update_from_page({"type": "progress", "task_id": qt.id, "stage": "queued"})

            # 持续心跳：不该超时
            for _ in range(4):
                await asyncio.sleep(0.2)
                quick.update_from_page({"type": "heartbeat", "task_id": qt.id})
            check("有心跳就不会超时", qt.status == "running", f"{qt.status} / {qt.error}")

            # 停止心跳：应当超时
            await asyncio.sleep(1.0)
            check("没有心跳会超时", qt.status == "error", f"{qt.status} / {qt.error}")
            check("原因写明「没有进展」", "没有" in (qt.error or ""), str(qt.error))

    finally:
        await runner.cleanup()

    print(f"\n{'=' * 46}")
    print(f"通过 {passed} 项，失败 {failed} 项")
    print("=" * 46)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
