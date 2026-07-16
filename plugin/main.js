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
  comfyuiUrl: "comfyps.comfyuiUrl",
  theme: "comfyps.theme",
  apiType: "comfyps.apiType",
  gptImageAuth: "comfyps.gptImageAuth",
  gptImageApiKey: "comfyps.gptImageApiKey",
  gptImageLocalValidation: "comfyps.gptImageLocalValidation",
  rhLocalDebug: "comfyps.rhLocalDebug",
  cacheMode: "comfyps.cacheMode",
};

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

function loadSettings() {
  return {
    bridgeUrl: localStorage.getItem(SETTINGS_KEYS.bridgeUrl) || "http://127.0.0.1:8765",
    backend: localStorage.getItem(SETTINGS_KEYS.backend) || "runninghub",
    rhSite: localStorage.getItem(SETTINGS_KEYS.rhSite) || "ai",
    apiKey: localStorage.getItem(SETTINGS_KEYS.apiKey) || "",
    comfyuiUrl: localStorage.getItem(SETTINGS_KEYS.comfyuiUrl) || "http://127.0.0.1:8188",
    theme: localStorage.getItem(SETTINGS_KEYS.theme) || "dark",
    apiType: localStorage.getItem(SETTINGS_KEYS.apiType) || "",
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

// =========================================================================
// 自包含 PNG 编码器 (无损, 支持 RGBA=color type 6 与 灰度=color type 0)
// UXP 的 imaging.encodeImageData 只输出 JPEG(有损、无 alpha)，Canvas 也不支持
// putImageData/toDataURL，因此插件侧裁切后必须用纯 JS 编码 PNG。
// DEFLATE 采用固定 Huffman + 贪心 LZ77，已在 Node(zlib) 与 macOS(sips) 双解码器
// 上做过逐字节校验(尺寸/CRC/像素往返/压缩率)。
// =========================================================================
var _PNG_CRC_TABLE = (function () {
  var table = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function _pngCrc32(bytes, start, end) {
  var crc = 0xffffffff;
  for (var i = start; i < end; i++) {
    crc = _PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function _pngAdler32(bytes) {
  var a = 1, b = 0;
  var MOD = 65521;
  var i = 0;
  var len = bytes.length;
  while (i < len) {
    var tlen = len - i > 5552 ? 5552 : len - i;
    for (var n = 0; n < tlen; n++) {
      a += bytes[i++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function _PngBitWriter() {
  this.bytes = [];
  this.bitBuffer = 0;
  this.bitCount = 0;
}
_PngBitWriter.prototype.writeBits = function (value, nbits) {
  this.bitBuffer |= (value << this.bitCount);
  this.bitCount += nbits;
  while (this.bitCount >= 8) {
    this.bytes.push(this.bitBuffer & 0xff);
    this.bitBuffer >>>= 8;
    this.bitCount -= 8;
  }
};
_PngBitWriter.prototype.writeHuff = function (code, nbits) {
  // Huffman codes are defined MSB-first; reverse them for the LSB-first writer.
  var reversed = 0;
  for (var i = 0; i < nbits; i++) {
    reversed = (reversed << 1) | ((code >>> i) & 1);
  }
  this.writeBits(reversed, nbits);
};
_PngBitWriter.prototype.finish = function () {
  if (this.bitCount > 0) {
    this.bytes.push(this.bitBuffer & 0xff);
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
  return this.bytes;
};

function _pngWriteFixedLiteral(bw, litval) {
  if (litval <= 143) bw.writeHuff(0x30 + litval, 8);
  else bw.writeHuff(0x190 + (litval - 144), 9);
}

var _PNG_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var _PNG_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
function _pngWriteFixedLength(bw, length) {
  var idx = 0;
  for (var i = 28; i >= 0; i--) {
    if (length >= _PNG_LEN_BASE[i]) { idx = i; break; }
  }
  var sym = 257 + idx;
  if (sym <= 279) bw.writeHuff(0x00 + (sym - 256), 7);
  else bw.writeHuff(0xc0 + (sym - 280), 8);
  var eb = _PNG_LEN_EXTRA[idx];
  if (eb > 0) bw.writeBits(length - _PNG_LEN_BASE[idx], eb);
}

var _PNG_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var _PNG_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
function _pngWriteFixedDistance(bw, dist) {
  var idx = 0;
  for (var i = 29; i >= 0; i--) {
    if (dist >= _PNG_DIST_BASE[i]) { idx = i; break; }
  }
  bw.writeHuff(idx, 5);
  var eb = _PNG_DIST_EXTRA[idx];
  if (eb > 0) bw.writeBits(dist - _PNG_DIST_BASE[idx], eb);
}

function _pngDeflateFixed(data) {
  var len = data.length;
  var bw = new _PngBitWriter();
  bw.writeBits(1, 1); // BFINAL=1
  bw.writeBits(1, 2); // BTYPE=01 (fixed Huffman)

  var WSIZE = 32768;
  var MIN_MATCH = 3;
  var MAX_MATCH = 258;
  var HASH_SIZE = 1 << 15;
  var HASH_MASK = HASH_SIZE - 1;
  var head = new Int32Array(HASH_SIZE);
  var prev = new Int32Array(len > 0 ? len : 1);
  for (var hi = 0; hi < HASH_SIZE; hi++) head[hi] = -1;

  var MAX_CHAIN = 128;
  var pos = 0;
  while (pos < len) {
    var bestLen = 0;
    var bestDist = 0;
    if (pos + MIN_MATCH <= len) {
      var hv = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
      var cand = head[hv];
      var chain = 0;
      var limit = len - pos;
      if (limit > MAX_MATCH) limit = MAX_MATCH;
      while (cand >= 0 && chain < MAX_CHAIN) {
        var dist = pos - cand;
        if (dist > WSIZE) break;
        if (bestLen === 0 || data[cand + bestLen] === data[pos + bestLen]) {
          var l = 0;
          while (l < limit && data[cand + l] === data[pos + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = dist;
            if (l >= limit) break;
          }
        }
        cand = prev[cand];
        chain++;
      }
    }

    if (bestLen >= MIN_MATCH) {
      _pngWriteFixedLength(bw, bestLen);
      _pngWriteFixedDistance(bw, bestDist);
      var end = pos + bestLen;
      while (pos < end) {
        if (pos + MIN_MATCH <= len) {
          var hh = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
          prev[pos] = head[hh];
          head[hh] = pos;
        }
        pos++;
      }
    } else {
      _pngWriteFixedLiteral(bw, data[pos]);
      if (pos + MIN_MATCH <= len) {
        var hx = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
        prev[pos] = head[hx];
        head[hx] = pos;
      }
      pos++;
    }
  }

  bw.writeHuff(0x00, 7); // end-of-block symbol 256
  return bw.finish();
}

function _pngZlibCompress(data) {
  var deflated = _pngDeflateFixed(data);
  var adler = _pngAdler32(data);
  var out = [];
  out.push(0x78); // CMF
  out.push(0x01); // FLG (level 0, no dict, valid FCHECK)
  for (var i = 0; i < deflated.length; i++) out.push(deflated[i]);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return out;
}

function _pngPaeth(a, b, c) {
  var p = a + b - c;
  var pa = p > a ? p - a : a - p;
  var pb = p > b ? p - b : b - p;
  var pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function _pngFilterScanlines(pixels, width, height, channels) {
  var stride = width * channels;
  var out = new Uint8Array((stride + 1) * height);
  var prevRow = new Uint8Array(stride);
  var curFiltered = new Uint8Array(stride);
  var bestFiltered = new Uint8Array(stride);
  var op = 0;
  for (var y = 0; y < height; y++) {
    var rowStart = y * stride;
    var bestType = 0;
    var bestSum = -1;
    for (var ft = 0; ft < 5; ft++) {
      var sum = 0;
      for (var x = 0; x < stride; x++) {
        var raw = pixels[rowStart + x];
        var left = x >= channels ? pixels[rowStart + x - channels] : 0;
        var up = prevRow[x];
        var ul = x >= channels ? prevRow[x - channels] : 0;
        var val;
        if (ft === 0) val = raw;
        else if (ft === 1) val = (raw - left) & 0xff;
        else if (ft === 2) val = (raw - up) & 0xff;
        else if (ft === 3) val = (raw - ((left + up) >> 1)) & 0xff;
        else val = (raw - _pngPaeth(left, up, ul)) & 0xff;
        curFiltered[x] = val;
        sum += val < 128 ? val : 256 - val;
      }
      if (bestSum < 0 || sum < bestSum) {
        bestSum = sum;
        bestType = ft;
        var tmp = bestFiltered; bestFiltered = curFiltered; curFiltered = tmp;
      }
    }
    out[op++] = bestType;
    for (var xx = 0; xx < stride; xx++) out[op++] = bestFiltered[xx];
    for (var xr = 0; xr < stride; xr++) prevRow[xr] = pixels[rowStart + xr];
  }
  return out;
}

function _pngU32be(arr, v) {
  arr.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function _pngChunk(out, type, data) {
  _pngU32be(out, data.length);
  var typeStart = out.length;
  out.push(type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3));
  for (var i = 0; i < data.length; i++) out.push(data[i]);
  var crc = _pngCrc32(out, typeStart, out.length);
  _pngU32be(out, crc);
}

// pixels: Uint8Array chunky. channels: 4 表示 RGBA(type 6), 1 表示灰度(type 0)。
function _encodePng(pixels, width, height, channels) {
  var colorType = channels === 1 ? 0 : 6;
  var filtered = _pngFilterScanlines(pixels, width, height, channels);
  var idat = _pngZlibCompress(filtered);
  var out = [];
  out.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  var ihdr = [];
  _pngU32be(ihdr, width);
  _pngU32be(ihdr, height);
  ihdr.push(8, colorType, 0, 0, 0);
  _pngChunk(out, "IHDR", ihdr);
  _pngChunk(out, "IDAT", idat);
  _pngChunk(out, "IEND", []);
  return new Uint8Array(out);
}

// =========================================================================
// 工具: fetch with timeout
// =========================================================================
function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  var controller;
  try { controller = new AbortController(); } catch (_) { return fetch(url, options); }
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  var opts = {};
  if (options) { for (var k in options) { if (options.hasOwnProperty(k)) opts[k] = options[k]; } }
  opts.signal = controller.signal;
  return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; });
}

// =========================================================================
// 状态显示
// =========================================================================
var _toastHideTimer = 0;
var _toastRemoveTimer = 0;

// 短暂提示弹窗：几秒后自动淡出；错误停留更久；点击可立即关闭。
function showToast(msg, kind) {
  var host = $("toast");
  if (!host) return;
  if (_toastHideTimer) { clearTimeout(_toastHideTimer); _toastHideTimer = 0; }
  if (_toastRemoveTimer) { clearTimeout(_toastRemoveTimer); _toastRemoveTimer = 0; }
  if (!msg) {
    host.className = "";
    host.style.display = "none";
    host.textContent = "";
    return;
  }
  host.textContent = msg;
  host.style.display = "block";
  host.className = kind || "";
  // 下一拍再加 show，触发淡入动画
  setTimeout(function () {
    host.className = "show" + (kind ? " " + kind : "");
  }, 10);
  var ms = kind === "err" ? 5000 : 2800;
  _toastHideTimer = setTimeout(function () {
    host.className = kind ? kind : ""; // 去掉 show → 淡出
    _toastRemoveTimer = setTimeout(function () {
      if (host) host.style.display = "none";
      _toastRemoveTimer = 0;
    }, 260);
    _toastHideTimer = 0;
  }, ms);
}

function setStatus(msg, kind) {
  if (msg) {
    addLogEntry(kind === "err" ? "error" : (kind === "ok" ? "success" : "info"), msg, "插件");
  }
  // 统一改为短暂弹窗提示（提交/完成/失败等），不再固定占用页面顶部。
  showToast(msg, kind);
}

// =========================================================================
// 页面导航
// =========================================================================
var _currentWorkflowId = null;
var _currentPage = "workflow";
var _workflowPageInitialized = false;

// =========================================================================
// 浏览器 / UXP UI 诊断（开发者按需调用，不改变页面状态）
// =========================================================================
function _roundUiDiagnosticValue(value) {
  var number = Number(value);
  if (!isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function _getUiDiagnosticRect(element) {
  var rect = element.getBoundingClientRect();
  return {
    left: _roundUiDiagnosticValue(rect.left),
    top: _roundUiDiagnosticValue(rect.top),
    right: _roundUiDiagnosticValue(rect.right),
    bottom: _roundUiDiagnosticValue(rect.bottom),
    width: _roundUiDiagnosticValue(rect.width),
    height: _roundUiDiagnosticValue(rect.height)
  };
}

function _getUiDiagnosticMetrics(element) {
  return {
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    offsetWidth: element.offsetWidth,
    offsetHeight: element.offsetHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop
  };
}

function _getUiDiagnosticStyles(element) {
  var view = element.ownerDocument && element.ownerDocument.defaultView;
  var computed = view && typeof view.getComputedStyle === "function"
    ? view.getComputedStyle(element) : null;
  var names = [
    "display", "position", "box-sizing", "width", "height", "min-height",
    "margin", "padding", "overflow", "overflow-y", "font-family",
    "font-size", "line-height", "visibility"
  ];
  var styles = {};
  for (var i = 0; i < names.length; i++) {
    styles[names[i]] = computed ? (computed.getPropertyValue(names[i]) || "") : "";
  }
  return styles;
}

function _getUiDiagnosticElement(selector) {
  var element = document.querySelector(selector);
  if (!element) return null;
  return {
    rect: _getUiDiagnosticRect(element),
    metrics: _getUiDiagnosticMetrics(element),
    styles: _getUiDiagnosticStyles(element)
  };
}

function _writeUiDiagnosticsToConsole(snapshot) {
  var output = JSON.stringify(snapshot, null, 2);
  // 使用日志捕获安装前保存的原生 console，避免污染插件的日志页。
  if (typeof _nativeConsole.log === "function") {
    try { _nativeConsole.log.call(console, output); } catch (_) {}
  }
}

function dumpUiDiagnostics() {
  var activePage = document.querySelector(".page.active");
  var root = document.documentElement;
  var body = document.body;
  var snapshot = {
    runtime: {
      userAgent: typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "",
      viewportWidth: window.innerWidth || 0,
      viewportHeight: window.innerHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      isDevPreview: !!IS_DEV
    },
    document: {
      root: root ? _getUiDiagnosticMetrics(root) : null,
      body: body ? _getUiDiagnosticMetrics(body) : null,
      pageXOffset: window.pageXOffset || 0,
      pageYOffset: window.pageYOffset || 0
    },
    activePage: activePage ? {
      id: activePage.id || null,
      snapshot: {
        rect: _getUiDiagnosticRect(activePage),
        metrics: _getUiDiagnosticMetrics(activePage),
        styles: _getUiDiagnosticStyles(activePage)
      }
    } : null,
    elements: {
      appShell: _getUiDiagnosticElement(".app-shell"),
      topbar: _getUiDiagnosticElement(".app-topbar"),
      workflowGrid: _getUiDiagnosticElement("#workflowGrid"),
      workflowInputs: _getUiDiagnosticElement("#workflowInputs"),
      runActions: _getUiDiagnosticElement("#runActions"),
      queueCards: _getUiDiagnosticElement("#workQueueCards"),
      logTerminal: _getUiDiagnosticElement(".log-terminal"),
      logList: _getUiDiagnosticElement("#logList")
    }
  };
  _writeUiDiagnosticsToConsole(snapshot);
  return snapshot;
}

if (typeof window !== "undefined") window.dumpUiDiagnostics = dumpUiDiagnostics;

function normalizePageName(page) {
  // 保留数字参数兼容性，新的页面逻辑统一使用语义化名称。
  if (page === 2) return "workflow";
  if (page === 3) return "settings";
  return page === "queue" || page === "logs" || page === "settings" ? page : "workflow";
}

function navigateTo(page) {
  var pageName = normalizePageName(page);
  var pageIds = {
    workflow: "pageWorkflow",
    queue: "pageQueue",
    logs: "pageLogs",
    settings: "pageSettings",
  };
  if (pageName !== "logs") stopLogPolling();
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) { pages[i].classList.remove("active"); }
  var target = $(pageIds[pageName]);
  if (target) target.classList.add("active");

  var tabs = document.querySelectorAll(".topbar-tab");
  for (var ti = 0; ti < tabs.length; ti++) {
    if (tabs[ti].dataset.page === pageName) tabs[ti].classList.add("active");
    else tabs[ti].classList.remove("active");
  }
  _currentPage = pageName;

  if (pageName === "workflow") {
    renderWorkflowGrid();
    if (!_workflowPageInitialized) {
      selectWorkflow(_selectedWorkflowId || "inpaint");
      _workflowPageInitialized = true;
    }
    checkBridgeHealth();
  } else if (pageName === "queue") {
    // 打开队列页：按当前 PS 文件名自动扫描并加载历史任务。
    loadQueueHistoryForActiveDoc();
  } else if (pageName === "logs") {
    renderLogPanel();
    startLogPolling();
  } else if (pageName === "settings") {
    renderSettings();
  }
}

// =========================================================================
// 导出当前文档为 PNG (base64)
// =========================================================================
async function exportActiveDocPNG() {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");

  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_input.png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);

  await executeAsModal(
    async function () {
      await batchPlay(
        [{
          _obj: "save",
          as: { _obj: "PNGFormat", method: { _enum: "PNGMethod", _value: "quick" } },
          in: { _path: token, _kind: "local" },
          copy: true,
          lowerCase: true,
          _options: { dialogOptions: "dontDisplay" },
        }],
        {}
      );
    },
    { commandName: "导出文档PNG" }
  );

  var buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出的 PNG 为空");
  return bytesToBase64(buf);
}

// =========================================================================
// GPT Image: 图层与选区输入
// =========================================================================
function _asPixels(value) {
  if (typeof value === "number") return value;
  if (value && typeof value._value === "number") return value._value;
  if (value && typeof value.value === "number") return value.value;
  var parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

function _layerChildren(layer) {
  if (!layer || !layer.layers) return [];
  return layer.layers;
}

function _flattenLayers(layers, parents, output) {
  if (!layers) return;
  for (var li = 0; li < layers.length; li++) {
    var layer = layers[li];
    if (!layer) continue;
    var id = String(layer.id);
    var record = {
      id: id,
      name: layer.name || ("图层 " + id),
      path: parents.concat([layer.name || ("图层 " + id)]).join(" / "),
      ancestorIds: parents._ids ? parents._ids.slice() : [],
      layer: layer,
    };
    output.push(record);

    var childParents = parents.concat([layer.name || ("图层 " + id)]);
    childParents._ids = record.ancestorIds.concat([id]);
    _flattenLayers(_layerChildren(layer), childParents, output);
  }
}

function getDocumentLayerRecords() {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  var records = [];
  var root = [];
  root._ids = [];
  _flattenLayers(doc.layers || [], root, records);
  if (!records.length) throw new Error("当前文档没有可用图层");
  return records;
}

function findLayerRecord(records, id) {
  for (var ri = 0; ri < records.length; ri++) {
    if (records[ri].id === String(id)) return records[ri];
  }
  return null;
}

function _containsId(ids, id) {
  for (var ii = 0; ii < ids.length; ii++) {
    if (ids[ii] === String(id)) return true;
  }
  return false;
}

function _snapshotLayerVisibility(records) {
  var snapshot = [];
  for (var si = 0; si < records.length; si++) {
    snapshot.push({ layer: records[si].layer, visible: records[si].layer.visible !== false });
  }
  return snapshot;
}

function _restoreLayerVisibility(snapshot) {
  for (var si = 0; si < snapshot.length; si++) {
    try { snapshot[si].layer.visible = snapshot[si].visible; } catch (_) {}
  }
}

function _isolateLayer(records, targetId) {
  var target = findLayerRecord(records, targetId);
  if (!target) throw new Error("找不到所选图层，请重新选择");
  for (var li = 0; li < records.length; li++) {
    var record = records[li];
    var shouldShow = record.id === target.id ||
      _containsId(record.ancestorIds, target.id) ||
      _containsId(target.ancestorIds, record.id);
    try { record.layer.visible = shouldShow; } catch (_) {}
  }
  return target;
}

function _pngSaveDescriptor(token) {
  return {
    _obj: "save",
    as: { _obj: "PNGFormat", method: { _enum: "PNGMethod", _value: "quick" } },
    in: { _path: token, _kind: "local" },
    copy: true,
    lowerCase: true,
    _options: { dialogOptions: "dontDisplay" },
  };
}

async function exportLayerPNG(layerId) {
  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_gpt_reference_" + layerId + ".png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);
  var records = getDocumentLayerRecords();
  var visibility = _snapshotLayerVisibility(records);

  await executeAsModal(
    async function () {
      try {
        _isolateLayer(records, layerId);
        await batchPlay([_pngSaveDescriptor(token)], {});
      } finally {
        _restoreLayerVisibility(visibility);
      }
    },
    { commandName: "导出 GPT Image 参考图层" }
  );

  var buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出参考图层失败");
  return bytesToBase64(buf);
}

async function exportActiveLayerPNG() {
  return exportLayerPNG(_activeLayerId());
}

function _parseSelectionBounds(result) {
  var selection = result && (result.selection || result);
  if (!selection || selection.top === undefined || selection.left === undefined ||
      selection.right === undefined || selection.bottom === undefined) {
    throw new Error("请先做一个选区");
  }
  var left = _asPixels(selection.left);
  var top = _asPixels(selection.top);
  var right = _asPixels(selection.right);
  var bottom = _asPixels(selection.bottom);
  if (right <= left || bottom <= top) throw new Error("选区范围无效");
  return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
}

// Photoshop 的选区边界可能带有小数像素，且极少数情况下会延伸到画布外。
// 上传裁切图时必须把图层和蒙版裁到同一个整数矩形，否则返图缩放后会出现
// 一像素偏移或蒙版尺寸不一致。向外取整可以保证整个选区都被保留。
function _normalizeSelectionCropBounds(bounds) {
  var doc = app.activeDocument;
  var docWidth = _asPixels(doc && doc.width);
  var docHeight = _asPixels(doc && doc.height);
  var left = Math.floor(_asPixels(bounds && bounds.left));
  var top = Math.floor(_asPixels(bounds && bounds.top));
  var right = Math.ceil(_asPixels(bounds && bounds.right));
  var bottom = Math.ceil(_asPixels(bounds && bounds.bottom));

  if (docWidth > 0) {
    left = Math.max(0, Math.min(left, Math.floor(docWidth)));
    right = Math.max(0, Math.min(right, Math.ceil(docWidth)));
  }
  if (docHeight > 0) {
    top = Math.max(0, Math.min(top, Math.floor(docHeight)));
    bottom = Math.max(0, Math.min(bottom, Math.ceil(docHeight)));
  }
  if (right <= left || bottom <= top) throw new Error("选区外接矩形无效");
  return {
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    width: right - left,
    height: bottom - top,
  };
}

function _cropDescriptor(bounds, options) {
  return {
    _obj: "crop",
    to: {
      _obj: "rectangle",
      top: { _unit: "pixelsUnit", _value: bounds.top },
      left: { _unit: "pixelsUnit", _value: bounds.left },
      bottom: { _unit: "pixelsUnit", _value: bounds.bottom },
      right: { _unit: "pixelsUnit", _value: bounds.right },
    },
    _options: options || { dialogOptions: "silent" },
  };
}

async function _readSelectionBounds() {
  var doc = app.activeDocument;
  if (doc && doc.selection && doc.selection.bounds) {
    return _parseSelectionBounds(doc.selection.bounds);
  }
  var result = await batchPlay(
    [{
      _obj: "get",
      _target: [
        { _property: "selection" },
        { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
      ],
      _options: { dialogOptions: "dontDisplay" },
    }],
    {}
  );
  return _parseSelectionBounds(result && result[0]);
}

function _activeLayerId() {
  var doc = app.activeDocument;
  var activeLayers = doc && doc.activeLayers;
  if (!activeLayers || !activeLayers.length || activeLayers[0].id === undefined) {
    throw new Error("请先在 Photoshop 中选择一个图层");
  }
  return String(activeLayers[0].id);
}

async function _snapshotSelectionChannel() {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  var channelName = "comfyps_local_sel_" + Date.now();
  await executeAsModal(
    async function () {
      try {
        await batchPlay([{
          _obj: "duplicate",
          _target: [{ _ref: "channel", _property: "selection" }],
          name: channelName,
          _options: { dialogOptions: "silent" },
        }], {});
      } catch (_) {
        throw new Error("请先做一个选区(未检测到选区)");
      }
    },
    { commandName: "保存 GPT Image 本地验证选区" }
  );
  return channelName;
}

// 本地验证不应走桥、图像模型或网络请求，但要模拟真实 GPT 编辑的返图
// 形态：先导出活动图层的选区外接矩形，再按原始坐标贴回，并创建选区蒙版。
// 这样验证得到的图层尺寸和位置与真实 GPT 编辑返图一致，而不是完整原图层。
async function runFastGptEditValidation(layerName) {
  var selectionChannelName = "";
  try {
    selectionChannelName = await _snapshotSelectionChannel();
    var editInput = await exportActiveLayerSelectionPNG();
    await placeImageBytesAsLayer(
      editInput.image,
      layerName,
      editInput.bounds,
      true,
      selectionChannelName
    );
    // placeImageBytesAsLayer 已在创建图层蒙版后清理了快照通道。
    selectionChannelName = "";
    return editInput.bounds;
  } finally {
    if (selectionChannelName) {
      await removeSelectionSnapshotChannel(selectionChannelName);
    }
  }
}

// =========================================================================
// 无文档切换的选区裁切导出 (photoshop.imaging)
// getPixels/getSelection 直接按 sourceBounds 读取像素，无需复制文档或切换图层
// 可见性，因此不会瞬间切换到临时副本文档；再由插件侧 _encodePng 编码上传。
// 旧的“复制文档+裁切”路径保留为回退，兼容缺少 imaging 能力的宿主版本。
// 无论走哪条路径，图片与蒙版都补齐到同一个 normalized 选区外接矩形，尺寸严格一致。
// =========================================================================
function _imagingCropSupported() {
  return !!(imaging && typeof imaging.getPixels === "function"
    && typeof imaging.getSelection === "function");
}

function _activeDocId() {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  return doc.id;
}

function _boundsOffset(actual, bounds) {
  var left = actual && actual.left !== undefined ? _asPixels(actual.left) : bounds.left;
  var top = actual && actual.top !== undefined ? _asPixels(actual.top) : bounds.top;
  return { left: left, top: top };
}

// 把 imaging 返回的(可能被裁到实际像素区域的)缓冲区补齐到完整选区外接矩形，
// 保证图片与蒙版尺寸严格一致。RGBA 空白处填透明。
function _padRgbaToRect(data, comps, srcW, srcH, offLeft, offTop, bounds) {
  var w = bounds.width, h = bounds.height;
  var dst = new Uint8Array(w * h * 4);
  var dx0 = Math.round(offLeft - bounds.left);
  var dy0 = Math.round(offTop - bounds.top);
  for (var y = 0; y < srcH; y++) {
    var dy = dy0 + y;
    if (dy < 0 || dy >= h) continue;
    for (var x = 0; x < srcW; x++) {
      var dx = dx0 + x;
      if (dx < 0 || dx >= w) continue;
      var s = (y * srcW + x) * comps;
      var d = (dy * w + dx) * 4;
      dst[d] = data[s];
      dst[d + 1] = comps >= 3 ? data[s + 1] : data[s];
      dst[d + 2] = comps >= 3 ? data[s + 2] : data[s];
      dst[d + 3] = comps === 4 ? data[s + 3] : (comps === 2 ? data[s + 1] : 255);
    }
  }
  return dst;
}

// 灰度补齐；空白处填 fillValue(选区蒙版未选中区应为 0)。
function _padGrayToRect(data, comps, srcW, srcH, offLeft, offTop, bounds, fillValue) {
  var w = bounds.width, h = bounds.height;
  var dst = new Uint8Array(w * h);
  if (fillValue) {
    for (var i = 0; i < dst.length; i++) dst[i] = fillValue;
  }
  var dx0 = Math.round(offLeft - bounds.left);
  var dy0 = Math.round(offTop - bounds.top);
  for (var y = 0; y < srcH; y++) {
    var dy = dy0 + y;
    if (dy < 0 || dy >= h) continue;
    for (var x = 0; x < srcW; x++) {
      var dx = dx0 + x;
      if (dx < 0 || dx >= w) continue;
      dst[dy * w + dx] = data[(y * srcW + x) * comps];
    }
  }
  return dst;
}

async function _exportActiveLayerSelectionViaImaging(bounds) {
  var docId = _activeDocId();
  var layerId = Number(_activeLayerId());
  if (!bounds) bounds = _normalizeSelectionCropBounds(await _readSelectionBounds());
  var rgba = null;
  // imaging 读取需要 modal 作用域，但 executeAsModal 本身不切换/复制文档，因此不会闪切。
  await executeAsModal(async function () {
    var res = await imaging.getPixels({
      documentID: docId,
      layerID: layerId,
      sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      colorSpace: "RGB",
      componentSize: 8,
      applyAlpha: false,
    });
    var imageData = res.imageData;
    var off = _boundsOffset(res.sourceBounds, bounds);
    var comps = imageData.components || 4;
    var data = await imageData.getData({ chunky: true });
    rgba = _padRgbaToRect(data, comps, imageData.width, imageData.height, off.left, off.top, bounds);
    try { if (typeof imageData.dispose === "function") imageData.dispose(); } catch (_) {}
  }, { commandName: "读取选区图层像素(imaging)" });
  var png = _encodePng(rgba, bounds.width, bounds.height, 4);
  return { image: bytesToBase64(png), bounds: bounds };
}

async function _readSelectionGray(bounds) {
  var docId = _activeDocId();
  var gray = null;
  // 同样在 modal 作用域内读取选区蒙版；不复制文档，无闪切。
  await executeAsModal(async function () {
    var res = await imaging.getSelection({
      documentID: docId,
      sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    });
    var imageData = res.imageData;
    var off = _boundsOffset(res.sourceBounds, bounds);
    var comps = imageData.components || 1;
    var data = await imageData.getData({ chunky: true });
    // imaging.getSelection: 选中处=255(白)，未选中=0(黑)；空白补 0(未选中)。
    gray = _padGrayToRect(data, comps, imageData.width, imageData.height, off.left, off.top, bounds, 0);
    try { if (typeof imageData.dispose === "function") imageData.dispose(); } catch (_) {}
  }, { commandName: "读取选区蒙版(imaging)" });
  return gray;
}

async function _exportSelectionMaskViaImaging(forGptImage, keepSelectionSnapshot, cropBounds) {
  var bounds = _normalizeSelectionCropBounds(cropBounds);
  var gray = await _readSelectionGray(bounds);
  var png;
  if (forGptImage) {
    // 与旧路径一致: 未选区=不透明白，选区=透明(alpha 随选区羽化过渡)。
    var n = bounds.width * bounds.height;
    var rgba = new Uint8Array(n * 4);
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
      rgba[o + 3] = 255 - gray[i];
    }
    png = _encodePng(rgba, bounds.width, bounds.height, 4);
  } else {
    // RunningHub: 选区=白，未选区=黑。
    png = _encodePng(gray, bounds.width, bounds.height, 1);
  }
  var maskB64 = bytesToBase64(png);
  if (keepSelectionSnapshot) {
    var channelName = await _snapshotSelectionChannel();
    return { mask: maskB64, selectionChannelName: channelName };
  }
  return maskB64;
}

async function exportActiveLayerSelectionPNG() {
  if (_imagingCropSupported()) {
    try {
      return await _exportActiveLayerSelectionViaImaging();
    } catch (e) {
      addLogEntry("warn", "imaging 图层导出失败，回退复制文档(会闪切): " +
        (e && e.message ? e.message : e), "插件");
    }
  } else {
    addLogEntry("warn", "当前宿主无 imaging.getPixels/getSelection，使用复制文档导出(会闪切)", "插件");
  }
  return await _exportActiveLayerSelectionViaDuplicate();
}

async function _exportActiveLayerSelectionViaDuplicate() {
  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_gpt_edit_input.png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);
  var layerId = _activeLayerId();
  var records = getDocumentLayerRecords();
  var visibility = _snapshotLayerVisibility(records);
  var bounds;
  var duplicated = false;
  var duplicateDoc = null;
  var noDialog = { dialogOptions: "dontDisplay" };

  await executeAsModal(
    async function () {
      try {
        bounds = _normalizeSelectionCropBounds(await _readSelectionBounds());
        _isolateLayer(records, layerId);
        if (typeof app.activeDocument.duplicate === "function") {
          duplicateDoc = await app.activeDocument.duplicate("ComfyPS GPT Image Input");
          duplicated = true;
          await duplicateDoc.crop(bounds);
          await batchPlay([_pngSaveDescriptor(token)], {});
        } else {
          await batchPlay([{
            _obj: "duplicate",
            _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
            name: "ComfyPS GPT Image Input",
            _options: noDialog,
          }], {});
          duplicated = true;
          await batchPlay([
            _cropDescriptor(bounds, noDialog),
            _pngSaveDescriptor(token),
          ], {});
        }
      } finally {
        if (duplicated) {
          try {
            if (duplicateDoc && typeof duplicateDoc.closeWithoutSaving === "function") {
              await duplicateDoc.closeWithoutSaving();
            } else {
              await batchPlay([{
                _obj: "close",
                saving: { _enum: "yesNo", _value: "no" },
                _options: noDialog,
              }], {});
            }
          } catch (_) {}
        }
        _restoreLayerVisibility(visibility);
      }
    },
    { commandName: "导出 GPT Image 图层选区" }
  );

  var buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出当前图层选区失败");
  return { image: bytesToBase64(buf), bounds: bounds };
}

// =========================================================================
// 导出当前选区为蒙版 PNG (base64, 默认白=选中；GPT Image 为透明=编辑区)
// =========================================================================
async function exportSelectionMaskPNG(forGptImage, keepSelectionSnapshot, cropBounds) {
  // 选区裁切场景(cropBounds 存在)优先走无切换的 imaging 路径；本地整画布调试
  // (无 cropBounds)保留旧的整画布导出行为。
  if (cropBounds && _imagingCropSupported()) {
    try {
      return await _exportSelectionMaskViaImaging(forGptImage, keepSelectionSnapshot, cropBounds);
    } catch (e) {
      addLogEntry("warn", "imaging 蒙版导出失败，回退复制文档(会闪切): " +
        (e && e.message ? e.message : e), "插件");
    }
  }
  return await _exportSelectionMaskViaDuplicate(forGptImage, keepSelectionSnapshot, cropBounds);
}

async function _exportSelectionMaskViaDuplicate(forGptImage, keepSelectionSnapshot, cropBounds) {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");

  var normalizedCropBounds = cropBounds
    ? _normalizeSelectionCropBounds(cropBounds) : null;

  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_mask.png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);

  // `dontDisplay` may still open Photoshop's Fill dialog when the host
  // needs additional information. Mask export has all required parameters,
  // so use `silent` and surface any failure in the plugin instead.
  var noDialog = { dialogOptions: "silent" };
  var fillCmd = function (v) {
    return {
      _obj: "fill",
      using: { _enum: "fillContents", _value: v },
      opacity: { _unit: "percentUnit", _value: 100 },
      mode: { _enum: "blendMode", _value: "normal" },
      _options: noDialog,
    };
  };
  var setSel = function (to) {
    return {
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: to,
      _options: noDialog,
    };
  };

  var channelName = "comfyps_sel_" + Date.now();
  var sourceChannel = null;
  var duplicateDoc = null;
  var tempLayer = null;
  var tempLayerCreated = false;
  var batchPlayLayerCreated = false;
  var batchPlayDuplicate = false;
  var channelCreated = false;

  var removeSourceChannel = async function () {
    if (!channelCreated) return;
    if (sourceChannel && typeof sourceChannel.remove === "function") {
      try {
        await sourceChannel.remove();
        return;
      } catch (_) {}
    }
    try {
      await batchPlay(
        [{
          _obj: "delete",
          _target: [{ _ref: "channel", _name: channelName }],
          _options: noDialog,
        }],
        {}
      );
    } catch (_) {}
  };

  await executeAsModal(
    async function () {
      try {
        await batchPlay(
          [{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name: channelName, _options: noDialog }],
          {}
        );
        channelCreated = true;
      } catch (e) {
        throw new Error("请先做一个选区(未检测到选区)");
      }

      try {
        // Use the same DOM duplicate-and-crop path as the active-layer image
        // export. In real Photoshop an untargeted batchPlay crop can leave the
        // mask save on the original full-size document, producing dimensions
        // that do not match the cropped image.
        if (typeof doc.duplicate === "function") {
          duplicateDoc = await doc.duplicate("ComfyPS Mask Input");
          batchPlayDuplicate = true;
          if (normalizedCropBounds) await duplicateDoc.crop(normalizedCropBounds);
        } else {
          await batchPlay([{
            _obj: "duplicate",
            _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
            name: "ComfyPS Mask Input",
            _options: noDialog,
          }], {});
          batchPlayDuplicate = true;
          if (normalizedCropBounds) {
            await batchPlay([_cropDescriptor(normalizedCropBounds, noDialog)], {});
          }
        }

        // Create a new layer at the top of the duplicate for the B&W mask.
        await batchPlay([{
          _obj: "make",
          _target: [{ _ref: "layer" }],
          using: { _obj: "layer", name: "ComfyPS Mask" },
          _options: noDialog,
        }], {});
        batchPlayLayerCreated = true;

        await batchPlay(
          [
            setSel({ _enum: "ordinal", _value: "allEnum" }),
            fillCmd(forGptImage ? "white" : "black"),
            setSel({ _ref: "channel", _name: channelName }),
            fillCmd(forGptImage ? "clear" : "white"),
            setSel({ _enum: "ordinal", _value: "none" }),
            {
              _obj: "save",
              as: { _obj: "PNGFormat", method: { _enum: "PNGMethod", _value: "quick" } },
              in: { _path: token, _kind: "local" },
              copy: true, lowerCase: true,
              _options: noDialog,
            },
          ],
          {}
        );
      } finally {
        if (batchPlayDuplicate) {
          try {
            if (duplicateDoc && typeof duplicateDoc.closeWithoutSaving === "function") {
              await duplicateDoc.closeWithoutSaving();
            } else {
              await batchPlay([{
                _obj: "close",
                saving: { _enum: "yesNo", _value: "no" },
                _options: noDialog,
              }], {});
            }
          } catch (_) {}
        }

        // After closing the duplicate, the original document is active again.
        if (!keepSelectionSnapshot) await removeSourceChannel();
      }
    },
    { commandName: "导出选区蒙版" }
  );

  var buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出蒙版失败");
  var mask = bytesToBase64(buf);
  if (keepSelectionSnapshot) {
    return { mask: mask, selectionChannelName: channelName };
  }
  return mask;
}

// =========================================================================
// 进度轮询
// =========================================================================
var _activeRuns = {
  gptImage: null,
  runningHub: [],
  other: null
};

function getRunSlot(workflow, settings) {
  if (workflow && workflow.gptImage) return "gptImage";
  return settings && settings.backend === "runninghub" ? "runningHub" : "other";
}

function activeRunCount(slot) {
  var active = _activeRuns[slot];
  if (slot === "runningHub" && active && typeof active.length === "number") return active.length;
  return active ? 1 : 0;
}

function registerActiveRun(slot, runState, settings) {
  if (slot === "runningHub" && supportsRunningHubParallel(settings)) {
    if (!_activeRuns.runningHub || typeof _activeRuns.runningHub.length !== "number") {
      _activeRuns.runningHub = [];
    }
    _activeRuns.runningHub.push(runState);
    return;
  }
  _activeRuns[slot] = runState;
}

function unregisterActiveRun(slot, runState) {
  if (slot === "runningHub" && _activeRuns.runningHub
    && typeof _activeRuns.runningHub.length === "number") {
    for (var i = _activeRuns.runningHub.length - 1; i >= 0; i--) {
      if (_activeRuns.runningHub[i] === runState) _activeRuns.runningHub.splice(i, 1);
    }
    return;
  }
  if (_activeRuns[slot] === runState) _activeRuns[slot] = null;
}

function canStartWorkflow(workflow, settings) {
  var slot = getRunSlot(workflow, settings);
  if (slot === "runningHub" && supportsRunningHubParallel(settings)) {
    return activeRunCount("other") === 0;
  }
  if (activeRunCount(slot) > 0) return false;
  if (slot === "gptImage" || slot === "runningHub") return !_activeRuns.other;
  return activeRunCount("gptImage") === 0 && activeRunCount("runningHub") === 0
    && activeRunCount("other") === 0;
}

function refreshRunButton() {
  var runBtn = $("runBtn");
  var label = $("btnLabel");
  var spinner = $("btnSpinner");
  var workflow = findWorkflow(_selectedWorkflowId);
  if (!runBtn || !workflow) return;

  var slot = getRunSlot(workflow, loadSettings());
  var hasActiveRun = activeRunCount(slot) > 0;
  var canStart = canStartWorkflow(workflow, loadSettings());
  runBtn.disabled = !canStart;
  if (label) {
    label.hidden = false;
    label.textContent = "生成";
  }
  if (spinner) spinner.hidden = !hasActiveRun;
}

// =========================================================================
// 调用本地桥 /run
// =========================================================================
function getInpaintResolution(value) {
  var resolution = parseInt(value, 10);
  if (!isFinite(resolution) || resolution < 1) return 1024;
  return resolution;
}

function getWorkflowRunConfig(workflow, inputs) {
  var runConfig = {
    workflowId: workflow.workflowId,
    workflowFile: workflow.workflowFile || "",
    imageNodeId: workflow.imageNodeId || "",
    maskNodeId: workflow.maskNodeId || "",
    resolutionNodeId: "",
    inpaintVariant: "",
  };
  if (workflow.id === "inpaint" && workflow.inpaintVariants) {
    var variantId = inputs && inputs.wfInpaintVariant === "boogu" ? "boogu" : "qwen";
    var variant = workflow.inpaintVariants[variantId] || workflow.inpaintVariants.qwen;
    runConfig.workflowId = variant.workflowId;
    runConfig.workflowFile = variant.workflowFile;
    runConfig.imageNodeId = variant.imageNodeId;
    runConfig.maskNodeId = variant.maskNodeId;
    runConfig.resolutionNodeId = variant.resolutionNodeId;
    runConfig.inpaintVariant = variantId;
  }
  return runConfig;
}

async function callBridge(bridgeUrl, imageB64, maskB64, prompt, settings, workflow, inputs, taskId, onProgress) {
  var pollTimer = 0;
  var url = bridgeUrl.replace(/\/+$/, "") + "/run";
  var runConfig = getWorkflowRunConfig(workflow, inputs);
  var body = {
    image: imageB64,
    prompt: prompt || "",
    backend: settings.backend,
    workflowId: runConfig.workflowId,
    workflowFile: runConfig.workflowFile,
    imageNodeId: runConfig.imageNodeId,
    needsMask: workflow.needsMask,
    taskId: taskId || "",
  };
  if (runConfig.maskNodeId) body.maskNodeId = runConfig.maskNodeId;
  if (workflow.needsMask) {
    body.mask = maskB64;
  }
  // 工作流自定义参数注入 (如 denoise 等)
  if (typeof workflow.setArgs === "function") {
    body.extraSetArgs = workflow.setArgs(inputs, runConfig);
  }
  if (settings.backend === "comfyui") {
    body.comfyuiUrl = settings.comfyuiUrl;
  } else {
    body.site = settings.rhSite;
    if (settings.apiKey) body.apiKey = settings.apiKey;
  }

  var resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("连不上本地桥(" + url + "):" + (e && e.message ? e.message : e) + "。桥启动了吗?");
  }
  if (!resp.ok) {
    var detail = "";
    try {
      var j = JSON.parse(await resp.text());
      detail = j.message || j.error || JSON.stringify(j);
    } catch (_) {
      detail = "HTTP " + resp.status;
    }
    throw new Error("云端处理失败:" + detail);
  }

  // 提取任务 ID 并启动进度轮询
  var taskId = resp.headers.get("X-Task-Id");
  if (taskId && onProgress) {
    pollTimer = setInterval(async function () {
      try {
        var pr = await fetch(bridgeUrl.replace(/\/+$/, "") + "/progress?taskId=" + taskId);
        if (pr.ok) {
          var data = await pr.json();
          var pct = data.percent || 0;
          onProgress(pct, (data.message || "") + (pct > 0 ? " (" + pct + "%)" : ""));
          if (pct >= 100) clearInterval(pollTimer);
        }
      } catch (_) {}
    }, 2000);
  }

  try {
    return await resp.arrayBuffer();
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

// =========================================================================
// 调用本地 GPT Image 桥
// =========================================================================
function makeGptTaskId() {
  return "gpt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function makeGptTaskCancelledError() {
  var error = new Error("GPT Image 任务已停止");
  error.comfypsGptTaskCancelled = true;
  return error;
}

function isGptTaskCancelled(error) {
  return !!(error && error.comfypsGptTaskCancelled);
}

function throwIfGptTaskCancelled(runState) {
  if (runState && runState.cancelRequested) throw makeGptTaskCancelledError();
}

function startGptProgressPolling(bridgeUrl, taskId, onProgress) {
  if (!taskId || !onProgress) return 0;
  var timer = setInterval(async function () {
    try {
      var pr = await fetch(bridgeUrl.replace(/\/+$/, "") + "/progress?taskId=" + encodeURIComponent(taskId));
      if (pr.ok) {
        var data = await pr.json();
        var pct = data.percent || 0;
        onProgress(pct, (data.message || "") + (pct > 0 ? " (" + pct + "%)" : ""));
        if (pct >= 100 || data.message === "已停止") clearInterval(timer);
      }
    } catch (_) {}
  }, 1000);
  return timer;
}

async function callGptImage(bridgeUrl, provider, apiKey, mode, prompt, aspectRatio, resolution, images, maskB64, runState, localValidation) {
  var pollTimer = 0;
  var url = bridgeUrl.replace(/\/+$/, "") + "/gpt-image";
  throwIfGptTaskCancelled(runState);
  var taskId = runState && runState.taskId ? runState.taskId : makeGptTaskId();
  if (runState) runState.taskId = taskId;
  var body = {
    taskId: taskId,
    provider: provider || "codex",
    mode: mode,
    prompt: prompt || "",
    aspectRatio: aspectRatio || "",
    resolution: resolution || "",
    images: images || [],
  };
  if (localValidation) body.localValidation = true;
  if (maskB64) body.mask = maskB64;
  if (provider === "api-key" && apiKey) body.apiKey = apiKey;

  var resp;
  try {
    var fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    if (runState && runState.abortController) fetchOptions.signal = runState.abortController.signal;
    if (runState) runState.bridgeRequestStarted = true;
    var request = fetch(url, fetchOptions);
    pollTimer = startGptProgressPolling(bridgeUrl, taskId, runState && runState.onProgress);
    resp = await request;
  } catch (e) {
    if ((runState && runState.cancelRequested) || (e && e.name === "AbortError")) {
      throw makeGptTaskCancelledError();
    }
    throw new Error("连不上本地 GPT Image 桥(" + url + "):" + (e && e.message ? e.message : e));
  }
  try {
    if (!resp.ok) {
      if (runState && runState.cancelRequested) throw makeGptTaskCancelledError();
      var detail = "";
      try {
        var j = JSON.parse(await resp.text());
        detail = j.message || j.error || JSON.stringify(j);
      } catch (_) {
        detail = "HTTP " + resp.status;
      }
      throw new Error("GPT Image 生成失败:" + detail);
    }
    if (runState && localValidation) {
      runState.localValidationInfo = resp.headers.get("X-ComfyPS-Local-Validation") || "";
    }
    throwIfGptTaskCancelled(runState);
    return await resp.arrayBuffer();
  } catch (e) {
    if ((runState && runState.cancelRequested) || (e && e.name === "AbortError")) {
      throw makeGptTaskCancelledError();
    }
    throw e;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

async function onStopGptClick() {
  var runState = _activeRuns.gptImage;
  if (!runState || runState.cancelRequested) return;

  runState.cancelRequested = true;
  refreshRunButton();
  setStatus("正在停止 GPT Image 任务…", "");

  var cancelRequest = null;
  if (runState.bridgeRequestStarted && runState.taskId) {
    var url = loadSettings().bridgeUrl.replace(/\/+$/, "") + "/gpt-image/cancel";
    try {
      cancelRequest = fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: runState.taskId })
      });
    } catch (e) {
      console.warn("无法发送 GPT Image 停止请求", e);
    }
  }

  if (runState.abortController) {
    try { runState.abortController.abort(); } catch (_) {}
  }

  if (cancelRequest) {
    try {
      var response = await cancelRequest;
      if (!response.ok && response.status !== 404) {
        console.warn("GPT Image 停止请求未成功", response.status);
      }
    } catch (e) {
      console.warn("GPT Image 停止请求失败", e);
    }
  }
}

// =========================================================================
// 把结果贴成新图层
// =========================================================================
var _resultFileSequence = 0;
var _placeImageQueue = Promise.resolve();

async function removeSelectionSnapshotChannel(channelName) {
  if (!channelName) return;
  try {
    await executeAsModal(
      async function () {
        await batchPlay([{
          _obj: "delete",
          _target: [{ _ref: "channel", _name: channelName }],
          _options: { dialogOptions: "silent" },
        }], {});
      },
      { commandName: "清理 GPT Image 选区快照" }
    );
  } catch (_) {}
}

// =========================================================================
// 工作队列: 文件保存
// =========================================================================
function _sanitizeDocName(psDocName) {
  return (psDocName || "").replace(/[\/\\:\*\?"<>\|]/g, "_") || "untitled";
}

// 解析缓存根目录(自定义路径或插件数据目录)。
async function _getCacheBaseFolder() {
  var storedCacheMode = localStorage.getItem(SETTINGS_KEYS.cacheMode);
  var cacheMode = storedCacheMode
    || (localStorage.getItem("comfyps.cacheBasePath") ? "custom" : "default");
  var token = cacheMode === "custom" ? localStorage.getItem("comfyps.cacheBasePath") : "";
  if (token) {
    try {
      return await localFileSystem.getEntryForPersistentToken(token);
    } catch (_) {
      return await localFileSystem.getDataFolder();
    }
  }
  return await localFileSystem.getDataFolder();
}

// 在父目录里按名查已有子目录，找不到返回 null(不新建)。
async function _findChildFolder(parent, name) {
  if (!parent || typeof parent.getEntries !== "function") return null;
  var entries = await parent.getEntries();
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].name === name && entries[i].isFolder) return entries[i];
  }
  return null;
}

async function _getOrCreateCacheFolder(psDocName, taskId) {
  var base = await _getCacheBaseFolder();
  var safeName = _sanitizeDocName(psDocName);
  var docFolder;
  try {
    docFolder = await base.createEntry(safeName, { type: require("uxp").storage.types.folder, overwrite: false });
  } catch (_) {
    var entries = await base.getEntries();
    docFolder = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === safeName) { docFolder = entries[i]; break; }
    }
    if (!docFolder) throw new Error("无法创建缓存目录: " + safeName);
  }
  var taskFolder;
  try {
    taskFolder = await docFolder.createEntry(taskId, { type: require("uxp").storage.types.folder, overwrite: false });
  } catch (_) {
    var tEntries = await docFolder.getEntries();
    taskFolder = null;
    for (var j = 0; j < tEntries.length; j++) {
      if (tEntries[j].name === taskId) { taskFolder = tEntries[j]; break; }
    }
    if (!taskFolder) throw new Error("无法创建任务目录: " + taskId);
  }
  return taskFolder;
}

async function saveTaskResult(resultBuffer, maskB64, taskId, psDocName) {
  var resultFile = null;
  var maskFile = null;
  var thumbUrl = "";
  var savedOk = false;
  try {
    var folder = await _getOrCreateCacheFolder(psDocName, taskId);
    resultFile = await folder.createEntry("result.png", { type: require("uxp").storage.types.file, overwrite: true });
    await resultFile.write(new Uint8Array(resultBuffer), { format: formats.binary });
    if (maskB64) {
      var maskBytes = base64ToBytes(maskB64);
      maskFile = await folder.createEntry("mask.png", { type: require("uxp").storage.types.file, overwrite: true });
      await maskFile.write(maskBytes, { format: formats.binary });
    }
    var blob = new Blob([new Uint8Array(resultBuffer)], { type: "image/png" });
    thumbUrl = URL.createObjectURL(blob);
    savedOk = true;
  } catch (e) {
    console.error("ComfyPS: 保存任务结果失败", e);
    try {
      var blob2 = new Blob([new Uint8Array(resultBuffer)], { type: "image/png" });
      thumbUrl = URL.createObjectURL(blob2);
    } catch (_) {}
  }
  return { resultFile: resultFile, maskFile: maskFile, thumbUrl: thumbUrl, savedOk: savedOk };
}

// =========================================================================
// 工作队列: 历史任务持久化 (按 PS 文件名 / taskId 存 meta.json，重启后可重建)
// =========================================================================
function getActiveDocName() {
  try {
    return (app.activeDocument && (app.activeDocument.name || "untitled")) || "";
  } catch (_) { return ""; }
}

function _utf8Format() {
  // 真实 UXP: formats.utf8; dev mock 里补了同名字段。
  return (formats && formats.utf8) ? formats.utf8 : "utf8";
}

// 写入任务元数据，供下次打开队列页重建历史(仅对已保存结果的完成任务有意义)。
async function writeTaskMeta(task, psDocName) {
  if (!task || !task.id) return;
  try {
    var folder = await _getOrCreateCacheFolder(psDocName, task.id);
    var meta = {
      id: task.id,
      wfName: task.wfName || "",
      wfId: task.wfId || "",
      layerName: task.layerName || "",
      status: task.status || "completed",
      createdAt: task.createdAt || Date.now(),
      completedAt: task.completedAt || Date.now(),
      durationMs: (typeof task.durationMs === "number") ? task.durationMs : null,
      hasMask: !!task.hasMask,
      savedOk: !!task.savedOk,
      placement: task.placement || null,
      psDocName: psDocName || ""
    };
    var f = await folder.createEntry("meta.json", {
      type: require("uxp").storage.types.file, overwrite: true
    });
    await f.write(JSON.stringify(meta), { format: _utf8Format() });
  } catch (e) {
    console.warn("ComfyPS: 写入任务元数据失败", e);
  }
}

// 扫描某个 PS 文档的缓存目录，重建其历史任务(有 result.png 才算可重导入)。
async function scanDocHistory(psDocName) {
  if (!psDocName) return [];
  var items = [];
  try {
    var base = await _getCacheBaseFolder();
    var docFolder = await _findChildFolder(base, _sanitizeDocName(psDocName));
    if (!docFolder || typeof docFolder.getEntries !== "function") return [];
    var taskFolders = await docFolder.getEntries();
    for (var i = 0; i < taskFolders.length; i++) {
      var tf = taskFolders[i];
      if (!tf || !tf.isFolder || typeof tf.getEntries !== "function") continue;
      var item = await _historyItemFromFolder(tf, psDocName);
      if (item) items.push(item);
    }
  } catch (e) {
    console.warn("ComfyPS: 扫描历史任务失败", e);
    return [];
  }
  items.sort(function (a, b) {
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });
  return items;
}

async function _historyItemFromFolder(taskFolder, psDocName) {
  var entries = await taskFolder.getEntries();
  var resultFile = null, maskFile = null, metaFile = null;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || e.isFolder) continue;
    if (e.name === "result.png") resultFile = e;
    else if (e.name === "mask.png") maskFile = e;
    else if (e.name === "meta.json") metaFile = e;
  }
  if (!resultFile) return null; // 没有结果图不可重导入，跳过
  var meta = {};
  if (metaFile) {
    try { meta = JSON.parse(await metaFile.read({ format: _utf8Format() })) || {}; }
    catch (_) { meta = {}; }
  }
  return {
    id: meta.id || taskFolder.name,
    wfName: meta.wfName || "历史任务",
    wfId: meta.wfId || "",
    layerName: meta.layerName || ("ComfyPS - " + (meta.wfName || "历史任务")),
    status: "completed",
    runState: null,
    resultFile: resultFile,
    maskFile: maskFile,
    hasMask: (typeof meta.hasMask === "boolean") ? meta.hasMask : !!maskFile,
    // 跨会话后选区快照通道已丢失：历史导入只按 placement 贴回，不再恢复选区蒙版。
    revealSelection: false,
    selectionSnapshotChannel: "",
    placement: meta.placement || null,
    thumbUrl: "",           // 缩略图在渲染时按需从 result.png 懒加载
    savedOk: true,
    percent: 100,
    progressMsg: "",
    createdAt: Number(meta.createdAt) || 0,
    completedAt: Number(meta.completedAt) || 0,
    durationMs: (typeof meta.durationMs === "number") ? meta.durationMs : null,
    psDocName: psDocName,
    fromHistory: true
  };
}

async function deleteTaskFolderFromDisk(psDocName, taskId) {
  try {
    var base = await _getCacheBaseFolder();
    var docFolder = await _findChildFolder(base, _sanitizeDocName(psDocName));
    if (!docFolder) return;
    var tf = await _findChildFolder(docFolder, taskId);
    if (tf && typeof tf.delete === "function") await tf.delete();
  } catch (e) {
    console.warn("ComfyPS: 删除历史任务目录失败", e);
  }
}

// =========================================================================
// 工作队列: UI 渲染与操作
// =========================================================================
var _sessionTasks = [];          // 本会话创建的所有任务(跨文档)，按 psDocName 标记
var _historyQueue = [];          // 当前查看文档的磁盘历史任务
var _queueViewDocName = "";      // 队列页当前展示的 PS 文档名

// 用会话任务(当前文档) + 磁盘历史(去重) 重建 _workQueue 视图。
function rebuildWorkQueueView(selectedId) {
  var docName = _queueViewDocName;
  var seen = {};
  var list = [];
  for (var i = 0; i < _sessionTasks.length; i++) {
    var t = _sessionTasks[i];
    if (t && t.psDocName === docName) { list.push(t); seen[t.id] = true; }
  }
  for (var h = 0; h < _historyQueue.length; h++) {
    var hi = _historyQueue[h];
    if (hi && !seen[hi.id]) { list.push(hi); seen[hi.id] = true; }
  }
  _workQueue = list;
  sortWorkQueue(selectedId);
}

// 打开队列页时：扫描当前文档历史并重建视图。
async function loadQueueHistoryForActiveDoc() {
  var docName = getActiveDocName();
  _queueViewDocName = docName;
  updateQueueDocHeader(docName);
  var prevSelectedId = (_selectedQueueIdx >= 0 && _selectedQueueIdx < _workQueue.length)
    ? _workQueue[_selectedQueueIdx].id : "";
  try {
    _historyQueue = await scanDocHistory(docName);
  } catch (_) {
    _historyQueue = [];
  }
  rebuildWorkQueueView(prevSelectedId);
  renderWorkQueue();
}

function updateQueueDocHeader(docName) {
  var el = $("queueDocName");
  if (el) el.textContent = docName || "未打开文档";
}

function renderQueueProgress() {
  var fill = $("queueProgressFill");
  var msg = $("queueProgressMsg");
  var bar = $("queueProgressBar");
  if (!bar) return;

  var hasSelection = (_selectedQueueIdx >= 0 && _selectedQueueIdx < _workQueue.length);
  var task = hasSelection ? _workQueue[_selectedQueueIdx] : null;

  if (task && task.status === "running") {
    bar.style.display = "block";
    if (fill) fill.style.width = (task.percent || 0) + "%";
    if (msg) msg.textContent = task.progressMsg || "正在提交任务…";
  } else {
    bar.style.display = "none";
  }
}

function renderQueueTabBadge() {
  var badge = $("queueTabBadge");
  if (!badge) return;
  if (_workQueue.length > 0) {
    badge.textContent = String(_workQueue.length);
    badge.style.display = "inline-block";
  } else {
    badge.textContent = "";
    badge.style.display = "none";
  }
}

function sortWorkQueue(selectedTaskId) {
  var selectedId = selectedTaskId || "";
  if (!selectedId && _selectedQueueIdx >= 0 && _selectedQueueIdx < _workQueue.length) {
    selectedId = _workQueue[_selectedQueueIdx].id;
  }
  _workQueue.sort(function (a, b) {
    var aCreatedAt = Number(a && a.createdAt) || 0;
    var bCreatedAt = Number(b && b.createdAt) || 0;
    return bCreatedAt - aCreatedAt;
  });
  _selectedQueueIdx = -1;
  for (var i = 0; i < _workQueue.length; i++) {
    if (selectedId && _workQueue[i].id === selectedId) {
      _selectedQueueIdx = i;
      break;
    }
  }
  if (_selectedQueueIdx === -1 && _workQueue.length > 0) _selectedQueueIdx = 0;
}

function updateQueueControls() {
  var importBtn = $("queueImportBtn");
  var stopBtn = $("queueStopBtn");
  var deleteBtn = $("queueDeleteBtn");
  var section = $("workQueueSection");
  var emptyState = $("queueEmptyState");
  var hasSelection = (_selectedQueueIdx >= 0 && _selectedQueueIdx < _workQueue.length);
  var selectedTask = hasSelection ? _workQueue[_selectedQueueIdx] : null;
  var isCompleted = selectedTask && selectedTask.status === "completed";
  var isRunning = selectedTask && selectedTask.status === "running";

  if (importBtn) importBtn.disabled = !(isCompleted && selectedTask.resultFile);
  if (stopBtn) stopBtn.disabled = !isRunning;
  if (deleteBtn) deleteBtn.disabled = !(hasSelection && !isRunning);
  if (section) section.style.display = _workQueue.length > 0 ? "block" : "none";
  if (emptyState) emptyState.style.display = _workQueue.length > 0 ? "none" : "block";
  renderQueueProgress();
}

function selectWorkQueueTask(index) {
  if (index < 0 || index >= _workQueue.length) return;
  if (_selectedQueueIdx !== index) {
    _selectedQueueIdx = index;
    var cards = document.querySelectorAll("#workQueueCards .queue-card");
    for (var i = 0; i < cards.length; i++) {
      if (i === index) cards[i].classList.add("selected");
      else cards[i].classList.remove("selected");
    }
  }
  updateQueueControls();
}

function _queuePadTime(value) {
  return value < 10 ? "0" + value : String(value);
}

function formatQueueCreatedAt(timestamp) {
  if (!timestamp || !isFinite(timestamp)) return "创建时间 --";
  var date = new Date(timestamp);
  if (isNaN(date.getTime())) return "创建时间 --";
  return "创建时间 " + _queuePadTime(date.getMonth() + 1) + "-"
    + _queuePadTime(date.getDate()) + " "
    + _queuePadTime(date.getHours()) + ":" + _queuePadTime(date.getMinutes());
}

function formatQueueDuration(durationMs) {
  if (!isFinite(durationMs) || durationMs < 0) return "";
  var seconds = durationMs / 1000;
  if (seconds < 60) {
    var shortSeconds = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
    return "完成耗时 " + shortSeconds + " 秒";
  }
  var totalSeconds = Math.round(seconds);
  var minutes = Math.floor(totalSeconds / 60);
  var remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return "完成耗时 " + minutes + " 分 " + remainingSeconds + " 秒";
  }
  var hours = Math.floor(minutes / 60);
  var remainingMinutes = minutes % 60;
  return "完成耗时 " + hours + " 小时 " + remainingMinutes + " 分";
}

function seedDevWorkQueue() {
  if (!IS_DEV || _sessionTasks.length > 0) return;
  var demoThumb = "/demo-image.png";
  var demoNow = Date.now();
  var demoDoc = getActiveDocName() || "demo-document.psd";
  _sessionTasks = [
    {
      id: "demo-running",
      wfName: "局部编辑",
      wfId: "inpaint",
      layerName: "ComfyPS - 局部编辑",
      status: "running",
      runState: null,
      resultFile: null,
      maskFile: null,
      hasMask: false,
      revealSelection: false,
      selectionSnapshotChannel: "",
      placement: null,
      thumbUrl: demoThumb,
      savedOk: false,
      percent: 65,
      progressMsg: "正在生成结果…",
      createdAt: demoNow - 38000,
      psDocName: demoDoc
    },
    {
      id: "demo-completed",
      wfName: "背景去杂物",
      wfId: "cleanup",
      layerName: "ComfyPS - 背景去杂物",
      status: "completed",
      runState: null,
      resultFile: null,
      maskFile: null,
      hasMask: false,
      revealSelection: false,
      selectionSnapshotChannel: "",
      placement: null,
      thumbUrl: demoThumb,
      savedOk: true,
      percent: 100,
      progressMsg: "处理完成",
      createdAt: demoNow - 12400,
      durationMs: 8400,
      psDocName: demoDoc
    },
    {
      id: "demo-failed",
      wfName: "面部重绘",
      wfId: "face",
      layerName: "ComfyPS - 面部重绘",
      status: "failed",
      runState: null,
      resultFile: null,
      maskFile: null,
      hasMask: false,
      revealSelection: false,
      selectionSnapshotChannel: "",
      placement: null,
      thumbUrl: demoThumb,
      savedOk: false,
      percent: 0,
      progressMsg: "演示任务失败",
      createdAt: demoNow - 76000,
      psDocName: demoDoc
    }
  ];
  _queueViewDocName = demoDoc;
  rebuildWorkQueueView("demo-completed");
  renderQueueTabBadge();
}

async function _loadThumbFromResult(task, img) {
  if (!task || !task.resultFile) return;
  try {
    var bytes = await task.resultFile.read({ format: formats.binary });
    if (!bytes || !bytes.byteLength) return;
    var blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    var url = URL.createObjectURL(blob);
    task.thumbUrl = url;
    if (img) img.src = url;
    updateQueueControls(); // 缩略图就绪后“预览”按钮可用性可能变化
  } catch (_) {}
}

function renderWorkQueue() {
  var container = $("workQueueCards");
  renderQueueTabBadge();
  if (!container) return;

  container.innerHTML = "";
  for (var i = 0; i < _workQueue.length; i++) {
    (function (task, idx) {
      var card = document.createElement("div");
      card.className = "queue-card" + (idx === _selectedQueueIdx ? " selected" : "");
      card.dataset.taskId = task.id;
      if (task.status === "failed" || task.status === "cancelled") card.className += " queue-card-error";

      if (task.status === "running") {
        var spinnerWrap = document.createElement("div");
        spinnerWrap.className = "queue-thumb-running";
        var sp = document.createElement("span");
        sp.className = "spinner";
        spinnerWrap.appendChild(sp);
        card.appendChild(spinnerWrap);
      } else {
        var img = document.createElement("img");
        img.className = "queue-thumb";
        img.alt = task.wfName;
        img.title = "点击预览";
        img.style.cursor = "pointer";
        if (task.thumbUrl) {
          img.src = task.thumbUrl;
        } else if (task.resultFile) {
          // 历史任务：缩略图按需从 result.png 懒加载，避免打开队列页时一次性读全部结果。
          _loadThumbFromResult(task, img);
        }
        // 点击缩略图：选中并直接打开预览。
        (function (t, index) {
          img.addEventListener("click", function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            selectWorkQueueTask(index);
            openQueuePreview(t);
          });
        })(task, idx);
        card.appendChild(img);
      }

      var cardBody = document.createElement("div");
      cardBody.className = "queue-card-body";

      var label = document.createElement("div");
      label.className = "queue-card-label";
      label.textContent = task.wfName;
      cardBody.appendChild(label);

      var meta = document.createElement("div");
      meta.className = "queue-card-meta";
      var createdAt = document.createElement("span");
      createdAt.textContent = formatQueueCreatedAt(task.createdAt);
      meta.appendChild(createdAt);
      if (task.status === "completed"
        && task.durationMs !== null
        && typeof task.durationMs !== "undefined"
        && isFinite(task.durationMs)) {
        var duration = document.createElement("span");
        duration.textContent = formatQueueDuration(task.durationMs);
        meta.appendChild(duration);
      }
      cardBody.appendChild(meta);

      var badge = document.createElement("div");
      badge.className = "queue-card-status-badge";
      if (task.status === "running") {
        badge.className += " running";
        badge.textContent = "运行中" + (task.percent ? " · " + task.percent + "%" : "");
        var cardProgress = document.createElement("div");
        cardProgress.className = "queue-card-progress";
        var cardProgressFill = document.createElement("div");
        cardProgressFill.style.width = (task.percent || 0) + "%";
        cardProgress.appendChild(cardProgressFill);
        cardBody.appendChild(badge);
        cardBody.appendChild(cardProgress);
      } else if (task.status === "failed") {
        badge.className += " failed";
        badge.textContent = "失败";
        cardBody.appendChild(badge);
      } else if (task.status === "cancelled") {
        badge.className += " cancelled";
        badge.textContent = "已停止";
        cardBody.appendChild(badge);
      } else if (!task.savedOk && task.status === "completed") {
        badge.className += " failed";
        badge.textContent = "保存失败";
        cardBody.appendChild(badge);
      } else {
        badge.className += " completed";
        badge.textContent = "已完成";
        cardBody.appendChild(badge);
      }
      card.appendChild(cardBody);

      card.addEventListener("click", function () {
        selectWorkQueueTask(idx);
      });
      container.appendChild(card);
    })(_workQueue[i], i);
  }
  updateQueueControls();
}

