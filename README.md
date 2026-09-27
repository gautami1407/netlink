# Dexile — Remote Desktop Control & File Transfer

A self-hosted, LAN-oriented remote desktop control server: run `server.js` on
the machine you want to control, open `client.html` (served automatically by
the server) from a phone or another computer's browser, and control the
mouse, keyboard, and screen, plus transfer files both directions.

## What's real here

Every value shown in the UI comes from the server at runtime — hostname, IP,
memory, capability availability, transfer progress, latency, activity log.
Nothing is simulated. If a capability genuinely isn't available (no display,
missing OS dependency), the UI says **Unavailable** with the real reason
instead of pretending it works.

## Requirements

- Node.js 18+
- A real desktop environment on the host you're controlling (mouse/keyboard
  control and screen capture both need an actual display — see
  **Troubleshooting** below for what that means per OS)

## Setup

```bash
npm install
npm start
# or a custom port:
node server.js 8080
```

The server prints an 8-character authentication code to the console. Open
`http://YOUR_DESKTOP_IP:3000` from the controlling device's browser, enter
that address and code, and connect.

## Server console commands

While running: `status`, `newcode` (rotate the auth code), `help`, `exit`.

## Protocol (WebSocket, JSON messages)

**Client → server**
| type | fields |
|---|---|
| `auth` | `code` |
| `ping` | `t` |
| `get_status` | — |
| `mouse_move` | `deltaX`, `deltaY` |
| `mouse_button` | `button` (left/right/middle), `action` (down/up) |
| `gesture` | `gesture` (leftClick, rightClick, doubleClick, scrollUp, scrollDown, twoFingerSwipeLeft/Right, threeFingerSwipeUp) |
| `keyboard` | `key`, `ctrlKey`, `altKey`, `shiftKey`, `metaKey` |
| `screen_subscribe` | `fps` (1–15) |
| `screen_unsubscribe` | — |
| `upload_start` | `filename`, `fileSize` |
| `upload_chunk` | `transferId`, `chunkIndex`, `data` (base64), `isLastChunk` |
| `upload_cancel` / `download_cancel` | `transferId` |
| `list_files` | — |
| `download_start` | `filename` |
| `download_chunk_request` | `transferId`, `chunkIndex` |
| `delete_file` | `filename`, `direction` (incoming/outgoing) |

**Server → client:** `auth_success` / `auth_failed`, `pong`, `status`,
`activity`, `error`, `screen_frame` / `screen_error`, `upload_started` /
`upload_progress` / `upload_error`, `transfer_progress` / `transfer_completed`
/ `transfer_cancelled`, `file_list`, `download_started` / `download_chunk` /
`download_error`, `file_deleted`.

Every message is validated by type before its handler runs; unauthenticated
connections can only send `auth`.

## File transfer

- Uploads and downloads are chunked (64KB) with real progress, not a single
  blocking payload.
- Filenames are never trusted as filesystem paths — only `path.basename()`
  of a sanitized name is used, and the resolved path is checked to still be
  inside the transfers directory before any read/write/delete.
- `transfers/incoming` = uploaded from the controlling device.
  `transfers/outgoing` = files you place on the desktop for the controlling
  device to download.
- Extension allow-list and 100MB size limit are enforced server-side
  (`filetransfer.js`), not just in the UI.

## Security notes

- The auth code locks out an IP for 30 seconds after 5 failed attempts.
- This is designed for trusted LAN use. It uses plain `ws://`, not `wss://`,
  and there's no per-user account system — anyone with the code and network
  access can connect. Don't expose this port to the open internet without
  putting it behind a VPN or a TLS-terminating reverse proxy first.

## Troubleshooting

### `npm install` fails on robotjs
Older versions of this project pinned `robotjs@^0.6.0`, which predates
robotjs's prebuilt Node-API binaries and fails to compile on modern Node.
This is now pinned to `^0.9.1`, which ships prebuilt binaries for Node 18+
on Windows/macOS/Linux (x64 and arm64) and should install without a
compiler. If it still fails, run `npm install robotjs@latest` directly and
check the printed error for your specific platform's build requirements.

### Mouse/keyboard control shows "Unavailable"
robotjs needs a real, reachable display.
- **Linux**: requires an active X11 session and the `DISPLAY` environment
  variable set (e.g. `DISPLAY=:0`). Wayland-only sessions are not supported
  by robotjs. Headless servers, containers, and CI environments have no
  display and will correctly show this as unavailable rather than crash —
  this was verified during development.
- **macOS**: grant Accessibility permissions to your terminal/Node under
  System Settings → Privacy & Security → Accessibility, then restart the
  server.
- **Windows**: should work out of the box on a normal desktop session.

### Screen view shows "Unavailable"
`screenshot-desktop` shells out to OS screenshot tools.
- **Linux**: requires `xrandr` (package `x11-xserver-utils` on
  Debian/Ubuntu, `xrandr` on Arch). Without it, the server now detects this
  at startup and disables the capability cleanly instead of crashing.
- **macOS/Windows**: uses built-in OS screenshot APIs; should work without
  extra setup, subject to macOS Screen Recording permission.

### Running as a long-lived service
Because mouse/keyboard/screen control ultimately depend on native OS
integration outside Node's control, run the server under a process
supervisor (`systemd` with `Restart=always`, `pm2`, or similar) in any
unattended deployment, so it recovers automatically from anything a
JavaScript try/catch genuinely cannot.

## Testing

```bash
npm start
# in another terminal, using the auth code printed above:
node test/smoke-test.js <AUTH_CODE>
```

This exercises the real protocol end-to-end (auth success/failure/lockout
behavior, ping/pong, a chunked upload with a path-traversal filename to
confirm it's contained, and mouse/screen calls). On a machine with no
display it should report those two as cleanly "unavailable"; on your real
desktop they should actually work.

## Project structure

```
dexile/
├── server.js          # WebSocket + HTTP server, protocol handlers
├── filetransfer.js     # Chunked upload/download manager (used by server.js)
├── client.html          # Self-contained web client (served by the server)
├── test/smoke-test.js   # Real protocol smoke test
├── transfers/            # incoming/ outgoing/ temp/ (created at runtime)
└── package.json
```
