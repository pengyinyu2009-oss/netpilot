# M5d — HarmonyOS 鸿蒙覆盖策略（决策记录，2026-11-04）

## 结论：PWA 打底即可，原生 ArkTS 暂不立项

依据（计划即预置的判据：「仅在 PWA 实测体验不足时」才做原生薄客户端）：

1. PWA 已覆盖核心体验：移动优先布局 + 安全区 + 离线壳（SW precache）+ 角标（Badging）+ 令牌持久化
2. 鸿蒙系统浏览器（基于 Chromium 内核）支持 PWA 安装到桌面、Service Worker、localStorage
3. NetPilot 是「看 + 偶尔操作」的管控面板，无高频推送/后台采集需求 —— 通知走 Bark/ntfy/Telegram
   （collector notify provider 已内置），不依赖系统推送通道
4. 原生壳的成本：DevEco Studio 工具链 + ArkTS 薄客户端维护 + 每次前端契约变更双端同步

## 触发重新评估的条件（满足其一再立项）
- 鸿蒙端 PWA 安装后 Service Worker 被杀导致离线壳失效
- 需要 Push Kit 系统级推送（notify provider 已预留 provider 槽位，届时加 `harmony_push`）
- 需要桌面小组件/负一屏卡片

## 若立项：ArkTS 薄客户端路径
- Client API 契约已冻结：REST `/api/*`（Bearer token）——见 packages/web/src/api.ts 与 docs/client-api 需求
- 最小实现：Web 组件加载 PWA + 原生壳仅做推送接收与角标转发
- 复用 `globalThis.__NETPILOT_API__` 注入机制（api.ts 已预留）
