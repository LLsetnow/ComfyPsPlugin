"""bridge_common — 桥的基础层：共享状态 / 日志 / 配置 / 通用编解码。
被 gpt_image / comfyui_exec / bridge 复用，自身不依赖它们（无循环导入）。"""

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

from rh_cli.http import BASE_URL


_BRIDGE_LOG_MAX_ENTRIES = 300
# 启动时由 load_config() 就地填充；保持同一个 dict 对象，
# 这样各模块 `from bridge_common import CONFIG` 拿到的都是同一份实时配置。
CONFIG = {}

BRIDGE_DIR = Path(__file__).resolve().parent

RH_SITES = {
    "ai": "https://www.runninghub.ai",
    "cn": "https://www.runninghub.cn",
}

DEFAULT_RH_SITE = "ai"

# 任务进度 (task_id → {percent, status})
_task_progress: dict[str, dict] = {}
# 当前桥进程的内存日志，供插件日志页按序号增量读取。
_BRIDGE_LOG_MAX_ENTRIES = 300
_bridge_log_entries: list[dict] = []
_bridge_log_sequence = 0

_rh_cancel_events: dict[str, threading.Event] = {}

def bridge_log(message: str, level: str = "info"):
    """记录一条不含密钥/图片内容的桥日志，并保留原有终端输出。"""
    global _bridge_log_sequence
    _bridge_log_sequence += 1
    _bridge_log_entries.append({
        "id": _bridge_log_sequence,
        "ts": int(time.time() * 1000),
        "level": level,
        "source": "桥",
        "message": str(message),
    })
    if len(_bridge_log_entries) > _BRIDGE_LOG_MAX_ENTRIES:
        del _bridge_log_entries[:-_BRIDGE_LOG_MAX_ENTRIES]
    print(str(message), flush=True)

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
    cfg.setdefault("maskChannel", "red")  # 插件保存 RGB PNG，用 red 通道：白=1.0=编辑区，黑=0.0=保留区
    cfg.setdefault("port", 8765)
    return cfg

def strip_data_uri(b64: str) -> str:
    m = re.match(r"^data:[^;]+;base64,(.*)$", b64, re.IGNORECASE | re.DOTALL)
    return m.group(1) if m else b64


def write_b64_png(b64: str, path: Path):
    path.write_bytes(base64.b64decode(strip_data_uri(b64).strip()))

def cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Expose-Headers"] = (
        "X-Task-Id, X-ComfyPS-Local-Validation, "
        "X-ComfyPS-Task-Cost-Type, X-ComfyPS-Task-Cost"
    )
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


def log_snapshot(since):
    """返回 (id>since 的日志条目, 最新序号)。供 handle_logs 跨模块读取，避免导入到过期的整数。"""
    entries = [entry for entry in _bridge_log_entries if entry["id"] > since]
    return entries, _bridge_log_sequence