async function onQueueImportClick() {
  if (_selectedQueueIdx < 0 || _selectedQueueIdx >= _workQueue.length) return;
  var task = _workQueue[_selectedQueueIdx];
  if (task.status !== "completed") return;
  if (!task.resultFile) {
    setStatus("该任务结果文件未保存，无法导入", "err");
    return;
  }
  if (!app.activeDocument) {
    setStatus("请先打开一个 Photoshop 文档再导入", "err");
    return;
  }
  var importBtn = $("queueImportBtn");
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = "导入中…"; }
  try {
    var resultBytes = await task.resultFile.read({ format: formats.binary });
    if (!resultBytes || !resultBytes.byteLength) throw new Error("结果文件为空");
    await placeImageBytesAsLayer(
      resultBytes, task.layerName, task.placement, task.revealSelection, task.selectionSnapshotChannel
    );
    task.selectionSnapshotChannel = "";
    task.revealSelection = false;
    setStatus("已导入: " + task.layerName + " ✓", "ok");
  } catch (e) {
    setStatus("导入失败: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    if (importBtn) { importBtn.disabled = false; importBtn.textContent = "导入"; }
    renderWorkQueue();
  }
}

// 点击任务缩略图直接预览。历史任务缩略图可能尚未懒加载，这里补读一次。
async function openQueuePreview(task) {
  if (!task || task.status === "running") return;
  if (!task.thumbUrl && task.resultFile) {
    await _loadThumbFromResult(task, null);
  }
  if (!task.thumbUrl) { setStatus("没有可预览的图像", "err"); return; }
  var modal = $("queuePreviewModal");
  var modalImg = $("queuePreviewImg");
  if (!modal || !modalImg) return;
  modalImg.src = task.thumbUrl;
  modal.style.display = "flex";
  // UXP: native <select> renders above fixed overlays regardless of z-index
  var selects = document.querySelectorAll("select");
  for (var i = 0; i < selects.length; i++) selects[i].style.visibility = "hidden";
}

