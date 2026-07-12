#!/usr/bin/env python
"""
ComfyPS 本地桥
--------------
Photoshop 插件(UXP)无法直接执行命令并抓 stdout,所以由这个小服务代劳:
  插件 POST /run { image, mask, backend, ... }
    → RunningHub 模式: 用 RH_CLI 跑 inpaint 工作流
    → 本地 ComfyUI 模式: 直连 ComfyUI API 跑工作流

密钥可经插件传入,或从 ~/.config/rh/config.toml 读取。

配置:同目录 config.json(参考 config.example.json)。
运行:python bridge.py
"""

import asyncio
import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from aiohttp import web

BRIDGE_DIR = Path(__file__).resolve().parent

# 允许在未 pip install 的情况下直接从源码 import rh_cli(开发便利)
_RH_SRC = Path.home() / "Documents" / "github" / "RH_CLI" / "src"
try:
    import rh_cli  # noqa: F401
except ImportError:
    if _RH_SRC.exists():
        sys.path.insert(0, str(_RH_SRC))
    import rh_cli  # noqa: F401

from rh_cli.config import require_api_key
from rh_cli.errors import RhCliError
from rh_cli.http import BASE_URL, RhHttpClient
from rh_cli.workflow.client import run_workflow

# ---------------------------------------------------------------------------
# RunningHub 站点映射
# ---------------------------------------------------------------------------
RH_SITES = {
    "ai": "https://www.runninghub.ai",
    "cn": "https://www.runninghub.cn",
}

DEFAULT_RH_SITE = "ai"

# 任务进度 (task_id → {percent, status})
_task_progress: dict[str, dict] = {}


def get_rh_base_url(site: str | None) -> str:
    """根据 site 返回 RunningHub 基础 URL, 未识别时回退到 en。"""
    s = (site or "").strip().lower()
    if s in RH_SITES:
        return RH_SITES[s]
    # 尝试用 rh_cli 自带的 BASE_URL
    try:
        return str(BASE_URL)
    except Exception:
        return RH_SITES["ai"]


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def load_config():
    cfg_path = BRIDGE_DIR / "config.json"
    if not cfg_path.exists():
        raise SystemExit(
            f"❌ 找不到 {cfg_path}\n   请复制 config.example.json 为 config.json 并填写 "
            f"workflowId / imageNodeId / maskNodeId。"
        )
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    for key in ("workflowId", "imageNodeId", "maskNodeId", "workflowFile"):
        if not str(cfg.get(key, "")).strip():
            raise SystemExit(f"❌ config.json 缺少必填项:{key}")
    wf = Path(cfg["workflowFile"]).expanduser()
    if not wf.is_absolute():
        wf = (BRIDGE_DIR / wf).resolve()
    cfg["workflowFile"] = str(wf)
    if not Path(cfg["workflowFile"]).exists():
        raise SystemExit(f"❌ 工作流文件不存在:{cfg['workflowFile']}")
    cfg.setdefault("maskField", "image")
    cfg.setdefault("port", 8765)
    return cfg


CONFIG = None  # 启动时填充


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def strip_data_uri(b64: str) -> str:
    m = re.match(r"^data:[^;]+;base64,(.*)$", b64, re.IGNORECASE | re.DOTALL)
    return m.group(1) if m else b64


def write_b64_png(b64: str, path: Path):
    path.write_bytes(base64.b64decode(strip_data_uri(b64).strip()))


def upload_mask(mask_path: Path, api_key: str | None = None, site: str | None = None) -> str:
    """把蒙版上传到 RunningHub, 返回 fileName。"""
    if api_key and api_key.strip():
        key = api_key.strip()
    else:
        resolved = require_api_key(None)  # 从 ~/.config/rh/config.toml 读 key
        key = resolved.value

    base_url = get_rh_base_url(site)
    upload_url = f"{base_url}/openapi/v2/media/upload/binary"

    with RhHttpClient(key) as client:
        resp = client.upload_form(
            upload_url,
            str(mask_path),
            data={},
            headers={"Authorization": f"Bearer {key}"},
        )
    if resp.get("code") != 0:
        raise RuntimeError(f"蒙版上传失败:{resp.get('msg', resp)}")
    file_name = resp.get("data", {}).get("fileName")
    if not file_name:
        raise RuntimeError("蒙版上传成功但响应无 fileName")
    return str(file_name)


