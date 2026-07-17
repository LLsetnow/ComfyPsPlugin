# 云扉金额展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在云扉设置页把以“分”返回的余额和 GPU 价格准确显示为人民币元。

**Architecture:** bridge 保持返回云扉 API 的原始 `balance` 和 `price`；`plugin/settings.js` 增加一个纯格式化函数，余额卡和 GPU 规格行都经由它展示。创建请求仍只使用 `skuName`，不传递或依赖展示金额。

**Tech Stack:** Photoshop UXP ES5 JavaScript、Node 内置测试运行器、Markdown 文档。

---

### Task 1: 在面板展示层格式化云扉分金额

**Files:**

- Modify: `plugin/settings.js:76-80,155-168`
- Modify: `plugin/test_aigate_native.js:159-167`

- [ ] **Step 1: 写金额格式化的失败测试**

  用下列测试替换现有“原始 GPU 价格”测试，并新增余额格式化断言：

  ```js
  test("formats AIGate cent amounts as yuan for balance and GPU prices", function () {
    var context = loadAigateContext();

    assert.equal(context.formatAigateCents("205", "余额暂不可用"), "¥ 2.05");
    assert.equal(context.formatAigateCents(0, "余额暂不可用"), "¥ 0.00");
    assert.equal(context.formatAigateCents("5", "余额暂不可用"), "¥ 0.05");
    assert.equal(context.formatAigateCents("-1", "余额暂不可用"), "余额暂不可用");
    assert.equal(context.formatAigateCents("2.05", "余额暂不可用"), "余额暂不可用");
    assert.equal(context.aigateSkuPriceText({ price: "199" }), "¥ 1.99");
    assert.equal(context.aigateSkuPriceText({ price: "" }), "价格暂不可用");
  });
  ```

- [ ] **Step 2: 运行测试并确认当前实现失败**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，因为 `formatAigateCents` 尚不存在，且现有 `aigateSkuPriceText({ price: "199" })` 返回 `"199"`。

- [ ] **Step 3: 实现不依赖浮点数的 ES5 格式化函数**

  在 `shouldShowAigateCreate()` 后、`aigateSkuPriceText()` 前加入：

  ```js
  function formatAigateCents(value, unavailableText) {
    var text = value === undefined || value === null ? "" : String(value).trim();
    if (!/^\d+$/.test(text)) return unavailableText;
    text = text.replace(/^0+(?=\d)/, "");
    while (text.length < 3) text = "0" + text;
    return "¥ " + text.slice(0, -2) + "." + text.slice(-2);
  }

  function aigateSkuPriceText(sku) {
    return formatAigateCents(sku && sku.price, "价格暂不可用");
  }
  ```

  在 `_renderAigateAccount()` 中把余额文字从：

  ```js
  _appendAigateText(balance, "aigate-account-balance-value", String(_aigateAccount.balance));
  ```

  替换为：

  ```js
  _appendAigateText(
    balance,
    "aigate-account-balance-value",
    formatAigateCents(_aigateAccount.balance, "余额暂不可用")
  );
  ```

  不修改 bridge 的原始响应、SKU 选择或创建请求载荷。

- [ ] **Step 4: 运行前端测试和 UXP ES5 检查**

  Run: `node --test plugin/test_aigate_native.js plugin/test_rh_credentials.js`

  Expected: PASS；余额 `205` 和 GPU 价格 `199` 分别格式化为 `¥ 2.05` 与 `¥ 1.99`。

  Run: `rg -n '=>|\bconst\b|\blet\b|\.find\(|Object\.assign\(' plugin --glob '*.js' --glob '!test_*.js'`

  Expected: 无输出。

- [ ] **Step 5: 提交面板金额格式化**

  ```bash
  git add plugin/settings.js plugin/test_aigate_native.js
  git commit -m "fix: format aigate money in yuan"
  ```

### Task 2: 让配置文档与显示单位保持一致

**Files:**

- Modify: `README.md:74`
- Modify: `plugin/test_aigate_native.js:102-115`

- [ ] **Step 1: 为 README 的显示单位写失败断言**

  将现有 README 测试末尾三项替换为：

  ```js
  assert.match(readme, /余额.*分.*人民币元|余额.*分.*元/);
  assert.match(readme, /GPU.*价格.*分.*人民币元|GPU.*价格.*分.*元/);
  assert.match(readme, /bridge.*原始.*数值|原始.*数值.*bridge/);
  ```

- [ ] **Step 2: 运行测试并确认旧文档失败**

  Run: `node --test plugin/test_aigate_native.js`

  Expected: FAIL，因为 README 当前声明面板直接展示原始值且不推断单位。

- [ ] **Step 3: 更新 README 的云扉说明**

  将第 74 行的末句替换为：

  ```markdown
  连接器中的余额与 GPU 规格价格由云扉以“分”返回；面板会把它们显示为人民币元（例如 `205` 显示为 `¥ 2.05`、`199` 显示为 `¥ 1.99`）。bridge 响应仍保留原始数值，界面不会推断额外的计费周期。
  ```

- [ ] **Step 4: 运行完整回归与差异检查**

  Run: `node --test plugin/test_rh_credentials.js plugin/test_aigate_native.js`

  Expected: PASS。

  Run: `.venv/bin/python -m unittest bridge.test_aigate_native bridge.test_aigate_bridge dev.test_aigate_native -v`

  Expected: PASS；bridge 继续返回原始数值，未受展示层改动影响。

  Run: `git diff --check`

  Expected: 无输出。

- [ ] **Step 5: 提交文档一致性更新**

  ```bash
  git add README.md plugin/test_aigate_native.js
  git commit -m "docs: clarify aigate yuan display"
  ```
