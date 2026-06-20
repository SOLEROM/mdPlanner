---
noteId: "md-planner-plan-1"
tags: [plan, md-planner, review-tool, syncthing, android]
---

# MD Planner — a lightweight dual-mode reviewer for Claude-Code plan files

> **Status:** **implemented** — all of P0–P5 shipped and tested (50 JS + 37 Python tests).
> This doc is the original design; see **§10** for what shipped and where it went beyond
> the plan, and **`CLAUDE.md`** for the working map of the code.
> **Audience:** us, picking this up to extend / refactor.
> **Goal (the north star):** a tiny, dependency-light app to **read, approve, and
> annotate** the markdown plan files that Claude Code produces — on a **Linux desktop**
> and on an **Android phone/tablet** — where our remarks and questions are saved
> *inside* the md file as visible markdown, shown **notably red** in the app to set
> them apart from the original plan, with every behavioural knob exposed in a **config
> tab** so nothing needs a source-code change.
>
> Grounded in the tree as of 2026-06-19: the plan files live under
> `/data/aproj/mdplaner` (an existing **Syncthing** folder — note the `.stfolder`),
> use Obsidian-style YAML frontmatter (`noteId`, `tags`) and GitHub-flavoured markdown
> (tables, fenced code, ASCII diagrams). When code and this doc disagree later,
> **the code wins** — update this doc.

---

## 0. TL;DR — the shape of the thing

One **shared vanilla web UI** with two ways to run, picked automatically:

```
          ┌──────────────────────────────────────────────────────────────┐
          │  MODE 1 — SERVER (Linux host, where the md files live)        │
          │                                                              │
          │   server.py (python stdlib)  ──reads/writes──►  *.md files   │
          │      serves the web UI + a tiny file API                     │
          │      bind 0.0.0.0:8787  (no auth, trusted home LAN)          │
          └───────────────────────────────▲──────────────────────────────┘
                          over the LAN     │  http://host:8787
                          (full read/write)│
            ┌─────────────────────────────┴───────────────────────────────┐
            │  Android tablet/phone — just opens the URL in its browser     │
            │  ZERO install. Full read + write (the server does file I/O).  │
            └───────────────────────────────────────────────────────────────┘

          ┌──────────────────────────────────────────────────────────────┐
          │  MODE 2 — STANDALONE (static, no server, no install)         │
          │                                                              │
          │   the SAME web/ folder, opened as static files in the        │
          │   Android browser. Renders md client-side (markdown-it).     │
          │   READ-first: pick a file → render. Writing a remark →       │
          │     • in-place save if the browser has File System Access    │
          │     • else copy-to-clipboard / share a patched copy          │
          │   The web/ folder itself rides along in the Syncthing share. │
          └──────────────────────────────────────────────────────────────┘
```

The two modes differ **only** in a `storage.js` adapter (`ServerStorage` vs
`ClientStorage`). Everything else — rendering, the remark grammar, the splice logic,
the config tab — is identical code shared by both.

---

## 1. Decisions locked (from the grilling pass)

| # | Topic | Decision |
|---|-------|----------|
| 1 | Runtime | **Two modes**: (1) Python server on Linux + LAN browser, full R/W; (2) Android standalone static page, client-side render, read-first. No native APK. |
| 2 | Stack | **Vanilla** HTML/CSS/JS. `markdown-it` + `highlight.js` + `mermaid`, all **vendored locally** (offline, no CDN). Python **stdlib** server for Mode 1. |
| 3 | Storage abstraction | One `storage.js` adapter; `ServerStorage` (REST) vs `ClientStorage` (file picker + FS-Access-API/export). Mode auto-detected. |
| 4 | Remark encoding | **Visible blockquote markers** — real markdown, shown in every tool, painted red in-app. |
| 5 | Anchoring | **Block-level**: tap a paragraph / heading / list-item / code block → remark blockquote inserted **immediately after** that block. |
| 6 | Types & status | **Question (Q)** and **Remark (R)**, each **open/resolved**, with nested **replies**. App filters to "open only", counts them, jumps between unresolved. |
| 7 | Edit scope | **Annotate-only** — plan prose is read-only; the app only ever writes remark blockquotes + the approval line. Claude applies real edits later. |
| 8 | Marker grammar | **Minimal & human-readable**: `> 🔴 **Q (me):** text`. Type + author only; resolved shown by an icon/word swap. Every token is config-driven. |
| 9 | Approval | **Visible status blockquote** directly under the H1, **upserted** on each verdict. |
| 10 | Config | **Single file** `<root>/.mdplanner/config.json` (rides the Syncthing share). All format rules live here so both devices parse identically. |
| 11 | Navigation (Mode 1) | **Flat searchable list** (recurses subfolders, relative paths) with **status + open-remark badges**. Mode 2 uses the browser file picker. |
| 12 | Concurrency | **Minimal** — atomic temp+rename writes, insertion splice, no freshness check (accept the rare clobber). Sync-conflict files just show in the list. |
| 13 | Network/auth | **LAN bind `0.0.0.0`, no auth** (trusted home network). |
| 14 | Rendering | GFM essentials **+ syntax highlighting + mermaid**. Frontmatter hidden by default with a toggle. Mermaid lazy-loaded only when a diagram is present. |

