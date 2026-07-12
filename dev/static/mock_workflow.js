/*
 * mock_workflow.js — Demo 模式 UI 增强
 * - 添加 DEMO 标记
 * - 自动设置 mock 选区(让「运行」按钮直接可用)
 * - 可选:在预览区绘制演示缩略图
 */
(function () {
  console.log("[ComfyPS Dev] Demo 模式已激活");

  function addDemoBadge() {
    const header = document.querySelector("header");
    if (!header) return;
    const badge = document.createElement("span");
    badge.id = "demoBadge";
    badge.textContent = "DEMO";
    Object.assign(badge.style, {
      fontSize: "10px",
      fontWeight: "700",
      padding: "1px 6px",
      borderRadius: "3px",
      background: "#7c3aed",
      color: "#fff",
      marginLeft: "6px",
      verticalAlign: "middle",
    });
    header.appendChild(badge);
  }

  // 模拟画选区 — 让 __mock_photoshop 的 activeDocument._selection 为非 null
  function seedMockSelection() {
    if (window.__mock_photoshop?.app?.activeDocument) {
      window.__mock_photoshop.app.activeDocument._selection = {
        x: 100,
        y: 100,
        w: 312,
        h: 312,
      };
    }
  }

  // 把 demo 图(若有)画到预览 canvas
  async function drawPreviewThumbnails() {
    const canvasImg = document.getElementById("previewImage");
    const canvasMask = document.getElementById("previewMask");
    if (!canvasImg && !canvasMask) return;

    const demoBytes = window.__comfyps_demo_image;
    if (!demoBytes) return;

    const blob = new Blob([demoBytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      for (const c of [canvasImg, canvasMask]) {
        if (!c) continue;
        const ctx = c.getContext("2d");
        const w = c.width || 120;
        const h = c.height || 120;
        c.width = w;
        c.height = h;
        ctx.drawImage(img, 0, 0, w, h);
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // DOM 就绪后执行
  function whenReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  whenReady(() => {
    addDemoBadge();
    seedMockSelection();
    // 稍延迟画预览(等 demo 图加载完)
    setTimeout(drawPreviewThumbnails, 800);
  });
})();
