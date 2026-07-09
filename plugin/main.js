/*
 * ComfyPS — UXP 面板逻辑
 * 职责很轻:导出「当前图层」+「选区蒙版」两张图 → 发本地桥 → 结果贴成新图层。
 * 裁切/inpaint/放大/羽化合成全部在 RunningHub 工作流内部完成。
 */
const { app, core, action, imaging } = require("photoshop");
const { localFileSystem, formats } = require("uxp").storage;

const executeAsModal = core.executeAsModal;
const batchPlay = action.batchPlay;

const PLUGIN_VERSION = "1.0.3";

const $ = (id) => document.getElementById(id);

// 无依赖 base64 编码(不依赖 btoa,避免 UXP 环境差异)
function bytesToBase64(arrayBuffer) {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.length;
  let out = "";
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B[b0 >> 2];
    out += B[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? B[b2 & 63] : "=";
  }
  return out;
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = kind; // "" | "ok" | "err"
}

// doc.width/height 在个别标尺单位下可能是对象,统一取像素数值
function asPixels(v) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return v._value ?? v.value ?? 0;
  return Number(v) || 0;
}

// ---------------------------------------------------------------------------
// 导出「整个文档合成图」为 base64 PNG(纯 base64,无 data: 前缀)
// 用最小参数(不带 layerID/targetSize/sourceBounds),避免图层尺寸与请求尺寸
// 不一致导致的 UXP 原生内存越界崩溃。整文档天然与选区蒙版同坐标、同尺寸。
// ---------------------------------------------------------------------------
async function exportActiveDocPNG() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");

  // 用 batchPlay「存副本为 PNG」到插件 data 目录(最稳,不碰 imaging 原生接口)
  const folder = await localFileSystem.getDataFolder();
  const file = await folder.createFile("comfyps_input.png", { overwrite: true });
  const token = await localFileSystem.createSessionToken(file);

  await executeAsModal(
    async () => {
      await batchPlay(
        [
          {
            _obj: "save",
            as: { _obj: "PNGFormat", method: { _enum: "PNGMethod", _value: "quick" } },
            in: { _path: token, _kind: "local" },
            copy: true,
            lowerCase: true,
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        {}
      );
    },
    { commandName: "导出文档PNG" }
  );

  const buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出的 PNG 为空");
  return bytesToBase64(buf);
}

// ---------------------------------------------------------------------------
// 导出「当前选区」为画布对齐的灰度蒙版 base64 PNG(白=选中)
// ---------------------------------------------------------------------------
async function exportSelectionMaskPNG() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");

  const folder = await localFileSystem.getDataFolder();
  const file = await folder.createFile("comfyps_mask.png", { overwrite: true });
  const token = await localFileSystem.createSessionToken(file);

  const noDialog = { dialogOptions: "dontDisplay" };
  const fill = (v) => ({
    _obj: "fill",
    using: { _enum: "fillContents", _value: v },
    opacity: { _unit: "percentUnit", _value: 100 },
    mode: { _enum: "blendMode", _value: "normal" },
    _options: noDialog,
  });
  const setSel = (to) => ({
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to,
    _options: noDialog,
  });

  await executeAsModal(
    async () => {
      // 1) 保存当前选区到通道(无选区则抛错)
      try {
        await batchPlay(
          [
            {
              _obj: "duplicate",
              _target: [{ _ref: "channel", _property: "selection" }],
              name: "comfyps_sel",
              _options: noDialog,
            },
          ],
          {}
        );
      } catch (e) {
        throw new Error("请先做一个选区(未检测到选区)");
      }

      // 2) 新建图层(置于当前图层上方)
      await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], _options: noDialog }], {});

      // 3) 全选填黑 → 载入选区填白 → 取消选区 → 存 PNG
      await batchPlay(
        [
          setSel({ _enum: "ordinal", _value: "allEnum" }),
          fill("black"),
          setSel({ _ref: "channel", _name: "comfyps_sel" }),
          fill("white"),
          setSel({ _enum: "ordinal", _value: "none" }),
          {
            _obj: "save",
            as: { _obj: "PNGFormat", method: { _enum: "PNGMethod", _value: "quick" } },
            in: { _path: token, _kind: "local" },
            copy: true,
            lowerCase: true,
            _options: noDialog,
          },
        ],
        {}
      );

      // 4) 清理:删蒙版图层、恢复用户选区、删通道(best-effort)
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

  const buf = await file.read({ format: formats.binary });
  if (!buf || buf.byteLength === 0) throw new Error("导出蒙版失败");
  return bytesToBase64(buf);
}