---

## 2. The remark data model (the core)

Remarks are **plain markdown blockquotes** with a sentinel icon. The sentinel is what
makes them distinguishable from the plan's *own* blockquotes (e.g. `> **Status:** …`),
which the app renders normally.

### 2.1 Default grammar (all tokens configurable — see §5)

```markdown
...the plan paragraph you tapped...

> 🔴 **Q (me):** why three planes and not two?
> ↳ **claude:** consolidated to two; see §0.

...the next plan block...
```

- **`> `** — blockquote prefix (`marker.blockquotePrefix`).
- **`🔴`** — open sentinel (`marker.iconOpen`). Resolved swaps to **`⚪`**
  (`marker.iconResolved`) and the app dims/greys the box.
- **`**Q (me):**`** — `**{TYPE} ({author}{statusSuffix}):**`
  - `TYPE` ∈ `{Q, R, W, F}` (`marker.types.question` / `.remark` / `.wrong` / `.fix`;
    see §10.7 — each renders in its own colour from `ui.typeColors`).
  - `author` from `config.author` (default `me`).
  - `statusSuffix` empty when open, `, resolved` when resolved (`marker.resolvedSuffix`).
- **`↳`** — reply prefix (`marker.replyPrefix`); a continuation line in the *same*
  blockquote, `> ↳ **{who}:** …`. This is how Claude answers a question inline.
- Multi-line remark/reply bodies are just more `> ` lines.

### 2.2 Parsing rule (robust without ids)

A blockquote block is a **remark block** iff its first content line starts with
`iconOpen` **or** `iconResolved`. The parser then reads the bold `{TYPE} ({author}…)`
header and the body, and collects any `↳`-prefixed lines as replies. Because there is
no stable id (we chose the clean/minimal grammar), the app locates a remark for
toggle/reply by **(file path + the exact marker block text + its ordinal position)**.
This is resilient to edits elsewhere in the file; the only fragility is if the marker's
own text is hand-edited between load and action — acceptable for a single-user tool.

### 2.3 Approval marker (file-level verdict)

A single blockquote placed **immediately under the H1**, **upserted** (replaced, never
duplicated) on each verdict:

```markdown
# Master Agent Plan #1 — …

> 🟠 **CHANGES REQUESTED** — me · 2026-06-19

> **Status:** proposal / design plan …   ← the plan's own content continues
```

States (`approval.states`): `✅ APPROVED` (green) · `🟠 CHANGES REQUESTED` (orange) ·
`⚪ PENDING` (grey). The app surfaces this as a coloured banner at the top of the reader
and offers **[Approve]** / **[Request changes]** buttons; it can auto-suggest
*changes-requested* when open remarks exist.

---

## 3. Architecture & components

