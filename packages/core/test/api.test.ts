import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../store.ts';
import { AgentService, DemoEngine } from '../service.ts';
import { createApp } from '../../../apps/server/app.ts';

test('API validates requests, persists a background result and replays events', async () => {
  const store = new AgentStore(':memory:'); const service = new AgentService(store, new DemoEngine(1)); const app = createApp(service);
  try {
    const request = (route: string, init?: RequestInit) => app.request('http://localhost' + route, init);
    assert.equal((await request('/api/tasks', { method: 'POST', body: '{}' })).status, 400);
    const memory = await request('/api/memories', { method: 'POST', body: JSON.stringify({ text: '我喜欢短回复', source: 'user' }) }); assert.equal(memory.status, 201);
    const response = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ prompt: '短回复' }) }); assert.equal(response.status, 202);
    const input: { runId: string } = await response.json(); await service.wait(input.runId);
    const stream = await request('/api/runs/' + input.runId + '/stream'); assert.match(await stream.text(), /event: run.completed/);
    const artifacts: unknown[] = await (await request('/api/artifacts')).json(); assert.equal(artifacts.length, 1);
    assert.equal((await request('/api/tasks', { method: 'POST', headers: { origin: 'https://untrusted.example' }, body: JSON.stringify({ prompt: 'task' }) })).status, 403);
    assert.equal((await app.request('http://external.example/api/health')).status, 403);
  } finally { await service.close(); store.close(); }
});
