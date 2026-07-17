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
  var comfyuiInput = $("settingComfyuiUrl");
  var aigateTokenInput = $("settingAigateToken");
  var gptImageApiKeyInput = $("settingGptImageApiKey");
  var gptImageLocalValidationInput = $("settingGptImageLocalValidation");

  if (bridgeInput) bridgeInput.value = s.bridgeUrl;
  if (comfyuiInput) comfyuiInput.value = s.comfyuiUrl;
  if (aigateTokenInput) aigateTokenInput.value = s.aigateToken;
  if (gptImageApiKeyInput) gptImageApiKeyInput.value = s.gptImageApiKey;
  if (gptImageLocalValidationInput) gptImageLocalValidationInput.checked = s.gptImageLocalValidation;
  var rhLocalDebugInput = $("settingRhLocalDebug");
  if (rhLocalDebugInput) rhLocalDebugInput.checked = s.rhLocalDebug;
  var autoStartBridgeInput = $("settingAutoStartBridge");
  if (autoStartBridgeInput) autoStartBridgeInput.checked = s.autoStartBridge;
  _segSelect("segBackend", s.backend);
  _segSelect("segTheme", s.theme);
  _segSelect("segGptImageAuth", s.gptImageAuth);
  _segSelect("segCachePath", s.cacheMode);

  _applyBackendVisibility();
  _applyGptImageAuthVisibility();
  _applyCachePathVisibility();
  _refreshCachePathDisplay();
  renderRhCredentials();
  if (s.backend === "aigate" && s.aigateToken) refreshAigateInstances();
  _syncAigateLifecycleTimers();
}

function _applyBackendVisibility() {
  var backend = _segGet("segBackend");
  var rhSettings = $("rhSettings");
  var comfyuiSettings = $("comfyuiSettings");
  var aigateSettings = $("aigateSettings");
  var isComfyui = backend === "comfyui";
  var isAigate = backend === "aigate";

  if (rhSettings) rhSettings.style.display = isComfyui || isAigate ? "none" : "block";
  if (comfyuiSettings) comfyuiSettings.style.display = isComfyui ? "block" : "none";
  if (aigateSettings) aigateSettings.style.display = isAigate ? "block" : "none";
  _syncAigateLifecycleTimers();
}

function _getAigateToken() {
  var input = $("settingAigateToken");
  return (input ? input.value : loadSettings().aigateToken).trim();
}

var _aigateInstances = [];
var _aigateRefreshTimer = 0;
var _aigateRuntimeTimer = 0;
var _aigateRefreshInFlight = false;
var _aigateLifecycleCloseRequested = false;

function _clearAigateLifecycleTimers() {
  if (_aigateRefreshTimer) {
    clearInterval(_aigateRefreshTimer);
    _aigateRefreshTimer = 0;
  }
  if (_aigateRuntimeTimer) {
    clearInterval(_aigateRuntimeTimer);
    _aigateRuntimeTimer = 0;
  }
}

function _syncAigateLifecycleTimers() {
  var shouldRun = _currentPage === "settings" && _segGet("segBackend") === "aigate"
    && managedAigateInstanceIds().length > 0;
  if (!shouldRun) {
    _clearAigateLifecycleTimers();
    return;
  }
  if (!_aigateRefreshTimer) {
    _aigateRefreshTimer = setInterval(function () {
      refreshAigateInstances();
    }, 10000);
  }
  if (!_aigateRuntimeTimer) {
    _aigateRuntimeTimer = setInterval(function () {
      if (_aigateInstances.length) _renderAigateInstances(_aigateInstances);
    }, 1000);
  }
}