```
app/
  PLAN.md                     ← this document
  server.py                   ← Mode 1 server (python stdlib only)
  run.sh                      ← convenience: rebuilds the bundle, then python3 server.py …
  build-standalone.py         ← inlines web/ → web/index.standalone.html (Mode 2 bundle)
  web/                        ← the shared UI (served in Mode 1; inlined for Mode 2)
    index.html                ← multi-file entry (Mode 1 / server)
    index.standalone.html     ← generated single-file entry (Mode 2); git-ignored
    css/styles.css            ← incl. the red remark styling + dark/light + font scale
    js/
      app.js                  ← bootstrap, mode detection, view wiring
      storage.js              ← adapter: ServerStorage | ClientStorage  (the linchpin)
      remarks.js              ← parse / splice-after-block / toggle / reply / upsert-approval
      render.js               ← md → HTML pipeline (markdown-it + hljs + mermaid + frontmatter)
      config.js               ← load/merge/validate/save config, live-apply
      ui/
        filelist.js           ← flat searchable list + status/open-count badges
        reader.js             ← rendered plan + tap-to-comment toolbar + open-filter/jump
        configtab.js          ← edit + save config
    vendor/
      markdown-it.min.js
      highlight.min.js  +  highlight.css
      mermaid.min.js          ← lazy-loaded only when a ```mermaid fence is seen
  tests/
    js/    (node:test + jsdom)  ← remarks/render/config/storage units
    py/    (pytest)             ← server endpoints, path-traversal guard, listing
```

### 3.1 Mode detection (`app.js`)
On load, probe `GET /api/files`. **Success → Mode 1** (`ServerStorage`). **Failure or
`file:` protocol → Mode 2** (`ClientStorage`). A small badge in the header shows which
mode is active.

### 3.1a Mode-2 bundle (`build-standalone.py` → `index.standalone.html`)
The multi-file `index.html` loads `css/`, `js/`, and `vendor/` by **relative path**.
That breaks on Android: tapping a file in the Files app hands the browser a `content://`
URI, which addresses one file's bytes and has **no sibling directory**, so every relative
asset 404s and the page renders unstyled and dead. So Mode 2 ships a **single
self-contained file**: `build-standalone.py` inlines all CSS, every script, and the
vendored libs (markdown-it / highlight.js / **mermaid**) into `web/index.standalone.html`
— zero relative fetches, renders identically over `content://` / `file://` / `http://`.
It is a **build artifact, not a second copy**: `web/` stays the single source of truth,
the file is git-ignored, and `./run.sh` regenerates it on every start. Two runtime
branches in `app.js` are feature-detected on the inlined nodes (so they no-op for Mode 1):
the highlight theme is swapped by writing inlined CSS text into a live `<style>` rather
than swapping a `<link href>`, and **mermaid stays lazy** by building a `Blob` URL from
its inlined source on first diagram instead of fetching the vendor file.

### 3.2 The splice is shared; only persistence differs
`remarks.js` works purely on **raw markdown text** — given the file text, a target block,
and a new remark, it returns new file text with the blockquote inserted after that block.
Both modes call the *same* function; they differ only in `storage.write(path, text)`:

| Operation | `ServerStorage` (Mode 1) | `ClientStorage` (Mode 2) |
|-----------|--------------------------|--------------------------|
| list | `GET /api/files` | n/a — browser file picker |
| read | `GET /api/file?path=` | `FileReader` on picked file / FS-Access handle |
| write | `PUT /api/file?path=` (atomic) | FS-Access `createWritable()` **if available**, else `navigator.clipboard` copy + `share`/download of the patched copy |
| config | `GET/PUT /api/config` | bundled defaults + `localStorage` overrides |

---

## 4. Server API (Mode 1, python stdlib `http.server`)

