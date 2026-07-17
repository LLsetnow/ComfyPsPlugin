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
# 任务的额外输出蒙版 (task_id → PNG bytes)。某些工作流(如背景去杂物)除结果图外
# 还会返回一张蒙版图(节点 239)，桥把它暂存于此，插件通过 GET /result-mask 拉取，
# 再作为返回图层的图层蒙版。由 handle_run 设置、定时清理。
_task_result_masks: dict[str, bytes] = {}
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

def _png_unfilter(line: bytearray, prev: bytearray, filter_type: int, bpp: int) -> None:
    """就地反滤波一行 PNG 扫描线（滤波类型 0-4，非隔行）。"""
    stride = len(line)
    if filter_type == 0:
        return
    for i in range(stride):
        a = line[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        x = line[i]
        if filter_type == 1:      # Sub
            line[i] = (x + a) & 0xFF
        elif filter_type == 2:    # Up
            line[i] = (x + b) & 0xFF
        elif filter_type == 3:    # Average
            line[i] = (x + ((a + b) >> 1)) & 0xFF
        elif filter_type == 4:    # Paeth
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = (x + pr) & 0xFF
        else:
            raise ValueError("bad PNG filter")


def is_grayscale_png(data: bytes, sample_rows: int = 96) -> bool:
    """判断 PNG 是否为灰度图（每个像素 R==G==B）。仅支持 8-bit、非隔行的
    灰度(0/4) 与 RGB(2)/RGBA(6)；无法解码或格式不支持时返回 False。
    用于 RunningHub 多输出场景里区分「结果图(彩色照片)」与「蒙版图(灰度)」——
    彩色图会在前几行就命中非灰度像素而快速返回，蒙版图则抽样前若干行确认。"""
    try:
        if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        width, height, bit_depth, color_type = struct.unpack(">IIBB", data[16:26])
        if bit_depth != 8 or width <= 0 or height <= 0:
            return False
        if color_type in (0, 4):
            return True  # 本身即灰度（可含 alpha）
        if color_type not in (2, 6):
            return False
        channels = 4 if color_type == 6 else 3
        idat = bytearray()
        interlace = None
        pos = 8
        while pos + 8 <= len(data):
            length = struct.unpack(">I", data[pos:pos + 4])[0]
            ctype = data[pos + 4:pos + 8]
            start = pos + 8
            end = start + length
            if end + 4 > len(data):
                break
            if ctype == b"IHDR" and length >= 13:
                interlace = data[start + 12]
            elif ctype == b"IDAT":
                idat += data[start:end]
            elif ctype == b"IEND":
                break
            pos = end + 4  # 数据 + CRC
        if interlace not in (0, None):
            return False
        raw = zlib.decompress(bytes(idat))
        stride = width * channels
        rows = min(height, max(1, sample_rows))
        if len(raw) < (stride + 1) * rows:
            return False
        prev = bytearray(stride)
        offset = 0
        for _y in range(rows):
            f = raw[offset]
            line = bytearray(raw[offset + 1:offset + 1 + stride])
            offset += 1 + stride
            _png_unfilter(line, prev, f, channels)
            # 字节切片比较走 C 层，快；R/G/B 分量任一不等即非灰度。
            if line[0::channels] != line[1::channels] or line[0::channels] != line[2::channels]:
                return False
            prev = line
        return True
    except Exception:
        return False


def cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Expose-Headers"] = (
        "X-Task-Id, X-ComfyPS-Local-Validation, "
        "X-ComfyPS-Task-Cost-Type, X-ComfyPS-Task-Cost, X-ComfyPS-Has-Mask"
    )
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return resp


def log_snapshot(since):
    """返回 (id>since 的日志条目, 最新序号)。供 handle_logs 跨模块读取，避免导入到过期的整数。"""
    entries = [entry for entry in _bridge_log_entries if entry["id"] > since]
    return entries, _bridge_log_sequence
