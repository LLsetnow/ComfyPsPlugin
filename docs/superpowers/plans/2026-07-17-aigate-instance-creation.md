# 云扉 ComfyUI 创建实例 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在云扉 ComfyUI 设置中安全显示账户余额与实时 GPU 价格，并在云扉实例列表为空时创建一台本机配置的预设 ComfyUI 实例。

**Architecture:** UXP 面板继续只向本地 bridge 发送 Bearer Token；bridge 的 `aigate_native` 适配层负责云扉 OpenAPI，`bridge.py` 负责本机配置和“仅空列表可创建”的服务端保护。设置页在成功获取完整实例列表后决定显示实例列表或原位的创建状态机，开发服务器提供等价 mock。

**Tech Stack:** UXP ES5 DOM JavaScript、CSS Flexbox、Python 3.12、aiohttp、Python unittest、Node `node:test`。

---

> **Review amendment (2026-07-17):** 云扉 OpenAPI 将 `balance` 和 SKU `price` 定义为字符串，但未说明货币单位或计费周期。Task 1 已在 `4ee1d77` 修正为只返回原始值。Task 2–6 必须显示原始值，不得生成 `balanceLabel`、`priceLabel`、`¥`、除以 100 或“/ 小时”文案；Task 1 中较早的格式化片段仅记录已被替换的实施路径，不得重复执行。

## File structure

- `bridge/aigate_native.py` — 云扉余额、SKU、创建实例的安全适配函数和金额格式化。
- `bridge/bridge.py` — 本地 HTTP 端点、本机预设镜像配置校验，以及创建前的空实例列表保护。
- `bridge/bridge_common.py` — 保持既有配置加载；不将创建配置设成运行桥的全局必填项。
- `bridge/config.example.json` — 文档化可选的 `aigateCreate` 本机配置块。
- `bridge/test_aigate_native.py` — 对云扉 HTTP 请求、金额/错误处理的适配层测试。
- `bridge/test_aigate_bridge.py` — 对本地 bridge 响应、空列表保护和 Token 不回显的端点测试。
- `dev/dev_server.py` — 面板开发预览使用的余额、SKU、创建端点和可重置空实例 fixture。
- `dev/test_aigate_native.py` — 开发 mock 的创建生命周期测试。
- `plugin/index.html` — 云扉账户状态和实例区域的静态 DOM 锚点。
- `plugin/settings.js` — 云扉设置控制器、创建状态机和动态 DOM 渲染。
- `plugin/styles.css` — 账户余额块、SKU 价格行、确认和创建中状态的样式。
- `plugin/init.js` — 账户/实例刷新按钮绑定。
- `plugin/test_aigate_native.js` — UXP 无 DOM 纯函数、静态锚点与创建可见性规则测试。

### Task 1: 扩展云扉原生适配层

**Files:**

- Modify: `bridge/aigate_native.py:36-156`
- Modify: `bridge/test_aigate_native.py:96-193, 206-270`

