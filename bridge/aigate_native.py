"""云扉实例发现与原生 ComfyUI 调用的适配层。"""

import asyncio
import copy
import json
import re
from urllib.parse import urlencode

from aiohttp import ClientError, FormData


_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+$")
AIGATE_API_BASE = "https://waas.aigate.cc/api/openapi"


class AigateNativeError(RuntimeError):
    """可安全展示给插件用户的云扉原生调用错误。"""

    def __init__(self, code, message, status=502):
        RuntimeError.__init__(self, message)
        self.code = code
        self.message = message
        self.status = status


def normalize_bearer_token(value):
    """接受纯 Token 或完整 Bearer 值，不在异常中回显凭证。"""
    token = str(value or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if not token:
        raise AigateNativeError("AIGATE_TOKEN_REQUIRED", "请输入云扉 Bearer Token", 400)
    return token


async def _aigate_json(session, method, url, token, payload=None):
    """请求云扉 OpenAPI 并返回成功 data，禁止重定向。"""
    headers = {"Authorization": "Bearer " + normalize_bearer_token(token)}
    try:
        request = session.get if method == "GET" else session.post
        kwargs = {"headers": headers, "allow_redirects": False}
        if method != "GET" and payload is not None:
            kwargs["json"] = payload
        async with request(url, **kwargs) as response:
            try:
                body = await response.json(content_type=None)
            except Exception as exc:
                raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉返回了无效响应") from exc
        if response.status < 200 or response.status >= 300:
            raise AigateNativeError("AIGATE_HTTP_ERROR", "云扉实例服务请求失败", response.status)
        if not isinstance(body, dict) or body.get("code") != 0:
            raise AigateNativeError("AIGATE_API_ERROR", "云扉实例服务拒绝了请求")
        return body.get("data")
    except AigateNativeError:
        raise
    except asyncio.TimeoutError as exc:
        raise AigateNativeError(
            "AIGATE_TIMEOUT", "云扉实例服务请求超时", 504
        ) from exc
    except ClientError as exc:
        raise AigateNativeError("AIGATE_NETWORK_ERROR", "无法连接云扉实例服务") from exc


async def list_running_instances(token, session, api_base=AIGATE_API_BASE):
    """读取运行中实例，供每次原生任务动态发现 ComfyUI 服务。"""
    data = await _aigate_json(
        session,
        "POST",
        api_base.rstrip("/") + "/instance/page",
        token,
        {"operationStatus": "2", "current": 1, "pageSize": 20},
    )
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回实例列表")
    return records


async def list_instance_summaries(token, session, api_base=AIGATE_API_BASE):
    """读取设置页的实例摘要，不向面板暴露服务地址或实例凭证。"""
    data = await _aigate_json(
        session,
        "POST",
        api_base.rstrip("/") + "/instance/page",
        token,
        {"current": 1, "pageSize": 20},
    )
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回实例列表")
    summaries = []
    for record in records:
        if not isinstance(record, dict):
            continue
        instance_id = str(record.get("instanceId") or "")
        if not instance_id:
            continue
        detail = await get_instance_detail(token, instance_id, session, api_base)
        summary = safe_instance_summary(detail)
        if not summary["instanceName"] or summary["instanceName"] == "未命名实例":
            summary["instanceName"] = str(record.get("instanceName") or "未命名实例")
        if not summary["operationStatus"]:
            summary["operationStatus"] = str(record.get("operationStatus") or "")
        summaries.append(summary)
    return summaries


async def control_aigate_instance(token, instance_id, action, session, api_base=AIGATE_API_BASE):
    """请求云扉启动或关闭指定实例，不回传云扉响应中的未知字段。"""
    instance = str(instance_id or "").strip()
    operation = str(action or "").strip().lower()
    if not instance:
        raise AigateNativeError("AIGATE_INSTANCE_REQUIRED", "请选择云扉实例", 400)
    if operation not in ("open", "close"):
        raise AigateNativeError("AIGATE_ACTION_INVALID", "云扉实例操作无效", 400)
    await _aigate_json(
        session,
        "GET",
        api_base.rstrip("/") + "/instance/" + operation + "?" + urlencode({"instanceId": instance}),
        token,
    )
    return {"instanceId": instance, "action": operation}


async def get_instance_detail(token, instance_id, session, api_base=AIGATE_API_BASE):
    """读取单个云扉实例详情，供发现其公开的 ComfyUI 服务。"""
    query = urlencode({"instanceId": str(instance_id)})
    data = await _aigate_json(
        session,
        "GET",
        api_base.rstrip("/") + "/instance/get?" + query,
        token,
    )
    if not isinstance(data, dict):
        raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回实例详情")
    return data


async def discover_running_comfyui_instance(token, session, api_base=AIGATE_API_BASE):
    """按云扉列表顺序找出第一个包含 ComfyUI 服务的运行实例。"""
    records = await list_running_instances(token, session, api_base)
    for record in records:
        if not isinstance(record, dict) or str(record.get("operationStatus")) != "2":
            continue
        instance_id = str(record.get("instanceId") or "")
        if not instance_id:
            continue
        detail = await get_instance_detail(token, instance_id, session, api_base)
        host = find_comfyui_host(detail)
        if host:
            return {
                "instanceId": instance_id,
                "host": host,
                "baseUrl": make_comfyui_base_url(host),
            }
    raise AigateNativeError(
        "AIGATE_COMFYUI_NOT_RUNNING",
        "没有发现运行中的云扉 ComfyUI 实例，请启动包含 ComfyUI 服务的实例",
        409,
    )


async def _native_json(session, method, url, payload=None, form=None):
    """调用原生 ComfyUI JSON 端点；该路径绝不携带云扉认证头。"""
    request = session.get if method == "GET" else session.post
    kwargs = {"headers": {}, "allow_redirects": False}
    if payload is not None:
        kwargs["json"] = payload
    if form is not None:
        kwargs["data"] = form
    try:
        async with request(url, **kwargs) as response:
            status = response.status
            try:
                body = await response.json(content_type=None)
            except Exception as exc:
                raise AigateNativeError("COMFYUI_BAD_RESPONSE", "ComfyUI 返回了无效响应") from exc
        if status < 200 or status >= 300:
            raise AigateNativeError("COMFYUI_HTTP_ERROR", "ComfyUI 请求失败", status)
        if not isinstance(body, dict):
            raise AigateNativeError("COMFYUI_BAD_RESPONSE", "ComfyUI 返回了无效响应")
        return body
    except AigateNativeError:
        raise
    except asyncio.TimeoutError as exc:
        raise AigateNativeError("COMFYUI_TIMEOUT", "ComfyUI 请求超时", 504) from exc
    except ClientError as exc:
        raise AigateNativeError("COMFYUI_NETWORK_ERROR", "无法连接云扉 ComfyUI 服务") from exc


async def _upload_native_image(session, base_url, image_path, filename):
    """上传一个 PNG 到实例 input 目录，返回原生接口给出的文件名。"""
    form = FormData()
    with image_path.open("rb") as image_file:
        form.add_field("image", image_file, filename=filename, content_type="image/png")
        form.add_field("type", "input")
        body = await _native_json(
            session, "POST", base_url.rstrip("/") + "/upload/image", form=form
        )
    name = str(body.get("name") or "").strip()
    if not name:
        raise AigateNativeError("COMFYUI_UPLOAD_FAILED", "ComfyUI 未返回上传文件名")
    return name


async def _download_native_result(session, base_url, image):
    """下载 SaveImage 输出并确保交给 Photoshop 的结果确为 PNG。"""
    filename = str(image.get("filename") or "").strip()
    if not filename:
        raise AigateNativeError("COMFYUI_OUTPUT_MISSING", "ComfyUI 未返回输出文件名")
    params = {
        "filename": filename,
        "subfolder": str(image.get("subfolder") or ""),
        "type": str(image.get("type") or "output"),
    }
    url = base_url.rstrip("/") + "/view?" + urlencode(params)
    try:
        async with session.get(url, headers={}, allow_redirects=False) as response:
            data = await response.read()
            status = response.status
    except asyncio.TimeoutError as exc:
        raise AigateNativeError("COMFYUI_TIMEOUT", "ComfyUI 下载结果超时", 504) from exc
    except ClientError as exc:
        raise AigateNativeError("COMFYUI_NETWORK_ERROR", "无法下载 ComfyUI 结果") from exc
    if status < 200 or status >= 300:
        raise AigateNativeError("COMFYUI_DOWNLOAD_FAILED", "ComfyUI 结果下载失败", status)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AigateNativeError("COMFYUI_INVALID_OUTPUT", "ComfyUI 返回的结果不是 PNG 图片")
    if len(data) > 45 * 1024 * 1024:
        raise AigateNativeError("COMFYUI_INVALID_OUTPUT", "ComfyUI 返回的图片超过 45MB")
    return data


async def run_native_inpaint_on_instance(
    base_url, image_path, mask_path, prompt, task_id, workflow, on_progress, session,
    max_attempts=180, poll_interval=1,
):
    """在已发现的实例上调用无认证的原生 ComfyUI API。"""
    on_progress("正在上传原图和蒙版…")
    source_name = await _upload_native_image(
        session, base_url, image_path, "comfyps_" + str(task_id) + "_source.png"
    )
    mask_name = await _upload_native_image(
        session, base_url, mask_path, "comfyps_" + str(task_id) + "_mask.png"
    )
    native_workflow = build_native_workflow(
        workflow, source_name, mask_name, prompt, task_id
    )
    on_progress("正在提交 ComfyUI 工作流…")
    submitted = await _native_json(
        session,
        "POST",
        base_url.rstrip("/") + "/prompt",
        {"prompt": native_workflow, "client_id": "comfyps_aigate_" + str(task_id)},
    )
    prompt_id = str(submitted.get("prompt_id") or "").strip()
    if not prompt_id:
        raise AigateNativeError("COMFYUI_PROMPT_MISSING", "ComfyUI 未返回 prompt_id")

    history_url = base_url.rstrip("/") + "/history/" + prompt_id
    for attempt in range(max_attempts):
        on_progress("正在生成…")
        history = await _native_json(session, "GET", history_url)
        task = history.get(prompt_id) if isinstance(history, dict) else None
        status = task.get("status") if isinstance(task, dict) else None
        status_name = status.get("status_str") if isinstance(status, dict) else ""
        if str(status_name or "").lower() in ("error", "failed"):
            raise AigateNativeError(
                "COMFYUI_WORKFLOW_FAILED", "ComfyUI 工作流执行失败", 502
            )
        outputs = task.get("outputs") if isinstance(task, dict) else None
        node_output = outputs.get("224") if isinstance(outputs, dict) else None
        images = node_output.get("images") if isinstance(node_output, dict) else None
        if isinstance(images, list) and images:
            result = await _download_native_result(session, base_url, images[0])
            on_progress("完成")
            return result
        if attempt + 1 < max_attempts:
            await asyncio.sleep(poll_interval)
    raise AigateNativeError("AIGATE_TIMEOUT", "ComfyUI 工作流超时", 504)


async def run_native_inpaint(
    token, image_path, mask_path, prompt, task_id, workflow_path, on_progress, session,
    api_base=AIGATE_API_BASE,
):
    """发现云扉实例、读取 Boogu 工作流并执行原生 ComfyUI 任务。"""
    on_progress("正在发现云扉实例…")
    instance = await discover_running_comfyui_instance(token, session, api_base)
    try:
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError) as exc:
        raise AigateNativeError("COMFYUI_WORKFLOW_INVALID", "无法读取 Boogu 工作流") from exc
    if not isinstance(workflow, dict):
        raise AigateNativeError("COMFYUI_WORKFLOW_INVALID", "Boogu 工作流格式无效")
    return await run_native_inpaint_on_instance(
        instance["baseUrl"], image_path, mask_path, prompt, task_id, workflow,
        on_progress, session,
    )


