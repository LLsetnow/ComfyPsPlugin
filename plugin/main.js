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
  };
}

function isEnterprise() {
  var at = loadSettings().apiType.toLowerCase();
  return at.indexOf("enterprise") !== -1;
}

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
}

function saveSetting(key, value) {
  localStorage.setItem(SETTINGS_KEYS[key], value);
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
var _pollTimer = 0;
var _progressFill = null;
var _progressMsg = null;
var _progressBar = null;

// =========================================================================
// 调用本地桥 /run
// =========================================================================
async function callBridge(bridgeUrl, imageB64, maskB64, prompt, settings, workflow) {
  var progressFill = _progressFill;
  var progressMsg = _progressMsg;
  var progressBar = _progressBar;
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
    var inputs = getWorkflowInputs();
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
            _pollTimer = 0;
          }
        }
      } catch (_) {}
    }, 2000);
    _pollTimer = pollTimer;
  }

  return await resp.arrayBuffer();
}

// =========================================================================
// 把结果贴成新图层
// =========================================================================
async function placeImageBytesAsLayer(arrayBuffer, layerName) {
  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_result.png", { overwrite: true });
  await file.write(arrayBuffer);
  var token = await localFileSystem.createSessionToken(file);

  await executeAsModal(
    async function () {
      await batchPlay(
        [
          {
            _obj: "placeEvent",
            target: { _path: token, _kind: "local" },
            offset: {
              _obj: "offset",
              horizontal: { _unit: "pixelsUnit", _value: 0 },
              vertical: { _unit: "pixelsUnit", _value: 0 },
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
  var descEl = $("workflowDesc");
  if (descEl) {
    if (wf.description) {
      descEl.textContent = wf.description;
      descEl.style.display = "block";
    } else {
      descEl.style.display = "none";
    }
  }

  (wf.inputs || []).forEach(function (inp) {
    var label = document.createElement("label");
    label.textContent = inp.label;
    label.htmlFor = inp.id;
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
    } else {
      var ip = document.createElement("input");
      ip.id = inp.id;
      ip.type = inp.type;
      ip.placeholder = inp.placeholder || "";
      if (inp.default !== undefined) ip.value = inp.default;
      container.appendChild(ip);
    }
  });

  runBtn.style.display = "flex";
  runBtn.querySelector("#btnLabel").textContent = "运行 — " + wf.name;
}

function getWorkflowInputs() {
  var wf = findWorkflow(_selectedWorkflowId);
  if (!wf || !wf.inputs) return {};
  var values = {};
  wf.inputs.forEach(function (inp) {
    var el = $(inp.id);
    values[inp.id] = el ? el.value : (inp.default || "");
  });
  return values;
}

// =========================================================================
// 运行
// =========================================================================
async function onRunClick() {
  var btn = $("runBtn");
  if (!btn) return;
  // 非企业版禁止并发
  if (!isEnterprise() && btn.disabled) return;
  btn.disabled = true;
  var labelEl = $("btnLabel");
  var spinnerEl = $("btnSpinner");
  if (labelEl) { labelEl.hidden = true; }
  if (spinnerEl) spinnerEl.hidden = false;

  try {
    if (!app.activeDocument) throw new Error("没有打开的文档");

    var settings = loadSettings();
    var inputs = getWorkflowInputs();
    var wf = findWorkflow(_selectedWorkflowId);
    var prompt = inputs.wfPrompt || "";
    var resolution = parseInt(inputs.wfResolution) || 1024;

    var imageB64 = await exportActiveDocPNG();
    var maskB64 = "";
    if (wf && wf.needsMask) {
      maskB64 = await exportSelectionMaskPNG();
    }

    // 按钮显示处理状态
    if (labelEl) labelEl.textContent = "云端处理中…";

    // 启动进度条
    _progressBar = $("progressBar");
    _progressFill = $("progressFill");
    _progressMsg = $("progressMsg");
    if (_progressBar) _progressBar.style.display = "block";

    var resultBuffer = await callBridge(settings.bridgeUrl, imageB64, maskB64, prompt, settings, wf);

    if (_progressBar) _progressBar.style.display = "none";
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = 0; }

    var layerName = "ComfyPS - " + (wf ? wf.name : "结果");
    await placeImageBytesAsLayer(resultBuffer, layerName);

    setStatus("完成 ✓", "ok");
  } catch (e) {
    setStatus("失败: " + (e && e.message ? e.message : String(e)), "err");
    console.error(e);
  } finally {
    btn.disabled = false;
    var labelEl2 = $("btnLabel");
    var spinnerEl2 = $("btnSpinner");
    if (labelEl2) {
      labelEl2.hidden = false;
      labelEl2.textContent = "运行 — " + (findWorkflow(_selectedWorkflowId) ? findWorkflow(_selectedWorkflowId).name : "");
    }
    if (spinnerEl2) spinnerEl2.hidden = true;
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
  var balanceDisplay = $("balanceDisplay");

  if (bridgeInput) bridgeInput.value = s.bridgeUrl;
  if (apiKeyInput) apiKeyInput.value = s.apiKey;
  if (comfyuiInput) comfyuiInput.value = s.comfyuiUrl;
  _segSelect("segBackend", s.backend);
  _segSelect("segSite", s.rhSite);
  _segSelect("segTheme", s.theme);

  // 显示已保存的 API 类型标签
  _showApiTypeBadge(s.apiType);

  _applyBackendVisibility();
  _applySiteLink();
}

function _showApiTypeBadge(apiType) {
  var balanceDisplay = $("balanceDisplay");
  if (!balanceDisplay) return;
  if (!apiType) { balanceDisplay.style.display = "none"; return; }
  var isEnt = apiType.toLowerCase().indexOf("enterprise") !== -1;
  balanceDisplay.style.display = "inline-block";
  balanceDisplay.innerHTML = '<span class="balance-badge ' + (isEnt ? 'ok' : 'err') + '">'
    + (isEnt ? '企业级 · 支持并发' : '消费级 · 单任务')
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

function saveAllSettings() {
  var bridgeUrl = ($("settingBridgeUrl") ? $("settingBridgeUrl").value : "").trim();
  var apiKey = ($("settingApiKey") ? $("settingApiKey").value : "").trim();
  var comfyuiUrl = ($("settingComfyuiUrl") ? $("settingComfyuiUrl").value : "").trim();
  var backend = _segGet("segBackend") || "runninghub";
  var site = _segGet("segSite") || "ai";

  var theme = _segGet("segTheme") || "dark";
  applyTheme(theme);

  saveSetting("bridgeUrl", bridgeUrl);
  saveSetting("backend", backend);
  saveSetting("rhSite", site);
  saveSetting("apiKey", apiKey);
  saveSetting("comfyuiUrl", comfyuiUrl);
  saveSetting("theme", theme);
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

  // ---- 加载时应用主题 ----
  applyTheme(loadSettings().theme);

  // ---- 设置页: 输入自动保存 ----
  ["settingBridgeUrl", "settingApiKey", "settingComfyuiUrl"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("blur", saveAllSettings);
  });

  // ---- 设置页: 测试 Key ----
  var btnTestKey = $("btnTestKey");
  if (btnTestKey) btnTestKey.addEventListener("click", testApiKey);

  // ---- 桥健康轮询 ----
  startHealthPolling();

  // ---- 首页 ----
  navigateTo(1);
})();
