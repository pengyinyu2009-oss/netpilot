// TCP / HTTP / ICMP 探针：collector 独立测量设备与出口可达性（不依赖 mihomo）
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbePoint, ProbeSpec } from '../core-src/types.ts';

const execFileP = promisify(execFile);

function tcpProbe(host: string, port: number, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (err?: Error) => { sock.destroy(); err ? reject(err) : resolve(Date.now() - started); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done());
    sock.once('timeout', () => done(new Error('timeout')));
    sock.once('error', done);
  });
}

async function httpProbe(url: string, secret: string, timeoutMs = 5000): Promise<number> {
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const req = http.get(url, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, timeout: timeoutMs },
      res => { res.resume(); res.statusCode && res.statusCode < 500 ? resolve() : reject(new Error('HTTP ' + res.statusCode)); });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
  });
  return Date.now() - started;
}

async function icmpProbe(host: string, timeoutMs = 4000): Promise<number> {
  const { stdout } = await execFileP('ping', ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), host]);
  const m = stdout.match(/time[=<]([\d.]+)\s*ms/);
  if (!m) throw new Error('no rtt');
  return Math.round(parseFloat(m[1]));
}

export async function runProbe(spec: ProbeSpec, host: string): Promise<ProbePoint> {
  const ts = Date.now();
  const target = spec.host ?? host;   // 单条 probe 可覆写目标（host.docker.internal 等）
  try {
    let latencyMs: number;
    if (spec.type === 'tcp' && spec.port) latencyMs = await tcpProbe(target, spec.port);
    else if (spec.type === 'http' && spec.url) latencyMs = await httpProbe(spec.url, spec.secret ?? '');
    else if (spec.type === 'icmp') latencyMs = await icmpProbe(target);
    else throw new Error('bad probe spec');
    return { ts, latencyMs, ok: true };
  } catch {
    return { ts, latencyMs: null, ok: false };
  }
}

// 一组 probe 里取第一个可用结果（任一通则算通）
export async function runProbeGroup(specs: ProbeSpec[], host: string): Promise<ProbePoint> {
  const results = await Promise.all(specs.map(s => runProbe(s, host)));
  const ok = results.find(r => r.ok);
  return ok ?? { ts: Date.now(), latencyMs: null, ok: false };
}
