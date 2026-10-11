/** Same-origin API client. Mutations are never automatically replayed. */
export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Create a client with an injectable fetch for focused transport checks. */
export function createApi(send = globalThis.fetch.bind(globalThis)) {
  async function request(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await send(`/api/kleio${path}`, {
        method, credentials: 'same-origin', signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(method === 'GET' ? 'CONNECTION_FAILED' : 'OUTCOME_UNKNOWN',
        method === 'GET' ? '连接中断，请重试。' : '连接中断，操作结果未确认。请先刷新查看，避免重复操作。');
    }
    let payload;
    try { payload = await response.json(); }
    catch {
      throw new ApiError(method === 'GET' ? 'INVALID_RESPONSE' : 'OUTCOME_UNKNOWN',
        method === 'GET' ? '服务暂时无法读取，请重试。' : '服务返回异常，操作结果未确认。请先刷新查看。', response.status);
    }
    if (!response.ok) {
      const code = payload?.error?.code || `HTTP_${response.status}`;
      const known = {
        INVALID_INPUT: '请检查填写内容。语言和时区需要使用有效值。',
        SECRET_NOT_ALLOWED: '请移除密码、密钥或访问令牌后再保存。',
        FORGOTTEN_FACT: '这项内容曾被移除，请到“已移除”中明确恢复。',
        NOT_FOUND: '内容已不存在，请刷新。',
        TASK_ACTIVE: '任务仍在执行，请先处理确认或停止任务。',
        INSPECTION_REQUIRED: '请先查看执行过程，并确认可以再次执行。',
      };
      const message = response.status === 401 || response.status === 403 ? '连接已失效，请重新打开应用。'
        : /STALE|CONFLICT|VERSION/.test(code) ? '内容已更新，请刷新后再操作。'
        : known[code] || '操作未完成，请刷新后重试。';
      throw new ApiError(code, message, response.status);
    }
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
      throw new ApiError(method === 'GET' ? 'INVALID_RESPONSE' : 'OUTCOME_UNKNOWN', '服务返回的数据不完整，请先刷新确认操作结果。', response.status);
    }
    return payload.data;
  }
  const id = value => encodeURIComponent(value);
  const query = values => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
    return params.size ? `?${params}` : '';
  };
  return {
    profile: signal => request('/profile', { signal }),
    saveProfile: body => request('/profile', { method: 'PATCH', body }),
    memories: (values, signal) => request(`/memories${query(values)}`, { signal }),
    memory: (value, signal) => request(`/memories/${id(value)}`, { signal }),
    history: (value, signal) => request(`/memories/${id(value)}/history`, { signal }),
    correctMemory: (value, body) => request(`/memories/${id(value)}`, { method: 'PATCH', body }),
    forgetMemory: (value, expectedVersion) => request(`/memories/${id(value)}/forget`, { method: 'POST', body: { expectedVersion } }),
    restoreMemory: (value, body) => request(`/memories/${id(value)}/restore`, { method: 'POST', body }),
    candidates: (signal) => request('/candidates?status=pending', { signal }),
    memoryCapture: signal => request('/memory-capture', { signal }),
    memoryFiles: signal => request('/memory-files', { signal }),
    memoryFile: (path, signal) => request(`/memory-files${query({ path })}`, { signal }),
    editMemoryFile: body => request('/memory-files', { method: 'PATCH', body }),
    acceptCandidate: (value, body) => request(`/candidates/${id(value)}/accept`, { method: 'POST', body }),
    rejectCandidate: (value, expectedVersion) => request(`/candidates/${id(value)}/reject`, { method: 'POST', body: { expectedVersion } }),
    tasks: signal => request('/tasks', { signal }),
    task: (value, signal) => request(`/tasks/${id(value)}`, { signal }),
    createTask: body => request('/tasks', { method: 'POST', body }),
    cancelTask: value => request(`/tasks/${id(value)}/cancel`, { method: 'POST', body: {} }),
    retryTask: (value, body) => request(`/tasks/${id(value)}/retry`, { method: 'POST', body }),
    artifacts: (values, signal) => request(`/artifacts${query(values)}`, { signal }),
  };
}