- [ ] **Step 1: 为余额、SKU 和创建请求写失败测试**

  在 `AigateNativeHttpTests.asyncSetUp` 中加入三个 aiohttp mock 路由，并记录请求：

  ```python
  async def account_balance(request):
      self.requests.append({"kind": "balance", "headers": dict(request.headers)})
      return web.json_response({"code": 0, "data": {"balance": "12898"}})

  async def sku_list(request):
      self.requests.append({"kind": "sku", "headers": dict(request.headers),
                            "areaName": request.query.get("areaName")})
      return web.json_response({"code": 0, "data": [{
          "skuName": "4090-24GB-DDR5", "price": "199", "vmSize": "24"
      }]})

  async def start_instance(request):
      self.requests.append({"kind": "create", "headers": dict(request.headers),
                            "body": await request.json()})
      return web.json_response({"code": 0, "data": {
          "instanceId": "new-1", "instanceName": "", "operationStatus": "1"
      }})
  ```

  注册 `/user/balance`、`/instance/skuList` 和 `/instance/start`，然后加入：

  ```python
  async def test_reads_balance_and_formats_cents(self):
      from bridge.aigate_native import get_aigate_account
      actual = await get_aigate_account("demo-token", self.session, self.api_base)
      self.assertEqual(actual, {"balance": "12898", "balanceLabel": "¥ 128.98"})
      self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer demo-token")

  async def test_lists_skus_with_price_label_and_area(self):
      from bridge.aigate_native import list_aigate_skus
      actual = await list_aigate_skus("demo-token", "华东一区", self.session, self.api_base)
      self.assertEqual(actual, [{"skuName": "4090-24GB-DDR5", "vmSize": "24",
                                 "price": "199", "priceLabel": "¥ 1.99 / 小时"}])
      self.assertEqual(self.requests[-1]["areaName"], "华东一区")

  async def test_creates_configured_instance_without_echoing_token(self):
      from bridge.aigate_native import create_aigate_instance
      actual = await create_aigate_instance("demo-token", "4090-24GB-DDR5", {
          "areaName": "华东一区", "imageId": "42", "imageType": "2"
      }, self.session, self.api_base)
      self.assertEqual(actual["instanceId"], "new-1")
      self.assertEqual(self.requests[-1]["body"], {
          "skuName": "4090-24GB-DDR5", "areaName": "华东一区",
          "count": 1, "imageId": "42", "imageType": "2"
      })
  ```

- [ ] **Step 2: 运行测试并确认缺少函数导致失败**

  Run: `python -m unittest bridge.test_aigate_native.AigateNativeHttpTests -v`

  Expected: FAIL，提示无法从 `bridge.aigate_native` 导入 `get_aigate_account`、`list_aigate_skus` 和 `create_aigate_instance`。

- [ ] **Step 3: 实现最小的适配函数与价格格式化**

  在 `_aigate_json` 后加入以下函数；所有请求继续通过 `_aigate_json`，以复用 Bearer 规范化、超时和不回显远端响应的错误策略：

  ```python
  def format_aigate_cents(value, suffix=""):
      raw = str(value or "").strip()
      if not re.match(r"^\d+$", raw):
          raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回有效价格")
      cents = int(raw)
      amount = str(cents // 100) + "." + str(cents % 100).zfill(2)
      return "¥ " + amount + suffix

  async def get_aigate_account(token, session, api_base=AIGATE_API_BASE):
      data = await _aigate_json(session, "POST", api_base.rstrip("/") + "/user/balance", token)
      if not isinstance(data, dict) or not str(data.get("balance") or "").strip():
          raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回账户余额")
      balance = str(data["balance"]).strip()
      return {"balance": balance, "balanceLabel": format_aigate_cents(balance)}

  async def list_aigate_skus(token, area_name, session, api_base=AIGATE_API_BASE):
      area = str(area_name or "").strip()
      if not area:
          raise AigateNativeError("AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置云扉区域", 409)
      url = api_base.rstrip("/") + "/instance/skuList?" + urlencode({"areaName": area})
      data = await _aigate_json(session, "GET", url, token)
      if not isinstance(data, list):
          raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回可用 GPU 规格")
      result = []
      for record in data:
          if isinstance(record, dict) and str(record.get("skuName") or "").strip():
              price = str(record.get("price") or "").strip()
              result.append({"skuName": str(record["skuName"]),
                             "vmSize": str(record.get("vmSize") or ""),
                             "price": price,
                             "priceLabel": format_aigate_cents(price, " / 小时")})
      return result

  async def create_aigate_instance(token, sku_name, create_config, session,
                                   api_base=AIGATE_API_BASE):
      payload = {"skuName": str(sku_name or "").strip(),
                 "areaName": create_config["areaName"], "count": 1,
                 "imageId": create_config["imageId"],
                 "imageType": create_config["imageType"]}
      if not payload["skuName"]:
          raise AigateNativeError("AIGATE_SKU_REQUIRED", "请选择 GPU 规格", 400)
      data = await _aigate_json(session, "POST", api_base.rstrip("/") + "/instance/start", token, payload)
      if not isinstance(data, dict) or not str(data.get("instanceId") or "").strip():
          raise AigateNativeError("AIGATE_BAD_RESPONSE", "云扉未返回新实例 ID")
      return {"instanceId": str(data["instanceId"]),
              "instanceName": str(data.get("instanceName") or ""),
              "operationStatus": str(data.get("operationStatus") or "1"),
              "hasComfyui": True}
  ```

  `format_aigate_cents` 的 `199 → ¥ 1.99` 规则与云扉 `skuList` 和余额示例中的整数最小货币单位一致；后续改动若云扉公开单位元数据，必须只替换此 bridge 函数。