function _renderAigateInstances(instances) {
  var container = $("aigateInstanceList");
  if (!container) return;
  container.innerHTML = "";
  if (!instances || !instances.length) {
    container.textContent = "未找到可显示的云扉实例";
    return;
  }
  for (var i = 0; i < instances.length; i++) {
    (function (instance) {
      var row = document.createElement("div");
      row.className = "aigate-instance-row";
      var meta = document.createElement("div");
      meta.className = "aigate-instance-meta";
      var operationStatus = String(instance.operationStatus || "");
      var status = operationStatus === "2" ? "运行中"
        : (operationStatus === "7" || operationStatus === "22" ? "已停止"
          : (operationStatus === "4" ? "已释放" : "状态 " + (operationStatus || "未知")));
      var title = document.createElement("div");
      title.className = "aigate-instance-title";
      title.textContent = (instance.instanceName || "未命名实例") + " · " + status;
      meta.appendChild(title);
      var detail = document.createElement("div");
      detail.className = "setting-hint";
      detail.textContent = instance.instanceId + (instance.hasComfyui ? " · 已发现 ComfyUI" : " · 未发现 ComfyUI");
      meta.appendChild(detail);
      var runtime = document.createElement("div");
      runtime.className = "aigate-runtime";
      runtime.textContent = operationStatus === "2" ? formatAigateRuntime(instance.instanceId)
        : (operationStatus === "7" || operationStatus === "22" ? "已停止"
          : (operationStatus === "4" ? "已释放" : "状态变更中"));
      meta.appendChild(runtime);
      row.appendChild(meta);

      var actions = document.createElement("div");
      actions.className = "aigate-instance-actions";
      function addAction(action, label, danger) {
        var button = document.createElement("button");
        button.className = danger ? "btn-sm btn-danger" : "btn-sm";
        button.textContent = label;
        button.addEventListener("click", function () {
          controlAigateInstance(instance.instanceId, action);
        });
        actions.appendChild(button);
      }
      if (operationStatus === "2") {
        addAction("close", "关闭", false);
        addAction("release", "释放", true);
      } else if (operationStatus === "7" || operationStatus === "22") {
        addAction("open", "启动", false);
        addAction("release", "释放", true);
      }
      if (actions.childNodes.length) row.appendChild(actions);
      container.appendChild(row);
    })(instances[i]);
  }
}

async function refreshAigateInstances() {
  if (_aigateRefreshInFlight) return;
  var token = _getAigateToken();
  var container = $("aigateInstanceList");
  if (!token) {
    if (container) container.textContent = "请输入云扉 Bearer Token";
    return;
  }
  _aigateRefreshInFlight = true;
  var settings = loadSettings();
  try {
    var response = await fetchWithTimeout(
      settings.bridgeUrl.replace(/\/+$/, "") + "/aigate/instances",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aigateToken: token, managedInstanceIds: managedAigateInstanceIds() })
      },
      15000
    );
    if (!response.ok) throw new Error("桥服务返回 HTTP " + response.status);
    var data = await response.json();
    if (!data || !data.ok) throw new Error((data && data.message) || "读取云扉实例失败");
    _aigateInstances = data.instances || [];
    reconcileAigateLifecycle(_aigateInstances);
    _renderAigateInstances(_aigateInstances);
    _syncAigateLifecycleTimers();
  } catch (e) {
    if (container) container.textContent = "读取云扉实例失败：" + (e && e.message ? e.message : e);
  } finally {
    _aigateRefreshInFlight = false;
  }
}

async function controlAigateInstance(instanceId, action) {
  if (action === "close" && typeof confirm === "function" && !confirm("确定关闭此云扉实例吗？")) return;
  if (action === "release" && typeof confirm === "function"
    && !confirm("释放实例后将无法恢复，是否继续？")) return;
  var token = _getAigateToken();
  if (!token) { showToast("请输入云扉 Bearer Token"); return; }
  var settings = loadSettings();
  try {
    var response = await fetchWithTimeout(
      settings.bridgeUrl.replace(/\/+$/, "") + "/aigate/instance-action",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aigateToken: token, instanceId: instanceId, action: action }),
      },
      15000
    );
    if (!response.ok) throw new Error("桥服务返回 HTTP " + response.status);
    var data = await response.json();
    if (!data || !data.ok) throw new Error((data && data.message) || "云扉实例操作失败");
    if (action === "open") {
      var records = loadAigateLifecycle();
      records[String(instanceId)] = { managed: true, pendingStart: true, startedAt: 0 };
      saveAigateLifecycle(records);
    } else if (action === "release") {
      removeAigateLifecycle(instanceId);
    }
    showToast(action === "close" ? "云扉实例正在关闭"
      : (action === "release" ? "云扉实例正在释放" : "云扉实例正在启动"));
    await refreshAigateInstances();
    _syncAigateLifecycleTimers();
  } catch (e) {
    showToast("云扉实例操作失败：" + (e && e.message ? e.message : e));
  }
}

