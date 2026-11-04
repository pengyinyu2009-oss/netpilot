// SSH 拉取式 agent：对不在 tailnet、但有 SSH 通道的机器（aly/GCP），collector 周期执行
// 目标机上的 netpilot-agent.sh --once（输出 JSON 到 stdout），喂给与 push 相同的 ingest
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkConfig } from '../core-src/types.ts';
import { ingestReport } from './ingest.ts';
import * as store from './store.ts';
import { alertWithNotify } from './notify.ts';

const execFileP = promisify(execFile);

interface PullTarget {
  id: string; name: string; host: string;
  user: string; key: string; everySeconds: number; script: string;
}

export class Puller {
  private targets: PullTarget[] = [];
  private lastOk = new Map<string, boolean>();   // 状态变化才记事件/告警

  constructor(private cfg: NetworkConfig) {
    const all: { id: string; name: string; host: string; agent?: { pull?: { user: string; key: string; everySeconds?: number; script?: string } } }[] = [
      ...cfg.devices, ...cfg.exits,
    ];
    for (const n of all) {
      const p = n.agent?.pull;
      if (p?.key && p?.user) {
        this.targets.push({
          id: n.id, name: n.name, host: n.host,
          user: p.user, key: p.key,
          everySeconds: Math.max(30, p.everySeconds ?? 60),
          script: p.script ?? '/usr/local/bin/netpilot-agent.sh',
        });
      }
    }
  }

  private async pullOne(t: PullTarget): Promise<boolean> {
    try {
      const { stdout } = await execFileP('ssh', [
        '-i', t.key,
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=12', '-o', 'LogLevel=ERROR',
        `${t.user}@${t.host}`, `${t.script} --once`,
      ], { timeout: 25_000 });
      const m = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
      ingestReport(t.id, t.name, m);
      return true;
    } catch (e) {
      return false;
    }
  }

  async poll() {
    await Promise.all(this.targets.map(async t => {
      const ok = await this.pullOne(t);
      const prev = this.lastOk.get(t.id);
      if (prev === undefined || prev !== ok) {
        if (ok) {
          store.logEvent('info', 'puller', `${t.name} agent 拉取恢复`);
          store.ackAlertsByRulePrefix(`agent_down:${t.id}`);   // 恢复即自动关闭对应告警
        } else {
          alertWithNotify(`agent_down:${t.id}`, 'warning',
            `${t.name} agent 拉取失败（SSH ${t.user}@${t.host}）`, { host: t.host });
        }
      }
      this.lastOk.set(t.id, ok);
    }));
  }

  start() {
    if (!this.targets.length) return;
    const interval = Math.min(...this.targets.map(t => t.everySeconds));
    console.log(`[netpilot] puller: ${this.targets.map(t => t.id).join(', ')} every ${interval}s`);
    void this.poll();
    setInterval(() => void this.poll(), interval * 1000).unref();
  }
}
