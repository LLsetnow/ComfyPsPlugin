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
  _syncAigateLifecycleTimers();
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

// 与 _parseSelectionBounds 不同，这个辅助函数把“没有选区”视为正常结果。
// 图像高清允许直接处理完整活动图层，因此调用方需要能无异常地区分两种情况。
function _selectionBoundsOrNull(result) {
  var selection = result && (result.selection || result);
  if (!selection || selection.top === undefined || selection.left === undefined ||
      selection.right === undefined || selection.bottom === undefined) {
    return null;
  }
  return _parseSelectionBounds(result);
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

// 部分 Photoshop 版本会在没有选区的 get 请求上直接抛错，另一些版本会
// 返回没有边界字段的 descriptor。两种都应当走“完整图层”分支。
async function _readSelectionBoundsIfAny() {
  try {
    var doc = app.activeDocument;
    if (doc && doc.selection && doc.selection.bounds) {
      return _selectionBoundsOrNull(doc.selection.bounds);
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
    return _selectionBoundsOrNull(result && result[0]);
  } catch (_) {
    return null;
  }
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
  bounds = _normalizeSelectionCropBounds(bounds || await _readSelectionBounds());
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

async function exportActiveLayerSelectionPNG(bounds) {
  if (_imagingCropSupported()) {
    try {
      return await _exportActiveLayerSelectionViaImaging(bounds);
    } catch (e) {
      addLogEntry("warn", "imaging 图层导出失败，回退复制文档(会闪切): " +
        (e && e.message ? e.message : e), "插件");
    }
  } else {
    addLogEntry("warn", "当前宿主无 imaging.getPixels/getSelection，使用复制文档导出(会闪切)", "插件");
  }
  return await _exportActiveLayerSelectionViaDuplicate(bounds);
}

async function _exportActiveLayerSelectionViaDuplicate(bounds) {
  var folder = await localFileSystem.getDataFolder();
  var file = await folder.createFile("comfyps_gpt_edit_input.png", { overwrite: true });
  var token = await localFileSystem.createSessionToken(file);
  var layerId = _activeLayerId();
  var records = getDocumentLayerRecords();
  var visibility = _snapshotLayerVisibility(records);
  var cropBounds = bounds;
  var duplicated = false;
  var duplicateDoc = null;
  var noDialog = { dialogOptions: "dontDisplay" };

  await executeAsModal(
    async function () {
      try {
        cropBounds = _normalizeSelectionCropBounds(cropBounds || await _readSelectionBounds());
        _isolateLayer(records, layerId);
        if (typeof app.activeDocument.duplicate === "function") {
          duplicateDoc = await app.activeDocument.duplicate("ComfyPS GPT Image Input");
          duplicated = true;
          await duplicateDoc.crop(cropBounds);
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
            _cropDescriptor(cropBounds, noDialog),
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
  return { image: bytesToBase64(buf), bounds: cropBounds };
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