- [ ] **Step 4: 运行适配层测试**

  Run: `python -m unittest bridge.test_aigate_native -v`

  Expected: PASS，现有实例发现/工作流测试和新增三项 HTTP 测试均通过。

- [ ] **Step 5: 提交适配层**

  ```bash
  git add bridge/aigate_native.py bridge/test_aigate_native.py
  git commit -m "feat: add aigate account and sku adapter"
  ```

### Task 2: 增加 bridge 创建端点和本机预设镜像配置

**Files:**

- Modify: `bridge/config.example.json:1-13`
- Modify: `bridge/bridge.py:39-48, 206-272, 511-520`
- Modify: `bridge/test_aigate_bridge.py:56-145`

- [ ] **Step 1: 写 bridge 端点和空列表保护的失败测试**

  在 `AigateBridgeEndpointTests` 新增：

  ```python
  async def test_returns_account_without_token(self):
      with patch.object(bridge, "get_aigate_account", new=AsyncMock(
          return_value={"balance": "12898"}
      )):
          response = await bridge.handle_aigate_account(JsonRequest({"aigateToken": "demo-token"}))
      self.assertEqual(json.loads(response.body.decode("utf-8")), {
          "ok": True, "balance": "12898"
      })
      self.assertNotIn("demo-token", response.body.decode("utf-8"))

  async def test_rejects_create_when_any_instance_exists(self):
      with patch.object(bridge, "list_instance_summaries", new=AsyncMock(
          return_value=[{"instanceId": "existing", "operationStatus": "7"}]
      )) as listed, patch.object(bridge, "create_aigate_instance", new=AsyncMock()) as created:
          response = await bridge.handle_aigate_create_instance(JsonRequest({
              "aigateToken": "demo-token", "skuName": "4090-24GB-DDR5"
          }))
      self.assertEqual(response.status, 409)
      self.assertEqual(json.loads(response.body.decode("utf-8"))["error"], "AIGATE_INSTANCE_EXISTS")
      listed.assert_awaited_once()
      created.assert_not_awaited()
  ```

  在各测试前保存 `bridge.CONFIG` 并设置：

  ```python
  bridge.CONFIG["aigateCreate"] = {
      "areaName": "华东一区", "imageId": "42", "imageType": "2"
  }
  ```

  加一项 `/aigate/create-options` 测试，mock `list_aigate_skus` 并断言响应只包含 `options` 和 `updatedAt`；加一项配置缺失测试，断言 `409/AIGATE_CREATE_CONFIG_REQUIRED`。

- [ ] **Step 2: 运行 bridge 测试并确认端点尚未定义**

  Run: `python -m unittest bridge.test_aigate_bridge -v`

  Expected: FAIL，提示 `handle_aigate_account` 和 `handle_aigate_create_instance` 尚不存在。

