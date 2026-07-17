import json
import unittest

from dev import dev_server


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class AigateDevMockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        dev_server.reset_mock_aigate_instances([])

    async def test_empty_console_exposes_raw_account_skus_and_created_instance(self):
        account = await dev_server.handle_aigate_account(JsonRequest({
            "aigateToken": "demo-token",
        }))
        account_data = json.loads(account.body.decode("utf-8"))
        self.assertEqual(account_data["balance"], "12898")
        self.assertEqual(account_data["updatedAt"], 0)
        self.assertNotIn("balanceLabel", account_data)

        options = await dev_server.handle_aigate_create_options(JsonRequest({
            "aigateToken": "demo-token",
        }))
        options_data = json.loads(options.body.decode("utf-8"))
        sku = options_data["options"][0]
        self.assertEqual(sku["price"], "199")
        self.assertNotIn("priceLabel", sku)

        created = await dev_server.handle_aigate_create_instance(JsonRequest({
            "aigateToken": "demo-token",
            "skuName": sku["skuName"],
        }))
        created_data = json.loads(created.body.decode("utf-8"))
        self.assertTrue(created_data["ok"])
        self.assertEqual(created_data["instance"]["instanceId"], "mock-created-1")

        listed = await dev_server.handle_aigate_instances(JsonRequest({
            "aigateToken": "demo-token",
        }))
        self.assertEqual(len(json.loads(listed.body.decode("utf-8"))["instances"]), 1)

    async def test_create_rejects_any_existing_instance_including_stopped(self):
        dev_server.reset_mock_aigate_instances([{
            "instanceId": "mock-stopped",
            "instanceName": "已关闭实例（开发模拟）",
            "operationStatus": "7",
            "hasComfyui": False,
        }])

        response = await dev_server.handle_aigate_create_instance(JsonRequest({
            "aigateToken": "demo-token",
            "skuName": "4090-24GB-DDR5",
        }))

        self.assertEqual(response.status, 409)
        self.assertEqual(
            json.loads(response.body.decode("utf-8"))["error"],
            "AIGATE_INSTANCE_EXISTS",
        )

    async def test_create_requires_known_sku(self):
        response = await dev_server.handle_aigate_create_instance(JsonRequest({
            "aigateToken": "demo-token",
            "skuName": "unknown-gpu",
        }))

        self.assertEqual(response.status, 400)
        self.assertEqual(
            json.loads(response.body.decode("utf-8"))["error"],
            "AIGATE_SKU_INVALID",
        )

    async def test_models_open_close_managed_and_release_lifecycle(self):
        dev_server.reset_mock_aigate_instances([
            {
                "instanceId": "mock-running",
                "instanceName": "Boogu ComfyUI（开发模拟）",
                "operationStatus": "2",
                "hasComfyui": True,
            },
            {
                "instanceId": "mock-stopped",
                "instanceName": "已关闭实例（开发模拟）",
                "operationStatus": "7",
                "hasComfyui": False,
            },
        ])
        listed = await dev_server.handle_aigate_instances(JsonRequest({
            "aigateToken": "demo-token",
        }))
        instances = json.loads(listed.body.decode("utf-8"))["instances"]
        self.assertTrue(instances[0]["hasComfyui"])

        opened = await dev_server.handle_aigate_instance_action(JsonRequest({
            "aigateToken": "demo-token",
            "instanceId": "mock-stopped",
            "action": "open",
        }))
        self.assertTrue(json.loads(opened.body.decode("utf-8"))["ok"])
        listed = await dev_server.handle_aigate_instances(JsonRequest({"aigateToken": "demo-token"}))
        instances = json.loads(listed.body.decode("utf-8"))["instances"]
        self.assertEqual(
            [item for item in instances if item["instanceId"] == "mock-stopped"][0]["operationStatus"],
            "2",
        )

        closed = await dev_server.handle_aigate_close_managed(JsonRequest({
            "aigateToken": "demo-token",
            "managedInstanceIds": ["mock-running"],
        }))
        self.assertEqual(json.loads(closed.body.decode("utf-8"))["closed"], ["mock-running"])
        listed = await dev_server.handle_aigate_instances(JsonRequest({"aigateToken": "demo-token"}))
        instances = json.loads(listed.body.decode("utf-8"))["instances"]
        self.assertEqual(
            [item for item in instances if item["instanceId"] == "mock-running"][0]["operationStatus"],
            "7",
        )

        released = await dev_server.handle_aigate_instance_action(JsonRequest({
            "aigateToken": "demo-token",
            "instanceId": "mock-stopped",
            "action": "release",
        }))
        self.assertTrue(json.loads(released.body.decode("utf-8"))["ok"])
        listed = await dev_server.handle_aigate_instances(JsonRequest({"aigateToken": "demo-token"}))
        instance_ids = [item["instanceId"] for item in json.loads(listed.body.decode("utf-8"))["instances"]]
        self.assertNotIn("mock-stopped", instance_ids)


if __name__ == "__main__":
    unittest.main()