function onQueuePreviewClose() {
  var modal = $("queuePreviewModal");
  if (modal) modal.style.display = "none";
  var selects = document.querySelectorAll("select");
  for (var i = 0; i < selects.length; i++) selects[i].style.visibility = "";
}

function onQueueStopClick() {
  if (_selectedQueueIdx < 0 || _selectedQueueIdx >= _workQueue.length) return;
  var task = _workQueue[_selectedQueueIdx];
  if (!task || task.status !== "running" || !task.runState) return;
  var rs = task.runState;
  rs.cancelRequested = true;
  if (rs.abortController) {
    // GPT Image 任务：通过 AbortController 中断 fetch
    try { rs.abortController.abort(); } catch (_) {}
  } else if (rs.taskId) {
    // RunningHub 任务：通知 bridge 调用 RunningHub cancel API
    var cancelUrl = loadSettings().bridgeUrl.replace(/\/+$/, "") + "/cancel";
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", cancelUrl, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({taskId: rs.taskId}));
    } catch (_) {}
  }
  setStatus("正在停止任务…", "");
  renderWorkQueue();
}

function onQueueDeleteClick() {
  if (_selectedQueueIdx < 0 || _selectedQueueIdx >= _workQueue.length) return;
  var task = _workQueue[_selectedQueueIdx];
  if (!task || task.status === "running") return;
  // 已保存结果的任务(含历史)删除时一并清掉磁盘目录，避免下次扫描又出现。
  var hasDisk = !!(task.resultFile || task.fromHistory);
  if (hasDisk && typeof confirm === "function"
    && !confirm("删除该任务及其磁盘缓存结果？此操作不可恢复。")) {
    return;
  }
  if (task.thumbUrl) { try { URL.revokeObjectURL(task.thumbUrl); } catch (_) {} }

  // 从会话主表与历史缓存中移除
  for (var s = _sessionTasks.length - 1; s >= 0; s--) {
    if (_sessionTasks[s] && _sessionTasks[s].id === task.id) _sessionTasks.splice(s, 1);
  }
  for (var h = _historyQueue.length - 1; h >= 0; h--) {
    if (_historyQueue[h] && _historyQueue[h].id === task.id) _historyQueue.splice(h, 1);
  }
  if (hasDisk) {
    deleteTaskFolderFromDisk(task.psDocName || _queueViewDocName, task.id);
  }

  _workQueue.splice(_selectedQueueIdx, 1);
  if (_workQueue.length === 0) {
    _selectedQueueIdx = -1;
  } else {
    _selectedQueueIdx = Math.min(_selectedQueueIdx, _workQueue.length - 1);
  }
  renderWorkQueue();
}

