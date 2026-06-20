# CLAUDE.md — orientation for working on MD Planner

Read this first. It's the fast map of the codebase so a refactor session can start
editing in minutes instead of re-deriving the architecture. When this file and the
code disagree, **the code wins — fix this file.** (`PLAN.md` is the original design
doc; `README.md` is the user-facing guide.)

---

## What it is

A dependency-light reviewer for the markdown **plan files** Claude Code produces.
You read a plan, drop typed notes — **question / remark / wrong / fix** — straight into
the `.md` as visible, **per-type colour-coded** blockquotes, resolve / reply / delete
them, and stamp an **approve / request-changes** verdict — all saved as plain markdown
*inside the file*, so Claude reads the feedback next round.

Two run modes, **one shared `web/` UI**, differing only in a storage adapter:

| Mode | Where | Storage adapter | Writes |
|------|-------|-----------------|--------|
| **1 — Server** | `python3 server.py <root>` on the Linux host | `ServerStorage` (REST) | in place, atomically |
| **2 — Standalone** | `web/index.standalone.html` opened in a browser | `ClientStorage` (file picker) | FS-Access in place, else export a patched copy |

No framework, no bundler, **nothing to compile to run**. The one generated artifact is
`web/index.standalone.html` — every asset inlined into a single file for Android Mode 2
(a `content://` URI has no sibling `css/`/`js/`, so multi-file `index.html` can't load
there). It's built by `build-standalone.py`, rebuilt automatically by `./run.sh`, and
git-ignored — `web/` is the single source of truth. Vendored `markdown-it` +
`highlight.js` + `mermaid` under `web/vendor/` (offline). Server is Python **stdlib only**.

---

## Run & test

```bash
./run.sh                        # = python3 server.py <parent-of-app/>   → http://127.0.0.1:8787/
./run.sh --help                 # both run modes + all flags
./run.sh [ROOT] [...] --service # install+enable+start systemd unit /etc/systemd/system/mdplanner.service
python3 server.py /some/root    # serve a specific markdown root

npm install                     # dev only: installs markdown-it + highlight.js
npm test                        # 50 JS unit tests (node --test, no jsdom needed for these)
python3 -m pytest tests/py/     # 37 server / path-safety / adhoc / counter tests
node --check web/js/<file>.js   # quick parse check after editing a module
```

After editing `web/**`, the running page must be **reloaded** to pick it up — use the
top-bar **⟳ Reload** (re-reads config + files + re-renders) or just refresh the browser.
For **Mode 2**, also rebuild the inlined bundle (`python3 build-standalone.py`, or just
`./run.sh`) — `index.standalone.html` is generated and won't see source edits otherwise.

---

## Module map (each file's public surface)

Every `web/js` module is a **UMD IIFE**: it attaches to `window.MDP.*` in the browser
**and** `module.exports` for `node --test`. Load order is fixed in `index.html`
(deps before dependents): config → remarks → render → storage → ui/dom → ui/filelist
→ ui/reader → ui/configtab → app.

```
web/js/
  config.js     MDP.config   → { DEFAULT_CONFIG, mergeConfig, deepMerge, clone,
                                  validateConfig, renderHeader, isPlainObject }
  remarks.js    MDP.remarks  → parse / build / splice / mutate, PURE TEXT IN→OUT:
                                parseRemarks, countOpen, buildRemark, addRemarkAfterLine,
                                toggleResolved, addReply, removeRemark, findApproval,
                                upsertApproval
  render.js     MDP.render   → createRenderer(MarkdownIt, hljs, cfg).render(text)
                                → { html, hasMermaid }.  Stamps data-line-start/-end.
  storage.js    MDP.storage  → detectStorage() → ServerStorage | ClientStorage
                                (.mode, .capabilities, list/read/write/open*/getConfig/putConfig).
                                ServerStorage.list merges /api/files + /api/adhoc; read/write
                                route an `adhoc:<id>` path sentinel to /api/file?adhoc=<id>.
                                ClientStorage also lists/reads the standalone root
                                (cfg.standaloneRoot, default ../../plans) when served over
                                http(s) — derives badges via remarks.js (loads after it).
  ui/dom.js     MDP.ui.dom   → h(tag, attrs, ...children), clear(el)   ← the only DOM helper
  ui/filelist.js MDP.ui.filelist → render(listEl, {files, cfg, query, currentPath,
                                  hidden, showHidden, onOpen, onToggleHide, onToggleShowHidden}).
                                  Per-row ⊘ hide button filters a plan out of the list (view-only,
                                  never deletes); hidden set is an app.js localStorage pref
                                  (`mdp.hidden`/`mdp.showHidden`) keyed by path (or `ext:<label>`
                                  for adhoc plans). A footer reveals/unhides (↺).
  ui/reader.js  MDP.ui.reader → paint(pane), mountPane(pane, app)   ← the big one (see below)
  ui/configtab.js MDP.ui.configtab → render(formEl, {cfg, onCancel, onSave})
  app.js        MDP.app      → boot, mode detection, panes, persistence orchestration
```

