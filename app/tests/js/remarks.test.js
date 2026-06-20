'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../web/js/config.js');
const R = require('../../web/js/remarks.js');

const cfg = config.mergeConfig({});

test('parses a single open question', () => {
  const text = '# Plan\n\nSome prose.\n\n> 🔴 **Q (me):** why three planes?\n';
  const rs = R.parseRemarks(text, cfg);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].type, 'question');
  assert.equal(rs[0].author, 'me');
  assert.equal(rs[0].status, 'open');
  assert.equal(rs[0].body, 'why three planes?');
});

test('plain plan blockquotes are NOT remarks', () => {
  const text = '# Plan\n\n> **Status:** proposal / design plan\n> Audience: us\n';
  assert.equal(R.parseRemarks(text, cfg).length, 0);
});

test('parses a resolved remark via icon + suffix', () => {
  const text = '> ⚪ **R (me, resolved):** addressed in §2\n';
  const rs = R.parseRemarks(text, cfg);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].type, 'remark');
  assert.equal(rs[0].status, 'resolved');
  assert.equal(rs[0].author, 'me');
});

test('parses replies and multi-line bodies', () => {
  const text = [
    '> 🔴 **Q (me):** first line',
    '> still the question',
    '> ↳ **claude:** an answer',
    '> spanning two lines'
  ].join('\n');
  const rs = R.parseRemarks(text, cfg);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].body, 'first line\nstill the question');
  assert.equal(rs[0].replies.length, 1);
  assert.equal(rs[0].replies[0].who, 'claude');
  assert.equal(rs[0].replies[0].body, 'an answer\nspanning two lines');
});

test('buildRemark round-trips through parseRemarks', () => {
  const md = R.buildRemark(cfg, { type: 'question', body: 'round trip?' });
  assert.equal(md, '> 🔴 **Q (me):** round trip?');
  const rs = R.parseRemarks(md, cfg);
  assert.equal(rs[0].type, 'question');
  assert.equal(rs[0].body, 'round trip?');
});

test('builds, parses and resolves the wrong/fix note types', () => {
  const w = R.buildRemark(cfg, { type: 'wrong', body: 'this date is off' });
  const f = R.buildRemark(cfg, { type: 'fix', body: 'use 2026 instead' });
  assert.equal(w, '> 🔴 **W (me):** this date is off');
  assert.equal(f, '> 🔴 **F (me):** use 2026 instead');
  const rs = R.parseRemarks(w + '\n\n' + f, cfg);
  assert.deepEqual(rs.map(function (r) { return r.type; }), ['wrong', 'fix']);
  assert.equal(R.countOpen(rs), 2);
  // they toggle resolved like any other remark (icon + suffix)
  const resolved = R.toggleResolved(w, R.parseRemarks(w, cfg)[0], cfg);
  assert.equal(resolved, '> ⚪ **W (me, resolved):** this date is off');
  assert.equal(R.parseRemarks(resolved, cfg)[0].status, 'resolved');
});

test('addRemarkAfterLine inserts after the block with blank separation', () => {
  const text = 'para one\n\npara two';
  const out = R.addRemarkAfterLine(text, 0, cfg, { type: 'remark', body: 'note' });
  const lines = out.split('\n');
  assert.equal(lines[0], 'para one');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '> 🔴 **R (me):** note');
  assert.equal(lines[3], '');
  assert.equal(lines[4], 'para two');
  assert.equal(R.parseRemarks(out, cfg).length, 1);
});

test('toggleResolved flips icon + suffix and is reversible', () => {
  const text = '> 🔴 **Q (me):** open?';
  const resolved = R.toggleResolved(text, R.parseRemarks(text, cfg)[0], cfg);
  assert.equal(resolved, '> ⚪ **Q (me, resolved):** open?');
  assert.equal(R.parseRemarks(resolved, cfg)[0].status, 'resolved');
  const back = R.toggleResolved(resolved, R.parseRemarks(resolved, cfg)[0], cfg);
  assert.equal(back, text);
});

test('toggleResolved preserves the reply lines', () => {
  const text = '> 🔴 **Q (me):** q\n> ↳ **claude:** a';
  const out = R.toggleResolved(text, R.parseRemarks(text, cfg)[0], cfg);
  assert.ok(out.indexOf('> ↳ **claude:** a') !== -1);
  assert.equal(R.parseRemarks(out, cfg)[0].replies.length, 1);
});

test('addReply appends inside the same blockquote', () => {
  const text = '> 🔴 **Q (me):** why?';
  const out = R.addReply(text, R.parseRemarks(text, cfg)[0], 'claude', 'because.', cfg);
  assert.equal(out, '> 🔴 **Q (me):** why?\n> ↳ **claude:** because.');
  assert.equal(R.parseRemarks(out, cfg)[0].replies[0].body, 'because.');
});

test('removeRemark deletes the whole block and collapses surrounding blanks', () => {
  const text = 'para one\n\n> 🔴 **Q (me):** why?\n> ↳ **claude:** because.\n\npara two';
  const r = R.parseRemarks(text, cfg)[0];
  const out = R.removeRemark(text, r);
  assert.equal(out, 'para one\n\npara two');
  assert.equal(R.parseRemarks(out, cfg).length, 0);
});

test('removeRemark at the top of the file leaves no leading blank', () => {
  const text = '> 🔴 **Q (me):** top?\n\n# Title\n\nbody';
  const r = R.parseRemarks(text, cfg)[0];
  assert.equal(R.removeRemark(text, r), '# Title\n\nbody');
});