function requestAigateManagedClose() {
  if (_aigateLifecycleCloseRequested) return;
  var token = _getAigateToken();
  var ids = managedAigateInstanceIds();
  if (!token || !ids.length) return;
  _aigateLifecycleCloseRequested = true;
  var bridgeInput = $("settingBridgeUrl");
  var bridgeUrl = bridgeInput ? bridgeInput.value : loadSettings().bridgeUrl;
  var url = String(bridgeUrl || "").replace(/\/+$/, "") + "/aigate/close-managed";
  var body = JSON.stringify({ aigateToken: token, managedInstanceIds: ids });
  if (typeof navigator !== "undefined" && navigator.sendBeacon && typeof Blob === "function") {
    var sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    if (sent) return;
  }
  fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body
  }, 1500).catch(function () {});
}

function resetAigateManagedCloseForPanelShow() {
  _aigateLifecycleCloseRequested = false;
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

function _applySiteLink(site) {
  var resolvedSite = normalizeRhCredentialSite(site);
  var linkGetKey = $("linkGetKey");
  if (!linkGetKey) return;
  linkGetKey.href = resolvedSite === "cn"
    ? "https://www.runninghub.cn/enterprise-api/consumerApi"
    : "https://www.runninghub.ai/enterprise-api/consumerApi";
}

var _rhCredentialEditorId = "";
var _rhCredentialAutoChecked = {};
var _rhCredentialRefreshInFlight = {};

function maskRhCredentialKey(apiKey) {
  var value = String(apiKey || "");
  if (value.length <= 8) return "••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

function formatRhCredentialCheckedAt(timestamp) {
  if (!timestamp) return "未检测";
  var date = new Date(timestamp);
  if (isNaN(date.getTime())) return "未检测";
  return "检测于 " + _queuePadTime(date.getMonth() + 1) + "-" + _queuePadTime(date.getDate())
    + " " + _queuePadTime(date.getHours()) + ":" + _queuePadTime(date.getMinutes());
}

function rhCredentialStatusLabel(credential) {
  if (credential.status === "ready") return "有效";
  if (credential.status === "error") return "检测失败";
  return "待检测";
}

function rhCredentialConcurrencyLabel(credential) {
  return credential.supportsParallel ? "支持并发" : "单任务";
}

function appendRhChip(container, text, className) {
  var chip = document.createElement("span");
  chip.className = "rh-chip " + className;
  chip.textContent = text;
  container.appendChild(chip);
}

function renderRhCredentialCurrent(credential) {
  var current = $("rhCredentialCurrent");
  if (!current) return;
  while (current.firstChild) current.removeChild(current.firstChild);
  if (!credential) {
    current.textContent = "尚未选择凭据";
    return;
  }
  var prefix = document.createTextNode("当前使用：");
  var name = document.createElement("strong");
  name.textContent = credential.name + " · " + credential.site;
  var suffix = document.createTextNode(" · " + rhCredentialConcurrencyLabel(credential));
  current.appendChild(prefix);
  current.appendChild(name);
  current.appendChild(suffix);
}

function createRhCredentialCard(credential, active) {
  var card = document.createElement("div");
  card.className = "rh-credential-card" + (active ? " active" : "") + " " + credential.status;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", "切换到 " + credential.name);

  var head = document.createElement("div");
  head.className = "rh-credential-card-head";
  var name = document.createElement("div");
  name.className = "rh-credential-name";
  name.textContent = credential.name;
  head.appendChild(name);
  var chips = document.createElement("div");
  chips.className = "rh-credential-chips";
  appendRhChip(chips, credential.site, credential.site === "cn" ? "site-cn" : "site-ai");
  appendRhChip(chips, active ? "当前使用" : rhCredentialStatusLabel(credential),
    active ? "active" : credential.status);
  head.appendChild(chips);
  card.appendChild(head);

  var key = document.createElement("div");
  key.className = "rh-credential-key";
  key.textContent = maskRhCredentialKey(credential.apiKey);
  card.appendChild(key);

  var details = document.createElement("div");
  details.className = "rh-credential-details";
  var coins = document.createElement("span");
  coins.appendChild(document.createTextNode("RH币 "));
  var coinValue = document.createElement("strong");
  coinValue.textContent = credential.coins || "--";
  coins.appendChild(coinValue);
  details.appendChild(coins);
  var balance = document.createElement("span");
  balance.appendChild(document.createTextNode("余额 "));
  var balanceValue = document.createElement("strong");
  balanceValue.textContent = credential.balance ? credential.symbol + credential.balance : "--";
  balance.appendChild(balanceValue);
  details.appendChild(balance);
  var checkedAt = document.createElement("span");
  checkedAt.textContent = formatRhCredentialCheckedAt(credential.checkedAt);
  details.appendChild(checkedAt);
  appendRhChip(details, rhCredentialConcurrencyLabel(credential), credential.supportsParallel ? "parallel" : "serial");
  card.appendChild(details);

  if (credential.status === "error" && credential.errorMessage) {
    var error = document.createElement("div");
    error.className = "setting-hint";
    error.style.color = "var(--danger)";
    error.textContent = credential.errorMessage;
    card.appendChild(error);
  }

  var actions = document.createElement("div");
  actions.className = "rh-credential-actions";
  var edit = document.createElement("button");
  edit.className = "rh-credential-action";
  edit.type = "button";
  edit.textContent = "编辑";
  edit.addEventListener("click", function (event) {
    if (event && event.stopPropagation) event.stopPropagation();
    showRhCredentialEditor(credential.id);
  });
  actions.appendChild(edit);
  var remove = document.createElement("button");
  remove.className = "rh-credential-action";
  remove.type = "button";
  remove.textContent = "删除";
  remove.addEventListener("click", function (event) {
    if (event && event.stopPropagation) event.stopPropagation();
    deleteRhCredential(credential.id);
  });
  actions.appendChild(remove);
  card.appendChild(actions);

  card.addEventListener("click", function () { activateRhCredential(credential.id); });
  card.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      if (event.preventDefault) event.preventDefault();
      activateRhCredential(credential.id);
    }
  });
  return card;
}

