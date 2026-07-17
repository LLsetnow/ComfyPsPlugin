var assert = require("node:assert/strict");
var fs = require("node:fs");
var test = require("node:test");
var vm = require("node:vm");

function loadAigateContext() {
  var source = fs.readFileSync("plugin/main.js", "utf8");
  var initAt = source.indexOf("(function init() {");
  assert.ok(initAt > 0, "main.js must keep its init IIFE boundary");
  var values = {};
  var mockPs = {
    app: {},
    core: { executeAsModal: function () {} },
    action: { batchPlay: function () {} },
    imaging: {},
  };
  var context = {
    window: {
      __COMFYPS_DEV__: true,
      __mock_photoshop: mockPs,
      __mock_uxp: { storage: { localFileSystem: {}, formats: {} }, shell: {} },
    },
    document: {
      getElementById: function () { return null; },
      querySelectorAll: function () { return []; },
    },
    localStorage: {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function (key, value) { values[key] = String(value); },
      removeItem: function (key) { delete values[key]; },
    },
    Math: Math,
    Date: { now: function () { return 0; } },
    JSON: JSON,
    console: { log: function () {}, error: function () {}, warn: function () {} },
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, initAt), context);
  return context;
}

test("AIGate backend forces Boogu inpaint config", function () {
  var context = loadAigateContext();
  var config = context.getWorkflowRunConfig(
    context.findWorkflow("inpaint"),
    { wfInpaintVariant: "qwen" },
    "aigate"
  );
  assert.equal(config.inpaintVariant, "boogu");
  assert.equal(config.workflowFile, "../workflows/inpaint_boogu_api.json");
});

test("AIGate backend blocks unsupported native workflows", function () {
  var context = loadAigateContext();
  assert.equal(
    context.isWorkflowAvailableForBackend(context.findWorkflow("cleanup"), "aigate"),
    false
  );
  assert.equal(
    context.isWorkflowAvailableForBackend(context.findWorkflow("face"), "aigate"),
    false
  );
  assert.equal(
    context.isWorkflowAvailableForBackend(context.findWorkflow("gpt-image"), "aigate"),
    true
  );
});

test("settings include AIGate token and instance controls", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  assert.match(html, /data-value="aigate"/);
  assert.match(html, /id="settingAigateToken"/);
  assert.match(html, /id="btnRefreshAigateInstances"/);
  assert.match(html, /id="aigateInstanceList"/);
});

test("records runtime only after first observed running state", function () {
  var context = loadAigateContext();
  context.Date.now = function () { return 1000; };
  context.saveAigateLifecycle({
    "i-1": { managed: true, pendingStart: true, startedAt: 0 },
  });

  context.reconcileAigateLifecycle([{ instanceId: "i-1", operationStatus: "2" }]);
  context.Date.now = function () { return 3000; };
  context.reconcileAigateLifecycle([{ instanceId: "i-1", operationStatus: "2" }]);

  assert.deepEqual(context.loadAigateLifecycle()["i-1"], {
    managed: true,
    pendingStart: false,
    startedAt: 1000,
  });
  assert.equal(context.formatAigateRuntime("i-1", 62000), "运行 00:01:01");
});

test("does not invent runtime for an unmanaged running instance", function () {
  var context = loadAigateContext();
  context.reconcileAigateLifecycle([{ instanceId: "external", operationStatus: "2" }]);
  assert.equal(context.formatAigateRuntime("external", 2000), "开始时间未知");
});

test("removes a released instance from local lifecycle", function () {
  var context = loadAigateContext();
  context.saveAigateLifecycle({
    "i-1": { managed: true, pendingStart: false, startedAt: 1000 },
  });
  context.removeAigateLifecycle("i-1");
  assert.equal(context.loadAigateLifecycle()["i-1"], undefined);
});

test("settings expose AIGate lifecycle controls and normal-exit cleanup", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  var source = fs.readFileSync("plugin/main.js", "utf8");
  assert.match(html, /运行/);
  assert.match(source, /启动/);
  assert.match(source, /关闭/);
  assert.match(source, /释放/);
  assert.match(source, /uxpcommand/);
  assert.match(source, /\/aigate\/close-managed/);
});

test("resets the AIGate close guard when a UXP panel is shown again", function () {
  var context = loadAigateContext();
  context._aigateLifecycleCloseRequested = true;
  context.resetAigateManagedCloseForPanelShow();
  assert.equal(context._aigateLifecycleCloseRequested, false);
  assert.match(fs.readFileSync("plugin/main.js", "utf8"), /uxpshowpanel/);
});