def _text_field_of(node: dict):
    inputs = node.get("inputs", {}) or {}
    for f in ("text", "prompt", "positive", "string", "text_g"):
        if f in inputs and isinstance(inputs[f], str):
            return f
    return None


def find_positive_prompt_target(workflow: dict):
    candidates = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        field = _text_field_of(node)
        if not field:
            continue
        title = str((node.get("_meta") or {}).get("title", ""))
        if re.search(r"negative|负向|负面|\bneg\b", title, re.I):
            continue
        if re.search(r"positive|正向|正面|\bpos\b", title, re.I):
            return (nid, field)
        candidates.append((nid, field))

    def resolve_source(ref, depth=0):
        if depth > 8 or not (isinstance(ref, list) and len(ref) == 2):
            return None
        node = workflow.get(str(ref[0]))
        if not isinstance(node, dict):
            return None
        field = _text_field_of(node)
        if field:
            return (str(ref[0]), field)
        for v in (node.get("inputs", {}) or {}).values():
            if isinstance(v, list) and len(v) == 2:
                r = resolve_source(v, depth + 1)
                if r:
                    return r
        return None

    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        pos = (node.get("inputs", {}) or {}).get("positive")
        if isinstance(pos, list):
            r = resolve_source(pos)
            if r:
                return r

    if len(candidates) == 1:
        return candidates[0]
    return None


def resolve_prompt_target(cfg: dict, workflow: dict):
    explicit = str(cfg.get("promptNodeId", "")).strip()
    if explicit:
        return (explicit, str(cfg.get("promptField", "") or "text"))
    return find_positive_prompt_target(workflow)


def run_inpaint_blocking(
    image_path: Path,
    mask_path: Path | None,
    out_dir: Path,
    prompt: str = "",
    api_key: str | None = None,
    site: str | None = None,
    needs_mask: bool = True,
    workflow_id: str | None = None,
    workflow_file: str | None = None,
    extra_set_args: list[str] | None = None,
    image_node_id: str | None = None,
    task_id: str | None = None,
) -> bytes:
    """RunningHub 模式: 上传蒙版(可选) → 注入提示词 → 跑工作流 → 读结果字节。"""
    cfg = CONFIG
    wf_id = str(workflow_id or cfg["workflowId"])
    # 选择工作流文件: 请求传入的相对路径 > 配置的默认文件
    if workflow_file and workflow_file.strip():
        wf_file = str((BRIDGE_DIR / workflow_file.strip()).resolve())
    else:
        wf_file = cfg["workflowFile"]
    set_args = []

    # 蒙版上传 (仅需要蒙版的工作流)
    if needs_mask and mask_path:
        mask_file_name = upload_mask(mask_path, api_key=api_key, site=site)
        set_args.append(f"{cfg['maskNodeId']}:{cfg['maskField']}={mask_file_name}")
        if cfg.get("maskChannel"):
            set_args.append(f"{cfg['maskNodeId']}:channel={cfg['maskChannel']}")

    # 提示词注入
    if prompt and prompt.strip():
        workflow = json.loads(Path(wf_file).read_text(encoding="utf-8"))
        target = resolve_prompt_target(cfg, workflow)
        if target:
            node_id, field = target
            set_args.append(f"{node_id}:{field}={prompt}")
            print(f"# 提示词注入 → [{node_id}].{field}")
        else:
            print("# ⚠️ 未能自动判断 positive 提示词节点,已跳过注入(可在 config 填 promptNodeId)")

    # 插件传入的额外参数 (如 denoise 等)
    if extra_set_args:
        for arg in extra_set_args:
            set_args.append(str(arg))
            print(f"# 额外参数注入 → {arg}")

    img_node = str(image_node_id or cfg["imageNodeId"])

    def on_progress(elapsed: int, message: str):
        if task_id:
            _task_progress[task_id] = {
                "elapsed": elapsed,
                "message": message,
                "percent": min(95, int(elapsed / 120 * 100)),  # 粗略估算, 最多 95%
            }

    if task_id:
        _task_progress[task_id] = {"elapsed": 0, "message": "提交中…", "percent": 0}

    result = run_workflow(
        api_key_arg=api_key if api_key else None,
        workflow_file=wf_file,
        workflow_id=wf_id,
        input_image=str(image_path),
        load_image_node=img_node,
        output=None,
        output_dir=out_dir,
        set_args=set_args,
        on_tick=on_progress,
    )

    if task_id:
        _task_progress[task_id] = {"elapsed": -1, "message": "完成", "percent": 100}
        # 延迟清理
        import threading as _th
        _th.Timer(60, lambda: _task_progress.pop(task_id, None)).start()
    if not result.files:
        raise RuntimeError("工作流没有返回任何输出文件")
    return Path(result.files[0]).read_bytes()


