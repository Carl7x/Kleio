import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, Hono } from 'hono';
import { repositoryRoot } from '../../packages/runtime/config.ts';

const maxAge = 7 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Exchanges a short-lived, single-use launch ticket for an HttpOnly browser session. */
export class BrowserSessions {
  private readonly tickets = new Map<string, number>();
  private readonly cookieName: string;
  constructor(private readonly secret: string, port: number) { this.cookieName = `kleio_session_${port}`; }
  issue(): { ticket: string; expiresAt: string } {
    const now = Date.now();
    for (const [key, expires] of this.tickets) if (expires <= now) this.tickets.delete(key);
    while (this.tickets.size >= 20) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url'); const expires = now + 60_000;
    this.tickets.set(digest(ticket), expires);
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  private signature(value: string): string {
    return createHmac('sha256', this.secret).update(this.cookieName + ':' + value).digest('base64url');
  }
  exchange(ticket: string, c: Context): boolean {
    const key = digest(ticket); const expires = this.tickets.get(key);
    this.tickets.delete(key);
    if (!expires || expires <= Date.now()) return false;
    const payload = `${Date.now() + maxAge * 1000}.${randomBytes(24).toString('base64url')}`;
    setCookie(c, this.cookieName, payload + '.' + this.signature(payload), {
      httpOnly: true, sameSite: 'Strict', path: '/', maxAge,
    });
    return true;
  }
  authenticated(c: Context): boolean {
    const value = getCookie(c, this.cookieName);
    if (!value || value.length > 256) return false;
    const match = /^(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + maxAge * 1000) return false;
    const payload = match[1] + '.' + match[2];
    return equal(match[3]!, this.signature(payload));
  }
  clear(c: Context): void { deleteCookie(c, this.cookieName, { path: '/' }); }
}

export function mountWeb(app: Hono): void {
  const root = join(repositoryRoot, 'apps/mobile/dist/web');
  app.get('/', async (c, next) => {
    if (!existsSync(join(root, 'index.html'))) return c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Kleio</title><h1>Kleio</h1><p>请在项目目录运行 <code>pnpm web</code>，构建并打开可视界面。</p></html>', 503);
    return serveStatic({ root, path: 'index.html' })(c, next);
  });
  app.get('/assets/*', serveStatic({ root }));
  app.get('/_expo/static/*', serveStatic({ root }));
  app.get('/favicon.svg', serveStatic({ root }));
  app.get('/favicon.ico', serveStatic({ root }));
  app.get('/manifest.webmanifest', serveStatic({ root }));
}
