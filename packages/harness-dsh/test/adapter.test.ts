import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DshAcpClient, DshAcpError, type DshAcpEvent, type DshAcpOptions } from '../src/index.ts';

const fixture = fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url));
function client(options: Partial<DshAcpOptions> = {}): DshAcpClient {
  return new DshAcpClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 2_000, closeTimeoutMs: 500, ...options });
}

test('routes overlapping sessions and preserves semantic updates', async () => {
  const adapter = client();
  try {
    const [a, b] = await Promise.all([adapter.createSession({ cwd: process.cwd() }), adapter.createSession({ cwd: process.cwd() })]);
    const updatesA: DshAcpEvent[] = [];
    const updatesB: DshAcpEvent[] = [];
    const [resultA, resultB] = await Promise.all([
      adapter.prompt({ sessionId: a.sessionId, text: 'alpha', onEvent: event => updatesA.push(event) }),
      adapter.prompt({ sessionId: b.sessionId, text: 'beta', onEvent: event => updatesB.push(event) }),
    ]);
    assert.equal(resultA.stopReason, 'end_turn');
    assert.equal(resultB.stopReason, 'end_turn');
    assert.deepEqual(updatesA.map(event => event.sessionId), [a.sessionId]);
    assert.deepEqual(updatesB.map(event => event.sessionId), [b.sessionId]);
    assert.equal(updatesA[0]?.update.sessionUpdate, 'agent_message_chunk');
  } finally { await adapter.close(); }
});

test('permission defaults deny and grants only an advertised one-shot choice', async () => {
  for (const choice of [undefined, 'allow', 'invented', 'always'] as const) {
    const events: DshAcpEvent[] = [];
    const adapter = client({ ...(choice === undefined ? {} : { onPermission: () => choice }) });
    try {
      const session = await adapter.createSession({ cwd: process.cwd() });
      await adapter.prompt({ sessionId: session.sessionId, text: 'permission', onEvent: event => events.push(event) });
      const text = (events[0]?.update.content as { text: string }).text;
      const reply = JSON.parse(text) as { outcome: { outcome: string; optionId?: string } };
      if (choice === 'allow') assert.equal(reply.outcome.optionId, 'allow');
      else if (choice === undefined) assert.equal(reply.outcome.optionId, 'reject');
      else assert.equal(reply.outcome.outcome, 'cancelled');
    } finally { await adapter.close(); }
  }
});

test('cancel settles only the selected session and rejects concurrent prompts', async () => {
  const adapter = client();
  try {
    const a = await adapter.createSession({ cwd: process.cwd() });
    const b = await adapter.createSession({ cwd: process.cwd() });
    let release: (() => void) | undefined;
    const working = new Promise<void>(resolve => { release = resolve; });
    const pending = adapter.prompt({ sessionId: a.sessionId, text: 'hold', onEvent: () => release?.() });
    await working;
    await assert.rejects(adapter.prompt({ sessionId: a.sessionId, text: 'second' }), (error: unknown) => error instanceof DshAcpError && error.code === 'SESSION_BUSY');
    assert.equal((await adapter.prompt({ sessionId: b.sessionId, text: 'still works' })).stopReason, 'end_turn');
    adapter.cancel(a.sessionId);
    assert.equal((await pending).stopReason, 'cancelled');
  } finally { await adapter.close(); }
});

test('AbortSignal requests cancellation and waits for the peer settlement', async () => {
  const adapter = client();
  try {
    const session = await adapter.createSession({ cwd: process.cwd() });
    const controller = new AbortController();
    const result = await adapter.prompt({ sessionId: session.sessionId, text: 'hold', signal: controller.signal, onEvent: () => controller.abort() });
    assert.equal(result.stopReason, 'cancelled');
  } finally { await adapter.close(); }
});

test('invalid stdout fails pending calls instead of accepting a false result', async () => {
  const adapter = client();
  try {
    const session = await adapter.createSession({ cwd: process.cwd() });
    await assert.rejects(adapter.prompt({ sessionId: session.sessionId, text: 'malformed' }));
  } finally { await adapter.close(); }
});

test('timeout reports an unknown result and never resends the prompt', async () => {
  const events: DshAcpEvent[] = [];
  const adapter = client({ env: { ...process.env, FIXTURE_IGNORE_CANCEL: '1' }, promptTimeoutMs: 60 });
  try {
    const session = await adapter.createSession({ cwd: process.cwd() });
    await assert.rejects(adapter.prompt({ sessionId: session.sessionId, text: 'hold', onEvent: event => events.push(event) }), (error: unknown) => error instanceof DshAcpError && error.code === 'REQUEST_TIMEOUT');
    assert.equal(events.length, 1);
    await assert.rejects(adapter.prompt({ sessionId: session.sessionId, text: 'do not retry an uncertain mutation' }), (error: unknown) => error instanceof DshAcpError && error.code === 'OUTCOME_UNKNOWN');
  } finally { await adapter.close(); }
});
