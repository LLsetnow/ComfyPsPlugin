# 云扉默认镜像回退 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建云扉实例时按默认名称优先解析个人镜像，找不到时回退到同名社区镜像。

**Architecture:** bridge 从私有 `aigateCreate` 读取区域、可选显式镜像 ID 与命名镜像回退规则。`aigate_native` 负责调用云扉镜像分页 API、精确匹配名称并返回安全的 `{ imageId, imageType }`；bridge 在既有创建锁内把该结果交给现有创建函数。面板 API 和 `skuName` 创建载荷保持不变。

**Tech Stack:** Python 3、aiohttp、unittest/AsyncMock、Photoshop UXP ES5、Markdown。

---

### Task 1: 解析个人优先、社区兜底的默认镜像

**Files:**

- Modify: `bridge/aigate_native.py:14-16,60-128`
- Modify: `bridge/test_aigate_native.py:77-161,246-290`

- [ ] **Step 1: 扩展 aiohttp fixture 并写解析失败测试**

  在 `AigateNativeHttpTests.asyncSetUp()` 中加入 `/image/page` mock；它记录 JSON body 到 `self.requests` 的 `kind: "image-page"`，并按 `body["imageType"]` 返回 `self.personal_images` 或 `self.community_images`：

  ```python
  self.personal_images = []
  self.community_images = []

  async def image_page(request):
      body = await request.json()
      self.requests.append({
          "kind": "image-page", "headers": dict(request.headers), "body": body,
      })
      records = self.personal_images if body.get("imageType") == "3" else self.community_images
      return web.json_response({"code": 0, "data": {"total": len(records), "records": records}})

  app.router.add_post("/image/page", image_page)
  ```

  添加以下失败测试：

  ```python
  async def test_resolves_personal_image_before_community(self):
      from bridge.aigate_native import resolve_aigate_create_image
      self.personal_images = [{"worksId": "301", "name": "comfyui-boogu-edit-int8-20260716"}]
      self.community_images = [{"worksId": "302", "name": "comfyui-boogu-edit-int8-20260716"}]

      actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
          "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
          "imageName": "comfyui-boogu-edit-int8-20260716",
      }, self.session, self.api_base)

      self.assertEqual(actual["imageId"], 301)
      self.assertEqual(actual["imageType"], "3")
      self.assertEqual([item["body"]["imageType"] for item in self.requests if item.get("kind") == "image-page"], ["3"])

  async def test_falls_back_to_community_image_with_area_and_sku(self):
      from bridge.aigate_native import resolve_aigate_create_image
      self.community_images = [{"worksId": "302", "name": "comfyui-boogu-edit-int8-20260716"}]

      actual = await resolve_aigate_create_image("demo-token", "4090-24GB-DDR5", {
          "areaName": "华东一区", "imageId": "", "imageTypes": ["3", "2"],
          "imageName": "comfyui-boogu-edit-int8-20260716",
      }, self.session, self.api_base)

      self.assertEqual(actual["imageId"], 302)
      self.assertEqual(actual["imageType"], "2")
      community_request = [item for item in self.requests if item.get("kind") == "image-page"][-1]
      self.assertEqual(community_request["body"], {
          "current": 1, "pageSize": 20, "imageType": "2", "areaName": "华东一区",
          "skuName": "4090-24GB-DDR5", "imageName": "comfyui-boogu-edit-int8-20260716", "imageVersion": "",
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
  ```

- [ ] **Step 2: 运行新测试并确认缺少解析函数导致失败**

  Run: `.venv/bin/python -m unittest bridge.test_aigate_native.AigateNativeHttpTests -v`

  Expected: FAIL，提示不能导入 `resolve_aigate_create_image`。