def run_comfyui_blocking(
    image_path: Path,
    mask_path: Path,
    out_dir: Path,
    prompt: str = "",
    comfyui_url: str = "http://127.0.0.1:8188",
) -> bytes:
    """本地 ComfyUI 模式: 加载工作流 JSON → 注入 image/mask → 提交 → 轮询 → 返回结果图。"""
    import urllib.request
    import urllib.error

    cfg = CONFIG
    wf = json.loads(Path(cfg["workflowFile"]).read_text(encoding="utf-8"))

    # 编码 image 和 mask 为 base64 并注入到对应节点
    img_b64 = base64.b64encode(image_path.read_bytes()).decode()
    mask_b64 = base64.b64encode(mask_path.read_bytes()).decode()

    img_node = str(cfg["imageNodeId"])
    mask_node = str(cfg["maskNodeId"])

    # 尝试注入 image/mask (适配 LoadImage 节点的常见字段名)
    _inject_image_input(wf, img_node, img_b64)
    _inject_image_input(wf, mask_node, mask_b64)

    # 注入 prompt
    if prompt and prompt.strip():
        target = resolve_prompt_target(cfg, wf)
        if target:
            node_id, field = target
            if node_id in wf and "inputs" in wf[node_id]:
                wf[node_id]["inputs"][field] = prompt.strip()

    # 提交 prompt
    api_url = comfyui_url.rstrip("/") + "/prompt"
    payload = json.dumps({"prompt": wf}).encode("utf-8")
    req = urllib.request.Request(api_url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接到 ComfyUI ({comfyui_url}): {e.reason}")
    except Exception as e:
        raise RuntimeError(f"ComfyUI 提交失败: {e}")

    prompt_id = result.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI 未返回 prompt_id: {result}")

    # 轮询等待结果
    history_url = f"{comfyui_url.rstrip('/')}/history/{prompt_id}"
    max_attempts = 120  # 最多等 2 分钟
    for attempt in range(max_attempts):
        import time as _time
        _time.sleep(1)
        try:
            with urllib.request.urlopen(history_url, timeout=5) as resp:
                hist = json.loads(resp.read())
        except Exception:
            continue
        outputs = hist.get(prompt_id, {}).get("outputs")
        if outputs:
            # 找第一个 SaveImage 输出
            for node_out in outputs.values():
                images = node_out.get("images")
                if images and len(images) > 0:
                    img_file = images[0]
                    file_name = img_file.get("filename", "result.png")
                    subfolder = img_file.get("subfolder", "")
                    dl_path = f"{subfolder}/{file_name}" if subfolder else file_name
                    dl_url = f"{comfyui_url.rstrip('/')}/view?filename={file_name}&subfolder={subfolder}"
                    with urllib.request.urlopen(dl_url, timeout=10) as dl_resp:
                        return dl_resp.read()
    raise RuntimeError("ComfyUI 工作流超时:未在 2 分钟内返回结果")


def _inject_image_input(workflow: dict, node_id: str, image_b64: str):
    """将 base64 图片注入到工作流节点的 image 字段。"""
    if node_id not in workflow:
        return
    inputs = workflow[node_id].get("inputs", {})
    # 常见字段名: image, choose file to upload
    for field in ("image", "choose file to upload"):
        if field in inputs:
            inputs[field] = image_b64
            return
    # 不支持的节点类型, 跳过
    print(f"# ⚠️ 节点 {node_id} 没有可写入的图片字段, 跳过注入")


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------
def cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


async def handle_options(request):
    return cors(web.Response(status=204))


async def handle_health(request):
    return cors(web.json_response({"ok": True, "workflowId": CONFIG["workflowId"]}))


async def handle_progress(request):
    task_id = request.query.get("taskId", "")
    if not task_id or task_id not in _task_progress:
        return cors(web.json_response({"percent": 0, "message": "未知任务"}, status=404))
    return cors(web.json_response(_task_progress[task_id]))


async def handle_restart(request):
    """重启桥进程: 用 os.execv 原地替换当前进程。"""
    resp = cors(web.json_response({"ok": True, "message": "bridge restarting"}))

    def _restart():
        import time as _time
        _time.sleep(0.3)
        os.execv(sys.executable, [sys.executable] + sys.argv)

    import threading
    threading.Thread(target=_restart, daemon=True).start()
    return resp


async def handle_test_key(request):
    """测试 API Key 是否有效, 查询指定站点的余额。"""
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response({"ok": False, "message": "请求体不是 JSON"}, status=400))

    api_key = (body.get("apiKey") or "").strip()
    site = (body.get("site") or "ai").strip()

    if not api_key:
        return cors(web.json_response({"ok": False, "message": "请输入 API Key"}, status=400))

    if site not in ("ai", "cn"):
        site = "ai"

    # 根据站点选择 URL (与 rh_cli.http 中 ACCOUNT_STATUS_URL 格式一致)
    host = "https://www.runninghub.ai" if site == "ai" else "https://www.runninghub.cn"
    status_url = f"{host}/uc/openapi/accountStatus"

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, _check_account_single, api_key, site, status_url
        )
    except Exception as e:
        return cors(web.json_response({"ok": False, "message": f"检测异常: {e}"}))

    return cors(web.json_response(result))


