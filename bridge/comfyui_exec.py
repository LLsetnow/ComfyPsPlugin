"""comfyui_exec — RunningHub / 本地 ComfyUI 工作流执行（阻塞式，跑在线程里）。"""

import asyncio
import base64
import binascii
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import zlib
from pathlib import Path

from aiohttp import ClientError, ClientSession, ClientTimeout, FormData, web

import inspect

from rh_cli.config import require_api_key
from rh_cli.errors import RhCliError
from rh_cli.http import BASE_URL, RhHttpClient
from rh_cli.workflow.client import run_workflow

try:
    from bridge_common import bridge_log, _task_progress, _task_result_masks, _rh_cancel_events, BRIDGE_DIR, get_rh_base_url, CONFIG, is_grayscale_png
    from workflow_runtime import apply_set_args
except ImportError:
    from bridge.bridge_common import bridge_log, _task_progress, _task_result_masks, _rh_cancel_events, BRIDGE_DIR, get_rh_base_url, CONFIG, is_grayscale_png
    from bridge.workflow_runtime import apply_set_args


_RUN_WORKFLOW_SUPPORTS_CANCEL = "cancel_event" in inspect.signature(run_workflow).parameters

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
    mask_node_id: str | None = None,
    task_id: str | None = None,
    cancel_event: threading.Event | None = None,
    mask_output_node_id: str | None = None,
) -> tuple[bytes, str | None, str | None]:
    """RunningHub 模式: 上传蒙版(可选) → 注入提示词 → 跑工作流 → 读结果字节。

    当 mask_output_node_id 提供时，工作流会额外保存一张蒙版图（如背景去杂物的
    节点 239）。RunningHub 的输出只按顺序返回文件、不带节点号，故用灰度检测从
    多个输出中挑出蒙版图，暂存到 _task_result_masks[task_id] 供插件拉取。"""
    cfg = CONFIG
    wf_id = str(workflow_id or cfg["workflowId"])
    # 选择工作流文件: 请求传入的相对路径 > 配置的默认文件
    if workflow_file and workflow_file.strip():
        wf_file = str((BRIDGE_DIR / workflow_file.strip()).resolve())
    else:
        wf_file = cfg["workflowFile"]
    set_args = []
    mask_node = str(mask_node_id or cfg["maskNodeId"])

    # 蒙版上传 (仅需要蒙版的工作流)
    if needs_mask and mask_path:
        mask_file_name = upload_mask(mask_path, api_key=api_key, site=site)
        set_args.append(f"{mask_node}:{cfg['maskField']}={mask_file_name}")
        if cfg.get("maskChannel"):
            set_args.append(f"{mask_node}:channel={cfg['maskChannel']}")

    # 提示词注入
    if prompt and prompt.strip():
        workflow = json.loads(Path(wf_file).read_text(encoding="utf-8"))
        target = resolve_prompt_target(cfg, workflow)
        if target:
            node_id, field = target
            set_args.append(f"{node_id}:{field}={prompt}")
            bridge_log(f"# 提示词注入 → [{node_id}].{field}")
        else:
            bridge_log("# ⚠️ 未能自动判断 positive 提示词节点,已跳过注入(可在 config 填 promptNodeId)", "warn")

    # 插件传入的额外参数 (如 denoise 等)
    if extra_set_args:
        for arg in extra_set_args:
            set_args.append(str(arg))
            bridge_log(f"# 额外参数注入 → {arg}")

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

    rw_kwargs = dict(
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
    if _RUN_WORKFLOW_SUPPORTS_CANCEL and cancel_event is not None:
        rw_kwargs["cancel_event"] = cancel_event

    _SSL_ERRS = ("SSL", "EOF", "ConnectionReset", "RemoteDisconnected", "BrokenPipe")
    _MAX_RETRIES = 3
    last_exc = None
    for _attempt in range(_MAX_RETRIES):
        if cancel_event and cancel_event.is_set():
            raise RhCliError("TASK_CANCELLED", "任务已取消")
        try:
            result = run_workflow(**rw_kwargs)
            break
        except Exception as _e:
            _emsg = str(_e)
            if any(k in _emsg for k in _SSL_ERRS):
                last_exc = _e
                _wait = 2 ** _attempt  # 1s, 2s, 4s
                if task_id:
                    _task_progress[task_id] = {
                        "elapsed": 0,
                        "message": "网络错误，{}s 后重试({}/{})…".format(_wait, _attempt + 1, _MAX_RETRIES),
                        "percent": 0,
                    }
                import time as _time
                _time.sleep(_wait)
            else:
                raise
    else:
        raise RuntimeError("网络连接失败（已重试 {} 次）: {}".format(_MAX_RETRIES, last_exc))

    if task_id:
        _task_progress[task_id] = {"elapsed": -1, "message": "完成", "percent": 100}
        # 延迟清理
        import threading as _th
        _th.Timer(60, lambda: _task_progress.pop(task_id, None)).start()
    if not result.files:
        raise RuntimeError("工作流没有返回任何输出文件")
    cost_type = getattr(result, "cost_type", None)
    cost = getattr(result, "cost", None)
    if cost_type not in ("coins", "money") or cost is None or not str(cost).strip():
        cost_type, cost = None, None
    else:
        cost = str(cost).strip()

    all_bytes = [Path(f).read_bytes() for f in result.files]
    result_bytes = all_bytes[0]
    if mask_output_node_id and len(all_bytes) >= 2:
        # RunningHub 不带节点号：结果图是彩色照片、蒙版图是灰度，用灰度检测区分。
        mask_bytes = None
        result_bytes = None
        for b in all_bytes:
            if mask_bytes is None and is_grayscale_png(b):
                mask_bytes = b
            elif result_bytes is None:
                result_bytes = b
        if result_bytes is None:  # 检测失败（都判为灰度/都非灰度）→ 退回顺序
            result_bytes = all_bytes[0]
            mask_bytes = all_bytes[1]
        if task_id and mask_bytes is not None:
            _task_result_masks[task_id] = mask_bytes
            bridge_log("# 已捕获返回蒙版 → task=" + str(task_id))
    return result_bytes, cost_type, cost


def run_comfyui_blocking(
    image_path: Path,
    mask_path: Path | None,
    out_dir: Path,
    prompt: str = "",
    comfyui_url: str = "http://127.0.0.1:8188",
    workflow_file: str | None = None,
    extra_set_args: list[str] | None = None,
    image_node_id: str | None = None,
    mask_node_id: str | None = None,
    output_node_id: str | None = None,
    prompt_node_id: str | None = None,
    prompt_field: str | None = None,
    mask_output_node_id: str | None = None,
    task_id: str | None = None,
) -> bytes:
    """本地 ComfyUI 模式: 加载工作流 JSON → 注入 image/mask → 提交 → 轮询 → 返回结果图。

    当 mask_output_node_id 提供时，额外按节点号读取该节点输出的蒙版图，暂存到
    _task_result_masks[task_id] 供插件作为返回图层的图层蒙版。"""
    import urllib.request
    import urllib.error

    cfg = CONFIG
    if workflow_file and str(workflow_file).strip():
        requested_file = Path(str(workflow_file).strip()).expanduser()
        wf_file = requested_file if requested_file.is_absolute() else (BRIDGE_DIR / requested_file).resolve()
    else:
        wf_file = Path(cfg["workflowFile"])
    wf = json.loads(wf_file.read_text(encoding="utf-8"))

    # 编码 image 和可选 mask 为 base64 并注入到对应节点
    img_b64 = base64.b64encode(image_path.read_bytes()).decode()
    img_node = str(image_node_id or cfg["imageNodeId"])

    # 尝试注入 image (适配 LoadImage 节点的常见字段名)
    _inject_image_input(wf, img_node, img_b64)
    if mask_path is not None and mask_node_id:
        mask_b64 = base64.b64encode(mask_path.read_bytes()).decode()
        _inject_image_input(wf, str(mask_node_id), mask_b64)

    # 注入 prompt
    if prompt and prompt.strip():
        if prompt_node_id and prompt_field:
            target = (str(prompt_node_id), str(prompt_field))
        else:
            target = resolve_prompt_target(cfg, wf)
        if target:
            node_id, field = target
            if node_id in wf and "inputs" in wf[node_id]:
                wf[node_id]["inputs"][field] = prompt.strip()
            else:
                raise RuntimeError("ComfyUI 工作流缺少提示词节点或字段")

    apply_set_args(wf, extra_set_args)

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
            def _download_node_image(node_id):
                node_out = outputs.get(str(node_id)) if node_id else None
                if not isinstance(node_out, dict):
                    return None
                images = node_out.get("images")
                if not images:
                    return None
                img_file = images[0]
                file_name = img_file.get("filename", "result.png")
                subfolder = img_file.get("subfolder", "")
                dl_url = f"{comfyui_url.rstrip('/')}/view?filename={file_name}&subfolder={subfolder}"
                with urllib.request.urlopen(dl_url, timeout=10) as dl_resp:
                    return dl_resp.read()

            if output_node_id:
                result_bytes = _download_node_image(output_node_id)
            else:
                result_bytes = None
                for node_id in outputs:
                    result_bytes = _download_node_image(node_id)
                    if result_bytes is not None:
                        break
            if result_bytes is not None:
                if mask_output_node_id and task_id:
                    mask_bytes = _download_node_image(mask_output_node_id)
                    if mask_bytes is not None:
                        _task_result_masks[task_id] = mask_bytes
                        bridge_log("# 已捕获返回蒙版 → task=" + str(task_id))
                return result_bytes
            if output_node_id:
                raise RuntimeError("ComfyUI 未返回指定输出节点的图片")
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
    bridge_log(f"# ⚠️ 节点 {node_id} 没有可写入的图片字段, 跳过注入", "warn")
