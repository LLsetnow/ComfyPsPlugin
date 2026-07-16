/*
 * mock_uxp.js — 浏览器端模拟 require("uxp").storage
 * 提供: localFileSystem, formats
 *
 * 用内存 Map 充当虚拟文件系统; 预加载 demo 图像供 mock_photoshop 使用。
 */
(function () {
  // 共享 VFS (mock_photoshop 也会读写)
  const _vfs = (window.__mock_uxp_vfs = window.__mock_uxp_vfs || new Map());

  const formats = { binary: "binary", utf8: "utf8" };

  class MockFile {
    constructor(nativePath) {
      this.nativePath = nativePath;
      this.name = nativePath.split("/").pop();
      this.isFolder = false;
      this.isFile = true;
    }
    async read(opts) {
      const data = _vfs.get(this.nativePath);
      if (!data) throw new Error("File not found: " + this.nativePath);
      return data;
    }
    async write(data) {
      _vfs.set(this.nativePath, data);
    }
    async delete() {
      _vfs.delete(this.nativePath);
    }
  }

  class MockFolder {
    constructor(path) {
      this._path = path;
      this.nativePath = path;
      this.name = path.split("/").pop();
      this.isFolder = true;
      this.isFile = false;
    }
    async createFile(name, opts) {
      const fullPath = this._path + "/" + name;
      if (opts?.overwrite) _vfs.delete(fullPath);
      return new MockFile(fullPath);
    }
    // 历史扫描用；dev 里不模拟磁盘目录，返回空即可(逻辑会安全降级)。
    async getEntries() {
      return [];
    }
    async delete() {}
  }

  const localFileSystem = {
    async getDataFolder() {
      return new MockFolder("/mock-data/comfyps");
    },
    async getPluginFolder() {
      return new MockFolder("/mock-plugin/comfyps");
    },
    async getFolder() {
      return new MockFolder("/mock-custom/comfyps-results");
    },
    createPersistentToken(folder) {
      return folder.nativePath;
    },
    async getEntryForPersistentToken(token) {
      return new MockFolder(token);
    },
    getNativePath(entry) {
      return entry.nativePath;
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

  // shell — 模拟 uxp.shell（openPath/openExternal）
  const shell = {
    async openPath(path, developerText) {
      console.log("[mock_uxp] shell.openPath:", path, developerText ? "| " + developerText : "");
      // 返回空字符串表示成功（真实 UXP 语义）。
      return "";
    },
    async openExternal(url, developerText) {
      console.log("[mock_uxp] shell.openExternal:", url, developerText ? "| " + developerText : "");
      return "";
    },
  };

  window.__mock_uxp = { storage: { localFileSystem, formats }, shell };
})();