def _check_account_single(api_key: str, site: str, status_url: str) -> dict:
    """单站点余额查询, 返回格式与 rh_cli.account.check_account 一致。"""
    key_prefix = api_key[:4] + "****"

    try:
        with RhHttpClient(api_key, timeout=15.0) as client:
            resp = client.post_json(status_url, {"apikey": api_key}, timeout=15.0)
    except Exception as e:
        return {
            "ok": False,
            "key_prefix": key_prefix,
            "message": f"{site} 站点请求失败: {e}",
        }

    if resp.get("code") != 0:
        return {
            "ok": False,
            "key_prefix": key_prefix,
            "message": f"{site} 站点: {resp.get('msg') or resp.get('message') or 'Key 无效'}",
        }

    data = resp.get("data", {})
    balance_raw = data.get("remainMoney")
    balance_str = str(balance_raw) if balance_raw is not None else "0"
    try:
        balance_num = float(balance_str)
    except (TypeError, ValueError):
        balance_num = 0.0

    status = "ready" if balance_num > 0 else "no_balance"
    coins = str(data.get("remainCoins", "0"))
    currency = str(data.get("currency", "")) if data.get("currency") else ""
    api_type = str(data.get("apiType", ""))
    tasks = str(data.get("currentTaskCounts", "0"))

    # 符号: ai → $, cn → ¥
    symbol = "$" if site == "ai" else "¥"

    if status == "ready":
        msg = f"Key {key_prefix} 有效 · 余额 {symbol}{balance_str} ({coins} coins) · {api_type}"
    else:
        msg = f"Key {key_prefix} 有效但余额为 0 · {api_type}"

    if tasks and int(tasks) > 0:
        msg += f" · 运行中: {tasks}"

    return {
        "ok": True,
        "site": site,
        "status": status,
        "key_prefix": key_prefix,
        "balance": balance_str,
        "coins": coins,
        "symbol": symbol,
        "api_type": api_type,
        "running_tasks": tasks,
        "message": msg,
    }


