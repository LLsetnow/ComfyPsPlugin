/*
 * ComfyPS — UXP 面板逻辑
 * 多页面架构: 主页 → 工作流 → 设置
 */

// ---- 环境检测: UXP vs 浏览器 Dev 模式 ----
var IS_DEV = typeof window !== "undefined" && window.__COMFYPS_DEV__;

var app, core, action, imaging, localFileSystem, formats, uxpShell;

if (IS_DEV) {
  var _mockPs = window.__mock_photoshop;
  var _mockUxp = window.__mock_uxp;
  app = _mockPs.app;
  core = _mockPs.core;
  action = _mockPs.action;
  imaging = _mockPs.imaging;
  localFileSystem = _mockUxp.storage.localFileSystem;
  formats = _mockUxp.storage.formats;
  uxpShell = _mockUxp.shell;
} else {
  var _ps = require("photoshop");
  var _uxp = require("uxp");
  app = _ps.app;
  core = _ps.core;
  action = _ps.action;
  imaging = _ps.imaging;
  localFileSystem = _uxp.storage.localFileSystem;
  formats = _uxp.storage.formats;
  uxpShell = _uxp.shell;
}

var executeAsModal = core.executeAsModal;
var batchPlay = action.batchPlay;
var PLUGIN_VERSION = "1.1.0";

var $ = function (id) { return document.getElementById(id); };

