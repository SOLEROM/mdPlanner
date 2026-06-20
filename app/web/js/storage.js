/*
 * storage.js — the adapter that is the ONLY difference between the two modes.
 *
 *   ServerStorage  (Mode 1) — talks REST to server.py; full list/read/write/config.
 *   ClientStorage  (Mode 2) — browser file picker; reads any picked file, writes
 *                             in place via the File System Access API when present,
 *                             else exports a patched copy (download / clipboard / share).
 *
 * detectStorage() probes GET /api/files: success ⇒ server, failure or file:// ⇒ client.
 * See PLAN.md §0, §3.2.
 *
 * Everything network-facing validates the response envelope { ok, data, error } and
 * raises a descriptive Error — we never silently swallow failures.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'), require('./remarks.js'));
  else { root.MDP = root.MDP || {}; root.MDP.storage = factory(root.MDP.config, root.MDP.remarks); }
})(typeof self !== 'undefined' ? self : this, function (configMod, remarksMod) {
  'use strict';

  // ---- Mode 1: server REST adapter ----------------------------------------

  function ServerStorage(opts) {
    opts = opts || {};
    const base = opts.base || '';
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('ServerStorage requires a fetch implementation');

    async function api(method, path, body, rawText) {
      const init = { method: method, headers: {} };
      if (body !== undefined) {
        if (rawText) { init.headers['Content-Type'] = 'text/markdown; charset=utf-8'; init.body = body; }
        else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      }
      const res = await fetchImpl(base + path, init);
      let payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }
      if (!res.ok || !payload || payload.ok !== true) {
        const msg = (payload && payload.error) || ('HTTP ' + res.status);
        throw new Error('server: ' + msg);
      }
      return payload.data;
    }

    // On-demand external plans are addressed by an opaque id behind an `adhoc:<id>`
    // path sentinel — the server resolves the id to a real file outside the root.
    // read/write branch on the sentinel so the rest of the app stays path-agnostic.
    function fileQuery(path) {
      const m = /^adhoc:(.+)$/.exec(path || '');
      return m ? 'adhoc=' + encodeURIComponent(m[1]) : 'path=' + encodeURIComponent(path);
    }

    return {
      mode: 'server',
      capabilities: { list: true, directWrite: true },
      list: async function () {
        const files = await api('GET', '/api/files');
        let adhoc = [];
        try { adhoc = await api('GET', '/api/adhoc'); } catch (e) { /* feature off ⇒ none */ }
        return (adhoc || []).concat(files || []);
      },
      read: function (path) { return api('GET', '/api/file?' + fileQuery(path)); },
      write: async function (doc, text) {
        const data = await api('PUT', '/api/file?' + fileQuery(doc.path), text, true);
        return { saved: true, exported: false, mtime: data && data.mtime };
      },
      getConfig: function () { return api('GET', '/api/config'); },
      putConfig: async function (cfg) { await api('PUT', '/api/config', cfg); return { ok: true }; }
    };
  }

  // ---- Mode 2: client / standalone adapter --------------------------------

  function ClientStorage(opts) {
    opts = opts || {};
    const win = opts.window || (typeof window !== 'undefined' ? window : {});
    const storageKey = 'mdplanner.config';
    const hasFsAccess = typeof win.showOpenFilePicker === 'function';
    const fetchImpl = opts.fetchImpl || win.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const loc = opts.location || win.location || { protocol: 'file:', href: '' };
    const URLCtor = win.URL || (typeof URL !== 'undefined' ? URL : null);
    // A path typed into config can only be fetched as a sibling folder over http(s):
    // on file:// / content:// the browser blocks relative fetches (and Android's Files
    // app gives a content:// URI with no sibling dir at all), so listing is disabled
    // there and we fall back to the file picker. See PLAN.md §10.9.
    const canList = /^https?:$/.test(loc.protocol || '') && typeof fetchImpl === 'function' && !!URLCtor;

    function readFileObject(file) {
      return new Promise(function (resolve, reject) {
        const reader = new win.FileReader();
        reader.onload = function () { resolve(String(reader.result)); };
        reader.onerror = function () { reject(new Error('could not read file: ' + file.name)); };
        reader.readAsText(file);
      });
    }

    async function openViaPicker() {
      const handles = await win.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
        multiple: false
      });
      const handle = handles[0];
      const file = await handle.getFile();
      const text = await readFileObject(file);
      return { path: file.name, text: text, mtime: file.lastModified, handle: handle };
    }

    async function openViaInput(file) {
      const text = await readFileObject(file);
      return { path: file.name, text: text, mtime: file.lastModified, handle: null };
    }

    // Best-effort export of a patched copy when we cannot write in place.
    async function exportCopy(doc, text) {
      const filename = doc.path || 'plan.md';
      // 1) clipboard (most reliable on Android Chrome)
      let clipped = false;
      try {
        if (win.navigator && win.navigator.clipboard) { await win.navigator.clipboard.writeText(text); clipped = true; }
      } catch (e) { /* clipboard may be blocked; continue */ }
      // 2) trigger a download of the patched file
      try {
        const blob = new win.Blob([text], { type: 'text/markdown' });
        const url = win.URL.createObjectURL(blob);
        const a = win.document.createElement('a');
        a.href = url; a.download = filename;
        win.document.body.appendChild(a); a.click(); a.remove();
        win.URL.revokeObjectURL(url);
      } catch (e) { /* download may be unavailable; clipboard still helped */ }
      return { saved: false, exported: true, method: clipped ? 'clipboard+download' : 'download' };
    }

    async function write(doc, text) {
      if (doc && doc.handle && typeof doc.handle.createWritable === 'function') {
        try {
          const writable = await doc.handle.createWritable();
          await writable.write(text);
          await writable.close();
          return { saved: true, exported: false };
        } catch (e) { /* permission denied or revoked -> fall back to export */ }
      }
      return exportCopy(doc, text);
    }

    function lastModified(res) {
      try {
        const hv = res.headers && res.headers.get && res.headers.get('Last-Modified');
        const t = hv ? Date.parse(hv) : NaN;
        return isNaN(t) ? 0 : t;
      } catch (e) { return 0; }
    }

    // Resolve the standalone root (default ../../plans) to an absolute directory URL,
    // relative to the running page (index.standalone.html). The trailing slash matters
    // so relative file names resolve INSIDE the folder.
    function rootDirURL(cfg) {
      let rel = (cfg && cfg.standaloneRoot) || '../../plans';
      if (!/\/$/.test(rel)) rel += '/';
      return new URLCtor(rel, loc.href);
    }

    // Discover *.md file names under the root: a generated `index.json` manifest first
    // (an array of names, or {files:[...]}), else parse an autoindex HTML listing the
    // way nginx / Apache / `python -m http.server` produce one.
    async function discover(baseURL) {
      try {
        const res = await fetchImpl(new URLCtor('index.json', baseURL).href);
        if (res && res.ok) {
          const data = await res.json();
          const arr = Array.isArray(data) ? data : (data && data.files) || [];
          const names = arr
            .map(function (x) { return typeof x === 'string' ? x : (x && (x.path || x.name)); })
            .filter(Boolean);
          if (names.length) return names;
        }
      } catch (e) { /* no manifest -> fall through to autoindex parsing */ }

      const res2 = await fetchImpl(baseURL.href);
      if (!res2 || !res2.ok) throw new Error('cannot list standalone root (HTTP ' + (res2 && res2.status) + ')');
      const html = await res2.text();
      const names = [];
      const re = /href="([^"?#]+\.(?:md|markdown))(?:[?#][^"]*)?"/gi;
      let m;
      while ((m = re.exec(html))) {
        let name;
        try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; }
        // keep only safe in-folder relative names (no abs, no escape, no scheme)
        if (!name || name.charAt(0) === '/' || name.indexOf('..') !== -1 || /^[a-z][a-z0-9+.-]*:\/\//i.test(name)) continue;
        if (names.indexOf(name) === -1) names.push(name);
      }
      if (!names.length) throw new Error('no .md files found under the standalone root');
      return names;
    }

    // List plans under the standalone root, computing the same {status, openCount}
    // badges the server derives — here client-side via the shared remark parser.
    async function list() {
      if (!canList) throw new Error('file listing in standalone mode requires serving over http(s)');
      const cfg = await getConfig();
      const baseURL = rootDirURL(cfg);
      const names = await discover(baseURL);
      const out = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const item = { path: name, status: 'pending', openCount: 0, mtime: 0 };
        try {
          const r = await fetchImpl(new URLCtor(encodeURI(name), baseURL).href);
          if (r && r.ok) {
            const text = await r.text();
            item.mtime = lastModified(r);
            if (remarksMod) {
              item.openCount = remarksMod.countOpen(remarksMod.parseRemarks(text, cfg));
              const ap = remarksMod.findApproval(text, cfg);
              item.status = ap ? ap.state : 'pending';
            }
          }
        } catch (e) { /* keep the file listed; its summary stays unknown */ }
        out.push(item);
      }
      return out;
    }

    async function read(path) {
      if (!canList) throw new Error('use open() to pick a file in standalone mode');
      const cfg = await getConfig();
      const baseURL = rootDirURL(cfg);
      const r = await fetchImpl(new URLCtor(encodeURI(path), baseURL).href);
      if (!r || !r.ok) throw new Error('could not fetch ' + path + ' (HTTP ' + (r && r.status) + ')');
      const text = await r.text();
      // No write handle: edits to a fetched plan export a patched copy (read-first).
      return { path: path, text: text, mtime: lastModified(r), handle: null };
    }

    function getConfig() {
      let overrides = {};
      try {
        const raw = win.localStorage && win.localStorage.getItem(storageKey);
        if (raw) overrides = JSON.parse(raw);
      } catch (e) { overrides = {}; }
      return Promise.resolve(configMod.mergeConfig(overrides));
    }

    function putConfig(cfg) {
      const check = configMod.validateConfig(cfg);
      if (!check.valid) return Promise.reject(new Error('invalid config: ' + check.errors.join('; ')));
      try { win.localStorage.setItem(storageKey, JSON.stringify(cfg)); }
      catch (e) { return Promise.reject(new Error('could not persist config: ' + e.message)); }
      return Promise.resolve({ ok: true });
    }

    return {
      mode: 'client',
      capabilities: { list: canList, directWrite: hasFsAccess },
      list: list,
      read: read,
      open: openViaPicker,
      openViaInput: openViaInput,
      write: write,
      getConfig: getConfig,
      putConfig: putConfig
    };
  }

  // Probe for a Mode-1 server; fall back to the standalone client adapter.
  async function detectStorage(opts) {
    opts = opts || {};
    const loc = opts.location || (typeof location !== 'undefined' ? location : { protocol: 'http:' });
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (loc.protocol !== 'file:' && fetchImpl) {
      try {
        const res = await fetchImpl('/api/files', { method: 'GET' });
        if (res.ok) return ServerStorage({ fetchImpl: fetchImpl });
      } catch (e) { /* no server -> standalone */ }
    }
    return ClientStorage(opts);
  }

  return { ServerStorage: ServerStorage, ClientStorage: ClientStorage, detectStorage: detectStorage };
});
