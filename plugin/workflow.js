// =========================================================================
// 桥状态检测
// =========================================================================
var _bridgeOnline = false;
var _healthPollTimer = 0;
var _restarting = false;
var _launchingBridge = false;
var _bridgePanelLoadStartTried = false;
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

// 每次面板加载时都请求启动脚本安全替换旧桥。
function forceBridgeStartOnPanelLoad() {
  if (_bridgePanelLoadStartTried || _launchingBridge || _restarting) return;
  _bridgePanelLoadStartTried = true;
  addLogEntry("info", "面板加载，正在替换本地桥…", "插件");
  startBridgeViaShell();
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
  var settings = loadSettings();
  WORKFLOWS.forEach(function (wf) {
    var available = isWorkflowAvailableForBackend(wf, settings.backend);
    var card = document.createElement("div");
    card.className = "wf-card" + (available ? "" : " disabled") + (_selectedWorkflowId === wf.id ? " selected" : "");
    card.dataset.wfId = wf.id;
    card.innerHTML =
      '<div class="wf-icon">' + wf.icon + '</div>' +
      '<div class="wf-name">' + wf.name + '</div>' +
      (available ? "" : '<span class="wf-tag soon">' + (settings.backend === "aigate" && wf.active ? "暂未支持云扉原生工作流" : "即将推出") + "</span>");

    if (available) {
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
  var wf = findWorkflow(wfId);
  if (!wf || !isWorkflowAvailableForBackend(wf, loadSettings().backend)) return;
  _selectedWorkflowId = wfId;

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

  var isAigateInpaint = loadSettings().backend === "aigate" && wf.id === "inpaint";
  (wf.inputs || []).forEach(function (inp) {
    if (isAigateInpaint && inp.id === "wfResolution") return;
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
      if (isAigateInpaint && inp.id === "wfInpaintVariant") {
        options = [{ value: "boogu", label: "Boogu" }];
      }
      for (var oi = 0; oi < options.length; oi++) {
        var option = document.createElement("option");
        option.value = options[oi].value;
        option.textContent = options[oi].label;
        select.appendChild(option);
      }
      if (inp.default !== undefined) {
        select.value = isAigateInpaint && inp.id === "wfInpaintVariant" ? "boogu" : inp.default;
      }
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
  if (!isWorkflowAvailableForBackend(wf, settings.backend)) {
    setStatus("该工作流暂未支持云扉原生后端", "err");
    return;
  }
  if (settings.backend === "aigate" && !_getAigateToken()) {
    setStatus("请先在设置中填写云扉 Bearer Token", "err");
    return;
  }
  if (!app.activeDocument) {
    setStatus("没有打开的文档", "err");
    return;
  }
  var isRhLocalMaskDebug = !wf.gptImage && settings.backend === "runninghub"
    && settings.rhLocalDebug && wf.needsMask;
  if (!wf.gptImage && settings.backend === "runninghub" && !isRhLocalMaskDebug) {
    if (!settings.rhCredential) {
      setStatus("请先在设置中添加并选择 RunningHub 凭据", "err");
      return;
    }
    if (settings.rhCredential.status !== "ready") {
      setStatus("当前 RunningHub 凭据尚未通过检测，请在设置中重新检测", "err");
      return;
    }
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
    rhCredentialId: settings.rhCredentialId || "",
    rhCredentialKey: settings.apiKey || "",
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
      taskCostType: "",
      taskCost: "",
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
        var bridgeResult = await callBridge(
          settings.bridgeUrl, imageB64, maskB64, prompt, settings, wf, inputs,
          runState.taskId, runState.onProgress
        );
        resultBuffer = bridgeResult.resultBuffer;
        if (queueItem) {
          queueItem.taskCostType = bridgeResult.taskCostType;
          queueItem.taskCost = bridgeResult.taskCost;
        }
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
