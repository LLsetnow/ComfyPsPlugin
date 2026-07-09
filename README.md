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
pip install ~/Documents/github/RH_CLI                  # 提供 rh 与 rh_cli 库
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

## 使用

### 启动本地桥
```bash
source .venv/bin/activate
python bridge/bridge.py
# 监听 http://127.0.0.1:8765
```

### 加载插件到 Photoshop(2022+ / v23.0+)
- **推荐**:装 **UXP Developer Tool**(通过 Creative Cloud)→ Add Plugin 选 `plugin/manifest.json` → Load。
- **免下载**:侧载——把 `plugin/` 拷到
  `~/Library/Application Support/Adobe/UXP/Plugins/External/`,并在
  `~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/PS.json` 加一条 `enabled` 记录
  (macOS 用正斜杠路径),重启 Photoshop。

### 操作
1. 打开图片,**选中要处理的图层**,用选框/套索**画一个选区**。
2. 点面板里的「运行」。
3. 状态走完「导出 → 云端处理 → 贴回」后,结果作为新图层出现,选区外像素不变。

## 许可证
MIT
