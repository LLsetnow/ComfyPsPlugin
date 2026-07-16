# RunningHub 任务费用显示设计

## 目标

在 ComfyPS 的任务队列中显示每次成功的 RunningHub 工作流实际消耗，并在任务历史中保留该信息。每项任务最多显示一个费用值：优先 RH 币，金额作为回退。

## 数据来源与优先级

RunningHub 工作流输出接口 `/task/openapi/outputs` 的成功输出项可包含以下字段：

- `consumeCoins`：任务消耗的 RH 币。
- `consumeMoney`：平台运行时长消耗金额。

RH CLI 选择首个输出项的费用字段，规范化为一项费用数据：

1. `consumeCoins` 有非空值时，返回类型 `coins` 和该值。
2. 否则 `consumeMoney` 有非空值时，返回类型 `money` 和该值。
3. 两者均缺失或为空时，不返回费用数据。

不使用余额差额推算费用，也不显示 `thirdPartyConsumeMoney`，因此不会把并发任务、充值或第三方计费混入本次任务。

## 组件与数据流

1. RH CLI 扩展 `RunResult`，让 `workflow.run_workflow()` 将规范化费用与 `task_id` 一起返回。
2. 本地桥调用 RH CLI 后，从结果中取费用，在成功的 `/run` 图片响应中通过响应头返回。图片响应体保持不变。
3. 插件的 `callBridge()` 读取该响应头并将费用返回给工作流执行逻辑。
4. 完成的队列项记录费用类型和值；卡片元信息显示 `消耗 N RH币` 或 `消耗 ¥N`。
5. `writeTaskMeta()` 将费用写入 `meta.json`，历史扫描在存在该字段时还原显示。

## 行为与异常处理

- 只有成功的 RunningHub 任务可获得并显示费用。
- ComfyUI、GPT Image、本地蒙版调试、失败与已取消的任务均不显示费用。
- 旧 `meta.json` 或服务端未返回费用字段时，队列保持现有布局，不显示费用。
- 桥在缺少 RH CLI 费用属性时按“无费用”处理，兼容未升级的安装。
- 浏览器开发服务器会模拟同样的响应头，便于前端预览。

## 验证

- RH CLI 单元测试覆盖 RH 币优先、金额回退和无费用三种输出。
- 桥测试/检查确认成功响应含费用头，且无费用时不发送该头。
- ComfyPS 执行 Python 编译、工作流 JSON 校验及 UXP ES5 兼容扫描。