def make_comfyui_base_url(host):
    """构造云扉公开 HTTPS 反向代理地址，忽略容器协议和端口。"""
    value = str(host or "").strip()
    if not value or not _HOST_RE.match(value):
        raise ValueError("云扉实例未返回有效的 ComfyUI 服务地址")
    return "https://" + value


def build_native_workflow(workflow, source_name, mask_name, prompt, task_id):
    """复制 Boogu 工作流，并只覆盖云端原生运行所需的五个输入。"""
    result = copy.deepcopy(workflow)
    replacements = {
        "71": {"image": source_name},
        "214": {"image": mask_name},
        "36": {"prompt": prompt},
        "5": {"vae_name": "flux1_vae_bf16.safetensors"},
        "224": {"filename_prefix": "boogu_blue_hair_api_" + str(task_id)},
    }
    for node_id, values in replacements.items():
        node = result.get(node_id)
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            raise ValueError("Boogu 工作流缺少节点 " + node_id + " 的输入")
        inputs.update(values)
    return result


def find_comfyui_host(detail):
    """从云扉实例详情的工具列表中找出公开的 ComfyUI 域名。"""
    services = detail.get("instanceUtilList") if isinstance(detail, dict) else None
    if not isinstance(services, list):
        return ""
    for service in services:
        if not isinstance(service, dict):
            continue
        if service.get("name") != "ComfyUI":
            continue
        host = str(service.get("host") or "").strip()
        if host:
            return host
    return ""


def safe_instance_summary(detail):
    """只给面板暴露控制实例所需的非敏感摘要。"""
    data = detail if isinstance(detail, dict) else {}
    return {
        "instanceId": str(data.get("instanceId") or ""),
        "instanceName": str(data.get("instanceName") or "未命名实例"),
        "operationStatus": str(data.get("operationStatus") or ""),
        "hasComfyui": bool(find_comfyui_host(data)),
    }
