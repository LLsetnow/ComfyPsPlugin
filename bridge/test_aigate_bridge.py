import asyncio
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
        self.original_config = dict(bridge.CONFIG)
        bridge.CONFIG["aigateCreate"] = {
            "areaName": "华东一区",
            "imageId": "42",
            "imageType": "2",
        }
        if hasattr(bridge, "_aigate_managed_tokens"):
            bridge._aigate_managed_tokens.clear()

    def tearDown(self):
        bridge.CONFIG.clear()
        bridge.CONFIG.update(self.original_config)

    def test_uses_default_named_image_when_no_explicit_id_is_configured(self):
        bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}

        try:
            actual = bridge.get_aigate_create_config()
        except bridge.AigateNativeError:
            actual = None

        self.assertEqual(actual, {
            "areaName": "华东一区",
            "imageId": None,
            "imageType": "",
            "imageName": "comfyui-boogu-edit-int8-20260716",
            "imageTypes": ["3", "2"],
        })

    async def test_returns_raw_account_balance_without_echoing_token(self):
        with patch.object(
            bridge, "get_aigate_account", new=AsyncMock(
                return_value={"balance": "12898"}
            )
        ) as get_account, patch.object(bridge.time, "time", return_value=123.456):
            response = await bridge.handle_aigate_account(JsonRequest({
                "aigateToken": "demo-token",
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "balance": "12898",
            "updatedAt": 123456,
        })
        self.assertNotIn("demo-token", response.body.decode("utf-8"))
        get_account.assert_awaited_once()
        self.assertEqual(get_account.await_args.args[0], "demo-token")

    async def test_returns_create_options_with_raw_prices(self):
        options = [{
            "skuName": "4090-24GB-DDR5",
            "vmSize": "24",
            "price": "199",
        }]
        with patch.object(
            bridge, "list_aigate_skus", new=AsyncMock(return_value=options)
        ) as list_skus, patch.object(bridge.time, "time", return_value=123.456):
            response = await bridge.handle_aigate_create_options(JsonRequest({
                "aigateToken": "demo-token",
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "options": options,
            "updatedAt": 123456,
        })
        self.assertNotIn("demo-token", response.body.decode("utf-8"))
        list_skus.assert_awaited_once()
        self.assertEqual(list_skus.await_args.args[0], "demo-token")
        self.assertEqual(list_skus.await_args.args[1], "华东一区")

    async def test_rejects_create_options_without_local_image_config(self):
        bridge.CONFIG.pop("aigateCreate")

        response = await bridge.handle_aigate_create_options(JsonRequest({
            "aigateToken": "demo-token",
        }))

        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": False,
            "error": "AIGATE_CREATE_CONFIG_REQUIRED",
            "message": "本机尚未配置预设 ComfyUI 镜像",
        })

    async def test_rejects_create_when_any_instance_exists(self):
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[{
                "instanceId": "existing", "operationStatus": "7",
            }])
        ) as listed, patch.object(
            bridge, "create_aigate_instance", new=AsyncMock()
        ) as created:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": "4090-24GB-DDR5",
            }))

        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": False,
            "error": "AIGATE_INSTANCE_EXISTS",
            "message": "云扉控制台已有实例，不能重复创建",
        })
        listed.assert_awaited_once()
        created.assert_not_awaited()

    async def test_serializes_concurrent_creates_for_an_empty_console(self):
        instances = []
        created_instances = []

        async def list_current_instances(token, session):
            await asyncio.sleep(0)
            return list(instances)

        async def create_instance(token, sku_name, config, session):
            await asyncio.sleep(0)
            instance = {
                "instanceId": "new-" + str(len(created_instances) + 1),
                "instanceName": "",
                "operationStatus": "1",
                "hasComfyui": True,
            }
            created_instances.append(instance)
            instances.append(instance)
            return instance

        with patch.object(
            bridge, "list_instance_summaries",
            new=AsyncMock(side_effect=list_current_instances),
        ) as listed, patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(return_value={"imageId": 42, "imageType": "2"}),
            create=True,
        ) as resolve, patch.object(
            bridge, "create_aigate_instance",
            new=AsyncMock(side_effect=create_instance),
        ) as create:
            responses = await asyncio.gather(
                bridge.handle_aigate_create_instance(JsonRequest({
                    "aigateToken": "demo-token",
                    "skuName": "4090-24GB-DDR5",
                })),
                bridge.handle_aigate_create_instance(JsonRequest({
                    "aigateToken": "demo-token",
                    "skuName": "4090-24GB-DDR5",
                })),
            )

        responses_by_status = {response.status: response for response in responses}
        self.assertEqual(sorted(response.status for response in responses), [200, 409])
        self.assertEqual(json.loads(
            responses_by_status[409].body.decode("utf-8")
        ), {
            "ok": False,
            "error": "AIGATE_INSTANCE_EXISTS",
            "message": "云扉控制台已有实例，不能重复创建",
        })
        self.assertEqual(len(created_instances), 1)
        self.assertEqual(create.await_count, 1)
        self.assertEqual(listed.await_count, 2)
        self.assertEqual(resolve.await_count, 1)
        self.assertEqual(bridge._aigate_managed_tokens, {"new-1": "demo-token"})

    async def test_creates_empty_console_instance_with_configured_image_and_registers_it(self):
        created_instance = {
            "instanceId": "new-1",
            "instanceName": "",
            "operationStatus": "1",
            "hasComfyui": True,
        }
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ) as listed, patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(return_value={"imageId": 42, "imageType": "2"}),
            create=True,
        ) as resolve, patch.object(
            bridge, "create_aigate_instance", new=AsyncMock(
                return_value=created_instance
            )
        ) as create:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": "4090-24GB-DDR5",
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True,
            "instance": created_instance,
        })
        listed.assert_awaited_once()
        resolve.assert_awaited_once()
        create.assert_awaited_once()
        self.assertEqual(create.await_args.args[0], "demo-token")
        self.assertEqual(create.await_args.args[1], "4090-24GB-DDR5")
        self.assertEqual(create.await_args.args[2], {
            "areaName": "华东一区",
            "imageId": 42,
            "imageType": "2",
            "imageName": "comfyui-boogu-edit-int8-20260716",
            "imageTypes": ["3", "2"],
        })
        self.assertEqual(bridge._aigate_managed_tokens, {"new-1": "demo-token"})

    async def test_passes_configured_image_id_to_native_adapter_unchanged(self):
        bridge.CONFIG["aigateCreate"]["imageId"] = 42
        created_instance = {
            "instanceId": "new-1",
            "instanceName": "",
            "operationStatus": "1",
            "hasComfyui": True,
        }
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ), patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(return_value={"imageId": 42, "imageType": "2"}),
            create=True,
        ), patch.object(
            bridge, "create_aigate_instance", new=AsyncMock(
                return_value=created_instance
            )
        ) as create:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": "4090-24GB-DDR5",
            }))

        self.assertEqual(response.status, 200)
        self.assertEqual(create.await_args.args[2]["imageId"], 42)

    async def test_resolves_image_inside_empty_console_create_lock(self):
        bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}
        resolved = {"imageId": 301, "imageType": "3"}
        created = {
            "instanceId": "new-1",
            "instanceName": "",
            "operationStatus": "1",
            "hasComfyui": True,
        }
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ), patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(return_value=resolved),
            create=True,
        ) as resolve, patch.object(
            bridge, "create_aigate_instance", new=AsyncMock(return_value=created)
        ) as create:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": "4090-24GB-DDR5",
            }))

        self.assertEqual(response.status, 200)
        resolve.assert_awaited_once()
        self.assertEqual(resolve.await_args.args[0], "demo-token")
        self.assertEqual(resolve.await_args.args[1], "4090-24GB-DDR5")
        self.assertEqual(create.await_args.args[2]["imageId"], 301)
        self.assertEqual(create.await_args.args[2]["imageType"], "3")

    async def test_rejects_missing_sku_before_image_resolution(self):
        bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ), patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(return_value={"imageId": 301, "imageType": "3"}),
        ) as resolve, patch.object(
            bridge, "create_aigate_instance", new=AsyncMock(return_value={
                "instanceId": "new-1",
                "instanceName": "",
                "operationStatus": "1",
                "hasComfyui": True,
            })
        ) as create:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": " ",
            }))

        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": False,
            "error": "AIGATE_SKU_REQUIRED",
            "message": "请选择 GPU 规格",
        })
        resolve.assert_not_awaited()
        create.assert_not_awaited()

    async def test_returns_image_resolution_error_without_creating(self):
        bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}
        resolution_error = bridge.AigateNativeError(
            "AIGATE_IMAGE_NOT_FOUND",
            "未找到默认 ComfyUI 镜像（已尝试个人和社区镜像）",
            409,
        )
        with patch.object(
            bridge, "list_instance_summaries", new=AsyncMock(return_value=[])
        ), patch.object(
            bridge, "resolve_aigate_create_image",
            new=AsyncMock(side_effect=resolution_error),
            create=True,
        ) as resolve, patch.object(
            bridge, "create_aigate_instance", new=AsyncMock()
        ) as create:
            response = await bridge.handle_aigate_create_instance(JsonRequest({
                "aigateToken": "demo-token",
                "skuName": "4090-24GB-DDR5",
            }))

        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": False,
            "error": "AIGATE_IMAGE_NOT_FOUND",
            "message": "未找到默认 ComfyUI 镜像（已尝试个人和社区镜像）",
        })
        resolve.assert_awaited_once()
        create.assert_not_awaited()

    def test_registers_account_and_instance_creation_routes(self):
        class FakeRouter:
            def __init__(self):
                self.post_routes = []

            def add_post(self, path, handler):
                self.post_routes.append((path, handler))

            def add_get(self, path, handler):
                pass

            def add_route(self, method, path, handler):
                pass

        class FakeApp:
            def __init__(self):
                self.router = FakeRouter()
                self.on_shutdown = []

        app = FakeApp()
        with patch.object(bridge.web, "Application", return_value=app), patch.object(
            bridge.web, "run_app"
        ), patch.object(
            bridge, "load_config", return_value={
                "workflowId": "workflow", "imageNodeId": "41", "maskNodeId": "42",
                "workflowFile": "workflow.json", "port": 8765,
            }
        ), patch.object(bridge, "bridge_log"):
            bridge.main()

        routes = dict(app.router.post_routes)
        self.assertIn("/aigate/account", routes)
        self.assertIn("/aigate/create-options", routes)
        self.assertIn("/aigate/create-instance", routes)
        self.assertEqual(routes["/aigate/account"], bridge.handle_aigate_account)
        self.assertEqual(
            routes["/aigate/create-options"],
            bridge.handle_aigate_create_options,
        )
        self.assertEqual(
            routes["/aigate/create-instance"],
            bridge.handle_aigate_create_instance,
        )

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

    async def test_restart_runs_managed_instance_cleanup_before_exec(self):
        with patch.object(
            bridge, "cleanup_managed_aigate_instances", new=AsyncMock()
        ) as cleanup, patch.object(
            bridge.asyncio, "sleep", new=AsyncMock()
        ), patch.object(bridge.os, "execv") as execv:
            await bridge.restart_after_aigate_cleanup()

        cleanup.assert_awaited_once_with(None)
        execv.assert_called_once_with(bridge.sys.executable, [bridge.sys.executable] + bridge.sys.argv)

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