// =========================================================================
// 工作队列: 缓存路径设置
// =========================================================================
async function browseCachePath() {
  var btn = $("btnBrowseCachePath");
  var display = $("cachePathDisplay");
  if (btn) { btn.disabled = true; btn.textContent = "选择中…"; }
  try {
    var folder = await localFileSystem.getFolder();
    if (!folder) return;
    var token = localFileSystem.createPersistentToken(folder);
    localStorage.setItem("comfyps.cacheBasePath", token);
    saveSetting("cacheMode", "custom");
    _segSelect("segCachePath", "custom");
    _applyCachePathVisibility();
    await _refreshCachePathDisplay();
  } catch (e) {
    console.error("ComfyPS: 选择缓存路径失败", e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "选择文件夹"; }
  }
}

function _getCacheEntryNativePath(entry) {
  if (!entry) return "";
  try {
    if (entry.nativePath) return entry.nativePath;
  } catch (_) {}
  try {
    if (localFileSystem && typeof localFileSystem.getNativePath === "function") {
      return localFileSystem.getNativePath(entry) || "";
    }
  } catch (_) {}
  return "";
}

async function _refreshCachePathDisplay() {
  var mode = _segGet("segCachePath") || loadSettings().cacheMode || "default";
  var defaultDisplay = $("defaultCachePathDisplay");
  var customDisplay = $("cachePathDisplay");
  if (mode === "custom") {
    if (customDisplay) customDisplay.textContent = "读取自定义路径…";
  } else if (defaultDisplay) {
    defaultDisplay.textContent = "读取插件数据目录…";
  }

  try {
    var entry;
    if (mode === "custom") {
      var token = localStorage.getItem("comfyps.cacheBasePath");
      if (!token) {
        if (customDisplay) customDisplay.textContent = "尚未选择自定义文件夹";
        return;
      }
      try {
        entry = await localFileSystem.getEntryForPersistentToken(token);
      } catch (e) {
        if (customDisplay) customDisplay.textContent = "自定义路径不可用，请重新选择文件夹";
        console.warn("ComfyPS: 自定义缓存路径已失效", e);
        return;
      }
    } else {
      entry = await localFileSystem.getDataFolder();
    }

    var nativePath = _getCacheEntryNativePath(entry);
    if (mode === "custom") {
      if (customDisplay) customDisplay.textContent = nativePath
        ? "路径：" + nativePath
        : "已设置自定义路径（无法读取绝对路径）";
    } else if (defaultDisplay) {
      defaultDisplay.textContent = nativePath
        ? "路径：" + nativePath
        : "插件数据目录（无法读取绝对路径）";
    }
  } catch (e) {
    if (mode === "custom") {
      if (customDisplay) customDisplay.textContent = "无法读取自定义路径，请重新选择文件夹";
    } else if (defaultDisplay) {
      defaultDisplay.textContent = "无法读取插件数据目录";
    }
    console.warn("ComfyPS: 读取缓存路径失败", e);
  }
}

