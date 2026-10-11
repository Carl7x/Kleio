# Native Personal Agent views

This browser plugin adds **任务、记忆、成果、资料** to the existing DSH sidebar. It uses the official `main` and `sidebar.panellist` slots, shared React and UI primitives, native theme variables, session navigation, and the native file resource viewer. It does not replace the sidebar, conversation, composer, permissions, or settings.

## Build and load

Run `node packages/personal-agent-ui/build.mjs` from the repository. The local `esbuild` dev dependency or the repository's existing `tsx` build dependency produces `dist/client.js` in DSH's closure-factory module format. Add the absolute `packages/personal-agent-ui/host.mjs` path to the official Host Loader overlay. The nearest `package.json` supplies `exports["./client"]` and `dsh.client.inject`; no upstream module changes or separate Web server are required.

The API must be mounted at the same authenticated origin under `/api/kleio`. Success is `{data: value}`; non-2xx failure is `{error:{code,message}}`. The browser sends same-origin cookies, never extracts or stores a URL token, and never automatically retries a mutation. A failed transport after a write is shown as an unknown outcome that requires readback.

## Surfaces and behavior

- Memory: keyword search, active/file/pending/removed views, editable standing notes and SOUL, source dialogue, immutable history, expected-version correction, recoverable deletion and explicit version restore. Candidates display their source quote; conflicting acceptance shows both facts before confirmation.
- Tasks: persisted queue/running/waiting/completed/failed/cancelled states, creation with a stable request ID, five-second read refresh while visible, native execution dialogue, stop, and explicit retry. Possible external effects require acknowledgement before retry.
- Results: indexed delivered files, source dialogue, and official file preview. Navigation waits for the native session to mount through a React effect, not a guessed delay. A failed handoff is visible outside the navigated panel.
- Profile: editable assistant/user fields and opt-in candidate capture setting, guarded by the persisted profile version.

All visible content comes from the API. Empty/loading/error states do not imply success, and removed memory is not described as erased history. The current UI is Chinese; sidebar labels also use the native locale registry. No secrets or private profile values are compiled into the bundle.

## Design and checks

This extends the existing DSH visual system, using its typography, controls, theme colours and page geometry. Source references: upstream `ui-schedule` for sidebar/main registration, `ui-primitives` for controls and modal focus behavior, `ui-reference`/`ui-chat` for `fileAddressFor`, and `ui-sidebar-right` for session-bound resource opening.

Focused checks: `node --test packages/personal-agent-ui/api.test.mjs`; `node node_modules/typescript/bin/tsc -p packages/personal-agent-ui/tsconfig.json`; `node packages/personal-agent-ui/build.mjs`. Type checking uses installed DSH declarations and the repository's React type declarations; the shipped client uses the Host's shared React. Actual Web loading, interactive flows and desktop/narrow-screen screenshots are verified by the main task against the running Host.
