# ComfyUI Connectivity Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings-page test that confirms the local bridge can reach the configured ComfyUI server without submitting a workflow.

**Architecture:** The UXP panel posts the unsaved URL to a new bridge endpoint. The bridge validates the URL and fetches ComfyUI's `GET /system_stats` with a five-second timeout; the panel renders a transient success or error badge from the structured response. The development server supplies the same endpoint contract for browser preview.

**Tech Stack:** UXP ES5 JavaScript, HTML/CSS, Python 3, aiohttp, unittest.

---

### Task 1: Cover the bridge contract with focused tests

**Files:**
- Create: `bridge/test_comfyui_connectivity.py`
- Test: `bridge/test_comfyui_connectivity.py`

- [ ] **Step 1: Write failing async tests for valid, invalid, and unavailable ComfyUI targets**

```python
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
    async def test_handle_test_comfyui_returns_version_for_system_stats(self):
        factory = FakeSessionFactory(200, {"system": {"comfyui_version": "0.3.0"}})
        with patch.object(bridge, "ClientSession", factory):
            response = await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188/",
            }))
        self.assertEqual(factory.requested_url, "http://127.0.0.1:8188/system_stats")
        self.assertEqual(json.loads(response.body.decode("utf-8")), {
            "ok": True, "status": 200, "version": "0.3.0",
        })

    async def test_handle_test_comfyui_rejects_empty_url(self):
        response = await bridge.handle_test_comfyui(JsonRequest({"comfyuiUrl": ""}))
        self.assertEqual(response.status, 400)
        self.assertFalse(json.loads(response.body.decode("utf-8"))["ok"])

    async def test_handle_test_comfyui_reports_upstream_failure(self):
        factory = FakeSessionFactory(503, {})
        with patch.object(bridge, "ClientSession", factory):
            response = await bridge.handle_test_comfyui(JsonRequest({
                "comfyuiUrl": "http://127.0.0.1:8188",
            }))
        data = json.loads(response.body.decode("utf-8"))
        self.assertFalse(data["ok"])
        self.assertEqual(data["status"], 503)
```

- [ ] **Step 2: Run the test to verify the endpoint is absent**

Run: `python -m unittest bridge.test_comfyui_connectivity -v`

Expected: FAIL because `handle_test_comfyui` is not defined.

- [ ] **Step 3: Commit the failing test**

```bash
git add bridge/test_comfyui_connectivity.py
git commit -m "test: cover ComfyUI connectivity checks"
```

### Task 2: Implement the stateless bridge connectivity endpoint

**Files:**
- Modify: `bridge/bridge.py:1019-1125`
- Modify: `bridge/bridge.py:1605-1620`
- Test: `bridge/test_comfyui_connectivity.py`

- [ ] **Step 1: Add URL normalization and a `/system_stats` request handler**

```python
import urllib.parse


def normalize_comfyui_url(value: str) -> str:
    url = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("ComfyUI 地址必须以 http:// 或 https:// 开头")
    return url


async def handle_test_comfyui(request):
    try:
        body = await request.json()
    except Exception:
        return cors(web.json_response({"ok": False, "status": 0,
                                       "message": "请求体不是 JSON"}, status=400))
    try:
        comfyui_url = normalize_comfyui_url(body.get("comfyuiUrl"))
    except ValueError as error:
        return cors(web.json_response({"ok": False, "status": 0,
                                       "message": str(error)}, status=400))
    try:
        async with ClientSession(timeout=ClientTimeout(total=5)) as session:
            async with session.get(comfyui_url + "/system_stats") as response:
                status = response.status
                data = await response.json(content_type=None)
    except asyncio.TimeoutError:
        return cors(web.json_response({"ok": False, "status": 0,
                                       "message": "连接 ComfyUI 超时（5 秒）"}, status=502))
    except ClientError as error:
        return cors(web.json_response({"ok": False, "status": 0,
                                       "message": "无法连接 ComfyUI: " + str(error)}, status=502))
    except (TypeError, ValueError, UnicodeDecodeError):
        return cors(web.json_response({"ok": False, "status": status,
                                       "message": "ComfyUI 返回了无效响应"}, status=502))
    if not 200 <= status < 300:
        return cors(web.json_response({"ok": False, "status": status,
                                       "message": "ComfyUI 返回 HTTP " + str(status)}, status=502))
    if not isinstance(data, dict):
        return cors(web.json_response({"ok": False, "status": status,
                                       "message": "ComfyUI 返回了无效响应"}, status=502))
    system = data.get("system") if isinstance(data.get("system"), dict) else {}
    version = str(system.get("comfyui_version") or data.get("comfyui_version") or "")
    return cors(web.json_response({"ok": True, "status": status, "version": version}))
```

- [ ] **Step 2: Register the handler next to `/test-key`**

```python
app.router.add_post("/test-key", handle_test_key)
app.router.add_post("/test-comfyui", handle_test_comfyui)
```

- [ ] **Step 3: Run the contract tests**

Run: `python -m unittest bridge.test_comfyui_connectivity -v`

Expected: PASS for the three endpoint cases.

- [ ] **Step 4: Commit the bridge implementation**