async function _alignPlacedLayerToPosition(layer, targetLeft, targetTop) {
  if (!layer || !layer.bounds || !isFinite(targetLeft) || !isFinite(targetTop)) return;
  // placeEvent 的默认中心放置在缩放后可能留下非零的左/上偏移，因此
  // 必须用实际边界重新对齐到目标文档坐标。GPT 编辑的目标坐标是选区
  // 外接矩形左上角；整画布工作流的目标坐标则是 (0, 0)。
  var bounds = layer.boundsNoEffects || layer.bounds;
  var left = _asPixels(bounds && bounds.left);
  var top = _asPixels(bounds && bounds.top);
  var dx = targetLeft - left;
  var dy = targetTop - top;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

  if (typeof layer.translate === "function") {
    await layer.translate(dx, dy);
    return;
  }

  // Photoshop 23+ 提供 Layer.translate；保留 Action Manager 回退，便于
  // 旧版宿主或开发模拟器继续运行。
  await batchPlay([{
    _obj: "move",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "offset",
      horizontal: { _unit: "pixelsUnit", _value: dx },
      vertical: { _unit: "pixelsUnit", _value: dy },
    },
    _options: { dialogOptions: "silent" },
  }], {});
}

function placeImageBytesAsLayer(arrayBuffer, layerName, placement, revealSelection, selectionChannelName) {
  var queuedPlacement = _placeImageQueue.then(function () {
    return _placeImageBytesAsLayer(arrayBuffer, layerName, placement, revealSelection, selectionChannelName);
  });
  _placeImageQueue = queuedPlacement.catch(function () {});
  return queuedPlacement;
}

