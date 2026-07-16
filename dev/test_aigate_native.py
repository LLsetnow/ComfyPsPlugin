import json
import unittest

from dev import dev_server


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class AigateDevMockTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_and_controls_mock_instance(self):
        listed = await dev_server.handle_aigate_instances(JsonRequest({
            "aigateToken": "demo-token",
        }))
        instances = json.loads(listed.body.decode("utf-8"))["instances"]
        self.assertTrue(instances[0]["hasComfyui"])

        changed = await dev_server.handle_aigate_instance_action(JsonRequest({
            "aigateToken": "demo-token",
            "instanceId": "mock-running",
            "action": "close",
        }))
        self.assertTrue(json.loads(changed.body.decode("utf-8"))["ok"])


if __name__ == "__main__":
    unittest.main()