Server side mirrors the JS engine:

```
server.py     stdlib http.server: GET / + /static, /api/files, /api/file, /api/config,
              + on-demand external plans: POST/DELETE /api/adhoc (loopback-only pin/unpin),
              GET /api/adhoc (list), and /api/file?adhoc=<id> (read/write by opaque id).
              `--open FILE` runs in client mode (POSTs to the running server). On-demand is
              UNRESTRICTED by default; repeatable --open-dir restricts where adhoc plans live.
              Path-safety (no .., no symlink escape, no abs, null-byte reject), *.md only,
              atomic temp+os.replace writes, size-capped bodies, nosniff/SAMEORIGIN headers.
              IGNORE_DIRS prunes node_modules/venv/dist/… from the file listing.
mdmarks.py    Python port of remarks.js parse + counter. MUST stay byte-compatible.
build-standalone.py  inlines web/ (styles + every script + hljs themes + mermaid) into
              web/index.standalone.html — the Mode-2 single-file bundle. Run by ./run.sh,
              git-ignored. Edit web/, never the bundle. See gotcha below + PLAN.md §10.8.
```

---

## The two architectural ideas to hold in your head

### 1. Panes with internal scroll (recent refactor — touch carefully)

A **pane** is a self-contained reader unit: its own approval bar + triage bar + an
**internally-scrolling** `<article class="reader">` + its own notes rail. `app.js`
owns `state.panes[]` and `state.active`.

- **Single mode** = 1 pane, plus the left **Outline** (shared `#outline` nav, only the
  active pane paints into it) and the pane's right **Notes rail**.
- **Split / compare** = 2 panes side-by-side (`.panes.split`), each opens its own file
  and **scrolls independently**; the outline is hidden, rails stay.

The article scrolls *internally* (`.reader{ flex:1; overflow-y:auto }`), **not** the
window — this is what makes split-pane independent scrolling work. Consequences any
edit must respect: scroll-spy listens on `reader`'s scroll (not window); the inline
annotate bar is in-flow (not `position:fixed`); offsets are computed from
`reader.getBoundingClientRect()`, never `window.scrollY`.

`reader.js` is **pane-scoped**: `paint(ctx)` is pure (re)painting, `mountPane(ctx, app)`
wires this pane's events exactly once. Re-render = call `paint`; never re-wire.

### 2. Source-line mapping is the anchor for everything

`render.js` stamps each top-level block with `data-line-start` / `data-line-end`
(full-file line numbers, **offset by the frontmatter line count**). That mapping is the
single source of truth tying rendered DOM ↔ raw markdown:

- **Tap-to-annotate**: tapped block's `data-line-end - 1` → `addRemarkAfterLine`.
- **Remark decoration**: a `blockquote[data-line-start]` whose number matches a parsed
  remark's `lineStart` gets `.remark .type-<key>` (+ `.resolved`) and its action row.
  Each `.type-<key>` rebinds the local `--remark-color` (CSS var) to that note's hue.
- **Outline open-badges / scroll-spy**: heading `data-line-start` vs remark `lineStart`.

If you change the line-map logic, re-check all three.

---

## Conventions (follow these — they're enforced by review/tests)