function renderRhCredentials() {
  var listEl = $("rhCredentialList");
  var emptyEl = $("rhCredentialEmpty");
  if (!listEl) return;
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  var credentials = loadRhCredentials();
  var active = getActiveRhCredential(credentials);
  renderRhCredentialCurrent(active);
  if (emptyEl) emptyEl.style.display = credentials.length ? "none" : "block";

  var sites = ["ai", "cn"];
  for (var s = 0; s < sites.length; s++) {
    var site = sites[s];
    var groupItems = [];
    for (var i = 0; i < credentials.length; i++) {
      if (credentials[i].site === site) groupItems.push(credentials[i]);
    }
    if (!groupItems.length) continue;
    var group = document.createElement("div");
    group.className = "rh-credential-group";
    var groupTitle = document.createElement("div");
    groupTitle.className = "rh-credential-group-title";
    var dot = document.createElement("span");
    dot.className = "rh-credential-site-dot" + (site === "cn" ? " cn" : "");
    groupTitle.appendChild(dot);
    groupTitle.appendChild(document.createTextNode(site + " 站点"));
    group.appendChild(groupTitle);
    for (var j = 0; j < groupItems.length; j++) {
      group.appendChild(createRhCredentialCard(groupItems[j], !!active && active.id === groupItems[j].id));
    }
    listEl.appendChild(group);
  }
  _applySiteLink(active ? active.site : "ai");
  if (active && active.status === "unchecked" && !_rhCredentialAutoChecked[active.id]) {
    _rhCredentialAutoChecked[active.id] = true;
    refreshRhCredential(active.id, true);
  }
}

