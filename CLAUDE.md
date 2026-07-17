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

#### Rebase 安全规则（并行 / 多 agent 开发）

并行开发时 rebase 是「新内容被静默覆盖」的高发环节，必须遵守：

- **rebase / force-push 只用于你独占的短分支。** 别人或别的 agent（Claude Code / Codex）正在使用的分支，**绝不 rebase、绝不 `push --force`**——rebase 重写历史 + 强推会静默抹掉对方已提交的工作。
- **共享分支要同步 `main`，用 merge 而非 rebase。** 即 GitHub 的「Update branch」或 `git merge origin/main`；宁可历史多出 merge 节点，也不丢提交。
- **解决冲突必须两边整合，禁止整边 `accept ours` / `accept theirs`。** 尤其 agent 自动解冲突时，要逐块确认，绝不图省事丢掉一侧的改动。
- 冲突范围过大时，优先**拆小 PR、缩短分支寿命**，从源头减少重叠。

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
  index.html    → 三页面 UI 结构 (主页 / 工作流 / 设置) + <link> 引入 styles.css + 按序加载下列脚本
  styles.css    → 全部页面样式 (原 index.html 内联 <style>，UXP 支持外部样式表)
  main.js       → 基础层: 环境检测 / WORKFLOWS / 设置 key / AIGate 生命周期 / 队列状态 / 会话日志 / 凭据 / base64
  png.js        → 自包含 PNG 编码器 (纯 JS, 无损)
  imaging.js    → PS 成像: 导出 PNG / 选区裁切 / 蒙版导出 / 状态与导航 / UI 诊断 / fetch 工具
  run.js        → 执行: 进度轮询 / 运行锁 / 调用 /run / GPT Image 桥 / 贴回图层
  queue.js      → 工作队列: 文件保存 / 历史持久化 / 队列 UI 渲染 / 缓存路径
  workflow.js   → 桥状态检测 / 工作流网格 / onRunClick 编排
  settings.js   → 设置页 (后端切换 / 凭据 / 主题 / AIGate 实例 / 分段控件)
  init.js       → 引导 IIFE (DOM 绑定 / 事件注册, 最后加载)
  manifest.json → UXP 清单
