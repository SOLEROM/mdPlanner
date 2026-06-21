# MD Planner

A lightweight, dependency-light reviewer for the markdown **plan files** Claude Code
produces. Read a plan, drop **questions, remarks, "wrong" flags and "fix" suggestions**
straight into the file (each **colour-coded** so they stand apart from the plan and from
each other), resolve them, reply, and record an
**approve / request-changes** verdict — all saved as plain markdown *inside the `.md`
file itself*, so Claude can read your feedback on the next round.

It runs two ways, and you don't install anything heavy on either device:

| Mode | Where | How | Read | Write |
|------|-------|-----|------|-------|
| **1 — Server** | Linux host (where the files live) | `python3 server.py` then open the URL on your tablet over the LAN | ✅ | ✅ in place |
| **2 — Standalone** | Android phone/tablet, no server | open `web/index.standalone.html` (one self-contained file) | ✅ | in place if the browser supports it, else exports a patched copy |

Both modes share the exact same UI and the same remark format — only *where the bytes
get written* differs.

---

## Requirements

- **Mode 1:** Python **3.8+** (standard library only — no `pip install`, no virtualenv).
- **Mode 2:** any modern browser (Chrome/Firefox on Android, etc.).
- The markdown rendering libraries (`markdown-it`, `highlight.js`, `mermaid`) are
  **vendored** under `web/vendor/` — everything works **offline**, no CDN, no network.

