var assert = require("node:assert/strict");
var fs = require("node:fs");
var test = require("node:test");
var vm = require("node:vm");

function makeElement(tagName) {
  var element = {
    tagName: tagName,
    children: [],
    className: "",
    dataset: {},
    style: {},
    listeners: {},
    textContent: "",
    disabled: false,
    appendChild: function (child) {
      this.children.push(child);
      return child;
    },
    addEventListener: function (eventName, handler) {
      this.listeners[eventName] = handler;
    }
  };
  Object.defineProperty(element, "innerHTML", {
    get: function () { return ""; },
    set: function () { this.children = []; }
  });
  return element;
}

function createQueueContext() {
  var elements = {
    workQueueCards: makeElement("div"),
    workQueueSection: makeElement("div"),
    queueEmptyState: makeElement("div"),
    queueTabBadge: makeElement("span")
  };
  var context = {
    IS_DEV: false,
    _workQueue: [],
    _selectedQueueIdx: -1,
    document: {
      createElement: makeElement,
      querySelectorAll: function () { return []; }
    },
    $: function (id) { return elements[id] || null; },
    console: { warn: function () {} },
    setStatus: function () {},
    localStorage: { getItem: function () { return null; } },
    elements: elements
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("plugin/queue.js", "utf8"), context);
  return context;
}

function queueCardActions(card) {
  return card.children[card.children.length - 1].children;
}

test("queue card actions target their own task instead of the selected task", function () {
  var context = createQueueContext();
  var importedTaskId = "";
  var stoppedTaskId = "";
  var didStopPropagation = false;
  context.onQueueImportClick = function (taskId) { importedTaskId = taskId; };
  context.onQueueStopClick = function (taskId) { stoppedTaskId = taskId; };
  context._workQueue = [
    {
      id: "completed-task",
      wfName: "局部编辑",
      status: "completed",
      resultFile: {},
      thumbUrl: "memory://completed",
      savedOk: true,
      createdAt: 1
    },
    {
      id: "running-task",
      wfName: "背景去杂物",
      status: "running",
      runState: {},
      thumbUrl: "memory://running",
      percent: 50,
      createdAt: 2
    }
  ];
  context._selectedQueueIdx = 1;

  context.renderWorkQueue();

  var cards = context.elements.workQueueCards.children;
  var completedActions = queueCardActions(cards[0]);
  var runningActions = queueCardActions(cards[1]);
  assert.deepEqual(completedActions.map(function (button) { return button.textContent; }), ["导入", "删除"]);
  assert.deepEqual(runningActions.map(function (button) { return button.textContent; }), ["停止", "删除"]);
  assert.equal(completedActions[0].disabled, false);
  assert.equal(runningActions[0].disabled, false);
  assert.equal(runningActions[1].disabled, true);

  completedActions[0].listeners.click({
    stopPropagation: function () { didStopPropagation = true; }
  });
  runningActions[0].listeners.click({ stopPropagation: function () {} });

  assert.equal(importedTaskId, "completed-task");
  assert.equal(stoppedTaskId, "running-task");
  assert.equal(didStopPropagation, true);
});

test("queue page and bootstrap no longer contain global task action buttons", function () {
  var html = fs.readFileSync("plugin/index.html", "utf8");
  var init = fs.readFileSync("plugin/init.js", "utf8");

  assert.doesNotMatch(html, /queueImportBtn|queueStopBtn|queueDeleteBtn|queue-actions/);
  assert.doesNotMatch(init, /queueImportBtn|queueStopBtn|queueDeleteBtn/);
});
