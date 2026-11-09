# Restless

A local-first API and MCP client. No login, no account, no cloud sync. Runs as a desktop app (macOS, Windows, Linux) and as a Chrome/Edge extension, from one codebase.

Rest less, test more: send REST requests and test MCP servers without an account standing in the way.

## What works today

API testing
- Requests with params, headers, JSON / text / urlencoded bodies, Bearer / Basic / API-key auth
- Environments with `{{variables}}` and dynamic values (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`)
- Secret variables: encrypted on the machine (Keychain / DPAPI / libsecret via Electron `safeStorage`), never written to the workspace folder
- Import from cURL (paste into the URL bar or the Import dialog), Postman collections v2.0/v2.1 (folders, inherited auth, variables) and Postman environments
- Response viewer with pretty JSON, headers, the exact request that was sent, and copy-as-cURL
- Timing trace: DNS, connect, TLS, waiting, download (desktop)
- History, filterable sidebar, auto-save

MCP testing
- Transports: stdio (desktop), Streamable HTTP, legacy SSE, with custom env vars / headers
- Server info, negotiated protocol version, capabilities, ping
- Tools: a form generated from each tool's `inputSchema` (or raw JSON), run with Ctrl/Cmd + Enter, rendered results (text, JSON, images, audio, `structuredContent`), `isError` shown clearly
- Resources (including templates) and prompts
- Traffic: every JSON-RPC message in and out plus server stderr, searchable, expandable
- Lint: duplicate names, missing or weak descriptions, undocumented params, required params missing from the schema, and a rough token cost of the tool list per tool
- Detects the classic stdio bug (server logging to stdout) and says how to fix it
- On macOS/Linux the app loads your login shell's PATH, so `npx`, `uvx` and nvm-installed `node` work from the Dock

Extension specifics
- Asks for access per host the first time you send to it (no blanket `<all_urls>` at install)
- Sends browser-forbidden headers such as `Cookie`, `Origin`, `Referer`, `User-Agent` using a short-lived `declarativeNetRequest` rule scoped to the extension and the target host; anything still impossible is listed under the response
- Requests don't carry your browser's own cookies (`credentials: 'omit'`); add a `Cookie` header when you want one
- stdio MCP servers need the desktop app (browsers can't start processes); the option is disabled with an explanation

## Layout

```
packages/core       data model, variables, cURL + Postman import, MCP session wrapper, lint, Bridge interface
packages/ui         the React app, shared by both shells; talks only to a Bridge
apps/desktop        Electron: main process (HTTP engine, MCP manager, file storage), sandboxed preload, renderer
apps/extension      MV3 extension: fetch engine + DNR header rules, MCP over HTTP, chrome.storage
scripts             demo HTTP API, demo MCP server (stdio / HTTP / --pollute), icon generator
```

The UI never calls `fetch`, spawns processes or touches files. Each shell implements `Bridge` (`packages/core/src/bridge.ts`), so a future CLI or web build only needs another Bridge.

## Workspace format (desktop)

A workspace is a plain folder, safe to commit to git:

```
restless.yaml                                  name, active environment
requests/<folder>/<name>--<id8>.yaml        one file per request
environments/<name>--<id8>.yaml             secret values are blank here
mcp-servers.yaml
```

History and secret values live in the app's own data folder, per machine. Default workspace: `~/Documents/Restless`; switch with "Open folder".

## Develop

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm dev:desktop          # build + launch the Electron app
pnpm build:extension      # then chrome://extensions → Developer mode → Load unpacked → apps/extension/dist
                          # (Edge: edge://extensions, same steps)

pnpm api:demo             # demo API on http://localhost:4545  (/users, /echo, /slow, /redirect)
pnpm mcp:demo             # demo MCP server on http://localhost:3333/mcp
node scripts/test-mcp-server.mjs            # same server over stdio (use as the command in the app)
node scripts/test-mcp-server.mjs --pollute  # a buggy server that logs to stdout

pnpm typecheck
pnpm verify               # unit tests + end-to-end checks of the desktop engine, MCP and storage
```

## Build installers

- On a Mac: `pnpm dist:mac` → `apps/desktop/release/Restless-0.1.0-arm64.dmg` (and x64)
- On Windows: `pnpm dist:win` → `apps/desktop/release/Restless Setup 0.1.0.exe`
- Anywhere: push to GitHub and run the "Build installers" workflow (or push a `v*` tag). It builds the `.dmg`, the `.exe` and the extension zip as downloadable artifacts.

Builds are unsigned for now. Unsigned Mac apps need right-click → Open the first time; Windows shows a SmartScreen warning. Signing needs an Apple Developer account (and notarization) and a Windows code-signing certificate; add them as CI secrets when ready.

## Security notes

- Renderer: `contextIsolation`, `sandbox`, no Node integration, a CSP with `connect-src 'none'`, and an allow-listed IPC surface
- Workspace folder names from imports are sanitised, so a collection can't write outside the workspace
- Redirects drop `Authorization` and `Cookie` when they leave the original host
- Pre-request/test scripts are intentionally not implemented yet; when they are, they must run in a sandbox (e.g. QuickJS), because importing someone's collection means running their code

## Roadmap

1. MCP client features: answer `sampling` (mock, or your own API key) and `elicitation` requests from the UI; roots
2. MCP OAuth flow with a step-by-step view
3. Saved MCP test cases with assertions + a CLI runner for CI (`restless test`)
4. Schema-based fuzzing of tool inputs
5. Extension: capture requests from the current tab into a collection; Requestly-style rules (modify headers, redirect, mock, delay)
6. Native messaging bridge so the extension can use the desktop app for stdio servers
7. Multipart form-data, GraphQL mode, WebSocket / SSE requests
8. Newer MCP protocol revisions as the official SDK adds them (this build negotiates up to 2025-11-25)
