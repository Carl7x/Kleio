import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';

let nativeURL = '';
let nativeToken = '';
export function setTransport(url: string, token = ''): void { nativeURL = url; nativeToken = token; }
export function getServerURL(): string { return Platform.OS === 'web' ? globalThis.location?.origin ?? '' : nativeURL; }
export function serverURL(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || !['', '/'].includes(url.pathname)) throw new Error('请填写 Kleio 的服务地址，例如 http://192.168.1.10:4317。');
  const local = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname) || url.hostname.endsWith('.local');
  if (url.protocol !== 'https:' && !local) throw new Error('远程地址需要使用 HTTPS；同一局域网可以使用 HTTP。');
  return url.origin;
}
export async function clientFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (Platform.OS === 'web') return globalThis.fetch(path, { ...init, credentials: 'same-origin' });
  if (!nativeURL) throw new Error('请先连接你的 Kleio。');
  const headers = new Headers(init.headers);
  if (nativeToken) headers.set('Authorization', 'Bearer ' + nativeToken);
  const fetcher = /^\/api\/(?:executions|conversations)\/[^/]+\/stream\?/.test(path) ? expoFetch : globalThis.fetch;
  return fetcher(nativeURL + path, {
    method: init.method, headers, signal: init.signal ?? undefined,
    body: typeof init.body === 'string' ? init.body : undefined,
    credentials: 'omit', redirect: 'error',
  }) as unknown as Promise<Response>;
}
