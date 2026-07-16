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

**提交 PR/MR 前必须先 rebase 到最新的 `main`，并确认 rebase 过程没有冲突后，才能提交 PR/MR。**

```bash
git fetch origin
git rebase origin/main
```

如发生冲突，必须先解决冲突并完成 rebase；未完成或仍有冲突时不得提交 PR/MR。

### Pull Requests

- Target branch: `main`
- **使用 merge commit，禁止 squash merge**
- 提交 PR/MR 前先 `git rebase origin/main`，确认无冲突后再 push 和提交

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

## CI

PR 到 `main` 时自动运行 `ci.yml`：
- **Python 语法检查** — `py_compile` bridge.py + dev_server.py
- **Workflow JSON 校验** — 确保工作流文件是合法 JSON
- **UXP ES5 检测** — 扫描 main.js 禁止 `const`/`let`/`=>`/`.find()`/`Object.assign`/`classList.toggle(bool)`

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

**该目录下的文件已用符号链接指向仓库 `plugin/`（单一真源，2026-07-16 起）：**

```
com.llsetnow.comfyps_1.0.0/
  main.js       -> <repo>/plugin/main.js
  index.html    -> <repo>/plugin/index.html
  manifest.json -> <repo>/plugin/manifest.json
  icons         -> <repo>/plugin/icons
```

因此：

- **改完 `plugin/` 下的文件无需再手动同步 / cp。** 符号链接下 `cp plugin/main.js <目标>` 会因“源与目标是同一文件”报错，不要再执行，也不要在完成插件改动后自动 cp。
- **每次全新启动 PS 都会自动加载仓库最新版。**
- PS 已经开着时改文件不会热更新——需在 PS 中**重新加载面板**（增效工具菜单重载 / 关闭再打开面板）或重启 PS。边写边看请用 `dev/dev_server.py` 浏览器预览（真正热更新）。

首次搭建 / 还原符号链接：删除目录内真实文件后 `ln -s "<repo>/plugin/main.js" "<目标>/main.js"`（index.html / manifest.json / icons 同理）。原始真实文件的备份**不要放在 `External/` 内**，否则会被 PS 当成重复插件。

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
