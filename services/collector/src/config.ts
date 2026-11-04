import fs from 'node:fs';
import yaml from 'js-yaml';
import type { NetworkConfig } from '../core-src/types.ts';

// ${VAR} 占位符从进程环境解析；密钥只来自 .env，不落库
function resolveVars(input: string): string {
  return input.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? '');
}

export function loadConfig(path = process.env.NETPILOT_CONFIG ?? '/app/network.yaml'): NetworkConfig {
  const raw = fs.readFileSync(path, 'utf8');
  const cfg = yaml.load(resolveVars(raw)) as NetworkConfig;
  if (!cfg?.router?.host) throw new Error('network.yaml 缺少 router.host');
  return cfg;
}

export const env = {
  port: Number(process.env.NETPILOT_PORT ?? 8899),
  dbPath: process.env.NETPILOT_DB ?? '/data/netpilot.db',
  readToken: process.env.NETPILOT_READ_TOKEN ?? '',
  writeToken: process.env.NETPILOT_WRITE_TOKEN ?? '',
  agentToken: process.env.NETPILOT_AGENT_TOKEN ?? '',
  notify: {
    provider: process.env.NOTIFY_PROVIDER ?? 'none',   // none|bark|ntfy|telegram|webhook
    barkUrl: process.env.NOTIFY_BARK_URL ?? '',
    ntfyUrl: process.env.NOTIFY_NTFY_URL ?? '',
    telegramToken: process.env.NOTIFY_TG_TOKEN ?? '',
    telegramChatId: process.env.NOTIFY_TG_CHATID ?? '',
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? '',
    cooldownMin: Number(process.env.NOTIFY_COOLDOWN_MIN ?? 30),
  },
};