test('removeRemark only removes the targeted note, keeping the others', () => {
  const text = '> 🔴 **Q (me):** one\n\n> 🔴 **R (me):** two\n\n> 🔴 **Q (me):** three';
  const rs = R.parseRemarks(text, cfg);
  const out = R.removeRemark(text, rs[1]);   // delete the middle one
  const left = R.parseRemarks(out, cfg);
  assert.equal(left.length, 2);
  assert.deepEqual(left.map(function (r) { return r.body; }), ['one', 'three']);
});

test('upsertApproval inserts under H1 then replaces (no duplicate)', () => {
  const text = '# Title\n\nbody text';
  const a = R.upsertApproval(text, 'changes-requested', cfg, 'me', '2026-06-19');
  assert.ok(a.indexOf('> 🟠 **CHANGES REQUESTED** — me · 2026-06-19') !== -1);
  assert.equal(R.findApproval(a, cfg).state, 'changes-requested');
  const b = R.upsertApproval(a, 'approved', cfg, 'me', '2026-06-20');
  assert.equal((b.match(/CHANGES REQUESTED/g) || []).length, 0);
  assert.equal((b.match(/APPROVED/g) || []).length, 1);
  assert.equal(R.findApproval(b, cfg).state, 'approved');
});

test('approval banners are not mistaken for remarks (incl. ⚪ pending)', () => {
  const text = '# Title\n\n> ⚪ **PENDING** — me · 2026-06-19\n\nbody';
  assert.equal(R.parseRemarks(text, cfg).length, 0);
  assert.equal(R.findApproval(text, cfg).state, 'pending');
});

test('countOpen ignores resolved remarks', () => {
  const text = [
    '> 🔴 **Q (me):** open one',
    '',
    '> ⚪ **R (me, resolved):** done'
  ].join('\n');
  assert.equal(R.countOpen(R.parseRemarks(text, cfg)), 1);
});

test('findApproval is not fooled by approval labels in remark bodies', () => {
  // resolved remark (⚪) whose body literally mentions **PENDING**
  const a = '# T\n\n> ⚪ **R (me, resolved):** clear the **PENDING** list first';
  assert.equal(R.findApproval(a, cfg), null);
  // a continuation body line that looks like an approval banner
  const b = '# T\n\n> 🔴 **Q (me):** check\n> ⚪ **PENDING** — not really a banner';
  assert.equal(R.findApproval(b, cfg), null);
  // a real banner is still found
  const c = '# T\n\n> ✅ **APPROVED** — me · 2026-06-19';
  assert.equal(R.findApproval(c, cfg).state, 'approved');
});

test('upsertApproval inserts after the H1, not inside frontmatter', () => {
  const text = '---\nnoteId: x\ntags: [a]\n---\n\n# Real Title\n\nbody';
  const out = R.upsertApproval(text, 'approved', cfg, 'me', '2026-06-19');
  const lines = out.split('\n');
  assert.equal(lines[0], '---');                      // frontmatter intact
  assert.equal(lines[3], '---');
  const bannerIdx = lines.findIndex(l => l.indexOf('APPROVED') !== -1);
  const titleIdx = lines.findIndex(l => l === '# Real Title');
  assert.ok(bannerIdx > titleIdx, 'banner must come after the H1');
});

test('marker examples inside fenced code blocks are ignored', () => {
  const text = [
    '# Doc that documents the format',
    '',
    '```markdown',
    '> 🔴 **Q (me):** this is only an example',
    '> ↳ **claude:** also an example',
    '```',
    '',
    '> 🔴 **Q (me):** but THIS one is real',
    '',
    '```',
    '> ✅ **APPROVED** — me · 2026-06-19',
    '```'
  ].join('\n');
  const rs = R.parseRemarks(text, cfg);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].body, 'but THIS one is real');
  assert.equal(R.findApproval(text, cfg), null); // the ✅ is inside a fence
});

test('config-driven tokens change the grammar without code change', () => {
  const custom = config.mergeConfig({ marker: { iconOpen: '❗', types: { question: 'ASK', remark: 'NOTE' } } });
  const md = R.buildRemark(custom, { type: 'question', body: 'hi' });
  assert.equal(md, '> ❗ **ASK (me):** hi');
  assert.equal(R.parseRemarks(md, custom)[0].type, 'question');
});

test('parses multi-word type labels (not just single tokens)', () => {
  const custom = config.mergeConfig({
    marker: {
      types: {
        question: 'Question about that, i need answer to:',
        remark: 'i have some Remarks here:',
        wrong: 'that is Wrong, do: ',   // note the trailing space
        fix: 'FixThat:'
      }
    }
  });
  // Build each type and confirm it round-trips back to the right type key —
  // every type, not only the single-token "fix", must be parsed.
  for (const type of ['question', 'remark', 'wrong', 'fix']) {
    const md = R.buildRemark(custom, { type: type, body: 'x' });
    const rs = R.parseRemarks(md, custom);
    assert.equal(rs.length, 1, type + ' should parse');
    assert.equal(rs[0].type, type);
    assert.equal(rs[0].author, 'me');
  }
});

test('multi-word labels parse a full mixed file (rail sees every type)', () => {
  const custom = config.mergeConfig({
    marker: {
      types: {
        question: 'Question about that, i need answer to:',
        remark: 'i have some Remarks here:',
        wrong: 'that is Wrong, do: ',
        fix: 'FixThat:'
      }
    }
  });
  const text = [
    '# a',
    '',
    R.buildRemark(custom, { type: 'question', body: '0' }),
    '',
    R.buildRemark(custom, { type: 'remark', body: '1' }),
    '',
    R.buildRemark(custom, { type: 'fix', body: '2' }),
    '',
    R.buildRemark(custom, { type: 'wrong', body: '3' })
  ].join('\n');
  const rs = R.parseRemarks(text, custom);
  assert.deepEqual(rs.map(r => r.type), ['question', 'remark', 'fix', 'wrong']);
});
