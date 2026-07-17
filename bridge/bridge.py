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

try:
    from aigate_native import (
        AigateNativeError, close_aigate_instances, control_aigate_instance,
        create_aigate_instance, get_aigate_account, list_aigate_skus,
        list_instance_summaries, run_native_inpaint,
    )
except ImportError:
    from bridge.aigate_native import (
        AigateNativeError, close_aigate_instances, control_aigate_instance,
        create_aigate_instance, get_aigate_account, list_aigate_skus,
        list_instance_summaries, run_native_inpaint,
    )

try:
    import rh_cli  # noqa: F401
except ImportError:
    raise SystemExit(
        "\u274c \u672a\u5b89\u88c5 rh_cli\u3002\u8bf7\u8fd0\u884c:\n"
        "   pip install git+https://github.com/LLsetnow/RH_CLI.git"
    )

from rh_cli.config import require_api_key
from rh_cli.errors import RhCliError
from rh_cli.http import BASE_URL, RhHttpClient

try:
    from bridge_common import bridge_log, _task_progress, _rh_cancel_events, log_snapshot, cors, BRIDGE_DIR, RH_SITES, DEFAULT_RH_SITE, get_rh_base_url, write_b64_png, CONFIG, load_config
    from comfyui_exec import run_inpaint_blocking, run_comfyui_blocking
    from gpt_image import GPT_IMAGE_REQUEST_MAX_BYTES, handle_codex_status, handle_codex_image, handle_gpt_image, handle_gpt_image_cancel, handle_gpt_image_status
except ImportError:
    from bridge.bridge_common import bridge_log, _task_progress, _rh_cancel_events, log_snapshot, cors, BRIDGE_DIR, RH_SITES, DEFAULT_RH_SITE, get_rh_base_url, write_b64_png, CONFIG, load_config
    from bridge.comfyui_exec import run_inpaint_blocking, run_comfyui_blocking
    from bridge.gpt_image import GPT_IMAGE_REQUEST_MAX_BYTES, handle_codex_status, handle_codex_image, handle_gpt_image, handle_gpt_image_cancel, handle_gpt_image_status


_aigate_managed_tokens: dict[str, str] = {}
_aigate_create_lock = asyncio.Lock()

async def handle_options(request):
    return cors(web.Response(status=204))


async def handle_health(request):
    return cors(web.json_response({"ok": True, "workflowId": CONFIG["workflowId"]}))


async def handle_progress(request):
    task_id = request.query.get("taskId", "")
    if not task_id or task_id not in _task_progress:
        return cors(web.json_response({"percent": 0, "message": "未知任务"}, status=404))
    return cors(web.json_response(_task_progress[task_id]))


async def handle_logs(request):
    """返回桥进程内存日志；since 用于插件增量轮询。"""
    try:
        since = max(0, int(request.query.get("since", "0")))
    except (TypeError, ValueError):
        since = 0
    entries, latest = log_snapshot(since)
    return cors(web.json_response({
        "entries": entries,
        "latest": latest,
    }))


async def restart_after_aigate_cleanup():
    """等待重启响应送达后清理受管实例，再原地替换桥进程。"""
    await asyncio.sleep(0.3)
    try:
        await cleanup_managed_aigate_instances(None)
    except Exception:
        bridge_log("# 云扉重启清理失败", "error")
    os.execv(sys.executable, [sys.executable] + sys.argv)


async def handle_restart(request):
    """重启桥进程前尽力关闭受管云扉实例。"""
    asyncio.create_task(restart_after_aigate_cleanup())
    return cors(web.json_response({"ok": True, "message": "bridge restarting"}))


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


def normalize_comfyui_url(value: str) -> str:
    """验证并规范化用户输入的 ComfyUI 根地址。"""
    url = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if not url:
        raise ValueError("请输入 ComfyUI 地址")
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("ComfyUI 地址必须以 http:// 或 https:// 开头")
    if parsed.query or parsed.fragment:
        raise ValueError("ComfyUI 地址不能包含查询参数或片段")
    return url