Root path comes from a **launch argument** (`python3 server.py <root>`), defaulting to
`config.rootPath`; this dodges the config chicken-and-egg (config lives *inside* the root)
while keeping all *format* rules in the synced file.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` , `/static/*` | serve the `web/` UI + vendored libs |
| `GET` | `/api/files` | recursive list of `*.md`: `[{path, status, openCount, mtime}]` |
| `GET` | `/api/file?path=` | raw md text (path validated against root) |
| `PUT` | `/api/file?path=` | write full new text **atomically** (temp + `os.replace`) |
| `GET` / `PUT` | `/api/config` | read / write `<root>/.mdplanner/config.json` |

**Security (even without auth):** every `path` is normalised and **must stay inside the
root** (reject `..`, symlink escapes); only `*.md` (+ config) are writable; bodies size-
capped; render uses `markdown-it({html:false})` and `mermaid.securityLevel:'strict'` to
neutralise embedded-HTML/diagram XSS. No secrets anywhere.

---

## 5. Config (`<root>/.mdplanner/config.json`) — the config tab

The config tab is a form over this file; **Save** writes it and **re-parses/re-renders
live**. Example with defaults:

```jsonc
{
  "rootPath": "/data/aproj/mdplaner",   // Mode-1 default root (launch arg overrides)
  "author": "me",
  "fileGlob": "**/*.md",
  "dateFormat": "YYYY-MM-DD",

  "marker": {
    "blockquotePrefix": "> ",
    "iconOpen": "🔴",
    "iconResolved": "⚪",
    "replyPrefix": "↳ ",
    "types": { "question": "Q", "remark": "R", "wrong": "W", "fix": "F" },
    "resolvedSuffix": ", resolved",
    "headerTemplate": "**{type} ({author}{statusSuffix}):** "
  },

  "approval": {
    "states": {
      "approved":          { "icon": "✅", "label": "APPROVED" },
      "changes-requested": { "icon": "🟠", "label": "CHANGES REQUESTED" },
      "pending":           { "icon": "⚪", "label": "PENDING" }
    },
    "template": "> {icon} **{label}** — {author} · {date}"
  },

  "render": { "hideFrontmatter": true, "syntaxHighlight": true, "mermaid": true },

  "ui": { "theme": "auto", "fontScale": 1.0, "remarkColor": "#e5484d",
          "resolvedColor": "#8a8f98" },

  "server": { "host": "0.0.0.0", "port": 8787 }
}
```

Changing `iconOpen`, `headerTemplate`, `remarkColor`, the prefix/suffix, etc. needs **no
code change** — exactly the brief. Because the file is synced, both devices read/write
identical markers.

---

## 6. Core user flows

1. **Review queue** — open the app → flat list shows every plan with a badge
   (`🟢 approved` / `🟠 changes` / `⚪ pending`) and open-remark count `●3`. Search to filter.
2. **Read a plan** — tap it → rendered with highlighting + mermaid; frontmatter hidden
   behind a toggle; existing remarks shown as **red boxes** inline, resolved ones dimmed.
3. **Ask / remark** — tap a block → toolbar **[Add question] [Add remark]** → type →
   blockquote spliced in right after that block → persisted (Mode 1 instant; Mode 2
   in-place or export).
4. **Triage** — **open-only** filter + **next ⊕** jumps between unresolved items;
   tap a remark → **Resolve** (icon flips to ⚪, box dims) or **Reply**.
5. **Verdict** — **[Approve]** / **[Request changes]** upserts the status blockquote
   under the H1; the banner + list badge update.
6. **Claude round-trip** — Claude reads the raw md, sees the visible `🔴 Q/R` blockquotes
   and the verdict line, answers inline via `↳` replies and applies prose edits, then
   you re-review.

---

## 7. Testing plan (TDD, target ≥ 80%)

- **JS units** (`node:test` + `jsdom`, dev-only, no heavy framework):
  `remarks.js` — parse open/resolved/reply blocks; **distinct from plain plan
  blockquotes**; splice-after each block type (para/heading/list-item/code-fence);
  multi-line bodies; toggle resolve; add reply; **upsert** approval (no duplicates);
  config-driven token round-trip (parse↔serialize is idempotent).
  `render.js` — frontmatter hidden/toggle; remark→red; mermaid-fence detection & lazy
  load. `config.js` — defaults merge, validation, live re-apply. `storage.js` — adapter
  selection; mocked server + mocked FS-Access/clipboard.
- **Server integration** (`pytest`): files/file/config endpoints; **path-traversal
  rejected**; atomic write leaves no partial file; listing computes status + openCount.
- **E2E** (one happy path per mode, light harness): Mode 1 — list→open→add Q→resolve→
  approve→assert file bytes. Mode 2 — pick file→render→add R→export path.

---

## 8. Phased roadmap

- **P0 — Skeleton.** `server.py` serves `web/`; mode detection; vendored libs; render one
  plan read-only with frontmatter toggle + highlighting + mermaid.
- **P1 — Remarks core.** Tap-block toolbar; add Q/R; splice; render red; persist (Mode 1).
- **P2 — Status & verdict.** Resolve toggle, replies, open-filter, jump-next, count
  badges; approval upsert + banner; flat list with badges + search.
- **P3 — Config tab.** Load/save `config.json`; live apply; all tokens/colours editable.
- **P4 — Mode 2 standalone.** Static client-side: file picker render; FS-Access write with
  clipboard/share export fallback; `localStorage` config overrides.
- **P5 — Polish.** Themes, font scale, tablet touch ergonomics, mermaid lazy-load tuning;
  push tests to ≥80%; short README.

Each phase is RED → GREEN → REFACTOR, code-reviewed before the next.

---

## 9. Open questions / future (deferred, not blocking)

- **Author identity for "us".** `author` is a single synced value (default `me`); if two
  people need distinct labels, add a per-device override (`localStorage`) later.
- **Sync-conflict resolver.** We chose minimal concurrency; a side-by-side
  `*.sync-conflict-*` merge view could come later if collisions actually bite.
- **Cross-file review queue** ("next open across *all* plans"), per-file remark export
  summary, desktop keyboard shortcuts — nice-to-haves after P5.

---

## 10. Built status & what shipped beyond this plan

P0–P5 all shipped. The remark grammar, two-mode storage, config tab, approval upsert,
and red-painting all match §2–§6 as designed. A few things were **added or reshaped**
during the build (the code is the source of truth — `CLAUDE.md` maps it):

### 10.1 Internal-scroll **pane** model (replaces window-scroll)
A *pane* is a self-contained reader unit — its own approval bar, triage bar, an
**internally-scrolling** article, and its own notes rail. `app.js` owns `state.panes[]`
+ `state.active`; `ui/reader.js` is pane-scoped (`paint(ctx)` re-renders, `mountPane`
wires events once). The article scrolls internally (not the window), which is what makes
the split view's independent scrolling possible. Scroll math is relative to the reader's
`getBoundingClientRect()`, never `window.scrollY`.

### 10.2 Desktop navigation suite (wide screens; auto-hidden ≤1080px)
- **📑 Outline** — a VS-Code-style TOC tree built from the rendered headings, with
  **scroll-spy** active-section highlighting and a red **open-note badge** per section.
  Only the active, non-split pane paints into the shared `#outline`. Toggle persisted in
  `localStorage` (`mdp.outline`).
