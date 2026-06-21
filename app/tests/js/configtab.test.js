'use strict';
/* configtab.test.js — drives the real configtab UMD module (the browser code path)
   through a minimal fake DOM in a vm sandbox, so the paged config form + per-type
   note-bank editor get regression coverage without pulling jsdom. The shim models
   only the DOM subset configtab/dom.js touch (createElement, appendChild, value,
   checked, <select>.value, event listeners). */
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.style = { setProperty() {} }; this.dataset = {};
    this._text = ''; this.className = ''; this.hidden = false; this.checked = false; this._value = '';
  }
  get value() {
    if (this.tagName === 'select') {
      const sel = this.children.filter((c) => c.attributes && 'selected' in c.attributes)[0];
      const opt = sel || this.children[0];
      return opt && opt.attributes ? opt.attributes.value : '';
    }
    return this._value || '';
  }
  set value(v) { this._value = v; }
  appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => (c && c.textContent) || '').join('');
  }
  set innerHTML(v) { this._html = v; this.children = []; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'value') this.value = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })); }
  focus() {}
  querySelectorAll() { return []; }
}

function loadConfigtab() {
  const document = {
    createElement: (t) => new El(t),
    createTextNode: (s) => ({ nodeType: 3, textContent: String(s), parentNode: null }),
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }
  };
  const sandbox = { document, console, setTimeout, JSON };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  ['js/ui/dom.js', 'js/config.js', 'js/ui/configtab.js'].forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(WEB, rel), 'utf8'), sandbox, { filename: rel });
  });
  return sandbox.MDP;
}

function find(el, cls, out) {
  out = out || [];
  (el.children || []).forEach((c) => {
    if (c && c.className && (' ' + c.className + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(c);
    if (c && c.children) find(c, cls, out);
  });
  return out;
}
const inputsOf = (el) => el.children.filter((c) => c.tagName === 'input');

function mount(MDP, overrides) {
  const cfg = MDP.config.mergeConfig(overrides || {});
  const formEl = new El('div');
  const navEl = new El('nav');
  let saved = null;
  MDP.ui.configtab.render(formEl, navEl, {
    cfg, onSave: (c) => { saved = c; }, onCancel: () => {}
  });
  return { cfg, formEl, navEl, nav: find(navEl, 'config-nav-item'), getSaved: () => saved };
}

test('config nav lists General + one page per note type, General active', () => {
  const { nav } = mount(loadConfigtab());
  assert.deepEqual(nav.map((b) => b.textContent), ['General', 'Questions', 'Remarks', 'Wrong', 'Fix']);
  assert.ok((' ' + nav[0].className + ' ').includes(' active '));
});

test('General page carries shared config but no bank or per-type label field', () => {
  const { formEl } = mount(loadConfigtab());
  assert.equal(find(formEl, 'cfg-page-title')[0].textContent, 'General');
  assert.equal(find(formEl, 'bank-list').length, 0);
  // The per-type label tokens moved to their own pages — none on General.
  assert.equal(find(formEl, 'cfg-page-title').length, 1);
});

test('type page seeds the bank; label-token edit survives navigation and saves', () => {
  const { formEl, nav, getSaved, cfg } = mount(loadConfigtab());
  nav[1].click();                                            // → Questions
  assert.equal(find(formEl, 'cfg-page-title')[0].textContent, 'Questions');
  assert.equal(find(formEl, 'bank-row').length, 3);

  const label = inputsOf(find(formEl, 'cfg-field')[0])[0];
  assert.equal(label.value, 'Q');
  label.value = 'Qx';

  nav[0].click();                                            // away to General …
  nav[1].click();                                            // … and back
  assert.equal(inputsOf(find(formEl, 'cfg-field')[0])[0].value, 'Qx', 'edit persisted');

  find(formEl, 'cfg-actions')[0].children
    .filter((c) => c.textContent === 'Save & apply')[0].click();
  const saved = getSaved();
  assert.ok(saved && MDP_validate(saved));
  assert.equal(saved.marker.types.question, 'Qx');
  assert.equal(cfg.marker.types.question, 'Q', 'input cfg untouched (immutable)');
});

test('bank add (trimmed) + reorder + delete flow through to the saved config', () => {
  const MDP = loadConfigtab();
  const { formEl, nav, getSaved } = mount(MDP);
  nav[1].click();                                            // Questions

  // add
  const add = find(formEl, 'bank-add')[0];
  inputsOf(add)[0].value = '  New question?  ';
  add.children.filter((c) => c.tagName === 'button')[0].click();
  assert.equal(find(formEl, 'bank-row').length, 4);

  // move the new last row up one
  const rows = find(formEl, 'bank-row');
  rows[3].children.filter((c) => (c.className || '').includes('bank-move'))[0].click();

  // delete the (now) first row
  let r0 = find(formEl, 'bank-row')[0];
  r0.children.filter((c) => (c.className || '').includes('bank-del'))[0].click();
  assert.equal(find(formEl, 'bank-row').length, 3);

  find(formEl, 'cfg-actions')[0].children
    .filter((c) => c.textContent === 'Save & apply')[0].click();
  const bank = getSaved().noteBank.question;
  assert.equal(bank.length, 3);
  assert.ok(bank.includes('New question?'), 'added note trimmed + survived reorder/delete');
});

test('save is blocked when an edit makes the config invalid', () => {
  const MDP = loadConfigtab();
  const { formEl, nav, getSaved } = mount(MDP);
  nav[1].click();                                            // Questions
  inputsOf(find(formEl, 'cfg-field')[0])[0].value = 'R';     // collides with Remark label
  find(formEl, 'cfg-actions')[0].children
    .filter((c) => c.textContent === 'Save & apply')[0].click();
  assert.equal(getSaved(), null, 'onSave not called for invalid config');
  assert.equal(find(formEl, 'cfg-errors')[0].hidden, false, 'error box shown');
});

// validateConfig lives on the loaded MDP; expose a tiny helper for the assert above.
let _MDP = null;
function MDP_validate(cfg) { return (_MDP || (_MDP = loadConfigtab())).config.validateConfig(cfg).valid; }
