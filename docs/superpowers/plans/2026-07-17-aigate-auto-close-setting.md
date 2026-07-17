# 云扉受管实例自动关闭开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在云扉设置中提供一个默认开启的持久化开关，决定 Photoshop 面板关闭时是否关闭插件受管实例。

**Architecture:** 新设置沿用 `SETTINGS_KEYS` 和 `loadSettings`/`saveAllSettings` 的 localStorage 模式。设置页只负责呈现和保存开关；`requestAigateManagedClose` 读取该值并在关闭时短路，因此现有 Token、受管实例过滤和 bridge 端点不需要改动。

**Tech Stack:** UXP ES5 JavaScript、HTML、Node.js 内置 `node:test`。

---

### Task 1: 先锁定开关的设置与退出语义

**Files:**
- Modify: `plugin/test_aigate_native.js`

- [ ] **Step 1: 添加失败的 DOM、默认值和持久化测试**

  在 `settings include AIGate token and instance controls` 测试后添加：

  ```javascript
  test("settings expose the AIGate auto-close toggle", function () {
    var html = fs.readFileSync("plugin/index.html", "utf8");
    var context = loadAigateContext();

    assert.match(html, /id="settingAigateAutoCloseOnExit"/);
    assert.match(html, /id="aigateAutoCloseStatus"/);
    assert.equal(context.loadSettings().aigateAutoCloseOnExit, true);

    context.saveSetting("aigateAutoCloseOnExit", "false");
    assert.equal(context.loadSettings().aigateAutoCloseOnExit, false);
  });
  ```

- [ ] **Step 2: 添加失败的关闭请求开关测试**

  在现有 `resets the AIGate close guard...` 测试前添加：

  ```javascript
  test("AIGate close request honors the persisted auto-close setting", function () {
    var context = loadAigateContext();
    var calls = [];
    context._getAigateToken = function () { return "token"; };
    context.saveAigateLifecycle({ "i-1": { managed: true, pendingStart: false, startedAt: 1 } });
    context.fetchWithTimeout = function (url, options) {
      calls.push({ url: url, options: options });
      return { catch: function () {} };
    };

    context.saveSetting("aigateAutoCloseOnExit", "false");
    context.requestAigateManagedClose();
    assert.equal(calls.length, 0);
    assert.equal(context._aigateLifecycleCloseRequested, false);

    context.saveSetting("aigateAutoCloseOnExit", "true");
    context.requestAigateManagedClose();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:8765/aigate/close-managed");
    assert.match(calls[0].options.body, /"managedInstanceIds":\["i-1"\]/);
  });
  ```

- [ ] **Step 3: 运行测试确认失败**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，指出 `settingAigateAutoCloseOnExit` 缺失，且 `loadSettings().aigateAutoCloseOnExit` 不是 `true`。

### Task 2: 加入设置 UI、默认值与保存

**Files:**
- Modify: `plugin/index.html:198-218`
- Modify: `plugin/main.js:156-170,580-605`
- Modify: `plugin/settings.js:22-50,1232-1265`
- Modify: `plugin/init.js:180-220`

- [ ] **Step 1: 在云扉 Token 下添加开关 DOM**

  在 `plugin/index.html` 的 `settingAigateToken` 所在 `.setting-row` 后添加：

  ```html
  <div class="setting-row">
    <label class="setting-checkbox">
      <input id="settingAigateAutoCloseOnExit" type="checkbox" checked />
      <span id="aigateAutoCloseStatus">已开启：关闭 Photoshop 时会向本地桥发送关闭请求。</span>
    </label>
  </div>
  ```

- [ ] **Step 2: 添加默认开启的 localStorage 设置**

  在 `SETTINGS_KEYS` 的 `aigateToken` 后加入：

  ```javascript
  aigateAutoCloseOnExit: "comfyps.aigateAutoCloseOnExit",
  ```

  在 `loadSettings()` 的 `aigateToken` 后加入：

  ```javascript
  aigateAutoCloseOnExit: localStorage.getItem(SETTINGS_KEYS.aigateAutoCloseOnExit) !== "false",
  ```

