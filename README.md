# Restless

A local-first API and MCP client. No login, no account, no cloud sync. Runs as a desktop app (macOS, Windows, Linux) and as a Chrome/Edge extension, from one codebase.

Rest less, test more: send REST requests and test MCP servers without an account standing in the way.

Open source under the [MIT license](LICENSE).

## Install

Downloads are on the [Releases page](https://github.com/Shivendra-99/restless/releases/latest).

- macOS with Homebrew:

  ```
  brew install shivendra-99/tap/restless
  ```

  Or without Homebrew, run this in Terminal. It picks the build for your Mac (Apple silicon or Intel), checks it against the release checksums and puts Restless in Applications:

  ```
  curl -fsSL https://raw.githubusercontent.com/Shivendra-99/restless/main/scripts/install-mac.sh | bash
  ```

  Restless isn't notarized by Apple (that needs a paid account), so a `.dmg` downloaded with a browser is blocked the first time you open it: open System Settings → Privacy & Security and click Open Anyway. Homebrew and the script both avoid that: the cask removes the quarantine flag after installing, and downloads made with `curl` don't get one.
- Windows: `Restless-Setup-<version>.exe`. Signed builds come through SignPath Foundation's free signing for open source (see [code signing policy](CODE_SIGNING_POLICY.md)); until a release is signed, Windows shows "Windows protected your PC": click More info → Run anyway.
- Linux: the `.AppImage` (make it executable and run it).
- Chrome / Edge extension: unzip `restless-extension-<version>.zip`, open chrome://extensions, turn on Developer mode, Load unpacked.

## What works today

API testing
- Collections with folders, like Postman: create, rename, move requests between them (the "Saved in" picker above the request name), duplicate, delete, export
- Requests with params, headers, and JSON / text / urlencoded / multipart bodies
- File uploads: files as multipart form fields, or one file as the whole body. On desktop only the file's path is kept and it is read again on every send
- Bulk edit for params, headers and form fields: edit the list as `key: value` lines, or paste JSON, XML, a query string or a whole URL (pasting those into a key cell fills the table too)
- Auth: API key, Bearer, Basic, Digest, JWT bearer (signed on every send), OAuth 1.0, OAuth 2.0 (client credentials, password, authorization code with PKCE on desktop), Hawk and AWS Signature v4
- Global variables, usable anywhere as `{{name}}`, plus environments (an active environment's value wins over a global with the same name) and dynamic values (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`)
- Save from response, no scripts: click any value in a JSON response (or Save on a response header), name it, done. Tick "Update it every time this request is sent" and the variable refreshes on every 2xx response, so a login request keeps `{{access_token}}` current for every other request. Rules are listed and editable in the request's "Save to variables" tab
- Every request shows the variables it uses with their current values; a missing one is red and opens the Variables window ready to fill
- 🔒 variables (the default for values saved from responses, since they are usually tokens) are encrypted on the machine (Keychain / DPAPI / libsecret via Electron `safeStorage`) and never written to the workspace folder
- Import from cURL (paste into the URL bar or the Import dialog), Postman collections v2.0/v2.1 (folders, inherited auth, variables, and test scripts that save values such as `pm.environment.set("token", pm.response.json().token)` become save-from-response rules), Postman environments and Postman globals
- Export a collection as Postman v2.1 JSON; save-from-response rules become `pm.globals.set(...)` test scripts, so the export works in Postman, Bruno, Insomnia and others
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

Network capture (time travel), desktop app
- Capture → type your app's address (e.g. `localhost:3000`) → Open and record. The site opens in the Restless browser, a window of the desktop app, and every API call (fetch/XHR) and page load it makes is recorded with request and response headers (including the real Cookie and Set-Cookie), bodies, status and timing. No extension, proxy or certificate needed
- Recording starts when the window opens, so nothing is missed: the timeline goes back to the first request. Step through with ⏮ ◀ ▶ ⏭, the ← → keys, or by dragging along the track; page loads are marked on it. "Following live" keeps the newest call selected, "Jump to live" brings you back after scrubbing
- The browser toolbar has back/forward/reload, an address bar, a Recording/Paused switch with the call count, and "Show in Restless" to jump to the timeline. New capture starts an empty one without closing the browser
- Popups the site opens (sign-in windows) are recorded too; DevTools open with F12; localhost https with a self-signed certificate is accepted
- It has its own cookies, separate from your normal browser: sign in to your site once there and it stays signed in. "Sign out of all sites in the Restless browser" in the ⋯ menu clears it. Sites can't use camera, microphone, location or notifications in it
- Any captured call → "Save as request" (into a collection, ready to edit and send again) or "Copy cURL". Import and export HAR files
- Captures stay in the app's data folder (not the workspace folder, since they hold real cookies and tokens); the newest 60 are kept

Extension specifics
- Asks for access per host the first time you send to it (no blanket `<all_urls>` at install)
- Sends browser-forbidden headers such as `Cookie`, `Origin`, `Referer`, `User-Agent` using a short-lived `declarativeNetRequest` rule scoped to the extension and the target host; anything still impossible is listed under the response
- Requests don't carry your browser's own cookies (`credentials: 'omit'`); add a `Cookie` header when you want one
- stdio MCP servers need the desktop app (browsers can't start processes); the option is disabled with an explanation

## Layout

```
packages/core       data model, variables, cURL + Postman import, MCP session wrapper, lint, Bridge interface
packages/ui         the React app, shared by both shells; talks only to a Bridge
apps/desktop        Electron: main process (HTTP engine, MCP manager, file storage, Restless browser + capture), sandboxed preloads, renderer
apps/extension      MV3 extension: fetch engine + DNR header rules, MCP over HTTP, chrome.storage
scripts             demo HTTP API, demo web app for capture, demo MCP server (stdio / HTTP / --pollute), icon generator
```

The UI never calls `fetch`, spawns processes or touches files. Each shell implements `Bridge` (`packages/core/src/bridge.ts`), so a future CLI or web build only needs another Bridge.

## Workspace format (desktop)

A workspace is a plain folder, safe to commit to git:

```
restless.yaml                                              name, active environment
collections/<collection>--<id8>/collection.yaml            collection name and folders
collections/<collection>--<id8>/<folder>/<name>--<id8>.yaml   one file per request
environments/<name>--<id8>.yaml                            🔒 values are blank here
globals.yaml                                               🔒 values are blank here
mcp-servers.yaml
```

Workspaces from 0.1 (a `requests/` folder) are moved into a collection called "My collection" the first time they are opened.

History and secret values live in the app's own data folder, per machine. Default workspace: `~/Documents/Restless`; switch with "Open folder".

## Develop

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm dev:desktop          # build + launch the Electron app
pnpm build:extension      # then chrome://extensions → Developer mode → Load unpacked → apps/extension/dist
                          # (Edge: edge://extensions, same steps)

pnpm api:demo             # demo API on http://localhost:4545  (/users, POST /auth/token, /me, /echo, /upload, /digest, POST /oauth/token, /slow, /redirect)
                          # token flow: POST /auth/token with {"username":"asha","password":"secret"},
                          # click data.access_token in the response, then call /me with Bearer {{access_token}}
pnpm capture:demo         # a small web app on http://localhost:5555 that calls its own API; open it under Capture
pnpm mcp:demo             # demo MCP server on http://localhost:3333/mcp
node scripts/test-mcp-server.mjs            # same server over stdio (use as the command in the app)
node scripts/test-mcp-server.mjs --pollute  # a buggy server that logs to stdout

pnpm typecheck
pnpm verify               # unit tests + end-to-end checks of the desktop engine, MCP, storage and the capture store
```

## Build installers

- On a Mac: `pnpm dist:mac` → `apps/desktop/release/Restless-<version>-arm64.dmg` and `-x64.dmg`
- On Windows: `pnpm dist:win` → `apps/desktop/release/Restless-Setup-<version>.exe`
- On GitHub: publish a release (or push a `v*` tag) and the "Build and release" workflow attaches the `.dmg`s, the Windows installer, the AppImage, the extension zip and `SHA256SUMS.txt` to it. Run the workflow by hand to only build.

Signing, all free: Windows through SignPath Foundation, the Microsoft Store package signed by the Store, macOS ad-hoc signed. [docs/RELEASING.md](docs/RELEASING.md) has the one-time setup and how to cut a release.

## Security notes

- Renderer: `contextIsolation`, `sandbox`, no Node integration, a CSP with `connect-src 'none'`, and an allow-listed IPC surface
- Workspace folder names from imports are sanitised, so a collection can't write outside the workspace
- Redirects drop `Authorization` and `Cookie` when they leave the original host
- The Restless browser runs sites sandboxed with no preload and no Node access, can't navigate to `file://`, and only its toolbar can send it commands
- Pre-request/test scripts are intentionally not implemented yet; when they are, they must run in a sandbox (e.g. QuickJS), because importing someone's collection means running their code

## Roadmap

1. MCP client features: answer `sampling` (mock, or your own API key) and `elicitation` requests from the UI; roots
2. MCP OAuth flow with a step-by-step view
3. Saved MCP test cases with assertions + a CLI runner for CI (`restless test`)
4. Schema-based fuzzing of tool inputs
5. Capture: Requestly-style rules in the Restless browser (modify headers, redirect, mock, delay); replay a whole capture in order; diff two captures
6. Native messaging bridge so the extension can use the desktop app for stdio servers
7. Multipart form-data, GraphQL mode, WebSocket / SSE requests
8. Newer MCP protocol revisions as the official SDK adds them (this build negotiates up to 2025-11-25)