bridge/         本地桥 (Python aiohttp) — 按职责拆成一个小包
  bridge.py       → 入口 + HTTP 路由处理器 (/run /health /restart /test-key /progress /aigate/*) + main()
  bridge_common.py→ 基础层: 共享状态(_task_progress/日志/CONFIG) / bridge_log / cors / get_rh_base_url / 通用编解码
  gpt_image.py    → GPT Image / Codex / OpenAI 子系统 (含其 HTTP 处理器与任务状态)
  comfyui_exec.py → RunningHub / 本地 ComfyUI 工作流执行 (阻塞式，跑在线程里)
  aigate_native.py→ 云扉 (AIGate) 原生 ComfyUI 后端
  config.json     → 默认 workflowId / imageNodeId / maskNodeId (gitignored)
dev/            开发服务器
  dev_server.py → 浏览器热更新预览 + mock API
  static/       → mock_photoshop.js / mock_uxp.js / mock_workflow.js / hot_reload.js
workflows/      ComfyUI 工作流 JSON (API 格式)
```

## CI

PR 到 `main` 时自动运行 `ci.yml`：
- **Python 语法检查** — `py_compile` bridge.py + bridge_common.py + gpt_image.py + comfyui_exec.py + aigate_native.py + dev_server.py
- **Workflow JSON 校验** — 确保工作流文件是合法 JSON
- **UXP ES5 检测** — 扫描所有 UXP 运行时模块 (`plugin/*.js`，排除 `test_*.js`) 禁止 `const`/`let`/`=>`/`.find()`/`Object.assign`/`classList.toggle(bool)`

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

### 模块加载模型 (无打包器)

UXP 没有打包器 / `import`。原 `main.js` 已按依赖顺序拆成多个**共享全局作用域**的脚本，由 `index.html` 顺序 `<script src>` 加载（`main → png → imaging → run → queue → workflow → settings → init`），运行时等价于原单一文件。

- **文件顶层只能是声明**（`function` / `var` 字面量），**禁止在顶层调用后面模块才定义的函数**——单文件靠整体 hoist 能跑，拆分后前一个脚本执行时后面的还没加载，会 `undefined`。跨模块调用只能发生在运行时（`init.js` 的 IIFE 或事件回调里）。
- **`init.js` 永远最后加载**，负责 DOM 绑定与事件注册。
- Node 测试 (`test_rh_credentials.js` / `test_aigate_native.js`) 通过 `MODULE_FILES` 顺序拼回完整源码再切片，改动模块列表时同步更新这两个测试。

### Python 桥

- 基于 aiohttp + rh_cli（从 GitHub 安装）
- 依赖：`pip install git+https://github.com/LLsetnow/RH_CLI.git`
- `bridge/config.json` 在 .gitignore 中（含私有 workflowId）

#### 桥模块拆分约定（bridge_common / gpt_image / comfyui_exec / bridge）

- **依赖方向单向无环**：`bridge_common` ← `gpt_image` / `comfyui_exec` ← `bridge`。新增跨模块引用时别让 `bridge_common` 反向依赖上层，否则循环导入。
- **共享可变状态放 `bridge_common`**（`_task_progress` / 日志 / `_rh_cancel_events` / `CONFIG`）。`CONFIG` 是一个「就地更新」的 dict——`main()` 用 `CONFIG.clear()/update()` 而非重新赋值，这样各模块 `from bridge_common import CONFIG` 拿到的都是同一份实时配置。整数序号（如日志序号）不能直接 `from import`（会拿到过期副本），要走 `log_snapshot()` 这类取值函数。
- **导入用「脚本模式 / 包模式」双写**：`try: from bridge_common import ... except ImportError: from bridge.bridge_common import ...`。因为 `python bridge/bridge.py`（脚本）与单测 `importlib`/`bridge.` 包导入两种路径都要成立。
- **单测通过 `importlib` 按路径加载 bridge.py 并 `patch.object(bridge, NAME)`**：被 patch / 被调用的处理器和它引用的名字必须在 `bridge.py` 命名空间里（`handle_*` 处理器、`_aigate_managed_tokens`、`ClientSession`、`asyncio`/`os`/`sys` 等都留在 bridge.py）。把这些搬走会让 monkeypatch 失效。

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
  png.js        -> <repo>/plugin/png.js
  imaging.js    -> <repo>/plugin/imaging.js
  run.js        -> <repo>/plugin/run.js
  queue.js      -> <repo>/plugin/queue.js
  workflow.js   -> <repo>/plugin/workflow.js
  settings.js   -> <repo>/plugin/settings.js
  init.js       -> <repo>/plugin/init.js
  styles.css    -> <repo>/plugin/styles.css
  index.html    -> <repo>/plugin/index.html
  manifest.json -> <repo>/plugin/manifest.json
  icons         -> <repo>/plugin/icons
```

因此：

- **改完 `plugin/` 下的文件无需再手动同步 / cp。** 符号链接下 `cp plugin/main.js <目标>` 会因“源与目标是同一文件”报错，不要再执行，也不要在完成插件改动后自动 cp。
- **每次全新启动 PS 都会自动加载仓库最新版。**
- PS 已经开着时改文件不会热更新——需在 PS 中**重新加载面板**（增效工具菜单重载 / 关闭再打开面板）或重启 PS。边写边看请用 `dev/dev_server.py` 浏览器预览（真正热更新）。
- **⚠️ 新增 UXP 模块脚本时（`plugin/` 下多一个 `.js`）必须同步三处，否则安装目录会加载不到：** ① 在 `index.html` 按依赖顺序加一个 `<script src>`；② 在安装目录 `ln -s` 建一个新符号链接；③ 更新上面的架构表 / 本清单。

首次搭建 / 还原符号链接：删除目录内真实文件后 `ln -s "<repo>/plugin/main.js" "<目标>/main.js"`（其余 `.js` / index.html / manifest.json / icons 同理）。原始真实文件的备份**不要放在 `External/` 内**，否则会被 PS 当成重复插件。

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
