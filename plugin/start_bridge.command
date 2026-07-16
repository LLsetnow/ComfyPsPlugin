#!/bin/bash
# ComfyPS 本地桥启动器
# 由插件「启动桥」按钮通过 uxp.shell.openPath 调用；也可在 Finder 里双击运行。
# 会解析自身真实路径(跟随符号链接)定位仓库，优先用 .venv 里的 python 起桥。

set -u

# --- 解析脚本自身真实路径(该文件可能是 PS 插件目录里指向仓库的符号链接) ---
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  TARGET="$(readlink "$SOURCE")"
  case "$TARGET" in
    /*) SOURCE="$TARGET" ;;
    *)  SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$TARGET" ;;
  esac
done
PLUGIN_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"   # <repo>/plugin
REPO="$(cd "$PLUGIN_DIR/.." && pwd)"               # <repo>
cd "$REPO" || { echo "无法进入仓库目录: $REPO"; exit 1; }

# --- 选择解释器：优先仓库内 .venv，其次系统 python3/python ---
PY="$REPO/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PY" ]; then
  echo "未找到 python，请先创建 .venv 或安装 python3"; exit 1
fi

# --- 若 8765 已被占用，先释放(可能是残留的桥或 dev 预览服务器) ---
PIDS="$(lsof -ti tcp:8765 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "端口 8765 被占用，先结束: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  sleep 1
fi

echo "=============================================="
echo " ComfyPS 本地桥启动"
echo "   repo   : $REPO"
echo "   python : $PY"
echo "   关闭本窗口即停止桥。"
echo "=============================================="
exec "$PY" bridge/bridge.py
