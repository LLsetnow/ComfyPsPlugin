# 云扉本地 Token 存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户已提供的云扉 AI Gate Token 安全保存到仅用户可读写的 `~/.AiGate`，并在仓库协作说明中记录安全使用方式。

**Architecture:** 凭证只保存在用户主目录的单行纯文本文件，不引入插件、桥或仓库配置读取逻辑。`CLAUDE.md` 与 `AGENTS.md` 保持完全一致的说明：在需要云扉 OpenAPI 调用时临时读取文件并构造 Bearer Header，绝不打印、提交、记录或复制凭证。

**Tech Stack:** POSIX 文件权限、Git 文档变更、shell `stat`/`rg` 验证。

---

## 文件结构

- Create outside repository: `~/.AiGate` — 单行原始云扉 Token，权限 `0600`。
- Modify: `CLAUDE.md` — 增加本地云扉凭证使用规范。
- Modify: `AGENTS.md` — 与 `CLAUDE.md` 保持相同规范。

### Task 1: 创建受限权限的本地凭证文件

**Files:**
- Create: `~/.AiGate`

- [ ] **Step 1: 写入用户已在安全上下文中提供的 Token**

使用具备用户主目录写入权限的秘密写入操作，将已提供的原始 Token 写为 `~/.AiGate` 的唯一一行。不得把 Token 放进命令回显、终端输出、Git diff、测试 fixture 或仓库文件。

- [ ] **Step 2: 限制文件权限**

Run:

```bash
chmod 600 ~/.AiGate
```

Expected: command exits successfully; only the current user can read or write the file.

- [ ] **Step 3: 验证存在性和权限而不读取内容**

Run:

```bash
test -f ~/.AiGate && test "$(stat -f '%Lp' ~/.AiGate)" = 600
```

Expected: exit code `0`; the Token is never printed.

### Task 2: 记录开发者和代理的安全使用方式

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 在两份协作说明中加入相同的云扉凭证章节**

在 “Python 桥” 小节之后加入以下 Markdown，两个文件保持逐字一致：

```markdown
### 云扉 AI Gate 凭证（仅本地）

- 云扉 Token 仅保存在 `~/.AiGate`，该文件不属于仓库且权限必须为 `0600`。
- 需要调用云扉 OpenAPI 时，临时读取并去除首尾空白：`AIGATE_TOKEN="$(tr -d '\\r\\n' < ~/.AiGate)"`，请求头使用 `Authorization: Bearer $AIGATE_TOKEN`。
- 禁止打印 Token、将其写入日志、提交到 Git、放进 `bridge/config.json`、插件 localStorage、`.env` 或测试数据。
- 此文件仅供开发者和代理使用；Photoshop 插件与本地桥仍使用其现有的显式 Token 传递流程。
```

- [ ] **Step 2: 验证文档内容一致且包含所有安全约束**

Run:

```bash
diff -u <(sed -n '/### 云扉 AI Gate 凭证（仅本地）/,/^### /p' CLAUDE.md | sed '$d') <(sed -n '/### 云扉 AI Gate 凭证（仅本地）/,/^### /p' AGENTS.md | sed '$d')
rg -n 'Authorization: Bearer \$AIGATE_TOKEN|~/.AiGate|权限必须为 `0600`|禁止打印 Token|bridge/config.json' CLAUDE.md AGENTS.md
```

Expected: `diff` produces no output and `rg` finds every required constraint in both files.

- [ ] **Step 3: 检查仓库变更中没有密钥**

Run:

```bash
git diff --check
git diff -- CLAUDE.md AGENTS.md
```

Expected: only documentation text appears; neither command exposes the Token.

- [ ] **Step 4: 提交仓库内文档改动**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: document local AIGate token usage"
```

Expected: one documentation-only commit on the feature branch. `~/.AiGate` remains outside Git.

### Task 3: 交付前验证

**Files:**
- Verify: `~/.AiGate`
- Verify: `CLAUDE.md`
- Verify: `AGENTS.md`

- [ ] **Step 1: 运行完整的秘密安全检查**

Run:

```bash
test -f ~/.AiGate && test "$(stat -f '%Lp' ~/.AiGate)" = 600
git status --short
git diff --check origin/main...HEAD
```

Expected: file permission check passes; Git status lists only intentional repository documentation changes or a clean feature branch; no local credential file is tracked.

- [ ] **Step 2: 同步最新 main 并准备 PR**

```bash
git fetch origin
git rebase origin/main
git push -u origin chore/aigate-local-token-docs
```

Expected: rebase completes without conflicts and branch is available for a PR targeting `main`.
