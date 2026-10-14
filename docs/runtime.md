# Local runtime

## Configuration

`KLEIO_CONFIG` selects an owner-only JSON file outside the checkout. Defaults use XDG configuration/data roots, falling back to `~/.config` and `~/.local/share`.

Settings: `port`, `token`, `dataDirectory`, `model.baseURL`, `model.id`, `model.apiKey`, `memoryIdleMs`, optional `nodeExecutable` for a specific Node runtime. Environment overrides: `KLEIO_PORT`, `KLEIO_TOKEN`, `KLEIO_DATA_DIR`, `KLEIO_MODEL_BASE_URL`, `KLEIO_MODEL_ID`, `KLEIO_MODEL_API_KEY`, `KLEIO_MEMORY_IDLE_MS`, `KLEIO_NODE_BINARY`.

Credentials and bearer tokens are private. Keep them out of URLs, command-line arguments, logs and committed examples. The CLI reads the same private configuration as the service.

Default listener: `127.0.0.1:4317`. `/health` only reports liveness. Every `/api/*` request requires `Authorization: Bearer <local-token>`. Cross-origin browser requests are rejected. Remote deployment is outside this entry point's scope.

## API

| Method/path | Purpose |
| --- | --- |
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
