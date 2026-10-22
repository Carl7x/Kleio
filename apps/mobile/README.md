# Kleio client

Expo 57, React Native 0.86 and React Native Web share the application screens.
The Expo client lives in `kleio/`. MIT attribution for the incorporated upstream
presentation code is in `../../third_party/upstream-notice`. Local adapters connect
those presentation contracts to Kleio.

From the repository root:

```sh
pnpm web
pnpm mobile
pnpm mobile:dev
```

`web` builds and opens an authenticated Web session. `mobile` also enables
local-network connections. `mobile:dev` serves the native Expo bundle.
Use Expo Go for SDK 57 or a compatible development build. The server address
comes from the Expo development host or deployment configuration
(`EXPO_PUBLIC_API_URL`); it is not an end-user form. Existing device credentials
are reused. A new public or remote client uses the Kleio access-token gate
(`KLEIO_TOKEN`); web exchanges it for an HttpOnly cookie session, and native
exchanges it for a limited device credential automatically.

`pnpm mobile:build:ios` exports JavaScript/Hermes assets. It is not a signed iOS
application. `pnpm mobile:ios` requires Xcode and the relevant signing setup.

Chat, Activity, Ideas, Goals and Apps keep their original layout. Conversations,
search sources, background research/results, notifications and memory edits
use Kleio data. Unsupported integrations retain their original locations with
disabled actions. PDF native rendering requires a development build and remains
disabled along with mail, calendar, computer control, goals and tracking.
OS push and background phone execution are not implemented.

Provider keys remain on the runtime. Native device tokens use SecureStore;
Web uses an HttpOnly cookie. Do not put secrets in `EXPO_PUBLIC_*` variables.