async function _placeImageBytesAsLayer(arrayBuffer, layerName, placement, revealSelection, selectionChannelName) {
  var folder = await localFileSystem.getDataFolder();
  _resultFileSequence++;
  var file = await folder.createFile(
    "comfyps_result_" + Date.now() + "_" + _resultFileSequence + ".png",
    { overwrite: true }
  );
  // UXP may treat a bare ArrayBuffer as text unless the binary format is
  // explicit. Local validation passes the cropped input as Base64, while
  // bridge results are binary buffers, so normalize both forms before writing.
  var resultBytes;
  if (typeof arrayBuffer === "string") {
    resultBytes = base64ToBytes(arrayBuffer);
  } else if (arrayBuffer instanceof Uint8Array) {
    resultBytes = arrayBuffer;
  } else {
    resultBytes = new Uint8Array(arrayBuffer);
  }
  if (!resultBytes || resultBytes.length < 8 ||
      resultBytes[0] !== 0x89 || resultBytes[1] !== 0x50 ||
      resultBytes[2] !== 0x4e || resultBytes[3] !== 0x47 ||
      resultBytes[4] !== 0x0d || resultBytes[5] !== 0x0a ||
      resultBytes[6] !== 0x1a || resultBytes[7] !== 0x0a) {
    throw new Error("待贴回图像不是有效 PNG");
  }
  await file.write(resultBytes, { format: formats.binary });
  var token = await localFileSystem.createSessionToken(file);
  var offsetX = 0;
  var offsetY = 0;
  if (placement) {
    var doc = app.activeDocument;
    var docWidth = _asPixels(doc && doc.width);
    var docHeight = _asPixels(doc && doc.height);
    // placeEvent 的偏移量以画布中心为基准。选区裁剪输入与输出均按其中心贴回。
    offsetX = placement.left + placement.width / 2 - docWidth / 2;
    offsetY = placement.top + placement.height / 2 - docHeight / 2;
  }

  await executeAsModal(
    async function () {
      var commands = [
        {
          _obj: "placeEvent",
          // `null` is the Action Manager file target for placeEvent. Include
          // the center state explicitly so offset semantics are deterministic.
          "null": { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: offsetX },
            vertical: { _unit: "pixelsUnit", _value: offsetY },
          },
          _options: { dialogOptions: "dontDisplay" },
        },
        {
          _obj: "set",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          to: { _obj: "layer", name: layerName },
          _options: { dialogOptions: "dontDisplay" },
        },
      ];
      await batchPlay(commands, {});
      if (revealSelection) {
        // GPT Image and RunningHub inpaint may return a different resolution,
        // so scale the result to its intended Photoshop canvas before applying
        // the selection mask. Cropped workflows provide placement; full-canvas
        // workflows continue to target the document dimensions.
        var targetDoc = app.activeDocument;
        var targetLayer = targetDoc && targetDoc.activeLayers && targetDoc.activeLayers[0];
        var targetWidth = _asPixels(targetDoc && targetDoc.width);
        var targetHeight = _asPixels(targetDoc && targetDoc.height);
        var targetLeft = 0;
        var targetTop = 0;
        if (placement) {
          targetWidth = _asPixels(placement.width);
          targetHeight = _asPixels(placement.height);
          targetLeft = _asPixels(placement.left);
          targetTop = _asPixels(placement.top);
        }
        var layerWidth = _asPixels(targetLayer && targetLayer.bounds && targetLayer.bounds.width);
        var layerHeight = _asPixels(targetLayer && targetLayer.bounds && targetLayer.bounds.height);
        if (targetWidth > 0 && targetHeight > 0 && layerWidth > 0 && layerHeight > 0) {
          var scaleX = targetWidth / layerWidth * 100;
          var scaleY = targetHeight / layerHeight * 100;
          var scale = Math.max(scaleX, scaleY);
          if (Math.abs(scale - 100) > 0.01) {
            await batchPlay([{
              _obj: "transform",
              freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
              width: { _unit: "percentUnit", _value: scale },
              height: { _unit: "percentUnit", _value: scale },
              _options: { dialogOptions: "dontDisplay" },
            }], {});
          }
        }
        // Re-read the bounds after the optional scale. The selection snapshot
        // is in document coordinates, so the output layer must share the same
        // document position before Photoshop creates its layer mask.
        targetLayer = targetDoc && targetDoc.activeLayers && targetDoc.activeLayers[0];
        await _alignPlacedLayerToPosition(targetLayer, targetLeft, targetTop);
        try {
          // Restore the selection captured at submission time. The user may
          // have changed the active selection while a long GPT task ran.
          if (selectionChannelName) {
            await batchPlay([{
              _obj: "set",
              _target: [{ _ref: "channel", _property: "selection" }],
              to: { _ref: "channel", _name: selectionChannelName },
              _options: { dialogOptions: "silent" },
            }], {});
          }
          await batchPlay([{
            _obj: "make",
            new: { _class: "channel" },
            at: { _ref: "channel", _enum: "channel", _value: "mask" },
            using: { _enum: "userMaskEnabled", _value: "revealSelection" },
            _options: { dialogOptions: "silent" },
          }], {});
        } finally {
          if (selectionChannelName) {
            await batchPlay([{
              _obj: "delete",
              _target: [{ _ref: "channel", _name: selectionChannelName }],
              _options: { dialogOptions: "silent" },
            }], {}).catch(function () {});
          }
        }
      }
    },
    { commandName: "贴回结果图层" }
  );
}

// =========================================================================
// 桥状态检测
// =========================================================================
var _bridgeOnline = false;
var _healthPollTimer = 0;
var _restarting = false;
var _launchingBridge = false;
var _bridgeBtnMode = "restart"; // "restart"=桥在线时重启; "start"=桥离线时启动
var _lastBridgeUiLog = "";

async function checkBridgeHealth() {
  var settings = loadSettings();
  var bridgeUrl = settings.bridgeUrl;
  if (!bridgeUrl) {
    _setBridgeBarUI("off", "未配置地址", false);
    _bridgeOnline = false;
    return;
  }

  _setBridgeBarUI("chk", "检测中…", false);
  try {
    var resp = await fetchWithTimeout(bridgeUrl.replace(/\/+$/, "") + "/health", null, 5000);
    if (resp.ok) {
      _setBridgeBarUI("on", "桥已连接", true);
      _bridgeOnline = true;
    } else {
      _setBridgeBarUI("off", "桥异常 (HTTP " + resp.status + ")", true);
      _bridgeOnline = false;
    }
  } catch (_) {
    _setBridgeBarUI("off", "桥未运行", true);
    _bridgeOnline = false;
  }
}

function _setBridgeBarUI(state, text, restartEnabled) {
  var dot = $("bridgeBarDot");
  var label = $("bridgeBarText");
  var btn = $("restartBtn");

  if (state !== "chk") {
    var bridgeLogKey = state + "|" + text;
    if (bridgeLogKey !== _lastBridgeUiLog) {
      addLogEntry(state === "off" ? "warn" : "info", "桥状态: " + text, "插件");
      _lastBridgeUiLog = bridgeLogKey;
    }
  }

  if (dot) dot.className = "bridge-bar-dot " + state;
  if (label) {
    label.textContent = text;
    label.className = "bridge-bar-text " + (state === "on" ? "on" : state === "off" ? "off" : "");
  }
  if (btn) {
    if (_restarting) {
      btn.disabled = true;
      btn.textContent = "重启中…";
    } else if (_launchingBridge) {
      btn.disabled = true;
      btn.textContent = "启动中…";
    } else if (state === "off") {
      // 桥离线时按钮变为“启动桥”(通过 shell.openPath 拉起启动脚本)。
      _bridgeBtnMode = "start";
      btn.disabled = !restartEnabled;
      btn.textContent = "▶ 启动桥";
    } else {
      _bridgeBtnMode = "restart";
      btn.disabled = !restartEnabled;
      btn.textContent = "⟳ 重启桥";
    }
  }
}

async function restartBridge() {
  if (_restarting) return;
  _restarting = true;
  var settings = loadSettings();
  var bridgeUrl = settings.bridgeUrl;
  if (!bridgeUrl) { _restarting = false; return; }

  _setBridgeBarUI("chk", "正在重启…", false);
  setStatus("正在重启本地桥…");

  try {
    var resp = await fetchWithTimeout(bridgeUrl.replace(/\/+$/, "") + "/restart", { method: "POST" }, 5000);
    if (resp.ok) {
      setStatus("桥重启指令已发送, 等待恢复…");
    }
  } catch (e) {
    setStatus("重启失败:" + (e && e.message ? e.message : String(e)), "err");
    _restarting = false;
    checkBridgeHealth();
    return;
  }

  var attempts = 0;
  while (attempts < 30) {
    await new Promise(function (r) { setTimeout(r, 500); });
    attempts++;
    try {
      var hr = await fetchWithTimeout(bridgeUrl.replace(/\/+$/, "") + "/health", null, 2000);
      if (hr.ok) {
        _restarting = false;
        setStatus("桥已恢复 ✓", "ok");
        checkBridgeHealth();
        return;
      }
    } catch (_) {}
  }
  _restarting = false;
  setStatus("桥重启后超时未恢复, 请手动检查", "err");
  checkBridgeHealth();
}

// UXP 沙箱无法 spawn 进程，但可用 shell.openPath 打开一个启动脚本(.command)，
// 由 macOS 运行它来拉起 Python 桥。首次会弹用户授权框，并可见地打开一个终端窗口。
async function _bridgeLauncherPath() {
  if (!localFileSystem || typeof localFileSystem.getPluginFolder !== "function") {
    throw new Error("当前宿主不支持定位插件目录");
  }
  var folder = await localFileSystem.getPluginFolder();
  var base = folder && folder.nativePath;
  if (!base) throw new Error("无法获取插件目录路径");
  var sep = base.charAt(base.length - 1) === "/" ? "" : "/";
  return base + sep + "start_bridge.command";
}

async function startBridgeViaShell() {
  if (_launchingBridge || _restarting) return;
  if (!uxpShell || typeof uxpShell.openPath !== "function") {
    setStatus("当前宿主不支持自动启动桥，请手动运行 bridge.py", "err");
    return;
  }
  _launchingBridge = true;
  _setBridgeBarUI("chk", "正在启动桥…", false);
  setStatus("正在启动本地桥…");

  var launcherPath;
  try {
    launcherPath = await _bridgeLauncherPath();
    var err = await uxpShell.openPath(
      launcherPath,
      "启动 ComfyPS 本地桥：将打开终端运行 Python 桥 (bridge.py)。"
    );
    if (err) throw new Error(err);
    addLogEntry("info", "已请求启动桥: " + launcherPath, "插件");
    setStatus("已请求启动桥，等待就绪…");
  } catch (e) {
    _launchingBridge = false;
    setStatus("启动桥失败: " + (e && e.message ? e.message : String(e)), "err");
    addLogEntry("error", "启动桥失败: " + (e && e.message ? e.message : e) +
      (launcherPath ? " (" + launcherPath + ")" : ""), "插件");
    checkBridgeHealth();
    return;
  }

  var settings = loadSettings();
  var bridgeUrl = settings.bridgeUrl ? settings.bridgeUrl.replace(/\/+$/, "") : "";
  var attempts = 0;
  while (attempts < 40) {
    await new Promise(function (r) { setTimeout(r, 500); });
    attempts++;
    if (bridgeUrl) {
      try {
        var hr = await fetchWithTimeout(bridgeUrl + "/health", null, 2000);
        if (hr.ok) {
          _launchingBridge = false;
          setStatus("桥已启动 ✓", "ok");
          checkBridgeHealth();
          return;
        }
      } catch (_) {}
    }
  }
  _launchingBridge = false;
  setStatus("桥启动后超时未就绪，请检查弹出的终端窗口是否有报错", "err");
  checkBridgeHealth();
}

function startHealthPolling() {
  checkBridgeHealth();
  _healthPollTimer = setInterval(checkBridgeHealth, 30000);
}

// =========================================================================
// 工作流网格
// =========================================================================
var _selectedWorkflowId = null;

function findWorkflow(id) {
  for (var i = 0; i < WORKFLOWS.length; i++) {
    if (WORKFLOWS[i].id === id) return WORKFLOWS[i];
  }
  return null;
}

function getWorkflowDescription(wf) {
  if (!wf) return "";
  if (wf.gptImage) {
    var gptSettings = loadSettings();
    var auth = gptSettings.gptImageAuth;
    var provider = auth === "api-key" ? "GPT API" : "本机 Codex";
    var debugText = gptSettings.gptImageLocalValidation
      ? " 当前已启用本地验证：不会调用桥或上传图片。" : "";
    return "使用 " + provider + " 的图像生成功能。可文生图，或裁切活动图层的选区外接矩形进行编辑。" + debugText;
  }
  return wf.description || "";
}

function renderWorkflowDescription(wf) {
  var descEl = $("workflowDesc");
  if (!descEl) return;
  var description = getWorkflowDescription(wf);
  descEl.textContent = description;
  descEl.style.display = description ? "block" : "none";
}

function renderWorkflowGrid() {
  var grid = $("workflowGrid");
  if (!grid) return;
  grid.innerHTML = "";
  WORKFLOWS.forEach(function (wf) {
    var card = document.createElement("div");
    card.className = "wf-card" + (wf.active ? "" : " disabled") + (_selectedWorkflowId === wf.id ? " selected" : "");
    card.dataset.wfId = wf.id;
    card.innerHTML =
      '<div class="wf-icon">' + wf.icon + '</div>' +
      '<div class="wf-name">' + wf.name + '</div>' +
      (wf.active ? "" : '<span class="wf-tag soon">即将推出</span>');

    if (wf.active) {
      card.addEventListener("click", function () { selectWorkflow(wf.id); });
    }
    grid.appendChild(card);
  });
}

function _appendGptLayerSelect(container, inputId, labelText, records) {
  var label = document.createElement("label");
  label.textContent = labelText;
  label.htmlFor = inputId;
  container.appendChild(label);

  var select = document.createElement("select");
  select.id = inputId;
  for (var li = 0; li < records.length; li++) {
    var option = document.createElement("option");
    option.value = records[li].id;
    option.textContent = records[li].path;
    select.appendChild(option);
  }
  container.appendChild(select);
}

function updateGptAspectRatioVisibility() {
  var modeSelect = $("gptImageMode");
  var ratioLabel = $("gptAspectRatioLabel");
  var ratioInput = $("gptAspectRatio");
  var isEdit = modeSelect && modeSelect.value === "edit";
  if (ratioLabel) ratioLabel.style.display = isEdit ? "none" : "";
  if (ratioInput) ratioInput.style.display = isEdit ? "none" : "";
}

function getSelectionAspectRatio(bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("选区范围无效");
  }
  return normalizeGptAspectRatio(bounds.width + ":" + bounds.height);
}

function renderGptEditReferenceInput(container) {
  var records;
  try {
    records = getDocumentLayerRecords();
  } catch (e) {
    var errorNote = document.createElement("div");
    errorNote.className = "input-note";
    errorNote.textContent = e && e.message ? e.message : "无法读取图层";
    container.appendChild(errorNote);
    return;
  }

  var toggleLabel = document.createElement("label");
  toggleLabel.className = "gpt-edit-reference-toggle";
  var toggle = document.createElement("input");
  toggle.id = "gptEditUseReference";
  toggle.type = "checkbox";
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode(" 添加参考图"));
  container.appendChild(toggleLabel);

  var referenceFields = document.createElement("div");
  referenceFields.id = "gptEditReferenceFields";
  container.appendChild(referenceFields);
  var renderReferenceFields = function () {
    referenceFields.innerHTML = "";
    if (!toggle.checked) return;
    _appendGptLayerSelect(referenceFields, "gptEditReferenceLayer", "参考图层", records);
  };
  toggle.addEventListener("change", renderReferenceFields);
  renderReferenceFields();
}

