# Kleio

A local, self-hosted personal assistant. Kleio owns conversations, memory, background work and notifications. Execution engines are replaceable; the first adapter uses DeepSeek Harness.

## Current stage

The independent headless runtime is under development. It provides an authenticated local API and a command-line client. Product navigation and desktop/mobile clients are not finalized.

- Persistent multi-turn conversations with streaming responses and queued follow-ups.
- Automatic memory after a quiet interval, with evidence, corrections, forgetting and basic people/relationships.
- Full-text retrieval across memory and conversation history; semantic retrieval is not implemented.
- Read-only public web/RSS documents.
- One-shot reminders and interval work, with durable research results, main-assistant review and a local inbox.
- Explicit cancellation and unknown outcomes; unfinished research is not silently repeated on restart.

Generic shell execution, arbitrary MCP servers, external messaging and account writes are not exposed by this runtime.

## Local setup

Node.js 24.19 or later in the Node 24 series, pnpm 11.25.0, and a reachable compatible model endpoint.

```sh
pnpm install --frozen-lockfile
pnpm setup:dsh
pnpm start
# In another terminal:
pnpm chat
```

Configuration is outside the repository at `~/.config/kleio/config.json` (or `$KLEIO_CONFIG`). First startup creates a private local API token. Supply model credentials through `KLEIO_MODEL_API_KEY` or the private configuration field `model.apiKey`. Never add credentials to tracked files. Default model endpoint is DeepSeek.

The service binds to loopback only. Closing the CLI leaves the service running; `pnpm stop` stops it. A login service is not installed yet.

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

Older Harness-hosted entry points remain under `native:*` for compatibility. The new runtime does not automatically import old databases or private archives. Select and review a migration before switching existing data.

See [architecture](docs/architecture.md), [memory](docs/memory-architecture.md), and [runtime/API](docs/runtime.md).

## Development

```sh
pnpm typecheck
```

Keep credentials, runtime data, personal examples, internal research notes and validation transcripts outside the repository. Public documentation describes supported behavior and limits.

## License

Apache-2.0. Dependencies retain their respective licenses.
