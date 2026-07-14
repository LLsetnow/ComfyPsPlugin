/*
 * ComfyPS — UXP 面板逻辑
 * 多页面架构: 主页 → 工作流 → 设置
 */

// ---- 环境检测: UXP vs 浏览器 Dev 模式 ----
var IS_DEV = typeof window !== "undefined" && window.__COMFYPS_DEV__;

var app, core, action, imaging, localFileSystem, formats;

if (IS_DEV) {
  var _mockPs = window.__mock_photoshop;
  var _mockUxp = window.__mock_uxp;
  app = _mockPs.app;
  core = _mockPs.core;
  action = _mockPs.action;
  imaging = _mockPs.imaging;
  localFileSystem = _mockUxp.storage.localFileSystem;
  formats = _mockUxp.storage.formats;
} else {
  var _ps = require("photoshop");
  var _uxp = require("uxp");
  app = _ps.app;
  core = _ps.core;
  action = _ps.action;
  imaging = _ps.imaging;
  localFileSystem = _uxp.storage.localFileSystem;
  formats = _uxp.storage.formats;
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
    icon: "🖌",
    active: true,
    needsMask: true,
    workflowId: "2075283500294565890",
    workflowFile: "../workflows/inpaint_api.json",
    imageNodeId: "41",
    description: "对选区范围内的像素进行图像编辑。先画一个选区，再点运行。",
    inputs: [
      { id: "wfPrompt", type: "textarea", label: "提示词 (positive)", placeholder: "例如: 干净空旷的背景", default: "" },
      { id: "wfResolution", type: "number", label: "分辨率", placeholder: "", default: 1024 },
    ],
  },
  {
    id: "cleanup",
    name: "背景去杂物",
    icon: "🧹",
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
    icon: "👤",
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
    description: "使用本机 Codex 的图像生成功能。可文生图、使用图层作为参考图，或基于活动图层的选区进行编辑。",
    inputs: [
      {
        id: "gptImageMode", type: "select", label: "生成模式", default: "generate", options: [
          { value: "generate", label: "文生图" },
          { value: "reference", label: "添加参考图" },
          { value: "edit", label: "图像编辑（当前图层选区）" },
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
  { id: "blend", name: "物体溶图", icon: "🖼", active: false },
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
};

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
  };
}

function isEnterprise() {
  var at = loadSettings().apiType.toLowerCase();
  return at.indexOf("enterprise") !== -1;
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
function setStatus(msg, kind) {
  var el = $("status");
  if (!el) return;
  el.textContent = msg;
  el.className = kind || "";
}

// =========================================================================
// 页面导航
// =========================================================================
var _currentWorkflowId = null;

function navigateTo(page) {
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) { pages[i].classList.remove("active"); }
  var target = $("page" + page);
  if (target) target.classList.add("active");

  if (page === 2) {
    renderWorkflowGrid();
    checkBridgeHealth();
  }
  if (page === 3) {
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

async function exportActiveLayerSelectionPNG() {
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
        bounds = await _readSelectionBounds();
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
            {
              _obj: "crop",
              to: {
                _obj: "rectangle",
                top: { _unit: "pixelsUnit", _value: bounds.top },
                left: { _unit: "pixelsUnit", _value: bounds.left },
                bottom: { _unit: "pixelsUnit", _value: bounds.bottom },
                right: { _unit: "pixelsUnit", _value: bounds.right },
              },
              _options: noDialog,
            },
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
// 导出当前选区为蒙版 PNG (base64, 白=选中)
// =========================================================================
async function exportSelectionMaskPNG() {
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");

  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_mask.png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);

  var noDialog = { dialogOptions: "dontDisplay" };
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

  await executeAsModal(
    async function () {
      try {
        await batchPlay(
          [{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name: "comfyps_sel", _options: noDialog }],
          {}
        );
      } catch (e) {
        throw new Error("请先做一个选区(未检测到选区)");
      }

      await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], _options: noDialog }], {});

      await batchPlay(
        [
          setSel({ _enum: "ordinal", _value: "allEnum" }),
          fillCmd("black"),
          setSel({ _ref: "channel", _name: "comfyps_sel" }),
          fillCmd("white"),
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

      try {
        await batchPlay(
          [
            { _obj: "delete", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], _options: noDialog },
            setSel({ _ref: "channel", _name: "comfyps_sel" }),
            { _obj: "delete", _target: [{ _ref: "channel", _name: "comfyps_sel" }], _options: noDialog },
          ],
          {}
        );
      } catch (_) {}
    },
    { commandName: "导出选区蒙版" }
  );

  var buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出蒙版失败");
  return bytesToBase64(buf);
}

