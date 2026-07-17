import asyncio
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, ClientTimeout, web


class AigateNativeUrlTests(unittest.TestCase):
    def test_uses_public_https_host_without_container_port(self):
        from bridge.aigate_native import make_comfyui_base_url

        self.assertEqual(
            make_comfyui_base_url("node.region1.waas.aigate.cc"),
            "https://node.region1.waas.aigate.cc",
        )


class AigateNativeWorkflowTests(unittest.TestCase):
    def test_applies_declared_inputs_and_runtime_overrides(self):
        from bridge.aigate_native import build_native_workflow

        workflow = {
            "5": {"inputs": {"vae_name": "FLUX.1-vae.sft"}},
            "36": {"inputs": {"prompt": "old prompt"}},
            "71": {"inputs": {"image": "old-source.png"}},
            "214": {"inputs": {"image": "old-mask.png"}},
            "212": {"inputs": {
                "output_target_width": 1024,
                "output_target_height": 1024,
            }},
            "224": {"inputs": {"filename_prefix": "ComfyUI"}},
        }

        actual = build_native_workflow(
            workflow, "source.png", "mask.png", "蓝色头发", "job42",
            ["212:output_target_width=1536", "212:output_target_height=768"],
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
        self.assertEqual(actual["212"]["inputs"]["output_target_width"], 1536)
        self.assertEqual(actual["212"]["inputs"]["output_target_height"], 768)
        self.assertEqual(workflow["212"]["inputs"]["output_target_width"], 1024)
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
        self.failed_history = False
        self.slow_instance_list = False
        self.redirect_prompt = False
        self.redirect_target_hits = 0
        self.personal_images = []
        self.personal_image_pages = None
        self.community_images = []
        self.malformed_image_page = False
        app = web.Application()

        async def list_instances(request):
            body = await request.json()
            self.requests.append({
                "headers": dict(request.headers),
                "body": body,
            })
            if self.slow_instance_list:
                await asyncio.sleep(0.05)
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

        async def control_instance(request):
            instance_id = request.query.get("instanceId")
            action = request.match_info["action"]
            self.requests.append({
                "kind": "instance-control",
                "headers": dict(request.headers),
                "instanceId": instance_id,
                "action": action,
            })
            if instance_id == "two":
                return web.json_response({"code": 1, "message": "not available"})
            return web.json_response({"code": 0, "data": {"instanceId": instance_id}})

        async def account_balance(request):
            self.requests.append({
                "kind": "balance",
                "headers": dict(request.headers),
            })
            return web.json_response({"code": 0, "data": {"balance": "12898"}})

        async def sku_list(request):
            self.requests.append({
                "kind": "sku",
                "headers": dict(request.headers),
                "areaName": request.query.get("areaName"),
            })
            return web.json_response({"code": 0, "data": [{
                "skuName": "4090-24GB-DDR5", "price": "199", "vmSize": "24",
            }]})

        async def start_instance(request):
            self.requests.append({
                "kind": "create",
                "headers": dict(request.headers),
                "body": await request.json(),
            })
            return web.json_response({"code": 0, "data": {
                "instanceId": "new-1", "instanceName": "", "operationStatus": "1",
            }})

        async def image_page(request):
            body = await request.json()
            self.requests.append({
                "kind": "image-page",
                "headers": dict(request.headers),
                "body": body,
            })
            if self.malformed_image_page:
                return web.json_response({"code": 0, "data": {"total": "not-a-number"}})
            records = self.personal_images if body.get("imageType") == "3" else self.community_images
            if body.get("imageType") == "3" and self.personal_image_pages is not None:
                page_index = max(0, int(body.get("current") or 1) - 1)
                records = (
                    self.personal_image_pages[page_index]
                    if page_index < len(self.personal_image_pages) else []
                )
                total = sum(len(page) for page in self.personal_image_pages)
            else:
                total = len(records)
            return web.json_response({
                "code": 0,
                "data": {"total": total, "records": records},
            })

        app.router.add_post("/instance/page", list_instances)
        app.router.add_get("/instance/get", get_instance)
        app.router.add_post("/user/balance", account_balance)
        app.router.add_get("/instance/skuList", sku_list)
        app.router.add_post("/instance/start", start_instance)
        app.router.add_post("/image/page", image_page)
        app.router.add_get("/instance/{action}", control_instance)

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
            if self.redirect_prompt:
                raise web.HTTPFound("/redirected")
            return web.json_response({"prompt_id": "native-prompt"})

        async def redirected(request):
            self.redirect_target_hits += 1
            return web.json_response({"prompt_id": "native-prompt"})

        async def history(request):
            self.requests.append({"kind": "history", "headers": dict(request.headers)})
            if self.failed_history:
                return web.json_response({
                    "native-prompt": {"status": {"status_str": "error"}, "outputs": {}},
                })
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
                        "100": {
                            "images": [{
                                "filename": "image_enhance_00001_.png",
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
        app.router.add_get("/redirected", redirected)
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

    async def test_reads_raw_balance_with_bearer_token(self):
        from bridge.aigate_native import get_aigate_account

        actual = await get_aigate_account("demo-token", self.session, self.api_base)

        self.assertEqual(actual, {"balance": "12898"})
        self.assertEqual(
            self.requests[-1]["headers"]["Authorization"], "Bearer demo-token"
        )

    async def test_lists_skus_with_raw_price_and_bearer_token(self):
        from bridge.aigate_native import list_aigate_skus

        actual = await list_aigate_skus(
            "demo-token", "华东一区", self.session, self.api_base
        )

        self.assertEqual(actual, [{
            "skuName": "4090-24GB-DDR5",
            "vmSize": "24",
            "price": "199",
        }])
        self.assertEqual(self.requests[-1]["areaName"], "华东一区")
        self.assertEqual(
            self.requests[-1]["headers"]["Authorization"], "Bearer demo-token"
        )

    async def test_creates_configured_instance_with_numeric_image_id_and_bearer_token(self):
        from bridge.aigate_native import create_aigate_instance

        actual = await create_aigate_instance("demo-token", "4090-24GB-DDR5", {
            "areaName": "华东一区", "imageId": "42", "imageType": "2",
        }, self.session, self.api_base)

        self.assertEqual(actual["instanceId"], "new-1")
        self.assertEqual(self.requests[-1]["body"], {
            "skuName": "4090-24GB-DDR5",
            "areaName": "华东一区",
            "count": 1,
            "imageId": 42,
            "imageType": "2",
        })
        self.assertEqual(
            self.requests[-1]["headers"]["Authorization"], "Bearer demo-token"
        )

    async def test_rejects_missing_or_invalid_image_id_safely(self):
        from bridge.aigate_native import AigateNativeError, create_aigate_instance

        invalid_configs = [
            {"areaName": "华东一区", "imageType": "2"},
            {"areaName": "华东一区", "imageId": "image-42", "imageType": "2"},
            {"areaName": "华东一区", "imageId": "-1", "imageType": "2"},
        ]
        for create_config in invalid_configs:
            with self.subTest(create_config=create_config):
                with self.assertRaises(AigateNativeError) as raised:
                    await create_aigate_instance(
                        "demo-token", "4090-24GB-DDR5", create_config,
                        self.session, self.api_base,
                    )
                self.assertEqual(raised.exception.code, "AIGATE_CREATE_CONFIG_REQUIRED")
                self.assertEqual(raised.exception.status, 409)
        self.assertEqual(self.requests, [])

    async def test_resolves_personal_image_before_community(self):
        from bridge.aigate_native import resolve_aigate_create_image

        self.personal_images = [{
            "worksId": "301", "name": "comfyui-boogu-edit-int8-20260716",
        }]
        self.community_images = [{
            "worksId": "302", "name": "comfyui-boogu-edit-int8-20260716",
        }]

        actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
            "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
            "imageName": "comfyui-boogu-edit-int8-20260716",
        }, self.session, self.api_base)

        self.assertEqual(actual["imageId"], 301)
        self.assertEqual(actual["imageType"], "3")
        self.assertEqual(
            [item["body"]["imageType"] for item in self.requests
             if item.get("kind") == "image-page"],
            ["3"],
        )

    async def test_honors_configured_community_before_personal_image_order(self):
        from bridge.aigate_native import resolve_aigate_create_image

        self.personal_images = [{
            "worksId": "301", "name": "comfyui-boogu-edit-int8-20260716",
        }]
        self.community_images = [{
            "worksId": "302", "name": "comfyui-boogu-edit-int8-20260716",
        }]

        actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
            "areaName": "华东一区", "imageId": "", "imageTypes": ["2", "3"],
            "imageName": "comfyui-boogu-edit-int8-20260716",
        }, self.session, self.api_base)

        self.assertEqual(actual, {"imageId": 302, "imageType": "2"})
        self.assertEqual(
            [item["body"]["imageType"] for item in self.requests
             if item.get("kind") == "image-page"],
            ["2"],
        )

    async def test_searches_later_personal_image_pages_before_community_fallback(self):
        from bridge.aigate_native import resolve_aigate_create_image

        self.personal_image_pages = [
            [{"worksId": "101", "name": "other-image"} for _ in range(20)],
            [{"worksId": "301", "name": "comfyui-boogu-edit-int8-20260716"}],
        ]

        actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
            "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
            "imageName": "comfyui-boogu-edit-int8-20260716",
        }, self.session, self.api_base)

        self.assertEqual(actual, {"imageId": 301, "imageType": "3"})
        requests = [item for item in self.requests if item.get("kind") == "image-page"]
        self.assertEqual([item["body"]["current"] for item in requests], [1, 2])
        self.assertEqual([item["body"]["imageType"] for item in requests], ["3", "3"])

    async def test_falls_back_to_community_image_with_area_and_sku(self):
        from bridge.aigate_native import resolve_aigate_create_image

        self.community_images = [{
            "worksId": "302", "name": "comfyui-boogu-edit-int8-20260716",
        }]

        actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
            "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
            "imageName": "comfyui-boogu-edit-int8-20260716",
        }, self.session, self.api_base)

        self.assertEqual(actual["imageId"], 302)
        self.assertEqual(actual["imageType"], "2")
        community_request = [item for item in self.requests if item.get("kind") == "image-page"][-1]
        self.assertEqual(community_request["body"], {
            "current": 1, "pageSize": 20, "imageType": "2", "areaName": "华东一区",
            "skuName": "4090-24GB-DDR5", "imageName": "comfyui-boogu-edit-int8-20260716",
            "imageVersion": "",
        })

    async def test_rejects_create_when_neither_default_image_exists(self):
        from bridge.aigate_native import AigateNativeError, resolve_aigate_create_image

        with self.assertRaises(AigateNativeError) as raised:
            await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
                "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
                "imageName": "comfyui-boogu-edit-int8-20260716",
            }, self.session, self.api_base)

        self.assertEqual(raised.exception.code, "AIGATE_IMAGE_NOT_FOUND")
        self.assertEqual(raised.exception.status, 409)

    async def test_rejects_malformed_image_page_without_echoing_token(self):
        from bridge.aigate_native import AigateNativeError, resolve_aigate_create_image

        self.malformed_image_page = True
        with self.assertRaises(AigateNativeError) as raised:
            await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
                "areaName": "华东一区", "imageId": "", "imageTypes": ["3"],
                "imageName": "comfyui-boogu-edit-int8-20260716",
            }, self.session, self.api_base)

        self.assertEqual(raised.exception.code, "AIGATE_BAD_RESPONSE")
        self.assertNotIn("demo-token", raised.exception.message)

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

    async def test_reports_aigate_request_timeout_safely(self):
        from bridge.aigate_native import AigateNativeError, list_running_instances

        self.slow_instance_list = True
        async with ClientSession(timeout=ClientTimeout(total=0.01)) as short_session:
            with self.assertRaises(AigateNativeError) as raised:
                await list_running_instances("demo-token", short_session, self.api_base)

        self.assertEqual(raised.exception.code, "AIGATE_TIMEOUT")

    async def test_releases_named_instance_with_bearer_token(self):
        from bridge.aigate_native import control_aigate_instance

        actual = await control_aigate_instance(
            "demo-token", "released", "release", self.session, self.api_base
        )

        self.assertEqual(actual, {"instanceId": "released", "action": "release"})
        request = [item for item in self.requests if item.get("kind") == "instance-control"][-1]
        self.assertEqual(request["instanceId"], "released")
        self.assertEqual(request["headers"]["Authorization"], "Bearer demo-token")

    async def test_closes_managed_instances_without_stopping_after_one_failure(self):
        from bridge.aigate_native import close_aigate_instances

        actual = await close_aigate_instances(
            "demo-token", ["one", "two", "one", ""], self.session, self.api_base
        )

        self.assertEqual(actual, {"closed": ["one"], "failed": ["two"]})
        requests = [item for item in self.requests if item.get("kind") == "instance-control"]
        self.assertEqual([item["instanceId"] for item in requests], ["one", "two"])

    async def test_runs_native_comfyui_without_authorization_header(self):
        from bridge.aigate_native import run_native_inpaint_on_instance

        workflow = {
            "5": {"inputs": {"vae_name": "old"}},
            "36": {"inputs": {"prompt": "old"}},
            "71": {"inputs": {"image": "old"}},
            "214": {"inputs": {"image": "old"}},
            "212": {"inputs": {
                "output_target_width": 1024,
                "output_target_height": 1024,
            }},
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
                extra_set_args=[
                    "212:output_target_width=1536",
                    "212:output_target_height=768",
                ],
            )

        native_requests = [item for item in self.requests if item.get("kind")]
        self.assertEqual(actual, b"\x89PNG\r\n\x1a\nmock")
        self.assertEqual(native_requests[0]["imageName"], "comfyps_job42_source.png")
        self.assertEqual(native_requests[1]["imageName"], "comfyps_job42_mask.png")
        self.assertEqual(native_requests[0]["type"], "input")
        for request in native_requests:
            self.assertNotIn("Authorization", request["headers"])
        self.assertEqual(
            native_requests[2]["body"]["prompt"]["36"]["inputs"]["prompt"], "蓝色头发"
        )
        self.assertEqual(
            native_requests[2]["body"]["prompt"]["212"]["inputs"]["output_target_width"], 1536
        )
        self.assertEqual(
            native_requests[2]["body"]["prompt"]["212"]["inputs"]["output_target_height"], 768
        )
        self.assertEqual(native_requests[2]["body"]["client_id"], "comfyps_aigate_job42")
        self.assertEqual(native_requests[4]["query"]["type"], "output")
        self.assertIn("正在提交 ComfyUI 工作流…", progress)

    async def test_runs_generic_single_image_workflow(self):
        from bridge.aigate_native import run_native_workflow_on_instance

        workflow = {
            "90": {"inputs": {"image": "old.png"}},
            "95": {"inputs": {"Number": 2.0}},
            "100": {"inputs": {"filename_prefix": "ComfyUI"}},
        }
        progress = []
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            actual = await run_native_workflow_on_instance(
                self.api_base, image_path, None, "", "job-up", workflow,
                "90", "", "100", "", "", ["95:Number=4.5"], progress.append,
                self.session, max_attempts=2, poll_interval=0,
            )

        native_requests = [item for item in self.requests if item.get("kind")]
        upload_requests = [item for item in native_requests if item["kind"] == "upload"]
        prompt_request = [item for item in native_requests if item["kind"] == "prompt"][0]
        self.assertEqual(actual, b"\x89PNG\r\n\x1a\nmock")
        self.assertEqual(len(upload_requests), 1)
        for request in native_requests:
            self.assertNotIn("Authorization", request["headers"])
        native_workflow = prompt_request["body"]["prompt"]
        self.assertEqual(native_workflow["90"]["inputs"]["image"], "comfyps_job-up_source.png")
        self.assertEqual(native_workflow["95"]["inputs"]["Number"], 4.5)
        self.assertEqual(native_workflow["100"]["inputs"]["filename_prefix"], "comfyps_aigate_job-up")
        self.assertIn("正在提交 ComfyUI 工作流…", progress)

    async def test_reports_failed_history_without_waiting_for_timeout(self):
        from bridge.aigate_native import AigateNativeError, run_native_inpaint_on_instance

        self.failed_history = True
        workflow = {
            "5": {"inputs": {"vae_name": "old"}},
            "36": {"inputs": {"prompt": "old"}},
            "71": {"inputs": {"image": "old"}},
            "214": {"inputs": {"image": "old"}},
            "224": {"inputs": {"filename_prefix": "old"}},
        }
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            mask_path = Path(directory) / "mask.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            mask_path.write_bytes(b"\x89PNG\r\n\x1a\nmask")
            with self.assertRaises(AigateNativeError) as raised:
                await run_native_inpaint_on_instance(
                    self.api_base, image_path, mask_path, "蓝色头发", "job-fail", workflow,
                    lambda message: None, self.session, max_attempts=1,
                )
        self.assertEqual(raised.exception.code, "COMFYUI_WORKFLOW_FAILED")

    async def test_does_not_follow_native_comfyui_redirects(self):
        from bridge.aigate_native import AigateNativeError, run_native_inpaint_on_instance

        self.redirect_prompt = True
        workflow = {
            "5": {"inputs": {"vae_name": "old"}},
            "36": {"inputs": {"prompt": "old"}},
            "71": {"inputs": {"image": "old"}},
            "214": {"inputs": {"image": "old"}},
            "224": {"inputs": {"filename_prefix": "old"}},
        }
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            mask_path = Path(directory) / "mask.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            mask_path.write_bytes(b"\x89PNG\r\n\x1a\nmask")
            with self.assertRaises(AigateNativeError):
                await run_native_inpaint_on_instance(
                    self.api_base, image_path, mask_path, "蓝色头发", "job-redirect",
                    workflow, lambda message: None, self.session,
                )

        self.assertEqual(self.redirect_target_hits, 0)

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
