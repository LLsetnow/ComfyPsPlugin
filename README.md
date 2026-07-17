# ComfyPS

一个极简的 **Photoshop(UXP)插件**,把「当前图层 + 选区蒙版」发到 **RunningHub** 的 ComfyUI 工作流做局部重绘(inpaint),再把结果贴回为新图层。

云端后端复用 [`RH_CLI`](https://github.com/LLsetnow/RH_CLI)(RunningHub 命令行工具),裁切 / 处理 / 放大 / 羽化合成全部在 ComfyUI 工作流内部完成——**插件只负责传两张图、贴回一张图**,本地不需要 ComfyUI 或 GPU。

## 架构

```
Photoshop 面板 (UXP)                本地桥 (Python, import rh_cli)          RunningHub
  ├ 导出「当前图层」→ base64 PNG
  ├ 导出「当前选区」→ base64 PNG(白=选中)
  ├ POST /run { image, mask }  ─────►  预上传蒙版拿 fileName
  │                                     run_workflow(-w ID, -i 图 → imageNode,
  │                                       --set maskNode:image=蒙版fileName)
  │                                     rh 上传/提交/轮询/下载 ──► /task/openapi/*
  │      ◄── image/png(整图) ◄── 读结果字节                       ◄── 合成好的整图
  └ 贴成新图层
```

- **密钥不进插件**:RH_CLI 自己从 `~/.config/rh/config.toml` 读 RunningHub API Key。
- 为什么要本地桥:UXP 插件无法直接执行命令并抓 stdout,由桥代为调用 RH_CLI。

## 目录

```
plugin/      UXP 插件(manifest.json / index.html / main.js / icons)
bridge/      本地桥(bridge.py / config.example.json / requirements.txt)
workflows/   打包的工作流(inpaint_api.json,API 格式)
```

## 前置准备

### 1. 在 RunningHub 侧准备 inpaint 工作流
- 工作流需**两个图片输入节点**:一个收原图、一个收蒙版(通常都是 `LoadImage`);内部完成裁切→重绘→放大→羽化合成,输出**画布尺寸整图**。
- 把工作流传到 RunningHub,记下:
  - **workflowId** = 工作流页面 URL 末尾的数字
  - **图片输入节点号**、**蒙版输入节点号**(API 格式 JSON 里的节点键)
- 把该工作流的 **API 格式 JSON** 放到 `workflows/inpaint_api.json`。

### 2. 装 RH_CLI + 桥依赖
```bash
python -m venv .venv && source .venv/bin/activate     # 或复用现有环境
pip install git+https://github.com/LLsetnow/RH_CLI.git   # 提供 rh 与 rh_cli 库
pip install -r bridge/requirements.txt                 # aiohttp
```

### 3. 配好 RunningHub Key(RH_CLI)
```bash
rh auth set-key YOUR_RUNNINGHUB_API_KEY     # 写入 ~/.config/rh/config.toml
rh check                                     # 验证 key 与余额
```

### 4. 填桥配置
```bash
cp bridge/config.example.json bridge/config.json
# 编辑 config.json,填 workflowId / imageNodeId / maskNodeId
```

#### 云扉 ComfyUI 实例（可选）

如需从设置页创建云扉 ComfyUI 实例，也要在本机私有的 `bridge/config.json` 中填写 `aigateCreate`。可参考 `bridge/config.example.json`：

```json
"aigateCreate": {
  "areaName": "你的云扉区域名称",
  "imageName": "comfyui-boogu-edit-int8-20260716",
  "imageTypes": ["3", "2"],
  "imageId": "",
  "imageType": ""
}
```

其中 `areaName` 是云扉区域名称。默认不填写 `imageId` 时，桥会按 `imageTypes` 的顺序精确匹配 `imageName`：默认先查当前云扉账号的个人镜像（`"3"`），找不到再查同名社区镜像（`"2"`）；两者都不可用时会拒绝创建。若要固定使用某个镜像，请同时填写该镜像的数值 `imageId` 和对应的 `imageType`（个人为 `"3"`、社区为 `"2"`），它们会覆盖自动解析。不要把真实区域或镜像配置提交到仓库；`bridge/config.json` 已被忽略。

在设置页填写云扉 Bearer Token 后刷新实例。只有成功刷新并确认云扉控制台没有任何实例时，才会显示「创建实例」卡片；已有任意实例（包括已停止实例）都会隐藏该卡片。连接器中的余额与 GPU 规格价格由云扉以“分”返回；面板会把它们显示为人民币元（例如 `205` 显示为 `¥ 2.05`、`199` 显示为 `¥ 1.99`）。bridge 响应仍保留原始数值，界面不会推断额外的计费周期。

## 使用

### 启动本地桥
```bash
source .venv/bin/activate
python bridge/bridge.py
# 监听 http://127.0.0.1:8765
```

> 每次打开或加载 ComfyPS 面板都会通过 `uxp.shell.openPath` 运行 `plugin/start_bridge.command`：它自动定位仓库、优先使用 `.venv`，安全结束旧的 ComfyPS `bridge.py` 后再启动新桥。若 8765 被其他程序占用，脚本会提示冲突且不会终止该程序。首次会弹一次系统授权确认,并打开一个终端窗口(关掉即停桥)。桥在线时顶部按钮仍可用于「⟳ 重启桥」。

### 加载插件到 Photoshop(2022+ / v23.0+)
- **推荐**:装 **UXP Developer Tool**(通过 Creative Cloud)→ Add Plugin 选 `plugin/manifest.json` → Load。
- **免下载**:侧载——把 `plugin/` 拷到
  `~/Library/Application Support/Adobe/UXP/Plugins/External/`,并在
  `~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/PS.json` 加一条 `enabled` 记录
  (macOS 用正斜杠路径),重启 Photoshop。
- **开发**:把 External 插件目录里的 `main.js` / `index.html` / `manifest.json` / `icons`
  换成指向仓库 `plugin/` 的**符号链接**,这样每次全新启动 Photoshop 都加载最新版、无需手动 cp
  (已开着的面板仍需重载或重启 PS 才生效;边写边看可用 `python dev/dev_server.py` 浏览器预览)。

### 操作
1. 打开图片,**选中要处理的图层**,用选框/套索**画一个选区**。
2. (局部编辑)在「模型」下拉里选 **QwenImage**(默认)或 **Boogu**。
3. 点面板里的「运行」。
4. 状态走完「导出 → 云端处理 → 贴回」后,结果作为新图层出现,选区外像素不变。

> 局部编辑只上传**活动图层的选区外接矩形**(图片与蒙版严格同尺寸)。导出走 Photoshop Imaging API(`getPixels`/`getSelection`)在插件侧裁切并编码 PNG,**不复制文档、不闪切**;返图按原矩形坐标贴回。缺少 Imaging 能力的旧宿主会自动回退到"复制文档裁切"的老路径。

### 任务队列

「任务队列」页**按当前 PS 文件名**列出该文档的历史任务:完成结果会缓存到磁盘并写入 `meta.json`,**重开 Photoshop 后仍能加载**。切换文档时列表自动跟随,可点「刷新」重扫。选中某条可**预览 / 导入(按原坐标贴回) / 删除**(删除会一并清掉磁盘缓存)。

> 注意:跨 Photoshop 重启后,提交时的选区快照通道已丢失,历史任务导入**只按坐标贴回、不再自动恢复选区蒙版**(结果图本身已包含编辑内容)。

## GPT Image

工作流页的「GPT Image」支持三种模式：

- **文生图**：填写关键词，选择画面比例和分辨率。
- **添加参考图**：从当前文档的图层下拉框中选择 1 或 2 个图层作为参考图。
- **图像编辑**：只裁切上传当前活动图层的选区外接矩形，并使用同一矩形裁切后的选区蒙版；生成结果按原矩形坐标贴回，选区外保持原内容。

RunningHub「局部编辑」也会保留提交时的选区快照：该蒙版继续作为工作流输入，并在结果图层上创建同一位置的图层蒙版。

在设置页选择认证方式：

- **Codex 订阅**：在本机终端完成 `codex login`，并确保 `codex features list` 中 `image_generation` 已启用。此路径通过本机 Codex CLI 调用，不需要 API Key。
- **OpenAI API Key**：桥会直接调用 `gpt-image-2` 的图像接口。API 使用量与 ChatGPT/Codex 订阅分开计费，账户也可能需要完成 OpenAI 的组织验证。

OpenAI API Key 保存在本机插件设置中；每次仅随本机桥的 GPT Image 请求传递，不会写入 `bridge/config.json`。生产桥提供 `POST /gpt-image` 和 `POST /gpt-image/status`；旧的 `POST /codex/image` 仍保留兼容。

### 本地验证模式

设置页可开启「启用本地验证模式」。开启后不调用桥、Codex 或 OpenAI，也不创建网络任务；仅支持「图像编辑」模式。插件会在本机裁切活动图层的选区外接矩形，再按原坐标贴回并创建图层蒙版，结果图层名称会以 `ComfyPSGPT - 本地验证` 开头，状态栏会显示选区外接矩形的尺寸和左上坐标。该操作不上传或生成模型图片，可快速确认活动图层、裁切范围、选区和图层蒙版回贴的 Photoshop 端流程。

## 许可证
MIT
