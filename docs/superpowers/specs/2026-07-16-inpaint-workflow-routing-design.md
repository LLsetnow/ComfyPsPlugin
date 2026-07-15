# 局部编辑工作流路由设计

## 目标

将局部编辑的模型下拉框替换为两个工作流选项：`QwenImage` 和 `Boogu`。两个选项共享提示词、分辨率、当前图层图片与选区蒙版输入，但分别提交到对应的 RunningHub 工作流和节点。

## 选择项

| 选项 | RunningHub workflowId | API 文件 | 图片节点 | 蒙版节点 | 分辨率节点 |
| --- | --- | --- | --- | --- | --- |
| QwenImage（默认） | `2075283500294565890` | `workflows/inpaint_api.json` | `41` | `210` | `202` |
| Boogu | `2077428511296888833` | `workflows/inpaint_boogu_api.json` | `71` | `214` | `212` |

Boogu API 文件从 `/Users/apple/Documents/github/RH_CLI/workflows/ai/PS-局部编辑-Boogu_api.json` 复制到仓库的 `workflows/inpaint_boogu_api.json`，使插件和本地桥无需依赖该外部目录。

## 界面与参数

局部编辑继续显示提示词和分辨率输入，并把原有的模型文件下拉框改为「模型」选择：`QwenImage`（默认）和 `Boogu`。

- QwenImage 通过额外参数把节点 `12.unet_name` 固定为 `qwnImageEdit_v16Bf16.safetensors`。
- Boogu 使用其 API 文件中节点 2 的默认模型 `boogu_image_edit_turbo_int8_convrot.safetensors`，不额外覆盖模型。
- 分辨率解析为正整数；无效或缺失时使用 `1024`。所选工作流的 `InpaintCropImproved` 节点同时接收 `output_target_width` 和 `output_target_height`，因此输出为对应的正方形尺寸。

提示词继续作为普通 `prompt` 请求字段交给桥自动注入：QwenImage 的正向节点为 `68.prompt`，Boogu 的提示词节点为 `36.prompt`。图片和选区蒙版继续使用现有导出逻辑。

## 路由与桥接

插件在发起局部编辑请求时，根据选择项解析出本次请求的 workflow ID、API 文件、图片节点、蒙版节点和节点参数；不修改全局工作流对象，避免一次运行影响下一次选择。

桥的 `/run` 请求增加可选的 `maskNodeId` 字段。RunningHub 执行时优先使用请求中的蒙版节点，未提供时继续使用 `bridge/config.json` 的 `maskNodeId`。蒙版字段仍为 `image`、通道仍为 `red`，因此其他工作流和既有配置保持兼容。

## 错误处理与兼容性

- 未知的下拉值回退到 QwenImage。
- Boogu API 文件随仓库提交；桥找不到工作流文件时保留现有的请求失败提示。
- 不改变 GPT Image、背景去杂物、面部重绘或本地 ComfyUI 执行路径。
- `plugin/main.js` 保持 ES5 兼容，不使用 `const`、`let`、箭头函数、`Object.assign` 或 `Array.find`。

## 验证

- 校验新的 Boogu JSON 与已有工作流 JSON。
- 检查 QwenImage 和 Boogu 请求分别携带正确的 workflow ID、文件路径、图片节点、蒙版节点和分辨率 `extraSetArgs`。
- 校验桥接层能优先采用请求传入的 `maskNodeId`，未传时回退配置值。
- 运行 Python 语法检查、UXP ES5 扫描，并同步更新后的 `plugin/main.js` 到 Photoshop UXP 插件目录。
