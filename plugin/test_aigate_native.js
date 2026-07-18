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

test("AIGate inpaint does not hide the resolution input", function () {
  var source = fs.readFileSync("plugin/workflow.js", "utf8");
  assert.doesNotMatch(source, /inp\.id === "wfResolution"\) return/);
});

test("image enhance selects each workflow variant", function () {
  var context = loadAigateContext();
  var workflow = context.findWorkflow("image-enhance");
  var clarity = context.getWorkflowRunConfig(workflow, {
    wfImageEnhanceMode: "clarity", wfImageEnhanceScale: "2.5"
  }, "runninghub");
  var upscale = context.getWorkflowRunConfig(workflow, {
    wfImageEnhanceMode: "upscale", wfImageEnhanceScale: "6"
  }, "aigate");

  assert.equal(clarity.workflowId, "2078092574119964674");
  assert.equal(clarity.workflowFile, "../workflows/image_clarity_api.json");
  assert.equal(clarity.imageNodeId, "90");
  assert.equal(clarity.outputNodeId, "100");
  assert.equal(upscale.workflowId, "2078099177921589250");
  assert.equal(upscale.workflowFile, "../workflows/image_upscale_api.json");
  assert.equal(context.getImageEnhanceScale("2.5"), 2.5);
  assert.equal(context.getImageEnhanceScale("8.1"), 2);
});

test("image enhance crops the active layer only when a selection exists", async function () {
  var context = loadAigateContext();
  var selectionBounds = { left: 12, top: 24, right: 212, bottom: 124, width: 200, height: 100 };

  context._readSelectionBoundsIfAny = async function () { return selectionBounds; };
  context.exportActiveLayerSelectionPNG = async function (bounds) {
    assert.equal(bounds, selectionBounds);
    return { image: "cropped-layer", bounds: bounds };
  };
  context.exportActiveLayerPNG = async function () {
    throw new Error("should not export the full layer while a selection exists");
  };

  var cropped = await context.exportImageEnhanceInput();
  assert.equal(cropped.image, "cropped-layer");
  assert.equal(cropped.placement.left, 12);
  assert.equal(cropped.placement.top, 24);
  assert.equal(cropped.placement.width, 200);
  assert.equal(cropped.placement.height, 100);
  assert.equal(cropped.placement.alignToTopLeft, true);

  context._readSelectionBoundsIfAny = async function () { return null; };
  context.exportActiveLayerPNG = async function () { return "full-active-layer"; };
  var full = await context.exportImageEnhanceInput();
  assert.equal(full.image, "full-active-layer");
  assert.equal(full.placement, null);
});

test("selection probe treats an absent selection as a normal result", function () {
  var context = loadAigateContext();
  assert.equal(context._selectionBoundsOrNull({ selection: {} }), null);
  var bounds = context._selectionBoundsOrNull({
    selection: {
      left: { _value: 1 }, top: { _value: 2 }, right: { _value: 11 }, bottom: { _value: 22 }
    }
  });
  assert.equal(bounds.width, 10);
  assert.equal(bounds.height, 20);
});

test("AIGate enables declared native workflows", function () {
  var context = loadAigateContext();
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("inpaint"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("cleanup"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("face"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("image-enhance"), "aigate"), true);
  assert.equal(context.isWorkflowAvailableForBackend(context.findWorkflow("gpt-image"), "aigate"), true);
});

test("settings include AIGate token and instance controls", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  assert.match(html, /data-value="aigate"/);
  assert.match(html, /id="settingAigateToken"/);
  assert.match(
    html,
    /<a id="linkGetAigateToken" class="link-sm" href="https:\/\/waas\.aigate\.cc\/user\/setting" target="_blank">如何获取 Bearer Token<\/a>/
  );
  assert.match(html, /id="btnRefreshAigateInstances"/);
  assert.match(html, /id="aigateInstanceList"/);
});

test("settings expose the AIGate auto-close toggle", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  var context = loadAigateContext();

  assert.match(html, /id="settingAigateAutoCloseOnExit"/);
  assert.match(html, /id="aigateAutoCloseStatus"/);
  assert.equal(context.loadSettings().aigateAutoCloseOnExit, true);

  context.saveSetting("aigateAutoCloseOnExit", "false");
  assert.equal(context.loadSettings().aigateAutoCloseOnExit, false);
});