// =========================================================================
// 工作流定义
// =========================================================================
var WORKFLOWS = [
  {
    id: "inpaint",
    name: "局部编辑",
    icon: "⌗",
    active: true,
    needsMask: true,
    workflowId: "2075283500294565890",
    workflowFile: "../workflows/inpaint_api.json",
    imageNodeId: "41",
    inpaintVariants: {
      qwen: {
        workflowId: "2075283500294565890",
        workflowFile: "../workflows/inpaint_api.json",
        imageNodeId: "41",
        maskNodeId: "210",
        resolutionNodeId: "202",
      },
      boogu: {
        workflowId: "2077428511296888833",
        workflowFile: "../workflows/inpaint_boogu_api.json",
        imageNodeId: "71",
        maskNodeId: "214",
        resolutionNodeId: "212",
        outputNodeId: "224",
        promptNodeId: "36",
        promptField: "prompt",
      },
    },
    description: "对选区范围内的像素进行图像编辑。先画一个选区，再点运行。",
    inputs: [
      { id: "wfPrompt", type: "textarea", label: "提示词 (positive)", placeholder: "例如: 干净空旷的背景", default: "" },
      { id: "wfResolution", type: "number", label: "分辨率", placeholder: "", default: 1024 },
      {
        id: "wfInpaintVariant", type: "select", label: "模型", default: "qwen", options: [
          { value: "qwen", label: "QwenImage" },
          { value: "boogu", label: "Boogu" },
        ],
      },
    ],
    setArgs: function (inputs, runConfig) {
      var resolution = getInpaintResolution(inputs.wfResolution);
      var args = [
        runConfig.resolutionNodeId + ":output_target_width=" + resolution,
        runConfig.resolutionNodeId + ":output_target_height=" + resolution,
      ];
      if (runConfig.inpaintVariant === "qwen") {
        args.unshift("12:unet_name=qwnImageEdit_v16Bf16.safetensors");
      }
      return args;
    },
  },
  {
    id: "cleanup",
    name: "背景去杂物",
    icon: "✧",
    active: true,
    needsMask: false,
    workflowId: "2075237897401360385",
    workflowFile: "../workflows/cleanup_api.json",
    imageNodeId: "41",
    aigateSupported: true,
    outputNodeId: "220",
    promptNodeId: "68",
    promptField: "prompt",
    description: "去除背景的所有杂物与路人。修改提示词可以实现不同的去除效果。",
    inputs: [
      { id: "wfPrompt", type: "textarea", label: "提示词", placeholder: "", default: "去除主体以外的其他人物，有着干净空旷的背景，并保留原背景的景深和天花板。保留人物的物品" },
    ],
  },
  {
    id: "face",
    name: "面部重绘",
    icon: "◎",
    active: true,
    needsMask: false,
    workflowId: "2075255153690759170",
    workflowFile: "../workflows/facefix_api.json",
    imageNodeId: "27",
    aigateSupported: true,
    outputNodeId: "72",
    promptNodeId: "2",
    promptField: "text",
    description: "自动检测并修复面部细节，使皮肤更细腻、五官更立体。无需选区。",
    inputs: [
      { id: "wfPrompt", type: "textarea", label: "提示词", placeholder: "", default: "光滑细腻的皮肤质感，立体的五官" },
      { id: "wfDenoise", type: "range", label: "重绘幅度", placeholder: "", default: 0.1, min: 0, max: 1, step: 0.01 },
    ],
    setArgs: function (inputs) {
      return ["9:denoise=" + (inputs.wfDenoise || 0.1)];
    },
  },
  {
    id: "image-enhance",
    name: "图像高清",
    icon: "✦",
    active: true,
    needsMask: false,
    aigateSupported: true,
    description: "图像清晰保持原始分辨率；图像放大会按比例提升分辨率。",
    inputs: [
      {
        id: "wfImageEnhanceMode", type: "select", label: "模式", default: "clarity", options: [
          { value: "clarity", label: "图像清晰（保持分辨率）" },
          { value: "upscale", label: "图像放大" },
        ],
      },
      { id: "wfImageEnhanceScale", type: "range", label: "放大比例", default: 2, min: 1, max: 8, step: 0.1 },
    ],
    variants: {
      clarity: {
        workflowId: "2078092574119964674",
        workflowFile: "../workflows/image_clarity_api.json",
        imageNodeId: "90",
        outputNodeId: "100",
      },
      upscale: {
        workflowId: "2078099177921589250",
        workflowFile: "../workflows/image_upscale_api.json",
        imageNodeId: "90",
        outputNodeId: "100",
      },
    },
    setArgs: function (inputs) {
      return ["95:value=" + getImageEnhanceScale(inputs.wfImageEnhanceScale)];
    },
  },
  {
    id: "gpt-image",
    name: "GPT Image",
    icon: "✦",
    active: true,
    gptImage: true,
    description: "使用本机 Codex 的图像生成功能。可文生图，或裁切活动图层的选区外接矩形进行编辑。",
    inputs: [
      {
        id: "gptImageMode", type: "select", label: "生成模式", default: "generate", options: [
          { value: "generate", label: "文生图" },
          { value: "edit", label: "图像编辑（活动图层选区）" },
        ],
      },
      { id: "wfPrompt", type: "textarea", label: "关键词 / 编辑说明", placeholder: "例如：午后阳光下的极简室内产品摄影", default: "" },
      {
        id: "gptAspectRatio", type: "text", label: "画面比例（宽:高，1:3 至 3:1）",
        placeholder: "例如 2:3、7:5 或 1.91:1", default: "1:1",
      },
      {
        id: "gptResolution", type: "select", label: "分辨率", default: "1k", options: [
          { value: "1k", label: "1K（快速）" },
          { value: "2k", label: "2K（细节）" },
          { value: "4k", label: "4K（最高）" },
        ],
      },
    ],
  },
  { id: "blend", name: "物体溶图", icon: "▧", active: false },
];

// =========================================================================
// 设置 (localStorage key)
// =========================================================================
var SETTINGS_KEYS = {
  bridgeUrl: "comfyps.bridgeUrl",
  backend: "comfyps.backend",
  rhSite: "comfyps.rhSite",
  apiKey: "comfyps.apiKey",
  rhCredentials: "comfyps.rhCredentials",
  activeRhCredentialId: "comfyps.activeRhCredentialId",
  comfyuiUrl: "comfyps.comfyuiUrl",
  aigateToken: "comfyps.aigateToken",
  aigateAutoCloseOnExit: "comfyps.aigateAutoCloseOnExit",
  theme: "comfyps.theme",
  apiType: "comfyps.apiType",
  gptImageAuth: "comfyps.gptImageAuth",
  gptImageApiKey: "comfyps.gptImageApiKey",
  gptImageLocalValidation: "comfyps.gptImageLocalValidation",
  rhLocalDebug: "comfyps.rhLocalDebug",
  cacheMode: "comfyps.cacheMode",
};

