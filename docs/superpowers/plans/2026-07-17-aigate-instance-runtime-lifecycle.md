# 云扉实例运行时间与生命周期控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ComfyPS 设置页为插件管理的云扉实例显示本地运行时间，支持启动、关闭、释放，并在正常退出时尽力关闭受管实例。

**Architecture:** 面板在 localStorage 保存无凭证的实例生命周期记录，首次观察到运行状态时开始计时。桥只在内存中保存实例到 Token 的映射，提供同步、释放和并发关闭端点，并在 aiohttp 正常 shutdown 时进行最后一次关闭。云扉 Token 不写盘、不进日志、不进入实例摘要。

**Tech Stack:** Photoshop UXP ES5、aiohttp、Python unittest、Node 内置 test/vm、云扉 OpenAPI。

---

## 文件结构

- Modify: `bridge/aigate_native.py` — 允许 `release`，并提供并发关闭实例的适配函数。
- Modify: `bridge/test_aigate_native.py` — 覆盖 release 与多实例关闭请求。
- Modify: `bridge/bridge.py` — 受管实例的内存注册、`/aigate/close-managed` 与 shutdown 清理。
- Modify: `bridge/test_aigate_bridge.py` — 覆盖同步、释放和关闭受管实例端点。
- Modify: `dev/dev_server.py` — mock 的 release、关闭受管实例与实例状态。
- Modify: `dev/test_aigate_native.py` — 验证 mock 生命周期动作。
- Modify: `plugin/index.html` — 为实例行增加紧凑的运行时间与动作布局样式。
- Modify: `plugin/main.js` — 本地生命周期存储、计时、自动刷新、释放确认和 UXP 退出清理。
- Modify: `plugin/test_aigate_native.js` — 覆盖本地计时与受管实例状态迁移。

### Task 1: 云扉适配器支持释放和并发关闭

**Files:**
- Modify: `bridge/test_aigate_native.py`
- Modify: `bridge/aigate_native.py`

- [ ] **Step 1: 写 release 与并发关闭的失败测试**

在 `AigateNativeHttpTests` 中记录 `/instance/close` 与 `/instance/release` 请求，添加：

```python
async def test_releases_named_instance_with_bearer_token(self):
    from bridge.aigate_native import control_aigate_instance

    actual = await control_aigate_instance(
        "demo-token", "released", "release", self.session, self.api_base
    )

    self.assertEqual(actual, {"instanceId": "released", "action": "release"})
    self.assertEqual(self.requests[-1]["instanceId"], "released")
    self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer demo-token")

async def test_closes_managed_instances_without_stopping_after_one_failure(self):
    from bridge.aigate_native import close_aigate_instances

    actual = await close_aigate_instances(
        "demo-token", ["one", "two"], self.session, self.api_base
    )

    self.assertEqual(actual["closed"], ["one"])
    self.assertEqual(actual["failed"], ["two"])
```

