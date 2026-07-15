# 局部编辑模型选择设计

## 目标

为 RunningHub 的「局部编辑」工作流增加模型选择参数。用户可在运行前选择节点 12（`UNETLoader`）使用的模型；默认仍为 `qwen_image_edit_2511_fp8mixed.safetensors`。

## 范围

仅修改局部编辑工作流在插件面板中的输入定义与参数注入。模型选择仅影响提交给 RunningHub 的局部编辑任务，不新增全局设置，不修改其他工作流，也不改变本地 ComfyUI 执行路径。

## 界面

在局部编辑的现有输入区域、提示词和分辨率之后增加一个「模型」下拉框：

| 显示名称 | 传递给节点 12 的值 |
| --- | --- |
| Qwen Image Edit 2511（FP8 Mixed，默认） | `qwen_image_edit_2511_fp8mixed.safetensors` |
| Qwn Image Edit v1.6（BF16） | `qwnImageEdit_v16Bf16.safetensors` |

切换工作流或重新打开面板时，控件按工作流默认值初始化；本次不保存用户上次的选择。

## 数据流

1. 插件通过既有的 `getWorkflowInputs()` 读取下拉框值。
2. 局部编辑工作流的 `setArgs(inputs)` 将其转成 `12:unet_name=<模型文件名>`；值缺失时回退到默认 FP8 Mixed 模型。
3. `callBridge()` 将该字符串放进 `extraSetArgs`。
4. Python 桥已有逻辑将 `extraSetArgs` 追加到 RunningHub 的 `set_args`，从而覆盖工作流 JSON 中节点 12 的 `unet_name`。

`workflows/inpaint_api.json` 已以 FP8 Mixed 模型为默认值，保持不变，确保未注入参数时的行为也符合默认设置。

## 兼容性与错误处理

- 使用现有的 `select` 输入类型和 `setArgs` 约定，不增加新的 UI 或桥接协议。
- 保持 `plugin/main.js` 的 ES5 兼容性。
- 控件缺失或值为空时使用默认模型，而不向 RunningHub 发送空的 `unet_name`。
- 本地 ComfyUI 模式不在本次范围内；该模型参数的承诺范围仅是 RunningHub 局部编辑。

## 验证

- 校验 `plugin/main.js` 通过项目的 UXP ES5 扫描。
- 在浏览器预览中确认下拉框显示两个选项，默认选择 FP8 Mixed。
- 检查局部编辑请求的 `extraSetArgs` 包含所选模型对应的 `12:unet_name=...`。
- 执行现有 Python 语法检查与工作流 JSON 校验，确认本次改动不影响桥接和工作流文件。