- [ ] **Step 3: 同步开关的显示与保存**

  在 `plugin/settings.js` 增加函数：

  ```javascript
  function updateAigateAutoCloseStatus(enabled) {
    var status = $("aigateAutoCloseStatus");
    if (status) {
      status.textContent = enabled
        ? "已开启：关闭 Photoshop 时会向本地桥发送关闭请求。"
        : "已关闭：退出 Photoshop 时不关闭任何受管实例。";
    }
  }
  ```

  `renderSettings()` 从 `s` 读取 `aigateAutoCloseOnExit`，设置 `settingAigateAutoCloseOnExit.checked`，并调用 `updateAigateAutoCloseStatus`。`saveAllSettings()` 读取 checkbox，调用相同函数，并保存：

  ```javascript
  saveSetting("aigateAutoCloseOnExit", aigateAutoCloseOnExit ? "true" : "false");
  ```

  在 `plugin/init.js` 中为 `settingAigateAutoCloseOnExit` 注册 `change` 监听器，调用 `saveAllSettings`。

- [ ] **Step 4: 运行新增测试确认通过**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: Task 1 中的 DOM、默认开启与保存恢复测试 PASS；退出请求测试仍因尚未加入退出保护而 FAIL。

### Task 3: 让面板关闭逻辑遵守开关

**Files:**
- Modify: `plugin/settings.js:698-717`
- Test: `plugin/test_aigate_native.js`

- [ ] **Step 1: 在关闭函数最前加入设置保护**

  将 `requestAigateManagedClose()` 的开头改为：

  ```javascript
  function requestAigateManagedClose() {
    if (!loadSettings().aigateAutoCloseOnExit) return;
    if (_aigateLifecycleCloseRequested) return;
    var token = _getAigateToken();
  ```

  其余现有的 Token、受管 ID、`sendBeacon` 和 `fetchWithTimeout` 路径保持不变。

- [ ] **Step 2: 运行关闭请求测试确认通过**

  Run: `node --test --test-name-pattern="AIGate close request honors" plugin/test_aigate_native.js`

  Expected: PASS；关闭时零请求且保护位未设置，开启时请求 `/aigate/close-managed`。

- [ ] **Step 3: 运行完整前端测试**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: 全部 PASS。

### Task 4: 完整验证与提交

**Files:**
- Modify: `plugin/index.html`
- Modify: `plugin/main.js`
- Modify: `plugin/settings.js`
- Modify: `plugin/init.js`
- Modify: `plugin/test_aigate_native.js`

- [ ] **Step 1: 运行 Python 云扉回归与语法检查**

  Run: `python -m py_compile bridge/bridge.py bridge/bridge_common.py bridge/aigate_native.py dev/dev_server.py && python -m unittest bridge.test_aigate_bridge dev.test_aigate_native -v`

  Expected: 编译成功，所有指定测试 PASS。

- [ ] **Step 2: 运行 UXP ES5 兼容性检查**

  Run: `node --check plugin/main.js && node --check plugin/settings.js && node --check plugin/init.js && ! rg -n '\\b(const|let)\\b|=>|\\.find\\(|Object\\.assign\\(|classList\\.toggle\\([^,]+,[^)]+\\)' plugin/main.js plugin/settings.js plugin/init.js`

  Expected: 每个文件语法检查成功，`rg` 没有输出。

- [ ] **Step 3: 检查预期改动范围并提交**

  Run: `git diff --check && git diff -- plugin/index.html plugin/main.js plugin/settings.js plugin/init.js plugin/test_aigate_native.js`

  Expected: 无空白错误，改动仅包含本开关、状态文本、保存和关闭保护。

  Run: `git add plugin/index.html plugin/main.js plugin/settings.js plugin/init.js plugin/test_aigate_native.js docs/superpowers/plans/2026-07-17-aigate-auto-close-setting.md && git commit -m "feat: add aigate auto-close setting"`

  Expected: 仅提交列出的文件；不纳入工作区中已有的其他改动。
