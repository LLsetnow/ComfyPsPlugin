# ComfyPS

**Photoshop (UXP) 插件**，将当前图层和选区发送到 AI 工作流执行，结果存入本地工作队列，可按需导入为新图层。

支持三条后端路径：
- **RunningHub** — 云端 ComfyUI 工作流（局部编辑 / 背景去杂物 / 面部重绘）
- **本地 ComfyUI** — 本机 GPU 工作流
- **GPT Image** — OpenAI `gpt-image-2`，通过 Codex 订阅或自有 API Key

---

## 架构

```
Photoshop 面板 (UXP)
  ├─ 导出图层 / 选区蒙版 → base64 PNG
  ├─ POST /run 或 /gpt-image
  │
  ▼
本地桥 bridge.py (Python aiohttp, 127.0.0.1:8765)
  ├─ RunningHub: rh_cli → /task/openapi/create → 轮询 → 下载结果
  ├─ 本地 ComfyUI: HTTP → 127.0.0.1:8188
  └─ GPT Image: OpenAI API / Codex CLI
  │
  ▼
结果 PNG → 插件工作队列（本地磁盘缓存）→ 按需导入为 PS 图层
```

---

## 工作流

| ID | 名称 | 后端 | 需要选区 |
|----|------|------|----------|
| `inpaint` | 局部编辑 | RunningHub / ComfyUI | 是 |
| `cleanup` | 背景去杂物 | RunningHub / ComfyUI | 否 |
| `face` | 面部重绘 | RunningHub / ComfyUI | 否 |
| `gpt-image` | GPT Image | OpenAI gpt-image-2 | 编辑模式需要 |

---

## 工作队列

提交任务后结果先保存到本地磁盘，不立即导入。队列卡片显示每个任务的缩略图和状态，选中后可：

- **导入** — 将结果贴回为当前文档的新图层（含选区蒙版）
- **预览** — 全屏查看结果图
- **停止** — 取消正在运行的任务（RunningHub 会调用 `/task/openapi/cancel` 真实终止）
- **删除** — 从队列中移除已完成 / 失败 / 已停止的任务

结果文件存储路径（可在设置中自定义）：
```
<缓存根目录>/<PS文档名>/<任务ID>/result.png
                                  mask.png   (有选区时)
```

---

## 快速开始

### 1. 安装依赖

```bash
python -m venv .venv && source .venv/bin/activate
pip install git+https://github.com/LLsetnow/RH_CLI.git
pip install aiohttp
```

### 2. 配置桥

```bash
cp bridge/config.example.json bridge/config.json
# 编辑 config.json：填入 workflowId / imageNodeId / maskNodeId
```

### 3. 启动桥

```bash
source .venv/bin/activate
python bridge/bridge.py
# → http://127.0.0.1:8765
```

### 4. 安装插件到 Photoshop

将 `plugin/` 目录拷贝到：
```
~/Library/Application Support/Adobe/UXP/Plugins/External/com.llsetnow.comfyps_1.0.0/
```
在 Photoshop 中重新加载面板。

---

## GPT Image

工作流页选择「GPT Image」，支持三种模式：

| 模式 | 说明 |
|------|------|
| 文生图 | 填关键词，选比例和分辨率，不依赖当前图层 |
| 添加参考图 | 从图层列表选 1–2 个图层作为参考 |
| 图像编辑 | 裁切活动图层选区外接矩形上传，结果按原坐标贴回 |

认证方式（设置页）：
- **Codex 订阅** — 本机 `codex login` 后使用，无需 API Key
- **OpenAI API Key** — 直接调用 `gpt-image-2`

### 本地验证模式

设置页开启「本地验证模式」后，不发起任何网络请求，仅在本机执行裁切→贴回→蒙版流程，用于验证 Photoshop 端坐标和蒙版逻辑。

---

## 设置项

| 项目 | 说明 |
|------|------|
| 后端 | RunningHub / 本地 ComfyUI |
| RunningHub 站点 | cn / ai |
| RunningHub API Key | 按工作流单独配置 |
| Bridge 地址 | 默认 `http://127.0.0.1:8765` |
| GPT Image 认证 | Codex 订阅 / OpenAI API Key |
| 本地验证模式 | 不调用 API，仅验证 PS 端流程 |
| 结果缓存路径 | 工作队列结果文件的存储根目录 |

---

## API 端点（本地桥）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/run` | 执行 RunningHub / ComfyUI 工作流 |
| POST | `/cancel` | 取消 RunningHub 任务 |
| GET | `/progress?taskId=` | 任务进度轮询 |
| POST | `/restart` | 重启桥进程 |
| POST | `/test-key` | 测试 RunningHub API Key |
| POST | `/gpt-image` | 执行 GPT Image 任务 |
| POST | `/gpt-image/cancel` | 取消 GPT Image 任务 |
| POST | `/gpt-image/status` | 查询 GPT Image 任务状态 |

---

## 目录结构

```
plugin/         UXP 插件
  index.html    三页面 UI（主页 / 工作流 / 设置）
  main.js       核心逻辑
  manifest.json UXP 清单
bridge/         本地桥
  bridge.py     aiohttp HTTP 服务
  config.json   私有配置（gitignored）
dev/            开发服务器（浏览器预览 + 热更新）
workflows/      ComfyUI 工作流 JSON（API 格式）
```

---

## 开发

```bash
# 浏览器预览（mock API + 热更新）
python dev/dev_server.py    # → http://127.0.0.1:8765

# 同步到 PS 插件目录
cp plugin/main.js ~/Library/Application\ Support/Adobe/UXP/Plugins/External/com.llsetnow.comfyps_1.0.0/main.js
cp plugin/index.html ~/Library/Application\ Support/Adobe/UXP/Plugins/External/com.llsetnow.comfyps_1.0.0/index.html
```

**UXP 兼容性**：面板 JS 引擎为不完整 ES5，禁止 `const`/`let`/箭头函数/模板字符串/`Array.find()`/`Object.assign()`。

---

## 许可证

MIT