function setRhCredentialEditorSiteLocked(locked) {
  var segment = $("segRhCredentialSite");
  if (!segment) return;
  var buttons = segment.querySelectorAll("button");
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !!locked;
}

function showRhCredentialEditor(credentialId) {
  var editor = $("rhCredentialEditor");
  var title = $("rhCredentialEditorTitle");
  var nameInput = $("settingRhCredentialName");
  var keyInput = $("settingRhCredentialKey");
  if (!editor || !nameInput || !keyInput) return;
  var credential = findRhCredentialById(loadRhCredentials(), credentialId || "");
  _rhCredentialEditorId = credential ? credential.id : "";
  if (credential) {
    if (title) title.textContent = "编辑凭据";
    nameInput.value = credential.name;
    keyInput.value = credential.apiKey;
    _segSelect("segRhCredentialSite", credential.site);
    setRhCredentialEditorSiteLocked(true);
    _applySiteLink(credential.site);
  } else {
    if (title) title.textContent = "添加凭据";
    nameInput.value = "";
    keyInput.value = "";
    _segSelect("segRhCredentialSite", "ai");
    setRhCredentialEditorSiteLocked(false);
    _applySiteLink("ai");
  }
  editor.style.display = "block";
  try { nameInput.focus(); } catch (_) {}
}

function hideRhCredentialEditor() {
  var editor = $("rhCredentialEditor");
  if (editor) editor.style.display = "none";
  _rhCredentialEditorId = "";
  var active = getActiveRhCredential();
  _applySiteLink(active ? active.site : "ai");
}

function updateRhCredentialFromTest(credentialId, data, errorMessage) {
  var credentials = loadRhCredentials();
  var credential = findRhCredentialById(credentials, credentialId);
  if (!credential) return null;
  credential.checkedAt = Date.now();
  if (data && data.ok) {
    credential.coins = String(data.coins || "0");
    credential.balance = String(data.balance || "0");
    credential.symbol = String(data.symbol || (credential.site === "cn" ? "¥" : "$"));
    credential.apiType = String(data.api_type || "");
    credential.supportsParallel = supportsRunningHubParallel({ apiType: credential.apiType });
    credential.status = "ready";
    credential.errorMessage = "";
  } else {
    credential.status = "error";
    credential.errorMessage = errorMessage || (data && data.message) || "凭据检测失败";
  }
  saveRhCredentials(credentials);
  return credential;
}

async function refreshRhCredential(credentialId, silent) {
  if (!credentialId || _rhCredentialRefreshInFlight[credentialId]) return false;
  var credentials = loadRhCredentials();
  var credential = findRhCredentialById(credentials, credentialId);
  if (!credential) return false;
  _rhCredentialRefreshInFlight[credentialId] = true;
  try {
    var settings = loadSettings();
    var response = await fetchWithTimeout(
      settings.bridgeUrl.replace(/\/+$/, "") + "/test-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: credential.apiKey, site: credential.site })
      },
      10000
    );
    var data = await response.json();
    var updated = updateRhCredentialFromTest(credentialId, data, "");
    renderRhCredentials();
    refreshRunButton();
    if (!silent && updated) {
      setStatus(data.ok ? "凭据「" + updated.name + "」已更新 ✓" : updated.errorMessage, data.ok ? "ok" : "err");
    }
    return !!(data && data.ok);
  } catch (_) {
    var failed = updateRhCredentialFromTest(credentialId, null, "桥连接失败或认证检测超时");
    renderRhCredentials();
    refreshRunButton();
    if (!silent && failed) setStatus(failed.errorMessage, "err");
    return false;
  } finally {
    delete _rhCredentialRefreshInFlight[credentialId];
  }
}

