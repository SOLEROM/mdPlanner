/* configtab.js — a paged form over the config file. Save writes it (server or
   localStorage) and the app re-parses/re-renders live. Every behavioural token is
   editable here, so nothing needs a source change. See PLAN.md §5.

   The form is split into pages shown one at a time, navigated from a tree in the
   sidebar (rendered into navEl): a General page for all shared config, plus one
   page per note type (Question / Remark / Wrong / Fix) carrying that type's label
   token, accent colour, and its bank of predefined "common note" lines. Edits are
   held in a single draft that survives page switches; Save validates + persists it. */
(function (root) {
  'use strict';
  const dom = root.MDP.ui.dom;
  const h = dom.h;
  const clear = dom.clear;
  const cfgMod = root.MDP.config;

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  // Immutable set: returns a new object with path set to value.
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const copy = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
    if (keys.length === 1) { copy[keys[0]] = value; return copy; }
    copy[keys[0]] = setPath(obj[keys[0]] || {}, keys.slice(1).join('.'), value);
    return copy;
  }

  // The General page — all config that isn't tied to a single note type. The
  // per-type label tokens (marker.types.*) and colours (ui.typeColors.*) live on
  // their own pages instead, alongside that type's note bank.
  const GENERAL_FIELDS = [
    { section: 'General' },
    { path: 'author', label: 'Author label', type: 'text' },
    { path: 'rootPath', label: 'Server root (Mode 1)', type: 'text',
      hint: 'Folder to list (relative to the project, e.g. "plans"). Restart the server to apply.' },
    { path: 'standaloneRoot', label: 'Standalone root (Mode 2)', type: 'text' },

    { section: 'Remark markers' },
    { path: 'marker.iconOpen', label: 'Open icon', type: 'text' },
    { path: 'marker.iconResolved', label: 'Resolved icon', type: 'text' },
    { path: 'marker.blockquotePrefix', label: 'Blockquote prefix', type: 'text' },
    { path: 'marker.replyPrefix', label: 'Reply prefix', type: 'text' },
    { path: 'marker.resolvedSuffix', label: 'Resolved suffix', type: 'text' },
    { path: 'marker.headerTemplate', label: 'Header template', type: 'text' },

    { section: 'Appearance' },
    { path: 'ui.theme', label: 'Theme', type: 'select', options: ['auto', 'light', 'dark'] },
    { path: 'ui.fontScale', label: 'Font scale', type: 'number', step: '0.1', min: '0.6', max: '3' },
    { path: 'ui.remarkColor', label: 'Accent colour', type: 'color' },
    { path: 'ui.resolvedColor', label: 'Resolved colour', type: 'color' },

    { section: 'Rendering' },
    { path: 'render.hideFrontmatter', label: 'Hide frontmatter', type: 'checkbox' },
    { path: 'render.syntaxHighlight', label: 'Syntax highlighting', type: 'checkbox' },
    { path: 'render.mermaid', label: 'Mermaid diagrams', type: 'checkbox' },

    { section: 'Server (Mode 1)' },
    { path: 'server.host', label: 'Bind host', type: 'text' },
    { path: 'server.port', label: 'Port', type: 'number', step: '1', min: '1', max: '65535' }
  ];

  // Friendly page titles for the known types; any new type falls back to its
  // capitalised key so it still gets a page (and bank) for free.
  const TYPE_TITLES = { question: 'Questions', remark: 'Remarks', wrong: 'Wrong', fix: 'Fix' };
  function typeTitle(type) {
    return TYPE_TITLES[type] || (type.charAt(0).toUpperCase() + type.slice(1));
  }

  // render(formEl, navEl, { cfg, onSave(cfg), onCancel() })
  function render(formEl, navEl, opts) {
    let draft = cfgMod.clone(opts.cfg);   // single working copy; survives page switches
    let inputs = {};                      // simple-field inputs of the visible page
    let current = null;

    const types = (draft.marker && draft.marker.types) || {};
    const pages = [{ id: 'general', title: 'General', fields: GENERAL_FIELDS }].concat(
      Object.keys(types).map(function (type) {
        return {
          id: 'type:' + type, type: type, title: typeTitle(type),
          fields: [
            { path: 'marker.types.' + type, label: 'Label token', type: 'text',
              hint: 'Short tag shown in the note header (e.g. Q). Must be unique across types.' },
            { path: 'ui.typeColors.' + type, label: 'Accent colour', type: 'color' }
          ]
        };
      })
    );

    const errorBox = h('div', { class: 'cfg-errors', hidden: true });
    const actions = h('div', { class: 'cfg-actions' },
      h('button', { class: 'btn primary', onclick: save }, 'Save & apply'),
      h('button', { class: 'btn', onclick: function () { opts.onCancel(); } }, 'Close')
    );

    // ---- field rows ----------------------------------------------------------
    function buildFieldRow(f) {
      const value = getPath(draft, f.path);
      let input;
      if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox' });
        input.checked = !!value;
      } else if (f.type === 'select') {
        input = h('select', {}, f.options.map(function (o) {
          return h('option', { value: o, selected: o === value }, o);
        }));
      } else if (f.type === 'color') {
        input = h('input', { type: 'color', value: String(value) });
      } else {
        input = h('input', { type: f.type === 'number' ? 'number' : 'text', value: String(value) });
        if (f.step) input.step = f.step;
        if (f.min) input.min = f.min;
        if (f.max) input.max = f.max;
      }
      inputs[f.path] = { input: input, type: f.type };
      const field = h('div', { class: 'cfg-field' }, h('label', {}, f.label), input);
      if (f.hint) field.appendChild(h('small', { class: 'cfg-hint' }, f.hint));
      return field;
    }

    function renderFields(container, fields) {
      let section = null;
      fields.forEach(function (f) {
        if (f.section) {
          section = h('div', { class: 'cfg-section' }, h('h3', {}, f.section));
          container.appendChild(section);
          return;
        }
        (section || container).appendChild(buildFieldRow(f));
      });
    }

    // Read the visible page's simple-field inputs back into the draft. Bank edits
    // write through immediately, so they're already in the draft.
    function collectCurrentPage() {
      Object.keys(inputs).forEach(function (path) {
        const spec = inputs[path];
        let v;
        if (spec.type === 'checkbox') v = spec.input.checked;
        else if (spec.type === 'number') v = parseFloat(spec.input.value);
        else v = spec.input.value;
        draft = setPath(draft, path, v);
      });
    }

    // ---- per-type note bank editor ------------------------------------------
    function bankArr(type) {
      const arr = draft.noteBank && draft.noteBank[type];
      return Array.isArray(arr) ? arr : [];
    }
    function setBank(type, arr) { draft = setPath(draft, 'noteBank.' + type, arr); }

    function renderBankList(listEl, type) {
      clear(listEl);
      const arr = bankArr(type);
      if (!arr.length) {
        listEl.appendChild(h('div', { class: 'bank-empty' }, 'No common notes yet — add one below.'));
        return;
      }
      arr.forEach(function (line, i) {
        const input = h('input', { type: 'text', value: line, 'aria-label': 'Common note ' + (i + 1) });
        input.addEventListener('input', function () {
          const next = bankArr(type).slice();
          next[i] = input.value;
          setBank(type, next);
        });
        function move(dir) {
          const next = bankArr(type).slice();
          const j = i + dir;
          if (j < 0 || j >= next.length) return;
          const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
          setBank(type, next);
          renderBankList(listEl, type);
        }
        const row = h('div', { class: 'bank-row' },
          input,
          h('button', { class: 'icon-btn bank-move', title: 'Move up', disabled: i === 0,
            onclick: function () { move(-1); } }, '▲'),
          h('button', { class: 'icon-btn bank-move', title: 'Move down', disabled: i === arr.length - 1,
            onclick: function () { move(1); } }, '▼'),
          h('button', { class: 'icon-btn danger bank-del', title: 'Delete', onclick: function () {
            const next = bankArr(type).slice();
            next.splice(i, 1);
            setBank(type, next);
            renderBankList(listEl, type);
          } }, '✕')
        );
        listEl.appendChild(row);
      });
    }

    function renderBankEditor(container, type) {
      const section = h('div', { class: 'cfg-section' }, h('h3', {}, 'Common notes'));
      section.appendChild(h('small', { class: 'cfg-hint cfg-hint-block' },
        'Predefined lines for the “＋ Common note” dropdown when adding a ' +
        typeTitle(type).replace(/s$/, '').toLowerCase() + ' note. Reorder, edit or delete; ' +
        'changes are saved with the form.'));
      const listEl = h('div', { class: 'bank-list' });
      section.appendChild(listEl);
      renderBankList(listEl, type);

      const addInput = h('input', { type: 'text', placeholder: 'Add a common note…',
        'aria-label': 'New common note' });
      const addBtn = h('button', { class: 'btn small', onclick: function () {
        const v = addInput.value.trim();
        if (!v) { addInput.focus(); return; }
        setBank(type, bankArr(type).concat([v]));
        addInput.value = '';
        renderBankList(listEl, type);
        addInput.focus();
      } }, '＋ Add');
      addInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
      });
      section.appendChild(h('div', { class: 'bank-add' }, addInput, addBtn));
      container.appendChild(section);
    }

    // ---- pages ---------------------------------------------------------------
    function pageById(id) { return pages.filter(function (p) { return p.id === id; })[0]; }

    function renderNav() {
      clear(navEl);
      navEl.appendChild(h('div', { class: 'config-nav-head' }, 'Settings'));
      pages.forEach(function (p) {
        navEl.appendChild(h('button', {
          class: 'config-nav-item' + (p.id === current ? ' active' : ''),
          onclick: function () { selectPage(p.id); }
        }, p.title));
      });
    }

    function renderPage(id) {
      inputs = {};
      clear(formEl);
      const page = pageById(id);
      formEl.appendChild(h('h2', { class: 'cfg-page-title' }, page.title));
      renderFields(formEl, page.fields);
      if (page.type) renderBankEditor(formEl, page.type);
      formEl.appendChild(errorBox);
      formEl.appendChild(actions);
    }

    function selectPage(id) {
      if (current && current !== id) collectCurrentPage();
      current = id;
      renderNav();
      renderPage(id);
    }

    function save() {
      collectCurrentPage();
      const check = cfgMod.validateConfig(draft);
      if (!check.valid) {
        errorBox.hidden = false;
        errorBox.textContent = 'Cannot save:\n• ' + check.errors.join('\n• ');
        return;
      }
      errorBox.hidden = true;
      opts.onSave(draft);
    }

    selectPage('general');
  }

  root.MDP.ui.configtab = { render: render };
})(typeof self !== 'undefined' ? self : this);