// ---------------------------------------------------------------------------
// 调用本地桥:发 {image, mask},拿回结果 PNG 的字节
// ---------------------------------------------------------------------------
async function callBridge(bridgeUrl, imageB64, maskB64, prompt) {
  const url = bridgeUrl.replace(/\/+$/, "") + "/run";
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, mask: maskB64, prompt: prompt || "" }),
    });
  } catch (e) {
    throw new Error(`连不上本地桥(${url}):${e && e.message ? e.message : e}。桥启动了吗?`);
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const j = JSON.parse(await resp.text());
      detail = j.message || j.error || JSON.stringify(j);
    } catch (_) {
      detail = `HTTP ${resp.status}`;
    }
    throw new Error("云端处理失败:" + detail);
  }
  return await resp.arrayBuffer();
}

// ---------------------------------------------------------------------------
// 把结果字节贴成新图层
// ---------------------------------------------------------------------------
async function placeImageBytesAsLayer(arrayBuffer, layerName) {
  const folder = await localFileSystem.getDataFolder();
  const file = await folder.createFile("comfyps_result.png", { overwrite: true });
  await file.write(arrayBuffer);
  const token = await localFileSystem.createSessionToken(file);

  await executeAsModal(
    async () => {
      await batchPlay(
        [
          {
            _obj: "placeEvent",
            target: { _path: token, _kind: "local" },
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

// ---------------------------------------------------------------------------
// 主编排
// ---------------------------------------------------------------------------
// 诊断开关:先只验证「导出画面」这一步是否稳定(不发网络、不导蒙版)。
// 确认不崩后改为 false 即恢复完整流程。
const DIAGNOSTIC_EXPORT_ONLY = false;

async function onRunClick() {
  const btn = $("runBtn");
  btn.disabled = true;
  try {
    if (!app.activeDocument) throw new Error("没有打开的文档");

    if (DIAGNOSTIC_EXPORT_ONLY) {
      setStatus("诊断:用文件方式导出画面…");
      const imageB64 = await exportActiveDocPNG();
      setStatus(
        `✅ 导出成功 ${Math.round(imageB64.length / 1024)}KB,未崩溃。` +
          `请告诉我这条消息,我就恢复完整流程。`,
        "ok"
      );
      return;
    }

    const bridgeUrl = $("bridgeUrl").value.trim() || "http://127.0.0.1:8765";
    const prompt = $("prompt").value;
    localStorage.setItem("comfyps.bridgeUrl", bridgeUrl);
    localStorage.setItem("comfyps.prompt", prompt);

    setStatus("导出画面与选区…");
    const imageB64 = await exportActiveDocPNG();
    const maskB64 = await exportSelectionMaskPNG();

    setStatus("云端处理中…(inpaint 较慢,请稍候)");
    const resultBuffer = await callBridge(bridgeUrl, imageB64, maskB64, prompt);

    setStatus("贴回结果…");
    await placeImageBytesAsLayer(resultBuffer, "ComfyPS 结果");

    setStatus("完成 ✓", "ok");
  } catch (e) {
    setStatus("失败:" + (e && e.message ? e.message : String(e)), "err");
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
(function init() {
  const savedUrl = localStorage.getItem("comfyps.bridgeUrl");
  if (savedUrl) $("bridgeUrl").value = savedUrl;
  const savedPrompt = localStorage.getItem("comfyps.prompt");
  if (savedPrompt) $("prompt").value = savedPrompt;
  $("runBtn").addEventListener("click", onRunClick);
  setStatus("ComfyPS v" + PLUGIN_VERSION + " 就绪:画选区后点运行");
})();
