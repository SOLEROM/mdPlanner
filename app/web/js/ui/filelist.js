/* filelist.js — flat searchable plan list with status + open-remark badges.
   Mode 1 only (Mode 2 uses the browser file picker). See PLAN.md §1 (#11).

   Each row carries a "hide" affordance: hiding removes a plan from the listing
   without touching the file. Hidden plans are a *view* preference owned by app.js
   (persisted to localStorage as `mdp.hidden`); this module only filters them out,
   renders the per-row toggle, and a footer to reveal/unhide them again. */
(function (root) {
  'use strict';
  const dom = root.MDP.ui.dom;

  function statusIcon(cfg, status) {
    const st = cfg.approval.states[status];
    return st ? st.icon : '⚪';
  }

  // The label shown / searched for an entry: external plans show a friendly name
  // (basename) instead of their internal `adhoc:<id>` routing path.
  function labelOf(f) { return f.name || f.path; }

  // Stable key a hide is remembered by. External (adhoc) routing paths are
  // `adhoc:<id>` and the id is per-server-session, so key those by their friendly
  // label — a hide then survives a server restart that re-mints the id.
  function hideKey(f) { return f.external ? 'ext:' + labelOf(f) : f.path; }

  function matches(f, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return labelOf(f).toLowerCase().indexOf(q) !== -1 || (f.title || '').toLowerCase().indexOf(q) !== -1;
  }

  function fileItem(f, opts, hidden) {
    const isHidden = hidden.has(hideKey(f));
    const badge = f.openCount > 0
      ? dom.h('span', { class: 'fi-open', title: f.openCount + ' open remark(s)' }, '●' + f.openCount)
      : null;
    const hideBtn = dom.h('button', {
      class: 'fi-hide',
      title: isHidden ? 'Unhide — show this plan in the list again'
                      : 'Hide from the list (does not delete the file)',
      'aria-label': isHidden ? 'Unhide plan' : 'Hide plan',
      onclick: function (ev) {
        ev.stopPropagation();   // don't open the plan when toggling its visibility
        if (opts.onToggleHide) opts.onToggleHide(hideKey(f));
      }
    }, isHidden ? '↺' : '⊘');
    return dom.h('li', {
      class: 'file-item' + (f.external ? ' external' : '') + (isHidden ? ' hidden-row' : '')
        + (f.path === opts.currentPath ? ' active' : ''),
      dataset: { path: f.path },
      title: f.title || f.path,
      onclick: function () { opts.onOpen(f.path); }
    },
      dom.h('span', { class: 'fi-status', title: f.status }, statusIcon(opts.cfg, f.status)),
      dom.h('span', { class: 'fi-path' }, labelOf(f)),
      badge,
      hideBtn
    );
  }

  function hiddenToggle(count, showHidden, opts) {
    const noun = ' hidden plan' + (count === 1 ? '' : 's');
    return dom.h('li', {
      class: 'file-hidden-toggle',
      role: 'button',
      tabindex: '0',
      onclick: function () { if (opts.onToggleShowHidden) opts.onToggleShowHidden(); }
    }, showHidden ? '▾ hide ' + count + noun : '▸ show ' + count + noun);
  }

  // render(listEl, { files, cfg, query, currentPath, hidden, showHidden,
  //                  onOpen, onToggleHide, onToggleShowHidden })
  function render(listEl, opts) {
    dom.clear(listEl);
    const hidden = opts.hidden || new Set();
    const showHidden = !!opts.showHidden;
    const matched = (opts.files || []).filter(function (f) { return matches(f, opts.query); });
    const hiddenCount = matched.filter(function (f) { return hidden.has(hideKey(f)); }).length;
    // Hidden rows are only listed when revealed; otherwise they're dropped entirely.
    const shown = showHidden ? matched : matched.filter(function (f) { return !hidden.has(hideKey(f)); });

    if (shown.length === 0) {
      const msg = opts.query ? 'No plans match.'
        : (hiddenCount ? 'All plans are hidden.' : 'No .md files found under the root.');
      listEl.appendChild(dom.h('li', { class: 'file-item', style: 'color:var(--fg-soft);cursor:default' }, msg));
    } else {
      const adhoc = shown.filter(function (f) { return f.external; });
      const rooted = shown.filter(function (f) { return !f.external; });
      if (adhoc.length) {
        listEl.appendChild(dom.h('li', { class: 'file-group' }, 'On-demand'));
        adhoc.forEach(function (f) { listEl.appendChild(fileItem(f, opts, hidden)); });
        if (rooted.length) listEl.appendChild(dom.h('li', { class: 'file-group' }, 'Root'));
      }
      rooted.forEach(function (f) { listEl.appendChild(fileItem(f, opts, hidden)); });
    }

    if (hiddenCount) listEl.appendChild(hiddenToggle(hiddenCount, showHidden, opts));
  }

  root.MDP.ui.filelist = { render: render };
})(typeof self !== 'undefined' ? self : this);
