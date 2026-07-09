/*
 * ComfyPS — UXP 面板逻辑
 * 职责很轻:导出「当前图层」+「选区蒙版」两张图 → 发本地桥 → 结果贴成新图层。
 * 裁切/inpaint/放大/羽化合成全部在 RunningHub 工作流内部完成。
 */
const { app, core, action, imaging } = require("photoshop");
const { localFileSystem } = require("uxp").storage;

const executeAsModal = core.executeAsModal;
const batchPlay = action.batchPlay;

const $ = (id) => document.getElementById(id);

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
// 导出「当前图层」为画布对齐的 base64 PNG(纯 base64,无 data: 前缀)
// ---------------------------------------------------------------------------
async function exportActiveLayerPNG() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  const layers = doc.activeLayers;
  if (!layers || layers.length === 0) throw new Error("请先选中一个图层");
  const layerID = layers[0].id;
  const width = asPixels(doc.width);
  const height = asPixels(doc.height);
  const bounds = { left: 0, top: 0, right: width, bottom: height };

  let base64;
  await executeAsModal(
    async () => {
      const pix = await imaging.getPixels({
        documentID: doc.id,
        layerID,
        sourceBounds: bounds, // 画布对齐:与选区蒙版同坐标系
        targetSize: { width, height },
        componentSize: 8,
        applyAlpha: true,
        colorProfile: "sRGB IEC61966-2.1",
        colorSpace: "RGB",
      });
      try {
        base64 = await imaging.encodeImageData({
          imageData: pix.imageData,
          format: "png",
          base64: true,
        });
      } finally {
        pix.imageData.dispose();
      }
    },
    { commandName: "导出当前图层" }
  );
  return base64;
}

// ---------------------------------------------------------------------------
// 导出「当前选区」为画布对齐的灰度蒙版 base64 PNG(白=选中)
// ---------------------------------------------------------------------------
async function exportSelectionMaskPNG() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  const width = asPixels(doc.width);
  const height = asPixels(doc.height);
  const bounds = { left: 0, top: 0, right: width, bottom: height };

  let base64;
  await executeAsModal(
    async () => {
      let sel;
      try {
        sel = await imaging.getSelection({
          documentID: doc.id,
          sourceBounds: bounds,
          targetSize: { width, height }, // 强制画布尺寸,保证与图层对齐
        });
      } catch (e) {
        throw new Error("请先做一个选区(未检测到选区)");
      }
      try {
        base64 = await imaging.encodeImageData({
          imageData: sel.imageData,
          format: "png",
          base64: true,
        });
      } finally {
        sel.imageData.dispose();
      }
    },
    { commandName: "导出选区蒙版" }
  );
  if (!base64) throw new Error("请先做一个选区");
  return base64;
}

// ---------------------------------------------------------------------------
// 调用本地桥:发 {image, mask},拿回结果 PNG 的字节
// ---------------------------------------------------------------------------
async function callBridge(bridgeUrl, imageB64, maskB64) {
  const url = bridgeUrl.replace(/\/+$/, "") + "/run";
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageB64, mask: maskB64 }),
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
async function onRunClick() {
  const btn = $("runBtn");
  btn.disabled = true;
  try {
    const bridgeUrl = $("bridgeUrl").value.trim() || "http://127.0.0.1:8765";
    localStorage.setItem("comfyps.bridgeUrl", bridgeUrl);

    if (!app.activeDocument) throw new Error("没有打开的文档");

    setStatus("导出图层与选区…");
    const imageB64 = await exportActiveLayerPNG();
    const maskB64 = await exportSelectionMaskPNG();

    setStatus("云端处理中…(inpaint 较慢,请稍候)");
    const resultBuffer = await callBridge(bridgeUrl, imageB64, maskB64);

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
  const saved = localStorage.getItem("comfyps.bridgeUrl");
  if (saved) $("bridgeUrl").value = saved;
  $("runBtn").addEventListener("click", onRunClick);
})();
