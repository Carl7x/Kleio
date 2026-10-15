# Local runtime

## Configuration

`KLEIO_CONFIG` selects an owner-only JSON file outside the checkout. Defaults use XDG configuration/data roots, falling back to `~/.config` and `~/.local/share`.

Settings: `port`, `listenHost` (loopback by default), `token`, `dataDirectory`, `model.baseURL`, `model.id`, `model.apiKey`, `memoryIdleMs`, optional `search.apiKey` and `nodeExecutable`. Environment overrides: `KLEIO_PORT`, `KLEIO_LISTEN_HOST`, `KLEIO_TOKEN`, `KLEIO_DATA_DIR`, `KLEIO_MODEL_BASE_URL`, `KLEIO_MODEL_ID`, `KLEIO_MODEL_API_KEY`, `KLEIO_MEMORY_IDLE_MS`, `KLEIO_NODE_BINARY`, `KLEIO_TAVILY_API_KEY` (or `TAVILY_API_KEY`).

Credentials and bearer tokens are private. Keep them out of URLs, command-line arguments, logs and committed examples. The CLI reads the same private configuration as the service.

Default listener: `127.0.0.1:4317`. `/health` only reports liveness. Private APIs require an administration token, authenticated browser cookie or paired-device bearer. Cross-origin browser requests are rejected. `pnpm mobile` opts into `0.0.0.0` for local-network devices. Public internet deployment is outside this entry point's scope.

## Web client

Run `pnpm web` to build the Expo React Native Web client and open it from the same origin as the runtime. The launcher starts the runtime if it is not running. `--no-open` leaves the browser closed; `--skip-build` reuses an existing build. The runtime serves `apps/mobile/dist/web` after the launcher exits.

The launcher exchanges its bearer credential for a single-use ticket valid for 60 seconds. The browser receives the ticket in a URL fragment, removes it from browser history, and exchanges it for an HttpOnly, SameSite=Strict session cookie valid for seven days. A private `web-launch.json` file holds the temporary link for alternate launchers. The API token and model credentials are never placed in browser storage or bundles. Sessions survive runtime restarts and are invalidated when the API token changes. Reopen with `pnpm web` after a session or launch ticket expires.

Only built client assets are served publicly. Private API reads require authentication, and cookie-authenticated writes require JSON and the local origin. The client displays saved work/review results and observes persisted execution events; it does not own agent execution or scheduling.

## Phone connection

`pnpm mobile` enables the local-network listener, restarting an idle loopback service when necessary. The client keeps the original workspace access-key gate and obtains its endpoint from development/deployment configuration. Its adapter reuses existing sessions or exchanges the access key through the existing session/device APIs; there is no separate address or pairing-code form. The browser receives a session cookie; the native client receives a separate revocable 90-day device token stored with Expo SecureStore. Only token hashes are stored by the runtime. Native device tokens cannot create new pairings, administer other devices, create browser launch tickets or stop the runtime. Device revocation remains available through the authenticated API.

Native client development: `pnpm mobile:dev`; native JavaScript export: `pnpm mobile:build:ios`; local native build: `pnpm mobile:ios` (requires Xcode and applicable signing). These commands do not publish to an app store. Pairing and provider credentials are separate. All background work remains on the host; an iPhone cannot wake a sleeping or powered-off host.

## Search

`web_search` uses Tavily basic search with at most three results. Missing server-side search credentials select documented keyless access, with provider-imposed limits. A configured key selects account access without automatic fallback. Source snippets are bounded, public citations are filtered and the tool has a deadline. `tool.started`, `tool.completed` and `tool.failed` carry a `callId`; search completions include a bounded source-card result. Work creation/status completions include local task data for the original client cards. Other tool results and credentials are not exposed through this projection.

## API

| Method/path | Purpose |
| --- | --- |
| POST `/api/session-tickets` | Bearer-authenticated creation of a one-time browser launch ticket |
| POST `/api/session` | Exchange `{ticket}` for a local browser session |
| DELETE `/api/session` | Clear this browser session |
| POST `/api/device-pairing` | Create a single-use device pairing code from an authenticated browser/admin client |
| POST `/api/devices/pair` | Exchange `{code,client,name}` for a browser or native session |
| GET/DELETE `/api/devices[/:id]` | List/revoke native devices from the browser/admin client |
| DELETE `/api/device-session` | Revoke the current native device |
| GET `/api/status` | Capabilities/configuration and memory health; no secrets |
| GET/POST `/api/conversations` | List/create conversations |
| GET/POST `/api/conversations/:id/messages` | History or submit `{text,requestId}` |
| GET `/api/executions/:id` | Durable outcome |
| GET `/api/executions/:id/stream` | SSE, reconnect using Last-Event-ID |
| POST `/api/executions/:id/cancel` | Request cancellation |
| GET `/api/events?after=...` | Durable event cursor |
| GET `/api/memory?q=...` | Current memory/search |
| PATCH `/api/memory/:id` | `{text,expectedVersion}` correction |
| DELETE `/api/memory/:id` | `{expectedVersion}` forgetting |
| GET `/api/memory/:id/history` | Explicit version/source inspection |
| GET `/api/people` | Basic people and relationships |
| GET/POST `/api/work` | List/create explicitly authorized work |
| GET `/api/work/:id` | Task, runs, research and review |
| POST `/api/work/:id/cancel` | Cancel, optionally with expectedVersion |
| GET `/api/notifications` | Local inbox |
| POST `/api/notifications/:id/read` | Idempotent read receipt |
| PATCH `/api/settings` | `memoryEnabled`, IANA `timezone` |
| POST `/api/shutdown` | Stop service |

Work creation requires `requestId`, `title`, `prompt`, `kind` (`research` or `reminder`). Optional `at` is ISO time with explicit offset; `intervalMs` is at least one minute. `conversationId` optionally associates the result with a conversation. An authenticated API work command is explicit user authorization.

The first interval execution defaults to one interval after creation. Missed occurrences coalesce to the latest due occurrence. Reminders need no model. Research and review have separate scopes and durable records.

## Recovery and privacy

Graceful shutdown stops admission, cancels active execution, drains callbacks, closes the database and releases ownership. Engine output remains private product data. Clients consume product events rather than DSH storage.

Old data is not migrated automatically. Do not copy live databases while writers are active. Keep internal research, private fixtures, provider evaluation output and runtime artifacts outside the repository.