- [ ] **Step 3: 实现安全的镜像解析函数**

  在 `AIGATE_API_BASE` 后定义：

  ```python
  DEFAULT_AIGATE_IMAGE_NAME = "comfyui-boogu-edit-int8-20260716"
  ```

  在 `_require_aigate_image_id()` 后实现以下函数。它只接受精确名称匹配，个人镜像逐页读取直到 `total` 条记录，社区镜像请求必须带区域、SKU 和镜像名称：

  ```python
  def _configured_aigate_image_id(create_config):
      value = create_config.get("imageId") if isinstance(create_config, dict) else None
      if value is None or (isinstance(value, str) and not value.strip()):
          return None
      return _require_aigate_image_id(create_config)

  def _image_id_from_records(records, image_name):
      for record in records or []:
          if not isinstance(record, dict) or str(record.get("name") or "") != image_name:
              continue
          value = record.get("worksId")
          if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
              return value
          if isinstance(value, str) and re.match(r"^\d+$", value.strip()):
              return int(value.strip())
      return None

  async def resolve_aigate_create_image(token, sku_name, create_config, session,
                                        api_base=AIGATE_API_BASE):
      explicit_id = _configured_aigate_image_id(create_config)
      if explicit_id is not None:
          return {"imageId": explicit_id, "imageType": create_config["imageType"]}
      image_name = str(create_config.get("imageName") or DEFAULT_AIGATE_IMAGE_NAME).strip()
      image_types = create_config.get("imageTypes") or ["3", "2"]
      for image_type in image_types:
          if image_type == "3":
              current = 1
              while True:
                  data = await _aigate_json(session, "POST", api_base.rstrip("/") + "/image/page", token, {
                      "current": current, "pageSize": 20, "imageType": "3",
                  })
                  records = data.get("records") if isinstance(data, dict) else None
                  image_id = _image_id_from_records(records, image_name)
                  if image_id is not None:
                      return {"imageId": image_id, "imageType": "3"}
                  if not isinstance(records, list) or current * 20 >= int(data.get("total") or 0):
                      break
                  current += 1
          if image_type == "2":
              data = await _aigate_json(session, "POST", api_base.rstrip("/") + "/image/page", token, {
                  "current": 1, "pageSize": 20, "imageType": "2",
                  "areaName": create_config["areaName"], "skuName": str(sku_name or "").strip(),
                  "imageName": image_name, "imageVersion": "",
              })
              image_id = _image_id_from_records(data.get("records") if isinstance(data, dict) else None, image_name)
              if image_id is not None:
                  return {"imageId": image_id, "imageType": "2"}
      raise AigateNativeError(
          "AIGATE_IMAGE_NOT_FOUND", "未找到默认 ComfyUI 镜像（已尝试个人和社区镜像）", 409
      )
  ```

- [ ] **Step 4: 运行 native 测试并验证现有显式 ID 路径**

  Run: `.venv/bin/python -m unittest bridge.test_aigate_native -v`

  Expected: PASS；新增解析测试通过，既有 `test_creates_configured_instance_with_numeric_image_id_and_bearer_token` 继续证明数值 ID 创建路径不变。

- [ ] **Step 5: 提交 native 镜像解析器**

  ```bash
  git add bridge/aigate_native.py bridge/test_aigate_native.py
  git commit -m "feat: resolve aigate personal and community images"
  ```

### Task 2: 在创建锁内接入镜像解析和兼容配置

**Files:**

- Modify: `bridge/bridge.py:38-49,233-249,289-312`
- Modify: `bridge/test_aigate_bridge.py:38-50,64-72,184-260`

- [ ] **Step 1: 写 bridge 配置和创建调用的失败测试**

  在 bridge 测试的 imports 中引入 `resolve_aigate_create_image` 的 mock，并添加：

  ```python
  def test_uses_default_named_image_when_no_explicit_id_is_configured(self):
      bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}
      actual = bridge.get_aigate_create_config()
      self.assertEqual(actual["imageId"], None)
      self.assertEqual(actual["imageName"], "comfyui-boogu-edit-int8-20260716")
      self.assertEqual(actual["imageTypes"], ["3", "2"])

  async def test_resolves_image_inside_empty_console_create_lock(self):
      bridge.CONFIG["aigateCreate"] = {"areaName": "华东一区"}
      resolved = {"imageId": 301, "imageType": "3"}
      created = {"instanceId": "new-1", "instanceName": "", "operationStatus": "1", "hasComfyui": True}
      with patch.object(bridge, "list_instance_summaries", new=AsyncMock(return_value=[])), \
           patch.object(bridge, "resolve_aigate_create_image", new=AsyncMock(return_value=resolved)) as resolve, \
           patch.object(bridge, "create_aigate_instance", new=AsyncMock(return_value=created)) as create:
          response = await bridge.handle_aigate_create_instance(JsonRequest({
              "aigateToken": "demo-token", "skuName": "4090-24GB-DDR5",
          }))
      self.assertEqual(response.status, 200)
      resolve.assert_awaited_once()
      self.assertEqual(resolve.await_args.args[1], "4090-24GB-DDR5")
      self.assertEqual(create.await_args.args[2]["imageId"], 301)
      self.assertEqual(create.await_args.args[2]["imageType"], "3")
  ```

