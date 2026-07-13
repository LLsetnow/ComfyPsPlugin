# CLAUDE.md

## ComfyPS — Photoshop AI 工作流插件

Photoshop (UXP) 插件，通过本地 Python 桥将图层/选区发送到 RunningHub 或本地 ComfyUI 执行 AI 工作流，结果贴回新图层。

### 架构

```
plugin/         UXP 插件 (Photoshop 面板)
  index.html    → 三页面 UI (主页 / 工作流 / 设置)
  main.js       → 核心逻辑 (导出/调用/贴回 + 工作流系统)
  manifest.json → UXP 清单
bridge/         本地桥 (Python aiohttp)
  bridge.py     → HTTP API (/run /health /restart /test-key /progress)
  config.json   → 默认 workflowId / imageNodeId / maskNodeId (gitignored)
dev/            开发服务器
  dev_server.py → 浏览器热更新预览 + mock API
  static/       → mock_photoshop.js / mock_uxp.js / mock_workflow.js / hot_reload.js
workflows/      ComfyUI 工作流 JSON (API 格式)
```

### 开发规则

- **不能直接 commit 到 main**。必须 branch out 新分支，提交 PR 合并。
- UXP 插件必须兼容 ES5（无 `const`、箭头函数、`Array.find`、`NodeList.forEach`、`Object.assign`、CSS Grid）。
- Python 桥基于 aiohttp + rh_cli，无需额外 pip 包。
- `bridge/config.json` 在 .gitignore 中，含私有 workflowId。
- 每个工作流在 main.js 的 `WORKFLOWS` 数组中定义（id / name / icon / active / needsMask / workflowId / workflowFile / imageNodeId / inputs / setArgs / description）。

### 本地开发

```bash
# 开发模式 (浏览器预览 + 热更新)
python dev/dev_server.py          # → http://127.0.0.1:8765

# 生产模式 (真实桥，连接 PS 和 RunningHub)
python bridge/bridge.py           # → http://127.0.0.1:8765
```

### 安装到 Photoshop

插件目录：`~/Library/Application Support/Adobe/UXP/Plugins/External/com.llsetnow.comfyps_1.0.0/`
更新文件后需在 PS 中重新加载面板。

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 桥健康检查 |
| POST | `/run` | 执行工作流 `{image, mask?, prompt, backend, site?, apiKey?, workflowId, workflowFile, imageNodeId, needsMask, extraSetArgs?}` |
| POST | `/restart` | 重启桥进程 |
| POST | `/test-key` | 测试 API Key `{apiKey, site}` → `{ok, status, balance, coins, api_type}` |
| GET | `/progress?taskId=xxx` | 任务进度轮询 `{percent, message}` |

### 工作流

| id | 名称 | needsMask | imageNodeId |
|----|------|-----------|-------------|
| inpaint | 局部编辑 | yes | 41 |
| cleanup | 背景去杂物 | no | 41 |
| face | 面部重绘 | no | 27 |
