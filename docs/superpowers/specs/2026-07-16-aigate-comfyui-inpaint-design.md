# 云扉 ComfyUI「局部编辑」后端设计

## 目标与一期范围

为 ComfyPS 增加“云扉 ComfyUI”后端。它通过云扉 OpenAPI 执行预先创建的 ComfyUI 应用，而不是复用本地 ComfyUI 的 `/prompt` 协议。

一期只支持“局部编辑”的 Boogu 变体。背景去杂物和面部重绘在云扉后端下保留为待配置状态，不能提交任务。云扉应用 ID、Bearer Token 与应用绑定仅保存在用户本机，不写入仓库、配置样例、日志或测试数据。

## 云扉控制台应用配置

云扉公开 API 只提供查询应用、查询绑定实例、创建任务与查询任务结果；应用必须先在云扉控制台创建并绑定 ComfyUI 实例。

用户在控制台为 `workflows/inpaint_boogu_api.json` 创建一个 Boogu 局部编辑应用，并将下列输入设为允许输入：

| 用途 | allowInput 字段 |
| --- | --- |
| 提示词 | `36.inputs.prompt` |
| 原图文件名 | `71.inputs.image` |
| 输出宽度 | `212.inputs.output_target_width` |
| 输出高度 | `212.inputs.output_target_height` |
| 蒙版文件名 | `214.inputs.image` |
| 输出名称前缀 | `224.inputs.filename_prefix` |

该应用必须绑定包含该工作流所需模型与自定义节点的实例。插件在运行时只选取该应用关联实例中第一个 `instanceStatus = 2`（运行中）的实例；若没有运行中实例，任务在提交前失败并提示用户启动或绑定实例。

## 设置页交互

后端分段控件增加“云扉 ComfyUI”。选择后显示云扉设置，隐藏 RunningHub 与本地 ComfyUI 设置：

- Bearer Token 密码输入框与“验证并读取应用”按钮。
- 验证成功后显示云扉应用列表；一期只为“局部编辑”展示应用选择器。
- 用户选择应用后，插件将该应用 ID 仅保存到 `comfyps.aigateWorkflowBindings` 的 `inpaint` 项中。
- 绑定摘要显示“自动选择第一个运行中实例”。不提供实例 ID 输入框。
- 云扉后端下，“局部编辑”模型固定为 Boogu，QwenImage 不显示；其他两个 RunningHub 工作流显示“待配置云扉应用”并禁用运行。
- Token 和应用绑定变更都在本地保存。设置页与桥日志只显示脱敏状态，不显示 Token。

应用列表的响应提供 `allowInput`、别名和类型信息。对于一期选中的 Boogu 应用，插件在保存选择时验证上述六个字段是否都存在；字段缺失时不允许保存绑定，并明确列出缺失字段。这样避免把任意云扉应用误绑定到局部编辑。

## 请求与结果数据流

1. 设置页将 Token 发送到桥的云扉“列出应用”端点；桥以 `Authorization: Bearer <Token>` 请求云扉应用列表并返回可安全展示的应用元数据。
2. 运行局部编辑时，面板把 Token、选中的应用 ID、原图、蒙版、提示词与裁切尺寸发送给本地桥。
3. 桥查询该应用的实例列表，选择第一个运行中实例并读取 `comfyuiHost`。
4. 桥向 `comfyuiHost/api/upload/image` 分别上传原图与蒙版，获得云端文件名。
5. 桥以应用的 `allowInput` 模板为基础，仅覆盖六个已验证字段；宽高使用实际导出裁切尺寸，输出前缀使用唯一的 `ComfyPS_AIGate_<taskId>`。
6. 桥向云扉任务创建 API 提交 `appId`、自动选择的 `instanceId` 与 `allowInput`。
7. 桥轮询任务状态：`0` 排队、`1` 生成中、`2` 成功、`3` 取消、`4` 失败、`5` 超时。成功后下载第一个结果的 `downloadUrl`，作为 PNG 返回给现有 Photoshop 贴回流程。
8. 桥将排队/生成/失败状态写入现有任务进度接口。云扉文档没有取消任务端点，因此一期不把“停止”映射为远端取消。

## 桥接口与隔离

新增明确的云扉适配函数和端点，不改动本地 ComfyUI 与 RunningHub 协议：

- `POST /aigate/apps`：验证 Token、读取应用列表，并过滤为设置页所需字段。
- `/run` 在 `backend: "aigate"` 时走云扉执行函数；其他后端保持原分支。
- 云扉 HTTP 客户端统一添加 Bearer Token、有限超时、禁止不必要的跨主机重定向，并把云扉的 `code`/`msg` 转为安全的用户错误信息。

下载地址、Token、上传文件名都不写入桥日志。HTTP 响应中的未知字段不转发到面板。

## 验证

- 桥端单元测试覆盖：Bearer header、应用列表解析、Boogu 必填字段校验、运行中实例选择、没有运行中实例、上传/任务创建 payload、状态成功/失败/超时和结果下载。
- 面板逻辑测试覆盖：云扉后端可见性、Boogu 固定、应用绑定校验、云扉下其他工作流不可运行。
- 开发服务器提供无 Token、有效应用、字段缺失、无运行中实例、成功任务与失败任务的 mock 响应。
- 继续运行 Python 编译、UXP ES5 检查、现有 Python/Node 测试及工作流 JSON 校验。

## 后续扩展

当用户为背景去杂物和面部重绘创建并绑定云扉应用后，沿用 `aigateWorkflowBindings` 为各工作流增加独立应用选择与字段验证，不改变 Token、实例选择、上传、任务轮询或贴回架构。