- [ ] **Step 2: 运行 bridge 测试并确认失败**

  Run: `.venv/bin/python -m unittest bridge.test_aigate_bridge -v`

  Expected: FAIL，因为 `get_aigate_create_config()` 仍要求 `imageType`，且创建处理器尚未调用 `resolve_aigate_create_image()`。

- [ ] **Step 3: 扩展配置解析并在锁内合并已解析镜像**

  在两处 `aigate_native` import 中加入 `resolve_aigate_create_image`。替换 `get_aigate_create_config()` 为：

  ```python
  def get_aigate_create_config():
      raw = CONFIG.get("aigateCreate")
      if not isinstance(raw, dict):
          raise AigateNativeError(
              "AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置预设 ComfyUI 镜像", 409
          )
      area_name = str(raw.get("areaName") or "").strip()
      if not area_name:
          raise AigateNativeError(
              "AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置云扉区域", 409
          )
      image_id = raw.get("imageId")
      image_type = str(raw.get("imageType") or "").strip()
      if image_id is not None and str(image_id).strip() and image_type not in ("2", "3"):
          raise AigateNativeError(
              "AIGATE_CREATE_CONFIG_REQUIRED", "本机尚未配置有效的云扉镜像类型", 409
          )
      image_types = raw.get("imageTypes")
      if not isinstance(image_types, list):
          image_types = ["3", "2"]
      image_types = [str(value) for value in image_types if str(value) in ("2", "3")]
      if not image_types:
          image_types = ["3", "2"]
      return {
          "areaName": area_name,
          "imageId": image_id,
          "imageType": image_type,
          "imageName": str(raw.get("imageName") or "comfyui-boogu-edit-int8-20260716").strip(),
          "imageTypes": image_types,
      }
  ```

  在 `handle_aigate_create_instance()` 的 `_aigate_create_lock` 内、`create_aigate_instance()` 前加入：

  ```python
  resolved_image = await resolve_aigate_create_image(
      token, body.get("skuName"), config, session
  )
  create_config = dict(config)
  create_config.update(resolved_image)
  result = await create_aigate_instance(
      token, body.get("skuName"), create_config, session
  )
  ```

  不改变空实例检查、锁作用域、错误响应形状或受管实例登记。

- [ ] **Step 4: 运行 bridge 回归**

  Run: `.venv/bin/python -m unittest bridge.test_aigate_bridge bridge.test_aigate_native -v`

  Expected: PASS；显式数值 ID 和默认命名镜像都可创建，个人/社区未命中错误返回安全 409。

- [ ] **Step 5: 提交 bridge 接线**

  ```bash
  git add bridge/bridge.py bridge/test_aigate_bridge.py
  git commit -m "feat: use aigate image fallback when creating"
  ```

### Task 3: 更新示例配置、开发 mock 和用户文档

**Files:**

- Modify: `bridge/config.example.json:11-16`
- Modify: `dev/dev_server.py:638-669`
- Modify: `dev/test_aigate_native.py:72-107`
- Modify: `README.md:60-74`
- Modify: `plugin/test_aigate_native.js:102-115`

- [ ] **Step 1: 写文档和 mock 的失败断言**

  在 `plugin/test_aigate_native.js` 的 README 测试中增加：

  ```js
  assert.match(readme, /comfyui-boogu-edit-int8-20260716/);
  assert.match(readme, /个人.*优先.*社区|个人镜像.*社区镜像/);
  assert.match(readme, /imageId.*覆盖|显式.*imageId/);
  ```

  在 `dev/test_aigate_native.py` 添加创建响应断言：

  ```python
  self.assertEqual(json.loads(created.body.decode("utf-8"))["instance"]["imageType"], "3")
  ```