test("AIGate auto-close toggle status reflects its enabled state", function () {
  var context = loadAigateContext();
  var status = { textContent: "" };
  context.$ = function (id) { return id === "aigateAutoCloseStatus" ? status : null; };

  assert.equal(typeof context.updateAigateAutoCloseStatus, "function");
  context.updateAigateAutoCloseStatus(true);
  assert.equal(status.textContent, "已开启：关闭 Photoshop 时会向本地桥发送关闭请求。");
  context.updateAigateAutoCloseStatus(false);
  assert.equal(status.textContent, "已关闭：退出 Photoshop 时不关闭任何受管实例。");
});

test("README documents private AIGate create configuration and yuan UI values", function () {
  var readme = fs.readFileSync("README.md", "utf8");

  assert.match(readme, /aigateCreate/);
  assert.match(readme, /areaName/);
  assert.match(readme, /imageName/);
  assert.match(readme, /imageTypes/);
  assert.match(readme, /个人镜像/);
  assert.match(readme, /社区镜像/);
  assert.match(readme, /imageId.*imageType|imageType.*imageId/);
  assert.match(readme, /bridge\/config\.example\.json/);
  assert.match(readme, /成功刷新.*没有.*实例|没有.*实例.*成功刷新/);
  assert.match(readme, /停止.*隐藏|已有实例.*隐藏/);
  assert.match(readme, /余额.*分.*人民币元|余额.*分.*元/);
  assert.match(readme, /GPU.*价格.*分.*人民币元|GPU.*价格.*分.*元/);
  assert.match(readme, /bridge.*原始.*数值|原始.*数值.*bridge/);
});