让 mock 的 `one` 返回成功、`two` 返回云扉 `code: 1`，并断言两个请求均已发送。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
UV_CACHE_DIR=/private/tmp/comfyps-uv-cache uv run --with aiohttp python -m unittest bridge.test_aigate_native.AigateNativeHttpTests.test_releases_named_instance_with_bearer_token bridge.test_aigate_native.AigateNativeHttpTests.test_closes_managed_instances_without_stopping_after_one_failure -v
```

Expected: FAIL，因为 `release` 尚未允许，`close_aigate_instances` 尚不存在。

- [ ] **Step 3: 最小化实现 release 与关闭汇总**

将 action 白名单扩大为 `("open", "close", "release")`，保留已有 URL 编码与无重定向行为。新增：

```python
async def close_aigate_instances(token, instance_ids, session, api_base=AIGATE_API_BASE):
    ids = []
    for instance_id in instance_ids or []:
        value = str(instance_id or "").strip()
        if value and value not in ids:
            ids.append(value)
    tasks = [
        control_aigate_instance(token, instance_id, "close", session, api_base)
        for instance_id in ids
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    summary = {"closed": [], "failed": []}
    for instance_id, result in zip(ids, results):
        if isinstance(result, Exception):
            summary["failed"].append(instance_id)
        else:
            summary["closed"].append(instance_id)
    return summary
```

不得把异常内容、Token 或 host 放入汇总值。

- [ ] **Step 4: 运行适配器测试确认通过**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: 提交适配器改动**

```bash
git add bridge/aigate_native.py bridge/test_aigate_native.py
git commit -m "feat: add AIGate instance release controls"
```

### Task 2: 桥注册受管实例并在关闭时并发关闭

**Files:**
- Modify: `bridge/test_aigate_bridge.py`
- Modify: `bridge/bridge.py`

- [ ] **Step 1: 写桥端点的失败测试**

添加测试，mock `list_instance_summaries`、`control_aigate_instance` 和 `close_aigate_instances`：

```python
async def test_syncs_managed_instance_ids_without_returning_token(self):
    with patch.object(bridge, "list_instance_summaries", new=AsyncMock(return_value=[])):
        response = await bridge.handle_aigate_instances(JsonRequest({
            "aigateToken": "demo-token", "managedInstanceIds": ["i-1", "i-1", ""],
        }))
    self.assertEqual(response.status, 200)
    self.assertEqual(bridge._aigate_managed_tokens["i-1"], "demo-token")
    self.assertNotIn("demo-token", response.body.decode("utf-8"))

async def test_closes_all_managed_instances_from_lifecycle_request(self):
    with patch.object(
        bridge, "close_aigate_instances", new=AsyncMock(return_value={"closed": ["i-1"], "failed": []}
    ) as close_instances:
        response = await bridge.handle_aigate_close_managed(JsonRequest({
            "aigateToken": "demo-token", "managedInstanceIds": ["i-1"],
        }))
    self.assertEqual(response.status, 200)
    close_instances.assert_awaited_once()
```

另添加 release action 成功后从 `_aigate_managed_tokens` 删除实例的测试。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
UV_CACHE_DIR=/private/tmp/comfyps-uv-cache uv run --with aiohttp python -m unittest bridge.test_aigate_bridge -v
```

Expected: FAIL，因为内存注册表和关闭端点尚不存在。

- [ ] **Step 3: 实现内存注册表与端点**

在 `bridge.py` 的模块状态增加：

```python
_aigate_managed_tokens = {}

def _managed_aigate_ids(values):
    result = []
    for value in values or []:
        instance_id = str(value or "").strip()
        if instance_id and instance_id not in result:
            result.append(instance_id)
    return result

def _sync_aigate_managed_instances(token, instance_ids):
    for instance_id in _managed_aigate_ids(instance_ids):
        _aigate_managed_tokens[instance_id] = token
```

`handle_aigate_instances` 在校验 Token 后调用同步函数，但只返回 `ok` 和过滤后的实例摘要。`handle_aigate_instance_action` 成功 `open` 时注册、成功 `release` 时删除。新增 `handle_aigate_close_managed`：同步当前 body 中的 ID，调用 `close_aigate_instances`，并返回 `{ "ok": true, "closed": [...], "failed": [...] }`。

添加：

```python
async def cleanup_managed_aigate_instances(app):
    grouped = {}
    for instance_id, token in list(_aigate_managed_tokens.items()):
        grouped.setdefault(token, []).append(instance_id)
    _aigate_managed_tokens.clear()
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        for token, instance_ids in grouped.items():
            try:
                await close_aigate_instances(token, instance_ids, session)
            except AigateNativeError:
                bridge_log("# 云扉退出清理失败", "error")
```

在 `main()` 注册 `app.router.add_post("/aigate/close-managed", handle_aigate_close_managed)` 和 `app.on_shutdown.append(cleanup_managed_aigate_instances)`。日志不得拼接 Token、ID 之外的云扉敏感数据。

- [ ] **Step 4: 运行桥测试确认通过**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: 提交桥改动**

```bash
git add bridge/bridge.py bridge/test_aigate_bridge.py
git commit -m "feat: clean up managed AIGate instances on exit"
```

### Task 3: 让开发 mock 表现出完整实例生命周期

**Files:**
- Modify: `dev/test_aigate_native.py`
- Modify: `dev/dev_server.py`

- [ ] **Step 1: 写开发 mock 的失败测试**

扩展现有测试：先调用 `open`，断言列表中状态为 `2`；调用 `release`，断言后续列表不再包含实例；调用 `/aigate/close-managed`，断言受管实例转为 `7`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
UV_CACHE_DIR=/private/tmp/comfyps-uv-cache uv run --with aiohttp python -m unittest dev.test_aigate_native -v
```

Expected: FAIL，因为 mock 尚不支持 `release` 和 `/aigate/close-managed`。

- [ ] **Step 3: 实现最小 mock 状态**

使用模块级实例字典保存 `instanceId`、`operationStatus`、`hasComfyui`：

```python
_mock_aigate_instances = {
    "mock-running": {
        "instanceId": "mock-running",
        "instanceName": "Mock Boogu GPU",
        "operationStatus": "2",
        "hasComfyui": True,
    },
}

def _mock_aigate_ids(values):
    result = []
    for value in values or []:
        instance_id = str(value or "").strip()
        if instance_id and instance_id not in result:
            result.append(instance_id)
    return result
```

`handle_aigate_instance_action` 将 `open` 写为 `"2"`、`close` 写为 `"7"`、`release` 写为 `"4"`。`handle_aigate_instances` 只返回状态不为 `"4"` 的字典副本。`handle_aigate_close_managed` 遍历 `_mock_aigate_ids(body.get("managedInstanceIds"))`，把可见实例写为 `"7"` 并返回 `{ "ok": true, "closed": closed, "failed": failed }`。

- [ ] **Step 4: 运行开发 mock 测试确认通过**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: 提交 mock 改动**

```bash
git add dev/dev_server.py dev/test_aigate_native.py
git commit -m "test: model AIGate instance lifecycle in dev bridge"
```

### Task 4: 面板持久化本地运行时间并呈现操作

**Files:**
- Modify: `plugin/test_aigate_native.js`
- Modify: `plugin/main.js`
- Modify: `plugin/index.html`

- [ ] **Step 1: 写面板纯函数的失败测试**

在 Node vm 测试 loader 中使 `Date.now()` 可控，新增：

```javascript
test("records runtime only after first observed running state", function () {
  var context = loadAigateContext();
  context.Date.now = function () { return 1000; };
  context.saveAigateLifecycle({ "i-1": { managed: true, pendingStart: true, startedAt: 0 } });

  context.reconcileAigateLifecycle([{ instanceId: "i-1", operationStatus: "2" }]);

  assert.deepEqual(context.loadAigateLifecycle()["i-1"], {
    managed: true, pendingStart: false, startedAt: 1000,
  });
});

test("does not invent runtime for an unmanaged running instance", function () {
  var context = loadAigateContext();
  context.reconcileAigateLifecycle([{ instanceId: "external", operationStatus: "2" }]);
  assert.equal(context.formatAigateRuntime("external", 2000), "开始时间未知");
});

test("removes a released instance from local lifecycle", function () {
  var context = loadAigateContext();
  context.saveAigateLifecycle({ "i-1": { managed: true, pendingStart: false, startedAt: 1000 } });
  context.removeAigateLifecycle("i-1");
  assert.equal(context.loadAigateLifecycle()["i-1"], undefined);
});
```

还要断言 HTML 与主脚本包含“运行”“启动”“关闭”“释放”以及 `uxpcommand`、`/aigate/close-managed`。

- [ ] **Step 2: 运行面板测试确认失败**

Run:

```bash
node --test plugin/test_aigate_native.js
```

Expected: FAIL，因为生命周期 helper 与释放 UI 尚不存在。

- [ ] **Step 3: 实现 ES5 本地生命周期 helper**

在 `main.js` 的设置 key 附近定义并实现（`loadAigateLifecycle()` 对破损/非对象 JSON 返回空对象）：

```javascript
var AIGATE_LIFECYCLE_STORAGE_KEY = "comfyps.aigateInstanceLifecycle.v1";

function loadAigateLifecycle() {
  var raw = localStorage.getItem(AIGATE_LIFECYCLE_STORAGE_KEY);
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveAigateLifecycle(records) {
  localStorage.setItem(AIGATE_LIFECYCLE_STORAGE_KEY, JSON.stringify(records || {}));
}

function managedAigateInstanceIds() {
  var records = loadAigateLifecycle();
  var ids = [];
  for (var instanceId in records) {
    if (Object.prototype.hasOwnProperty.call(records, instanceId) && records[instanceId].managed) ids.push(instanceId);
  }
  return ids;
}

function reconcileAigateLifecycle(instances) {
  var records = loadAigateLifecycle();
  var changed = false;
  for (var i = 0; i < (instances || []).length; i++) {
    var instance = instances[i] || {};
    var record = records[String(instance.instanceId || "")];
    if (record && record.managed && record.pendingStart && String(instance.operationStatus) === "2") {
      record.pendingStart = false;
      record.startedAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAigateLifecycle(records);
  return records;
}

function formatAigateRuntime(instanceId, now) {
  var record = loadAigateLifecycle()[String(instanceId || "")];
  if (!record || !record.managed || !record.startedAt) return "开始时间未知";
  var seconds = Math.max(0, Math.floor(((now || Date.now()) - record.startedAt) / 1000));
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  var remain = seconds % 60;
  function pad(value) { return value < 10 ? "0" + value : String(value); }
  return "运行 " + pad(hours) + ":" + pad(minutes) + ":" + pad(remain);
}

function removeAigateLifecycle(instanceId) {
  var records = loadAigateLifecycle();
  delete records[String(instanceId || "")];
  saveAigateLifecycle(records);
}
```

不得使用 `const`、`let`、箭头函数、`Array.find` 或模板字符串。`refreshAigateInstances` 向请求体加入 `managedInstanceIds: managedAigateInstanceIds()`；先检查 `response.ok` 后再调用 `response.json()`，接着调用 `reconcileAigateLifecycle(data.instances || [])`，最后渲染。定义 `_aigateRefreshTimer` 和 `_aigateRuntimeTimer`：在设置面板可见且有受管实例时分别以 10 秒和 1 秒调度刷新/重渲染；离开设置或没有受管实例时用 `clearInterval` 清除二者。

`_renderAigateInstances` 对状态 `2` 显示 `formatAigateRuntime(id)` 并渲染“关闭”“释放”；对 `7`/`22` 显示“已停止”并渲染“启动”“释放”；对 `4` 显示“已释放”且不渲染动作；其余过渡状态不渲染动作。`controlAigateInstance` 的 `open` 成功后保存 `{ managed: true, pendingStart: true, startedAt: 0 }`，`release` 前调用 `confirm("释放实例后将无法恢复，是否继续？")`，成功后调用 `removeAigateLifecycle(id)`；`close` 保留记录但停止显示运行时间。

在 `index.html` 添加 `.aigate-instance-row`、`.aigate-instance-meta`、`.aigate-instance-actions` 和 `.aigate-runtime` 样式，继续使用 `--bg-card`、`--text-dim`、`--accent`、`--danger` 与现有 `btn-sm`/`btn-danger`，不引入 CSS Grid。

- [ ] **Step 4: 添加 UXP 正常退出清理**

在模块级增加一次性标记并实现：

```javascript
var _aigateLifecycleCloseRequested = false;

function requestAigateManagedClose() {
  if (_aigateLifecycleCloseRequested) return;
  var token = _getAigateToken();
  var ids = managedAigateInstanceIds();
  if (!token || !ids.length) return;
  _aigateLifecycleCloseRequested = true;
  var url = loadSettings().bridgeUrl.replace(/\/+$/, "") + "/aigate/close-managed";
  var body = JSON.stringify({ aigateToken: token, managedInstanceIds: ids });
  if (navigator && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    return;
  }
  fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body
  }, 1500).catch(function () {});
}
```

该操作没有 Token 或 ID 时直接返回；只关闭，不释放。

在初始化 IIFE 中注册：

```javascript
document.addEventListener("uxpcommand", function (event) {
  if (event && event.commandId === "uxphidepanel") requestAigateManagedClose();
});
window.addEventListener("beforeunload", requestAigateManagedClose);
```

用模块级布尔值确保一次退出周期最多提交一次；该操作只关闭，不释放。

- [ ] **Step 5: 运行面板测试确认通过**

Run the Step 2 command, then:

```bash
node --check plugin/main.js
if rg -n '\\b(const|let)\\b|=>|\\.find\\(|Object\\.assign\\(|classList\\.toggle\\([^,]+,[^)]+\\)' plugin/main.js; then exit 1; fi
```

Expected: all PASS, ES5 search has no matches.

- [ ] **Step 6: 提交面板改动**

```bash
git add plugin/index.html plugin/main.js plugin/test_aigate_native.js
git commit -m "feat: show AIGate runtime and lifecycle controls"
```

### Task 5: 集成验证与交付

**Files:**
- Verify: `.github/workflows/ci.yml`

- [ ] **Step 1: 运行完整测试与静态检查**

```bash
UV_CACHE_DIR=/private/tmp/comfyps-uv-cache uv run --with aiohttp python -m unittest bridge.test_comfyui_connectivity dev.test_comfyui_connectivity bridge.test_aigate_native bridge.test_aigate_bridge dev.test_aigate_native -v
PYTHONPYCACHEPREFIX=/private/tmp/comfyps-pycache python3 -m py_compile bridge/bridge.py bridge/aigate_native.py dev/dev_server.py
node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js
node --check plugin/main.js
for f in workflows/*.json; do python3 -m json.tool "$f" >/dev/null || exit 1; done
git diff --check origin/main...HEAD
```

Expected: all checks pass.

- [ ] **Step 2: 检查 CI 已覆盖扩展测试文件**

确认 `.github/workflows/ci.yml` 已运行 `bridge.test_aigate_native`、`bridge.test_aigate_bridge`、`dev.test_aigate_native` 和 `plugin/test_aigate_native.js`；无需新增独立 job。

- [ ] **Step 3: 同步 main 并发布 PR**

```bash
git fetch origin
git rebase origin/main
git push -u origin feat/aigate-instance-lifecycle
gh pr create --base main --head feat/aigate-instance-lifecycle --title "feat: add AIGate instance lifecycle controls"
```

Expected: rebase 无冲突，PR 指向 `main`。
