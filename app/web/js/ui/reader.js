/* reader.js — paints a plan into a pane and owns the in-reader interactions:
   tap-a-block-to-annotate, remark decoration (red boxes), resolve/reply, the
   approval banner, the open-only / jump-next triage, plus the desktop
   navigation aids — the left Outline (TOC) tree with scroll-spy and the right
   Notes rail. See PLAN.md §6.

   The app may show one pane, or two side-by-side panes (split/compare view).
   Each pane scrolls independently, so this module is pane-scoped: `ctx` is a
   pane object carrying its own `els`, `handlers`, `text`, `result`, etc.

   It calls back into app.js for persistence only:
     ctx.handlers.addRemark(lastLineIdx, type, body)
     ctx.handlers.toggleResolve(remark)
     ctx.handlers.reply(remark, body)
     ctx.handlers.verdict(stateKey)        (wired from the triage buttons by app.js)
*/
(function (root) {
  'use strict';
  const dom = root.MDP.ui.dom;
  const h = dom.h;
  const clear = dom.clear;
  const remarksMod = root.MDP.remarks;

  let docWired = false;     // one document-level dismiss listener for all panes

  function closeOpenComposers(scope) {
    scope.querySelectorAll('.composer').forEach(function (c) { c.remove(); });
  }

  function makeComposer(title, placeholder, onSubmit) {
    const ta = h('textarea', { placeholder: placeholder || 'Type here…', 'aria-label': title });
    const submit = function () {
      const v = ta.value.trim();
      if (!v) { ta.focus(); return; }
      onSubmit(v);
    };
    const box = h('div', { class: 'composer' },
      h('div', { class: 'composer-title' }, title),
      ta,
      h('div', { class: 'composer-row' },
        h('button', { class: 'btn small', onclick: function () { box.remove(); } }, 'Cancel'),
        h('button', { class: 'btn small primary', onclick: submit }, 'Save')
      )
    );
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') box.remove();
    });
    setTimeout(function () { ta.focus(); }, 0);
    return box;
  }

  // Smooth-scroll an element into view and briefly flash it (shared by the
  // outline, the notes rail, and jump-next). Works with the pane's own scroller.
  function flashScroll(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('selected');
    setTimeout(function () { el.classList.remove('selected'); }, 900);
  }

  // ---- remark decoration ----------------------------------------------------

  function decorate(ctx, remarks, approval) {
    const byLine = {};
    remarks.forEach(function (r) { byLine[r.lineStart] = r; });

    ctx.els.reader.querySelectorAll('blockquote[data-line-start]').forEach(function (bq) {
      const ls = parseInt(bq.dataset.lineStart, 10);
      if (approval && ls === approval.lineIdx) {
        bq.classList.add('approval', approval.state);
        return;
      }
      const r = byLine[ls];
      if (!r) return;
      bq.classList.add('remark', 'type-' + r.type);
      if (r.status === 'resolved') bq.classList.add('resolved');
      bq.appendChild(buildRemarkActions(ctx, r));
    });
  }

  function buildRemarkActions(ctx, remark) {
    const actions = h('div', { class: 'remark-actions' });

    function showDefault() {
      clear(actions);
      const resolveLabel = remark.status === 'resolved' ? 'Reopen' : 'Resolve';
      actions.appendChild(h('button', {
        class: 'btn small',
        onclick: function (e) { e.stopPropagation(); ctx.handlers.toggleResolve(remark); }
      }, resolveLabel));
      actions.appendChild(h('button', {
        class: 'btn small',
        onclick: function (e) {
          e.stopPropagation();
          const host = e.target.closest('blockquote');
          closeOpenComposers(ctx.els.reader);
          host.appendChild(makeComposer('Reply', 'Your reply…', function (body) {
            ctx.handlers.reply(remark, body);
          }));
        }
      }, 'Reply'));
      actions.appendChild(h('button', {
        class: 'btn small danger',
        onclick: function (e) { e.stopPropagation(); showConfirm(); }
      }, 'Delete'));
    }

    // Deleting removes the whole note from the file — confirm first.
    function showConfirm() {
      clear(actions);
      actions.appendChild(h('span', { class: 'confirm-text' }, 'Delete this note?'));
      actions.appendChild(h('button', {
        class: 'btn small danger',
        onclick: function (e) { e.stopPropagation(); ctx.handlers.deleteRemark(remark); }
      }, 'Delete'));
      actions.appendChild(h('button', {
        class: 'btn small',
        onclick: function (e) { e.stopPropagation(); showDefault(); }
      }, 'Cancel'));
    }

    showDefault();
    return actions;
  }

  // ---- inline "add a note here" action bar ----------------------------------
  // Rendered INSIDE the reader, right after the tapped block — so it is always
  // anchored to that md box, scrolls with the text, and can never float over the
  // sidebar/top bar the way an absolutely-positioned toolbar could.

  function clearBlockActions(reader) {
    reader.querySelectorAll('.block-actions').forEach(function (b) { b.remove(); });
    reader.querySelectorAll('[data-line-end].annot-target').forEach(function (b) {
      b.classList.remove('annot-target');
    });
  }

  // The addable note types, in button order. A button is emitted only for a type
  // present in cfg.marker.types, so dropping a type from config also drops its
  // button — and the per-type `type-<key>` class tints it (see styles.css).
  const ANNOT_TYPES = [
    { type: 'question', short: 'Question', title: 'New question', ph: 'What needs clarifying?' },
    { type: 'remark', short: 'Remark', title: 'New remark', ph: 'Your note…' },
    { type: 'wrong', short: 'Wrong', title: 'Flag what’s wrong', ph: 'What’s incorrect here?' },
    { type: 'fix', short: 'Fix', title: 'Suggest a fix', ph: 'What should it say instead?' }
  ];

  function showBlockActions(ctx, block) {
    const reader = ctx.els.reader;
    clearBlockActions(reader);
    closeOpenComposers(reader);
    block.classList.add('annot-target');
    const lastLineIdx = parseInt(block.dataset.lineEnd, 10) - 1;
    const types = (ctx.cfg.marker && ctx.cfg.marker.types) || {};

    function start(meta) {
      clearBlockActions(reader);
      const composer = makeComposer(meta.title, meta.ph,
        function (body) { ctx.handlers.addRemark(lastLineIdx, meta.type, body); });
      block.insertAdjacentElement('afterend', composer);
    }

    const bar = h('div', { class: 'block-actions' });
    ANNOT_TYPES.forEach(function (meta) {
      if (typeof types[meta.type] !== 'string') return;   // type disabled in config
      bar.appendChild(h('button', {
        class: 'btn small type-' + meta.type,
        onclick: function (e) { e.stopPropagation(); start(meta); }
      }, '＋ ' + meta.short));
    });
    bar.appendChild(h('button', { class: 'block-actions-x', title: 'Cancel',
      onclick: function (e) { e.stopPropagation(); clearBlockActions(reader); } }, '✕'));
    block.insertAdjacentElement('afterend', bar);
  }

  // ---- approval banner + triage bar ----------------------------------------

  function updateBars(ctx, remarks, approval) {
    const cfg = ctx.cfg;
    const bar = ctx.els.approvalBar;
    const stateKey = approval ? approval.state : 'pending';
    const st = cfg.approval.states[stateKey];
    bar.className = 'approval-bar ' + stateKey;
    bar.textContent = st.icon + '  ' + st.label;
    bar.hidden = false;

    const openCount = remarksMod.countOpen(remarks);
    ctx.els.triageBar.hidden = false;
    ctx.els.openCount.textContent = openCount + ' open · ' + remarks.length + ' total';
    ctx.els.reader.classList.toggle('show-open-only', !!ctx.els.openOnly.checked);
  }

  // ---- right notes rail ----------------------------------------------------

  function snippet(r) {
    const first = String(r.body || '').split('\n')[0].trim();
    if (!first) return '(no text)';
    return first.length > 90 ? first.slice(0, 89) + '…' : first;
  }

  function focusRemark(ctx, r) {
    const bq = ctx.els.reader.querySelector('blockquote[data-line-start="' + r.lineStart + '"]');
    if (bq) flashScroll(bq);
  }

  function buildRail(ctx, remarks) {
    const rail = ctx.els.remarkRail;
    if (!rail) return;
    clear(rail);
    if (!remarks.length) { rail.hidden = true; return; }
    rail.hidden = false;
    const cfg = ctx.cfg;

    rail.appendChild(h('div', { class: 'rail-head' },
      h('span', { class: 'rail-title' }, 'Notes'),
      h('span', { class: 'rail-count' }, remarksMod.countOpen(remarks) + ' open · ' + remarks.length)
    ));

    const list = h('ul', { class: 'rail-list' });
    remarks.forEach(function (r) {
      const typeLabel = (cfg.marker.types && cfg.marker.types[r.type]) || r.type;
      const meta = typeLabel + ' · ' + r.author +
        (r.replies && r.replies.length ? ' · ' + r.replies.length + ' ↳' : '');
      list.appendChild(h('li', {
        class: 'rail-item type-' + r.type + ' ' + (r.status === 'resolved' ? 'resolved' : 'open'),
        role: 'button', tabindex: '0', title: r.body || '',
        onclick: function () { focusRemark(ctx, r); },
        onkeydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusRemark(ctx, r); }
        }
      },
        h('span', { class: 'rail-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'rail-text' },
          h('span', { class: 'rail-meta' }, meta),
          h('span', { class: 'rail-snippet' }, snippet(r))
        )
      ));
    });
    rail.appendChild(list);
    rail.classList.toggle('show-open-only', !!ctx.els.openOnly.checked);
  }

  // ---- left outline (table of contents) tree -------------------------------

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'section';
  }
  function uniqueId(base, used) {
    let id = base, n = 2;
    while (used[id]) { id = base + '-' + n; n++; }
    used[id] = true;
    return id;
  }

  // Only the owning pane (single mode, focused) renders into the shared outline.
  function buildOutline(ctx, remarks) {
    const panel = ctx.els.outline;
    if (!panel) return;
    ctx._spy = [];
    clear(panel);
    if (!ctx.outline) { panel.hidden = true; return; }   // not this pane's job

    const heads = Array.prototype.slice.call(
      ctx.els.reader.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (heads.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;

    const levels = heads.map(function (el) { return parseInt(el.tagName.slice(1), 10); });
    const minLevel = Math.min.apply(null, levels);
    const used = {};

    panel.appendChild(h('div', { class: 'outline-head' }, 'Outline'));
    const list = h('div', { class: 'outline-list' });

    heads.forEach(function (hEl, idx) {
      if (!hEl.id) hEl.id = uniqueId(slugify(hEl.textContent), used);
      else used[hEl.id] = true;

      const line = parseInt(hEl.dataset.lineStart, 10);
      const nextLine = idx + 1 < heads.length ? parseInt(heads[idx + 1].dataset.lineStart, 10) : Infinity;
      let openHere = 0;
      if (!isNaN(line)) {
        openHere = remarks.filter(function (r) {
          return r.status === 'open' && r.lineStart >= line &&
                 (isNaN(nextLine) ? true : r.lineStart < nextLine);
        }).length;
      }

      const item = h('button', {
        class: 'outline-item',
        style: 'padding-left:' + (8 + (levels[idx] - minLevel) * 14) + 'px',
        title: hEl.textContent,
        onclick: function () { flashScroll(hEl); }
      },
        h('span', { class: 'outline-text' }, hEl.textContent),
        openHere ? h('span', { class: 'outline-badge', title: openHere + ' open' }, String(openHere)) : null
      );
      list.appendChild(item);
      ctx._spy.push({ el: hEl, item: item });
    });

    panel.appendChild(list);
    updateSpy(ctx);
  }

  // Scroll-spy: highlight the outline row for the heading currently on screen.
  function updateSpy(ctx) {
    const spy = ctx._spy;
    if (!spy || !spy.length) return;
    const top = ctx.els.reader.getBoundingClientRect().top + 8;
    let activeIdx = 0;
    for (let i = 0; i < spy.length; i++) {
      if (spy[i].el.getBoundingClientRect().top - top <= 0) activeIdx = i; else break;
    }
    spy.forEach(function (s, i) {
      const on = i === activeIdx;
      s.item.classList.toggle('active', on);
      if (on) ensureVisible(ctx.els.outline, s.item);
    });
  }

  function ensureVisible(panel, item) {
    if (!panel || typeof panel.scrollTop !== 'number') return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = top - 8;
    else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 8;
  }

  function scheduleSpy(ctx) {
    if (ctx._spyScheduled) return;
    ctx._spyScheduled = true;
    const raf = root.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { ctx._spyScheduled = false; updateSpy(ctx); });
  }

  // ---- triage: jump to next open remark ------------------------------------

  function jumpNextOpen(ctx) {
    const boxes = Array.prototype.slice.call(
      ctx.els.reader.querySelectorAll('blockquote.remark:not(.resolved)'));
    if (!boxes.length) return;
    const readerTop = ctx.els.reader.getBoundingClientRect().top + 12;
    let next = boxes.find(function (b) { return b.getBoundingClientRect().top > readerTop; });
    if (!next) next = boxes[0];
    flashScroll(next);
  }

  // ---- public API ----------------------------------------------------------

  // paint(ctx) — (re)render a pane. Pure painting; events are wired once by mountPane.
  function paint(ctx) {
    const reader = ctx.els.reader;
    reader.innerHTML = ctx.result.html;
    const remarks = remarksMod.parseRemarks(ctx.text, ctx.cfg);
    const approval = remarksMod.findApproval(ctx.text, ctx.cfg);
    decorate(ctx, remarks, approval);
    updateBars(ctx, remarks, approval);
    buildOutline(ctx, remarks);
    buildRail(ctx, remarks);
  }

  // mountPane(ctx, app) — wire this pane's in-reader interactions, once.
  function mountPane(ctx, app) {
    const reader = ctx.els.reader;

    reader.addEventListener('click', function (e) {
      app.focus(ctx);
      if (e.target.closest('.composer') || e.target.closest('.remark-actions') ||
          e.target.closest('.block-actions')) return;
      const block = e.target.closest('[data-line-end]');
      if (!block || !reader.contains(block)) { clearBlockActions(reader); return; }
      // remark/approval boxes have their own buttons — don't offer "add a note here".
      if (block.matches('blockquote.remark, blockquote.approval')) { clearBlockActions(reader); return; }
      showBlockActions(ctx, block);
    });

    reader.addEventListener('scroll', function () { scheduleSpy(ctx); }, { passive: true });

    ctx.els.openOnly.addEventListener('change', function () {
      const on = ctx.els.openOnly.checked;
      reader.classList.toggle('show-open-only', on);
      if (ctx.els.remarkRail) ctx.els.remarkRail.classList.toggle('show-open-only', on);
    });

    ctx.els.jumpNext.addEventListener('click', function () { jumpNextOpen(ctx); });

    // Dismiss the action bar when clicking away from any block (once, globally).
    if (!docWired) {
      docWired = true;
      document.addEventListener('mousedown', function (e) {
        if (e.target.closest('.block-actions') || e.target.closest('[data-line-end]') ||
            e.target.closest('.composer')) return;
        document.querySelectorAll('.block-actions').forEach(function (b) { b.remove(); });
        document.querySelectorAll('[data-line-end].annot-target').forEach(function (b) {
          b.classList.remove('annot-target');
        });
      });
    }
  }

  root.MDP.ui.reader = { paint: paint, mountPane: mountPane };
})(typeof self !== 'undefined' ? self : this);
