// collector 内的 SSH 执行辅助：key 或 passwordEnv（sshpass）两种凭据，供修复引擎用
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  key?: string;            // 容器内私钥路径
  passwordEnv?: string;    // 容器环境变量名（值=SSH 密码，走 sshpass）
}

export async function sshRun(t: SshTarget, command: string, timeoutMs = 25_000): Promise<string> {
  const args: string[] = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=12', '-o', 'LogLevel=ERROR'];
  if (t.port) args.push('-p', String(t.port));
  if (t.key) args.push('-i', t.key);
  if (t.passwordEnv) {
    const pass = process.env[t.passwordEnv] ?? '';
    if (!pass) throw new Error(`env ${t.passwordEnv} not set`);
    // 密码认证：禁 BatchMode，明确走 keyboard-interactive/password
    args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive');
    args.push(`${t.user}@${t.host}`, command);
    const r = await execFileP('sshpass', ['-p', pass, 'ssh', ...args], { timeout: timeoutMs });
    return r.stdout;
  }
  args.push('-o', 'BatchMode=yes');
  args.push(`${t.user}@${t.host}`, command);
  const r = await execFileP('ssh', args, { timeout: timeoutMs });
  return r.stdout;
}