- **Pure text remark ops.** Everything in `remarks.js` is `text → newText`, no DOM, no
  storage. This is why the same logic is unit-tested and mirrored in `mdmarks.py`.
- **JS ↔ Python parity.** Any change to the remark/approval grammar in `remarks.js`
  must land in `mdmarks.py` too, with matching tests on both sides. The grammar itself
  is **config-driven** (`cfg.marker.*`) — prefer changing config tokens over hardcoding.
- **Immutability.** Build new objects/strings; never mutate inputs. (`deepMerge`/`clone`
  in config.js model this.)
- **DOM via `h()` + `clear()` only.** No `innerHTML` assembly except `reader.innerHTML =
  result.html` (trusted, markdown-it `html:false`). No other templating.
- **Destructive = confirm first.** Delete uses an inline confirm row
  (`showDefault()` ⇄ `showConfirm()` in `buildRemarkActions`).
- **Many small files.** Keep modules focused; extract before a file gets large.
- **Lean deps.** Runtime deps are vendored; the only npm devDeps are markdown-it +
  highlight.js. If you pull `jsdom` for a headless DOM smoke test, install it
  `--no-save` and restore with `rm -rf node_modules package-lock.json && npm install`
  afterwards so the dep set stays exactly those two.

---

## Recipes

- **Add a remark text op** → write it pure in `remarks.js`, export it, add JS unit tests,
  **mirror in `mdmarks.py` + its pytest**, then add a pane `handler` in `app.js`
  `makeHandlers()` that calls `persist(pane, MDP.remarks.<op>(...))`, and surface it in
  `reader.js` (`buildRemarkActions` for per-note, `showBlockActions` for add-here).
- **Add a note type** (like `wrong`/`fix`) → it's mostly config, not grammar: add the label
  to `marker.types` (config.js **and** mdmarks.py) and a colour to `ui.typeColors`; the
  pure `buildRemark`/`parseRemarks` pick it up for free (they iterate `marker.types`). Then:
  a `--type-<key>` var + a `.remark.type-<key>`/`.rail-item.type-<key>`/`.block-actions .btn.type-<key>`
  rule in `styles.css`, an `app.js` `setProperty('--type-<key>', …)`, a `reader.js`
  `ANNOT_TYPES` entry (the annotate button), and form rows in `configtab.js`. Keep the
  type **labels unique** — the parser maps label→type (validated in `validateConfig`).
- **Add a top-bar control** → button in `index.html` topbar (give it an id), grab it in
  `app.js` `grab()`, wire in `wireControls()`. Persist UI prefs to `localStorage`
  (`mdp.*`) like `toggleOutline` does.
- **Add a config field** → `DEFAULT_CONFIG` in `config.js` (+ `validateConfig`), the
  Python default in `mdmarks.py`, a form row in `ui/configtab.js`. It round-trips through
  `<root>/.mdplanner/config.json` (server) or `localStorage` (client).
- **Change persistence** → only `storage.js` adapters + `server.py`. Nothing else should
  know whether it's REST or a file picker.

## Gotchas

- Only the **active, non-split** pane owns the shared `#outline`; `buildOutline` early-
  returns and hides the panel for any other pane — keep that guard.
- There's **one** global `document` mousedown listener (dismisses the annotate bar),
  guarded by `docWired`; don't add per-pane document listeners.
- `server.py` root precedence: CLI arg → else `os.path.dirname(APP_DIR)`. Host/port:
  CLI flag → `MDPLANNER_*` env → `config.server.*`. The config `rootPath` (the **Server
  root** field) is the saved default but the **launch arg / default is what actually
  scans** (config lives inside the root). The root now **only scopes the left-menu
  listing** (`/api/files` + relative `/api/file`); on-demand (`--open`) bypasses it
  entirely, so a fresh idea like "make the Server-root field re-scope the live listing"
  is unbuilt-by-design (it'd let any LAN client redirect the server's file root).
