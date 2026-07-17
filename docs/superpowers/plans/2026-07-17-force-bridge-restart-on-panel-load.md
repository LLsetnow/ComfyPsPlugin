# 面板加载时强制替换本地桥 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 ComfyPS 面板加载时安全替换旧的 ComfyPS 本地桥，并启动一个新桥进程。

**Architecture:** 面板初始化直接调用新的 `forceBridgeStartOnPanelLoad()`，不再等待离线健康检查，也不再保存自动启动偏好。它复用已有 `startBridgeViaShell()` 的 UXP 授权和健康轮询。启动脚本通过进程工作目录与命令行识别仓库内 `bridge/bridge.py`，只终止该桥；其他程序占用 8765 时失败退出。

**Tech Stack:** UXP ES5 JavaScript、macOS Bash、Node.js 内置 `node:test`、aiohttp Python bridge。

---

### Task 1: 用失败测试锁定面板启动和脚本安全边界

**Files:**
- Create: `plugin/test_bridge_start.js`

- [x] **Step 1: 写入面板加载启动的失败测试**

  创建测试文件，包含：

  ```javascript
  var assert = require("node:assert/strict");
  var fs = require("node:fs");
  var test = require("node:test");

  test("panel load always requests a fresh local bridge", function () {
    var workflow = fs.readFileSync("plugin/workflow.js", "utf8");
    var init = fs.readFileSync("plugin/init.js", "utf8");
    var main = fs.readFileSync("plugin/main.js", "utf8");
    var settings = fs.readFileSync("plugin/settings.js", "utf8");
    var html = fs.readFileSync("plugin/index.html", "utf8");

    assert.match(workflow, /function forceBridgeStartOnPanelLoad\(\)/);
    assert.match(init, /forceBridgeStartOnPanelLoad\(\);\s*startHealthPolling\(\);/);
    assert.doesNotMatch(workflow, /_maybeAutoStartBridge/);
    assert.doesNotMatch(main, /autoStartBridge/);
    assert.doesNotMatch(settings, /settingAutoStartBridge/);
    assert.doesNotMatch(html, /settingAutoStartBridge/);
  });
  ```

- [x] **Step 2: 写入启动脚本安全替换的失败测试**

  在同一文件添加：

  ```javascript
  test("bridge launcher only terminates the repository bridge process", function () {
    var script = fs.readFileSync("plugin/start_bridge.command", "utf8");

    assert.match(script, /is_comfyps_bridge_pid\(\)/);
    assert.match(script, /lsof -a -p "\$1" -d cwd -Fn/);
    assert.match(script, /bridge\/bridge\.py/);
    assert.match(script, /kill \$BRIDGE_PIDS/);
    assert.match(script, /端口 8765 被其他程序占用/);
    assert.doesNotMatch(script, /kill -9 \$PIDS/);
  });
  ```

- [x] **Step 3: 运行测试确认失败**

  Run: `node --test plugin/test_bridge_start.js`

  Expected: FAIL，因为尚不存在 `forceBridgeStartOnPanelLoad()` 与 `is_comfyps_bridge_pid()`，且旧的自动启动设置仍存在。

### Task 2: 让面板加载无条件请求新桥

**Files:**
- Modify: `plugin/workflow.js:1-50,139-200`
- Modify: `plugin/init.js:180-230`
- Modify: `plugin/main.js:150-180,580-610`
- Modify: `plugin/settings.js:20-50,1230-1280`
- Modify: `plugin/index.html:116-136`
- Modify: `README.md:83-88`

- [x] **Step 1: 删除旧的可选自动启动设置**

  删除 `SETTING_KEYS.autoStartBridge`、`loadSettings().autoStartBridge`、`renderSettings()` 和 `saveAllSettings()` 中的 checkbox 处理，以及 `init.js` 中 `settingAutoStartBridge` 的 change 监听器。删除 `index.html` 的完整 checkbox `.setting-row`。README 改为说明：打开/加载面板会请求安全替换旧桥。

- [x] **Step 2: 用一次性启动函数替换离线自动启动函数**

  在 `plugin/workflow.js` 将 `_bridgeAutoStartTried` 改为 `_bridgePanelLoadStartTried`，删除 `_maybeAutoStartBridge()` 和 `checkBridgeHealth()` catch 块中的调用，加入：

  ```javascript
  function forceBridgeStartOnPanelLoad() {
    if (_bridgePanelLoadStartTried || _launchingBridge || _restarting) return;
    _bridgePanelLoadStartTried = true;
    addLogEntry("info", "面板加载，正在替换本地桥…", "插件");
    startBridgeViaShell();
  }
  ```

