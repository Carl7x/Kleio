/** Request native Harness teardown through this launcher's private local endpoint. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(await readFile(resolve(root, '.data/native-web.json'), 'utf8'));
if (!Number.isInteger(state.controlPort) || typeof state.controlToken !== 'string') throw new Error('Native launcher state is invalid.');
const result = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, {
  method: 'POST', headers: { authorization: `Bearer ${state.controlToken}` }, signal: AbortSignal.timeout(5_000),
});
if (result.status !== 202) throw new Error(`Native shutdown request failed (${result.status}).`);
console.log('DeepSeek Harness is shutting down.');
