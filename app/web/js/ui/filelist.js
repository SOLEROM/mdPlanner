/* filelist.js — flat searchable plan list with status + open-remark badges.
   Mode 1 only (Mode 2 uses the browser file picker). See PLAN.md §1 (#11). */
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

  function matches(f, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return labelOf(f).toLowerCase().indexOf(q) !== -1 || (f.title || '').toLowerCase().indexOf(q) !== -1;
  }

  function fileItem(f, opts) {
    const badge = f.openCount > 0
      ? dom.h('span', { class: 'fi-open', title: f.openCount + ' open remark(s)' }, '●' + f.openCount)
      : null;
    return dom.h('li', {
      class: 'file-item' + (f.external ? ' external' : '') + (f.path === opts.currentPath ? ' active' : ''),
      dataset: { path: f.path },
      title: f.title || f.path,
      onclick: function () { opts.onOpen(f.path); }
    },
      dom.h('span', { class: 'fi-status', title: f.status }, statusIcon(opts.cfg, f.status)),
      dom.h('span', { class: 'fi-path' }, labelOf(f)),
      badge
    );
  }

  // render(listEl, { files, cfg, query, currentPath, onOpen })
  function render(listEl, opts) {
    dom.clear(listEl);
    const files = (opts.files || []).filter(function (f) { return matches(f, opts.query); });
    if (files.length === 0) {
      listEl.appendChild(dom.h('li', { class: 'file-item', style: 'color:var(--fg-soft);cursor:default' },
        opts.query ? 'No plans match.' : 'No .md files found under the root.'));
      return;
    }
    const adhoc = files.filter(function (f) { return f.external; });
    const rooted = files.filter(function (f) { return !f.external; });
    if (adhoc.length) {
      listEl.appendChild(dom.h('li', { class: 'file-group' }, 'On-demand'));
      adhoc.forEach(function (f) { listEl.appendChild(fileItem(f, opts)); });
      if (rooted.length) listEl.appendChild(dom.h('li', { class: 'file-group' }, 'Root'));
    }
    rooted.forEach(function (f) { listEl.appendChild(fileItem(f, opts)); });
  }

  root.MDP.ui.filelist = { render: render };
})(typeof self !== 'undefined' ? self : this);