- [ ] **Step 3: 实现配置校验、端点和路由**

  扩展 `bridge.py` 的 `aigate_native` 导入并加入以下本机配置读取器：

  ```python
  def get_aigate_create_config():
      raw = CONFIG.get("aigateCreate")
      if not isinstance(raw, dict):
          raise AigateNativeError("AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置预设 ComfyUI 镜像", 409)
      result = {
          "areaName": str(raw.get("areaName") or "").strip(),
          "imageId": str(raw.get("imageId") or "").strip(),
          "imageType": str(raw.get("imageType") or "").strip(),
      }
      if not all(result.values()):
          raise AigateNativeError("AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置预设 ComfyUI 镜像", 409)
      return result
  ```

  三个处理器均使用以下完整 JSON/Token 验证器。创建处理器先读取完整 `list_instance_summaries`，仅在 `instances == []` 时调用 `create_aigate_instance`；成功后调用 `_sync_aigate_managed_instances(token, [result["instanceId"]])`：

  ```python
  async def read_aigate_request(request):
      try:
          body = await request.json()
      except Exception:
          return None, "", cors(web.json_response(
              {"ok": False, "error": "BAD_JSON", "message": "请求体不是 JSON"}, status=400))
      token = str(body.get("aigateToken") or "").strip()
      if not token:
          return body, "", cors(web.json_response(
              {"ok": False, "error": "AIGATE_TOKEN_REQUIRED",
               "message": "请输入云扉 Bearer Token"}, status=400))
      return body, token, None

  async def handle_aigate_account(request):
      body, token, error_response = await read_aigate_request(request)
      if error_response:
          return error_response
      try:
          async with ClientSession(timeout=ClientTimeout(total=15)) as session:
          account = await get_aigate_account(token, session)
          return cors(web.json_response({"ok": True, **account, "updatedAt": int(time.time() * 1000)}))
      except AigateNativeError as error:
          return cors(web.json_response({"ok": False, "error": error.code,
                                         "message": error.message}, status=error.status))

  async def handle_aigate_create_options(request):
      body, token, error_response = await read_aigate_request(request)
      if error_response:
          return error_response
      try:
          config = get_aigate_create_config()
          async with ClientSession(timeout=ClientTimeout(total=15)) as session:
              options = await list_aigate_skus(token, config["areaName"], session)
          return cors(web.json_response({"ok": True, "options": options,
                                         "updatedAt": int(time.time() * 1000)}))
      except AigateNativeError as error:
          return cors(web.json_response({"ok": False, "error": error.code,
                                         "message": error.message}, status=error.status))

  async def handle_aigate_create_instance(request):
      body, token, error_response = await read_aigate_request(request)
      if error_response:
          return error_response
      try:
          config = get_aigate_create_config()
          async with ClientSession(timeout=ClientTimeout(total=15)) as session:
              instances = await list_instance_summaries(token, session)
              if instances:
                  raise AigateNativeError("AIGATE_INSTANCE_EXISTS", "云扉控制台已有实例，不能重复创建", 409)
              result = await create_aigate_instance(token, body.get("skuName"), config, session)
          _sync_aigate_managed_instances(token, [result["instanceId"]])
          return cors(web.json_response({"ok": True, "instance": result}))
      except AigateNativeError as error:
          return cors(web.json_response({"ok": False, "error": error.code,
                                         "message": error.message}, status=error.status))
  ```

  在 `main()` 中注册：

  ```python
  app.router.add_post("/aigate/account", handle_aigate_account)
  app.router.add_post("/aigate/create-options", handle_aigate_create_options)
  app.router.add_post("/aigate/create-instance", handle_aigate_create_instance)
  ```

  在 `config.example.json` 的 `port` 前加入可选块：

  ```json
  "_aigateCreate_comment": "创建云扉 ComfyUI 实例时填写；imageId 为预设 ComfyUI 镜像 ID。",
  "aigateCreate": {
    "areaName": "",
    "imageId": "",
    "imageType": "2"
  },
  ```

  不修改 `load_config()` 的必填字段，确保未配置创建镜像的既有 bridge 仍可启动和运行已有实例。

- [ ] **Step 4: 运行 bridge 回归测试和语法检查**

  Run: `python -m py_compile bridge/bridge.py bridge/aigate_native.py && python -m unittest bridge.test_aigate_bridge -v`

  Expected: PASS；端点成功响应不包含 Token，已有任意实例时创建端点返回 409。

- [ ] **Step 5: 提交 bridge API**

  ```bash
  git add bridge/bridge.py bridge/config.example.json bridge/test_aigate_bridge.py
  git commit -m "feat: add aigate instance creation endpoints"
  ```

