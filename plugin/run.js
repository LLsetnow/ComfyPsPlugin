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
  if (slot === "runningHub") {
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
  if (slot === "runningHub") {
    if (!supportsRunningHubParallel(settings)) {
      var credentialKey = settings && settings.apiKey ? settings.apiKey : "";
      var activeRuns = _activeRuns.runningHub || [];
      for (var i = 0; i < activeRuns.length; i++) {
        if (activeRuns[i] && activeRuns[i].rhCredentialKey === credentialKey) return false;
      }
    }
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

function getImageEnhanceScale(value) {
  var scale = parseFloat(value);
  if (!isFinite(scale) || scale < 1 || scale > 8) return 2;
  return Math.round(scale * 10) / 10;
}

function getWorkflowRunConfig(workflow, inputs, backend) {
  var runConfig = {
    workflowId: workflow.workflowId,
    workflowFile: workflow.workflowFile || "",
    imageNodeId: workflow.imageNodeId || "",
    maskNodeId: workflow.maskNodeId || "",
    outputNodeId: workflow.outputNodeId || "",
    promptNodeId: workflow.promptNodeId || "",
    promptField: workflow.promptField || "",
    resolutionNodeId: "",
    inpaintVariant: "",
  };
  if (workflow.id === "inpaint" && workflow.inpaintVariants) {
    var variantId = backend === "aigate" || (inputs && inputs.wfInpaintVariant === "boogu")
      ? "boogu" : "qwen";
    var variant = workflow.inpaintVariants[variantId] || workflow.inpaintVariants.qwen;
    runConfig.workflowId = variant.workflowId;
    runConfig.workflowFile = variant.workflowFile;
    runConfig.imageNodeId = variant.imageNodeId;
    runConfig.maskNodeId = variant.maskNodeId;
    runConfig.outputNodeId = variant.outputNodeId || "";
    runConfig.promptNodeId = variant.promptNodeId || "";
    runConfig.promptField = variant.promptField || "";
    runConfig.resolutionNodeId = variant.resolutionNodeId;
    runConfig.inpaintVariant = variantId;
  }
  if (workflow.id === "image-enhance" && workflow.variants) {
    var mode = inputs && inputs.wfImageEnhanceMode === "upscale" ? "upscale" : "clarity";
    var imageEnhanceVariant = workflow.variants[mode] || workflow.variants.clarity;
    runConfig.workflowId = imageEnhanceVariant.workflowId;
    runConfig.workflowFile = imageEnhanceVariant.workflowFile;
    runConfig.imageNodeId = imageEnhanceVariant.imageNodeId;
    runConfig.outputNodeId = imageEnhanceVariant.outputNodeId;
  }
  return runConfig;
}

function isWorkflowAvailableForBackend(workflow, backend) {
  if (!workflow || workflow.active === false) return false;
  if (backend !== "aigate") return true;
  if (workflow.gptImage) return true;
  return workflow.id === "inpaint" || workflow.aigateSupported === true;
}

async function callBridge(bridgeUrl, imageB64, maskB64, prompt, settings, workflow, inputs, taskId, onProgress) {
  var pollTimer = 0;
  var url = bridgeUrl.replace(/\/+$/, "") + "/run";
  var runConfig = getWorkflowRunConfig(workflow, inputs, settings.backend);
  var body = {
    image: imageB64,
    prompt: prompt || "",
    backend: settings.backend,
    workflowId: runConfig.workflowId,
    workflowFile: runConfig.workflowFile,
    imageNodeId: runConfig.imageNodeId,
    outputNodeId: runConfig.outputNodeId,
    promptNodeId: runConfig.promptNodeId,
    promptField: runConfig.promptField,
    extraSetArgs: typeof workflow.setArgs === "function" ? workflow.setArgs(inputs, runConfig) : [],
    needsMask: workflow.needsMask,
    taskId: taskId || "",
  };
  if (runConfig.maskNodeId) body.maskNodeId = runConfig.maskNodeId;
  if (workflow.needsMask) {
    body.mask = maskB64;
  }
  if (settings.backend === "aigate") {
    body.aigateToken = _getAigateToken();
  } else if (settings.backend === "comfyui") {
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
  var taskCostType = resp.headers.get("X-ComfyPS-Task-Cost-Type") || "";
  var taskCost = resp.headers.get("X-ComfyPS-Task-Cost") || "";
  if (taskCostType !== "coins" && taskCostType !== "money") {
    taskCostType = "";
    taskCost = "";
  }
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
    return {
      resultBuffer: await resp.arrayBuffer(),
      taskCostType: taskCostType,
      taskCost: taskCost
    };
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
