var assert = require("node:assert/strict");
var fs = require("node:fs");
var test = require("node:test");
var vm = require("node:vm");

// main.js 已按依赖顺序拆成多个全局脚本（见 index.html / CLAUDE.md）。
// 这里按同样顺序拼回完整源码，等价于原单一 main.js，再按标记切片。
var MODULE_FILES = [
  "plugin/main.js",
  "plugin/png.js",
  "plugin/imaging.js",
  "plugin/run.js",
  "plugin/queue.js",
  "plugin/workflow.js",
  "plugin/settings.js",
  "plugin/init.js",
];

function readModuleSource() {
  var out = "";
  for (var i = 0; i < MODULE_FILES.length; i++) {
    out += fs.readFileSync(MODULE_FILES[i], "utf8");
  }
  return out;
}

function loadAigateContext() {
  var source = readModuleSource();
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

test("settings expose AIGate account and conditional-create anchors", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  var css = fs.readFileSync("plugin/styles.css", "utf8");
  var accountCard = html.match(
    /<div id="aigateAccountStatus" class="aigate-account-card">([\s\S]*?)<\/div>\s*<\/div>/
  );

  assert.ok(accountCard, "AIGate account status must use the account card");
  assert.match(accountCard[1], /id="btnRefreshAigateAccount"/);
  assert.match(html, /id="aigateInstanceList"/);
  assert.match(css, /\.aigate-account-card/);
  assert.match(css, /\.aigate-account-balance/);
  assert.match(css, /\.aigate-account-meta/);
  assert.match(css, /\.aigate-account-refresh/);
  assert.match(css, /\.aigate-create-card/);
  assert.match(css, /\.aigate-sku-row/);
  assert.match(css, /\.aigate-sku-row\.selected/);
  assert.match(css, /\.aigate-sku-meta/);
  assert.match(css, /\.aigate-sku-price/);
  assert.match(css, /\.aigate-create-actions/);
  assert.match(css, /\.aigate-create-notice/);
  assert.match(css, /\.aigate-create-progress/);
});

test("settings initialization binds the AIGate balance refresh and shortens the instance label", function () {
  var initSource = fs.readFileSync("plugin/init.js", "utf8");

  assert.match(initSource, /btnRefreshAigateAccount/);
  assert.match(initSource, /refreshAigateAccount/);
  assert.match(initSource, /btnRefreshAigateInstances\.textContent = "刷新"/);
});

test("shows the AIGate create card only for a confirmed empty array", function () {
  var context = loadAigateContext();

  assert.equal(context.shouldShowAigateCreate([]), true);
  assert.equal(context.shouldShowAigateCreate([{ instanceId: "i-1" }]), false);
  assert.equal(context.shouldShowAigateCreate(null), false);
  assert.equal(context.shouldShowAigateCreate(undefined), false);
  assert.equal(context.shouldShowAigateCreate({ length: 0 }), false);
});

test("uses the raw AIGate SKU price without inferring a unit", function () {
  var context = loadAigateContext();

  assert.equal(context.aigateSkuPriceText({ price: "199" }), "199");
  assert.equal(context.aigateSkuPriceText({ price: 0 }), "0");
  assert.equal(context.aigateSkuPriceText({ price: "" }), "价格暂不可用");
  assert.equal(context.aigateSkuPriceText({}), "价格暂不可用");
  assert.equal(context.aigateSkuPriceText(null), "价格暂不可用");
});

test("unavailable AIGate GPU options keep an in-card retry action", function () {
  var source = fs.readFileSync("plugin/settings.js", "utf8");

  assert.match(source, /if \(!_aigateSkuOptions\.length\) \{[\s\S]{0,700}重试读取/);
});

test("refreshing a confirmed empty AIGate console loads account and create options", async function () {
  var context = loadAigateContext();
  var renders = [];
  var followUps = [];
  context._aigateInstances = [{ instanceId: "old" }];
  context._getAigateToken = function () { return "token"; };
  context.$ = function () { return { textContent: "" }; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () {
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve({ ok: true, instances: [] }); },
    });
  };
  context.reconcileAigateLifecycle = function () {};
  context._renderAigateInstances = function (instances) { renders.push(instances); };
  context._syncAigateLifecycleTimers = function () {};
  context.refreshAigateAccount = function () { followUps.push("account"); };
  context.refreshAigateCreateOptions = function () { followUps.push("options"); };

  await context.refreshAigateInstances();

  assert.deepEqual(renders, [[]]);
  assert.deepEqual(followUps, ["account", "options"]);
});

test("a malformed AIGate list response never reveals create options", async function () {
  var context = loadAigateContext();
  var container = { textContent: "" };
  var initialInstances = [{ instanceId: "old" }];
  var optionsRequests = 0;
  context._aigateInstances = initialInstances;
  context._getAigateToken = function () { return "token"; };
  context.$ = function () { return container; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () {
    return Promise.resolve({
      ok: true,
      json: function () { return Promise.resolve({ ok: true, instances: null }); },
    });
  };
  context._renderAigateInstances = function () {
    throw new Error("malformed data must not be rendered");
  };
  context.refreshAigateCreateOptions = function () { optionsRequests += 1; };

  await context.refreshAigateInstances();

  assert.strictEqual(context._aigateInstances, initialInstances);
  assert.equal(optionsRequests, 0);
  assert.match(container.textContent, /读取云扉实例失败/);
});

test("creating an AIGate instance adopts the response and starts managed lifecycle", async function () {
  var context = loadAigateContext();
  var rendered = [];
  context._aigateInstances = [];
  context._aigateSkuOptions = [{ skuName: "4090-24GB-DDR5", vmSize: "24", price: "199" }];
  context._aigateSelectedSkuName = "4090-24GB-DDR5";
  context._aigateCreateState = "confirm";
  context._getAigateToken = function () { return "token"; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () {
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve({
          ok: true,
          instance: {
            instanceId: "new-1",
            instanceName: "ComfyUI",
            operationStatus: "1",
            hasComfyui: true,
          },
        });
      },
    });
  };
  context._renderAigateInstances = function (instances) { rendered.push(instances); };
  context._syncAigateLifecycleTimers = function () {};

  await context.submitAigateCreate();

  assert.equal(JSON.stringify(context._aigateInstances), JSON.stringify([{
    instanceId: "new-1",
    instanceName: "ComfyUI",
    operationStatus: "1",
    hasComfyui: true,
  }]));
  assert.deepEqual(context.loadAigateLifecycle()["new-1"], {
    managed: true,
    pendingStart: true,
    startedAt: 0,
  });
  assert.equal(context._aigateCreateState, "idle");
  assert.equal(rendered.length, 2);
  assert.equal(JSON.stringify(rendered[0]), "[]");
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
  var source = readModuleSource();
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
  assert.match(readModuleSource(), /uxpshowpanel/);
});
