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
      taskCostType: task.taskCostType || "",
      taskCost: task.taskCost || "",
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
    taskCostType: meta.taskCostType || "",
    taskCost: meta.taskCost || "",
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

function formatQueueTaskCost(task) {
  if (!task || (task.taskCostType !== "coins" && task.taskCostType !== "money")) return "";
  if (task.taskCost === null || typeof task.taskCost === "undefined") return "";
  var value = String(task.taskCost).replace(/^\s+|\s+$/g, "");
  if (!value) return "";
  return task.taskCostType === "coins" ? "消耗 " + value + " RH币" : "消耗 ¥" + value;
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
      taskCostType: "coins",
      taskCost: "17",
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
      var taskCost = formatQueueTaskCost(task);
      if (taskCost) {
        var cost = document.createElement("span");
        cost.textContent = taskCost;
        meta.appendChild(cost);
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