// =========================================================================
// 进度轮询
// =========================================================================
var _activeRuns = {
  gptImage: null,
  runningHub: null,
  other: null
};

function getRunSlot(workflow, settings) {
  if (workflow && workflow.gptImage) return "gptImage";
  return settings && settings.backend === "runninghub" ? "runningHub" : "other";
}

function canStartWorkflow(workflow, settings) {
  var slot = getRunSlot(workflow, settings);
  if (_activeRuns[slot]) return false;
  if (slot === "gptImage" || slot === "runningHub") return !_activeRuns.other;
  return !_activeRuns.gptImage && !_activeRuns.runningHub && !_activeRuns.other;
}

function refreshRunButton() {
  var runBtn = $("runBtn");
  var label = $("btnLabel");
  var spinner = $("btnSpinner");
  var progressBar = $("progressBar");
  var workflow = findWorkflow(_selectedWorkflowId);
  if (!runBtn || !workflow) return;

  var slot = getRunSlot(workflow, loadSettings());
  var activeRun = _activeRuns[slot];
  var canStart = canStartWorkflow(workflow, loadSettings());
  runBtn.disabled = !canStart;
  if (label) {
    label.hidden = false;
    label.textContent = activeRun ? "生成中" : (canStart ? "运行 — " + workflow.name : "其他任务进行中");
  }
  if (spinner) spinner.hidden = !activeRun;
  if (progressBar) progressBar.style.display = activeRun ? "block" : "none";
}

