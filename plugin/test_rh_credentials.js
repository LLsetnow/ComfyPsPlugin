var assert = require("node:assert/strict");
var fs = require("node:fs");
var test = require("node:test");
var vm = require("node:vm");

function loadCredentialContext(storage) {
  var source = fs.readFileSync("plugin/main.js", "utf8");
  var end = source.indexOf("function refreshRunButton");
  var values = storage || {};
  var mockPs = {
    app: {},
    core: { executeAsModal: function () {} },
    action: { batchPlay: function () {} },
    imaging: {},
  };
  var mockUxp = { storage: { localFileSystem: {}, formats: {} }, shell: {} };
  var context = {
    window: { __COMFYPS_DEV__: true, __mock_photoshop: mockPs, __mock_uxp: mockUxp },
    document: { getElementById: function () { return null; } },
    localStorage: {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function (key, value) { values[key] = String(value); },
      removeItem: function (key) { delete values[key]; },
    },
    Math: Math,
    Date: Date,
    JSON: JSON,
  };
  assert.ok(end > 0, "credential helper boundary must exist");
  vm.createContext(context);
  vm.runInContext(source.slice(0, end), context);
  return context;
}

test("migrates the legacy key to an unchecked credential", function () {
  var context = loadCredentialContext({
    "comfyps.apiKey": "rh-legacy",
    "comfyps.rhSite": "cn",
  });
  var credentials = context.loadRhCredentials();
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].site, "cn");
  assert.equal(credentials[0].status, "unchecked");
});

test("serial credentials lock concurrent runs by API key, not card ID", function () {
  var context = loadCredentialContext();
  context._activeRuns.runningHub = [{
    rhCredentialId: "card-a",
    rhCredentialKey: "same-key",
  }];
  assert.equal(context.canStartWorkflow(null, {
    backend: "runninghub",
    rhCredentialId: "card-b",
    apiKey: "same-key",
    supportsParallel: false,
  }), false);
  assert.equal(context.canStartWorkflow(null, {
    backend: "runninghub",
    rhCredentialId: "card-c",
    apiKey: "other-key",
    supportsParallel: false,
  }), true);
});

test("finds an existing API key while excluding its own credential", function () {
  var context = loadCredentialContext();
  var credentials = [
    { id: "a", apiKey: "rh-same" },
    { id: "b", apiKey: "rh-other" },
  ];
  assert.equal(context.findRhCredentialByApiKey(credentials, "rh-same", "b").id, "a");
  assert.equal(context.findRhCredentialByApiKey(credentials, "rh-same", "a"), null);
});