async def handle_run(request):
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response({"error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400))

    image_b64 = body.get("image")
    mask_b64 = body.get("mask") or ""
    prompt = body.get("prompt", "") or ""
    backend = (body.get("backend") or "runninghub").strip().lower()
    site = body.get("site") or None
    api_key = body.get("apiKey") or None
    comfyui_url = body.get("comfyuiUrl") or "http://127.0.0.1:8188"
    needs_mask = body.get("needsMask", True)
    workflow_id = body.get("workflowId") or None
    workflow_file = body.get("workflowFile") or None
    extra_set_args = body.get("extraSetArgs") or []
    image_node_id = body.get("imageNodeId") or None

    import uuid
    task_id = str(uuid.uuid4())[:8]

    if not image_b64:
        return cors(web.json_response(
            {"error": "MISSING", "message": "缺少 image 字段"}, status=400))
    if needs_mask and not mask_b64:
        return cors(web.json_response(
            {"error": "MISSING", "message": "此工作流需要 mask (选区蒙版)"}, status=400))

    tmp = Path(tempfile.mkdtemp(prefix="comfyps_"))
    try:
        img_path = tmp / "image.png"
        out_dir = tmp / "out"
        out_dir.mkdir(exist_ok=True)
        write_b64_png(image_b64, img_path)

        mask_path = tmp / "mask.png"
        if needs_mask and mask_b64:
            write_b64_png(mask_b64, mask_path)

        loop = asyncio.get_event_loop()

        if backend == "comfyui":
            result_bytes = await loop.run_in_executor(
                None,
                lambda: run_comfyui_blocking(img_path, mask_path if needs_mask else None, out_dir, prompt, comfyui_url),
            )
        else:
            result_bytes = await loop.run_in_executor(
                None,
                lambda: run_inpaint_blocking(
                    img_path, mask_path if needs_mask else None, out_dir,
                    prompt, api_key, site, needs_mask, workflow_id, workflow_file,
                    extra_set_args, image_node_id, task_id,
                ),
            )

        resp = web.Response(body=result_bytes, content_type="image/png")
        resp.headers["X-Task-Id"] = task_id
        return cors(resp)
    except RhCliError as e:
        return cors(web.json_response(
            {"error": getattr(e, "code", "RH_ERROR"), "message": getattr(e, "message", str(e))},
            status=500))
    except Exception as e:
        return cors(web.json_response({"error": "BRIDGE_ERROR", "message": str(e)}, status=500))
    finally:
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


def main():
    global CONFIG
    CONFIG = load_config()
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_post("/run", handle_run)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/progress", handle_progress)
    app.router.add_post("/restart", handle_restart)
    app.router.add_post("/test-key", handle_test_key)
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_options)

    port = int(CONFIG["port"])
    print(f"# ComfyPS 桥启动: http://127.0.0.1:{port}")
    print(f"#   workflowId={CONFIG['workflowId']}  image={CONFIG['imageNodeId']}  mask={CONFIG['maskNodeId']}")
    print(f"#   workflow={CONFIG['workflowFile']}")
    web.run_app(app, host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
