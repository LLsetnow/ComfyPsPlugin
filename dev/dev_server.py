#!/usr/bin/env python
"""
ComfyPS 开发服务器
------------------
单一入口, 在浏览器中预览和热修 Photoshop 插件 UI:
  - 提供 UI 页面 (plugin/index.html + main.js)
  - 注入 mock 脚本, 模拟 Photoshop UXP API
  - WebSocket 热更新 (文件变更 → 浏览器自动刷新)
  - Mock bridge 端点 (/run, /health) 用于完整流程演示

启动: python dev/dev_server.py
然后浏览器打开 http://127.0.0.1:8765
"""

import asyncio
import base64
import hashlib
import io
import json
import os
import random
import struct
import time
import zlib
from pathlib import Path

from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parent.parent  # ComfyPsPlugin/
PLUGIN_DIR = ROOT / "plugin"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# 监听这些目录下的文件变更
WATCH_DIRS = [PLUGIN_DIR, STATIC_DIR]
WATCH_EXTENSIONS = {".html", ".js", ".css", ".json", ".png"}
POLL_INTERVAL = 0.5  # 秒


# =============================================================================
# 纯 Python PNG 生成 (无 PIL 依赖)
# =============================================================================
def _make_png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    """构造一个 PNG chunk: length(4) + type(4) + data + crc(4)."""
    raw = chunk_type + data
    crc = struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)
    return struct.pack(">I", len(data)) + raw + crc


