# Release 一键打包落地清单（macOS 优先 · 未签名版 · 可复用）

> 目标：一条命令 `python build/release.py` 产出 `ComfyPS-<version>-macos.pkg`，
> 双击即静默安装「冻结后的 Python 桥 + `.ccx` 插件」，用户无需装 Python。
> 分发方式：**UPIA 静默装 `.ccx`** + **PyInstaller 冻结桥**。

## 既定决策

- 平台：**先 macOS**（PyInstaller 不能交叉编译，Windows 后续加进 CI matrix）。
- 签名：**暂无 Apple Developer ID → 先出未签名版**。`codesign/notarize` 做成 `--sign` 开关（默认关），拿到账号后开启即可，脚本不重写。
- 复用：版本号从 `plugin/manifest.json` **单一来源**自动派生；每步可 `--only` / `--skip`。
- 冻结形态：**onedir**（re-exec/restart 更稳、启动快；目录藏在 Application Support，用户不可见）。
- workflows 落位：随桥装到 `~/Library/Application Support/ComfyPS/workflows/`，config 指过去。

---

## M1 · 前置改造（冻结前必须完成，且向后兼容 dev 模式）

> 这些是 `bridge.py` 里冻结后必然会坏的点，均已定位到具体行。
> 验收：改完 `python bridge/bridge.py` 仍能正常起桥（dev 不回归）。

- [ ] **config 落用户可写目录**：`bridge.py:35` `BRIDGE_DIR=Path(__file__).parent` + `:421` `cfg_path=BRIDGE_DIR/"config.json"`。
      冻结后 `__file__` 指向只读的临时解压目录。改为读 `~/Library/Application Support/ComfyPS/config.json`，缺失时从内置 `config.example.json` 播种。dev 模式保留原路径回退。
- [ ] **workflows 路径可解析**：`:431 / :828 / :938` 的 `config["workflowFile"]` 现指向 `../workflows/*.json`。
      改为解析到已安装的固定目录（或按 id 在已知目录查找），打包后无仓库路径也能命中。
- [ ] **/restart 兼容冻结**：`:1060` 的重启逻辑用 `python bridge.py` re-exec。
      检测 `sys.frozen`：冻结时用 `sys.executable`（无脚本参数）重启，dev 时维持原样。
- [ ] **start_bridge.command 改为直连冻结桥**：现用 `readlink` 回溯仓库找 `.venv`。
      改成 `exec` 固定安装路径的冻结可执行；保留 dev 用法可另出一个 `start_bridge_dev.command` 或用环境变量分支。
- [ ] **rh_cli 可被 PyInstaller 收集**：`:47-50` 深度 import `rh_cli.config/errors/http/workflow.client`。
      预留 `build/hooks/hook-rh_cli.py` 或用 `--collect-all rh_cli`，确保动态子模块/数据文件不漏。
- [ ] 建议 **M1 单独出一个 PR**，与打包解耦，风险最低。

---

## M2 · 冻结桥（PyInstaller）

- [ ] 新增 `build/bridge.spec`（入库、可复现），onedir，entry=`bridge/bridge.py`。
- [ ] 新增 `build/hooks/hook-rh_cli.py`，补 hidden imports / `collect_data_files`。
- [ ] aiohttp（自带 hook）、socksio（纯 Python）确认无需额外处理。
- [ ] `release.py --only bridge` 产出可运行的 `dist/bridge/`，手测：直接跑冻结桥 → `/health` 返回 200。
- [ ] 验证 `/run` 跑通一个真实工作流（rh_cli 收集完整、无缺模块）。

---

## M3 · `.ccx` 生成 + `.pkg` 组装

### `.ccx`
- [ ] `build_ccx`：把 `plugin/` 复制成干净副本，**去符号链接、剔除 dev 文件**。
- [ ] 优先用 UXP Developer Tool CLI 打包；无 UDT CLI 时退化为「按 UXP 规范结构化 zip + 改扩展名」。环境探测自动选路。

### `.pkg`
- [ ] `build/installer/macos/Distribution.xml`（productbuild 版面）。
- [ ] `build/installer/macos/scripts/postinstall`：
  - [ ] 冻结桥 → `~/Library/Application Support/ComfyPS/bridge/`
  - [ ] `workflows/` + `config.example.json` → 同目录；无 `config.json` 则播种
  - [ ] `UPIA --install ComfyPS.ccx` 静默装插件
        （`/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent`）
  - [ ] 写好 `start_bridge` 指向固定桥路径
- [ ] `pkgbuild` + `productbuild` → `dist/ComfyPS-<version>-macos.pkg`，打印 SHA256。
- [ ] 提供卸载路径：`UPIA --remove com.llsetnow.comfyps` + 删 Application Support 目录。
- [ ] 端到端验收：干净机器双击安装 → PS 里出现面板 → 启动桥 → 跑通一个工作流。

---

## M4 · CI 自动出 release

- [ ] `.github/workflows/release.yml`：`on: push tags 'v*'`。
- [ ] `macos-latest` runner → `python build/release.py` → 上传 `dist/*.pkg` 到 GitHub Release。
- [ ] 签名凭据（未来）从 GitHub Secrets 注入 env，脚本不改。
- [ ] Windows 后续加进 matrix。

---

## 未签名版的已知妥协（需写进 README）

- [ ] 首次运行冻结桥会被 Gatekeeper 拦：用户需**右键 → 打开**一次，或「系统设置 → 隐私与安全性 → 仍要打开」。
- [ ] 拿到 Apple Developer ID 后开 `--sign`（codesign `--options runtime` + notarytool + staple），此提示即消失。

---

## 新增文件一览

```
build/
  release.py                     # 编排器（唯一入口）
  bridge.spec                    # PyInstaller spec
  hooks/hook-rh_cli.py           # rh_cli 收集
  config.toml                    # app id / 安装路径 / (未来)签名身份
  installer/macos/
    Distribution.xml
    scripts/postinstall
dist/                            # 产物，加入 .gitignore
.github/workflows/release.yml    # tag 触发出包
```

---

## 待拍板

- [ ] onedir vs onefile（计划默认 onedir，理由见上）。
- [ ] workflows 落位是否接受放 `Application Support/ComfyPS/workflows/`。
- [ ] M1 是否先独立合并。
