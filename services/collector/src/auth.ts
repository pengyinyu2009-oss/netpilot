import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from './config.ts';

export type Scope = 'read' | 'write';

function tokenScope(token: string | undefined): Scope | null {
  if (!token) return null;
  if (env.writeToken && token === env.writeToken) return 'write';
  if (env.readToken && token === env.readToken) return 'read';
  return null;
}

export function extractToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const q = req.query as { token?: string };
  return q.token;
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const s = tokenScope(extractToken(req));
    if (!s) { reply.code(401).send({ error: 'invalid or missing token' }); return; }
    if (scope === 'write' && s !== 'write') { reply.code(403).send({ error: 'write token required' }); return; }
  };
}
