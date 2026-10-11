/** Exercises the pinned upstream MCP server without a model or access to product memories. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = join(projectRoot, 'packages/native-memory/.runtime/node_modules');
const { Client } = await import(pathToFileURL(join(runtimeRoot, '@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(runtimeRoot, '@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
const packageData = JSON.parse(await readFile(join(runtimeRoot, '@modelcontextprotocol/server-memory/package.json'), 'utf8'));
assert.equal(packageData.version, '2026.7.4');
const workDirectory = await mkdtemp(join(tmpdir(), 'kleio-native-memory-'));
const memoryFile = join(workDirectory, 'memory.jsonl');
const checks = [];
let client;

async function connect() {
  client = new Client({ name: 'kleio-memory-verification', version: '1.0.0' });
  const environment = { MEMORY_FILE_PATH: memoryFile };
  // Preserve only Windows process essentials; never pass model keys or other credentials.
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(runtimeRoot, '@modelcontextprotocol/server-memory/dist/index.js')],
    cwd: workDirectory,
    env: environment,
    stderr: 'pipe',
  });
  await client.connect(transport);
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `MCP ${name} returned isError`);
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}

try {
  await connect();
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const required of ['create_entities', 'add_observations', 'delete_observations', 'search_nodes', 'open_nodes', 'delete_entities', 'read_graph']) {
    assert.ok(tools.includes(required), `Missing upstream tool ${required}`);
  }
  checks.push('Upstream MCP tools discovered');
  const entityName = '验收样例用户';
  const oldPreference = '验收饮品偏好：桂花乌龙，不加糖。';
  const newPreference = '验收饮品偏好：茉莉花茶，不加糖。';
  await call('create_entities', { entities: [{ name: entityName, entityType: '验收样例', observations: [oldPreference] }] });
  assert.equal((await call('search_nodes', { query: '桂花乌龙' })).entities[0].name, entityName);
  checks.push('Chinese entity and observation created and found by substring');
  const persisted = await readFile(memoryFile, 'utf8');
  assert.ok(persisted.includes('桂花乌龙'));
  const storedDigest = createHash('sha256').update(persisted).digest('hex');
  await client.close();
  client = undefined;
  await connect();
  assert.ok((await call('open_nodes', { names: [entityName] })).entities[0].observations.includes(oldPreference));
  checks.push('Chinese memory persisted and read after MCP process restart');
  await call('add_observations', { observations: [{ entityName, contents: [newPreference] }] });
  await call('delete_observations', { deletions: [{ entityName, observations: [oldPreference] }] });
  assert.equal((await call('search_nodes', { query: '桂花乌龙' })).entities.length, 0);
  assert.ok((await call('search_nodes', { query: '茉莉花茶' })).entities[0].observations.includes(newPreference));
  checks.push('Preference changed with upstream add/delete observation tools');
  await call('delete_entities', { entityNames: [entityName] });
  assert.equal((await call('read_graph', {})).entities.length, 0);
  checks.push('Entity deleted through upstream MCP tool');
  const evidence = {
    checkedAt: new Date().toISOString(),
    status: 'passed',
    server: packageData.name,
    version: packageData.version,
    modelApiUsed: false,
    storage: 'isolated temporary JSONL file; removed after verification',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    checks,
    storedDigest,
    limitations: ['Substring search; no embedding or semantic retrieval.', 'This verifies the MCP server. Web model-driven cross-session usage is verified separately.'],
  };
  const evidenceDirectory = join(projectRoot, 'docs/kleio-native-evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'memory-mcp.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: evidence.status, server: evidence.server, version: evidence.version, checks }, null, 2));
} finally {
  if (client) await client.close();
  // This exact directory was created by mkdtemp above and is never a user data path.
  assert.ok(resolve(workDirectory).startsWith(`${resolve(tmpdir())}\\kleio-native-memory-`) || resolve(workDirectory).startsWith(`${resolve(tmpdir())}/kleio-native-memory-`));
  await rm(workDirectory, { recursive: true, force: true });
}
