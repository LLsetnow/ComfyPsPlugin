import importlib.util
import json
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "comfyps_dev_server", Path(__file__).with_name("dev_server.py"))
dev_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dev_server)


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class TestDevComfyuiConnectivity(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_urls_that_production_bridge_rejects(self):
        response = await dev_server.handle_test_comfyui(JsonRequest({
            "comfyuiUrl": "ftp://invalid.example/?query=1",
        }))
        data = json.loads(response.body.decode("utf-8"))
        self.assertEqual(response.status, 400)
        self.assertFalse(data["ok"])
        self.assertEqual(data["message"], "ComfyUI 地址必须以 http:// 或 https:// 开头")