// 插件受管云扉实例的本地生命周期；只保存 ID 和本机观察到的开始时间，绝不保存 Token。
var AIGATE_LIFECYCLE_STORAGE_KEY = "comfyps.aigateInstanceLifecycle.v1";

function loadAigateLifecycle() {
  var raw = localStorage.getItem(AIGATE_LIFECYCLE_STORAGE_KEY);
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveAigateLifecycle(records) {
  localStorage.setItem(AIGATE_LIFECYCLE_STORAGE_KEY, JSON.stringify(records || {}));
}

function managedAigateInstanceIds() {
  var records = loadAigateLifecycle();
  var ids = [];
  for (var instanceId in records) {
    if (Object.prototype.hasOwnProperty.call(records, instanceId) && records[instanceId].managed) {
      ids.push(instanceId);
    }
  }
  return ids;
}

function reconcileAigateLifecycle(instances) {
  var records = loadAigateLifecycle();
  var changed = false;
  for (var i = 0; i < (instances || []).length; i++) {
    var instance = instances[i] || {};
    var record = records[String(instance.instanceId || "")];
    if (record && record.managed && record.pendingStart
      && String(instance.operationStatus) === "2") {
      record.pendingStart = false;
      record.startedAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAigateLifecycle(records);
  return records;
}

function formatAigateRuntime(instanceId, now) {
  var record = loadAigateLifecycle()[String(instanceId || "")];
  if (!record || !record.managed || !record.startedAt) return "开始时间未知";
  var timestamp = typeof now === "number" ? now : Date.now();
  var seconds = Math.max(0, Math.floor((timestamp - record.startedAt) / 1000));
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  var remain = seconds % 60;
  function pad(value) { return value < 10 ? "0" + value : String(value); }
  return "运行 " + pad(hours) + ":" + pad(minutes) + ":" + pad(remain);
}

function removeAigateLifecycle(instanceId) {
  var records = loadAigateLifecycle();
  delete records[String(instanceId || "")];
  saveAigateLifecycle(records);
}

// =========================================================================
// 工作队列全局状态
// =========================================================================
var _workQueue = [];
var _selectedQueueIdx = -1;

// =========================================================================
// 当前会话日志
// =========================================================================
var _logEntries = [];
var _logMaxEntries = 300;
var _logSequence = 0;
var _lastBridgeLogId = 0;
var _bridgeLogLatestId = 0;
var _logPollTimer = 0;
var _logPollInFlight = false;
var _logAutoScroll = true;
var _logBatching = false;
var _consoleCaptureInstalled = false;
var _logRenderedFirstId = 0;
var _logRenderedCount = 0;
var _bridgeLogFailureReported = false;
var _nativeConsole = {};

function _logValueToText(value) {
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      var json = JSON.stringify(value);
      if (typeof json === "string") return json;
    } catch (_) {}
  }
  return String(value);
}

function _logLevelClass(level) {
  if (level === "warn" || level === "warning") return "warn";
  if (level === "error" || level === "err") return "error";
  if (level === "success" || level === "ok") return "success";
  return "info";
}

function _logLevelLabel(level) {
  var normalized = _logLevelClass(level);
  if (normalized === "warn") return "警告";
  if (normalized === "error") return "错误";
  if (normalized === "success") return "成功";
  return "信息";
}

function _logPadTime(value) {
  return value < 10 ? "0" + value : String(value);
}

function formatLogTime(timestamp) {
  var date = new Date(timestamp || Date.now());
  if (isNaN(date.getTime())) date = new Date();
  return _logPadTime(date.getHours()) + ":"
    + _logPadTime(date.getMinutes()) + ":"
    + _logPadTime(date.getSeconds());
}

function _isLogListAtBottom(list) {
  if (!list) return true;
  return list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
}

function updateLogAutoScrollButton() {
  var btn = $("logAutoScrollBtn");
  if (btn) btn.textContent = "自动跟随：" + (_logAutoScroll ? "开" : "关");
}

function _createLogRow(entry) {
  var level = _logLevelClass(entry.level);
  var row = document.createElement("div");
  row.className = "log-entry level-" + level;

  var time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatLogTime(entry.ts);
  row.appendChild(time);

  var source = document.createElement("span");
  source.className = "log-source";
  source.textContent = entry.source || "插件";
  row.appendChild(source);

  var levelLabel = document.createElement("span");
  levelLabel.className = "log-level";
  levelLabel.textContent = _logLevelLabel(level);
  row.appendChild(levelLabel);

  var message = document.createElement("span");
  message.className = "log-message";
  message.textContent = entry.message || "";
  row.appendChild(message);
  return row;
}

function renderLogPanel(force) {
  var list = $("logList");
  var count = $("logCount");
  if (count) count.textContent = _logEntries.length + " 条";
  if (!list) return;

  if (_logEntries.length === 0) {
    while (list.firstChild) list.removeChild(list.firstChild);
    var empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "暂无日志";
    list.appendChild(empty);
    _logRenderedFirstId = 0;
    _logRenderedCount = 0;
    return;
  }

  var shouldFollow = _logAutoScroll && _isLogListAtBottom(list);
  var firstId = _logEntries[0].id;
  var needsReset = !!force || _logRenderedFirstId !== firstId
    || _logRenderedCount > _logEntries.length;
  if (needsReset) {
    while (list.firstChild) list.removeChild(list.firstChild);
    _logRenderedCount = 0;
  }
  for (var i = _logRenderedCount; i < _logEntries.length; i++) {
    list.appendChild(_createLogRow(_logEntries[i]));
  }
  _logRenderedFirstId = firstId;
  _logRenderedCount = _logEntries.length;

  if (shouldFollow) list.scrollTop = list.scrollHeight;
}

function addLogEntry(level, message, source, timestamp) {
  var text = _logValueToText(message);
  _logEntries.push({
    id: ++_logSequence,
    ts: timestamp || Date.now(),
    level: _logLevelClass(level),
    source: source || "插件",
    message: text,
  });
  var trimmed = false;
  if (_logEntries.length > _logMaxEntries) {
    _logEntries.splice(0, _logEntries.length - _logMaxEntries);
    trimmed = true;
  }
  if (_currentPage === "logs" && !_logBatching) renderLogPanel(trimmed);
}

function clearLogPanel() {
  _logEntries = [];
  _lastBridgeLogId = Math.max(_lastBridgeLogId, _bridgeLogLatestId);
  renderLogPanel(true);
}

function installLogCapture() {
  if (_consoleCaptureInstalled || typeof console === "undefined") return;
  _consoleCaptureInstalled = true;
  var levels = ["log", "info", "warn", "error"];
  for (var i = 0; i < levels.length; i++) {
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function") continue;
    if (typeof _nativeConsole[level] !== "function") _nativeConsole[level] = original;
    (function (capturedLevel, capturedOriginal) {
      console[capturedLevel] = function () {
        var values = [];
        for (var valueIndex = 0; valueIndex < arguments.length; valueIndex++) {
          values.push(_logValueToText(arguments[valueIndex]));
        }
        addLogEntry(capturedLevel, values.join(" "), "插件");
        try {
          return capturedOriginal.apply(console, arguments);
        } catch (_) {
          return undefined;
        }
      };
    })(level, original);
  }
}

async function pollBridgeLogs() {
  if (_logPollInFlight) return;
  var settings = loadSettings();
  var bridgeUrl = (settings.bridgeUrl || "").replace(/\/+$/, "");
  if (!bridgeUrl) return;

  _logPollInFlight = true;
  try {
    var url = bridgeUrl + "/logs?since=" + encodeURIComponent(String(_lastBridgeLogId));
    var response = await fetchWithTimeout(url, null, 3000);
    if (!response.ok) throw new Error("HTTP " + response.status);
    var data = await response.json();
    var entries = data.entries || [];
    _logBatching = true;
    try {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i] || {};
        addLogEntry(entry.level || "info", entry.message || "", entry.source || "桥", entry.ts);
      }
    } finally {
      _logBatching = false;
    }
    if (entries.length > 0 && _currentPage === "logs") renderLogPanel();
    if (data.latest !== undefined && data.latest !== null) {
      _bridgeLogLatestId = Number(data.latest) || _bridgeLogLatestId;
      _lastBridgeLogId = Math.max(_lastBridgeLogId, _bridgeLogLatestId);
    } else if (entries.length > 0) {
      _lastBridgeLogId = Math.max(_lastBridgeLogId, Number(entries[entries.length - 1].id) || 0);
    }
    _bridgeLogFailureReported = false;
  } catch (_) {
    if (!_bridgeLogFailureReported) {
      _bridgeLogFailureReported = true;
      addLogEntry("warn", "无法读取本地桥日志，稍后会自动重试", "插件");
    }
  } finally {
    _logPollInFlight = false;
  }
}

