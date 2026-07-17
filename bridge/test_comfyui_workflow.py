import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


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

from bridge.comfyui_exec import run_comfyui_blocking


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


class LocalComfyuiWorkflowTests(unittest.TestCase):
    def test_uses_request_workflow_and_single_image_nodes(self):
        submitted = []
        png_bytes = b"\x89PNG\r\n\x1a\nresult"

        def fake_urlopen(request, timeout):
            if hasattr(request, "data"):
                submitted.append(json.loads(request.data.decode("utf-8")))
                return FakeResponse(b'{"prompt_id":"job-1"}')
            if "/history/job-1" in request:
                return FakeResponse(json.dumps({
                    "job-1": {"outputs": {
                        "100": {"images": [{"filename": "result.png", "subfolder": ""}]}
                    }}
                }).encode("utf-8"))
            return FakeResponse(png_bytes)

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "source.png"
            output_dir = Path(directory) / "out"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\nsource")
            output_dir.mkdir()
            with patch("urllib.request.urlopen", side_effect=fake_urlopen), patch("time.sleep"):
                actual = run_comfyui_blocking(
                    image_path, None, output_dir, "", "http://127.0.0.1:8188",
                    "../workflows/image_clarity_api.json", ["95:Number=3.5"],
                    "90", "", "100", "", "",
                )

        self.assertEqual(actual, png_bytes)
        workflow = submitted[0]["prompt"]
        self.assertEqual(workflow["95"]["inputs"]["Number"], 3.5)
        self.assertEqual(workflow["90"]["inputs"]["image"], "iVBORw0KGgpzb3VyY2U=")