> Node.js + pytest are only needed to run the test suite (see [Development](#development)).
> You do **not** need them to use the app.

---

## Quick start — Mode 1 (server on Linux, review from the tablet)

From this `app/` directory:

```bash
./run.sh
# or, equivalently, point it at any markdown root:
python3 server.py /data/aproj/mdplaner
```

You'll see:

```
MD Planner serving /data/aproj/mdplaner
  local:  http://127.0.0.1:8787/
  LAN:    http://<this-host-LAN-IP>:8787/
```

- On the **Linux host**, open <http://127.0.0.1:8787/>.
- On the **tablet/phone on the same Wi-Fi**, open `http://<host-ip>:8787/`
  (find the host IP with `ip addr` / `hostname -I` — e.g. `http://192.168.1.20:8787/`).

The root (the folder whose `.md` files fill the left list) follows the **Server root**
field (⚙ → Server root, saved as `rootPath`): a relative value like `plans` resolves
against the project folder, an absolute path is used as-is, and a blank or non-existent
path falls back to the parent of this `app/` folder. Pass a root as the first argument to
**override and lock** it (the field is then ignored), and set the host/port with flags:

```bash
python3 server.py /path/to/your/plans --host 0.0.0.0 --port 9000
```

Changing the field re-scopes the list on the next server start (use **⚙** in the UI, then
restart). Editing it never redirects a running server live — that's deliberate, so a tablet
on the LAN can't repoint the host's file root.

(Host/port also fall back to `server.host` / `server.port` in the config file, and to
the `MDPLANNER_HOST` / `MDPLANNER_PORT` environment variables.)

### Tip: keep it running

Quick and dirty — survives logout, logs to a file:

```bash
nohup ./run.sh > ~/mdplanner.log 2>&1 &
```

Proper — install a **systemd service** that starts at boot and restarts on failure:

```bash
./run.sh --service                         # follows the Server-root field, on :8787
./run.sh /path/to/plans --port 9000 --service   # bake a custom root/port into the unit (locks it)
```

`--service` writes `/etc/systemd/system/mdplanner.service` (running as **you**, not root —
it honours `$SUDO_USER`), reloads systemd, and `enable --now`s it. With no `ROOT` argument the
service **follows the configured Server-root field** — edit it in **⚙** and
`./run.sh --restart` to re-scope, no reinstall. An explicit `ROOT` and any `--host`/`--port`
are baked into the unit, and an `ExecStartPre` rebuilds the Mode-2
bundle on every start. `NoNewPrivileges` is always on; the filesystem sandbox depends on the
on-demand mode — **unrestricted by default** (relaxed, see [On-demand plans](#on-demand-plans--review-a-file-outside-the-root-no-syncing)),
or fully locked down (`ProtectSystem=strict`, `ReadWritePaths` = root + app dir + your dirs)
when you pass `--open-dir`. Manage it
with the built-in shortcuts (they proxy `systemctl`, escalating to root only when mutating):

```bash
./run.sh --status    # ≡ systemctl status mdplanner   — is it up? (+ recent log)
./run.sh --restart   # ≡ systemctl restart mdplanner  — after config/source changes
./run.sh --stop      # ≡ systemctl stop mdplanner
```

…or drive `systemctl` directly:

```bash
systemctl status mdplanner       # is it up?
journalctl -u mdplanner -f       # follow logs
systemctl restart mdplanner      # after config/source changes
systemctl disable --now mdplanner   # stop & remove from boot
```

Run `./run.sh --help` to print both run modes and all flags.

### On-demand plans — review a file outside the root, no syncing

When the server is up (foreground or service), render a plan that lives **anywhere on the
host** without moving it into the root or waiting for Syncthing:

```bash
./run.sh --open /path/to/some-project/plan.md
```

**Any path on the host works out of the box** — no `--open-dir`, no flags. It pins the file and
opens `http://127.0.0.1:<port>/?adhoc=<id>`; the plan shows up in an **On-demand** group in the
file list, and your questions / remarks / wrong / fix notes and the approve/request-changes
verdict **save straight back into that file** — so Claude reads the feedback next round. Open the
same `?adhoc=…` URL from a tablet on the LAN to review there too. (The **root only scopes the
left-menu list**; it never limited what you can open on demand.)

How it stays safe (it can touch files outside the root):

- **Only the host can add a file.** Pinning is **loopback-only** — a LAN browser can view and
  annotate a pinned plan, but can never name a *new* path. Files are reached by an opaque id,
  never a client-supplied path. Only `.md`/`.markdown` files qualify.
- **Restrict it if you want.** Unrestricted is the default; to confine on-demand plans to
  specific directories pass **`--open-dir DIR`** (repeatable) or `$MDPLANNER_OPEN_DIR`
  (`:`-separated). That also **keeps the systemd service hardened** (`ProtectSystem=strict`,
  with `ReadWritePaths` = root + app dir + those dirs):

```bash
./run.sh /data/aproj/mdplaner --open-dir /data/aproj --open-dir /tmp   # confine + harden
```

  Without `--open-dir`, the installed **service drops `ProtectSystem`/`ProtectHome`** so it can
  write wherever you pin (`./run.sh --service` prints a warning). Pinning stays host-only either way.

> Changing the scope means (re)starting the server — `--open` only talks to the already-running
> one. Under `--service`, re-run `./run.sh --service` (add `--open-dir …` to confine) to re-bake
> the unit. (A foreground server reads `/tmp` directly; a **`--open-dir`-bounded** service runs
> with `PrivateTmp=true` so it has its own `/tmp` and can't see yours — the unrestricted default
> turns that off so `/tmp` works.)

---

## Quick start — Mode 2 (standalone on Android, no server)

Use the **single self-contained file `web/index.standalone.html`** — *not* `index.html`.
This matters on Android: when you tap a file in the Android "Files" app, the browser is
handed a `content://…` URI, which points at one file's bytes and has **no sibling
directory** — so the multi-file `index.html` can't load its `css/`, `js/`, or `vendor/`
assets and renders as an unstyled, dead page. `index.standalone.html` has **every** asset
(CSS, all JS, the vendored markdown-it / highlight.js / mermaid) inlined, so it renders
correctly however it's opened — `content://`, `file://`, or `http://`.

If the whole `mdplaner` folder is synced to the device (e.g. via **Syncthing**):

1. In your Android file manager, find `…/mdplaner/app/web/index.standalone.html`.
2. Open it with Chrome (tapping it from the Files app works — that's the whole point).
3. Tap **📂 Open a .md file…** and pick a plan from the synced folder.

> **Keeping the bundle fresh.** `index.standalone.html` is *generated* from the `web/`
> sources by `build-standalone.py` (there's no duplicated source — `web/` is the single
> source of truth, and the bundle is git-ignored). `./run.sh` rebuilds it automatically on
> every server start; to rebuild by hand after editing the UI, run `python3
> build-standalone.py`. Then re-sync so the tablet picks up the new bundle.

> **Optional: a browsable plans list in standalone.** When the bundle is **served over
> http(s)** by any dumb static host (`python3 -m http.server` in `app/web/`, nginx, a
> CDN, Syncthing's built-in server…), it auto-lists the markdown under a **standalone
> root** — defaulting to `../../plans` *relative to `index.standalone.html`* — so you get
> the same searchable file list + badges as the server, reading each plan over http. Set
> the folder under **⚙ → Standalone root (Mode 2)**. This needs http: opening the file
> directly (`file://`, or a `content://` URI from Android's Files app) can't scan a
> folder, so there it simply falls back to the **📂 Open a .md file…** picker.

The header badge shows **📱 Standalone**. You can read and annotate fully. Saving:

- If the browser supports the **File System Access API**, your remark is written back
  to the picked file in place.
- Otherwise (typical on stock Android Chrome) the app **exports a patched copy**: it
  copies the full updated markdown to the clipboard *and* offers it as a download/share,
  so you can drop it back over the original. The on-screen toast tells you which
  happened.

> Because the files ride a Syncthing share, edits made in Mode 1 on the host appear on
> the tablet (and vice-versa) automatically.

---

## Using the reviewer

- **Open a plan** — Mode 1: pick it from the searchable list on the left (each row shows
  a verdict badge `✅ / 🟠 / ⚪` and an open-remark count `●3`; dependency dirs like
  `node_modules`, `venv`, `dist` are skipped). Or, for a file **outside the root**, push it
  in from the host with [`./run.sh --open FILE`](#on-demand-plans--review-a-file-outside-the-root-no-syncing)
  — it appears in an **On-demand** group at the top of the list. Mode 2: the **📂 file
  picker**, plus — when the bundle is served over http(s) — the same searchable list, sourced
  from the **Standalone root** (default `../../plans`); see Quick start — Mode 2.
- **Annotate** — **tap any block** (paragraph, heading, list item, code block). A small
  action bar appears **inline, anchored right under that block** (it scrolls with the text,
  never floats over the chrome) with four typed actions, each tinted its own colour:
  **＋ Question** (blue), **＋ Remark** (red), **＋ Wrong** (amber), **＋ Fix** (green).
  Type, **Save** — a colour-coded blockquote is spliced in **right after that block**:

  ```markdown
  > 🔴 **Q (me):** why three planes and not two?
  > 🔴 **W (me):** this date is off by a year
  > 🔴 **F (me):** use 2026 instead
  ```
- **Resolve / reply / delete** — tap a remark box → **Resolve** (icon flips to ⚪, the box
  dims), **Reply** (adds a threaded `> ↳ **me:** …` line), or **Delete** (asks to confirm,
  then removes the whole note — header, body and replies — leaving no trace in the file).
  Claude answers questions by editing the raw `.md` directly, and its replies show up in the
  same thread.
- **Triage** — tick **Open only** to hide resolved remarks; **Next open ⊕** jumps between
  unresolved ones; the counter shows `N open · M total`.
- **Verdict** — **✅ Approve** or **🟠 Request changes** upserts a single status line under
  the document's H1 (replaced, never duplicated) and recolours the banner + list badge:

  ```markdown
  # Master Agent Plan #1 — …

  > 🟠 **CHANGES REQUESTED** — me · 2026-06-19
  ```

Everything you do is ordinary markdown that renders fine in any other viewer; the app
just colour-codes the sentinel-icon blockquotes (per type) so your notes stand out from
the plan.

### Desktop navigation (wide screens)

On a roomy screen the side gutters become navigation aids (they hide automatically on
phones/tablets so the mobile view stays focused on reading):

- **📑 Outline** (top-bar toggle) — a VS-Code-style tree of the document's headings down
  the left. It highlights the section you're currently scrolling through, shows a red
  badge on any section that still has **open** notes, and jumps you there on click.
- **Notes rail** (right) — every question/remark in the plan, with a snippet and status.
  Each item is **colour-coded by type** (a blue/red/amber/green dot and left bar for
  question / remark / wrong / fix — the same hues as the add-note buttons), so you can
  spot the kind of each note at a glance; resolved notes dim to a hollow grey dot. Click
  one to fly to it in the text. Honours the **Open only** toggle.
- **⧉ Split** (top-bar, left) — split the reader into **two independent panes** to compare
  two plans side by side; each pane opens its own file (📂 in its toolbar) and **scrolls
  separately**. Press **✕** on a pane to go back to a single view.
- **⟳ Reload** (top-bar) — re-reads the config and re-renders everything on demand. Handy
  after editing settings, or to pull in changes a synced/edited file made on disk.

---

## Configuration (the ⚙ tab)

Press **⚙** to edit settings live — author label, the **two roots** (**Server root** for
Mode 1 and **Standalone root** for Mode 2 — each run mode uses its own), the marker
**icons / prefixes / labels / header template**, the **per-type colours** (question /
remark / wrong / fix), theme, font scale, rendering toggles, and the server host/port.
**Save & apply** re-renders immediately; no source edit, ever.

Settings are stored in one synced file:

```
<project>/.mdplanner/config.json      # the folder that holds app/ (NOT the scanned root)
```

The config lives next to `app/`, independent of whichever folder the **Server root** field
points the listing at — so the field you edit and the file the launcher reads are always the
same one. (Passing an explicit `ROOT` on the command line moves both into that root, the
legacy behaviour.) In Mode 1 the server reads/writes it; in Mode 2 overrides are kept in the browser's
`localStorage`. Because the format tokens live in this one file, both devices parse and
write **identical** markers. Changing, say, `marker.iconOpen` from `🔴` to `❗` changes the
grammar everywhere with no code change.

Key defaults (see `web/js/config.js` / `mdmarks.py` for the full schema):

```jsonc
{
  "author": "me",
  "rootPath": "plans",                  // Server root (Mode 1): relative to <project>, or absolute
  "standaloneRoot": "../../plans",       // Standalone root (Mode 2), relative to index.standalone.html
  "marker": {
    "iconOpen": "🔴", "iconResolved": "⚪", "replyPrefix": "↳ ",
    "types": { "question": "Q", "remark": "R", "wrong": "W", "fix": "F" },
    "headerTemplate": "**{type} ({author}{statusSuffix}):** "
  },
  "ui": {
    "theme": "auto", "remarkColor": "#e5484d",
    "typeColors": { "question": "#3b82f6", "remark": "#e5484d", "wrong": "#f5a623", "fix": "#30a46c" }
  },
  "server": { "host": "0.0.0.0", "port": 8787 }
}
```

---

## Security notes

- **No authentication, by design.** Mode 1 binds `0.0.0.0` for a **trusted home LAN**.
  Don't expose port 8787 to the internet. To restrict to the host only, run with
  `--host 127.0.0.1`.
- The server confines **rooted** file access to the root: paths are normalised and must
  stay inside it (no `..`, no symlink escape, no absolute paths, null bytes rejected), only
  `*.md` is read/written via the API, request bodies are size-capped, and responses send
  `X-Content-Type-Options: nosniff` / `X-Frame-Options: SAMEORIGIN`.
- **On-demand plans** ([above](#on-demand-plans--review-a-file-outside-the-root-no-syncing))
  are the one path that *can* read/write `.md` files outside the root. They're safe because
  **pinning a new path is loopback-only** (only a process on the host — never a LAN browser —
  can introduce one), files are reached by an opaque id rather than a client-supplied path,
  and the host can confine them with `--open-dir` (which also keeps the service sandboxed).
- Rendering is XSS-hardened: markdown is rendered with raw-HTML disabled and Mermaid runs
  in `securityLevel: 'strict'`.

---

## Development

```bash
# JS unit tests (Node's built-in runner; installs markdown-it + highlight.js as devDeps)
npm install
npm test                      # 50 tests: remarks, render, config, storage, rail

# Python tests (server API + path-safety + the remark counter)
python3 -m pytest tests/py/   # 37 tests
```

### Layout

```
app/
  server.py        Mode-1 HTTP server (stdlib only)
  mdmarks.py       server-side remark parser + path-safety (mirrors the JS engine)
  run.sh           convenience launcher (also rebuilds the standalone bundle)
  build-standalone.py  inlines web/ into web/index.standalone.html (Mode 2, git-ignored)
  web/
    index.html              multi-file entry (Mode 1 / server)
    index.standalone.html   generated single-file entry (Mode 2 / offline tablet)
    css/styles.css
    js/
      config.js    defaults, deep-merge, validation
      remarks.js   parse / splice / toggle / reply / delete / approval  ← the core, pure text ops
      render.js    markdown-it pipeline + source-line mapping for tap-to-comment
      storage.js   ServerStorage (REST) | ClientStorage (picker + FS-Access/export)
      ui/          dom (h/clear), filelist, reader (panes + outline + rail), configtab
      app.js       boot, mode detection, pane orchestration, persistence
    vendor/        markdown-it, highlight.js, mermaid (offline)
  tests/js, tests/py
  PLAN.md          the original design doc
  CLAUDE.md        orientation map for working on the code
```

The remark engine is **pure text in / text out**, so the same parse and splice logic runs
identically on the server (Python) and in the browser (JS) and is unit-tested on both
sides. See `PLAN.md` for the full design and the decisions behind it.