test("AIGate example config defaults to personal then community image lookup", function () {
  var config = JSON.parse(fs.readFileSync("bridge/config.example.json", "utf8"));

  assert.equal(config.aigateCreate.imageName, "comfyui-boogu-edit-int8-20260716");
  assert.deepEqual(config.aigateCreate.imageTypes, ["3", "2"]);
  assert.equal(config.aigateCreate.imageId, "");
  assert.equal(config.aigateCreate.imageType, "");
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

test("a stale successful AIGate account response cannot show Token A balance for Token B", async function () {
  var context = loadAigateContext();
  var currentToken = "token-a";
  var resolveAccount;
  var accountRequest = new Promise(function (resolve) { resolveAccount = resolve; });
  var rendersAfterTokenChange = [];
  var tokenChanged = false;
  context._getAigateToken = function () { return currentToken; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () { return accountRequest; };
  context._renderAigateAccount = function () {
    if (tokenChanged) {
      rendersAfterTokenChange.push({
        balance: context._aigateAccount && context._aigateAccount.balance,
        error: context._aigateAccountError,
        inFlight: context._aigateAccountRefreshInFlight,
      });
    }
  };

  var request = context.refreshAigateAccount();
  currentToken = "token-b";
  tokenChanged = true;
  resolveAccount({
    ok: true,
    json: function () { return Promise.resolve({ ok: true, balance: "999", updatedAt: 1000 }); },
  });
  await request;

  assert.equal(context._aigateAccount, null);
  assert.equal(context._aigateAccountUpdatedAt, 0);
  assert.equal(context._aigateAccountError, "云扉凭证已变更，请刷新余额");
  assert.equal(context._aigateAccountRefreshInFlight, false);
  assert.deepEqual(rendersAfterTokenChange, [{
    balance: null,
    error: "云扉凭证已变更，请刷新余额",
    inFlight: false,
  }]);
});

test("a stale failed AIGate account response cannot show Token A error for Token B", async function () {
  var context = loadAigateContext();
  var currentToken = "token-a";
  var rejectAccount;
  var accountRequest = new Promise(function (resolve, reject) { rejectAccount = reject; });
  var rendersAfterTokenChange = [];
  var tokenChanged = false;
  context._getAigateToken = function () { return currentToken; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () { return accountRequest; };
  context._renderAigateAccount = function () {
    if (tokenChanged) {
      rendersAfterTokenChange.push({
        balance: context._aigateAccount && context._aigateAccount.balance,
        error: context._aigateAccountError,
        inFlight: context._aigateAccountRefreshInFlight,
      });
    }
  };

  var request = context.refreshAigateAccount();
  currentToken = "token-b";
  tokenChanged = true;
  rejectAccount(new Error("Token A 网络错误"));
  await request;

  assert.equal(context._aigateAccount, null);
  assert.equal(context._aigateAccountUpdatedAt, 0);
  assert.equal(context._aigateAccountError, "云扉凭证已变更，请刷新余额");
  assert.equal(context._aigateAccountRefreshInFlight, false);
  assert.deepEqual(rendersAfterTokenChange, [{
    balance: null,
    error: "云扉凭证已变更，请刷新余额",
    inFlight: false,
  }]);
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

test("a pending AIGate options response cannot restore create after a list failure", async function () {
  var context = loadAigateContext();
  var container = { textContent: "" };
  var renders = [];
  var resolveOptions;
  var optionsPromise = new Promise(function (resolve) { resolveOptions = resolve; });
  var instanceReads = 0;
  context._getAigateToken = function () { return "token"; };
  context.$ = function () { return container; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context._renderAigateInstances = function (instances) { renders.push(instances); };
  context._syncAigateLifecycleTimers = function () {};
  context.refreshAigateAccount = function () {};
  context.fetchWithTimeout = function (url) {
    if (url.indexOf("/aigate/instances") !== -1) {
      instanceReads += 1;
      if (instanceReads === 1) {
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: true, instances: [] }); },
        });
      }
      return Promise.resolve({ ok: false, status: 503 });
    }
    if (url.indexOf("/aigate/create-options") !== -1) return optionsPromise;
    throw new Error("unexpected request " + url);
  };

  await context.refreshAigateInstances();
  await context.refreshAigateInstances();
  var rendersAfterFailure = renders.length;
  resolveOptions({
    ok: true,
    json: function () {
      return Promise.resolve({
        ok: true,
        options: [{ skuName: "4090", vmSize: "24", price: "199" }],
      });
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(context._aigateInstancesConfirmed, false);
  assert.equal(renders.length, rendersAfterFailure);
  assert.match(container.textContent, /读取云扉实例失败/);
});

test("a newer confirmed empty AIGate list retries after a stale options request settles", async function () {
  var context = loadAigateContext();
  var container = { textContent: "" };
  var resolveOldOptions;
  var oldOptions = new Promise(function (resolve) { resolveOldOptions = resolve; });
  var instanceReads = 0;
  var optionReads = 0;
  context._getAigateToken = function () { return "token"; };
  context.$ = function () { return container; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context._renderAigateInstances = function () {};
  context._syncAigateLifecycleTimers = function () {};
  context.refreshAigateAccount = function () {};
  context.fetchWithTimeout = function (url) {
    if (url.indexOf("/aigate/instances") !== -1) {
      instanceReads += 1;
      if (instanceReads === 2) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true, instances: [] }); },
      });
    }
    if (url.indexOf("/aigate/create-options") !== -1) {
      optionReads += 1;
      if (optionReads === 1) return oldOptions;
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({
            ok: true,
            options: [{ skuName: "5090", vmSize: "32", price: "299" }],
          });
        },
      });
    }
    throw new Error("unexpected request " + url);
  };

  await context.refreshAigateInstances();
  await context.refreshAigateInstances();
  await context.refreshAigateInstances();
  resolveOldOptions({
    ok: true,
    json: function () {
      return Promise.resolve({
        ok: true,
        options: [{ skuName: "4090", vmSize: "24", price: "199" }],
      });
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  assert.equal(optionReads, 2);
  assert.equal(context._aigateSkuOptions[0].skuName, "5090");
});

test("a list response for an old AIGate token cannot unlock creation for a new token", async function () {
  var context = loadAigateContext();
  var container = { textContent: "" };
  var currentToken = "token-a";
  var resolveList;
  var listPromise = new Promise(function (resolve) { resolveList = resolve; });
  var followUps = [];
  context._getAigateToken = function () { return currentToken; };
  context.$ = function () { return container; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () { return listPromise; };
  context._renderAigateInstances = function () {
    throw new Error("old-token list must not render");
  };
  context._syncAigateLifecycleTimers = function () {};
  context.refreshAigateAccount = function () { followUps.push("account"); };
  context.refreshAigateCreateOptions = function () { followUps.push("options"); };

  var request = context.refreshAigateInstances();
  currentToken = "token-b";
  resolveList({
    ok: true,
    json: function () { return Promise.resolve({ ok: true, instances: [] }); },
  });
  await request;

  assert.equal(context._aigateInstancesConfirmed, false);
  assert.deepEqual(followUps, []);
  assert.match(container.textContent, /凭证已变更/);
});

test("a failed AIGate create shows the bridge error message for retry", async function () {
  var context = loadAigateContext();
  var rendered = [];
  context._aigateInstances = [];
  context._aigateInstancesConfirmed = true;
  context._aigateConfirmedToken = "token";
  context._aigateSkuOptions = [{ skuName: "4090-24GB-DDR5", vmSize: "24", price: "199" }];
  context._aigateSelectedSkuName = "4090-24GB-DDR5";
  context._aigateCreateState = "confirm";
  context._getAigateToken = function () { return "token"; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () {
    return Promise.resolve({
      ok: false,
      status: 409,
      json: function () {
        return Promise.resolve({
          ok: false,
          error: "AIGATE_INSTANCE_EXISTS",
          message: "云扉控制台已有实例，不能重复创建",
        });
      },
    });
  };
  context._renderAigateInstances = function (instances) { rendered.push(instances); };

  await context.submitAigateCreate();

  assert.equal(context._aigateCreateState, "confirm");
  assert.equal(context._aigateSelectedSkuName, "4090-24GB-DDR5");
  assert.match(context._aigateCreateError, /已有实例，不能重复创建/);
  assert.equal(rendered.length, 2);
});

test("a completed create for an old AIGate token cannot populate a newer token console", async function () {
  var context = loadAigateContext();
  var currentToken = "token-a";
  var resolveCreate;
  var createPromise = new Promise(function (resolve) { resolveCreate = resolve; });
  context._aigateInstances = [];
  context._aigateInstancesConfirmed = true;
  context._aigateConfirmedToken = "token-a";
  context._aigateSkuOptions = [{ skuName: "4090-24GB-DDR5", vmSize: "24", price: "199" }];
  context._aigateSelectedSkuName = "4090-24GB-DDR5";
  context._aigateCreateState = "confirm";
  context._getAigateToken = function () { return currentToken; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.fetchWithTimeout = function () { return createPromise; };
  context._renderAigateInstances = function () {};
  context._syncAigateLifecycleTimers = function () {};

  var request = context.submitAigateCreate();
  currentToken = "token-b";
  resolveCreate({
    ok: true,
    json: function () {
      return Promise.resolve({
        ok: true,
        instance: { instanceId: "created-a", operationStatus: "1", hasComfyui: true },
      });
    },
  });
  await request;

  assert.equal(context._aigateInstancesConfirmed, false);
  assert.equal(JSON.stringify(context._aigateInstances), "[]");
  assert.equal(context._aigateCreateState, "idle");
});

test("creating an AIGate instance adopts the response and starts managed lifecycle", async function () {
  var context = loadAigateContext();
  var rendered = [];
  context._aigateInstances = [];
  context._aigateInstancesConfirmed = true;
  context._aigateConfirmedToken = "token";
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

test("AIGate lifecycle policy unregisters instances when auto-close is disabled", async function () {
  var context = loadAigateContext();
  var calls = [];
  context._getAigateToken = function () { return "token"; };
  context.loadSettings = function () { return { bridgeUrl: "http://bridge" }; };
  context.saveAigateLifecycle({ "i-1": { managed: true, pendingStart: false, startedAt: 1 } });
  context.fetchWithTimeout = function (url, options) {
    calls.push({ url: url, options: options });
    return Promise.resolve({ ok: true });
  };

  var result = await context.syncAigateManagedClosePolicy(false);
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://bridge/aigate/lifecycle");
  assert.match(calls[0].options.body, /"autoCloseOnExit":false/);
  assert.match(calls[0].options.body, /"managedInstanceIds":\["i-1"\]/);
});

test("panel reload syncs a disabled auto-close policy before replacing the bridge", async function () {
  var context = loadAigateContext();
  var calls = [];
  context.loadSettings = function () { return { aigateAutoCloseOnExit: false }; };
  context.addLogEntry = function () {};
  context.syncAigateManagedClosePolicy = function (enabled) {
    calls.push("sync:" + enabled);
    return Promise.resolve();
  };
  context.startBridgeViaShell = function () { calls.push("start"); };

  await context.forceBridgeStartOnPanelLoad();
  assert.deepEqual(calls, ["sync:false", "start"]);
});

test("resets the AIGate close guard when a UXP panel is shown again", function () {
  var context = loadAigateContext();
  context._aigateLifecycleCloseRequested = true;
  context.resetAigateManagedCloseForPanelShow();
  assert.equal(context._aigateLifecycleCloseRequested, false);
  assert.match(readModuleSource(), /uxpshowpanel/);
});