async function refreshAllRhCredentials() {
  var button = $("btnRefreshRhCredentials");
  var originalText = button ? button.textContent : "刷新余额";
  if (button) { button.disabled = true; button.textContent = "刷新中…"; }
  var credentials = loadRhCredentials();
  var succeeded = 0;
  for (var i = 0; i < credentials.length; i++) {
    if (await refreshRhCredential(credentials[i].id, true)) succeeded++;
  }
  if (button) { button.disabled = false; button.textContent = originalText; }
  if (!credentials.length) setStatus("请先添加 RunningHub 凭据", "err");
  else setStatus("已刷新 " + succeeded + "/" + credentials.length + " 个凭据", succeeded === credentials.length ? "ok" : "err");
}

function activateRhCredential(credentialId) {
  var credentials = loadRhCredentials();
  var credential = findRhCredentialById(credentials, credentialId);
  if (!credential) return;
  if (credential.status !== "ready") {
    setStatus(credential.errorMessage || "该凭据尚未通过检测，无法切换", "err");
    return;
  }
  localStorage.setItem(SETTINGS_KEYS.activeRhCredentialId, credential.id);
  renderRhCredentials();
  renderWorkflowDescription(findWorkflow(_selectedWorkflowId));
  refreshRunButton();
  setStatus("已切换到「" + credential.name + "」· " + credential.site, "ok");
  refreshRhCredential(credential.id, true);
}

async function saveRhCredentialEditor() {
  var nameInput = $("settingRhCredentialName");
  var keyInput = $("settingRhCredentialKey");
  if (!nameInput || !keyInput) return;
  var apiKey = String(keyInput.value || "").replace(/^\s+|\s+$/g, "");
  var site = normalizeRhCredentialSite(_segGet("segRhCredentialSite"));
  var name = String(nameInput.value || "").replace(/^\s+|\s+$/g, "") || makeDefaultRhCredentialName(site);
  if (!apiKey) {
    setStatus("请输入 RunningHub API Key", "err");
    return;
  }
  var credentials = loadRhCredentials();
  var credential = findRhCredentialById(credentials, _rhCredentialEditorId);
  var duplicate = findRhCredentialByApiKey(credentials, apiKey, credential ? credential.id : "");
  if (duplicate) {
    setStatus("该 API Key 已保存为凭据「" + duplicate.name + "」，一个 Key 只能保存一次", "err");
    return;
  }
  if (credential) {
    credential.name = name;
    if (credential.apiKey !== apiKey) {
      credential.apiKey = apiKey;
      credential.coins = "";
      credential.balance = "";
      credential.apiType = "";
      credential.supportsParallel = false;
    }
    credential.status = "unchecked";
    credential.errorMessage = "";
    credential.checkedAt = 0;
  } else {
    credential = normalizeRhCredential({
      id: makeRhCredentialId(),
      name: name,
      site: site,
      apiKey: apiKey,
      status: "unchecked",
      createdAt: Date.now()
    });
    if (credential) credentials.push(credential);
  }
  saveRhCredentials(credentials);
  hideRhCredentialEditor();
  renderRhCredentials();
  await refreshRhCredential(credential.id, false);
}