### Task 3: 让开发服务器复现账户、SKU 和创建生命周期

**Files:**

- Modify: `dev/dev_server.py:567-656, 1000-1025`
- Modify: `dev/test_aigate_native.py:15-56`

- [ ] **Step 1: 写从空列表创建实例的失败测试**

  用可重置 fixture 替代对模块全局列表的直接依赖：

  ```python
  class AigateDevMockTests(unittest.IsolatedAsyncioTestCase):
      def setUp(self):
          dev_server.reset_mock_aigate_instances([])

      async def test_empty_console_exposes_account_skus_and_created_instance(self):
          account = await dev_server.handle_aigate_account(JsonRequest({"aigateToken": "demo-token"}))
          self.assertEqual(json.loads(account.body.decode("utf-8"))["balance"], "12898")
          options = await dev_server.handle_aigate_create_options(JsonRequest({"aigateToken": "demo-token"}))
          sku = json.loads(options.body.decode("utf-8"))["options"][0]
          self.assertEqual(sku["price"], "199")
          created = await dev_server.handle_aigate_create_instance(JsonRequest({
              "aigateToken": "demo-token", "skuName": sku["skuName"]
          }))
          self.assertTrue(json.loads(created.body.decode("utf-8"))["ok"])
          listed = await dev_server.handle_aigate_instances(JsonRequest({"aigateToken": "demo-token"}))
          self.assertEqual(len(json.loads(listed.body.decode("utf-8"))["instances"]), 1)
  ```

  另加一项在 `reset_mock_aigate_instances` 放入一个状态为 `"7"` 的实例后调用创建端点、断言 HTTP 409 的测试。

- [ ] **Step 2: 运行 mock 测试并确认新处理器未定义**

  Run: `python -m unittest dev.test_aigate_native -v`

  Expected: FAIL，提示 `reset_mock_aigate_instances`、`handle_aigate_account` 和 `handle_aigate_create_options` 未定义。

- [ ] **Step 3: 实现确定性的 mock 数据和端点**

  在 `dev_server.py` 定义不可变 SKU fixture 与复制式重置函数：

  ```python
  _MOCK_AIGATE_SKUS = [
      {"skuName": "4090-24GB-DDR5", "vmSize": "24", "price": "199"},
      {"skuName": "A100-80GB", "vmSize": "80", "price": "899"},
  ]
  _mock_aigate_instances = []

  def reset_mock_aigate_instances(instances=None):
      global _mock_aigate_instances
      _mock_aigate_instances = [dict(item) for item in (instances or [])]
  ```

  余额端点返回 `{ "ok": true, "balance": "12898", "updatedAt": 0 }`；SKU 端点返回复制的 `_MOCK_AIGATE_SKUS`；创建端点先拒绝非空 `_mock_aigate_instances`，验证 `skuName` 在 fixture 中，再 append：

  ```python
  instance = {"instanceId": "mock-created-" + str(len(_mock_aigate_instances) + 1),
              "instanceName": "ComfyUI（开发模拟）", "operationStatus": "1", "hasComfyui": True}
  _mock_aigate_instances.append(instance)
  return web.json_response({"ok": True, "instance": dict(instance)})
  ```

  在 `main()` 的 mock 路由区注册与生产 bridge 相同的三个 `POST /aigate/...` 路由。`handle_aigate_instances` 返回所有未释放的 mock，绝不在空请求或异常时伪造空列表。

- [ ] **Step 4: 运行开发 mock 测试**

  Run: `python -m unittest dev.test_aigate_native -v`

  Expected: PASS；现有启动/关闭/释放覆盖仍通过，新增空列表创建和已有停止实例拒绝创建测试通过。

- [ ] **Step 5: 提交开发 mock**

  ```bash
  git add dev/dev_server.py dev/test_aigate_native.py
  git commit -m "feat: mock aigate instance creation"
  ```

### Task 4: 建立云扉账户和创建卡的静态 UI 外壳