def generate_demo_png(width=512, height=512) -> bytes:
    """生成一张演示用渐变 PNG (纯 Python, 无外部依赖)."""
    # 逐行生成 RGBA 像素, 做垂直渐变 + 圆角矩形选区框
    raw_rows = b""
    for y in range(height):
        row = b""
        for x in range(width):
            # 深色渐变背景
            r = int(30 + y * 0.25)
            g = int(30 + y * 0.1)
            b_val = int(50 + y * 0.15)
            # 中间画一个选区框 (虚线效果: 每 6px 亮一次)
            in_rect = (100 <= x <= 412) and (100 <= y <= 412)
            on_border = (
                (abs(x - 100) <= 2 or abs(x - 412) <= 2 or abs(y - 100) <= 2 or abs(y - 412) <= 2)
            )
            if on_border and ((x + y) // 6) % 2 == 0:
                r, g, b_val = 100, 200, 255
            elif in_rect:
                # 选区内稍亮
                r = min(255, r + 15)
                g = min(255, g + 10)
                b_val = min(255, b_val + 20)
            row += struct.pack("BBB", r, g, b_val)
        raw_rows += b"\x00" + row  # filter byte 0 (None) + 像素行

    # PNG 签名
    signature = b"\x89PNG\r\n\x1a\n"

    # IHDR
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ihdr = _make_png_chunk(b"IHDR", ihdr_data)

    # IDAT (zlib 压缩像素数据)
    compressed = zlib.compress(raw_rows)
    idat = _make_png_chunk(b"IDAT", compressed)

    # IEND
    iend = _make_png_chunk(b"IEND", b"")

    return signature + ihdr + idat + iend


# 启动时生成一次, 避免每次请求都重算
DEMO_PNG = generate_demo_png()
DEMO_PNG_HASH = hashlib.md5(DEMO_PNG).hexdigest()[:8]


# =============================================================================
# 文件监视器 (轮询 mtime)
# =============================================================================
class FileWatcher:
    def __init__(self):
        self._mtimes: dict[str, float] = {}
        self._subscribers: list[asyncio.Queue] = []

    def _collect_files(self) -> dict[str, float]:
        """遍历所有监听目录, 返回 {路径: mtime}."""
        result = {}
        for watch_dir in WATCH_DIRS:
            if not watch_dir.exists():
                continue
            for root, dirs, files in os.walk(watch_dir):
                # 跳过 __pycache__
                dirs[:] = [d for d in dirs if d != "__pycache__"]
                for f in files:
                    ext = os.path.splitext(f)[1].lower()
                    if ext in WATCH_EXTENSIONS:
                        fp = os.path.join(root, f)
                        try:
                            result[fp] = os.path.getmtime(fp)
                        except OSError:
                            pass
        return result

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def start(self):
        """后台任务: 每 POLL_INTERVAL 检查文件变更, 有变更时广播 reload."""
        # 首次扫描建立基线
        self._mtimes = self._collect_files()
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            current = self._collect_files()
            changed = False
            # 检查新增/修改
            for path, mtime in current.items():
                old = self._mtimes.get(path)
                if old is None or mtime > old:
                    changed = True
                    break
            # 检查删除
            for path in self._mtimes:
                if path not in current:
                    changed = True
                    break

            if changed:
                self._mtimes = current
                # 广播给所有订阅者
                dead: list[asyncio.Queue] = []
                for q in self._subscribers:
                    try:
                        q.put_nowait("reload")
                    except asyncio.QueueFull:
                        dead.append(q)
                for q in dead:
                    self.unsubscribe(q)


# =============================================================================
# HTML 注入: 在 </head> 前插入 mock 脚本
# =============================================================================
MOCK_SCRIPTS = [
    '<script src="/dev-static/mock_photoshop.js"></script>',
    '<script src="/dev-static/mock_uxp.js"></script>',
    '<script src="/dev-static/mock_workflow.js"></script>',
    '<script>window.__COMFYPS_DEV__ = true;</script>',
    '<script src="/dev-static/hot_reload.js"></script>',
]

INJECTION_MARKER = "</head>"
INJECTION = "\n  " + "\n  ".join(MOCK_SCRIPTS) + "\n" + INJECTION_MARKER


def inject_mocks(html_bytes: bytes) -> bytes:
    html = html_bytes.decode("utf-8")
    if INJECTION_MARKER in html:
        html = html.replace(INJECTION_MARKER, INJECTION, 1)
    return html.encode("utf-8")


# =============================================================================
# 安全: 检查路径是否在允许目录内
# =============================================================================
def _resolve_safe(base_dir: Path, rel_path: str) -> Path | None:
    """解析相对路径, 确保在 base_dir 内部。返回 None 表示不安全。"""
    resolved = (base_dir / rel_path).resolve()
    base_resolved = base_dir.resolve()
    try:
        resolved.relative_to(base_resolved)
    except ValueError:
        return None
    return resolved


# =============================================================================
# CORS 中间件
# =============================================================================
@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = web.Response(
                status=e.status,
                text=json.dumps({"error": "HTTP_ERROR", "message": str(e)}),
                content_type="application/json",
            )
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


# =============================================================================
# 路由处理器
# =============================================================================

async def handle_index(request: web.Request) -> web.Response:
    """Serve index.html 并注入 mock 脚本。"""
    index_path = PLUGIN_DIR / "index.html"
    if not index_path.exists():
        raise web.HTTPNotFound(text="index.html not found")
    html = inject_mocks(index_path.read_bytes())
    return web.Response(body=html, content_type="text/html")


async def handle_plugin_static(request: web.Request) -> web.Response:
    """Serve plugin/ 目录下其他文件 (main.js, icons/...)。"""
    rel = request.match_info.get("path", "")
    file_path = _resolve_safe(PLUGIN_DIR, rel)
    if file_path is None or not file_path.exists():
        raise web.HTTPNotFound()
    if file_path.is_dir():
        raise web.HTTPNotFound()
    return web.FileResponse(file_path)


async def handle_dev_static(request: web.Request) -> web.Response:
    """Serve dev/static/ 下的 mock/hot_reload 脚本。"""
    rel = request.match_info.get("path", "")
    file_path = _resolve_safe(STATIC_DIR, rel)
    if file_path is None or not file_path.exists():
        raise web.HTTPNotFound()
    if file_path.is_dir():
        raise web.HTTPNotFound()
    return web.FileResponse(file_path)


async def handle_websocket(request: web.Request) -> web.WebSocketResponse:
    """WebSocket 端点 — 热更新推送。"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    q = watcher.subscribe()
    try:
        # 发送初始连接确认
        await ws.send_json({"type": "connected"})
        while True:
            msg = await q.get()
            if msg == "reload":
                await ws.send_json({"type": "reload"})
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        watcher.unsubscribe(q)
    return ws


async def handle_health(request: web.Request) -> web.Response:
    """Mock bridge /health 端点。"""
    return web.json_response({
        "ok": True,
        "workflowId": "demo-2075283500294565890",
    })


async def handle_restart(request: web.Request) -> web.Response:
    """Mock bridge /restart 端点 (dev 模式下仅返回确认)。"""
    return web.json_response({"ok": True, "message": "dev bridge restarted"})


async def handle_test_key(request: web.Request) -> web.Response:
    """Mock bridge /test-key 端点 — 返回模拟余额。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "message": "请求体不是 JSON"}, status=400)
    api_key = (body.get("apiKey") or "").strip()
    site = (body.get("site") or "ai").strip()
    if not api_key:
        return web.json_response({"ok": False, "message": "请输入 API Key"}, status=400)
    symbol = "$" if site == "ai" else "¥"
    return web.json_response({
        "ok": True,
        "site": site,
        "status": "no_balance",
        "key_prefix": "demo****",
        "balance": "0",
        "coins": "0",
        "symbol": symbol,
        "api_type": "SHARED",
        "running_tasks": "0",
        "message": "Key demo**** 有效但余额为 0 · SHARED",
    })