- **Notes rail** (right of each pane) — every question/remark with snippet + status,
  click-to-fly-and-flash; honours the **Open only** filter.
- **⧉ Split / compare** — two side-by-side panes, each opens its own file (📂 per pane)
  and scrolls independently; outline hidden, rails kept. **✕** collapses back to one pane.
- **⟳ Reload** — re-reads config + file list + each open plan from storage and re-renders
  on demand (picks up config changes and externally/synced edits).

### 10.3 Inline annotate bar (replaces the floating toolbar)
Tapping a block inserts the typed-action bar *in-flow, right after that block*
(`.block-actions`, `insertAdjacentElement('afterend', …)`), so it's always anchored to the
tapped md box and can never float over the sidebar/top bar. The buttons are generated from
`marker.types` (see §10.7), so the bar reads **＋ Question / ＋ Remark / ＋ Wrong / ＋ Fix / ✕**.
Remark/approval boxes are skipped (they carry their own action row).

### 10.4 Per-note actions: Resolve · Reply · **Delete**
Each remark box now also has a **Delete** action with an inline confirm
(`removeRemark(text, remark)` removes the whole block — header, body, replies — and
collapses the surrounding blank lines, leaving no trace). Pure text op, mirrored intent
in tests.

### 10.5 File-listing hygiene
`server.py` prunes dependency/build dirs from the recursive `*.md` scan
(`IGNORE_DIRS`: `node_modules`, `__pycache__`, `site-packages`, `venv`, `env`, `dist`,
`build`, `target`, `vendor`) in addition to dotfolders.

### 10.6 Config bar docking
The config tab's **Save & apply** row docks at the end of the scrolling form (not sticky),
so it no longer overlaps fields.

