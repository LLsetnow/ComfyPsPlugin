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

test("bridge launcher only terminates the repository bridge process", function () {
  var script = fs.readFileSync("plugin/start_bridge.command", "utf8");

  assert.match(script, /is_comfyps_bridge_pid\(\)/);
  assert.match(script, /lsof -a -p "\$1" -d cwd -Fn/);
  assert.match(script, /bridge\/bridge\.py/);
  assert.match(script, /kill \$BRIDGE_PIDS/);
  assert.match(script, /端口 8765 被其他程序占用/);
  assert.doesNotMatch(script, /kill -9 \$PIDS/);
});

test("bridge launcher filters listeners and revalidates before each signal", function () {
  var script = fs.readFileSync("plugin/start_bridge.command", "utf8");

  assert.match(script, /listener_pids\(\)/);
  assert.match(script, /lsof -tiTCP:8765 -sTCP:LISTEN/);
  assert.match(script, /current_comfyps_bridge_pids\(\)/);
  assert.match(script, /BRIDGE_PIDS="\$\(current_comfyps_bridge_pids\)"/);
  assert.match(script, /kill \$BRIDGE_PIDS/);
  assert.match(script, /kill -9 \$BRIDGE_PIDS/);
});
