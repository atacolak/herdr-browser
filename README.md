# Herdr Browser

Herdr Browser renders a real Chromium view inside a Herdr pane and exposes it to
Chrome DevTools Protocol clients. An agent drives the browser, you watch it in
the pane, and you take over with the mouse and keyboard at any point without
detaching the automation client.

Browser automation is normally invisible. The agent runs headless and you
reconstruct what happened from screenshots after the fact, or you babysit a
detached Chrome window that has no relationship to your session. Herdr Browser
puts the automated browser in the layout you are already working in, live, and
makes it directly interactive.

## What This Is Not

This is not a general-purpose browser. A desktop browser wins on devtools,
extensions, video, downloads, right-click menus, and IME, and this plugin does
not try to compete with it. Use it to observe and steer automation, and to
preview local development servers without leaving the terminal.

## Requirements

- Herdr 0.7.4 or newer
- Linux or macOS
- Bun
- Google Chrome or Chromium
- A Kitty graphics-compatible terminal such as Ghostty, kitty, or WezTerm

Enable Herdr's experimental graphics support in your Herdr configuration:

```toml
[experimental]
kitty_graphics = true
```

Apply the change by restarting Herdr or running:

```bash
herdr server reload-config
```

## Install

Install the published plugin from GitHub:

```bash
herdr plugin install ogulcancelik/herdr-browser --yes
```

For local development, link this checkout instead:

```bash
herdr plugin link ~/Projects/herdr-browser
```

## Agent Browser Automation

Herdr Browser includes a CLI in the plugin directory; it does not install a
global executable. Find the active checkout with:

```bash
herdr plugin list --plugin official.browser --json
```

Read `result.plugins[0].plugin_root`, then run the CLI with Bun:

```bash
bun run "<plugin_root>/src/cli.ts" views
bun run "<plugin_root>/src/cli.ts" connect --view <view_id>
```

`views` lists browser views currently backed by visible plugin panes. `connect`
starts a loopback CDP gateway scoped to the selected view and returns its HTTP
and WebSocket endpoints. The gateway represents the complete browser view, not
only its active tab. Browser Use, PinchTab, Playwright, and other CDP clients can
navigate and manage tabs through their normal APIs while the Herdr tab strip and
rendered page follow standard CDP target activation.

Point a client at the returned endpoint:

- Browser Use: set `BU_CDP_URL` to `cdp_http_url` or `BU_CDP_WS` to
  `browser_ws_url`.
- Playwright: call `chromium.connectOverCDP(cdp_http_url)`.
- Playwright MCP: pass `--cdp-endpoint=<cdp_http_url>`.
- Chrome DevTools MCP: pass `--browser-url=<cdp_http_url>`.

While a client is connected, the pane stays fully interactive. Clicks, scrolling,
hover, typing, and the toolbar act on the same targets the automation client
sees, so you can intervene mid-run and hand control back without reconnecting.

The endpoint grants full control over that browser view. Keep it local and do
not expose it over the network. Herdr Browser retains ownership of Chromium;
closing an attached automation client disconnects it without terminating the
plugin browser.

The agent-oriented workflow is documented in
[`skills/herdr-browser/SKILL.md`](skills/herdr-browser/SKILL.md).

## Open A Browser Pane

Open a blank browser in a right split:

```bash
herdr plugin pane open \
  --plugin official.browser \
  --entrypoint browser \
  --placement split \
  --direction right \
  --focus
```

Use `--placement tab`, `--placement zoomed`, or `--placement overlay` for the
other supported layouts. The first toolbar row provides tab selection, close,
and new-tab controls. The second provides back, forward, reload, stop, zoom,
and URL entry. Page clicks, scrolling, hover, and keyboard input are forwarded
to Chromium.

Pass an initial URL when another plugin opens the pane:

```bash
herdr plugin pane open \
  --plugin official.browser \
  --entrypoint browser \
  --placement zoomed \
  --env HERDR_BROWSER_INITIAL_URL=http://127.0.0.1:3000 \
  --focus
```

## Open Local Development Links

The plugin registers a link handler for HTTP URLs using `localhost`,
`127.0.0.1`, or `[::1]`. Hold Control and click a matching URL in any Herdr
terminal pane:

```text
http://localhost:5173
http://127.0.0.1:3000/dashboard
http://[::1]:8080
```

Control-click is used on macOS as well as Linux. A normal click remains terminal
input, and URLs that do not match the local-link handler continue through
Herdr's normal external browser behavior.

By default, a local link opens the browser in a focused right split. Configure
that behavior in `browser.json` under the plugin configuration directory:

```bash
herdr plugin config-dir official.browser
```

Example configuration:

```json
{
  "linkOpenPlacement": "split",
  "splitDirection": "right",
  "focusOnOpen": true,
  "browserZoom": 1.25,
  "showDiagnostics": false,
  "captureScale": 1,
  "captureBackend": "screenshot",
  "screencastEveryNthFrame": 1,
  "screencastPollMs": 250,
  "profileRoot": "/absolute/path/to/herdr-browser-profiles"
}
```

`browserZoom` sets the initial page zoom from `0.5` through `2.5` and defaults
to `1`. The browser toolbar's `[-]` and `[+]` controls change the current pane
in ten-percent steps and persist the new default to this file. Pane resizing
does not change browser zoom.

