import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


def install_rh_cli_stub():
    """仅为本端点单测提供无关 RH CLI 导入的最小替身。"""
    try:
        import rh_cli  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    rh_cli = types.ModuleType("rh_cli")
    rh_cli.__path__ = []
    config = types.ModuleType("rh_cli.config")
    config.require_api_key = lambda *args, **kwargs: ""
    errors = types.ModuleType("rh_cli.errors")
    errors.RhCliError = type("RhCliError", (Exception,), {})
    http = types.ModuleType("rh_cli.http")
    http.BASE_URL = ""
    http.RhHttpClient = type("RhHttpClient", (), {})
    workflow = types.ModuleType("rh_cli.workflow")
    workflow.__path__ = []
    workflow_client = types.ModuleType("rh_cli.workflow.client")

    def run_workflow(*args, **kwargs):
        return None

    workflow_client.run_workflow = run_workflow
    sys.modules.update({
        "rh_cli": rh_cli,
        "rh_cli.config": config,
        "rh_cli.errors": errors,
        "rh_cli.http": http,
        "rh_cli.workflow": workflow,
        "rh_cli.workflow.client": workflow_client,
    })


install_rh_cli_stub()

SPEC = importlib.util.spec_from_file_location(
    "comfyps_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class FakeResponseContext:
    def __init__(self, status, body):
        self.status = status
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def json(self, content_type=None):
        if isinstance(self.body, BaseException):
            raise self.body
        return self.body


class FakeSession:
    def __init__(self, factory):
        self.factory = factory

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    def get(self, url, **kwargs):
        self.factory.requested_url = url
        self.factory.requested_options = kwargs
        return FakeResponseContext(self.factory.status, self.factory.body)


class FakeSessionFactory:
    def __init__(self, status, body):
        self.status = status
        self.body = body
        self.requested_url = ""
        self.requested_options = {}

    def __call__(self, timeout):
        return FakeSession(self)


class TestComfyuiConnectivity(unittest.IsolatedAsyncioTestCase):
    async def test_returns_version_for_system_stats(self):
        factory = FakeSessionFactory(200, {"system": {"comfyui_version": "0.3.0"}})
        with patch.object(bridge, "ClientSession", factory):
            response = await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188/",
            }))
        self.assertEqual(factory.requested_url, "http://127.0.0.1:8188/system_stats")
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True, "status": 200, "version": "0.3.0",
        })

    async def test_does_not_follow_comfyui_redirects(self):
        factory = FakeSessionFactory(200, {"system": {"comfyui_version": "0.3.0"}})
        with patch.object(bridge, "ClientSession", factory):
            await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188",
            }))
        self.assertEqual(factory.requested_options.get("allow_redirects"), False)

    async def test_rejects_empty_url(self):
        response = await bridge.handle_test_comfyui(JsonRequest({"comfyuiUrl": ""}))
        self.assertEqual(response.status, 400)
        self.assertFalse(json.loads(response.body.decode("utf-8"))["ok"])

    async def test_reports_upstream_failure(self):
        factory = FakeSessionFactory(503, {})
        with patch.object(bridge, "ClientSession", factory):
            response = await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188",
            }))
        data = json.loads(response.body.decode("utf-8"))
        self.assertFalse(data["ok"])
        self.assertEqual(data["status"], 503)

    async def test_reports_http_status_before_decoding_error_body(self):
        factory = FakeSessionFactory(503, ValueError("not json"))
        with patch.object(bridge, "ClientSession", factory):
            response = await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188",
            }))
        data = json.loads(response.body.decode("utf-8"))
        self.assertEqual(data["status"], 503)
        self.assertEqual(data["message"], "ComfyUI 返回 HTTP 503")
