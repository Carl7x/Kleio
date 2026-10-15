# Architecture

Kleio owns the product runtime independently of its clients and execution engine.

```text
Expo client (Web / iOS) / CLI
        |
authenticated local HTTP API + durable event stream
        |
Kleio runtime: conversations, memory, work, review, inbox
        |
Engine.execute(input, context)
        |
DSH adapter + product tool bridge
```

## Ownership

- `packages/runtime`: product contracts, durable messages/executions/events, execution admission and lifecycle.
- `packages/personal-memory/runtime.ts`: memory, relationships, revisions, recall, extraction watermarks and projections.
- `packages/personal-tasks/runtime.ts`: explicit work requests, schedules, result handoffs, reviews and notifications.
- `packages/engines/dsh.ts`: replaceable engine adapter; one execution owns one model/tool loop.
- `packages/harness-dsh/src`: pinned ACP transport, private setup and controlled MCP bridge.
- `packages/connectors`: scoped product capabilities.
- `apps/runtime`: authenticated service assembly.
- `apps/cli`: initial product API client.
- `apps/mobile`: shared Expo / React Native Web presentation, API transport and device connection. Durable state remains owned by the runtime.

Product tables share one SQLite database and one process lease. Engine sessions are opaque execution handles, not conversation IDs. The admission queue does not implement a second model/tool loop.

## Execution

The current path permits memory retrieval, explicitly authorized memory correction/forgetting, Tavily web search, public document reads and work creation. Research receives read-only tools; maintenance and review have no tools. General shell, filesystem, plugin installation and native subagent tools are disabled in the pinned composition, with a product tool allowlist as an additional check.

Research is delegated as a scoped engine execution. Its result is committed before a main-assistant review execution; review is committed before inbox notification. This version does not expose native subagent controls.

Requests and work occurrences have durable identities. Conversation submission is retry-safe within a conversation. Transport interruption is not proof that an external effect succeeded or failed. Running conversation work becomes unknown after an unclean restart; running research pauses for inspection. Safe review can resume from its saved result.

## Scope

Single user, local host, with optional paired devices on the local network. A second production engine, OS sandbox for general execution, automatic migration, service installation, semantic retrieval and native app distribution remain further work. Clients use product contracts and never own memory or scheduling state. Client capability support is explicit: unavailable mail, calendar, computer, file and goal features are omitted.
