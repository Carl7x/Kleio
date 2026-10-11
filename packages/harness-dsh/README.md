# DSH ACP adapter

This ESM TypeScript package owns a DSH subprocess and speaks its automation-only ACP v1 stdio protocol. It has no runtime dependency. The product owns conversation IDs, tasks, approvals, memory and artifact storage; ACP is confined to this package and the server's engine wrapper.

## Kleio runtime setup

`src/setup.ts` provides `inspectDshSetup(env, { baseDir })` and `prepareDshLaunch(env, { baseDir })`. Both are asynchronous. Inspection checks files and required configuration locally; it never writes configuration, starts dsh, contacts the model, reads credential stores, or returns key values. A `ready` result means local prerequisites are present. It does **not** mean the model account is authenticated or the model has been tested. Missing setup can remain visible in the Web/desktop settings while task execution is unavailable.

```ts
import { inspectDshSetup, prepareDshLaunch } from './src/setup.ts';

const setup = await inspectDshSetup(process.env, { baseDir: productDirectory });
if (setup.status === 'ready') {
  const launch = await prepareDshLaunch(process.env, { baseDir: productDirectory });
  // launch.env is private and contains the selected model key. Never log it
  // or send it to a browser. Pass it directly to DshAcpClient / DshEngine.
  const client = new DshAcpClient(launch);
}
```

Install the pinned runtime using the command below or use an existing dsh installation. The helper automatically finds this repository's ignored `.runtime` installation when `DSH_COMMAND` is absent. For an external Windows installation, use the actual `node.exe` executable and a JSON array containing the installed `@deepseek-ai/dsh/lib/bin.js`; `.cmd` and `.bat` wrappers are rejected because the adapter launches without a shell.

| Environment variable | Purpose |
| --- | --- |
| `DSH_COMMAND` | Optional executable; an ignored local installation is discovered otherwise |
| `DSH_ARGS_JSON` | Optional JSON array containing the dsh CLI file and existing ACP/patch flags; node.exe requires the CLI file |
| `DSH_HOME` | Explicit dsh data directory; default `<baseDir>/.data/dsh` |
| `DSH_WORKSPACE` | Agent working directory; default `<baseDir>/.data/workspace` |
| `KLEIO_MODEL_BASE_URL` | Explicit OpenAI Chat Completions-compatible API root, generally ending in `/v1` |
| `KLEIO_MODEL_ID` | Exact model ID served by that endpoint |
| `KLEIO_MODEL_API_KEY_ENV` | Environment variable containing the model key; defaults to `KLEIO_MODEL_API_KEY` |
| `KLEIO_MODEL_CONTEXT_WINDOW` | Optional capacity declaration; default `32768` tokens |
| `KLEIO_MODEL_MAX_TOKENS` | Optional output limit; default `4096` tokens, no larger than the declared context window |

Set the selected credential in the host environment or ignored `.env`. The first release does not write secrets through the UI. The readiness check supports this explicit environment credential path, rather than claiming an uninspected dsh credential store is ready. The generated model route is non-reasoning Chat Completions; additional protocols, thinking controls, image capabilities and exact provider validation need their own configuration before corresponding capabilities are advertised. Capacity defaults are conservative deployment settings, not claims about a model's actual limits; match them to provider documentation.

Preparation creates the selected home/workspace and writes `DSH_HOME/kleio-model.patch.json`, which is valid YAML containing **credential variable names only**. The launch uses the official profile loader:

```text
dsh --profile kleio --from-default-profile acp --patch kleio-acp.patch.yml --patch <DSH_HOME>/kleio-model.patch.json
```

The command shown above applies only on first initialization. Once `profiles/kleio/package.json` exists, preparation omits `--from-default-profile acp`; the real CLI rejects reinitializing an existing profile. Both paths still apply the product and model patches on each launch.

The default independent home does not reuse `~/.dsh`. Explicit `DSH_HOME` reuses that directory's existing profile and home patches. Profile creation uses dsh's shipped ACP template and keeps the product's `kleio` profile separate from the user's `acp` profile. `profiles/kleio-acp.patch.yml` explicitly mounts the official `@deepseek-ai/dsh-tool-present`. The generated model layer applies last, selecting the configured `kleio-model` route for ACP and the shared default model. Additional existing `--patch` paths resolve from `baseDir`, before Kleio's final layers. Unsupported or conflicting launcher commands fail as missing setup.

The subprocess receives OS launch essentials, explicit proxy/CA settings and only the selected model credential. Other host account tokens are not inherited. Preparation sets `DSH_PERMISSION_MODE=read-only` and `DSH_TELEMETRY_DISABLED=1`; product approvals still control elevated tool calls. Model retry is set to zero to avoid implicit repeated requests in this initial integration. Changing these launch settings requires restarting the product service; no secret-bearing configuration is stored in Git or returned by the settings endpoint. If an explicit home is outside the ignored `.data` directory, keep that private data out of source control yourself.