```bash
git add bridge/bridge.py bridge/test_comfyui_connectivity.py
git commit -m "feat: test ComfyUI connectivity from bridge"
```

### Task 3: Mirror the bridge contract in development preview

**Files:**
- Modify: `dev/dev_server.py:330-375`
- Modify: `dev/dev_server.py:635-645`

- [ ] **Step 1: Add the mock handler**

```python
async def handle_test_comfyui(request: web.Request) -> web.Response:
    body = await request.json()
    if not (body.get("comfyuiUrl") or "").strip():
        return web.json_response({"ok": False, "status": 0,
                                  "message": "请输入 ComfyUI 地址"}, status=400)
    return web.json_response({"ok": True, "status": 200,
                              "version": "0.3.0-dev"})
```

- [ ] **Step 2: Register the mock endpoint**

```python
app.router.add_post("/test-comfyui", handle_test_comfyui)
```

- [ ] **Step 3: Verify the mock contract**

Run: `curl -sS -X POST http://127.0.0.1:<dev-port>/test-comfyui -H 'Content-Type: application/json' --data '{"comfyuiUrl":"http://127.0.0.1:8188"}'`

Expected: JSON with `ok: true`, `status: 200`, and `version: "0.3.0-dev"`.

### Task 4: Add the settings-page control and status behavior

**Files:**
- Modify: `plugin/index.html:1059-1064`
- Modify: `plugin/main.js:3827-4485`

- [ ] **Step 1: Add a test button and an empty transient status container**

```html
<div class="input-row">
  <input id="settingComfyuiUrl" type="text" value="http://127.0.0.1:8188" />
  <button id="btnTestComfyui" class="btn-sm" type="button">测试连接</button>
</div>
<div id="comfyuiConnectionStatus" class="setting-hint" style="display:none;"></div>
```

- [ ] **Step 2: Add DOM-safe status rendering and the click handler**

```javascript
function showComfyuiConnectionStatus(ok, message) {
  var display = $("comfyuiConnectionStatus");
  if (!display) return;
  display.style.display = "block";
  while (display.firstChild) display.removeChild(display.firstChild);
  var badge = document.createElement("span");
  badge.className = "balance-badge " + (ok ? "ok" : "err");
  badge.textContent = message;
  display.appendChild(badge);
}

async function testComfyuiConnection() {
  var input = $("settingComfyuiUrl");
  var button = $("btnTestComfyui");
  var comfyuiUrl = String(input ? input.value : "").replace(/^\s+|\s+$/g, "");
  if (!comfyuiUrl) {
    showComfyuiConnectionStatus(false, "请输入 ComfyUI 地址");
    return;
  }
  var originalText = button ? button.textContent : "测试连接";
  if (button) { button.disabled = true; button.textContent = "检测中…"; }
  try {
    var settings = loadSettings();
    var response = await fetchWithTimeout(
      settings.bridgeUrl.replace(/\/+$/, "") + "/test-comfyui",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comfyuiUrl: comfyuiUrl }) },
      8000
    );
    if (response.status === 404) {
      showComfyuiConnectionStatus(false, "本地桥版本过旧，请更新后重启桥");
      return;
    }
    var data = await response.json();
    if (data && data.ok) {
      showComfyuiConnectionStatus(true, "已连接" + (data.version ? " · ComfyUI " + data.version : ""));
    } else {
      showComfyuiConnectionStatus(false, data && data.message ? data.message : "ComfyUI 连接失败");
    }
  } catch (_) {
    showComfyuiConnectionStatus(false, "桥连接失败或检测超时");
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

var btnTestComfyui = $("btnTestComfyui");
if (btnTestComfyui) btnTestComfyui.addEventListener("click", testComfyuiConnection);
```

- [ ] **Step 3: Verify both settings feedback states in dev preview**

Run: start `python dev/dev_server.py`, select “本地 ComfyUI”, then test the default address and an empty address.

Expected: the default address displays `已连接 · ComfyUI 0.3.0-dev`; the empty address displays `请输入 ComfyUI 地址`; neither test queues a task.

- [ ] **Step 4: Commit the panel and mock changes**

```bash
git add plugin/index.html plugin/main.js dev/dev_server.py
git commit -m "feat: add ComfyUI connectivity test"
```

### Task 5: Run repository compatibility checks

**Files:**
- Verify: `plugin/main.js`
- Verify: `plugin/index.html`
- Verify: `bridge/bridge.py`
- Verify: `dev/dev_server.py`

- [ ] **Step 1: Run Python syntax and endpoint tests**

Run: `PYTHONPYCACHEPREFIX=/private/tmp/comfyps-pycache python -m py_compile bridge/bridge.py dev/dev_server.py && python -m unittest bridge.test_comfyui_connectivity -v`

Expected: both compilation and all contract tests pass.

- [ ] **Step 2: Run the UXP ES5 guard**

Run: `rg -n '(^|[^[:alnum:]_])(const|let)[[:space:]]|=>|\.find\(|Object\.assign\(' plugin/main.js`

Expected: no matches.

- [ ] **Step 3: Inspect the final diff and rebase before creating a PR**

Run: `git diff origin/main...HEAD --check && git fetch origin && git rebase origin/main`

Expected: no whitespace errors and a conflict-free rebase on the feature branch.
