# 云扉受管实例自动关闭开关设计

## 目标

让用户在云扉 ComfyUI 设置中控制：关闭 Photoshop 时，是否自动关闭由本插件创建或启动过的受管云扉实例。

## 范围

- 仅影响本插件持久化登记为受管的实例。
- 仅影响面板收到 `uxphidepanel` 或 `beforeunload` 时发出的关闭请求。
- 不释放实例，也不影响云扉控制台中非受管实例。
- 本地 bridge 进程自身正常停止时的既有受管实例清理保持不变。

## 交互与存储

在云扉 Bearer Token 输入项下方加入一个复选开关。开关右侧使用状态文本：

- 开启：`已开启：关闭 Photoshop 时会向本地桥发送关闭请求。`
- 关闭：`已关闭：退出 Photoshop 时不关闭任何受管实例。`

设置通过 `localStorage` 持久化。新键缺失时默认视为开启，保证已有用户升级后维持此前自动关闭的行为。

## 行为

`requestAigateManagedClose()` 在读取到开关关闭时立即返回，不调用 `/aigate/close-managed`。开关开启时保留现有 Token、受管实例 ID、`sendBeacon` 优先和短超时 `fetch` 回退逻辑。

面板再次显示时，既有的一次性关闭请求保护仍会重置。桥服务的 `cleanup_managed_aigate_instances()` 不读取该用户界面设置；它用于 bridge 自身的正常关闭清理。

## 验证

- 前端单元测试覆盖设置默认值、保存和恢复。
- 前端单元测试覆盖关闭开关时不触发关闭请求，开启时仍按既有路径请求。
- HTML 静态测试覆盖开关 DOM。
- 运行现有 Python 云扉测试、JavaScript 测试、Python 编译和 UXP ES5 兼容性检查。