function startLogPolling() {
  if (_logPollTimer) return;
  updateLogAutoScrollButton();
  pollBridgeLogs();
  _logPollTimer = setInterval(pollBridgeLogs, 1000);
}

function stopLogPolling() {
  if (_logPollTimer) clearInterval(_logPollTimer);
  _logPollTimer = 0;
}

function normalizeRhCredentialSite(site) {
  return site === "cn" ? "cn" : "ai";
}

function makeRhCredentialId() {
  return "rh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function makeDefaultRhCredentialName(site) {
  return site === "cn" ? "CN 凭据" : "AI 凭据";
}

function normalizeRhCredential(raw) {
  if (!raw || typeof raw !== "object") return null;
  var apiKey = String(raw.apiKey || "").replace(/^\s+|\s+$/g, "");
  if (!apiKey) return null;
  var site = normalizeRhCredentialSite(raw.site);
  var apiType = String(raw.apiType || "");
  var status = raw.status === "ready" || raw.status === "error" ? raw.status : "unchecked";
  return {
    id: String(raw.id || makeRhCredentialId()),
    name: String(raw.name || makeDefaultRhCredentialName(site)),
    site: site,
    apiKey: apiKey,
    coins: String(raw.coins || ""),
    balance: String(raw.balance || ""),
    symbol: String(raw.symbol || (site === "cn" ? "¥" : "$")),
    apiType: apiType,
    supportsParallel: typeof raw.supportsParallel === "boolean"
      ? raw.supportsParallel : supportsRunningHubParallel({ apiType: apiType }),
    status: status,
    errorMessage: String(raw.errorMessage || ""),
    checkedAt: Number(raw.checkedAt) || 0,
    createdAt: Number(raw.createdAt) || Date.now()
  };
}

