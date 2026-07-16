import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, web


class AigateNativeUrlTests(unittest.TestCase):
    def test_uses_public_https_host_without_container_port(self):
        from bridge.aigate_native import make_comfyui_base_url

        self.assertEqual(
            make_comfyui_base_url("node.region1.waas.aigate.cc"),
            "https://node.region1.waas.aigate.cc",
        )


class AigateNativeWorkflowTests(unittest.TestCase):
    def test_changes_only_the_five_declared_node_inputs(self):
        from bridge.aigate_native import build_native_workflow

        workflow = {
            "5": {"inputs": {"vae_name": "FLUX.1-vae.sft"}},
            "36": {"inputs": {"prompt": "old prompt"}},
            "71": {"inputs": {"image": "old-source.png"}},
            "214": {"inputs": {"image": "old-mask.png"}},
            "212": {"inputs": {"output_target_width": 1024}},
            "224": {"inputs": {"filename_prefix": "ComfyUI"}},
        }

        actual = build_native_workflow(
            workflow, "source.png", "mask.png", "蓝色头发", "job42"
        )

        self.assertEqual(actual["71"]["inputs"]["image"], "source.png")
        self.assertEqual(actual["214"]["inputs"]["image"], "mask.png")
        self.assertEqual(actual["36"]["inputs"]["prompt"], "蓝色头发")
        self.assertEqual(
            actual["5"]["inputs"]["vae_name"], "flux1_vae_bf16.safetensors"
        )
        self.assertEqual(
            actual["224"]["inputs"]["filename_prefix"],
            "boogu_blue_hair_api_job42",
        )
        self.assertEqual(actual["212"]["inputs"]["output_target_width"], 1024)
        self.assertEqual(workflow["71"]["inputs"]["image"], "old-source.png")


class AigateNativeInstanceTests(unittest.TestCase):
    def test_extracts_comfyui_host_and_hides_it_from_settings_summary(self):
        from bridge.aigate_native import find_comfyui_host, safe_instance_summary

        detail = {
            "instanceId": "run-2",
            "instanceName": "Boogu GPU",
            "operationStatus": "2",
            "instanceUtilList": [
                {"name": "ssh", "host": "ssh.example", "password": "private"},
                {"name": "ComfyUI", "host": "comfy.example", "port": 8188},
            ],
        }

        self.assertEqual(find_comfyui_host(detail), "comfy.example")
        self.assertEqual(
            safe_instance_summary(detail),
            {
                "instanceId": "run-2",
                "instanceName": "Boogu GPU",
                "operationStatus": "2",
                "hasComfyui": True,
            },
        )


class AigateNativeHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        app = web.Application()

        async def list_instances(request):
            self.requests.append({
                "headers": dict(request.headers),
                "body": await request.json(),
            })
            return web.json_response({
                "code": 0,
                "data": {"records": [
                    {"instanceId": "running", "operationStatus": "2"},
                ]},
            })

        async def get_instance(request):
            self.requests.append({
                "headers": dict(request.headers),
                "instanceId": request.query.get("instanceId"),
            })
            return web.json_response({
                "code": 0,
                "data": {
                    "instanceId": "running",
                    "instanceUtilList": [
                        {"name": "ComfyUI", "host": "comfy.running.example", "port": 8188},
                    ],
                },
            })

        app.router.add_post("/instance/page", list_instances)
        app.router.add_get("/instance/get", get_instance)

        async def upload_image(request):
            reader = await request.multipart()
            image = await reader.next()
            image_name = image.filename
            type_field = await reader.next()
            type_value = await type_field.text()
            self.requests.append({
                "kind": "upload",
                "headers": dict(request.headers),
                "imageName": image_name,
                "type": type_value,
            })
            return web.json_response({"name": image_name})

        async def submit_prompt(request):
            self.requests.append({
                "kind": "prompt",
                "headers": dict(request.headers),
                "body": await request.json(),
            })
            return web.json_response({"prompt_id": "native-prompt"})

        async def history(request):
            self.requests.append({"kind": "history", "headers": dict(request.headers)})
            return web.json_response({
                "native-prompt": {
                    "outputs": {
                        "224": {
                            "images": [{
                                "filename": "boogu_blue_hair_api_job42_00001_.png",
                                "subfolder": "",
                                "type": "output",
                            }],
                        },
                    },
                },
            })

        async def view(request):
            self.requests.append({
                "kind": "view",
                "headers": dict(request.headers),
                "query": dict(request.query),
            })
            return web.Response(body=b"\x89PNG\r\n\x1a\nmock", content_type="image/png")

        app.router.add_post("/upload/image", upload_image)
        app.router.add_post("/prompt", submit_prompt)
        app.router.add_get("/history/{prompt_id}", history)
        app.router.add_get("/view", view)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.api_base = "http://127.0.0.1:" + str(port)
        self.session = ClientSession()

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()

    async def test_lists_running_instances_with_bearer_token(self):
        from bridge.aigate_native import list_running_instances

        records = await list_running_instances(
            "Bearer demo-token", self.session, self.api_base
        )

        self.assertEqual(records, [{"instanceId": "running", "operationStatus": "2"}])
        self.assertEqual(self.requests[0]["headers"]["Authorization"], "Bearer demo-token")
        self.assertEqual(
            self.requests[0]["body"],
            {"operationStatus": "2", "current": 1, "pageSize": 20},
        )

    async def test_discovers_first_running_comfyui_service(self):
        from bridge.aigate_native import discover_running_comfyui_instance

        actual = await discover_running_comfyui_instance(
            "demo-token", self.session, self.api_base
        )

        self.assertEqual(
            actual,
            {
                "instanceId": "running",
                "host": "comfy.running.example",
                "baseUrl": "https://comfy.running.example",
            },
        )
        self.assertEqual(self.requests[1]["instanceId"], "running")
        self.assertEqual(self.requests[1]["headers"]["Authorization"], "Bearer demo-token")

    async def test_runs_native_comfyui_without_authorization_header(self):
        from bridge.aigate_native import run_native_inpaint_on_instance

        workflow = {
            "5": {"inputs": {"vae_name": "old"}},
            "36": {"inputs": {"prompt": "old"}},
            "71": {"inputs": {"image": "old"}},
            "214": {"inputs": {"image": "old"}},
            "224": {"inputs": {"filename_prefix": "old"}},
        }
        progress = []
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            mask_path = Path(directory) / "mask.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            mask_path.write_bytes(b"\x89PNG\r\n\x1a\nmask")
            actual = await run_native_inpaint_on_instance(
                self.api_base, image_path, mask_path, "蓝色头发", "job42", workflow,
                progress.append, self.session,
            )

        native_requests = [item for item in self.requests if item.get("kind")]
        self.assertEqual(actual, b"\x89PNG\r\n\x1a\nmock")
        self.assertEqual(native_requests[0]["imageName"], "comfyps_job42_source.png")
        self.assertEqual(native_requests[1]["imageName"], "comfyps_job42_mask.png")
        self.assertEqual(native_requests[0]["type"], "input")
        self.assertNotIn("Authorization", native_requests[0]["headers"])
        self.assertNotIn("Authorization", native_requests[2]["headers"])
        self.assertEqual(
            native_requests[2]["body"]["prompt"]["36"]["inputs"]["prompt"], "蓝色头发"
        )
        self.assertEqual(native_requests[2]["body"]["client_id"], "comfyps_aigate_job42")
        self.assertEqual(native_requests[4]["query"]["type"], "output")
        self.assertIn("正在提交 ComfyUI 工作流…", progress)

    async def test_wrapper_discovers_instance_and_loads_workflow_file(self):
        from bridge.aigate_native import run_native_inpaint

        workflow = {
            "5": {"inputs": {"vae_name": "old"}},
            "36": {"inputs": {"prompt": "old"}},
            "71": {"inputs": {"image": "old"}},
            "214": {"inputs": {"image": "old"}},
            "224": {"inputs": {"filename_prefix": "old"}},
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "image.png"
            mask_path = root / "mask.png"
            workflow_path = root / "inpaint_boogu_api.json"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            mask_path.write_bytes(b"\x89PNG\r\n\x1a\nmask")
            workflow_path.write_text(__import__("json").dumps(workflow), encoding="utf-8")
            with patch(
                "bridge.aigate_native.discover_running_comfyui_instance",
                new=AsyncMock(return_value={"baseUrl": self.api_base}),
            ) as discover:
                actual = await run_native_inpaint(
                    "demo-token", image_path, mask_path, "蓝色头发", "job42",
                    workflow_path, lambda message: None, self.session, self.api_base,
                )

        self.assertEqual(actual, b"\x89PNG\r\n\x1a\nmock")
        discover.assert_awaited_once_with("demo-token", self.session, self.api_base)


if __name__ == "__main__":
    unittest.main()
