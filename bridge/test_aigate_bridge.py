import importlib.util
import json
import base64
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


def install_rh_cli_stub():
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
    workflow_client.run_workflow = lambda *args, **kwargs: None
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
    "comfyps_aigate_bridge", Path(__file__).with_name("bridge.py")
)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class AigateBridgeEndpointTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        if hasattr(bridge, "_aigate_managed_tokens"):
            bridge._aigate_managed_tokens.clear()

    async def test_lists_sanitized_instances(self):
        expected = [{
            "instanceId": "i-1",
            "instanceName": "Boogu GPU",
            "operationStatus": "2",
            "hasComfyui": True,
        }]
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=expected)
        ):
            response = await bridge.handle_aigate_instances(JsonRequest({
                "aigateToken": "demo-token",
            }))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "instances": expected,
        })

    async def test_controls_named_instance(self):
        with patch.object(
            bridge,
            "control_aigate_instance",
            new=AsyncMock(return_value={"instanceId": "i-1", "action": "close"}),
        ):
            response = await bridge.handle_aigate_instance_action(JsonRequest({
                "aigateToken": "demo-token",
                "instanceId": "i-1",
                "action": "close",
            }))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "instanceId": "i-1",
            "action": "close",
        })

    async def test_syncs_managed_instance_ids_without_returning_token(self):
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ):
            response = await bridge.handle_aigate_instances(JsonRequest({
                "aigateToken": "demo-token",
                "managedInstanceIds": ["i-1", "i-1", ""],
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(bridge._aigate_managed_tokens["i-1"], "demo-token")
        self.assertNotIn("demo-token", response.body.decode("utf-8"))

    async def test_releasing_instance_unregisters_managed_token(self):
        bridge._aigate_managed_tokens = {"i-1": "demo-token"}
        with patch.object(
            bridge,
            "control_aigate_instance",
            new=AsyncMock(return_value={"instanceId": "i-1", "action": "release"}),
        ):
            response = await bridge.handle_aigate_instance_action(JsonRequest({
                "aigateToken": "demo-token",
                "instanceId": "i-1",
                "action": "release",
            }))

        self.assertEqual(response.status, 200)
        self.assertNotIn("i-1", bridge._aigate_managed_tokens)

    async def test_closes_all_managed_instances_from_lifecycle_request(self):
        with patch.object(
            bridge,
            "close_aigate_instances",
            new=AsyncMock(return_value={"closed": ["i-1"], "failed": []}),
        ) as close_instances:
            response = await bridge.handle_aigate_close_managed(JsonRequest({
                "aigateToken": "demo-token",
                "managedInstanceIds": ["i-1"],
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "closed": ["i-1"],
            "failed": [],
        })
        close_instances.assert_awaited_once()

    async def test_runs_aigate_native_adapter_without_extra_set_args(self):
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\ninput").decode("ascii")
        with patch.object(
            bridge, "run_native_inpaint", new=AsyncMock(return_value=b"\x89PNG\r\n\x1a\nresult")
        ) as native_run, patch("shutil.copy2"):
            response = await bridge.handle_run(JsonRequest({
                "backend": "aigate",
                "aigateToken": "demo-token",
                "image": png_b64,
                "mask": png_b64,
                "prompt": "蓝色头发",
                "needsMask": True,
                "workflowFile": "../workflows/inpaint_boogu_api.json",
                "extraSetArgs": ["212:output_target_width=2048"],
                "taskId": "job42",
            }))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["X-Task-Id"], "job42")
        args = native_run.await_args.args
        self.assertEqual(args[0], "demo-token")
        self.assertEqual(args[3], "蓝色头发")
        self.assertEqual(args[4], "job42")
        self.assertEqual(args[5].name, "inpaint_boogu_api.json")
        self.assertEqual(len(args), 8)

    async def test_uses_repository_boogu_workflow_not_client_path(self):
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\ninput").decode("ascii")
        with patch.object(
            bridge, "run_native_inpaint", new=AsyncMock(return_value=b"\x89PNG\r\n\x1a\nresult")
        ) as native_run, patch("shutil.copy2"):
            await bridge.handle_run(JsonRequest({
                "backend": "aigate",
                "aigateToken": "demo-token",
                "image": png_b64,
                "mask": png_b64,
                "needsMask": True,
                "workflowFile": "../../untrusted/inpaint_boogu_api.json",
                "taskId": "job43",
            }))
        self.assertEqual(
            native_run.await_args.args[5],
            (bridge.BRIDGE_DIR / "../workflows/inpaint_boogu_api.json").resolve(),
        )


if __name__ == "__main__":
    unittest.main()
