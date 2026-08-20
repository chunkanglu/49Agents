<p align="center">
  <img alt="49Agents" src="https://github.com/user-attachments/assets/93d237b6-e1ec-40ea-aa30-6feb72ca6599" height="120" />
</p>

<h1 align="center">49 Agents IDE</h1>

<p align="center">The first 2D agentic IDE. Open source.</p>

<p align="center"><strong>All agents. All terminals. All projects. All machines. One unified space.</strong></p>

<p align="center">
  <a href="https://github.com/49Agents/49Agents/stargazers"><img src="https://img.shields.io/github/stars/49Agents/49Agents?style=flat" alt="GitHub Stars" /></a>
  <a href="https://twitter.com/49agents"><img src="https://img.shields.io/twitter/follow/49agents" alt="Twitter Follow" /></a>
</p>

https://github.com/user-attachments/assets/b2b038df-4100-490e-8bae-42965d5faca5

<h1 align="center">
  Before
</h1>

<img width="100%" alt="After — 49Agents" src="https://github.com/user-attachments/assets/878b3926-e017-4ccc-9c54-315b647fd417" />
<h1 align="center">
  49
</h1>
<img width="100%" alt="Before — terminal clutter" src="https://github.com/user-attachments/assets/b06c8fe8-d1bf-432a-b935-bbf8376bd7ff" />
<h1 align="center">
</h1>
<img width="1544" height="832" alt="diagram_with_pane_titles" src="https://github.com/user-attachments/assets/52a68a3a-8d77-4612-bbb0-dbc43ca990dd" />


---