This configuration follows the pinned upstream [profile launcher](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md#application-launch) and [pi-ai route fields](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/README.md#configure-provider-routes). It was validated against the installed `0.2.1-alpha.2` CLI, rather than relying on undocumented inline application boot.

## Public surface

`DshAcpClient` exports `start`, `createSession`, `listSessions`, `resumeSession`, `prompt`, `cancel`, `closeSession`, `onEvent`, and `close`. `DshAcpError` has a machine-readable `code`. The accompanying option, session, event and permission types are exported from `src/index.ts`.

```ts
import { DshAcpClient } from './src/index.ts';

const client = new DshAcpClient({
  command: process.execPath,
  args: ['/absolute/path/to/@deepseek-ai/dsh/lib/bin.js', '--profile', 'acp'],
  cwd: '/absolute/workspace',
  env: { /* explicit host essentials, isolated DSH_HOME and permitted model key */ },
  onPermission: async request => {
    // Persist a product approval and show the correlated tool call to the user.
    // Return an advertised allow_once / reject_once option ID, or null.
    return request.options.find(option => option.kind === 'reject_once')?.optionId ?? null;
  },
});

try {
  await client.start();
  const session = await client.createSession({ cwd: '/absolute/workspace' });
  const result = await client.prompt({
    sessionId: session.sessionId,
    text: 'Describe this workspace',
    onEvent: event => { /* publish through the product's own event contract */ },
  });
  // result.stopReason identifies the committed ACP prompt settlement.
} finally {
  await client.close();
}
```

The command is spawned without a shell. Supply an environment allowlist rather than inheriting unrelated account credentials. Use a private `DSH_HOME` per trust boundary. Runtime profiles and model routes belong to DSH configuration; passing a cwd is not user authorization or a tenant sandbox. This adapter does not launch an in-process Cordis tree.

`cancel()` sends a notification, not a confirmed stop. Await the in-flight `prompt()` to observe settlement. Only one prompt may run per session; different sessions are multiplexed. A timed-out prompt has an unknown execution outcome and poisons that session for new prompts until it is closed and reconciled. The adapter never resends a prompt automatically. It rejects unknown or permanent permission selections; absent approval handlers choose a advertised one-shot rejection, otherwise cancel. It bounds frames, request waits and shutdown and reaps the owned process; this is not a guarantee that every arbitrary tool's descendant or external side effect has stopped.

## Verification

Run the fixture tests with the root dependencies:

```text
node --import tsx --test packages/harness-dsh/test/*.test.ts
```

The fixture is a protocol peer, not a DSH mock presented as real integration. Its six cases cover routing, permissions, independent cancellation, AbortSignal settlement, malformed frames and uncertain timeout outcomes.

`test/setup.test.ts` has six cases covering private readiness output, fail-closed configuration, environment isolation, relative path resolution, custom credential references and existing-profile reuse. When the pinned ignored runtime is installed, its final case runs the **real** dsh `--dump-config` command twice and checks that the custom profile inherits ACP, uses the chosen model route and includes `present`. This check makes no model request; without that optional runtime, it is explicitly skipped.

For the opt-in real probe, install the pinned published runtime in the ignored directory, then execute the Node/TypeScript script:

```text
npm install --prefix packages/harness-dsh/.runtime --ignore-scripts --registry https://registry.npmjs.org @deepseek-ai/dsh@0.2.1-alpha.2
node --import tsx packages/harness-dsh/test/real-acp.ts
```

`real-acp.ts` starts the genuine published DSH process with an isolated home and a scripted localhost OpenAI-compatible model. It calls no paid model and uses a local placeholder credential. It proves initialize, new/list, prompt, one-shot permission with a real file tool, model-request cancellation, explicit official `tool-present` mounting and completed presentation, clean process shutdown and a fresh-process resume that sends the earlier answer back to the local model. Evidence is written to `docs/project-teardowns-2026-10-11/evidence/dsh/real-acp-probe.json`. The probe creates a fresh workspace per run and never changes the reference repositories.

## Product boundaries still to implement

- DSH permissions carry `toolCallId`; correlate earlier `tool_call` updates by session and ID to show name and arguments. A handler deciding from the permission payload alone cannot show the action reliably.
- The stock ACP composition omits `present`; mount the official `@deepseek-ai/dsh-tool-present` explicitly. Even with it mounted, ACP forwards generic tool updates rather than DSH's durable `deliverables/presented` event. The product must persist its own artifact record and immutable file copy after validated completion.
- ACP sends semantic updates derived from committed events. It does not provide DSH's full plans/todos/titles, native presentation descriptors, elicitation, transcript replay or native Queue/Steer controls. The current official SDK streams more durable events and permits enqueueing, but has no per-session cancel/close, Steer, or client approval methods; advanced product control needs a narrow plugin bridge, not merely an SDK switch. Image input capability depends on the configured exact model and attachment store; the local probe reports false.
- The probe verifies orderly shutdown and resume, not abrupt crash recovery, persistent approval continuation across reconnect, real-provider cancellation, external MCP servers, multi-tenant isolation, native computer use or model quality. Add these gates before making corresponding product guarantees.