async def handle_codex_status(request: web.Request) -> web.Response:
    """Mock Codex 订阅图像能力状态。"""
    return web.json_response({
        "ok": True,
        "installed": True,
        "loggedIn": True,
        "imageGeneration": True,
        "version": "codex-cli demo",
        "message": "Codex 订阅图像生成功能可用（开发模拟）",
    })


async def handle_codex_image(request: web.Request) -> web.Response:
    """Mock /codex/image，校验与真实桥相同的基本请求结构。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400
        )

    mode = (body.get("mode") or "generate").strip().lower()
    prompt = (body.get("prompt") or "").strip()
    images = body.get("images") or []
    if mode not in ("generate", "reference", "edit"):
        return web.json_response(
            {"error": "INVALID_MODE", "message": "无效的 Codex 图像模式"}, status=400
        )
    if not prompt:
        return web.json_response(
            {"error": "MISSING_PROMPT", "message": "请输入关键词或编辑说明"}, status=400
        )
    if mode == "reference" and not 1 <= len(images) <= 2:
        return web.json_response(
            {"error": "INVALID_IMAGES", "message": "参考图模式需要 1 或 2 张图片"}, status=400
        )
    if mode == "edit" and not 1 <= len(images) <= 2:
        return web.json_response(
            {"error": "INVALID_IMAGES", "message": "图像编辑模式需要完整文档图，可额外添加一张参考图"}, status=400
        )
    if mode == "edit" and not body.get("mask"):
        return web.json_response(
            {"error": "MISSING_MASK", "message": "图像编辑模式需要选区蒙版"}, status=400
        )

    print(
        f"  [mock /codex/image] mode={mode}  refs={len(images)}  "
        f"prompt={'✓' if prompt else '—'}"
    )
    await asyncio.sleep(1.2)
    return web.Response(body=DEMO_PNG, content_type="image/png")


async def handle_gpt_image(request: web.Request) -> web.Response:
    """Mock /gpt-image，覆盖 Codex 订阅与 OpenAI API Key 两种认证。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400
        )

    provider = (body.get("provider") or "codex").strip().lower()
    if provider not in ("codex", "api-key", "apikey", "openai"):
        return web.json_response(
            {"error": "INVALID_PROVIDER", "message": "无效的 GPT Image 认证方式"}, status=400
        )
    if provider != "codex" and not (body.get("apiKey") or "").strip():
        return web.json_response(
            {"error": "MISSING_API_KEY", "message": "请输入 OpenAI API Key"}, status=400
        )

    mode = (body.get("mode") or "generate").strip().lower()
    prompt = (body.get("prompt") or "").strip()
    images = body.get("images") or []
    if mode not in ("generate", "reference", "edit"):
        return web.json_response(
            {"error": "INVALID_MODE", "message": "无效的 GPT Image 模式"}, status=400
        )
    if not prompt:
        return web.json_response(
            {"error": "MISSING_PROMPT", "message": "请输入关键词或编辑说明"}, status=400
        )
    if mode == "reference" and not 1 <= len(images) <= 2:
        return web.json_response(
            {"error": "INVALID_IMAGES", "message": "参考图模式需要 1 或 2 张图片"}, status=400
        )
    if mode == "edit" and not 1 <= len(images) <= 2:
        return web.json_response(
            {"error": "INVALID_IMAGES", "message": "图像编辑模式需要完整文档图，可额外添加一张参考图"}, status=400
        )
    if mode == "edit" and not body.get("mask"):
        return web.json_response(
            {"error": "MISSING_MASK", "message": "图像编辑模式需要选区蒙版"}, status=400
        )

    print(
        f"  [mock /gpt-image] provider={provider}  mode={mode}  refs={len(images)}  "
        f"mask={'✓' if body.get('mask') else '—'}  "
        f"prompt={'✓' if prompt else '—'}"
    )
    await asyncio.sleep(1.2)
    return web.Response(body=DEMO_PNG, content_type="image/png")


