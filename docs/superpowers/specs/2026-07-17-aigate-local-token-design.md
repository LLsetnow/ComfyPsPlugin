# 云扉本地 Token 文件设计

## 目标

把现有云扉 AI Gate Token 保存为开发者和代理专用的本地文件 `~/.AiGate`，并在仓库协作说明中记录安全读取方式。

## 范围

- `~/.AiGate` 是用户主目录下、未纳入 Git 的单行纯文本文件，内容为原始 Token，末尾允许一个换行。
- 文件权限固定为仅文件所有者可读写（`0600`）。
- `CLAUDE.md` 与 `AGENTS.md` 增加同样的云扉凭证说明：读取时去除首尾空白，在云扉 OpenAPI 请求中作为 `Authorization: Bearer <token>` 发送；不得打印、提交、写入日志或复制到仓库配置。

## 非目标

- 不改变 Photoshop 插件、开发预览或 Python 桥的 Token 来源。
- 不把 Token 写入 `bridge/config.json`、localStorage、环境变量文件或任何 Git 跟踪文件。
- 不创建仓库内的 `AGENT.md`：当前仓库的协作说明文件名为 `AGENTS.md`。

## 数据流

开发者或代理在需要调用云扉 OpenAPI 时，从 `~/.AiGate` 读取 Token，去除换行后临时放入当前进程变量，再设置 HTTP Bearer Header。请求完成后不持久化该变量，也不在命令输出中回显 Token。

## 验证

确认 `~/.AiGate` 存在、权限为 `600`，并且文件不在 Git 工作树中。检查两份协作说明均包含路径、Bearer Header 用法和禁止泄露凭证的约束。不会显示 Token 内容。
