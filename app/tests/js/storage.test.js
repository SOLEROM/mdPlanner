'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Storage = require('../../web/js/storage.js');

function jsonResponse(ok, payload) {
  return Promise.resolve({ ok: ok, status: ok ? 200 : 500, json: () => Promise.resolve(payload) });
}

test('detectStorage selects ServerStorage when /api/files responds ok', async () => {
  const s = await Storage.detectStorage({
    location: { protocol: 'http:' },
    fetchImpl: () => jsonResponse(true, { ok: true, data: [] })
  });
  assert.equal(s.mode, 'server');
  assert.equal(s.capabilities.list, true);
});

test('detectStorage falls back to ClientStorage on file:// protocol', async () => {
  const s = await Storage.detectStorage({ location: { protocol: 'file:' }, window: { localStorage: null } });
  assert.equal(s.mode, 'client');
  assert.equal(s.capabilities.list, false);
});

test('detectStorage falls back to ClientStorage when probe throws', async () => {
  const s = await Storage.detectStorage({
    location: { protocol: 'http:' },
    fetchImpl: () => Promise.reject(new Error('connection refused')),
    window: { localStorage: null }
  });
  assert.equal(s.mode, 'client');
});

test('ServerStorage.read unwraps the envelope; bad envelope throws', async () => {
  const okStore = Storage.ServerStorage({ fetchImpl: () => jsonResponse(true, { ok: true, data: { path: 'a.md', text: 'hi' } }) });
  const data = await okStore.read('a.md');
  assert.equal(data.text, 'hi');

  const badStore = Storage.ServerStorage({ fetchImpl: () => jsonResponse(false, { ok: false, error: 'invalid path' }) });
  await assert.rejects(() => badStore.read('../etc/passwd'), /invalid path/);
});

test('ServerStorage.write PUTs raw text and reports saved', async () => {
  const calls = [];
  const store = Storage.ServerStorage({
    fetchImpl: (url, init) => { calls.push({ url, init }); return jsonResponse(true, { ok: true, data: { mtime: 123 } }); }
  });
  const res = await store.write({ path: 'a.md' }, '# new');
  assert.equal(res.saved, true);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.body, '# new');
  assert.ok(calls[0].url.includes('path=a.md'));
});

test('ServerStorage routes on-demand (adhoc) plans by id and merges the list', async () => {
  const calls = [];
  const fetchImpl = function (url, init) {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.endsWith('/api/files')) return jsonResponse(true, { ok: true, data: [{ path: 'a.md', status: 'pending', openCount: 0, mtime: 1 }] });
    if (u.endsWith('/api/adhoc')) return jsonResponse(true, { ok: true, data: [{ path: 'adhoc:abc123', name: 'plan.md', title: '/proj/plan.md', external: true, status: 'pending', openCount: 2, mtime: 9 }] });
    if (u.indexOf('/api/file?adhoc=abc123') !== -1) return jsonResponse(true, { ok: true, data: { path: 'adhoc:abc123', name: 'plan.md', text: '# External', mtime: 9 } });
    return jsonResponse(true, { ok: true, data: { mtime: 10 } });   // the PUT
  };
  const store = Storage.ServerStorage({ fetchImpl: fetchImpl });

  const files = await store.list();
  assert.deepEqual(files.map(f => f.path), ['adhoc:abc123', 'a.md']);   // on-demand listed first
  assert.equal(files[0].external, true);

  const doc = await store.read('adhoc:abc123');
  assert.equal(doc.text, '# External');
  assert.ok(calls.some(c => c.url.indexOf('/api/file?adhoc=abc123') !== -1), 'read goes by id, not path');

  await store.write({ path: 'adhoc:abc123' }, '# new');
  const put = calls.find(c => c.method === 'PUT');
  assert.ok(put && put.url.indexOf('/api/file?adhoc=abc123') !== -1, 'write goes by id');
});

test('ServerStorage.list still works when the on-demand endpoint is absent', async () => {
  const store = Storage.ServerStorage({
    fetchImpl: function (url) {
      const u = String(url);
      if (u.endsWith('/api/files')) return jsonResponse(true, { ok: true, data: [{ path: 'a.md' }] });
      return jsonResponse(false, { ok: false, error: 'unknown endpoint' });   // /api/adhoc 404 on old servers
    }
  });
  const files = await store.list();
  assert.deepEqual(files.map(f => f.path), ['a.md']);   // adhoc failure is swallowed
});

test('ClientStorage persists config to localStorage and merges defaults', async () => {
  const mem = {};
  const fakeWindow = {
    localStorage: {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = v; }
    }
  };
  const store = Storage.ClientStorage({ window: fakeWindow });
  await store.putConfig(require('../../web/js/config.js').mergeConfig({ author: 'rob' }));
  const cfg = await store.getConfig();
  assert.equal(cfg.author, 'rob');
  assert.equal(cfg.marker.iconOpen, '🔴'); // default merged back in
});

test('ClientStorage lists + reads plans from the standalone root over http', async () => {
  const plan = '# Plan\n\n> 🔴 **Q (me):** why?\n';
  const fetchImpl = function (url) {
    const u = String(url);
    if (u.indexOf('index.json') !== -1) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    if (/\/plans\/$/.test(u)) return Promise.resolve({                  // autoindex listing
      ok: true, status: 200, headers: { get: () => null },
      text: () => Promise.resolve('<a href="a.md">a.md</a><a href="sub/b.markdown">b</a><a href="../x.md">esc</a>')
    });
    return Promise.resolve({                                            // a plan file
      ok: true, status: 200, headers: { get: () => 'Wed, 01 Jan 2026 00:00:00 GMT' },
      text: () => Promise.resolve(plan)
    });
  };
  const store = Storage.ClientStorage({
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    location: { protocol: 'http:', href: 'http://h/app/web/index.standalone.html' },
    fetchImpl: fetchImpl
  });
  assert.equal(store.capabilities.list, true);
  const files = await store.list();
  assert.deepEqual(files.map(f => f.path), ['a.md', 'sub/b.markdown']);   // ../x.md rejected
  assert.equal(files[0].openCount, 1);                                    // parsed client-side
  const doc = await store.read('a.md');
  assert.equal(doc.text, plan);
  assert.equal(doc.handle, null);                                        // export-on-write
});

test('ClientStorage disables listing off http(s) (file:// falls back to picker)', () => {
  const store = Storage.ClientStorage({
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    location: { protocol: 'file:', href: 'file:///sd/app/web/index.standalone.html' }
  });
  assert.equal(store.capabilities.list, false);
});

test('ClientStorage rejects an invalid config', async () => {
  const store = Storage.ClientStorage({ window: { localStorage: { getItem: () => null, setItem: () => {} } } });
  await assert.rejects(() => store.putConfig({ ui: { theme: 'neon' } }), /invalid config/);
});
