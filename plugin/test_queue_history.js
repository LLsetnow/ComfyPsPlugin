var assert = require("node:assert/strict");
var fs = require("node:fs");
var test = require("node:test");
var vm = require("node:vm");

function loadQueueContext(baseFolder) {
  var source = fs.readFileSync("plugin/queue.js", "utf8");
  var end = source.indexOf("// =========================================================================\n// 工作队列: 缓存路径设置");
  assert.ok(end > 0, "queue cache settings boundary must exist");
  var values = {};
  var context = {
    SETTINGS_KEYS: { cacheMode: "comfyps.cacheMode" },
    app: { activeDocument: { name: "document.psd" } },
    formats: { utf8: "utf8" },
    localStorage: {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem: function (key, value) { values[key] = String(value); },
    },
    localFileSystem: {
      getDataFolder: async function () { return baseFolder; },
    },
    require: function () {
      return { storage: { types: { folder: "folder", file: "file" } } };
    },
    console: { warn: function () {}, error: function () {} },
    Date: Date,
    JSON: JSON,
    URL: { revokeObjectURL: function () {} },
    confirm: function () { return true; },
    setStatus: function () {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, end), context);
  return context;
}

function file(name, content) {
  return {
    name: name,
    isFolder: false,
    read: async function () { return content; },
  };
}

test("history scan ignores a task carrying a persisted deletion tombstone", async function () {
  var taskFolder = {
    name: "task-1",
    isFolder: true,
    getEntries: async function () {
      return [
        file("result.png", "result"),
        file("meta.json", JSON.stringify({ id: "task-1", deleted: true })),
      ];
    },
  };
  var docFolder = {
    name: "document.psd",
    isFolder: true,
    getEntries: async function () { return [taskFolder]; },
  };
  var baseFolder = {
    getEntries: async function () { return [docFolder]; },
  };
  var context = loadQueueContext(baseFolder);

  var history = await context.scanDocHistory("document.psd");
  assert.equal(history.length, 0);
});

test("queue deletion waits for disk persistence before removing its in-memory sources", async function () {
  var context = loadQueueContext({ getEntries: async function () { return []; } });
  var resolveDelete;
  var deleteFinished = new Promise(function (resolve) { resolveDelete = resolve; });
  var task = {
    id: "task-1",
    psDocName: "document.psd",
    status: "completed",
    resultFile: {},
    thumbUrl: "",
  };
  context._queueViewDocName = "other-document.psd";
  context._selectedQueueIdx = 0;
  context._workQueue = [task];
  context._sessionTasks = [task];
  context._historyQueue = [task];
  context.markTaskFolderDeletedOnDisk = async function () { return true; };
  context.deleteTaskFolderFromDisk = function () { return deleteFinished; };

  var deletion = context.onQueueDeleteClick();
  assert.equal(context._workQueue.length, 1);
  assert.equal(context._sessionTasks.length, 1);
  resolveDelete(true);
  await deletion;

  assert.equal(context._sessionTasks.length, 0);
  assert.equal(context._historyQueue.length, 0);
});
