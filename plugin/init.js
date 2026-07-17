// =========================================================================
// 初始化
// =========================================================================
(function init() {
  // 尽早捕获 UXP 控制台输出，确保初始化和后续运行日志都能显示。
  installLogCapture();

  // UXP 正常隐藏面板和浏览器/Photoshop 正常卸载时，尽力关闭插件受管实例。
  // 强制退出、崩溃或断电无法保证网络请求完成，桥的 shutdown hook 会再尝试一次。
  document.addEventListener("uxpcommand", function (event) {
    if (!event) return;
    if (event.commandId === "uxpshowpanel") resetAigateManagedCloseForPanelShow();
    if (event.commandId === "uxphidepanel") requestAigateManagedClose();
  });
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", requestAigateManagedClose);
  }

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
        renderWorkflowGrid();
        var currentWorkflow = findWorkflow(_selectedWorkflowId);
        if (!isWorkflowAvailableForBackend(currentWorkflow, _segGet("segBackend"))) {
          selectWorkflow("inpaint");
        } else if (currentWorkflow) {
          selectWorkflow(currentWorkflow.id);
        }
      }
    });
  }

  // ---- 设置页: RunningHub 凭据 ----
  var btnAddRhCredential = $("btnAddRhCredential");
  if (btnAddRhCredential) btnAddRhCredential.addEventListener("click", function () {
    showRhCredentialEditor("");
  });
  var btnCancelRhCredential = $("btnCancelRhCredential");
  if (btnCancelRhCredential) btnCancelRhCredential.addEventListener("click", hideRhCredentialEditor);
  var btnSaveRhCredential = $("btnSaveRhCredential");
  if (btnSaveRhCredential) btnSaveRhCredential.addEventListener("click", saveRhCredentialEditor);
  var btnRefreshRhCredentials = $("btnRefreshRhCredentials");
  if (btnRefreshRhCredentials) btnRefreshRhCredentials.addEventListener("click", refreshAllRhCredentials);
  var segRhCredentialSite = $("segRhCredentialSite");
  if (segRhCredentialSite) {
    segRhCredentialSite.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON" && !_rhCredentialEditorId && !e.target.disabled) {
        _segSelect("segRhCredentialSite", e.target.dataset.value);
        _applySiteLink(e.target.dataset.value);
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
  ["settingBridgeUrl", "settingComfyuiUrl", "settingAigateToken", "settingGptImageApiKey"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("blur", saveAllSettings);
  });
  var gptImageLocalValidation = $("settingGptImageLocalValidation");
  if (gptImageLocalValidation) gptImageLocalValidation.addEventListener("change", saveAllSettings);
  var rhLocalDebugChk = $("settingRhLocalDebug");
  if (rhLocalDebugChk) rhLocalDebugChk.addEventListener("change", saveAllSettings);
  var autoStartBridgeChk = $("settingAutoStartBridge");
  if (autoStartBridgeChk) autoStartBridgeChk.addEventListener("change", saveAllSettings);

  var btnTestCodex = $("btnTestCodex");
  if (btnTestCodex) btnTestCodex.addEventListener("click", testGptImageAuth);
  var btnTestGptImageKey = $("btnTestGptImageKey");
  if (btnTestGptImageKey) btnTestGptImageKey.addEventListener("click", testGptImageAuth);
  var btnTestComfyui = $("btnTestComfyui");
  if (btnTestComfyui) btnTestComfyui.addEventListener("click", testComfyuiConnection);
  var btnRefreshAigateInstances = $("btnRefreshAigateInstances");
  if (btnRefreshAigateInstances) btnRefreshAigateInstances.addEventListener("click", refreshAigateInstances);

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