function renderGptImageLayerInputs() {
  var container = $("gptImageLayerInputs");
  var modeSelect = $("gptImageMode");
  if (!container || !modeSelect) return;
  updateGptAspectRatioVisibility();
  container.innerHTML = "";
  if (modeSelect.value === "edit") {
    var editHint = document.createElement("div");
    editHint.className = "input-note";
    editHint.textContent = "仅上传活动图层的选区外接矩形，画面比例自动跟随该矩形；返图会放回原选区位置。";
    container.appendChild(editHint);
    renderGptEditReferenceInput(container);
    return;
  }
}

function selectWorkflow(wfId) {
  _selectedWorkflowId = wfId;
  var wf = findWorkflow(wfId);
  if (!wf || !wf.active) return;

  // 更新卡片选中状态
  var cards = document.querySelectorAll(".wf-card");
  for (var ci = 0; ci < cards.length; ci++) {
    var isSel = cards[ci].dataset.wfId === wfId;
    if (isSel) cards[ci].classList.add("selected");
    else cards[ci].classList.remove("selected");
  }

  // 渲染输入控件
  var container = $("workflowInputs");
  var runBtn = $("runBtn");
  var runActions = $("runActions");
  if (!container || !runBtn || !runActions) return;

  container.innerHTML = "";

  // 使用说明 — 渲染在输入区外面 (workflow grid 下方)
  renderWorkflowDescription(wf);

  (wf.inputs || []).forEach(function (inp) {
    var label = document.createElement("label");
    label.textContent = inp.label;
    label.htmlFor = inp.id;
    if (inp.id === "gptAspectRatio") label.id = "gptAspectRatioLabel";
    container.appendChild(label);

    if (inp.type === "textarea") {
      var ta = document.createElement("textarea");
      ta.id = inp.id;
      ta.placeholder = inp.placeholder || "";
      ta.rows = 3;
      if (inp.default !== undefined) ta.value = inp.default;
      container.appendChild(ta);
    } else if (inp.type === "range") {
      var row = document.createElement("div");
      row.className = "range-row";
      var slider = document.createElement("input");
      slider.type = "range";
      slider.id = inp.id;
      slider.min = inp.min || 0;
      slider.max = inp.max || 1;
      slider.step = inp.step || 0.01;
      slider.value = inp.default || 0;
      var valDisplay = document.createElement("span");
      valDisplay.id = inp.id + "_val";
      valDisplay.className = "range-val";
      valDisplay.textContent = slider.value;
      var updatePct = function () {
        var pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
        slider.style.setProperty("--pct", pct + "%");
        valDisplay.textContent = slider.value;
      };
      slider.addEventListener("input", updatePct);
      updatePct();
      row.appendChild(slider);
      row.appendChild(valDisplay);
      container.appendChild(row);
    } else if (inp.type === "select") {
      var select = document.createElement("select");
      select.id = inp.id;
      var options = inp.options || [];
      for (var oi = 0; oi < options.length; oi++) {
        var option = document.createElement("option");
        option.value = options[oi].value;
        option.textContent = options[oi].label;
        select.appendChild(option);
      }
      if (inp.default !== undefined) select.value = inp.default;
      if (inp.id === "gptImageMode") {
        select.addEventListener("change", renderGptImageLayerInputs);
      }
      container.appendChild(select);
    } else {
      var ip = document.createElement("input");
      ip.id = inp.id;
      ip.type = inp.type;
      ip.placeholder = inp.placeholder || "";
      if (inp.default !== undefined) ip.value = inp.default;
      container.appendChild(ip);
    }
  });

  if (wf.gptImage) {
    var gptLayerInputs = document.createElement("div");
    gptLayerInputs.id = "gptImageLayerInputs";
    container.appendChild(gptLayerInputs);
    renderGptImageLayerInputs();
  }

  runActions.style.display = "flex";
  runBtn.style.display = "flex";
  refreshRunButton();
}

function getWorkflowInputs() {
  var wf = findWorkflow(_selectedWorkflowId);
  if (!wf || !wf.inputs) return {};
  var values = {};
  wf.inputs.forEach(function (inp) {
    var el = $(inp.id);
    values[inp.id] = el ? el.value : (inp.default || "");
  });
  var editUseReference = $("gptEditUseReference");
  if (editUseReference) values.gptEditUseReference = editUseReference.checked;
  var editReferenceLayer = $("gptEditReferenceLayer");
  if (editReferenceLayer) values.gptEditReferenceLayer = editReferenceLayer.value;
  return values;
}

// =========================================================================
// 运行
// =========================================================================
async function onRunClick() {
  var btn = $("runBtn");
  if (!btn) return;
  var settings = loadSettings();
  var wf = findWorkflow(_selectedWorkflowId);
  if (!wf) {
    setStatus("请先选择一个工作流", "err");
    return;
  }
  if (!app.activeDocument) {
    setStatus("没有打开的文档", "err");
    return;
  }
  var localValidationRequested = !!(wf.gptImage && settings.gptImageLocalValidation);
  var localValidationCanStart = localValidationRequested && !_activeRuns.gptImage && !_activeRuns.other;
  if (!localValidationCanStart && !canStartWorkflow(wf, settings)) {
    setStatus(wf.gptImage ? "GPT Image 正在生成中" : "已有 RunningHub 工作流正在运行", "err");
    refreshRunButton();
    return;
  }

  var runSlot = getRunSlot(wf, settings);
  var inputs = getWorkflowInputs();
  var prompt = inputs.wfPrompt || "";
  var gptMode = wf.gptImage ? (inputs.gptImageMode || "generate") : "";
  if (localValidationRequested && gptMode !== "edit") {
    setStatus("本地验证模式仅支持“图像编辑”", "err");
    return;
  }
  if (wf.gptImage && gptMode !== "edit") {
    inputs.gptAspectRatio = normalizeGptAspectRatio(inputs.gptAspectRatio);
  }
  var runState = {
    workflowId: wf.id,
    cancelRequested: false,
    taskId: wf.gptImage ? makeGptTaskId() : "",
    bridgeRequestStarted: false,
    localValidation: localValidationRequested,
    localValidationInfo: "",
    abortController: null
  };
  if (wf.gptImage && !runState.localValidation && typeof AbortController !== "undefined") {
    try { runState.abortController = new AbortController(); } catch (_) {}
  }
  registerActiveRun(runSlot, runState, settings);
  refreshRunButton();

  // 本地验证不创建队列项，也不发送任何网络请求；只在 Photoshop 内
  // 复制图层和创建蒙版。普通任务继续使用短暂的提交提示。
  if (runState.localValidation) {
    setStatus("正在进行本地验证…", "");
  } else {
    // 提交提示走短暂弹窗，自动消失，无需手动清理。
    setStatus("任务已提交 ✓", "ok");
  }

  // 立即入队（非本地验证模式）
  var queueItem = null;
  var qTaskId = "";
  var psDocName = "untitled";
  if (!runState.localValidation) {
    qTaskId = wf.gptImage
      ? runState.taskId
      : ("rh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6));
    if (!wf.gptImage) runState.taskId = qTaskId;
    try { psDocName = app.activeDocument ? (app.activeDocument.name || "untitled") : "untitled"; } catch (_) {}
    queueItem = {
      id: qTaskId,
      wfName: wf.name,
      wfId: wf.id,
      layerName: "",
      status: "running",
      createdAt: Date.now(),
      durationMs: null,
      runState: runState,
      runSlot: runSlot,
      resultFile: null,
      maskFile: null,
      hasMask: false,
      revealSelection: false,
      selectionSnapshotChannel: "",
      placement: null,
      thumbUrl: "",
      savedOk: false,
      percent: 0,
      progressMsg: "正在提交任务…",
      psDocName: psDocName || "untitled"
    };
    // 进度回调：更新队列项数据，并刷新进度条显示
    (function (item) {
      runState.onProgress = function (pct, msg) {
        item.percent = pct;
        item.progressMsg = msg;
        if (msg && msg !== item._lastLogProgress) {
          addLogEntry("info", "任务「" + item.wfName + "」: " + msg, "插件");
          item._lastLogProgress = msg;
        }
        renderQueueProgress();
      };
    })(queueItem);
    // 任务进入会话主表(跨文档)；仅当队列页正展示同一文档时才并入可见视图。
    _sessionTasks.unshift(queueItem);
    if (!_queueViewDocName) _queueViewDocName = queueItem.psDocName;
    if (queueItem.psDocName === _queueViewDocName) {
      _workQueue.unshift(queueItem);
      sortWorkQueue(queueItem.id);
    }
    renderWorkQueue();
  }

  try {
    var resultBuffer;
    var placement = null;
    var gptMaskB64 = "";
    var selectionSnapshotChannel = "";
    var revealSelection = false;
    if (wf.gptImage) {
      var mode = gptMode;
      var images = [];
      if (runState.localValidation) {
        if (mode !== "edit") {
          throw new Error("本地验证模式仅支持“图像编辑”；请切换到图像编辑模式后再运行");
        }
        var validationBounds = await runFastGptEditValidation("ComfyPSGPT - 本地验证 - 图像编辑");
        setStatus(
          "本地验证完成 ✓（已裁切并回贴图层、创建蒙版；外接矩形 " +
          validationBounds.width + "×" + validationBounds.height +
          "，位置 " + validationBounds.left + "," + validationBounds.top + "）",
          "ok"
        );
        return;
      }
      if (!prompt.trim() && !runState.localValidation) throw new Error("请输入关键词或编辑说明");

      if (mode === "edit") {
        // Send only the active layer's selection bounding rectangle. The mask
        // is cropped to the exact same rectangle below, which keeps the model
        // input small while preserving the original document coordinates for
        // placement when the result is imported.
        var editInput = await exportActiveLayerSelectionPNG();
        images.push(editInput.image);
        throwIfGptTaskCancelled(runState);
        // OpenAI /edits requires an alpha mask (transparent = editable),
        // while local Codex receives the mask as an ordinary reference image
        // and therefore needs an explicit black/white selection map.
        var maskExport = await exportSelectionMaskPNG(
          settings.gptImageAuth !== "codex", true, editInput.bounds
        );
        gptMaskB64 = maskExport.mask;
        selectionSnapshotChannel = maskExport.selectionChannelName;
        throwIfGptTaskCancelled(runState);
        placement = editInput.bounds;
        inputs.gptAspectRatio = getSelectionAspectRatio(editInput.bounds);
        revealSelection = true;
        if (inputs.gptEditUseReference) {
          if (!inputs.gptEditReferenceLayer) throw new Error("请选择编辑参考图层");
          images.push(await exportLayerPNG(inputs.gptEditReferenceLayer));
          throwIfGptTaskCancelled(runState);
        }
      }

      throwIfGptTaskCancelled(runState);

      resultBuffer = await callGptImage(
        settings.bridgeUrl,
        settings.gptImageAuth,
        settings.gptImageApiKey,
        mode,
        prompt,
        inputs.gptAspectRatio,
        inputs.gptResolution,
        images,
        gptMaskB64,
        runState,
        runState.localValidation
      );
    } else {
      var imageB64;
      var maskB64 = "";
      if (wf.needsMask && !settings.rhLocalDebug) {
        // 局部编辑只上传活动图层的选区外接矩形。蒙版使用同一矩形裁切，
        // 返图通过 placement 回贴到原文档坐标，避免上传整张画布。
        var runningHubInput = await exportActiveLayerSelectionPNG();
        imageB64 = runningHubInput.image;
        var runningHubMaskExport = await exportSelectionMaskPNG(
          false, true, runningHubInput.bounds
        );
        maskB64 = runningHubMaskExport.mask;
        selectionSnapshotChannel = runningHubMaskExport.selectionChannelName;
        placement = runningHubInput.bounds;
        revealSelection = true;
      } else {
        // 本地蒙版调试保留整画布导出，确保调试图层和原有行为不变。
        imageB64 = await exportActiveDocPNG();
        if (wf.needsMask) {
          var debugMaskExport = await exportSelectionMaskPNG(false, false);
          maskB64 = debugMaskExport.mask;
        }
      }
      if (settings.rhLocalDebug && wf.needsMask) {
        // 蒙版调试：直接把蒙版贴回，不发任何网络请求。
        // 不需要 revealSelection / selectionSnapshot，否则 placeImageBytesAsLayer
        // 会对全尺寸蒙版做缩放+对齐+选区裁剪，导致位置错乱。
        resultBuffer = base64ToBytes(maskB64).buffer;
        revealSelection = false;
        selectionSnapshotChannel = "";
      } else {
        resultBuffer = await callBridge(
          settings.bridgeUrl, imageB64, maskB64, prompt, settings, wf, inputs,
          runState.taskId, runState.onProgress
        );
      }
    }

    var layerName = (settings.rhLocalDebug && wf.needsMask && !wf.gptImage)
      ? "ComfyPS - 调试蒙版 - " + wf.name
      : "ComfyPS - " + wf.name;
    if (wf.gptImage) {
      var gptModeNames = {
        generate: "文生图",
        edit: "图像编辑"
      };
      layerName = "ComfyPSGPT - " + (runState.localValidation ? "本地验证 - " : "") + (gptModeNames[mode] || mode);
    }
    throwIfGptTaskCancelled(runState);

    var saveMaskB64 = (wf.gptImage && gptMaskB64) ? gptMaskB64
      : (settings.rhLocalDebug) ? ""
      : (!wf.gptImage && wf.needsMask && maskB64) ? maskB64 : "";

    var saveResult = await saveTaskResult(resultBuffer, saveMaskB64, qTaskId, psDocName);

    if (queueItem) {
      queueItem.status = "completed";
      queueItem.layerName = layerName;
      queueItem.resultFile = saveResult.resultFile;
      queueItem.maskFile = saveResult.maskFile;
      queueItem.hasMask = !!(saveMaskB64 && saveResult.maskFile);
      queueItem.revealSelection = revealSelection;
      queueItem.selectionSnapshotChannel = selectionSnapshotChannel;
      queueItem.placement = placement;
      queueItem.thumbUrl = saveResult.thumbUrl;
      queueItem.savedOk = saveResult.savedOk;
      queueItem.completedAt = Date.now();
      queueItem.durationMs = queueItem.completedAt - queueItem.createdAt;
      queueItem.runState = null;
      // 落盘任务元数据，便于下次打开队列页按 PS 文件名重建历史(仅保存成功的)。
      if (queueItem.savedOk) {
        writeTaskMeta(queueItem, psDocName).catch(function () {});
      }
    }
    selectionSnapshotChannel = "";
    renderWorkQueue();

    setStatus("任务已加入队列 ✓", "ok");
  } catch (e) {
    var wasCancelled = isGptTaskCancelled(e) || !!(runState && runState.cancelRequested);
    if (queueItem) {
      queueItem.status = wasCancelled ? "cancelled" : "failed";
      queueItem.runState = null;
      renderWorkQueue();
    }
    if (wasCancelled) {
      setStatus("已停止任务", "");
    } else {
      setStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
      console.error(e);
    }
  } finally {
    if (typeof selectionSnapshotChannel !== "undefined" && selectionSnapshotChannel) {
      await removeSelectionSnapshotChannel(selectionSnapshotChannel);
    }
    unregisterActiveRun(runSlot, runState);
    if (queueItem && queueItem.runState) queueItem.runState = null;
    refreshRunButton();
  }
}

// =========================================================================
// 设置页面
// =========================================================================
// ---- Segmented control helpers ----
function _segSelect(segId, value) {
  var seg = $(segId);
  if (!seg) return;
  var btns = seg.querySelectorAll("button");
  for (var bi = 0; bi < btns.length; bi++) {
    if (btns[bi].dataset.value === value) btns[bi].classList.add("active");
    else btns[bi].classList.remove("active");
  }
}

function _segGet(segId) {
  var seg = $(segId);
  if (!seg) return "";
  var active = seg.querySelector("button.active");
  return active ? active.dataset.value : "";
}

function renderSettings() {
  var s = loadSettings();
  var bridgeInput = $("settingBridgeUrl");
  var apiKeyInput = $("settingApiKey");
  var comfyuiInput = $("settingComfyuiUrl");
  var gptImageApiKeyInput = $("settingGptImageApiKey");
  var gptImageLocalValidationInput = $("settingGptImageLocalValidation");
  var balanceDisplay = $("balanceDisplay");

  if (bridgeInput) bridgeInput.value = s.bridgeUrl;
  if (apiKeyInput) apiKeyInput.value = s.apiKey;
  if (comfyuiInput) comfyuiInput.value = s.comfyuiUrl;
  if (gptImageApiKeyInput) gptImageApiKeyInput.value = s.gptImageApiKey;
  if (gptImageLocalValidationInput) gptImageLocalValidationInput.checked = s.gptImageLocalValidation;
  var rhLocalDebugInput = $("settingRhLocalDebug");
  if (rhLocalDebugInput) rhLocalDebugInput.checked = s.rhLocalDebug;
  _segSelect("segBackend", s.backend);
  _segSelect("segSite", s.rhSite);
  _segSelect("segTheme", s.theme);
  _segSelect("segGptImageAuth", s.gptImageAuth);
  _segSelect("segCachePath", s.cacheMode);

  // 显示已保存的 API 类型标签
  _showApiTypeBadge(s.apiType);

  _applyBackendVisibility();
  _applySiteLink();
  _applyGptImageAuthVisibility();
  _applyCachePathVisibility();
  _refreshCachePathDisplay();
}

function _showApiTypeBadge(apiType) {
  var balanceDisplay = $("balanceDisplay");
  if (!balanceDisplay) return;
  if (!apiType) { balanceDisplay.style.display = "none"; return; }
  var supportsParallel = supportsRunningHubParallel({ apiType: apiType });
  balanceDisplay.style.display = "inline-block";
  balanceDisplay.innerHTML = '<span class="balance-badge ' + (supportsParallel ? 'ok' : 'err') + '">'
    + (supportsParallel ? '共享/企业级 · 支持并发' : '消费级 · RunningHub 单任务，可与 GPT Image 并行')
    + '</span>';
}

function _applyBackendVisibility() {
  var backend = _segGet("segBackend");
  var rhSettings = $("rhSettings");
  var comfyuiSettings = $("comfyuiSettings");
  var isComfyui = backend === "comfyui";

  if (rhSettings) rhSettings.style.display = isComfyui ? "none" : "block";
  if (comfyuiSettings) comfyuiSettings.style.display = isComfyui ? "block" : "none";
}

function _applyGptImageAuthVisibility() {
  var auth = _segGet("segGptImageAuth") || "codex";
  var codexSettings = $("gptImageCodexSettings");
  var apiSettings = $("gptImageApiSettings");
  if (codexSettings) codexSettings.style.display = auth === "codex" ? "block" : "none";
  if (apiSettings) apiSettings.style.display = auth === "api-key" ? "block" : "none";
}

function _applyCachePathVisibility() {
  var mode = _segGet("segCachePath") || "default";
  var defaultSettings = $("defaultCachePathSettings");
  var customSettings = $("customCachePathSettings");
  var hasCustomPath = !!localStorage.getItem("comfyps.cacheBasePath");
  if (defaultSettings) defaultSettings.style.display = mode === "custom" ? "none" : "block";
  if (customSettings) customSettings.style.display = mode === "custom" ? "block" : "none";
  var display = $("cachePathDisplay");
  if (display && mode === "custom") {
    if (!hasCustomPath) display.textContent = "尚未选择自定义文件夹";
  }
}

function _applySiteLink() {
  var site = _segGet("segSite");
  var linkGetKey = $("linkGetKey");
  if (!linkGetKey) return;
  linkGetKey.href = site === "cn"
    ? "https://www.runninghub.cn/enterprise-api/consumerApi"
    : "https://www.runninghub.ai/enterprise-api/consumerApi";
}

async function testApiKey() {
  var btn = $("btnTestKey");
  var balanceDisplay = $("balanceDisplay");
  if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }
  if (balanceDisplay) balanceDisplay.style.display = "none";

  var settings = loadSettings();
  var bridgeUrl = settings.bridgeUrl;
  var apiKey = ($("settingApiKey") ? $("settingApiKey").value : "").trim();
  var site = _segGet("segSite") || "ai";

  if (!apiKey) {
    if (balanceDisplay) {
      balanceDisplay.style.display = "inline-block";
      balanceDisplay.innerHTML = '<span class="balance-badge err">请输入 API Key</span>';
    }
    if (btn) { btn.disabled = false; btn.textContent = "测试"; }
    return;
  }

  try {
    var resp = await fetchWithTimeout(
      bridgeUrl.replace(/\/+$/, "") + "/test-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey, site: site }),
      },
      10000
    );
    var data = await resp.json();
    if (balanceDisplay) {
      balanceDisplay.style.display = "block";
      if (data.ok) {
        // 共享/企业级密钥支持并发提交；不在插件侧限制并发数量。
        var apiType = data.api_type || "";
        saveSetting("apiType", apiType);
        var supportsParallel = supportsRunningHubParallel({ apiType: apiType });
        var html = '<span class="balance-badge ok">' + data.message + '</span>';
        if (supportsParallel) {
          html += ' <span style="font-size:10px;color:var(--accent);">(共享/企业级 · 支持并发)</span>';
        }
        balanceDisplay.innerHTML = html;
      } else {
        balanceDisplay.innerHTML = '<span class="balance-badge err">' + (data.message || "Key 无效") + '</span>';
      }
    }
  } catch (e) {
    if (balanceDisplay) {
      balanceDisplay.style.display = "inline-block";
      balanceDisplay.innerHTML = '<span class="balance-badge err">桥连接失败</span>';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "测试"; }
  }
}