- **Per-mode roots:** `rootPath` = server root (Mode 1), `standaloneRoot` = standalone
  root (Mode 2, default `../../plans`). `ClientStorage.list()/read()` resolve
  `standaloneRoot` **relative to `index.standalone.html`** and fetch it — but only when
  served over **http(s)** (`capabilities.list` gates on `location.protocol`). On
  `file://`/`content://` relative fetches are blocked, so it falls back to the picker.
  Don't assume `capabilities.list` ⇒ server; standalone-over-http has it too.
- Mermaid is **lazy-loaded** only when a `mermaid` fence is present; `securityLevel:
  'strict'`. markdown-it runs `html:false` — both are XSS guards, don't loosen them.
- The notes-rail status dot is **CSS-drawn** (`.rail-dot`), not the `🔴`/`⚪` emoji — an
  emoji glyph paints its own colour and can't be type-tinted. It fills from the per-type
  `--remark-color` (rebound on `.rail-item.type-<key>`), so it matches the left bar and
  the add-note buttons; resolved → hollow grey ring. Don't swap it back to an emoji.
- **Standalone bundle is generated** — edit `web/` sources, then rebuild
  (`python3 build-standalone.py`, or just `./run.sh`); `index.standalone.html` is
  git-ignored and won't see source edits otherwise. `app.js` feature-detects the two
  runtimes on element *presence* (live `<link id="hljs-theme">` + `<script src>` in the
  served build vs. inert `<script type="text/plain" id="…-src">` seeds in the bundle,
  mermaid via a Blob URL), so **one source serves both**. `build-standalone.py` matches
  the hljs/styles `<link>`s, the vendor-libs comment, and `<script src>` tags **verbatim**
  and aborts if they move — restructure `index.html`'s head/scripts and you must revisit it.
- `run.sh --service` **bakes** the resolved `ROOT` + `--host`/`--port` into the unit's
  `ExecStart` at install time — change them and you must re-run `--service` (or edit
  `/etc/systemd/system/mdplanner.service` + `systemctl daemon-reload`). It installs as
  `$SUDO_USER` (not root); its dispatch is guarded by `[[ BASH_SOURCE == $0 ]]` so the
  `gen_unit`/`usage`/`service_ctl` helpers stay sourceable for tests — keep that guard if
  you refactor it. `--status`/`--restart`/`--stop` proxy `systemctl <action> mdplanner`
  via `service_ctl` (dispatched before the python3/ROOT checks, since they need neither);
  `status` is read-only, `restart`/`stop` escalate to `sudo` when not root.
- No auth by design (trusted LAN). Don't add network-exposed write paths without the
  path-safety guards in `server.py`.
- **On-demand (adhoc) plans read/write OUTSIDE the root** — the one place that escapes
  root-relative path-safety. It's safe only because of three invariants; preserve all
  three if you touch it: (1) **pinning is loopback-only** (`_is_loopback` gates POST/DELETE
  `/api/adhoc`) so LAN clients can't introduce a path; (2) clients address files by **opaque
  id**, never a path — `/api/file?adhoc=<id>`; (3) every pin/read/write **re-validates**
  `.md`/`.markdown` and — *when bounded* — that `realpath(target)` is inside `server.open_dirs`
  (TOCTOU-safe; `_validate_adhoc`). **Unrestricted is the DEFAULT** (`server.open_any`, via
  `wants_open_any`): no flag ⇒ any host-pinned path opens. `--open-dir` (repeatable;
  `$MDPLANNER_OPEN_DIR` `os.pathsep`-split) switches to bounded; `--open-any`/`--open-dir /`
  force unrestricted. Registry is in-memory (`server.adhoc`, cleared on restart). The default
  `run.sh --service` unit is **relaxed** (`ProtectSystem/Home=off`, `PrivateTmp=false`) + warns;
  `--open-dir` re-hardens (`ProtectSystem=strict`, `ReadWritePaths`=root+app+dirs). Invariant (1)
  loopback-pin is the load-bearing guard; keep it. The **root only scopes the left-menu list**.
  Responses expose a `proj/plan.md` label, never the realpath. `app.js` auto-opens `?adhoc=<id>`;
  `storage.js` routes the `adhoc:<id>` path sentinel. Mirror nothing in `mdmarks.py` (no grammar
  change — it just reuses `is_within`).
