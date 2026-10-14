import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function publicAddress(address: string): boolean {
  const parts = address.split('.').map(Number); const a = parts[0]!, b = parts[1]!;
  return parts.length === 4 && ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}

export async function readWeb(input: string, signal?: AbortSignal, redirects = 0): Promise<{ url: string; text: string; fetchedAt: string; truncated: boolean }> {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]);
  deadline.throwIfAborted();
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP(S) documents on standard ports are supported.');
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const aborted = () => reject(new Error('Document read cancelled or timed out.'));
    deadline.addEventListener('abort', aborted, { once: true });
    void lookup(url.hostname, { all: true, family: 4 }).then(resolve, reject).finally(() => deadline.removeEventListener('abort', aborted));
    if (deadline.aborted) aborted();
  });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private and reserved network destinations are unavailable.');
  deadline.throwIfAborted();
  const address = addresses[0]!.address;
  const result = await new Promise<{ status: number; location?: string; type: string; body: string; truncated: boolean }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal: deadline,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: { 'User-Agent': 'Kleio/0.5', Accept: 'text/html,text/plain,application/rss+xml,application/atom+xml,application/json', 'Accept-Encoding': 'identity' },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const finish = (truncated: boolean) => resolve({ status: response.statusCode ?? 0, ...(response.headers.location ? { location: response.headers.location } : {}), type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8'), truncated });
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk.subarray(0, Math.max(0, 1_000_000 - size))); size += chunk.length;
        if (size >= 1_000_000) { finish(true); response.destroy(); request.destroy(); }
      });
      response.on('error', reject);
      response.on('end', () => finish(false));
    });
    request.setTimeout(20_000, () => request.destroy(new Error('Document read timed out.')));
    request.on('error', reject); request.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
    if (redirects >= 3) throw new Error('Too many document redirects.');
    return readWeb(new URL(result.location, url).href, deadline, redirects + 1);
  }
  if (result.status < 200 || result.status >= 300) throw new Error(`Document returned HTTP ${result.status}.`);
  if (!/text|json|xml/i.test(result.type)) throw new Error('This connector reads text documents only.');
  const text = result.body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return { url: url.href, text: text.slice(0, 24_000), fetchedAt: new Date().toISOString(), truncated: result.truncated || text.length > 24_000 };
}
