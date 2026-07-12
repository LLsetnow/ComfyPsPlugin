/*
 * mock_uxp.js — 浏览器端模拟 require("uxp").storage
 * 提供: localFileSystem, formats
 *
 * 用内存 Map 充当虚拟文件系统; 预加载 demo 图像供 mock_photoshop 使用。
 */
(function () {
  // 共享 VFS (mock_photoshop 也会读写)
  const _vfs = (window.__mock_uxp_vfs = window.__mock_uxp_vfs || new Map());

  const formats = { binary: "binary" };

  class MockFile {
    constructor(nativePath) {
      this.nativePath = nativePath;
    }
    async read(opts) {
      const data = _vfs.get(this.nativePath);
      if (!data) throw new Error("File not found: " + this.nativePath);
      return data;
    }
    async write(data) {
      _vfs.set(this.nativePath, data);
    }
  }

  class MockFolder {
    constructor(path) {
      this._path = path;
    }
    async createFile(name, opts) {
      const fullPath = this._path + "/" + name;
      if (opts?.overwrite) _vfs.delete(fullPath);
      return new MockFile(fullPath);
    }
  }

  const localFileSystem = {
    async getDataFolder() {
      return new MockFolder("/mock-data/comfyps");
    },
    async createSessionToken(file) {
      return file.nativePath;
    },
  };

  // 预加载 demo 图 — 从 dev server 的 /demo-image.png 拉取
  (async function preloadDemoImage() {
    try {
      const resp = await fetch("/demo-image.png");
      if (resp.ok) {
        window.__comfyps_demo_image = await resp.arrayBuffer();
      }
    } catch (e) {
      console.warn("[mock_uxp] 无法预加载 demo 图:", e.message);
    }
  })();

  window.__mock_uxp = { storage: { localFileSystem, formats } };
})();
