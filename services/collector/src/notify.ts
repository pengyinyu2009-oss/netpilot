// 通知 provider 抽象：bark / ntfy / telegram / webhook，.env 里 NOTIFY_PROVIDER 选一
// 冷却去重：同 key 在 cooldownMin 内只发一条，避免探针 30s 一轮刷屏
import { env } from './config.ts';
import * as store from './store.ts';

export interface Notification {
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
}

type SendFn = (n: Notification) => Promise<void>;

const post = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(8000) });

const providers: Record<string, SendFn> = {
  none: async () => { /* 未配置通知渠道，只落库 */ },

  // Bark（iOS）：NOTIFY_BARK_URL=https://api.day.app/<key>
  bark: async n => {
    const u = env.notify.barkUrl.replace(/\/$/, '');
    await post(
      `${u}/${encodeURIComponent(n.title)}/${encodeURIComponent(n.message)}?group=NetPilot`,
      '' as BodyInit,
    );
  },

  // ntfy：NOTIFY_NTFY_URL=https://ntfy.sh/<topic>；中文标题不能进 HTTP header（ByteString 限制），
  // 改用 ntfy JSON 发布（UTF-8 安全）
  ntfy: async n => {
    const m = env.notify.ntfyUrl.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    if (!m) throw new Error('NOTIFY_NTFY_URL 需为 https://host/topic 形式');
    await post(m[1], JSON.stringify({
      topic: m[2],
      title: n.title,
      message: n.message,
      priority: n.severity === 'critical' ? 'urgent' : n.severity === 'warning' ? 'high' : 'default',
      tags: ['rotating_light'],
    }), { 'Content-Type': 'application/json' });
  },

  // Telegram：NOTIFY_TG_TOKEN + NOTIFY_TG_CHATID
  telegram: async n => {
    await post(
      `https://api.telegram.org/bot${env.notify.telegramToken}/sendMessage`,
      JSON.stringify({ chat_id: env.notify.telegramChatId, text: `${n.title}\n${n.message}` }),
      { 'Content-Type': 'application/json' },
    );
  },

  // webhook：NOTIFY_WEBHOOK_URL，POST JSON {title,message,severity}
  webhook: async n => {
    await post(env.notify.webhookUrl, JSON.stringify(n), { 'Content-Type': 'application/json' });
  },
};

const lastSent = new Map<string, number>();

export async function notify(key: string, n: Notification): Promise<void> {
  const send = providers[env.notify.provider] ?? providers.none;
  const cooldownMs = env.notify.cooldownMin * 60_000;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < cooldownMs) return;
  lastSent.set(key, now);
  try {
    await send(n);
    store.logEvent('info', 'notify', `sent ${env.notify.provider}: ${n.title}`);
  } catch (e) {
    lastSent.delete(key);
    store.logEvent('warn', 'notify', `send failed: ${(e as Error).message}`);
  }
}

// 告警落库 + 触发通知的统一入口（provider=none 时只落库）
export function alertWithNotify(rule: string, severity: string, message: string, data?: unknown): boolean {
  const raised = store.raiseAlertOnce(rule, severity, message, data);
  if (raised) {
    void notify(`alert:${rule}`, {
      title: `NetPilot ${severity === 'critical' ? '‼️' : '⚠️'} ${message.slice(0, 60)}`,
      message,
      severity: severity as Notification['severity'],
    });
  }
  return raised;
}
