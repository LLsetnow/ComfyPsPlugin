#!/usr/bin/env python
"""
ComfyPS 本地桥
--------------
Photoshop 插件(UXP)无法直接执行命令并抓 stdout,所以由这个小服务代劳:
  插件 POST /run { image, mask }(都是 base64 PNG)
    → 解码两张图
    → 用 RunningHub CLI(RH_CLI)的 Python 接口跑 inpaint 工作流:
        · 输入图  → run_workflow 的 -i,自动上传并注入 imageNodeId
        · 蒙版    → 桥预先上传拿 fileName,再 --set maskNodeId:image=fileName
    → 把工作流返回的整图字节回传给插件

密钥不经过插件:RH_CLI 自己从 ~/.config/rh/config.toml 读 API Key。

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

UPLOAD_URL = f"{BASE_URL}/media/upload/binary"  # 与 run_workflow 上传输入图同端点


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
    # workflowFile 相对路径按 config.json 所在目录解析
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


def upload_mask(mask_path: Path) -> str:
    """把蒙版按 run_workflow 同样的方式上传,返回 fileName。"""
    resolved = require_api_key(None)  # 从 ~/.config/rh/config.toml 读 key
    api_key = resolved.value
    with RhHttpClient(api_key) as client:
        resp = client.upload_form(
            UPLOAD_URL,
            str(mask_path),
            data={},
            headers={"Authorization": f"Bearer {api_key}"},
        )
    if resp.get("code") != 0:
        raise RuntimeError(f"蒙版上传失败:{resp.get('msg', resp)}")
    file_name = resp.get("data", {}).get("fileName")
    if not file_name:
        raise RuntimeError("蒙版上传成功但响应无 fileName")
    return str(file_name)


def _text_field_of(node: dict):
    """返回该节点里可写提示词的字段名(text/prompt/…),没有返回 None。"""
    inputs = node.get("inputs", {}) or {}
    for f in ("text", "prompt", "positive", "string", "text_g"):
        if f in inputs and isinstance(inputs[f], str):
            return f
    return None


def find_positive_prompt_target(workflow: dict):
    """自动判断正向提示词应写入的 (node_id, field)。三级策略,找不到返回 None。"""
    # 1) 标题含 positive/正 的文本节点优先;顺便收集非 negative 的候选
    candidates = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        field = _text_field_of(node)
        if not field:
            continue
        title = str((node.get("_meta") or {}).get("title", ""))
        if re.search(r"negative|负向|负面|\bneg\b", title, re.I):
            continue  # 明确是负向,排除
        if re.search(r"positive|正向|正面|\bpos\b", title, re.I):
            return (nid, field)
        candidates.append((nid, field))

    # 2) 顺着任意 sampler 的 positive 输入回溯到文本编码节点
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

    # 3) 排除负向后只剩一个文本节点 → 就是它
    if len(candidates) == 1:
        return candidates[0]
    return None


def resolve_prompt_target(cfg: dict, workflow: dict):
    """config 里显式指定优先,否则自动检测。返回 (node_id, field) 或 None。"""
    explicit = str(cfg.get("promptNodeId", "")).strip()
    if explicit:
        return (explicit, str(cfg.get("promptField", "") or "text"))
    return find_positive_prompt_target(workflow)


def run_inpaint_blocking(image_path: Path, mask_path: Path, out_dir: Path, prompt: str = "") -> bytes:
    """阻塞流程:上传蒙版 → (可选注入提示词) → 跑工作流 → 读结果字节。丢到线程池执行。"""
    cfg = CONFIG
    mask_file_name = upload_mask(mask_path)
    set_args = [f"{cfg['maskNodeId']}:{cfg['maskField']}={mask_file_name}"]
    # 我们的蒙版是黑白 RGB(无 alpha);若蒙版节点是 LoadImageMask 且默认读 alpha,
    # 通过 maskChannel 改为 red 才能正确读到黑白蒙版。
    if cfg.get("maskChannel"):
        set_args.append(f"{cfg['maskNodeId']}:channel={cfg['maskChannel']}")

    if prompt and prompt.strip():
        workflow = json.loads(Path(cfg["workflowFile"]).read_text(encoding="utf-8"))
        target = resolve_prompt_target(cfg, workflow)
        if target:
            node_id, field = target
            # 因走 Python 接口(非 shell),提示词含引号/冒号/换行均安全
            set_args.append(f"{node_id}:{field}={prompt}")
            print(f"# 提示词注入 → [{node_id}].{field}")
        else:
            print("# ⚠️ 未能自动判断 positive 提示词节点,已跳过注入(可在 config 填 promptNodeId)")

    result = run_workflow(
        api_key_arg=None,
        workflow_file=cfg["workflowFile"],
        workflow_id=str(cfg["workflowId"]),
        input_image=str(image_path),
        load_image_node=str(cfg["imageNodeId"]),
        output=None,
        output_dir=out_dir,
        set_args=set_args,
    )
    if not result.files:
        raise RuntimeError("工作流没有返回任何输出文件")
    return Path(result.files[0]).read_bytes()


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


async def handle_run(request):
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response({"error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400))

    image_b64 = body.get("image")
    mask_b64 = body.get("mask")
    prompt = body.get("prompt", "") or ""
    if not image_b64 or not mask_b64:
        return cors(web.json_response(
            {"error": "MISSING", "message": "缺少 image 或 mask 字段"}, status=400))

    tmp = Path(tempfile.mkdtemp(prefix="comfyps_"))
    try:
        img_path = tmp / "image.png"
        mask_path = tmp / "mask.png"
        out_dir = tmp / "out"
        out_dir.mkdir(exist_ok=True)
        write_b64_png(image_b64, img_path)
        write_b64_png(mask_b64, mask_path)

        loop = asyncio.get_event_loop()
        result_bytes = await loop.run_in_executor(
            None, run_inpaint_blocking, img_path, mask_path, out_dir, prompt
        )
        resp = web.Response(body=result_bytes, content_type="image/png")
        return cors(resp)
    except RhCliError as e:
        return cors(web.json_response(
            {"error": getattr(e, "code", "RH_ERROR"), "message": getattr(e, "message", str(e))},
            status=500))
    except Exception as e:
        return cors(web.json_response({"error": "BRIDGE_ERROR", "message": str(e)}, status=500))
    finally:
        # 清理临时文件(结果字节已读入内存)
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


def main():
    global CONFIG
    CONFIG = load_config()
    app = web.Application(client_max_size=64 * 1024 * 1024)  # 允许较大 base64 body
    app.router.add_post("/run", handle_run)
    app.router.add_get("/health", handle_health)
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_options)

    port = int(CONFIG["port"])
    print(f"# ComfyPS 桥启动:http://127.0.0.1:{port}")
    print(f"#   workflowId={CONFIG['workflowId']}  image={CONFIG['imageNodeId']}  mask={CONFIG['maskNodeId']}")
    print(f"#   workflow={CONFIG['workflowFile']}")
    web.run_app(app, host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