// =========================================================================
// 调用本地桥 /run
// =========================================================================
async function callBridge(bridgeUrl, imageB64, maskB64, prompt, settings, workflow, inputs) {
  var progressFill = $("progressFill");
  var progressMsg = $("progressMsg");
  var progressBar = $("progressBar");
  var pollTimer = 0;
  var url = bridgeUrl.replace(/\/+$/, "") + "/run";
  var body = {
    image: imageB64,
    prompt: prompt || "",
    backend: settings.backend,
    workflowId: workflow.workflowId,
    workflowFile: workflow.workflowFile || "",
    imageNodeId: workflow.imageNodeId || "",
    needsMask: workflow.needsMask,
  };
  if (workflow.needsMask) {
    body.mask = maskB64;
  }
  // 工作流自定义参数注入 (如 denoise 等)
  if (typeof workflow.setArgs === "function") {
    body.extraSetArgs = workflow.setArgs(inputs);
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
  if (taskId && progressBar && progressFill && progressMsg) {
    pollTimer = setInterval(async function () {
      try {
        var pr = await fetch(bridgeUrl.replace(/\/+$/, "") + "/progress?taskId=" + taskId);
        if (pr.ok) {
          var data = await pr.json();
          progressFill.style.width = (data.percent || 0) + "%";
          progressMsg.textContent = (data.message || "") + " (" + (data.percent || 0) + "%)";
          if (data.percent >= 100) {
            clearInterval(pollTimer);
          }
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
async function callGptImage(bridgeUrl, provider, apiKey, mode, prompt, aspectRatio, resolution, images) {
  var progressFill = $("progressFill");
  var progressMsg = $("progressMsg");
  var progressBar = $("progressBar");
  var pollTimer = 0;
  var url = bridgeUrl.replace(/\/+$/, "") + "/gpt-image";
  var body = {
    provider: provider || "codex",
    mode: mode,
    prompt: prompt || "",
    aspectRatio: aspectRatio || "",
    resolution: resolution || "",
    images: images || [],
  };
  if (provider === "api-key" && apiKey) body.apiKey = apiKey;

  var resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("连不上本地 GPT Image 桥(" + url + "):" + (e && e.message ? e.message : e));
  }
  if (!resp.ok) {
    var detail = "";
    try {
      var j = JSON.parse(await resp.text());
      detail = j.message || j.error || JSON.stringify(j);
    } catch (_) {
      detail = "HTTP " + resp.status;
    }
    throw new Error("GPT Image 生成失败:" + detail);
  }

  var taskId = resp.headers.get("X-Task-Id");
  if (taskId && progressBar && progressFill && progressMsg) {
    pollTimer = setInterval(async function () {
      try {
        var pr = await fetch(bridgeUrl.replace(/\/+$/, "") + "/progress?taskId=" + taskId);
        if (pr.ok) {
          var data = await pr.json();
          progressFill.style.width = (data.percent || 0) + "%";
          progressMsg.textContent = (data.message || "") + " (" + (data.percent || 0) + "%)";
          if (data.percent >= 100) {
            clearInterval(pollTimer);
          }
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
// 把结果贴成新图层
// =========================================================================
var _resultFileSequence = 0;
var _placeImageQueue = Promise.resolve();

function placeImageBytesAsLayer(arrayBuffer, layerName, placement) {
  var queuedPlacement = _placeImageQueue.then(function () {
    return _placeImageBytesAsLayer(arrayBuffer, layerName, placement);
  });
  _placeImageQueue = queuedPlacement.catch(function () {});
  return queuedPlacement;
}

async function _placeImageBytesAsLayer(arrayBuffer, layerName, placement) {
  var folder = await localFileSystem.getDataFolder();
  _resultFileSequence++;
  var file = await folder.createFile(
    "comfyps_result_" + Date.now() + "_" + _resultFileSequence + ".png",
    { overwrite: true }
  );
  await file.write(arrayBuffer);
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
      await batchPlay(
        [
          {
            _obj: "placeEvent",
            target: { _path: token, _kind: "local" },
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
        ],
        {}
      );
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
  var topDot = $("bridgeDot");
  var btn = $("restartBtn");

  if (dot) dot.className = "bridge-bar-dot " + state;
  if (topDot) topDot.className = "bridge-bar-dot " + state;
  if (label) {
    label.textContent = text;
    label.className = "bridge-bar-text " + (state === "on" ? "on" : state === "off" ? "off" : "");
  }
  if (btn) {
    if (_restarting) {
      btn.disabled = true;
      btn.textContent = "重启中…";
    } else {
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
    var auth = loadSettings().gptImageAuth;
    var provider = auth === "api-key" ? "GPT API" : "本机 Codex";
    return "使用 " + provider + " 的图像生成功能。可文生图、使用图层作为参考图，或基于活动图层的选区进行编辑。";
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

var _gptLayerRenderVersion = 0;

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

function renderGptImageLayerInputs() {
  var container = $("gptImageLayerInputs");
  var modeSelect = $("gptImageMode");
  if (!container || !modeSelect) return;
  updateGptAspectRatioVisibility();
  var renderVersion = ++_gptLayerRenderVersion;
  container.innerHTML = "";
  if (modeSelect.value === "edit") {
    var editHint = document.createElement("div");
    editHint.className = "input-note";
    editHint.textContent = "画面比例将自动跟随当前矩形选区。";
    container.appendChild(editHint);
    return;
  }
  if (modeSelect.value !== "reference") return;

  var records;
  try {
    records = getDocumentLayerRecords();
  } catch (e) {
    var empty = document.createElement("div");
    empty.className = "input-note";
    empty.textContent = e && e.message ? e.message : "无法读取图层";
    container.appendChild(empty);
    return;
  }
  if (renderVersion !== _gptLayerRenderVersion) return;

  var countLabel = document.createElement("label");
  countLabel.textContent = "参考图数量";
  countLabel.htmlFor = "gptReferenceCount";
  container.appendChild(countLabel);
  var count = document.createElement("select");
  count.id = "gptReferenceCount";
  var one = document.createElement("option");
  one.value = "1";
  one.textContent = "1 个图层";
  count.appendChild(one);
  var two = document.createElement("option");
  two.value = "2";
  two.textContent = "2 个图层";
  count.appendChild(two);
  container.appendChild(count);

  var layerSelects = document.createElement("div");
  layerSelects.id = "gptReferenceLayerSelects";
  container.appendChild(layerSelects);
  var renderSelects = function () {
    layerSelects.innerHTML = "";
    _appendGptLayerSelect(layerSelects, "gptReferenceLayer1", "参考图层 1", records);
    if (count.value === "2") {
      _appendGptLayerSelect(layerSelects, "gptReferenceLayer2", "参考图层 2", records);
    }
  };
  count.addEventListener("change", renderSelects);
  renderSelects();
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
  if (!container || !runBtn) return;

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
  var refCount = $("gptReferenceCount");
  if (refCount) values.gptReferenceCount = refCount.value;
  var ref1 = $("gptReferenceLayer1");
  if (ref1) values.gptReferenceLayer1 = ref1.value;
  var ref2 = $("gptReferenceLayer2");
  if (ref2) values.gptReferenceLayer2 = ref2.value;
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
  if (!canStartWorkflow(wf, settings)) {
    setStatus(wf.gptImage ? "GPT Image 正在生成中" : "已有 RunningHub 工作流正在运行", "err");
    refreshRunButton();
    return;
  }

  var runSlot = getRunSlot(wf, settings);
  var inputs = getWorkflowInputs();
  var prompt = inputs.wfPrompt || "";
  var gptMode = wf.gptImage ? (inputs.gptImageMode || "generate") : "";
  if (wf.gptImage && gptMode !== "edit") {
    inputs.gptAspectRatio = normalizeGptAspectRatio(inputs.gptAspectRatio);
  }
  _activeRuns[runSlot] = { workflowId: wf.id };
  refreshRunButton();
  setStatus("");

  var progressFill = $("progressFill");
  var progressMsg = $("progressMsg");
  if (progressFill) progressFill.style.width = "0";
  if (progressMsg) progressMsg.textContent = "正在提交任务…";

  try {
    var resultBuffer;
    var placement = null;
    if (wf.gptImage) {
      var mode = gptMode;
      var images = [];
      if (!prompt.trim()) throw new Error("请输入关键词或编辑说明");

      if (mode === "reference") {
        var referenceIds = [inputs.gptReferenceLayer1];
        if (inputs.gptReferenceCount === "2") referenceIds.push(inputs.gptReferenceLayer2);
        if (!referenceIds[0] || (referenceIds.length === 2 && !referenceIds[1])) {
          throw new Error("请选择参考图层");
        }
        if (referenceIds.length === 2 && referenceIds[0] === referenceIds[1]) {
          throw new Error("两张参考图请选择不同的图层");
        }
        for (var ri = 0; ri < referenceIds.length; ri++) {
          images.push(await exportLayerPNG(referenceIds[ri]));
        }
      } else if (mode === "edit") {
        var editInput = await exportActiveLayerSelectionPNG();
        images.push(editInput.image);
        placement = editInput.bounds;
        inputs.gptAspectRatio = getSelectionAspectRatio(editInput.bounds);
      }

      resultBuffer = await callGptImage(
        settings.bridgeUrl,
        settings.gptImageAuth,
        settings.gptImageApiKey,
        mode,
        prompt,
        inputs.gptAspectRatio,
        inputs.gptResolution,
        images
      );
    } else {
      var imageB64 = await exportActiveDocPNG();
      var maskB64 = "";
      if (wf.needsMask) {
        maskB64 = await exportSelectionMaskPNG();
      }
      resultBuffer = await callBridge(
        settings.bridgeUrl, imageB64, maskB64, prompt, settings, wf, inputs
      );
    }

    var layerName = "ComfyPS - " + wf.name;
    if (wf.gptImage) {
      var gptModeNames = {
        generate: "文生图",
        reference: "添加参考图",
        edit: "图像编辑"
      };
      layerName = "ComfyPSGPT - " + (gptModeNames[mode] || mode);
    }
    await placeImageBytesAsLayer(resultBuffer, layerName, placement);

    setStatus("完成 ✓", "ok");
  } catch (e) {
    setStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
    console.error(e);
  } finally {
    _activeRuns[runSlot] = null;
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
  var balanceDisplay = $("balanceDisplay");

  if (bridgeInput) bridgeInput.value = s.bridgeUrl;
  if (apiKeyInput) apiKeyInput.value = s.apiKey;
  if (comfyuiInput) comfyuiInput.value = s.comfyuiUrl;
  if (gptImageApiKeyInput) gptImageApiKeyInput.value = s.gptImageApiKey;
  _segSelect("segBackend", s.backend);
  _segSelect("segSite", s.rhSite);
  _segSelect("segTheme", s.theme);
  _segSelect("segGptImageAuth", s.gptImageAuth);

  // 显示已保存的 API 类型标签
  _showApiTypeBadge(s.apiType);

  _applyBackendVisibility();
  _applySiteLink();
  _applyGptImageAuthVisibility();
}

function _showApiTypeBadge(apiType) {
  var balanceDisplay = $("balanceDisplay");
  if (!balanceDisplay) return;
  if (!apiType) { balanceDisplay.style.display = "none"; return; }
  var isEnt = apiType.toLowerCase().indexOf("enterprise") !== -1;
  balanceDisplay.style.display = "inline-block";
  balanceDisplay.innerHTML = '<span class="balance-badge ' + (isEnt ? 'ok' : 'err') + '">'
    + (isEnt ? '企业级 · 支持并发' : '消费级 · RunningHub 单任务，可与 GPT Image 并行')
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
        // 保存 API 类型: enterprise 可并发，SHARED 不行
        var apiType = data.api_type || "";
        saveSetting("apiType", apiType);
        var isEnt = apiType.toLowerCase().indexOf("enterprise") !== -1;
        var html = '<span class="balance-badge ok">' + data.message + '</span>';
        if (isEnt) {
          html += ' <span style="font-size:10px;color:var(--accent);">(企业版 · 支持并发)</span>';
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
  var backend = _segGet("segBackend") || "runninghub";
  var site = _segGet("segSite") || "ai";
  var gptImageAuth = _segGet("segGptImageAuth") || "codex";

  var theme = _segGet("segTheme") || "dark";
  applyTheme(theme);

  saveSetting("bridgeUrl", bridgeUrl);
  saveSetting("backend", backend);
  saveSetting("rhSite", site);
  saveSetting("apiKey", apiKey);
  saveSetting("comfyuiUrl", comfyuiUrl);
  saveSetting("gptImageAuth", gptImageAuth);
  saveSetting("gptImageApiKey", gptImageApiKey);
  saveSetting("theme", theme);
  renderWorkflowDescription(findWorkflow(_selectedWorkflowId));
}

// =========================================================================
// 初始化
// =========================================================================
(function init() {
  // ---- 页面导航 ----
  var btnGoWorkflows = $("btnGoWorkflows");
  var btnGoSettings = $("btnGoSettings");
  var btnBackHome1 = $("btnBackHome1");
  var btnBackHome2 = $("btnBackHome2");

  if (btnGoWorkflows) btnGoWorkflows.addEventListener("click", function () { navigateTo(2); });
  if (btnGoSettings) btnGoSettings.addEventListener("click", function () { navigateTo(3); });
  if (btnBackHome1) btnBackHome1.addEventListener("click", function () { navigateTo(1); });
  if (btnBackHome2) btnBackHome2.addEventListener("click", function () { navigateTo(1); });

  // ---- 运行按钮 ----
  var runBtn = $("runBtn");
  if (runBtn) runBtn.addEventListener("click", onRunClick);

  // ---- 重启桥按钮 ----
  var restartBtn = $("restartBtn");
  if (restartBtn) {
    restartBtn.addEventListener("click", function () {
      if (typeof confirm === "function" ? confirm("确定要重启本地桥吗？正在处理的任务将丢失。") : true) {
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

  // ---- 加载时应用主题 ----
  applyTheme(loadSettings().theme);

  // ---- 设置页: 输入自动保存 ----
  ["settingBridgeUrl", "settingApiKey", "settingComfyuiUrl", "settingGptImageApiKey"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("blur", saveAllSettings);
  });

  // ---- 设置页: 测试 Key ----
  var btnTestKey = $("btnTestKey");
  if (btnTestKey) btnTestKey.addEventListener("click", testApiKey);
  var btnTestCodex = $("btnTestCodex");
  if (btnTestCodex) btnTestCodex.addEventListener("click", testGptImageAuth);
  var btnTestGptImageKey = $("btnTestGptImageKey");
  if (btnTestGptImageKey) btnTestGptImageKey.addEventListener("click", testGptImageAuth);

  // ---- 桥健康轮询 ----
  startHealthPolling();

  // ---- 首页 ----
  navigateTo(1);
})();
