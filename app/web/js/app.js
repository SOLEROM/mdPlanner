/* app.js — bootstrap, mode detection, view wiring, persistence orchestration.
   Owns the small app state and connects storage <-> render <-> reader <-> config.

   A "pane" is a self-contained reader unit (its own approval/triage bar, its own
   scrolling article, its own notes rail). Normally there's one pane; split view
   shows two side-by-side panes that open independent plans and scroll separately.
   See PLAN.md §3.1, §6. */
(function (root) {
  'use strict';
  const MDP = root.MDP;
  const D = MDP.ui.dom;
  const h = D.h;

  const state = {
    storage: null,
    cfg: null,
    renderer: null,
    files: [],
    query: '',
    ui: { outline: true },
    panes: [],
    active: null,
    split: false,
    paneSeq: 0,
    _pendingPane: null
  };

  let app = null;   // shared handle passed to the reader module

  const els = {};
  function grab() {
    ['menuBtn', 'splitBtn', 'outlineBtn', 'modeBadge', 'fontDown', 'fontUp', 'refreshBtn', 'themeBtn',
     'configBtn', 'sidebar', 'search', 'openFileBtn', 'fileInput', 'fileList', 'outline', 'readerView',
     'panes', 'configView', 'configForm', 'toast'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  // ---- toast ----
  let toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.className = 'toast' + (isError ? ' error' : '');
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, isError ? 5000 : 2200);
  }

  // ---- config-driven UI ----
  function effectiveTheme(cfg) {
    if (cfg.ui.theme !== 'auto') return cfg.ui.theme;
    return (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function applyConfigToUI(cfg) {
    const r = document.documentElement;
    r.setAttribute('data-theme', cfg.ui.theme);
    r.style.setProperty('--font-scale', String(cfg.ui.fontScale));
    r.style.setProperty('--remark-color', cfg.ui.remarkColor);
    r.style.setProperty('--resolved-color', cfg.ui.resolvedColor);
    const typeColors = cfg.ui.typeColors || {};
    ['question', 'remark', 'wrong', 'fix'].forEach(function (k) {
      if (typeColors[k]) r.style.setProperty('--type-' + k, typeColors[k]);
    });
    const dark = effectiveTheme(cfg) === 'dark';
    const link = document.getElementById('hljs-theme');
    if (link && link.tagName === 'LINK') {
      // Server / multi-file mode: swap the stylesheet href.
      link.href = dark ? 'vendor/highlight-dark.css' : 'vendor/highlight-light.css';
    } else if (link) {
      // Standalone bundle: both highlight themes are inlined as inert text; the
      // <style id="hljs-theme"> is live and we write the active theme into it.
      const src = document.getElementById(dark ? 'hljs-dark-src' : 'hljs-light-src');
      if (src) link.textContent = src.textContent;
    }
  }

  function buildRenderer(cfg) {
    return MDP.render.createRenderer(root.markdownit, root.hljs, cfg);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today(cfg) {
    const d = new Date();
    return (cfg.dateFormat || 'YYYY-MM-DD')
      .replace('YYYY', d.getFullYear())
      .replace('MM', pad(d.getMonth() + 1))
      .replace('DD', pad(d.getDate()));
  }

  // ---- mermaid (lazy) ----
  let mermaidPromise = null;
  function loadMermaid() {
    if (root.mermaid) return Promise.resolve(root.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      // Standalone bundle inlines the 2.6 MB mermaid source as inert text; turn it
      // into a Blob URL so it still loads lazily (only on first diagram) and works
      // from a content:// / file:// origin. Falls back to the relative vendor file.
      const inline = document.getElementById('mermaid-src');
      s.src = inline
        ? URL.createObjectURL(new Blob([inline.textContent], { type: 'application/javascript' }))
        : 'vendor/mermaid.min.js';
      s.onload = function () { resolve(root.mermaid); };
      s.onerror = function () { reject(new Error('mermaid failed to load')); };
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }
  async function runMermaid(readerEl) {
    const nodes = readerEl.querySelectorAll('pre.mermaid');
    if (!nodes.length || !state.cfg.render.mermaid) return;
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
        theme: effectiveTheme(state.cfg) === 'dark' ? 'dark' : 'default' });
      await mermaid.run({ nodes: Array.prototype.slice.call(nodes) });
    } catch (e) { console.warn('mermaid render skipped:', e); }
  }

  // ---- panes ----
  function makeHandlers(pane) {
    return {
      addRemark: function (lastLineIdx, type, body) {
        persist(pane, MDP.remarks.addRemarkAfterLine(pane.text, lastLineIdx, state.cfg, { type: type, body: body }));
      },
      toggleResolve: function (remark) {
        persist(pane, MDP.remarks.toggleResolved(pane.text, remark, state.cfg));
      },
      reply: function (remark, body) {
        // Replies via the UI are the reviewer's; Claude replies by editing the raw .md.
        persist(pane, MDP.remarks.addReply(pane.text, remark, state.cfg.author, body, state.cfg));
      },
      deleteRemark: function (remark) {
        persist(pane, MDP.remarks.removeRemark(pane.text, remark));
      },
      verdict: function (stateKey) {
        persist(pane, MDP.remarks.upsertApproval(pane.text, stateKey, state.cfg, state.cfg.author, today(state.cfg)));
      }
    };
  }

  function createPane() {
    const id = 'pane-' + (state.paneSeq++);
    const reader = h('article', { class: 'reader markdown-body', 'aria-live': 'polite' });
    const approvalBar = h('div', { class: 'approval-bar', hidden: true });
    const openOnly = h('input', { type: 'checkbox' });
    const openCount = h('span', { class: 'open-count' });
    const jumpNext = h('button', { class: 'btn small' }, 'Next open ⊕');
    const approveBtn = h('button', { class: 'btn small good' }, '✅ Approve');
    const changesBtn = h('button', { class: 'btn small warn' }, '🟠 Request changes');
    const paneFile = h('span', { class: 'pane-file', title: 'File open in this pane' }, '—');
    const paneOpen = h('button', { class: 'btn small pane-open', title: 'Open a file in this pane' }, '📂');
    const closeBtn = h('button', { class: 'icon-btn pane-close', title: 'Close this pane' }, '✕');
    const triageBar = h('div', { class: 'triage-bar', hidden: true },
      h('label', { class: 'toggle' }, openOnly, ' Open only'),
      openCount, jumpNext,
      h('div', { class: 'spacer' }),
      paneFile, paneOpen, approveBtn, changesBtn, closeBtn
    );
    const remarkRail = h('aside', { class: 'remark-rail', hidden: true, 'aria-label': 'Notes' });
    const readerWrap = h('div', { class: 'reader-wrap' }, reader, remarkRail);
    const paneEl = h('section', { class: 'pane', 'data-id': id }, approvalBar, triageBar, readerWrap);

    const pane = {
      id: id, el: paneEl, doc: null, text: '', result: null,
      cfg: state.cfg, outline: false, _spy: [],
      els: {
        reader: reader, approvalBar: approvalBar, triageBar: triageBar,
        openOnly: openOnly, openCount: openCount, jumpNext: jumpNext,
        remarkRail: remarkRail, paneFile: paneFile, outline: els.outline
      },
      handlers: null
    };
    pane.handlers = makeHandlers(pane);

    approveBtn.addEventListener('click', function () { focus(pane); pane.handlers.verdict('approved'); });
    changesBtn.addEventListener('click', function () { focus(pane); pane.handlers.verdict('changes-requested'); });
    paneOpen.addEventListener('click', function () { focus(pane); openInto(pane); });
    closeBtn.addEventListener('click', function () { closePane(pane); });
    paneEl.addEventListener('mousedown', function () { focus(pane); });

    MDP.ui.reader.mountPane(pane, app);
    els.panes.appendChild(paneEl);
    state.panes.push(pane);
    return pane;
  }

  function closePane(pane) {
    if (state.panes.length <= 1) return;
    const idx = state.panes.indexOf(pane);
    if (idx === -1) return;
    state.panes.splice(idx, 1);
    pane.el.remove();
    if (state.active === pane) state.active = state.panes[0];
    if (state.panes.length < 2) setSplit(false);
    else focus(state.active);
  }

  function focus(pane) {
    if (!pane) return;
    const changed = state.active !== pane;
    state.active = pane;
    state.panes.forEach(function (p) { p.el.classList.toggle('focused', p === pane); });
    if (changed && state.storage && state.storage.capabilities && state.storage.capabilities.list) {
      renderFileList();
    }
  }

  function renderPane(pane) {
    pane.cfg = state.cfg;
    pane.outline = (!state.split && pane === state.active && state.ui.outline);
    if (!pane.doc) {
      D.clear(pane.els.reader);
      pane.els.reader.appendChild(h('div', { class: 'empty-state' },
        h('p', {}, state.split ? 'Open a plan in this pane.' : 'Select a plan from the list to start reviewing.')));
      pane.els.approvalBar.hidden = true;
      pane.els.triageBar.hidden = true;
      pane.els.remarkRail.hidden = true;
      pane.els.paneFile.textContent = '—';
      if (pane.outline) els.outline.hidden = true;
      return;
    }
    pane.result = state.renderer.render(pane.text);
    MDP.ui.reader.paint(pane);
    if (pane.result.hasMermaid) runMermaid(pane.els.reader);
  }

  function setPaneDoc(pane, doc) {
    pane.doc = doc;
    pane.text = doc.text;
    pane.els.paneFile.textContent = doc.name || doc.path || 'untitled';
    pane.els.paneFile.title = doc.title || doc.path || 'File open in this pane';
    showView('reader');
    renderPane(pane);
    if (state.storage.capabilities.list) renderFileList();
  }

  // ---- persistence ----
  async function persist(pane, newText) {
    try {
      const res = await state.storage.write(pane.doc, newText);
      pane.text = newText;
      if (res && res.exported) toast('Exported a patched copy (no in-place write here).');
      else toast('Saved.');
      renderPane(pane);
      if (state.storage.capabilities.list) refreshBadges();
    } catch (e) {
      toast('Save failed: ' + e.message, true);
    }
  }

  async function refreshBadges() {
    try {
      state.files = await state.storage.list();
      renderFileList();
    } catch (e) { /* non-fatal */ }
  }

  // ---- split / compare view ----
  function setSplit(on) {
    if (on === state.split) return;
    state.split = on;
    els.splitBtn.setAttribute('aria-pressed', String(on));
    els.splitBtn.classList.toggle('active', on);
    els.panes.classList.toggle('split', on);
    if (on) {
      if (state.panes.length < 2) createPane();
    } else {
      while (state.panes.length > 1) { state.panes.pop().el.remove(); }
      if (state.panes.indexOf(state.active) === -1) state.active = state.panes[0];
    }
    focus(state.active || state.panes[0]);
    state.panes.forEach(renderPane);
  }

  // ---- file list / opening ----
  function standaloneHint(msg) {
    els.fileList.appendChild(D.h('li',
      { class: 'file-item', style: 'color:var(--fg-soft);cursor:default' }, msg));
  }
  function renderFileList() {
    MDP.ui.filelist.render(els.fileList, {
      files: state.files, cfg: state.cfg, query: state.query,
      currentPath: state.active && state.active.doc && state.active.doc.path,
      onOpen: openByPath
    });
  }
  async function openByPath(path) {
    const pane = state.active || state.panes[0];
    try {
      const doc = await state.storage.read(path);
      setPaneDoc(pane, doc);
      if (root.innerWidth <= 720 && !state.split) els.sidebar.classList.add('collapsed');
    } catch (e) { toast('Could not open: ' + e.message, true); }
  }

  // `./run.sh --open FILE` pins an external plan and opens /?adhoc=<id>; honour it.
  async function maybeOpenAdhoc() {
    try {
      const params = new root.URLSearchParams(root.location.search || '');
      const id = params.get('adhoc');
      if (id) await openByPath('adhoc:' + id);
    } catch (e) { /* malformed query ⇒ ignore */ }
  }

  async function openInto(pane) {
    if (state.storage.mode === 'server') {
      els.sidebar.classList.remove('collapsed');
      toast('Pick a plan from the list — it opens in this pane.');
      return;
    }
    if (state.storage.open && typeof root.showOpenFilePicker === 'function') {
      try { setPaneDoc(pane, await state.storage.open()); }
      catch (e) { if (e && e.name !== 'AbortError') toast('Open failed: ' + e.message, true); }
    } else {
      state._pendingPane = pane;
      els.fileInput.click();
    }
  }

  function showView(which) {
    els.readerView.hidden = which !== 'reader';
    els.configView.hidden = which !== 'config';
    els.outline.hidden = !(which === 'reader' && !state.split && state.ui.outline &&
                           els.outline.childElementCount > 0);
  }

  // ---- reload everything on demand ----
  async function reloadApp() {
    els.refreshBtn.classList.add('spin');
    try {
      state.cfg = await state.storage.getConfig();
      state.renderer = buildRenderer(state.cfg);
      applyConfigToUI(state.cfg);
      if (state.storage.capabilities.list) {
        try { state.files = await state.storage.list(); } catch (e) { /* keep old */ }
        renderFileList();
      }
      // Re-read each open plan from storage (picks up external / synced edits).
      for (const pane of state.panes) {
        if (pane.doc && pane.doc.path && state.storage.capabilities.list) {
          try {
            const fresh = await state.storage.read(pane.doc.path);
            pane.doc = fresh; pane.text = fresh.text;
          } catch (e) { /* file may have vanished; keep what we have */ }
        }
        renderPane(pane);
      }
      toast('Reloaded.');
    } catch (e) {
      toast('Reload failed: ' + e.message, true);
    } finally {
      els.refreshBtn.classList.remove('spin');
    }
  }

  // ---- config view ----
  function openConfig() {
    MDP.ui.configtab.render(els.configForm, {
      cfg: state.cfg,
      onCancel: function () { showView('reader'); },
      onSave: async function (next) {
        try {
          await state.storage.putConfig(next);
          state.cfg = next;
          state.renderer = buildRenderer(next);
          applyConfigToUI(next);
          toast('Config saved.');
          showView('reader');
          state.panes.forEach(renderPane);
          if (state.storage.capabilities.list) refreshBadges();
        } catch (e) { toast('Config save failed: ' + e.message, true); }
      }
    });
    showView('config');
  }

  // ---- header controls ----
  function bumpFont(delta) {
    const next = Math.min(3, Math.max(0.6, Math.round((state.cfg.ui.fontScale + delta) * 10) / 10));
    state.cfg = MDP.config.deepMerge(state.cfg, { ui: { fontScale: next } });
    applyConfigToUI(state.cfg);
    state.storage.putConfig(state.cfg).catch(function () {});
  }
  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.cfg.ui.theme) + 1) % order.length];
    state.cfg = MDP.config.deepMerge(state.cfg, { ui: { theme: next } });
    applyConfigToUI(state.cfg);
    state.renderer = buildRenderer(state.cfg);
    state.panes.forEach(renderPane);
    state.storage.putConfig(state.cfg).catch(function () {});
    toast('Theme: ' + next);
  }

  function syncOutlineBtn() {
    els.outlineBtn.setAttribute('aria-pressed', String(state.ui.outline));
    els.outlineBtn.classList.toggle('active', state.ui.outline);
  }
  function toggleOutline() {
    state.ui.outline = !state.ui.outline;
    try { localStorage.setItem('mdp.outline', state.ui.outline ? '1' : '0'); } catch (e) {}
    syncOutlineBtn();
    if (!els.readerView.hidden && state.active) renderPane(state.active);
    if (!els.readerView.hidden) showView('reader');
  }

  function loadUIPrefs() {
    let outline = true;
    try { outline = localStorage.getItem('mdp.outline') !== '0'; } catch (e) {}
    return { outline: outline };
  }

  function wireControls() {
    els.menuBtn.addEventListener('click', function () { els.sidebar.classList.toggle('collapsed'); });
    els.splitBtn.addEventListener('click', function () { setSplit(!state.split); });
    els.outlineBtn.addEventListener('click', toggleOutline);
    els.fontUp.addEventListener('click', function () { bumpFont(0.1); });
    els.fontDown.addEventListener('click', function () { bumpFont(-0.1); });
    els.refreshBtn.addEventListener('click', reloadApp);
    els.themeBtn.addEventListener('click', cycleTheme);
    els.configBtn.addEventListener('click', function () {
      if (els.configView.hidden) openConfig(); else showView('reader');
    });
    els.search.addEventListener('input', function () { state.query = els.search.value; renderFileList(); });

    els.openFileBtn.addEventListener('click', function () { openInto(state.active || state.panes[0]); });
    els.fileInput.addEventListener('change', async function () {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (!file) return;
      const pane = state._pendingPane || state.active || state.panes[0];
      state._pendingPane = null;
      try { setPaneDoc(pane, await state.storage.openViaInput(file)); }
      catch (e) { toast('Open failed: ' + e.message, true); }
      els.fileInput.value = '';
    });
  }

  // ---- boot ----
  async function boot() {
    grab();
    app = { els: els, focus: focus };
    state.ui = loadUIPrefs();
    state.storage = await MDP.storage.detectStorage();
    state.cfg = await state.storage.getConfig();
    applyConfigToUI(state.cfg);
    state.renderer = buildRenderer(state.cfg);
    wireControls();
    syncOutlineBtn();

    const first = createPane();
    state.active = first;
    focus(first);
    renderPane(first);   // empty state

    if (state.storage.mode === 'server') {
      els.modeBadge.textContent = '🖧 Server';
      els.modeBadge.className = 'badge server';
      els.openFileBtn.hidden = true;
      try {
        state.files = await state.storage.list();
        renderFileList();
      } catch (e) { toast('Could not list files: ' + e.message, true); }
      await maybeOpenAdhoc();   // honour ?adhoc=<id> from `./run.sh --open FILE`
    } else {
      els.modeBadge.textContent = '📱 Standalone';
      els.modeBadge.className = 'badge client';
      els.openFileBtn.hidden = false;
      // Served over http(s): list plans from the standalone root (default ../../plans).
      // Opened from a file:// / content:// URI: listing is impossible, so just offer the
      // picker. Either way the 📂 Open button stays available.
      if (state.storage.capabilities.list) {
        try {
          state.files = await state.storage.list();
          renderFileList();
        } catch (e) {
          standaloneHint('Standalone mode — open a .md file to begin.');
        }
      } else {
        standaloneHint('Standalone mode — open a .md file to begin.');
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  MDP.app = { state: state, _boot: boot };
})(typeof self !== 'undefined' ? self : this);