**Files:**

- Modify: `plugin/index.html:190-203`
- Modify: `plugin/styles.css:549-565`
- Modify: `plugin/test_aigate_native.js:73-112`

- [ ] **Step 1: 为静态锚点和 UI 状态 class 写失败测试**

  在 `plugin/test_aigate_native.js` 增加：

  ```js
  test("settings expose aigate account and conditional create anchors", function () {
    var html = fs.readFileSync("plugin/index.html", "utf8");
    var css = fs.readFileSync("plugin/styles.css", "utf8");
    assert.match(html, /id="aigateAccountStatus"/);
    assert.match(html, /id="btnRefreshAigateAccount"/);
    assert.match(html, /id="aigateInstanceList"/);
    assert.match(css, /\.aigate-account-card/);
    assert.match(css, /\.aigate-create-card/);
    assert.match(css, /\.aigate-sku-price/);
  });
  ```

- [ ] **Step 2: 运行 Node 测试并确认锚点不存在**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，`aigateAccountStatus`、刷新按钮和创建卡样式 class 尚不存在。

- [ ] **Step 3: 添加账户区域、可访问文本和 Flexbox 样式**

  在 Token `setting-row` 后、实例 `setting-row` 前插入：

  ```html
  <div class="setting-row">
    <div class="setting-label">云扉账户</div>
    <div id="aigateAccountStatus" class="aigate-account-card">
      <span class="aigate-account-pending">输入 Token 后读取余额</span>
      <button id="btnRefreshAigateAccount" class="aigate-account-refresh" type="button">↻ 更新余额</button>
    </div>
  </div>
  ```

  在 `styles.css` 中添加基于现有变量的 `.aigate-account-card`、`.aigate-account-balance`、`.aigate-account-meta`、`.aigate-account-refresh`、`.aigate-create-card`、`.aigate-sku-row`、`.aigate-sku-row.selected`、`.aigate-sku-meta`、`.aigate-sku-price`、`.aigate-create-actions`、`.aigate-create-notice` 和 `.aigate-create-progress`。全部使用 `display:flex`、现有 `--*` 色值与 `var(--radius)`；不使用 CSS grid。价格列使用 `margin-left:auto` 和 `font-variant-numeric: tabular-nums`，窄面板中仍不溢出。

- [ ] **Step 4: 运行 Node 静态测试与 UXP ES5 检查**

  Run: `node --test plugin/test_aigate_native.js && FILES=$(ls plugin/*.js | grep -v '/test_'); ! rg -n '=>|\bconst\b|\blet\b|\.find\(|Object\.assign\(' $FILES`

  Expected: PASS；HTML/CSS 锚点存在，所有 UXP 运行时模块仍为 ES5。

- [ ] **Step 5: 提交 UI 外壳**

  ```bash
  git add plugin/index.html plugin/styles.css plugin/test_aigate_native.js
  git commit -m "feat: add aigate account and create card UI"
  ```

### Task 5: 实现 UXP 创建状态机、错误处理和按钮绑定

**Files:**

- Modify: `plugin/settings.js:72-198`
- Modify: `plugin/init.js:194-196`
- Modify: `plugin/test_aigate_native.js:113-180`

- [ ] **Step 1: 为可见性和价格显示纯函数写失败测试**

  在 `loadAigateContext()` 返回的 VM 上测试先于 init IIFE 定义的函数：

  ```js
  test("only renders create flow after a confirmed empty instance response", function () {
    var context = loadAigateContext();
    assert.equal(context.shouldShowAigateCreate([]), true);
    assert.equal(context.shouldShowAigateCreate([{ instanceId: "running", operationStatus: "2" }]), false);
    assert.equal(context.shouldShowAigateCreate([{ instanceId: "stopped", operationStatus: "7" }]), false);
    assert.equal(context.shouldShowAigateCreate(null), false);
  });

  test("keeps bridge-provided raw sku prices intact", function () {
    var context = loadAigateContext();
    assert.equal(context.aigateSkuPriceText({ price: "199" }), "199");
    assert.equal(context.aigateSkuPriceText({}), "价格暂不可用");
  });
  ```

