# Capacitor 外壳（M5b — iOS / Android）

同一 Web 内核（packages/web 构建产物）套 Capacitor 壳，推送走 APNs/FCM。

## 接线方式
- App 注入 `globalThis.__NETPILOT_API__ = 'http://<collector-host>:8898'`（或 LAN 地址），见 packages/web/src/api.ts
- 前端令牌存储用 localStorage，Capacitor WebView 原生持久化，无需改造

## 构建（需 Android Studio / Xcode，本仓不提交构建产物）

```bash
cd shells/capacitor
npm install
npx cap init NetPilot com.pyyaiai.netpilot --web-dir ../../packages/web/dist
# 先构建 web：
cd ../../packages/web && npm run build && cd ../../shells/capacitor
npx cap add android          # Android（需 JDK17 + Android SDK）
npx cap sync android
npx cap open android         # Android Studio 里 Build APK
# iOS 需 macOS + Xcode：
npx cap add ios && npx cap sync ios && npx cap open ios
```

## 推送预留
- iOS: APNs —— 后续在 collector 加 notify provider `apns`，或经 Bark 中转（现有 bark provider 已可满足 iOS 通知）
- Android: FCM —— 同上，预留 provider 槽位（notify.ts providers 表）

## 已知约束
- collector 仅 LAN/Tailscale 可达：手机端需在 tailnet 内（装 Tailscale App）或走内网
- 深链/角标：Web 已实现 Badging API + 离线横幅，Capacitor WebView 支持 Badging（Android 13+ 通知权限需引导）
