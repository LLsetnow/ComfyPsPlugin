# ComfyPS — Photoshop AI 工作流插件

Photoshop (UXP) 插件，通过本地 Python 桥将图层/选区发送到 RunningHub 或本地 ComfyUI 执行 AI 工作流，结果贴回新图层。

## Git Workflow

### CRITICAL: Never commit directly to `main`

**所有改动必须通过 Pull Request。** 包括 Claude Code、Codex agent、人类开发者。

- NEVER `git push origin main` 直接推送
- NEVER 直接 commit 到 `main` — 必须先创建 feature/fix 分支
- 任何改动（包括 typo、配置、revert）都需要 PR

### Branching

```bash
# 始终从最新的 main 分支出去
git checkout main && git pull origin main
git checkout -b feat/xxx       # 新功能
git checkout -b fix/xxx        # 修复
git checkout -b docs/xxx       # 文档
```

保持分支短生命周期。

### Staying in Sync

Push 或开 PR 前，rebase 到最新的 main：

```bash
git fetch origin
git rebase origin/main
```

### Pull Requests

- Target branch: `main`
- **使用 merge commit，禁止 squash merge**
- Push 前 rebase 到最新 main 避免冲突

### Why No Squash Merge

Squash merge 会破坏分支与 main 的共享历史，导致 git 无法正确追踪哪些文件是你改的、哪些来自 main，造成：
1. 未触碰的文件出现冲突
2. 已合并的改动被静默覆盖

## 架构

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

## 开发规则

### UXP 兼容性 (CRITICAL)

Photoshop UXP 面板的 JS 引擎不完整，必须兼容 ES5：

- ❌ `const` / `let` → ✅ `var`
- ❌ 箭头函数 `() =>` → ✅ `function() {}`
- ❌ `Array.find()` → ✅ `for` 循环手动查找
- ❌ `NodeList.forEach()` → ✅ `for (var i=0; i<list.length; i++)`
- ❌ `Object.assign()` → ✅ 手动属性拷贝
- ❌ CSS `display: grid` → ✅ `display: flex` + `flex-wrap`
- ❌ 模板字符串 `` `...` `` → ✅ 字符串拼接

### Python 桥

- 基于 aiohttp + rh_cli（从 GitHub 安装）
- 依赖：`pip install git+https://github.com/LLsetnow/RH_CLI.git`
- `bridge/config.json` 在 .gitignore 中（含私有 workflowId）

### 工作流定义

每个工作流在 main.js 的 `WORKFLOWS` 数组中定义：

```js
{
  id: "inpaint",
  name: "局部编辑",
  icon: "🖌",
  active: true,           // false = 灰色占位"即将推出"
  needsMask: true,        // 是否需要选区蒙版
  workflowId: "2075...",
  workflowFile: "../workflows/inpaint_api.json",
  imageNodeId: "41",      // LoadImage 节点号
  description: "使用说明文字",
  inputs: [...],          // 输入控件定义
  setArgs: function(inputs) { return [...]; },  // 额外参数注入
}
```

## 本地开发

```bash
# 开发模式 (浏览器预览 + 热更新)
python dev/dev_server.py          # → http://127.0.0.1:8765

# 生产模式 (真实桥，连接 PS 和 RunningHub)
python bridge/bridge.py           # → http://127.0.0.1:8765
```

### 安装到 Photoshop

插件目录：`~/Library/Application Support/Adobe/UXP/Plugins/External/com.llsetnow.comfyps_1.0.0/`
更新文件后需在 PS 中重新加载面板。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 桥健康检查 |
| POST | `/run` | 执行工作流 `{image, mask?, prompt, backend, site?, apiKey?, workflowId, workflowFile, imageNodeId, needsMask, extraSetArgs?}` |
| POST | `/restart` | 重启桥进程 |
| POST | `/test-key` | 测试 API Key `{apiKey, site}` → `{ok, status, balance, coins, api_type}` |
| GET | `/progress?taskId=xxx` | 任务进度轮询 `{percent, message}` |

## 工作流

| id | 名称 | needsMask | imageNodeId |
|----|------|-----------|-------------|
| inpaint | 局部编辑 | yes | 41 |
| cleanup | 背景去杂物 | no | 41 |
| face | 面部重绘 | no | 27 |