- [ ] **Step 2: 运行 Node 测试并确认纯函数不存在**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，`shouldShowAigateCreate` 和 `aigateSkuPriceLabel` 尚未定义。

- [ ] **Step 3: 实现读取、渲染和创建状态机**

  在现有云扉状态变量旁加入：

  ```js
  var _aigateAccount = null;
  var _aigateSkuOptions = [];
  var _aigateSelectedSkuName = "";
  var _aigateCreateState = "idle";
  var _aigateCreateError = "";

  function shouldShowAigateCreate(instances) {
    return Array.isArray(instances) && instances.length === 0;
  }

  function aigateSkuPriceText(sku) {
    return sku && sku.price !== undefined && sku.price !== null && String(sku.price) !== ""
      ? String(sku.price) : "价格暂不可用";
  }
  ```

  实现 `refreshAigateAccount()`，向 `/aigate/account` 发 JSON POST，成功时把 `data.updatedAt || Date.now()` 保存到 `_aigateAccount`，失败时保存 `{ error: message }`，再调用 `_renderAigateAccount()`；渲染函数使用 DOM API 在余额方块内创建“当前账户余额 / 原始 balance / 上次更新于 HH:mm / ↻ 更新余额”，不使用 `innerHTML` 拼接 Token。

  将 `refreshAigateInstances()` 视为唯一的“列表可信状态”来源：成功后才赋值 `_aigateInstances`，再调用 `_renderAigateInstances(_aigateInstances)`。函数开始时不得清空旧成功列表；`catch` 只显示“读取云扉实例失败”，并让 `shouldShowAigateCreate(null)` 保持 false。成功时并行调用 `refreshAigateAccount()`；只有 `shouldShowAigateCreate(_aigateInstances)` 为 true 时调用 `refreshAigateCreateOptions()`。

  `refreshAigateCreateOptions()` 调用 `/aigate/create-options`，保存 `options`。`_renderAigateInstances()` 在 confirmed-empty 时改为调用 `_renderAigateCreate(container)`；在任意非空数组时只渲染现有实例行，绝不追加创建按钮。创建卡包含：

  ```js
  // idle: 每个 sku 是 button.aigate-sku-row；右侧使用 aigateSkuPriceText(sku)
  // confirm: 显示 selected.skuName、selected.vmSize、selected.price、返回/确认创建
  // creating: 显示“已提交创建请求 / 正在分配云端算力 / 等待 ComfyUI 服务就绪”
  ```

  `submitAigateCreate()` 调用 `/aigate/create-instance`，在请求前设为 `creating` 并禁用按钮；成功后把返回的 `instance` 写入 `_aigateInstances`、登记 `{ managed: true, pendingStart: true, startedAt: 0 }`、渲染实例行、开始既有轮询。失败时保留 `_aigateSelectedSkuName`，设 `_aigateCreateState = "confirm"` 和 `_aigateCreateError`，让用户重试或返回。创建确认中的价格始终使用同一 SKU 的原始 `price`，不能转换为任何未声明的货币或周期。

  在 `init.js` 中绑定：

  ```js
  var btnRefreshAigateAccount = $("btnRefreshAigateAccount");
  if (btnRefreshAigateAccount) btnRefreshAigateAccount.addEventListener("click", refreshAigateAccount);
  ```

  同时将已有 `btnRefreshAigateInstances` 的文本更新为“刷新”，它继续触发完整实例刷新；Token blur 后的既有 `saveAllSettings` 保持不变。

- [ ] **Step 4: 运行 UXP 逻辑测试和桥接单元回归**

  Run: `node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js && python -m unittest bridge.test_aigate_native bridge.test_aigate_bridge dev.test_aigate_native -v`

  Expected: PASS；空数组唯一显示创建卡、非空数组隐藏入口、价格标签不在 UXP 端换算，且原有实例生命周期测试通过。

