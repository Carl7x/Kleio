# Kleio

A local, self-hosted personal assistant. Kleio owns conversations, memory, background work and notifications. Execution engines are replaceable; the first adapter uses DeepSeek Harness.

## Current stage

The independent runtime is under development. An Expo / React Native client shares its screens across Web and iOS, backed by Kleio's authenticated API. The command-line client remains available.

- Persistent multi-turn conversations with streaming responses and queued follow-ups.
- Automatic memory after a quiet interval, with evidence, corrections, forgetting and basic people/relationships.
- Full-text retrieval across memory and conversation history; semantic retrieval is not implemented.
- Tavily web search with source cards, plus read-only public web/RSS documents.
- One-shot reminders and interval work, with durable research results, main-assistant review and a local inbox.
- Explicit cancellation and unknown outcomes; unfinished research is not silently repeated on restart.

Generic shell execution, arbitrary MCP servers, external messaging and account writes are not exposed by this runtime.

## Local setup

Node.js 24.19 or later in the Node 24 series, pnpm 11.25.0, and a reachable compatible model endpoint.

```sh
pnpm install --frozen-lockfile
pnpm setup:dsh
pnpm web
```

Configuration is outside the repository at `~/.config/kleio/config.json` (or `$KLEIO_CONFIG`). First startup creates a private local API token. Supply model credentials through `KLEIO_MODEL_API_KEY` or the private configuration field `model.apiKey`. Never add credentials to tracked files. Default model endpoint is DeepSeek.

Model execution now requires explicit `model.contextWindow` and `model.maxTokens`, or `KLEIO_MODEL_CONTEXT_WINDOW` and `KLEIO_MODEL_MAX_TOKENS`. Use a capacity supported by the configured endpoint, including a conservative lower bound for external auto routing. Missing capacity leaves stored-data APIs available but rejects model execution; the runtime does not guess a model window. The isolated DeepSeek Flash acceptance setup uses a 131072-token working window and an 8192-token output allowance, below its [documented limits](https://api-docs.deepseek.com/quick_start/pricing/). This is a test configuration, not a default for other providers.

`pnpm web` builds the Expo Web client, starts the local runtime if needed, and opens an authenticated browser session. It can reconnect to an already-running runtime. The interface supports conversations, background work and results, and memory inspection/correction. Provider keys and the administration token stay on the server.

The service binds to loopback by default. Closing a client leaves the service running; `pnpm stop` stops it. A login service is not installed yet. For terminal use, run `pnpm start` and then `pnpm chat` in another terminal.

### Phone access

Run `pnpm mobile` to enable authenticated local-network access and open the Web client. The original client uses its workspace access gate when an authenticated session is unavailable.

The native iOS client uses the same screens. `pnpm mobile:dev` starts the Expo development server for SDK 57. Its server address comes from the development host or deployment configuration, with no separate connection page. Existing device credentials are reused; new devices use the original workspace access-key gate. The adapter stores a limited device credential in the iOS Keychain. Native installation depends on the Expo SDK version and Apple's development/signing setup. `pnpm mobile:build:ios` exports a JavaScript bundle; it does not produce a signed application. Native background execution and OS push notifications are outside this release.

### Search

Search uses Tavily basic search. Without a key it uses Tavily's limited keyless access. For account access, set `KLEIO_TAVILY_API_KEY` (or `TAVILY_API_KEY`) on the server, or set `search.apiKey` in private configuration. Limits and provider failures are reported without switching to another provider. Search credentials are never bundled in the client.

```sh
pnpm kleio status
pnpm kleio chat <conversation-id>
pnpm kleio research "<research request>"
pnpm kleio remind "<ISO timestamp with timezone>" "<reminder text>"
pnpm kleio work
pnpm kleio inbox
pnpm kleio memory
pnpm kleio people
```

Chat supports `/new`, `/work`, `/inbox`, `/memory`, `/people` and `/quit`. Background research needs an explicit request. Notifications are stored in the local inbox; OS/mobile push is not implemented.

## Data and boundaries

Default data lives in `~/.local/share/kleio/` (or `$KLEIO_DATA_DIR`). One SQLite database owns product state. Markdown memory files are readable projections; conflicting external edits are preserved and reported. DSH uses fresh execution directories and product-controlled tools, with credentials supplied through its child environment. This is tool restriction, not an OS sandbox for general execution.

Standing files and playbooks also live in that data directory (`standing/*.md`, `skills/<id>/SKILL.md`, `skills-index.json`). Standing is captured when an execution starts. Skills are discovered as metadata; bodies and related text files enter model context only through explicit resource reads. A new valid skill directory does not require a selector change or an index allowlist entry. Product context remains owned by Kleio. This is still one local user. `standing/IDENTITY.md` supplies the display name and tone. `POST /api/agent/identity` writes those same fields; avatar and chat-update visibility stay presentation settings. A direct file edit wins on the next turn. Startup does not overwrite an existing standing or skill file. Empty or invalid identity fields use the product default, Kleio / warm.

Older Harness-hosted entry points remain under `native:*` for compatibility. The new runtime does not automatically import old databases or private archives. Select and review a migration before switching existing data.

See [architecture](docs/architecture.md), [memory](docs/memory-architecture.md), and [runtime/API](docs/runtime.md).

## Engineering workflow

Core feature work follows [AGENTS.md](AGENTS.md): inspect source, submit a decision-complete plan, obtain explicit user confirmation, then dispatch small implementation tasks to Codex with GPT-6.1 Sol, use a separate read-only reviewer, and independently verify architectural compliance as well as behavior. The scoped loader now supports generic skill discovery, progressive resources, structured context, request budgets and policy invalidation. The three pre-existing history/review failures are fixed. Current acceptance includes 285 targeted regression tests, 33 supplemental frontend tests (partly overlapping), runtime type checking, a Web build, real HTTP/database/model research and four real-browser scenarios (synthetic data). Active conversations receive background deliveries without reload, recover after reconnect or thread switching, and preserve drafts and foreground streaming. Mobile-wide type checking still has one existing Computer error. Full Muse behavior adaptation, automatic compaction/recovery, multi-user migration, native iOS validation and ECS deployment remain separate work. See the [current context-loading plan](docs/engineering/context-loading-plan-2026-10-17.md).

## Development

```sh
pnpm typecheck
```

Keep credentials, runtime data, personal examples, internal research notes and validation transcripts outside the repository. Public documentation describes supported behavior and limits.

## License

Apache-2.0. The Expo client incorporates MIT-licensed OpenMuse presentation code; its attribution and license are preserved in [third_party/openmuse](third_party/openmuse/NOTICE). Dependencies retain their respective licenses.