async def handle_gpt_image_status(request: web.Request) -> web.Response:
    """Mock OpenAI GPT Image API Key 检测。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "message": "请求体不是 JSON"}, status=400)
    if not (body.get("apiKey") or "").strip():
        return web.json_response({"ok": False, "message": "请输入 OpenAI API Key"}, status=400)
    return web.json_response({"ok": True, "message": "OpenAI GPT Image API Key 可用（开发模拟）"})


async def handle_run(request: web.Request) -> web.Response:
    """Mock bridge /run 端点 — 模拟延迟后返回 demo 图。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400
        )

    image_b64 = body.get("image")
    mask_b64 = body.get("mask")
    prompt = body.get("prompt", "")
    backend = body.get("backend", "runninghub")
    site = body.get("site", "")
    api_key = body.get("apiKey", "")
    comfyui_url = body.get("comfyuiUrl", "")
    extra_set_args = body.get("extraSetArgs") or []

    if not image_b64 or not mask_b64:
        return web.json_response(
            {"error": "MISSING", "message": "缺少 image 或 mask 字段"}, status=400
        )

    # 记录请求信息
    img_size = len(image_b64)
    mask_size = len(mask_b64)
    print(f"  [mock /run] backend={backend}  image={img_size // 1024}KB  mask={mask_size // 1024}KB  "
          f"prompt={'✓' if prompt else '—'}  site={site}  key={'✓' if api_key else '—'}")

    # 模拟云端处理延迟 (1.5~2.5s 随机, 让体验真实)
    delay = 1.5 + random.random() * 1.0
    await asyncio.sleep(delay)

    return web.Response(body=DEMO_PNG, content_type="image/png")


async def handle_demo_image(request: web.Request) -> web.Response:
    """Serve demo 图 (供 mock_uxp.js 预加载)."""
    return web.Response(body=DEMO_PNG, content_type="image/png")


async def handle_favicon(request: web.Request) -> web.Response:
    """返回 204 避免 favicon 404 噪音。"""
    return web.Response(status=204)


# =============================================================================
# 全局引用 (启动时填充)
# =============================================================================
watcher: FileWatcher


# =============================================================================
# 主入口
# =============================================================================
def main():
    global watcher
    port = int(os.environ.get("COMFYPS_DEV_PORT", "8765"))

    print(f"  ComfyPS Dev Server")
    print(f"  {'─' * 40}")
    print(f"  UI 页面:   http://127.0.0.1:{port}")
    print(f"  Mock 桥:   http://127.0.0.1:{port}/run")
    print(f"  健康检查:  http://127.0.0.1:{port}/health")
    print(f"  Demo 图:   http://127.0.0.1:{port}/demo-image.png  ({DEMO_PNG_HASH})")
    print(f"  热更新:    WebSocket /ws  (监视 plugin/ + dev/static/)")
    print()

    watcher = FileWatcher()

    app = web.Application(
        client_max_size=64 * 1024 * 1024,  # 64MB, 与真实桥一致
        middlewares=[cors_middleware],
    )

    # ---- 路由注册 ----
    # 首页
    app.router.add_get("/", handle_index)
    app.router.add_get("/index.html", handle_index)

    # Dev static (mock 脚本)
    app.router.add_get("/dev-static/{path:.*}", handle_dev_static)

    # WebSocket 热更新
    app.router.add_get("/ws", handle_websocket)

    # Mock bridge 端点 (协议与真实桥一致)
    app.router.add_get("/health", handle_health)
    app.router.add_post("/run", handle_run)
    app.router.add_post("/restart", handle_restart)
    app.router.add_post("/test-key", handle_test_key)
    app.router.add_get("/codex/status", handle_codex_status)
    app.router.add_post("/codex/image", handle_codex_image)
    app.router.add_post("/gpt-image", handle_gpt_image)
    app.router.add_post("/gpt-image/status", handle_gpt_image_status)

    # Demo 图
    app.router.add_get("/demo-image.png", handle_demo_image)

    # Favicon (静音)
    app.router.add_get("/favicon.ico", handle_favicon)

    # Plugin 静态文件 (main.js, icons/) — 兜底路由
    app.router.add_get("/{path:.*}", handle_plugin_static)

    # 启动文件监视器
    async def on_startup(app):
        asyncio.create_task(watcher.start())

    app.on_startup.append(on_startup)

    web.run_app(app, host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