function _showGptImageAuthStatus(ok, message) {
  var display = $("gptImageAuthStatus");
  if (!display) return;
  display.style.display = "block";
  display.innerHTML = "";
  var badge = document.createElement("span");
  badge.className = "balance-badge " + (ok ? "ok" : "err");
  badge.textContent = message;
  display.appendChild(badge);
}

async function testGptImageAuth() {
  var auth = _segGet("segGptImageAuth") || "codex";
  var btn = auth === "codex" ? $("btnTestCodex") : $("btnTestGptImageKey");
  var originalText = btn ? btn.textContent : "测试";
  if (btn) { btn.disabled = true; btn.textContent = "检测中…"; }

  var settings = loadSettings();
  var url = settings.bridgeUrl.replace(/\/+$/, "");
  var requestUrl = auth === "codex" ? url + "/codex/status" : url + "/gpt-image/status";
  var options = null;
  if (auth !== "codex") {
    var apiKey = ($("settingGptImageApiKey") ? $("settingGptImageApiKey").value : "").trim();
    if (!apiKey) {
      _showGptImageAuthStatus(false, "请输入 OpenAI API Key");
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
      return;
    }
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey }),
    };
  }

  try {
    var response = await fetchWithTimeout(requestUrl, options, 15000);
    var data = await response.json();
    _showGptImageAuthStatus(!!data.ok, data.message || (data.ok ? "认证可用" : "认证失败"));
  } catch (e) {
    _showGptImageAuthStatus(false, "桥连接失败或认证检测超时");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

function saveAllSettings() {
  var bridgeUrl = ($("settingBridgeUrl") ? $("settingBridgeUrl").value : "").trim();
  var apiKey = ($("settingApiKey") ? $("settingApiKey").value : "").trim();
  var comfyuiUrl = ($("settingComfyuiUrl") ? $("settingComfyuiUrl").value : "").trim();
  var gptImageApiKey = ($("settingGptImageApiKey") ? $("settingGptImageApiKey").value : "").trim();
  var gptImageLocalValidation = !!($("settingGptImageLocalValidation") && $("settingGptImageLocalValidation").checked);
  var rhLocalDebug = !!($("settingRhLocalDebug") && $("settingRhLocalDebug").checked);
  var backend = _segGet("segBackend") || "runninghub";
  var site = _segGet("segSite") || "ai";
  var gptImageAuth = _segGet("segGptImageAuth") || "codex";
  var cacheMode = _segGet("segCachePath") || "default";

  var theme = _segGet("segTheme") || "dark";
  applyTheme(theme);

  saveSetting("bridgeUrl", bridgeUrl);
  saveSetting("backend", backend);
  saveSetting("rhSite", site);
  saveSetting("apiKey", apiKey);
  saveSetting("comfyuiUrl", comfyuiUrl);
  saveSetting("gptImageAuth", gptImageAuth);
  saveSetting("gptImageApiKey", gptImageApiKey);
  saveSetting("gptImageLocalValidation", gptImageLocalValidation ? "true" : "false");
  saveSetting("rhLocalDebug", rhLocalDebug ? "true" : "false");
  saveSetting("theme", theme);
  saveSetting("cacheMode", cacheMode);
  renderWorkflowDescription(findWorkflow(_selectedWorkflowId));
}

// =========================================================================
// 初始化
// =========================================================================
(function init() {
  // 尽早捕获 UXP 控制台输出，确保初始化和后续运行日志都能显示。
  installLogCapture();

  // ---- 全局 Top Bar 导航 ----
  var topTabs = document.querySelectorAll(".topbar-tab");
  for (var topTabIndex = 0; topTabIndex < topTabs.length; topTabIndex++) {
    topTabs[topTabIndex].addEventListener("click", function (e) {
      navigateTo(e.currentTarget.dataset.page);
    });
  }

  // ---- 运行按钮 ----
  var runBtn = $("runBtn");
  if (runBtn) runBtn.addEventListener("click", onRunClick);

  // ---- 工作队列按钮 ----
  var queueImportBtn = $("queueImportBtn");
  if (queueImportBtn) queueImportBtn.addEventListener("click", onQueueImportClick);
  var queueStopBtn = $("queueStopBtn");
  if (queueStopBtn) queueStopBtn.addEventListener("click", onQueueStopClick);
  var queueDeleteBtn = $("queueDeleteBtn");
  if (queueDeleteBtn) queueDeleteBtn.addEventListener("click", onQueueDeleteClick);
  var queueRefreshBtn = $("queueRefreshBtn");
  if (queueRefreshBtn) queueRefreshBtn.addEventListener("click", function () {
    loadQueueHistoryForActiveDoc();
  });
  var queuePreviewClose = $("queuePreviewClose");
  if (queuePreviewClose) queuePreviewClose.addEventListener("click", onQueuePreviewClose);
  var toastEl = $("toast");
  if (toastEl) toastEl.addEventListener("click", function () { showToast(""); });
  var queuePreviewModal = $("queuePreviewModal");
  if (queuePreviewModal) {
    queuePreviewModal.addEventListener("click", function (e) {
      if (e.target === queuePreviewModal) onQueuePreviewClose();
    });
  }

  // ---- 日志页按钮 ----
  var logClearBtn = $("logClearBtn");
  if (logClearBtn) logClearBtn.addEventListener("click", clearLogPanel);
  var logAutoScrollBtn = $("logAutoScrollBtn");
  if (logAutoScrollBtn) {
    logAutoScrollBtn.addEventListener("click", function () {
      _logAutoScroll = !_logAutoScroll;
      updateLogAutoScrollButton();
      if (_logAutoScroll) {
        var logList = $("logList");
        if (logList) logList.scrollTop = logList.scrollHeight;
      }
    });
  }
  var logList = $("logList");
  if (logList) {
    logList.addEventListener("scroll", function () {
      var isAtBottom = _isLogListAtBottom(logList);
      if (_logAutoScroll && !isAtBottom) {
        _logAutoScroll = false;
        updateLogAutoScrollButton();
      } else if (!_logAutoScroll && isAtBottom) {
        _logAutoScroll = true;
        updateLogAutoScrollButton();
      }
    });
  }

  // ---- 启动/重启桥按钮 ----
  var restartBtn = $("restartBtn");
  if (restartBtn) {
    restartBtn.addEventListener("click", function () {
      if (_bridgeBtnMode === "start") {
        // 桥离线：通过 shell.openPath 拉起启动脚本(会弹授权框、打开终端)。
        startBridgeViaShell();
      } else if (typeof confirm === "function" ? confirm("确定要重启本地桥吗？正在处理的任务将丢失。") : true) {
        restartBridge();
      }
    });
  }

  // ---- 设置页: 后端切换 ----
  var segBackend = $("segBackend");
  if (segBackend) {
    segBackend.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") {
        _segSelect("segBackend", e.target.dataset.value);
        _applyBackendVisibility();
        saveAllSettings();
      }
    });
  }

  // ---- 设置页: 站点切换 ----
  var segSite = $("segSite");
  if (segSite) {
    segSite.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") {
        _segSelect("segSite", e.target.dataset.value);
        _applySiteLink();
        saveAllSettings();
      }
    });
  }

  // ---- 设置页: 主题切换 ----
  var segTheme = $("segTheme");
  if (segTheme) {
    segTheme.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") {
        _segSelect("segTheme", e.target.dataset.value);
        saveAllSettings();
      }
    });
  }

  // ---- 设置页: GPT Image 认证方式 ----
  var segGptImageAuth = $("segGptImageAuth");
  if (segGptImageAuth) {
    segGptImageAuth.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") {
        _segSelect("segGptImageAuth", e.target.dataset.value);
        _applyGptImageAuthVisibility();
        saveAllSettings();
      }
    });
  }

  // ---- 设置页: 结果缓存路径 ----
  var segCachePath = $("segCachePath");
  if (segCachePath) {
    segCachePath.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") {
        _segSelect("segCachePath", e.target.dataset.value);
        _applyCachePathVisibility();
        saveAllSettings();
        _refreshCachePathDisplay();
      }
    });
  }

  // ---- 加载时应用主题 ----
  applyTheme(loadSettings().theme);

  // ---- 开发预览：注入任务队列演示数据，生产模式不执行 ----
  seedDevWorkQueue();

  // ---- 设置页: 输入自动保存 ----
  ["settingBridgeUrl", "settingApiKey", "settingComfyuiUrl", "settingGptImageApiKey"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("blur", saveAllSettings);
  });
  var gptImageLocalValidation = $("settingGptImageLocalValidation");
  if (gptImageLocalValidation) gptImageLocalValidation.addEventListener("change", saveAllSettings);
  var rhLocalDebugChk = $("settingRhLocalDebug");
  if (rhLocalDebugChk) rhLocalDebugChk.addEventListener("change", saveAllSettings);

  // ---- 设置页: 测试 Key ----
  var btnTestKey = $("btnTestKey");
  if (btnTestKey) btnTestKey.addEventListener("click", testApiKey);
  var btnTestCodex = $("btnTestCodex");
  if (btnTestCodex) btnTestCodex.addEventListener("click", testGptImageAuth);
  var btnTestGptImageKey = $("btnTestGptImageKey");
  if (btnTestGptImageKey) btnTestGptImageKey.addEventListener("click", testGptImageAuth);

  // ---- 设置页: 缓存路径 ----
  var btnBrowseCachePath = $("btnBrowseCachePath");
  if (btnBrowseCachePath) btnBrowseCachePath.addEventListener("click", browseCachePath);
  var btnClearCachePath = $("btnClearCachePath");
  if (btnClearCachePath) btnClearCachePath.addEventListener("click", function () {
    localStorage.removeItem("comfyps.cacheBasePath");
    saveSetting("cacheMode", "default");
    _segSelect("segCachePath", "default");
    _applyCachePathVisibility();
    _refreshCachePathDisplay();
  });

  // ---- 桥健康轮询 ----
  startHealthPolling();

  // ---- 默认进入工作流页 ----
  navigateTo("workflow");
})();