### 10.7 Four typed notes, each its own colour
The original two note types (`question`, `remark`) grew to **four**: `question` (Q, blue),
`remark` (R, red), `wrong` (W, amber), `fix` (F, green). Because the grammar is config-
driven, `buildRemark`/`parseRemarks`/`mdmarks.py` needed **no logic change** — only the
`marker.types` map gained `wrong`/`fix`. Colour is a render concern: a new
`ui.typeColors` map drives `--type-<key>` CSS vars (set in `app.js`), and each painted box
(and rail item, and annotate button) carries a `type-<key>` class that rebinds the local
`--remark-color` to that hue. Resolved still greys out regardless of type; **Delete** keeps
a fixed danger red (`--danger-color`) so a destructive action never blends into a green
"fix" box. `validateConfig` requires the four labels, enforces label uniqueness (the
parser maps label→type), and checks each `typeColors` entry is a hex colour. The settings
tab exposes a label + colour row per type.

### 10.8 Standalone single-file bundle (Mode 2 on Android)
Mode 2 originally meant "open `web/index.html` from the filesystem", but Android's Files
app hands the browser a `content://` URI — one file's bytes with **no sibling directory** —
so every relative `css/`, `js/`, `vendor/` fetch fails and the page renders dead. Fix:
`build-standalone.py` inlines **everything** (styles, every script, both hljs themes, and
the ~2.6 MB mermaid lib) into one `web/index.standalone.html` with **zero relative
fetches**, so it renders however it's opened (`content://`, `file://`, `http://`). It is a
*build step*, **not** a second copy — `web/` stays the only hand-edited source and the
bundle is **git-ignored**; `./run.sh` rebuilds it on every start (`python3
build-standalone.py` to do it by hand). `app.js` feature-detects the two runtimes on
**element presence** — a live `<link id="hljs-theme">` + `<script src>` tags in the served
build vs. inert `<script type="text/plain" id="…-src">` seeds in the bundle (mermaid
lazy-loaded from a Blob URL) — so the **same source** serves both. The bundler matches
index.html's hljs/styles `<link>`s, the vendor-libs comment, and `<script src>` tags
**verbatim** and aborts loudly if any move: restructure the head/scripts and you must
revisit `build-standalone.py`.

### 10.9 Launcher CLI + systemd service (`run.sh`)
`run.sh` grew past "rebuild the bundle, then exec the server" into a small front door:
- **`--help`** prints both run modes (server vs standalone) and every flag.
- **`--open FILE`** / **`--open-dir DIR`** / **`--open-any`** drive on-demand plans — see §10.11.
- **`--service`** installs, enables, and starts a **systemd** unit
  `/etc/systemd/system/mdplanner.service`, then prints status + the LAN URL. The chosen
  `ROOT` and any `--host`/`--port`/`--open-dir`/`--open-any` are **baked into `ExecStart`**, and
  an `ExecStartPre=-…/build-standalone.py` refreshes the Mode-2 bundle on every start.
- It runs **as the invoking user, not root** (honours `$SUDO_USER`); only the install steps
  use `sudo`. `NoNewPrivileges` + kernel/cgroup protections are always on; the **filesystem
  sandbox depends on the on-demand mode** (§10.11): the default (unrestricted) unit relaxes
  `ProtectSystem`/`ProtectHome` and warns, while `--open-dir` re-hardens with `ProtectSystem=
  strict` and `ReadWritePaths` = root + app dir + the named dirs.
- Degrades gracefully where `systemctl` is absent (prints the unit + manual steps).

Arg parsing pulls `--help`/`--service` out first, then the same ROOT-detection as before
runs on the remainder, so flags compose in any order. The dispatch block is guarded by
`[[ "${BASH_SOURCE[0]}" == "${0}" ]]` so tests can `source run.sh` and call `gen_unit`/
`usage` without launching anything; the generated unit is validated with
`systemd-analyze verify`.

### 10.10 Per-mode roots (server root vs standalone root)
Each run mode now has its **own** markdown root, set independently in the config tab:
- **`rootPath` — Server root (Mode 1).** The directory `server.py` serves; in practice
  still set at launch (CLI arg / `run.sh`), with the config field as the saved default. It
  now **only scopes the left-menu listing** — on-demand plans (§10.11) open from anywhere,
  so the root no longer limits what you can review, just what the file list shows.