function saveRhCredentials(credentials) {
  localStorage.setItem(SETTINGS_KEYS.rhCredentials, JSON.stringify(credentials || []));
}

function loadRhCredentials() {
  var stored = localStorage.getItem(SETTINGS_KEYS.rhCredentials);
  var credentials = [];
  if (stored !== null) {
    try {
      var parsed = JSON.parse(stored);
      if (parsed && typeof parsed.length === "number") {
        for (var i = 0; i < parsed.length; i++) {
          var normalized = normalizeRhCredential(parsed[i]);
          if (normalized) credentials.push(normalized);
        }
      }
    } catch (_) {}
    return credentials;
  }

  // 首次升级：把旧版单 Key 设置迁移成一条待检测的凭据记录。
  var legacyKey = String(localStorage.getItem(SETTINGS_KEYS.apiKey) || "").replace(/^\s+|\s+$/g, "");
  if (legacyKey) {
    var legacySite = normalizeRhCredentialSite(localStorage.getItem(SETTINGS_KEYS.rhSite));
    var legacyApiType = String(localStorage.getItem(SETTINGS_KEYS.apiType) || "");
    var legacyCredential = normalizeRhCredential({
      id: makeRhCredentialId(),
      name: makeDefaultRhCredentialName(legacySite),
      site: legacySite,
      apiKey: legacyKey,
      apiType: legacyApiType,
      status: "unchecked",
      createdAt: Date.now()
    });
    if (legacyCredential) {
      credentials.push(legacyCredential);
      localStorage.setItem(SETTINGS_KEYS.activeRhCredentialId, legacyCredential.id);
    }
  }
  saveRhCredentials(credentials);
  return credentials;
}

function findRhCredentialById(credentials, credentialId) {
  if (!credentialId) return null;
  for (var i = 0; i < credentials.length; i++) {
    if (credentials[i] && credentials[i].id === credentialId) return credentials[i];
  }
  return null;
}

