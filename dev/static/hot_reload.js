/*
 * hot_reload.js — WebSocket 热更新客户端
 * 连到 dev server /ws, 收到 {type:"reload"} 时自动刷新页面。
 * 断线自动重连。
 */
(function () {
  var ws;
  var reconnectTimer;
  var retryMs = 500;

  function connect() {
    var url = "ws://" + location.host + "/ws";
    ws = new WebSocket(url);
    ws.onopen = function () {
      console.log("[ComfyPS Dev] 热更新已连接");
      retryMs = 500; // 重置重试间隔
    };
    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === "reload") {
          console.log("[ComfyPS Dev] 文件已变更, 刷新页面…");
          location.reload();
        }
      } catch (_) {}
    };
    ws.onclose = function () {
      reconnectTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 5000); // 退避, 最多 5s
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
