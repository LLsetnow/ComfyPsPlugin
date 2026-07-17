import json
import unittest

from dev import dev_server


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class AigateDevMockTests(unittest.IsolatedAsyncioTestCase):
    async def test_models_open_close_managed_and_release_lifecycle(self):
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
