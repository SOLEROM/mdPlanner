'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../web/js/config.js');

test('mergeConfig fills defaults and overlays overrides immutably', () => {
  const merged = config.mergeConfig({ author: 'rob', ui: { fontScale: 1.4 } });
  assert.equal(merged.author, 'rob');
  assert.equal(merged.ui.fontScale, 1.4);
  assert.equal(merged.ui.remarkColor, '#e5484d');       // default preserved
  assert.equal(merged.marker.iconOpen, '🔴');           // deep default preserved
  // original defaults untouched
  assert.equal(config.DEFAULT_CONFIG.author, 'me');
});

test('validateConfig accepts defaults', () => {
  const res = config.validateConfig(config.mergeConfig({}));
  assert.equal(res.valid, true, res.errors.join('; '));
});

test('validateConfig rejects bad values', () => {
  const bad = config.mergeConfig({ server: { port: 70000 }, ui: { remarkColor: 'red', theme: 'neon' } });
  const res = config.validateConfig(bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes('port')));
  assert.ok(res.errors.some(e => e.includes('remarkColor')));
  assert.ok(res.errors.some(e => e.includes('theme')));
});

test('validateConfig rejects identical open/resolved icons', () => {
  const res = config.validateConfig(config.mergeConfig({ marker: { iconResolved: '🔴' } }));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes('must differ')));
});

test('default config carries all four note types with distinct colours', () => {
  const cfg = config.mergeConfig({});
  assert.deepEqual(cfg.marker.types, { question: 'Q', remark: 'R', wrong: 'W', fix: 'F' });
  const colors = Object.values(cfg.ui.typeColors);
  assert.equal(colors.length, 4);
  assert.equal(new Set(colors).size, 4, 'each type colour must be distinct');
});

test('validateConfig rejects duplicate type labels and bad type colours', () => {
  const dup = config.mergeConfig({ marker: { types: { wrong: 'Q' } } }); // collides with question
  const r1 = config.validateConfig(dup);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some(e => e.includes('unique')));
  const bad = config.mergeConfig({ ui: { typeColors: { fix: 'green' } } });
  const r2 = config.validateConfig(bad);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some(e => e.includes('typeColors')));
});

test('per-mode roots: server rootPath + standaloneRoot defaults and validation', () => {
  const cfg = config.mergeConfig({});
  assert.equal(cfg.rootPath, '/data/aproj/mdplaner');     // server (Mode 1)
  assert.equal(cfg.standaloneRoot, '../../plans');        // standalone (Mode 2)
  assert.equal(config.validateConfig(cfg).valid, true);
  const bad = config.validateConfig(config.mergeConfig({ standaloneRoot: 123 }));
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => e.includes('standaloneRoot')));
});

test('renderHeader honours template + status suffix', () => {
  const cfg = config.mergeConfig({});
  assert.equal(config.renderHeader(cfg, 'question', 'me', 'open'), '**Q (me):** ');
  assert.equal(config.renderHeader(cfg, 'remark', 'me', 'resolved'), '**R (me, resolved):** ');
});
