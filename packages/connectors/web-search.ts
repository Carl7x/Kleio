import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

export interface WebSearchResult {
  query: string;
  results: Array<{ url: string; title: string; content: string }>;
  warnings: string[];
  truncated: boolean;
}

export class WebSearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WebSearchError'; }
}

const responseLimit = 256_000;
const queryLimit = 1000;
const snippetLimit = 2000;
const resultLimit = 3;
const transientStatuses = new Set([502, 503, 504]);
const transientNetworkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function transientTransport(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) return false;
  if ('code' in error && typeof error.code === 'string' && transientNetworkCodes.has(error.code)) return true;
  if (error instanceof AggregateError && error.errors.some(cause => transientTransport(cause, depth + 1))) return true;
  return transientTransport(error.cause, depth + 1);
}

function publicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number); const a = parts[0]!, b = parts[1]!;
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && ![0, 10, 127].includes(a) && a < 224 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b))
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}

async function citationUrl(input: unknown, signal: AbortSignal): Promise<string | undefined> {
  if (typeof input !== 'string' || input.length > 2000 || !/^https?:\/\//i.test(input) || /[\u0000-\u0020\u007f]/.test(input)) return;
  let url: URL;
  try { url = new URL(input); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || !url.hostname.includes('.')
    || /[:\[\]]/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|home|lan|onion|invalid|test|example)$/i.test(url.hostname)) return;
  // Match web_read's public IPv4 boundary before exposing a clickable citation.
  try {
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const aborted = () => reject(new WebSearchError('search_cancelled', 'Web search cancelled or timed out.'));
      signal.addEventListener('abort', aborted, { once: true });
      void lookup(url.hostname, { all: true, family: 4 }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
    });
    if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) return;
    // Preserve the provider's exact source URL, including its citation path and query.
    return input;
  } catch { signal.throwIfAborted(); return; }
}

function statusError(status: number, keyed: boolean): WebSearchError {
  if (status === 401 || status === 403) return new WebSearchError('search_auth', keyed ? 'Tavily rejected the configured search key. Check the server-side Tavily key.' : 'Tavily keyless search is unavailable. A server-side Tavily key can enable account access.');
  if ([429, 432, 433].includes(status)) return new WebSearchError('search_limit', keyed ? 'Tavily search reached an account rate or usage limit. Try again later or review the Tavily account limits.' : 'Tavily keyless search reached its rate limit. Try again later or configure a server-side Tavily key.');
  if (status === 400 || status === 422) return new WebSearchError('search_request', 'Tavily rejected this search request. Rephrase or shorten the query.');
  return new WebSearchError('search_provider', `Tavily search returned HTTP ${status}. Try again later.`);
}

async function readResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > responseLimit) {
    await response.body?.cancel(); throw new WebSearchError('search_response_limit', 'Tavily search response exceeded the size limit.');
  }
  if (!response.body) throw new WebSearchError('search_response', 'Tavily search returned an empty response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > responseLimit) throw new WebSearchError('search_response_limit', 'Tavily search response exceeded the size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new WebSearchError('search_response', 'Tavily search returned an invalid response.'); }
}

/** Searches only Tavily's fixed endpoint; response text is untrusted source material. */
export async function searchWeb(input: { query: string; maxResults?: number }, options: { apiKey?: string } = {}, signal?: AbortSignal): Promise<WebSearchResult> {
  const query = input.query.trim(); const maxResults = input.maxResults ?? resultLimit;
  if (!query || query.length > queryLimit || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > resultLimit) throw new WebSearchError('search_input', 'Search requires a query of 1–1000 characters and 1–3 results.');
  const apiKey = options.apiKey?.trim();
  if (apiKey && (apiKey.length > 1024 || !/^[\x21-\x7e]+$/.test(apiKey))) throw new WebSearchError('search_config', 'The server-side Tavily key is invalid.');
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]);
  try {
    let raw: unknown;
    // One retry shares the original deadline and request. Do not retry auth,
    // usage limits, malformed responses, or permanent transport failures.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      deadline.throwIfAborted();
      try {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST', signal: deadline, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : { 'X-Tavily-Access-Mode': 'keyless' }) },
          body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', topic: 'general', auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false }),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (attempt === 0 && transientStatuses.has(response.status)) { await delay(250, undefined, { signal: deadline }); continue; }
          throw statusError(response.status, Boolean(apiKey));
        }
        raw = await readResponse(response); break;
      } catch (error) {
        deadline.throwIfAborted();
        if (attempt !== 0 || !transientTransport(error)) throw error;
        await delay(250, undefined, { signal: deadline });
      }
    }
    if (!raw || typeof raw !== 'object' || !('results' in raw) || !Array.isArray(raw.results)) throw new WebSearchError('search_response', 'Tavily search returned an invalid result list.');
    const warnings: string[] = [];
    const results: WebSearchResult['results'] = []; let truncated = raw.results.length > maxResults; let omitted = false;
    for (const item of raw.results.slice(0, maxResults)) {
      if (!item || typeof item !== 'object') { omitted = true; continue; }
      const source = item as Record<string, unknown>;
      const url = await citationUrl(source.url, deadline);
      if (!url) { omitted = true; continue; }
      const title = typeof source.title === 'string' ? source.title : '';
      const content = typeof source.content === 'string' ? source.content : '';
      truncated ||= title.length > 300 || content.length > snippetLimit;
      results.push({ url, title: title.slice(0, 300), content: content.slice(0, snippetLimit) });
    }
    if (omitted) { truncated = true; warnings.push('Some results were omitted because their source URLs were invalid, unavailable, or not public.'); }
    if (truncated) warnings.push('Search results or snippets were shortened to fit the search limits.');
    deadline.throwIfAborted();
    return { query, results, warnings, truncated };
  } catch (error) {
    if (signal?.aborted) throw new WebSearchError('search_cancelled', 'Web search cancelled.');
    if (deadline.aborted) throw new WebSearchError('search_timeout', 'Tavily search timed out. Try again later.');
    if (error instanceof WebSearchError) throw error;
    // Provider and transport bodies can contain secrets or instructions; never forward them.
    throw new WebSearchError('search_transport', 'Tavily search could not be reached. Check the runtime network connection and try again later.');
  }
}
