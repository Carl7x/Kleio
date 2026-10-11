/** Product HTTP routes use the official Host's authentication and request trust fence. */
const prefix = '/api/kleio';
const maximumBodyBytes = 64 * 1024;

class RequestError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

async function body(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError('CONTENT_TYPE', '请发送有效的请求。', 415);
  }
  const parts = []; let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > maximumBodyBytes) throw new RequestError('REQUEST_TOO_LARGE', '内容过长，请缩短后重试。', 413);
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError('INVALID_REQUEST', '请检查输入内容。'); }
}

function send(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function reportError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'APPLICATION_ERROR';
  const status = error?.status || (/STALE|CONFLICT|BUSY|FORGOTTEN|UNCERTAIN|DUPLICATE|ACTIVE/.test(code) ? 409
    : /NOT_FOUND|MISSING_RECORD/.test(code) ? 404 : /INVALID|REQUIRED|LIMIT|DELETED|DENIED|UNKNOWN|VERSION|NOT_ALLOWED/.test(code) ? 400 : 500);
  const messages = {
    STALE_VERSION: '这条内容已经更新，请刷新后再试。',
    MEMORY_CONFLICT: '已有不同的记录，请先查看并确认更正。',
    FORGOTTEN_FACT: '这项信息已被遗忘，需要明确确认才能恢复。',
    DELETED_MEMORY: '这条记忆已移到已删除，请先恢复。',
    MEMORY_NOT_FOUND: '找不到这条记忆。',
  };
  return { status, error: { code, message: messages[code] || (status < 500 ? error.message : '操作未完成，请稍后重试。') } };
}

function number(value, fallback) {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) throw new RequestError('INVALID_LIMIT', '请检查列表数量。');
  return Number(value);
}

/** Mount one longest-prefix route on the existing server; never opens a second listener. */
export function mountApplicationHttp(ctx, { memory, tasks, artifacts, routines }) {
  const handler = async (req, res) => {
    // The exact same signed cookie, Host and Origin checks protect native and application data.
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission) { send(res, admission.rejection, { error: { code: 'AUTH_REQUIRED', message: '请重新打开本机助理。' } }); return; }
    try {
      const url = new URL(req.url, 'http://local.invalid');
      const path = url.pathname.slice(prefix.length);
      const method = req.method;
      const params = url.searchParams;
      let data;
      if (path === '/profile' && method === 'GET') data = memory.profileGet();
      else if (path === '/profile' && method === 'PATCH') data = await memory.profileSet(await body(req));
      else if (path === '/memories' && method === 'GET') data = memory.memoryList({ query: params.get('query') || '', includeDeleted: params.get('includeDeleted') === 'true', limit: number(params.get('limit'), 100) });
      else if (path === '/candidates' && method === 'GET') data = memory.candidatesList({ status: params.get('status') || 'pending', limit: number(params.get('limit'), 100) });
      else if (path === '/memory-capture' && method === 'GET') data = memory.capture.stats();
      else if (path === '/memory-files' && method === 'GET') data = memory.memoryFilesGet(params.get('path') || '');
      else if (path === '/memory-files' && method === 'PATCH') data = memory.memoryFilesEdit(await body(req));
      else if (path === '/tasks' && method === 'GET') data = tasks.list({ limit: number(params.get('limit'), 100), ...(params.get('status') ? { status: params.get('status') } : {}) });
      else if (path === '/tasks' && method === 'POST') data = await tasks.create(await body(req));
      else if (path === '/artifacts' && method === 'GET') data = artifacts.list({ ...(params.get('taskId') ? { taskId: params.get('taskId') } : {}) });
      else if (path === '/routines' && method === 'GET') data = await routines.list();
      else if (path === '/routines' && method === 'POST') data = await routines.create(await body(req));
      else if (path === '/routines' && method === 'PATCH') data = await routines.update(await body(req));
      else if (path === '/routines' && method === 'DELETE') data = await routines.delete(await body(req));
      else {
        const match = /^\/(memories|candidates|tasks)\/([^/]+)(?:\/(history|forget|restore|accept|reject|cancel|retry))?$/u.exec(path);
        if (!match) throw new RequestError('NOT_FOUND', '找不到这个入口。', 404);
        const [, kind, rawId, action] = match;
        let id;
        try { id = decodeURIComponent(rawId); } catch { throw new RequestError('INVALID_ID', '找不到这条记录。'); }
        if (id.length > 120) throw new RequestError('INVALID_ID', '找不到这条记录。');
        if (kind === 'memories' && method === 'GET' && !action) data = memory.memoryGet({ id });
        else if (kind === 'memories' && method === 'GET' && action === 'history') data = memory.memoryHistory({ id });
        else if (kind === 'memories' && method === 'PATCH' && !action) data = await memory.memoryCorrect({ ...await body(req), id });
        else if (kind === 'memories' && method === 'POST' && action === 'forget') data = await memory.memoryForget({ ...await body(req), id });
        else if (kind === 'memories' && method === 'POST' && action === 'restore') data = await memory.memoryRestore({ ...await body(req), id });
        else if (kind === 'candidates' && method === 'POST' && action === 'accept') data = await memory.candidatesAccept({ ...await body(req), id });
        else if (kind === 'candidates' && method === 'POST' && action === 'reject') data = await memory.candidatesReject({ ...await body(req), id });
        else if (kind === 'tasks' && method === 'GET' && !action) data = tasks.detail({ id });
        else if (kind === 'tasks' && method === 'POST' && action === 'cancel') data = await tasks.cancel({ ...await body(req), id });
        else if (kind === 'tasks' && method === 'POST' && action === 'retry') data = await tasks.retry({ ...await body(req), id });
        else throw new RequestError('NOT_FOUND', '找不到这个操作。', 404);
      }
      send(res, method === 'POST' && path === '/tasks' ? 201 : 200, { data });
    } catch (error) { const result = reportError(error); send(res, result.status, { error: result.error }); }
  };
  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }), 'kleio: authenticated product API');
}