- [x] **Step 3: 在初始化阶段启动新桥**

  在 `plugin/init.js` 的桥健康轮询处，将：

  ```javascript
  startHealthPolling();
  ```

  替换为：

  ```javascript
  forceBridgeStartOnPanelLoad();
  startHealthPolling();
  ```

- [x] **Step 4: 运行面板加载测试确认通过**

  Run: `node --test --test-name-pattern="panel load always" plugin/test_bridge_start.js`

  Expected: PASS；旧 `autoStartBridge` 设置与离线自动启动函数均不再存在，初始化直接调用新函数。

### Task 3: 安全替换旧桥进程

**Files:**
- Modify: `plugin/start_bridge.command:27-40`
- Test: `plugin/test_bridge_start.js`

- [x] **Step 1: 以仓库工作目录和命令行识别桥进程**

  用以下函数替换“结束端口所有进程”的逻辑：

  ```bash
  is_comfyps_bridge_pid() {
    PID_CWD="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    PID_COMMAND="$(ps -p "$1" -o command= 2>/dev/null || true)"
    [ "$PID_CWD" = "$REPO" ] && case "$PID_COMMAND" in
      *"bridge/bridge.py"*) return 0 ;;
      *) return 1 ;;
    esac
  }
  ```

- [x] **Step 2: 仅停止旧桥并拒绝其他端口占用者**

  收集 `lsof -ti tcp:8765` 结果；将 `is_comfyps_bridge_pid` 匹配的 PID 加入 `BRIDGE_PIDS`，其他 PID 加入 `OTHER_PIDS`。存在 `OTHER_PIDS` 时输出 `端口 8765 被其他程序占用: ...` 并 `exit 1`。仅在 `BRIDGE_PIDS` 非空时运行：

  ```bash
  kill $BRIDGE_PIDS 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    lsof -ti tcp:8765 >/dev/null 2>&1 || break
    sleep 1
  done
  ```

  若桥仍在监听，运行 `kill -9 $BRIDGE_PIDS 2>/dev/null || true`；端口仍未释放时输出错误并退出。

- [x] **Step 3: 运行启动脚本测试确认通过**

  Run: `node --test --test-name-pattern="bridge launcher only" plugin/test_bridge_start.js`

  Expected: PASS；脚本包含桥进程识别和端口冲突文本，且不再无差别执行 `kill -9 $PIDS`。

### Task 4: 全量验证和提交

**Files:**
- Create: `plugin/test_bridge_start.js`
- Modify: `plugin/workflow.js`
- Modify: `plugin/init.js`
- Modify: `plugin/main.js`
- Modify: `plugin/settings.js`
- Modify: `plugin/index.html`
- Modify: `plugin/start_bridge.command`
- Modify: `README.md`

- [x] **Step 1: 运行所有前端测试**

  Run: `node --test plugin/test_bridge_start.js plugin/test_rh_credentials.js plugin/test_aigate_native.js`

  Expected: 全部 PASS。

- [x] **Step 2: 运行 Python 回归和语法检查**

  Run: `PYTHONPYCACHEPREFIX=/private/tmp/comfyps-pycache python3 -m py_compile bridge/bridge.py bridge/bridge_common.py bridge/aigate_native.py dev/dev_server.py && UV_CACHE_DIR=/private/tmp/comfyps-uv-cache PYTHONPYCACHEPREFIX=/private/tmp/comfyps-pycache uv run --with aiohttp python -m unittest bridge.test_aigate_bridge dev.test_aigate_native -v`

  Expected: 编译成功，所有指定测试 PASS。

- [x] **Step 3: 运行 UXP ES5 与脚本语法检查**

  Run: `node --check plugin/workflow.js && node --check plugin/init.js && node --check plugin/main.js && node --check plugin/settings.js && bash -n plugin/start_bridge.command && ! rg -n '\\b(const|let)\\b|=>|\\.find\\(|Object\\.assign\\(|classList\\.toggle\\([^,]+,[^)]+\\)' plugin/workflow.js plugin/init.js plugin/main.js plugin/settings.js`

  Expected: 所有语法检查成功，ES5 扫描没有输出。

- [x] **Step 4: 审查改动范围并提交**

  Run: `git diff --check && git diff -- plugin/test_bridge_start.js plugin/workflow.js plugin/init.js plugin/main.js plugin/settings.js plugin/index.html plugin/start_bridge.command README.md`

  Expected: 无空白错误；改动仅限面板加载时的桥替换、旧设置删除、安全端口处理和文档。

  Run: `git add plugin/test_bridge_start.js plugin/workflow.js plugin/init.js plugin/main.js plugin/settings.js plugin/index.html plugin/start_bridge.command README.md docs/superpowers/plans/2026-07-17-force-bridge-restart-on-panel-load.md && git commit -m "feat: restart bridge when panel loads"`

  Expected: 仅提交列出的实现、测试和计划文件。