async def handle_test_comfyui(request):
    """确认本地桥可访问指定 ComfyUI 的系统状态接口，不提交任务。"""
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response(
            {"ok": False, "status": 0, "message": "请求体不是 JSON"}, status=400))

    try:
        comfyui_url = normalize_comfyui_url(body.get("comfyuiUrl"))
    except ValueError as error:
        return cors(web.json_response(
            {"ok": False, "status": 0, "message": str(error)}, status=400))

    status = 0
    try:
        async with ClientSession(timeout=ClientTimeout(total=5)) as session:
            async with session.get(
                comfyui_url + "/system_stats", allow_redirects=False
            ) as response:
                status = response.status
                if not 200 <= status < 300:
                    return cors(web.json_response(
                        {"ok": False, "status": status,
                         "message": "ComfyUI 返回 HTTP " + str(status)}, status=502))
                data = await response.json(content_type=None)
    except asyncio.TimeoutError:
        return cors(web.json_response(
            {"ok": False, "status": 0, "message": "连接 ComfyUI 超时（5 秒）"}, status=502))
    except ClientError as error:
        return cors(web.json_response(
            {"ok": False, "status": 0, "message": "无法连接 ComfyUI: " + str(error)}, status=502))
    except (TypeError, ValueError, UnicodeDecodeError):
        return cors(web.json_response(
            {"ok": False, "status": status, "message": "ComfyUI 返回了无效响应"}, status=502))

    if not isinstance(data, dict):
        return cors(web.json_response(
            {"ok": False, "status": status, "message": "ComfyUI 返回了无效响应"}, status=502))

    system = data.get("system") if isinstance(data.get("system"), dict) else {}
    version = str(system.get("comfyui_version") or data.get("comfyui_version") or "")
    return cors(web.json_response({"ok": True, "status": status, "version": version}))


async def read_aigate_request(request):
    """读取云扉请求 JSON 与 Token，并保持统一的安全错误响应。"""
    try:
        body = await request.json()
    except Exception:
        return None, "", cors(web.json_response(
            {"ok": False, "error": "BAD_JSON", "message": "请求体不是 JSON"},
            status=400,
        ))
    if not isinstance(body, dict):
        return None, "", cors(web.json_response(
            {"ok": False, "error": "BAD_JSON", "message": "请求体不是 JSON"},
            status=400,
        ))
    token = str(body.get("aigateToken") or "").strip()
    if not token:
        return body, "", cors(web.json_response(
            {"ok": False, "error": "AIGATE_TOKEN_REQUIRED",
             "message": "请输入云扉 Bearer Token"},
            status=400,
        ))
    return body, token, None


def get_aigate_create_config():
    """读取本机预设 ComfyUI 镜像配置；不让它成为桥启动的必填项。"""
    raw = CONFIG.get("aigateCreate")
    if not isinstance(raw, dict):
        raise AigateNativeError(
            "AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置预设 ComfyUI 镜像", 409
        )
    result = {
        "areaName": str(raw.get("areaName") or "").strip(),
        "imageId": raw.get("imageId"),
        "imageType": str(raw.get("imageType") or "").strip(),
    }
    if not result["areaName"] or not result["imageType"]:
        raise AigateNativeError(
            "AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置预设 ComfyUI 镜像", 409
        )
    return result


async def handle_aigate_account(request):
    """返回云扉账户的原始余额，绝不回显 Bearer Token。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as session:
            account = await get_aigate_account(token, session)
        return cors(web.json_response({
            "ok": True, **account, "updatedAt": int(time.time() * 1000),
        }))
    except AigateNativeError as error:
        return cors(web.json_response(
            {"ok": False, "error": error.code, "message": error.message},
            status=error.status,
        ))


async def handle_aigate_create_options(request):
    """返回本机区域中云扉可用 GPU 规格及其原始价格。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    try:
        config = get_aigate_create_config()
        async with ClientSession(timeout=ClientTimeout(total=15)) as session:
            options = await list_aigate_skus(token, config["areaName"], session)
        return cors(web.json_response({
            "ok": True, "options": options, "updatedAt": int(time.time() * 1000),
        }))
    except AigateNativeError as error:
        return cors(web.json_response(
            {"ok": False, "error": error.code, "message": error.message},
            status=error.status,
        ))


async def handle_aigate_create_instance(request):
    """仅当云扉控制台为空时，使用预设 ComfyUI 镜像创建实例。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    try:
        config = get_aigate_create_config()
        async with _aigate_create_lock:
            async with ClientSession(timeout=ClientTimeout(total=15)) as session:
                instances = await list_instance_summaries(token, session)
                if instances:
                    raise AigateNativeError(
                        "AIGATE_INSTANCE_EXISTS", "云扉控制台已有实例，不能重复创建", 409
                    )
                result = await create_aigate_instance(
                    token, body.get("skuName"), config, session
                )
            _sync_aigate_managed_instances(token, [result["instanceId"]])
        return cors(web.json_response({"ok": True, "instance": result}))
    except AigateNativeError as error:
        return cors(web.json_response(
            {"ok": False, "error": error.code, "message": error.message},
            status=error.status,
        ))


async def handle_aigate_instances(request):
    """返回云扉实例的最小安全摘要，供设置页显示和控制。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    _sync_aigate_managed_instances(token, body.get("managedInstanceIds"))
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as session:
            instances = await list_instance_summaries(token, session)
        return cors(web.json_response({"ok": True, "instances": instances}))
    except AigateNativeError as e:
        return cors(web.json_response(
            {"ok": False, "error": e.code, "message": e.message}, status=e.status))