- **`standaloneRoot` — Standalone root (Mode 2).** Default **`../../plans`**, resolved as
  a URL **relative to the running `index.standalone.html`**. When the bundle is *served
  over http(s)* (any dumb static host — `python3 -m http.server`, nginx, a CDN), the
  `ClientStorage` adapter now implements `list()` + `read()`: it discovers `*.md` under
  that root (a generated `index.json` manifest, else a parsed autoindex listing) and
  computes the same `{status, openCount}` badges the server derives — here client-side via
  the shared `remarks.js` parser. So standalone over http gets the full searchable list,
  not just the picker.

The hard limit is the browser: a typed path can only be fetched as a sibling folder over
**http(s)**. From a `file://` page Chrome blocks relative fetches, and Android's Files app
hands over a `content://` URI with no sibling directory at all — so `ClientStorage` gates
listing on `location.protocol` being http(s) (`capabilities.list`), and everywhere else
falls back cleanly to the **file picker** (and export-on-write, since fetched plans carry
no write handle). The two roots never collide: the server root lives in the server's
config file, the standalone root in the browser's `localStorage`.

### 10.11 On-demand external plans (`--open`, server mode)
Render and annotate a plan that lives **outside the root** without moving or syncing it —
for fast one-off reviews while the server runs as a systemd service.

- **Trigger.** `./run.sh --open /abs/path/plan.md` runs `server.py` in *client mode*: it
  `POST`s the path to the already-running server's `/api/adhoc`, then prints/opens
  `http://127.0.0.1:<port>/?adhoc=<id>`. `app.js` honours `?adhoc=<id>` on boot and opens it.
- **Registry.** The server keeps an in-memory `{id → realpath}` map (`id = sha1(realpath)[:12]`,
  so re-opening the same file is idempotent). Pinned plans show in a separate **On-demand**
  group in the file list with the usual verdict + open-count badges (`GET /api/adhoc`).
- **Access by id, never path.** Read/write use `/api/file?adhoc=<id>` (an `adhoc:<id>` path
  sentinel in `storage.js`); annotations save **in place** into the external file via the
  same atomic temp+replace. The UI is otherwise path-agnostic.

**Security model (the points that matter):**
1. **Pinning is loopback-only** — `_is_loopback()` gates `POST/DELETE /api/adhoc`, so only a
   process *on the host* can introduce a new external path. LAN clients can view/annotate
   ids the host already pinned (same trust as the root) but can never name a new file.
2. **Unrestricted by default; bounded opt-in.** `server.open_any` (the default — see
   `wants_open_any`) lets a host process pin *any* path; the directory check is skipped.
   Naming dirs with **`--open-dir`** (*repeatable*; `$MDPLANNER_OPEN_DIR` is `os.pathsep`-
   separated) switches to bounded mode, where every pin/read/write re-validates that
   `realpath(target)` is inside one of `open_dirs` (symlink-safe via `mdmarks.is_within`).
   `--open-any` / `--open-dir /` force unrestricted. Either way the target must end in
   `.md`/`.markdown`; traversal, symlink escape, null bytes and non-markdown are rejected at
   pin time *and* on every access (TOCTOU-safe), and **pinning stays loopback-only** (the
   real guard — invariant 1). The **root only scopes the left-menu listing**, never on-demand.
3. **No path disclosure.** Responses carry only a `proj/plan.md`-style label, not the realpath.
4. **systemd.** The default (unrestricted) unit **relaxes hardening** (`ProtectSystem=off`,
   `ProtectHome=off`, `PrivateTmp=false`) so the service can write any pinned path, and
   `run.sh --service` prints a warning. Passing `--open-dir` re-hardens: `ProtectSystem=strict`
   with `ReadWritePaths` = root + app dir + the named dirs. (`build_server(open_any=False,
   open_dir=[])` still yields a fully disabled feature for embedders/tests.)

> Anything in §3–§6 that still says "floating toolbar", window-scroll, two note types, a
> single remark colour, "open `index.html` raw" for Mode 2, a bare `run.sh` with no
> `--help`/`--service`, a single shared root, or omits the
> outline/rail/split/standalone-bundle is superseded by this section.