- [ ] **Step 5: 提交设置页控制器**

  ```bash
  git add plugin/settings.js plugin/init.js plugin/test_aigate_native.js
  git commit -m "feat: create aigate instances from settings"
  ```

### Task 6: 端到端验证、配置文档和 PR 准备

**Files:**

- Modify: `README.md:52-60` 
- Verify: `bridge/config.json` (仅本机，Git 忽略，不提交)
- Verify: `plugin/index.html`, `plugin/settings.js`, `plugin/styles.css`, `dev/dev_server.py`

- [ ] **Step 1: 为本机配置说明写文档断言**

  在 `plugin/test_aigate_native.js` 增加：

  ```js
  test("setup documentation names the private aigate creation config", function () {
    var readme = fs.readFileSync("README.md", "utf8");
    var example = fs.readFileSync("bridge/config.example.json", "utf8");
    assert.match(readme, /aigateCreate/);
    assert.match(example, /"areaName"/);
    assert.match(example, /"imageId"/);
  });
  ```

- [ ] **Step 2: 运行断言并确认 README 尚未说明配置块**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，README 尚未出现 `aigateCreate`。

- [ ] **Step 3: 增加最小本机配置和预览验证说明**

  在 README 复制 `config.example.json` 的说明下插入：

  ````markdown
  如需从插件创建云扉 ComfyUI 实例，还需在本机 `bridge/config.json` 填入：

  ```json
  "aigateCreate": {
    "areaName": "华东一区",
    "imageId": "你的预设 ComfyUI 镜像 ID",
    "imageType": "2"
  }
  ```

  此配置仅供本地 bridge 使用，`config.json` 已被 Git 忽略。未配置时插件会说明缺少预设镜像，不会向云扉发起创建请求。
  ````

  使用开发服务器验证：先以空 mock 启动 `python dev/dev_server.py`，在浏览器选择“云扉 ComfyUI”，填写任意 Token，确认看到余额、SKU 价格和创建卡；确认创建后确认卡消失并显示创建中实例；调用刷新后确认不再显示创建入口。

- [ ] **Step 4: 运行完整质量门禁**

  Run:

  ```bash
  python -m py_compile bridge/bridge.py bridge/bridge_common.py bridge/gpt_image.py bridge/comfyui_exec.py bridge/aigate_native.py dev/dev_server.py
  python -m unittest bridge.test_comfyui_connectivity dev.test_comfyui_connectivity bridge.test_aigate_native bridge.test_aigate_bridge dev.test_aigate_native -v
  node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js
  FILES=$(ls plugin/*.js | grep -v '/test_'); ! rg -n '=>|\bconst\b|\blet\b|\.find\(|Object\.assign\(|classList\.toggle\([^,]+,[^)]+\)' $FILES
  git diff --check
  ```

  Expected: 所有命令退出码为 0；无 UXP ES6 违规、无空白错误、全部 Python/Node 测试通过。

- [ ] **Step 5: 提交文档与验证结果**

  ```bash
  git add README.md plugin/test_aigate_native.js
  git commit -m "docs: explain aigate creation setup"
  git status --short
  ```

  Expected: 只剩用户原有的未跟踪目录（`.claude/`、`.superpowers/`、`.understand-anything/`）；不得添加或提交它们。

## Plan self-review

- **Spec coverage:** Task 1 覆盖余额、SKU、价格与创建协议；Task 2 把本机镜像配置和“仅空实例可创建”落实在服务端；Task 3 保证开发预览同协议；Task 4–5 覆盖账户连接器、价格选择、确认、创建中、错误和 ES5 UXP DOM；Task 6 覆盖私有配置说明与 CI 质量门禁。
- **Placeholder scan:** 每个改动步骤都列出文件、函数、测试、命令与预期。
- **Type consistency:** 面板与 bridge 使用 `aigateToken`、`skuName`、原始 `price`、`instance`、`instances`；`aigateCreate` 均使用 `areaName`、`imageId`、`imageType`；创建状态统一为 `idle`、`confirm`、`creating`。