- [ ] **Step 2: 运行测试并确认当前内容失败**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，因为 README 尚未说明默认命名镜像和个人优先规则。

  Run: `.venv/bin/python -m unittest dev.test_aigate_native -v`

  Expected: FAIL，因为开发 mock 的创建实例摘要尚未提供 `imageType`。

- [ ] **Step 3: 同步示例、mock 和 README**

  将 `bridge/config.example.json` 中 `aigateCreate` 更新为：

  ```json
  "_aigateCreate_comment": "创建云扉 ComfyUI 实例时填写；默认按镜像名称优先查个人镜像，再查社区镜像；imageId 是可选的显式覆盖。",
  "aigateCreate": {
    "areaName": "",
    "imageName": "comfyui-boogu-edit-int8-20260716",
    "imageTypes": ["3", "2"],
    "imageId": "",
    "imageType": ""
  },
  ```

  在 `dev/dev_server.py` 的创建摘要中加入：

  ```python
  "imageType": "3",
  ```

  更新 README 的 JSON 示例和说明：默认名称先查个人镜像、再查同名社区镜像；`imageId` 与 `imageType` 同时填写时会覆盖自动解析。个人与社区都不可用时创建被拒绝。

- [ ] **Step 4: 运行完整回归和格式检查**

  Run: `node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js`

  Expected: PASS。

  Run: `.venv/bin/python -m unittest bridge.test_aigate_native bridge.test_aigate_bridge dev.test_aigate_native -v`

  Expected: PASS。

  Run: `.venv/bin/python -m py_compile bridge/aigate_native.py bridge/bridge.py dev/dev_server.py`

  Expected: PASS。

  Run: `.venv/bin/python -m json.tool bridge/config.example.json`

  Expected: 输出格式化 JSON 且进程成功退出。

  Run: `rg -n '=>|\bconst\b|\blet\b|\.find\(|Object\.assign\(' plugin --glob '*.js' --glob '!test_*.js'`

  Expected: 无输出。

  Run: `git diff --check`

  Expected: 无输出。

- [ ] **Step 5: 提交文档和 mock 同步**

  ```bash
  git add bridge/config.example.json dev/dev_server.py dev/test_aigate_native.py README.md plugin/test_aigate_native.js
  git commit -m "docs: describe aigate image fallback"
  ```

### Task 4: 添加云扉 Bearer Token 获取链接

**Files:**

- Modify: `plugin/index.html:190-198`
- Modify: `plugin/test_aigate_native.js:94-100`

- [ ] **Step 1: 写 Token 链接的失败静态测试**

  在 `settings include AIGate token and instance controls` 测试中加入：

  ```js
  assert.match(
    html,
    /<a id="linkGetAigateToken" class="link-sm" href="https:\/\/waas\.aigate\.cc\/user\/setting" target="_blank">如何获取 Bearer Token<\/a>/
  );
  ```

- [ ] **Step 2: 运行测试并确认链接尚不存在**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，因为 `linkGetAigateToken` 尚未出现在云扉 Token 设置区。

- [ ] **Step 3: 在云扉 Token 提示中插入外部链接**

  将云扉 Token 输入行后的提示改为：

  ```html
  <div class="setting-hint">仅用于读取、启动和关闭云扉实例；原生 ComfyUI 工作流请求不会携带该凭证。 <a id="linkGetAigateToken" class="link-sm" href="https://waas.aigate.cc/user/setting" target="_blank">如何获取 Bearer Token</a></div>
  ```

  复用现有 `.link-sm` 和 `target="_blank"` 模式；不增加 JavaScript、不会在面板内导航。

- [ ] **Step 4: 运行静态测试和 UXP ES5 检查**

  Run: `node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js`

  Expected: PASS。

  Run: `rg -n '=>|\bconst\b|\blet\b|\.find\(|Object\.assign\(' plugin --glob '*.js' --glob '!test_*.js'`

  Expected: 无输出。

- [ ] **Step 5: 提交链接**

  ```bash
  git add plugin/index.html plugin/test_aigate_native.js
  git commit -m "feat: link aigate bearer token settings"
  ```
