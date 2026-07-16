/*
 * mock_photoshop.js — 浏览器端模拟 require("photoshop")
 * 提供: app, core, action (batchPlay), imaging
 *
 * 核心是 batchPlay descriptor handler, 按 _obj 分发处理 main.js 中
 * exportActiveDocPNG / exportSelectionMaskPNG / placeImageBytesAsLayer
 * 发出的所有 action descriptor。
 */
(function () {
  // -------------------------------------------------------------------
  // Mock 文档状态
  // -------------------------------------------------------------------
  const MOCK_LAYERS = [
    { id: 1, name: "产品主体", visible: true },
    {
      id: 2,
      name: "环境组",
      visible: true,
      layers: [
        { id: 3, name: "背景", visible: true },
        { id: 4, name: "光影", visible: true },
      ],
    },
  ];
  const MOCK_DOC = {
    width: 512,
    height: 512,
    name: "demo-document.psd",
    resolution: 72,
    bitsPerChannel: 8,
    mode: "RGBColor",
    layers: MOCK_LAYERS,
    activeLayers: [MOCK_LAYERS[0]],
    _selection: null, // null = 无选区; {x,y,w,h}
  };

  // -------------------------------------------------------------------
  // app
  // -------------------------------------------------------------------
  const app = {
    get activeDocument() {
      return MOCK_DOC._closed ? null : MOCK_DOC;
    },
  };

  // -------------------------------------------------------------------
  // core
  // -------------------------------------------------------------------
  const core = {
    executeAsModal(fn, _options) {
      return fn();
    },
  };

  // -------------------------------------------------------------------
  // action — batchPlay
  // -------------------------------------------------------------------
  // 虚拟状态(在闭包内,各 handler 共享)
  let _virtualLayers = [];
  let _nextLayerId = 1;
  let _selectionChannel = null; // 已保存的选区通道名
  let _lastFillColor = null;
  // 存到"文件"的内容: token → ArrayBuffer
  const _vfs = (window.__mock_uxp_vfs = window.__mock_uxp_vfs || new Map());

  async function _handleDescriptor(desc) {
    switch (desc._obj) {
      // ---- save ----
      case "save": {
        const token = desc.in?._path;
        const pngData = _renderCanvasToPNG();
        _vfs.set(token, pngData);
        return { _obj: "save" };
      }

      // ---- duplicate channel / layer / document ----
      case "duplicate": {
        const ref = desc._target?.[0];
        if (ref?._ref === "channel" && ref?._property === "selection") {
          if (!MOCK_DOC._selection) {
            throw new Error("请先做一个选区(未检测到选区)");
          }
          _selectionChannel = desc.name || "comfyps_sel";
        }
        if (ref?._ref === "document") {
          MOCK_DOC._hasDuplicate = true;
        }
        if (ref?._ref === "layer") {
          const layer = {
            id: _nextLayerId++,
            name: "Layer " + _virtualLayers.length + " copy",
            visible: true,
          };
          _virtualLayers.push(layer);
          MOCK_DOC.activeLayers = [layer];
        }
        return { _obj: "duplicate" };
      }

      // ---- get selection bounds ----
      case "get": {
        const property = desc._target?.[0]?._property;
        if (property === "selection") {
          if (!MOCK_DOC._selection) throw new Error("请先做一个选区(未检测到选区)");
          const s = MOCK_DOC._selection;
          return {
            selection: {
              left: { _unit: "pixelsUnit", _value: s.x },
              top: { _unit: "pixelsUnit", _value: s.y },
              right: { _unit: "pixelsUnit", _value: s.x + s.w },
              bottom: { _unit: "pixelsUnit", _value: s.y + s.h },
            },
          };
        }
        return { _obj: "get" };
      }

      // ---- crop duplicated document ----
      case "crop":
        return { _obj: "crop" };

      // ---- close duplicated document ----
      case "close":
        MOCK_DOC._hasDuplicate = false;
        return { _obj: "close" };

      // ---- make (新图层 / 图层蒙版) ----
      case "make": {
        if (desc.new?._class === "channel" && desc.at?._value === "mask") {
          const activeLayer = MOCK_DOC.activeLayers[0];
          if (activeLayer) activeLayer._hasUserMask = true;
          return { _obj: "make" };
        }
        const layer = {
          id: _nextLayerId++,
          name: "Layer " + _virtualLayers.length,
        };
        _virtualLayers.push(layer);
        MOCK_DOC.activeLayers = [layer];
        return {
          _obj: "make",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        };
      }

      // ---- fill ----
      case "fill":
        _lastFillColor = desc.using?._value;
        return { _obj: "fill" };

      // ---- set ----
      case "set": {
        const ref = desc._target?.[0];
        if (ref?._ref === "channel" && ref?._property === "selection") {
          if (desc.to?._enum === "ordinal") {
            if (desc.to._value === "allEnum")
              MOCK_DOC._selection = { x: 0, y: 0, w: MOCK_DOC.width, h: MOCK_DOC.height };
            else if (desc.to._value === "none") MOCK_DOC._selection = null;
          } else if (desc.to?._ref === "channel" && desc.to._name === _selectionChannel) {
            // 从通道恢复选区
            MOCK_DOC._selection = { x: 100, y: 100, w: 312, h: 312 };
          }
        } else if (ref?._ref === "layer") {
          const name = desc.to?.name;
          if (name && _virtualLayers.length > 0) {
            _virtualLayers[_virtualLayers.length - 1].name = name;
          }
        }
        return { _obj: "set" };
      }

      // ---- delete ----
      case "delete": {
        const ref = desc._target?.[0];
        if (ref?._ref === "layer") {
          _virtualLayers.pop();
        } else if (ref?._ref === "channel") {
          _selectionChannel = null;
        }
        return { _obj: "delete" };
      }

      // ---- placeEvent ----
      case "placeEvent": {
        const token = (desc.target || desc.null)?._path;
        const layer = {
          id: _nextLayerId++,
          name: "Placed",
          token,
          offset: desc.offset,
          bounds: { left: 0, top: 0, width: MOCK_DOC.width, height: MOCK_DOC.height },
        };
        _virtualLayers.push(layer);
        MOCK_DOC.activeLayers = [layer];
        return { _obj: "placeEvent" };
      }

      // ---- move (Action Manager fallback for layer.translate) ----
      case "move": {
        const layer = MOCK_DOC.activeLayers[0];
        const offset = desc.to;
        if (layer && layer.bounds && offset) {
          layer.bounds.left += offset.horizontal?._value || 0;
          layer.bounds.top += offset.vertical?._value || 0;
        }
        return { _obj: "move" };
      }

      default:
        console.warn("[mock_photoshop] unhandled batchPlay _obj:", desc._obj, desc);
        return { _obj: desc._obj };
    }
  }

  function _renderCanvasToPNG() {
    // 返回预加载的 demo 图; 若未就绪则生成简单纯色图
    if (window.__comfyps_demo_image && window.__comfyps_demo_image.byteLength > 0) {
      return window.__comfyps_demo_image;
    }
    // 最小后备: 1x1 蓝色 PNG (67 bytes)
    const minimalPNG = new Uint8Array([
      0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
      0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
      0xde,0x00,0x00,0x00,0x0c,0x49,0x44,0x41,0x54,0x08,0xd7,0x63,0x60,0x60,0x60,0x00,
      0x00,0x00,0x04,0x00,0x01,0x5c,0x5a,0x53,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,
      0xae,0x42,0x60,0x82,
    ]).buffer;
    return minimalPNG;
  }

  const action = {
    batchPlay: async function (descriptors, _options) {
      const results = [];
      for (const desc of descriptors) {
        results.push(await _handleDescriptor(desc));
      }
      return results;
    },
  };

  // -------------------------------------------------------------------
  // imaging — 模拟 photoshop.imaging 的无切换裁切读取
  // getPixels: 返回 sourceBounds 区域的 RGBA 像素(合成渐变图)
  // getSelection: 返回选区蒙版(选区内=255 白, 选区外=0 黑)
  // -------------------------------------------------------------------
  function _makeImageData(width, height, components, data) {
    return {
      width,
      height,
      components,
      componentSize: 8,
      colorSpace: components >= 3 ? "RGB" : "Grayscale",
      hasAlpha: components === 4 || components === 2,
      pixelFormat: components === 4 ? "RGBA" : components >= 3 ? "RGB" : "Grayscale",
      async getData() {
        return data;
      },
      dispose() {},
    };
  }

  function _rectFromBounds(b) {
    const left = b.left | 0;
    const top = b.top | 0;
    const right = b.right !== undefined ? b.right | 0 : left + (b.width | 0);
    const bottom = b.bottom !== undefined ? b.bottom | 0 : top + (b.height | 0);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  const imaging = {
    async getPixels(options) {
      const b = _rectFromBounds(options.sourceBounds || {
        left: 0, top: 0, right: MOCK_DOC.width, bottom: MOCK_DOC.height,
      });
      const w = b.width, h = b.height;
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          data[o] = Math.round(((b.left + x) * 255) / Math.max(1, MOCK_DOC.width - 1));
          data[o + 1] = Math.round(((b.top + y) * 255) / Math.max(1, MOCK_DOC.height - 1));
          data[o + 2] = 128;
          data[o + 3] = 255;
        }
      }
      return {
        imageData: _makeImageData(w, h, 4, data),
        sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      };
    },
    async getSelection(options) {
      const sel = MOCK_DOC._selection;
      const b = _rectFromBounds(options.sourceBounds || {
        left: 0, top: 0, right: MOCK_DOC.width, bottom: MOCK_DOC.height,
      });
      const w = b.width, h = b.height;
      const data = new Uint8Array(w * h);
      if (sel) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ax = b.left + x, ay = b.top + y;
            const inside = ax >= sel.x && ax < sel.x + sel.w && ay >= sel.y && ay < sel.y + sel.h;
            data[y * w + x] = inside ? 255 : 0;
          }
        }
      }
      return {
        imageData: _makeImageData(w, h, 1, data),
        sourceBounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      };
    },
    async encodeImageData(_options) {
      throw new Error("mock encodeImageData 未实现(插件应使用内置 PNG 编码)");
    },
  };

  // -------------------------------------------------------------------
  // 暴露到 window
  // -------------------------------------------------------------------
  window.__mock_photoshop = { app, core, action, imaging };
})();