function findRhCredentialByApiKey(credentials, apiKey, excludedCredentialId) {
  var targetKey = String(apiKey || "").replace(/^\s+|\s+$/g, "");
  if (!targetKey) return null;
  for (var i = 0; i < credentials.length; i++) {
    var credential = credentials[i];
    if (credential && credential.id !== excludedCredentialId && credential.apiKey === targetKey) {
      return credential;
    }
  }
  return null;
}

function getActiveRhCredential(credentials) {
  var list = credentials || loadRhCredentials();
  return findRhCredentialById(list, localStorage.getItem(SETTINGS_KEYS.activeRhCredentialId) || "");
}

function loadSettings() {
  var rhCredentials = loadRhCredentials();
  var activeRhCredential = getActiveRhCredential(rhCredentials);
  return {
    bridgeUrl: localStorage.getItem(SETTINGS_KEYS.bridgeUrl) || "http://127.0.0.1:8765",
    backend: localStorage.getItem(SETTINGS_KEYS.backend) || "runninghub",
    rhSite: activeRhCredential ? activeRhCredential.site : "ai",
    apiKey: activeRhCredential ? activeRhCredential.apiKey : "",
    rhCredentials: rhCredentials,
    rhCredential: activeRhCredential,
    rhCredentialId: activeRhCredential ? activeRhCredential.id : "",
    comfyuiUrl: localStorage.getItem(SETTINGS_KEYS.comfyuiUrl) || "http://127.0.0.1:8188",
    aigateToken: localStorage.getItem(SETTINGS_KEYS.aigateToken) || "",
    aigateAutoCloseOnExit: localStorage.getItem(SETTINGS_KEYS.aigateAutoCloseOnExit) !== "false",
    theme: localStorage.getItem(SETTINGS_KEYS.theme) || "dark",
    apiType: activeRhCredential ? activeRhCredential.apiType : "",
    gptImageAuth: localStorage.getItem(SETTINGS_KEYS.gptImageAuth) || "codex",
    gptImageApiKey: localStorage.getItem(SETTINGS_KEYS.gptImageApiKey) || "",
    gptImageLocalValidation: localStorage.getItem(SETTINGS_KEYS.gptImageLocalValidation) === "true",
    rhLocalDebug: localStorage.getItem(SETTINGS_KEYS.rhLocalDebug) === "true",
    cacheMode: localStorage.getItem(SETTINGS_KEYS.cacheMode)
      || (localStorage.getItem("comfyps.cacheBasePath") ? "custom" : "default"),
  };
}

function supportsRunningHubParallel(settings) {
  var source = settings || loadSettings();
  if (source && typeof source.supportsParallel === "boolean") return source.supportsParallel;
  var apiType = String(source.apiType || "").toLowerCase();
  return apiType.indexOf("enterprise") !== -1 || apiType.indexOf("shared") !== -1;
}

function applyTheme(theme) {
  if (theme === "light") document.body.classList.add("light");
  else document.body.classList.remove("light");
}

function saveSetting(key, value) {
  localStorage.setItem(SETTINGS_KEYS[key], value);
}

function normalizeGptAspectRatio(value) {
  var ratioText = String(value || "").replace(/\s/g, "");
  var match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratioText);
  if (!match) throw new Error("画面比例格式应为 宽:高，例如 7:5");
  var width = parseFloat(match[1]);
  var height = parseFloat(match[2]);
  var ratio = width / height;
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0
      || ratio < 1 / 3 || ratio > 3) {
    throw new Error("画面比例需在 1:3 到 3:1 之间");
  }
  return ratioText;
}

// =========================================================================
// 核心: base64
// =========================================================================
function bytesToBase64(arrayBuffer) {
  var B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var bytes = new Uint8Array(arrayBuffer);
  var len = bytes.length;
  var out = "";
  for (var i = 0; i < len; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < len ? bytes[i + 1] : 0;
    var b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B[b0 >> 2];
    out += B[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? B[b2 & 63] : "=";
  }
  return out;
}

function base64ToBytes(b64str) {
  var data = b64str.indexOf(",") !== -1 ? b64str.split(",")[1] : b64str;
  var binary = atob(data);
  var len = binary.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