function deleteRhCredential(credentialId) {
  var credentials = loadRhCredentials();
  var credential = findRhCredentialById(credentials, credentialId);
  if (!credential) return;
  if (typeof confirm === "function" && !confirm("确定删除凭据「" + credential.name + "」吗？")) return;
  var activeId = localStorage.getItem(SETTINGS_KEYS.activeRhCredentialId) || "";
  for (var i = credentials.length - 1; i >= 0; i--) {
    if (credentials[i].id === credentialId) credentials.splice(i, 1);
  }
  if (activeId === credentialId) {
    var next = null;
    for (var j = 0; j < credentials.length; j++) {
      if (credentials[j].status === "ready") { next = credentials[j]; break; }
    }
    if (next) localStorage.setItem(SETTINGS_KEYS.activeRhCredentialId, next.id);
    else localStorage.removeItem(SETTINGS_KEYS.activeRhCredentialId);
  }
  saveRhCredentials(credentials);
  hideRhCredentialEditor();
  renderRhCredentials();
  refreshRunButton();
  setStatus("已删除凭据「" + credential.name + "」", "ok");
}

function showComfyuiConnectionStatus(ok, message) {
  var display = $("comfyuiConnectionStatus");
  if (!display) return;
  display.style.display = "block";
  while (display.firstChild) display.removeChild(display.firstChild);
  var badge = document.createElement("span");
  badge.className = "balance-badge " + (ok ? "ok" : "err");
  badge.textContent = message;
  display.appendChild(badge);
}

async function testComfyuiConnection() {
  var input = $("settingComfyuiUrl");
  var button = $("btnTestComfyui");
  var comfyuiUrl = String(input ? input.value : "").replace(/^\s+|\s+$/g, "");
  if (!comfyuiUrl) {
    showComfyuiConnectionStatus(false, "请输入 ComfyUI 地址");
    return;
  }

  var originalText = button ? button.textContent : "测试连接";
  if (button) { button.disabled = true; button.textContent = "检测中…"; }
  try {
    var settings = loadSettings();
    var response = await fetchWithTimeout(
      settings.bridgeUrl.replace(/\/+$/, "") + "/test-comfyui",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comfyuiUrl: comfyuiUrl }),
      },
      8000
    );
    if (response.status === 404) {
      showComfyuiConnectionStatus(false, "本地桥版本过旧，请更新后重启桥");
      return;
    }
    var data = await response.json();
    if (data && data.ok) {
      showComfyuiConnectionStatus(
        true,
        "已连接" + (data.version ? " · ComfyUI " + data.version : "")
      );
    } else {
      showComfyuiConnectionStatus(
        false,
        data && data.message ? data.message : "ComfyUI 连接失败"
      );
    }
  } catch (_) {
    showComfyuiConnectionStatus(false, "桥连接失败或检测超时");
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
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
  var comfyuiUrl = ($("settingComfyuiUrl") ? $("settingComfyuiUrl").value : "").trim();
  var aigateToken = _getAigateToken();
  var gptImageApiKey = ($("settingGptImageApiKey") ? $("settingGptImageApiKey").value : "").trim();
  var gptImageLocalValidation = !!($("settingGptImageLocalValidation") && $("settingGptImageLocalValidation").checked);
  var rhLocalDebug = !!($("settingRhLocalDebug") && $("settingRhLocalDebug").checked);
  var autoStartBridge = !($("settingAutoStartBridge")) || !!$("settingAutoStartBridge").checked;
  var backend = _segGet("segBackend") || "runninghub";
  var gptImageAuth = _segGet("segGptImageAuth") || "codex";
  var cacheMode = _segGet("segCachePath") || "default";

  var theme = _segGet("segTheme") || "dark";
  applyTheme(theme);

  saveSetting("bridgeUrl", bridgeUrl);
  saveSetting("backend", backend);
  saveSetting("comfyuiUrl", comfyuiUrl);
  saveSetting("aigateToken", aigateToken);
  saveSetting("gptImageAuth", gptImageAuth);
  saveSetting("gptImageApiKey", gptImageApiKey);
  saveSetting("gptImageLocalValidation", gptImageLocalValidation ? "true" : "false");
  saveSetting("rhLocalDebug", rhLocalDebug ? "true" : "false");
  saveSetting("autoStartBridge", autoStartBridge ? "true" : "false");
  saveSetting("theme", theme);
  saveSetting("cacheMode", cacheMode);
  renderWorkflowDescription(findWorkflow(_selectedWorkflowId));
}