`showDiagnostics` reserves a bottom status row with stream and viewport metrics.
It defaults to `false` and is intended for performance debugging.

`captureScale` reduces the captured frame size from `0.1` through `1` and
defaults to `1`. Frames are captured at full device pixels, so a HiDPI display
pays for every one of them twice over: once in Chromium's encoder and again in
the terminal's decode and texture upload. Setting `0.75` cuts pixel count by
roughly 44% for a modest loss of sharpness, and is the most effective knob
available if a browser pane costs more CPU than you want. Text stays legible
well below `1` because the pane is already downscaled to fit the cell grid.

`captureBackend`, `screencastEveryNthFrame`, and `screencastPollMs` tune the
frame pipeline itself and rarely need changing. `captureBackend` selects
`screenshot` or `screencast` for on-demand frames and defaults to `screenshot`;
the live pane stream uses screencast regardless. `screencastEveryNthFrame`
accepts `1` or `2` and halves the producer rate at `2`. `screencastPollMs`
accepts `50` through `5000` and defaults to `250`.

Chrome profiles persist by default under the plugin state directory and are
isolated by Herdr session. `profileRoot` optionally changes the parent
directory; the sanitized Herdr session name is still appended to prevent
Chrome profile-lock conflicts across concurrent sessions. Do not point it at a
profile currently used by another Chrome process.

`linkOpenPlacement` accepts `split`, `tab`, `zoomed`, or `overlay`. An overlay
is the recommended transient, popup-like browser surface. True Herdr `popup`
placement is not supported because popups do not have the pane identity needed
by the graphics stream.

## Keybindings

Add custom commands to your Herdr configuration to open the browser without a
link. This example binds a right split and a transient overlay:

```toml
[[keys.command]]
key = "prefix+b"
type = "shell"
command = '"${HERDR_BIN_PATH}" plugin pane open --plugin official.browser --entrypoint browser --placement split --direction right --focus'
description = "open browser in right split"

[[keys.command]]
key = "prefix+shift+b"
type = "shell"
command = '"${HERDR_BIN_PATH}" plugin pane open --plugin official.browser --entrypoint browser --placement overlay --focus'
description = "open browser overlay"
```

Reload the configuration after editing it:

```bash
herdr server reload-config
```

## Chromium Discovery

The plugin launches a separate headless Chromium process with a dedicated,
persistent profile for each Herdr session. Cookies, origin storage, consent
state, and logins survive browser pane and daemon restarts within that session.
It does not attach to your normal browser process or reuse your normal browser
profile.

On Linux, it searches common Chrome and Chromium executable names on `PATH`. On
macOS, it also searches standard Google Chrome and Chromium application
locations. Set an explicit executable in the environment used to start the
Herdr server when automatic discovery is insufficient, then restart Herdr:

```bash
export HERDR_BROWSER_CHROME="/path/to/chrome"
```

The current release does not download Chromium automatically. If no compatible
browser is installed, startup fails with a discovery error.

## External CDP

By default the plugin launches and owns a headless Chromium. To attach instead
to a browser you already started on this machine, point it at that browser's
**loopback** CDP HTTP endpoint:

```bash
export HERDR_BROWSER_CDP_URL="http://127.0.0.1:9222"
# or in browser.json: { "cdpUrl": "http://127.0.0.1:9222" }
```

Only plain `http://` on `127.0.0.1`, `localhost`, or `[::1]` is accepted (Chrome
remote debugging is local HTTP, not HTTPS). `HERDR_BROWSER_CDP_URL` wins when
both are set. Omit both for owned launch.

Ownership rules:

- Never launches, kills, or reaps the external browser.
- Daemon shutdown and pane close only disconnect; browser death is observed via
  the existing browser websocket close path.
- Each view creates and owns a new page target; pre-existing tabs are left alone.
- Daemon state files are namespaced by session and CDP endpoint so multiple
  external ports can coexist.

Start Chrome with remote debugging on loopback, confirm `/json/version`
answers, then open a browser pane or run the CLI with the env set. Unset the
env (and remove `cdpUrl`) to return to owned launch.

## Rendering

Frames come from CDP screencast and reach the terminal through Herdr's pane
graphics stream. Capture is paint-driven and paced by delaying
`Page.screencastFrameAck`, which applies backpressure before Chromium encodes
another frame instead of discarding frames after the cost is already paid. The
passive ceiling is 15 FPS; direct input raises it to 30 FPS for 750 ms and then
returns to the passive rate. A settled page emits close to nothing.

## Local Smoke Test

Start the included test page on an unused port from a Herdr pane:

```bash
HERDR_BROWSER_TEST_PORT=43127 bun run test-page
```

Control-click the printed local URL. Confirm that the page opens, resizes with
the pane, accepts clicks and typing, and closes its browser view when the pane
is closed.

Run the automated checks with:

```bash
bun test
bun run typecheck
```

## Current Limits

Windows, true popup placement, downloads, right-click menus, DevTools, and IME
are not supported. There is no page text selection, clipboard copy, or
find-in-page yet. Rendering requires Herdr's experimental Kitty graphics setting
and is tuned for local sessions; the per-frame bandwidth is too high for remote
SSH use.
