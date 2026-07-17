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

# --- 安全替换旧桥：只终止本仓库运行的 bridge.py，绝不杀掉其他服务 ---
listener_pids() {
  lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null || true
}

is_comfyps_bridge_pid() {
  PID_CWD="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  PID_COMMAND="$(ps -p "$1" -o command= 2>/dev/null || true)"
  [ "$PID_CWD" = "$REPO" ] && case "$PID_COMMAND" in
    *"bridge/bridge.py"*) return 0 ;;
    *) return 1 ;;
  esac
}

current_comfyps_bridge_pids() {
  MATCHED_PIDS=""
  for PID in $(listener_pids); do
    if is_comfyps_bridge_pid "$PID"; then
      MATCHED_PIDS="$MATCHED_PIDS $PID"
    fi
  done
  echo "$MATCHED_PIDS"
}

current_other_listener_pids() {
  OTHER_PIDS=""
  for PID in $(listener_pids); do
    if ! is_comfyps_bridge_pid "$PID"; then
      OTHER_PIDS="$OTHER_PIDS $PID"
    fi
  done
  echo "$OTHER_PIDS"
}

OTHER_PIDS="$(current_other_listener_pids)"

if [ -n "$OTHER_PIDS" ]; then
  echo "端口 8765 被其他程序占用:$OTHER_PIDS"
  exit 1
fi

BRIDGE_PIDS="$(current_comfyps_bridge_pids)"
if [ -n "$BRIDGE_PIDS" ]; then
  echo "正在结束旧的 ComfyPS 桥:$BRIDGE_PIDS"
  kill $BRIDGE_PIDS 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    [ -z "$(listener_pids)" ] && break
    sleep 1
  done
  if [ -n "$(listener_pids)" ]; then
    OTHER_PIDS="$(current_other_listener_pids)"
    if [ -n "$OTHER_PIDS" ]; then
      echo "端口 8765 被其他程序占用:$OTHER_PIDS"
      exit 1
    fi
    BRIDGE_PIDS="$(current_comfyps_bridge_pids)"
    if [ -n "$BRIDGE_PIDS" ]; then
      echo "旧桥未在 5 秒内退出，强制结束"
      kill -9 $BRIDGE_PIDS 2>/dev/null || true
      sleep 1
    fi
  fi
fi

if [ -n "$(listener_pids)" ]; then
  echo "端口 8765 未能释放，取消启动"
  exit 1
fi

echo "=============================================="
echo " ComfyPS 本地桥启动"
echo "   repo   : $REPO"
echo "   python : $PY"
echo "   关闭本窗口即停止桥。"
echo "=============================================="
exec "$PY" bridge/bridge.py