| Before | 49 |
|--------|--------------|
| 14 terminal tabs | One zoomable canvas |
| SSH into each machine | All machines, zero SSH |
| Alt-tab to check Claude | Claude status on every pane |
| Can't work from phone | Any device, anywhere |
| Terminal-only, no files | Monaco editor on the canvas |
| 🤷 | Git graph |
| 🤷 | Interactive issue tables ([Beads](https://github.com/steveyegge/beads)) |
| 🤷 | Permission notifications |
| 🤷 | Markdown notes |

---

## Quick Start

```bash
git clone https://github.com/49Agents/49Agents.git
cd 49Agents
./49ctl setup    # interactive setup (one time)
./49ctl start    # start cloud server + agent
```

Open `http://localhost:1071`. No account, no login, no token.

Sharing a self-hosted instance with teammates over Tailscale — host setup,
adding other people's machines, the security model, and the failure modes worth
knowing: **[TAILNET.md](TAILNET.md)**.

Don't want to self-host? **[49agents.com](https://app.49agents.com)**
![tutorial](https://github.com/user-attachments/assets/776a96c7-35ae-495a-8c15-ee847b3dcd57)


---

## Desktop App (macOS)

Download the latest `.dmg` from [GitHub Releases](https://github.com/49Agents/49Agents/releases/latest).

After downloading, macOS will block the app because it is not notarized. Run this once to allow it:

```bash
xattr -cr /Applications/49Agents.app
```

Then open 49Agents normally. It runs as a tray icon — look for it in your menu bar.

Updates are delivered in-app: click the tray icon and choose **Check for Updates**.

---

## Features

### Canvas and Workspace

- [x] **Infinite canvas** — no tabs, no splits. Place panes anywhere on a zoomable surface
- [x] **Drag, resize, arrange** — your workspace grows with your thinking, not your monitor
- [x] **Zoom levels** — zoom out for the big picture, zoom in to focus
- [x] **Persistent layout** — everything stays where you put it

### Terminals

- [x] **Real tmux sessions** via ttyd — full ANSI color, scrollback, your shell config
- [x] **Broadcast input** — type once, send keystrokes to multiple terminals simultaneously

### Browser panes

A real Chrome running on the agent's machine, streamed into the canvas — the
same relationship a terminal pane has with tmux. It exists because **web page
panes are an `<iframe>`, and most sites refuse to be framed**: `github.com`
sends `x-frame-options: deny`, `google.com` and `app.shortcut.com` send
`SAMEORIGIN`. Those are the remote site's headers, so nothing on this end can
change them. A browser pane is not framing anything, so it is not subject to it.

- [x] **Tabs**, an address bar, back / forward / reload
- [x] **Shared view** — everyone on the canvas sees the same page, like a terminal
- [x] **Its own profile**, so logins persist across restarts without touching your
      everyday browser
- [x] **Survives an agent restart** — the browser is adopted, tabs and all

Requires Google Chrome, Chromium, Edge or Brave on the agent's machine
(`CHROME_BIN` overrides the search).

#### Which pane should I use?

| | Web page pane | Browser pane |
|---|---|---|
| Renders in | your browser, as an iframe | Chrome on the host, streamed as JPEG |
| Session | your cookies and logins | the pane's own profile |
| Fidelity | native text, zero bandwidth | a video of a page, ~1 MB/s while loading |
| Works on | only sites that permit framing | anything |
| Other viewers see | their own private copy | the same view as you |

#### Known limitations

- **Bandwidth.** Frames are JPEG at up to 20fps, roughly 1 MB/s per pane while a
  page loads. An idle page costs nothing — a page that is not repainting sends
  no frames at all — but several busy panes add up, and every viewer pays for
  every pane.
- **Not native text.** The page is an image. Browser-native find-in-page,
  spellcheck, and text selection you can copy out of the pane do not exist;
  selection inside the page works, but the clipboard round trip does not.
- **No context menu.** Chrome's right-click menu is browser UI, not page
  content, so it is not in the stream. Right-click reaches the page, so a site
  that draws its own menu works; everything else shows nothing.
- **JavaScript dialogs are auto-dismissed.** There is nowhere to show an
  `alert()`, and an unanswered dialog blocks the renderer, so `confirm()` always
  reads as Cancel.
- **No downloads or audio.**
- **Two viewers share one viewport.** Chrome is rendered at one size, and the
  last client to resize wins. The other viewer sees a stretched image, and their
  clicks land off-target by the ratio between the two pane sizes.
- **Panes do not re-attach after an agent restart** until the page is reloaded.
- **Board zoom does not re-render.** Zooming in magnifies the existing frames
  rather than asking Chrome for sharper ones.

#### Security

The debugging port Chrome exposes is unauthenticated and amounts to full control
of that browser — arbitrary JavaScript, cookies, `file://` reads — so it is
pinned to `127.0.0.1` and the agent is its only client; frames reach the canvas
over the existing relay. Panes default to a dedicated profile under the agent's
state directory rather than your everyday Chrome profile, because anyone who can
reach the canvas can drive these panes. `file:` and `javascript:` URLs are
refused.

### Multi-Machine

- [x] **Zero SSH** — connect agents from any machine to one canvas
- [x] **HUD overlay** — live CPU, RAM, and Claude API usage across all connected machines

### Access

- [x] **Any device** — laptop, tablet, phone. Same workspace, same layout
- [x] **Tailscale / LAN / hosted relay** — works however you connect
- [x] **Fully self-hosted** — the entire stack runs on your hardware
- [x] **No data stored server-side** — terminal I/O is relayed, never persisted

### Keyboard-First

- [x] **Tab chords** for pane switching
- [x] **WASD move mode** for spatial navigation
- [x] **Shortcut numbers** (1–9) for instant pane focus
- [x] **Broadcast mode** for multi-terminal input

---

## Architecture

```
┌──────────────┐    WSS    ┌──────────────┐    WSS    ┌──────────────┐
│  🖥️ PC       │ ────────►│  ☁️ Relay    │ ◄──────── │  📱 Browser  │
│  49-agent    │           │              │           │              │
└──────────────┘           └──────────────┘           └──────────────┘
                           Self-host or use
                            49agents.com
```

<details>
<summary>Multi-machine setup</summary>

```
┌──────────────┐                                         ┌──────────────┐
│  🖥️ MacBook  │ ─── WSS ───┐                        ┌───│  📱 Phone   │
│  49-agent    │             │                       │   │  Browser     │
└──────────────┘             │                       │   └──────────────┘
                             │   ┌──────────────┐    │
┌──────────────┐             ├──►│  ☁️ Relay    │◄───┤   ┌──────────────┐
│  🖥️ PC       │ ─── WSS ───┤   │              │     ├───│  💻 Laptop  │
│  49-agent    │             │   │  Self-host   │    │   │  Browser     │
└──────────────┘             │   │  or use      │    │   └──────────────┘
                             │   │ 49agents.com │    │
┌──────────────┐             │   └──────────────┘    │    ┌──────────────┐
│  ☁️ Azure VM │ ─── WSS ───┘                        └───│  📱 Tablet   │
│  49-agent    │                                          │  Browser     │
└──────────────┘                                          └──────────────┘

                  Each agent independently connects
                   to the relay via WebSocket.
                  No terminal data stored server-side.
```

</details>

---

## License

[BSL 1.1](./LICENSE) — free for individuals and small teams. Converts to MIT on 2030-02-26.
