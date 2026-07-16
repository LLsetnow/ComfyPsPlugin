# 云扉原生 ComfyUI「局部编辑」后端设计

## 目标与一期范围

为 ComfyPS 增加“云扉 ComfyUI”后端。云扉 OpenAPI 仅用于发现和控制实例；图像上传、工作流提交、进度查询与结果下载均直接调用发现到的实例原生 ComfyUI API。

一期只支持“局部编辑”的 Boogu 变体。背景去杂物和面部重绘在云扉后端下显示为待配置状态，不能提交任务。云扉 Bearer Token 仅保存到用户本机的插件设置，不写入仓库、配置样例、日志、工作流或测试数据。

## 实例发现和控制

桥使用 `Authorization: Bearer <Token>` 调用云扉 OpenAPI：

1. `POST /api/openapi/instance/page`，请求体为 `{ "operationStatus": "2", "current": 1, "pageSize": 20 }`，获得运行中实例的有序列表。
2. 对列表中的实例依次调用 `GET /api/openapi/instance/get?instanceId=<id>`。
3. 从详情的 `data.instanceUtilList` 中选择 `name = "ComfyUI"` 且包含 `host` 的服务。第一个符合条件的运行中实例即为本次任务的实例。

服务地址固定构造为 `https://<host>`，绝不根据 `protocol` 或 `port` 拼接为容器内的 HTTP 地址。用户已验证云扉的公网反向代理在此 HTTPS 地址提供原生 ComfyUI 服务。

设置页显示云扉实例列表，包括实例名称、实例 ID、状态和是否发现 ComfyUI 服务。每个实例提供启动或关闭操作：桥以 Bearer Token 调用对应的云扉实例启动/关闭 OpenAPI；关闭操作在面板中必须二次确认，操作结束后刷新列表。实例列表只用于显示和控制，不保存“选中实例”；运行仍自动选择第一个符合条件的运行中实例。

## 原生 ComfyUI 工作流执行

对于每个云扉局部编辑任务，面板像现有 RunningHub 局部编辑流程一样导出当前 Photoshop 图像、选区蒙版和提示词，并将其发送给本地桥。

桥在临时目录中保存原图和蒙版后，按以下顺序执行：

1. 向 `https://<host>/upload/image` 分别以 `multipart/form-data` 上传原图和蒙版；每个请求包含 `image` 和固定的 `type=input`。上传文件名使用任务 ID 生成的唯一 PNG 名，避免多个任务覆盖同一 ComfyUI input 文件。
2. 读取 `workflows/inpaint_boogu_api.json`，仅在本次请求的内存副本中覆盖：
   - `71.inputs.image`：原图上传返回的文件名；
   - `214.inputs.image`：蒙版上传返回的文件名；
   - `36.inputs.prompt`：面板提示词；
   - `5.inputs.vae_name`：`flux1_vae_bf16.safetensors`；
   - `224.inputs.filename_prefix`：含任务 ID 的唯一前缀。
3. 向 `https://<host>/prompt` 提交 `{ "prompt": <修改后的工作流>, "client_id": <唯一任务客户端 ID> }`，读取返回的 `prompt_id`。
4. 轮询 `GET https://<host>/history/<prompt_id>`。成功时从节点 `224` 的 `images` 输出取第一张图片。
5. 使用该图片的 `filename`、`subfolder` 和 `type` 请求 `GET https://<host>/view`，校验返回 PNG 后交给现有 Photoshop 贴回流程。

仅云扉 OpenAPI 请求携带 Bearer Token。四个原生 ComfyUI 请求都不携带认证头、不记录 Token 或完整 URL，且禁用自动重定向。请求、轮询与下载都有有限超时；无运行实例、找不到 ComfyUI 服务、上传失败、无 `prompt_id`、工作流失败、超时、缺少 224 输出和非 PNG 下载都转为安全且可展示的错误信息，并同步到现有任务进度接口。

## 面板交互

后端分段控件增加“云扉 ComfyUI”。选中后隐藏 RunningHub 和本地 ComfyUI 专属设置，显示云扉 Token、刷新实例按钮及实例列表。

云扉后端下，局部编辑模型固定为 Boogu，不显示 QwenImage 选项。背景去杂物和面部重绘显示“暂未支持云扉原生工作流”并禁用运行；GPT Image 保持独立，不受此后端选择影响。任务队列沿用“other”串行槽位，不与本地 ComfyUI 或 GPT Image 任务并发。

## 接口边界

桥新增独立云扉原生适配模块和两个本地端点：

- `POST /aigate/instances`：接收 Bearer Token，返回经过过滤的实例 ID、名称、状态和 `hasComfyui`，不返回服务 host、账号、密码、端口或云扉未知字段。
- `POST /aigate/instance-action`：接收 Bearer Token、实例 ID 与 `open` 或 `close`，调用云扉实例控制 API 并返回安全的状态消息。
- `/run` 在 `backend: "aigate"` 时走原生适配；其他后端保持原分支。请求体只新增 Token、云扉后端标识与导出裁切尺寸，不传递或保存云扉应用 ID、应用模板或实例选择。

## 验证

- 云扉适配单元测试覆盖 Token 仅发送给云扉域、运行实例/ComfyUI 服务选择、HTTPS host 构造、实例启停、原生请求无认证头、上传表单、五个节点覆盖、`prompt_id` 轮询、224 输出下载、失败与超时。
- 面板逻辑测试覆盖云扉后端可见性、Boogu 固定、其他工作流禁用、实例列表渲染和关闭二次确认。
- 开发服务器提供无 Token、运行实例、无 ComfyUI 服务、启动/关闭和原生 ComfyUI 成功/失败 mock，不含真实凭证。
- 继续运行 Python 编译、UXP ES5 检查、Python/Node 测试和工作流 JSON 校验。

## 后续扩展

背景去杂物和面部重绘可在未来通过各自的原生工作流节点映射接入同一实例发现、控制、原生提交和结果下载适配层，无需引入云扉 ComfyUI 应用。
