'use strict';
// Guards the promise of the right-hand Notes rail: EVERY note type we can add
// (question / remark / wrong / fix) must surface as its own rail item when the
// pane is painted. buildRail is private, so we drive the real reader.paint()
// through a tiny zero-dependency DOM stub — no jsdom, in keeping with the lean
// dev deps. If anyone reintroduces a per-type filter in the rail, this fails.
const { test } = require('node:test');
const assert = require('node:assert');

// ---- minimal DOM stub: only what dom.h()/clear() and reader.paint() touch ----
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this._class = '';
    this._text = '';
    this._html = '';
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  get classList() {
    const self = this;
    const bag = () => new Set(self._class.split(/\s+/).filter(Boolean));
    return {
      add: function () { const s = bag(); for (const c of arguments) s.add(c); self._class = [...s].join(' '); },
      remove: function () { const s = bag(); for (const c of arguments) s.delete(c); self._class = [...s].join(' '); },
      toggle: function (c, on) { const s = bag(); const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); self._class = [...s].join(' '); },
      contains: function (c) { return bag().has(c); }
    };
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map(function (c) { return c.nodeType === 3 ? c._text : (c.textContent || ''); }).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { this.children.push(n); return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
}

global.self = global;
global.document = {
  createElement: function (t) { return new FakeEl(t); },
  createTextNode: function (t) { return { nodeType: 3, _text: String(t) }; }
};

// config/remarks use a module.exports-first UMD, so wire MDP by hand; dom/reader
// attach to the shared global (self) and read MDP back off it.
const cfgMod = require('../../web/js/config.js');
const remarksMod = require('../../web/js/remarks.js');
global.MDP = { config: cfgMod, remarks: remarksMod, ui: {} };
require('../../web/js/ui/dom.js');
require('../../web/js/ui/reader.js');
const reader = global.MDP.ui.reader;

function makeCtx(text) {
  const cfg = cfgMod.mergeConfig({});
  const rail = new FakeEl('aside');
  return {
    rail: rail,
    ctx: {
      cfg: cfg,
      text: text,
      result: { html: '<p>painted</p>', hasMermaid: false },
      outline: false,
      els: {
        reader: new FakeEl('article'),
        approvalBar: new FakeEl('div'),
        triageBar: new FakeEl('div'),
        openOnly: { checked: false },
        openCount: new FakeEl('span'),
        jumpNext: new FakeEl('button'),
        remarkRail: rail,
        outline: null            // buildOutline early-returns → no scroll-spy / rAF
      },
      _spy: []
    }
  };
}

function railItems(rail) {
  const list = rail.children.find(function (c) { return c.className.indexOf('rail-list') !== -1; });
  return list ? list.children : [];
}
function typeOf(li) { const m = li.className.match(/\btype-(\w+)\b/); return m ? m[1] : null; }

test('every note type (question/remark/wrong/fix) gets its own item in the Notes rail', function () {
  const DOC = [
    '# Plan', '',
    'Intro paragraph.', '',
    '> 🔴 **Q (me):** clarify the scope', '',
    '> 🔴 **R (me):** a minor note', '',
    '> 🔴 **W (me):** this assumption is wrong', '',
    '> 🔴 **F (me):** suggest using a queue', '',
    '> ⚪ **Q (me, resolved):** already answered'
  ].join('\n');

  const { rail, ctx } = makeCtx(DOC);
  reader.paint(ctx);

  assert.equal(rail.hidden, false, 'rail must be visible when notes exist');
  const items = railItems(rail);
  assert.equal(items.length, 5, 'one rail item per parsed note');

  const types = items.map(typeOf);
  assert.deepEqual(
    [...new Set(types)].sort(),
    ['fix', 'question', 'remark', 'wrong'],
    'all four addable types reach the rail'
  );
  // the two recent additions specifically:
  assert.ok(types.includes('wrong'), 'wrong note shows in the panel');
  assert.ok(types.includes('fix'), 'fix note shows in the panel');

  // each item leads with the CSS-drawn, per-type-tinted status dot
  items.forEach(function (li) {
    assert.ok(li.children[0] && li.children[0].className.indexOf('rail-dot') !== -1, 'item has a rail-dot');
  });

  // resolved notes are still listed (CSS hides them only under "open only")
  const resolved = items.filter(function (li) { return li.className.indexOf('resolved') !== -1; });
  assert.equal(resolved.length, 1, 'resolved note remains in the rail, marked resolved');
});

test('rail hides when there are no notes', function () {
  const { rail, ctx } = makeCtx('# Plan\n\nNo notes here at all.\n');
  reader.paint(ctx);
  assert.equal(rail.hidden, true);
  assert.equal(railItems(rail).length, 0);
});
