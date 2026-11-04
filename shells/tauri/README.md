# Tauri 外壳（M5c — macOS 菜单栏 / Windows 托盘）

同一 Web 内核套 Tauri 2 壳，提供托盘/菜单栏常驻 + 系统通知 + 开机自启。

## 构建（需 Rust 工具链）

```bash
cd shells/tauri
# 先确保 packages/web/dist 已构建
cargo install tauri-cli --version "^2"
npx tauri build        # 或 cargo tauri build
```

## tauri.conf.json 要点
- windows: [{ label: main, url: http://<collector-host>:8898, width: 420, height: 720 }]
  —— 直接加载 collector 页面（或打包 web/dist 资产 + 注入 __NETPILOT_API__）
- trayIcon: true，关闭窗口=隐藏到托盘
- 通知：collector 告警时用系统通知（可复用 notify webhook provider → 本地小代理），或轮询 /api/alerts

## 说明
- 仓库不提交 src-tauri/target 构建产物；Rust 工具链缺失时本壳仅保留脚手架
- macOS 菜单栏形态：extraBinaryTypeMenuBar 或窗口 style: Overlay