async def handle_aigate_instance_action(request):
    """启动、关闭或释放设置页指定的云扉实例。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    instance_id = (body.get("instanceId") or "").strip()
    action = (body.get("action") or "").strip().lower()
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as session:
            result = await control_aigate_instance(token, instance_id, action, session)
        if result["action"] == "open":
            _sync_aigate_managed_instances(token, [result["instanceId"]])
        elif result["action"] == "release":
            _aigate_managed_tokens.pop(result["instanceId"], None)
        return cors(web.json_response({"ok": True, **result}))
    except AigateNativeError as e:
        return cors(web.json_response(
            {"ok": False, "error": e.code, "message": e.message}, status=e.status))


def _managed_aigate_ids(values):
    """规范化面板传来的受管实例 ID，拒绝非数组值。"""
    if not isinstance(values, list):
        return []
    result = []
    for value in values:
        instance_id = str(value or "").strip()
        if instance_id and instance_id not in result:
            result.append(instance_id)
    return result


def _sync_aigate_managed_instances(token, instance_ids):
    """把当前面板已知的受管实例与 Token 只登记在本进程内。"""
    for instance_id in _managed_aigate_ids(instance_ids):
        _aigate_managed_tokens[instance_id] = token


async def handle_aigate_close_managed(request):
    """正常关闭插件时尽力关闭该面板登记的云扉实例，不释放实例。"""
    body, token, error_response = await read_aigate_request(request)
    if error_response:
        return error_response
    instance_ids = _managed_aigate_ids(body.get("managedInstanceIds"))
    _sync_aigate_managed_instances(token, instance_ids)
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as session:
            result = await close_aigate_instances(token, instance_ids, session)
        return cors(web.json_response({"ok": True, **result}))
    except AigateNativeError as e:
        return cors(web.json_response(
            {"ok": False, "error": e.code, "message": e.message}, status=e.status))


async def cleanup_managed_aigate_instances(app):
    """桥正常 shutdown 时按 Token 分组并发关闭所有内存登记的实例。"""
    grouped = {}
    for instance_id, token in list(_aigate_managed_tokens.items()):
        grouped.setdefault(token, []).append(instance_id)
    _aigate_managed_tokens.clear()
    if not grouped:
        return
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        for token, instance_ids in grouped.items():
            try:
                await close_aigate_instances(token, instance_ids, session)
            except Exception:
                bridge_log("# 云扉退出清理失败", "error")


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
    aigate_token = body.get("aigateToken") or ""
    needs_mask = body.get("needsMask", True)
    workflow_id = body.get("workflowId") or None
    workflow_file = body.get("workflowFile") or None
    extra_set_args = body.get("extraSetArgs") or []
    image_node_id = body.get("imageNodeId") or None
    mask_node_id = body.get("maskNodeId") or None

    task_id = body.get("taskId") or str(uuid.uuid4())[:8]

    if not image_b64:
        return cors(web.json_response(
            {"error": "MISSING", "message": "缺少 image 字段"}, status=400))
    if needs_mask and not mask_b64:
        return cors(web.json_response(
            {"error": "MISSING", "message": "此工作流需要 mask (选区蒙版)"}, status=400))
    if backend == "aigate":
        if not str(aigate_token).strip():
            return cors(web.json_response(
                {"error": "AIGATE_TOKEN_REQUIRED", "message": "请输入云扉 Bearer Token"}, status=400))
        if not needs_mask:
            return cors(web.json_response(
                {"error": "AIGATE_WORKFLOW_UNSUPPORTED", "message": "云扉原生后端目前仅支持 Boogu 局部编辑"},
                status=400))

    bridge_log(
        "# 工作流提交 → task=" + str(task_id) + " backend=" + backend
        + " mask=" + ("yes" if needs_mask else "no")
    )

    tmp = Path(tempfile.mkdtemp(prefix="comfyps_"))
    try:
        img_path = tmp / "image.png"
        out_dir = tmp / "out"
        out_dir.mkdir(exist_ok=True)
        write_b64_png(image_b64, img_path)

        mask_path = tmp / "mask.png"
        if needs_mask and mask_b64:
            write_b64_png(mask_b64, mask_path)
            # debug: 保留一份供检查，下次运行时覆盖
            import shutil as _sh
            _sh.copy2(mask_path, BRIDGE_DIR / "debug_last_mask.png")

        loop = asyncio.get_event_loop()
        task_cost_type = None
        task_cost = None

        if backend == "aigate":
            workflow_path = (BRIDGE_DIR / "../workflows/inpaint_boogu_api.json").resolve()

            def aigate_progress(message):
                _task_progress[task_id] = {"percent": 50, "message": str(message)}

            async with ClientSession(timeout=ClientTimeout(total=195)) as session:
                result_bytes = await run_native_inpaint(
                    aigate_token, img_path, mask_path, prompt, task_id, workflow_path,
                    aigate_progress, session,
                )
        elif backend == "comfyui":
            result_bytes = await loop.run_in_executor(
                None,
                lambda: run_comfyui_blocking(img_path, mask_path if needs_mask else None, out_dir, prompt, comfyui_url),
            )
        else:
            cancel_event = threading.Event()
            _rh_cancel_events[task_id] = cancel_event
            try:
                result_bytes, task_cost_type, task_cost = await loop.run_in_executor(
                    None,
                    lambda: run_inpaint_blocking(
                        img_path, mask_path if needs_mask else None, out_dir,
                        prompt, api_key, site, needs_mask, workflow_id, workflow_file,
                        extra_set_args, image_node_id, mask_node_id, task_id, cancel_event,
                    ),
                )
            finally:
                _rh_cancel_events.pop(task_id, None)

        resp = web.Response(body=result_bytes, content_type="image/png")
        resp.headers["X-Task-Id"] = task_id
        if task_cost_type in ("coins", "money") and task_cost:
            resp.headers["X-ComfyPS-Task-Cost-Type"] = task_cost_type
            resp.headers["X-ComfyPS-Task-Cost"] = task_cost
        bridge_log("# 工作流完成 ← task=" + str(task_id))
        return cors(resp)
    except AigateNativeError as e:
        bridge_log("# 工作流失败 ← task=" + str(task_id) + " " + e.message, "error")
        return cors(web.json_response(
            {"error": e.code, "message": e.message}, status=e.status))
    except RhCliError as e:
        code = getattr(e, "code", "RH_ERROR")
        bridge_log("# 工作流失败 ← task=" + str(task_id) + " " + str(getattr(e, "message", e)), "error")
        http_status = 499 if code == "TASK_CANCELLED" else 500
        return cors(web.json_response(
            {"error": code, "message": getattr(e, "message", str(e))},
            status=http_status))
    except Exception as e:
        bridge_log("# 工作流失败 ← task=" + str(task_id) + " " + str(e), "error")
        return cors(web.json_response({"error": "BRIDGE_ERROR", "message": str(e)}, status=500))
    finally:
        _rh_cancel_events.pop(task_id, None)
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


async def handle_cancel(request):
    """取消 RunningHub 任务（设置取消事件，由轮询线程负责调用 RunningHub cancel API）。"""
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response({"ok": False, "message": "BAD_JSON"}, status=400))
    task_id = body.get("taskId", "")
    event = _rh_cancel_events.get(task_id)
    if event:
        event.set()
        return cors(web.json_response({"ok": True}))
    return cors(web.json_response({"ok": False, "message": "task not found or already completed"}))

def main():
    # 就地更新共享的 CONFIG dict（而非重新赋值），
    # 以便 comfyui_exec / gpt_image 中 from bridge_common import CONFIG 拿到实时配置。
    CONFIG.clear()
    CONFIG.update(load_config())
    app = web.Application(client_max_size=GPT_IMAGE_REQUEST_MAX_BYTES)
    app.router.add_post("/run", handle_run)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/progress", handle_progress)
    app.router.add_get("/logs", handle_logs)
    app.router.add_post("/restart", handle_restart)
    app.router.add_post("/test-key", handle_test_key)
    app.router.add_post("/test-comfyui", handle_test_comfyui)
    app.router.add_post("/aigate/account", handle_aigate_account)
    app.router.add_post("/aigate/create-options", handle_aigate_create_options)
    app.router.add_post("/aigate/create-instance", handle_aigate_create_instance)
    app.router.add_post("/aigate/instances", handle_aigate_instances)
    app.router.add_post("/aigate/instance-action", handle_aigate_instance_action)
    app.router.add_post("/aigate/close-managed", handle_aigate_close_managed)
    app.on_shutdown.append(cleanup_managed_aigate_instances)
    app.router.add_get("/codex/status", handle_codex_status)
    app.router.add_post("/codex/image", handle_codex_image)
    app.router.add_post("/gpt-image", handle_gpt_image)
    app.router.add_post("/gpt-image/cancel", handle_gpt_image_cancel)
    app.router.add_post("/gpt-image/status", handle_gpt_image_status)
    app.router.add_post("/cancel", handle_cancel)
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_options)

    port = int(CONFIG["port"])
    bridge_log(f"# ComfyPS 桥启动: http://127.0.0.1:{port}")
    bridge_log(f"#   workflowId={CONFIG['workflowId']}  image={CONFIG['imageNodeId']}  mask={CONFIG['maskNodeId']}")
    bridge_log(f"#   workflow={CONFIG['workflowFile']}")
    web.run_app(app, host="127.0.0.1", port=port, print=None)

if __name__ == "__main__":
    main()
