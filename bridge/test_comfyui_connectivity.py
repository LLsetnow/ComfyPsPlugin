import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


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
        return self.body


class FakeSession:
    def __init__(self, factory):
        self.factory = factory

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    def get(self, url):
        self.factory.requested_url = url
        return FakeResponseContext(self.factory.status, self.factory.body)


class FakeSessionFactory:
    def __init__(self, status, body):
        self.status = status
        self.body = body
        self.requested_url = ""

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
