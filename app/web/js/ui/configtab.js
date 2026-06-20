/* configtab.js — a form over the config file. Save writes it (server or
   localStorage) and the app re-parses/re-renders live. Every behavioural token is
   editable here, so nothing needs a source change. See PLAN.md §5. */
(function (root) {
  'use strict';
  const dom = root.MDP.ui.dom;
  const h = dom.h;
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

  // Field schema — the knobs we surface (others remain editable via the JSON file).
  const FIELDS = [
    { section: 'General' },
    { path: 'author', label: 'Author label', type: 'text' },
    { path: 'rootPath', label: 'Server root (Mode 1)', type: 'text' },
    { path: 'standaloneRoot', label: 'Standalone root (Mode 2)', type: 'text' },

    { section: 'Remark markers' },
    { path: 'marker.iconOpen', label: 'Open icon', type: 'text' },
    { path: 'marker.iconResolved', label: 'Resolved icon', type: 'text' },
    { path: 'marker.blockquotePrefix', label: 'Blockquote prefix', type: 'text' },
    { path: 'marker.replyPrefix', label: 'Reply prefix', type: 'text' },
    { path: 'marker.types.question', label: 'Question label', type: 'text' },
    { path: 'marker.types.remark', label: 'Remark label', type: 'text' },
    { path: 'marker.types.wrong', label: 'Wrong label', type: 'text' },
    { path: 'marker.types.fix', label: 'Fix label', type: 'text' },
    { path: 'marker.resolvedSuffix', label: 'Resolved suffix', type: 'text' },
    { path: 'marker.headerTemplate', label: 'Header template', type: 'text' },

    { section: 'Appearance' },
    { path: 'ui.theme', label: 'Theme', type: 'select', options: ['auto', 'light', 'dark'] },
    { path: 'ui.fontScale', label: 'Font scale', type: 'number', step: '0.1', min: '0.6', max: '3' },
    { path: 'ui.remarkColor', label: 'Accent colour', type: 'color' },
    { path: 'ui.resolvedColor', label: 'Resolved colour', type: 'color' },
    { path: 'ui.typeColors.question', label: 'Question colour', type: 'color' },
    { path: 'ui.typeColors.remark', label: 'Remark colour', type: 'color' },
    { path: 'ui.typeColors.wrong', label: 'Wrong colour', type: 'color' },
    { path: 'ui.typeColors.fix', label: 'Fix colour', type: 'color' },

    { section: 'Rendering' },
    { path: 'render.hideFrontmatter', label: 'Hide frontmatter', type: 'checkbox' },
    { path: 'render.syntaxHighlight', label: 'Syntax highlighting', type: 'checkbox' },
    { path: 'render.mermaid', label: 'Mermaid diagrams', type: 'checkbox' },

    { section: 'Server (Mode 1)' },
    { path: 'server.host', label: 'Bind host', type: 'text' },
    { path: 'server.port', label: 'Port', type: 'number', step: '1', min: '1', max: '65535' }
  ];

  // render(formEl, { cfg, onSave(cfg), onCancel() })
  function render(formEl, opts) {
    dom.clear(formEl);
    const inputs = {};
    let section = null;

    FIELDS.forEach(function (f) {
      if (f.section) {
        section = h('div', { class: 'cfg-section' }, h('h3', {}, f.section));
        formEl.appendChild(section);
        return;
      }
      const value = getPath(opts.cfg, f.path);
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
      section.appendChild(h('div', { class: 'cfg-field' }, h('label', {}, f.label), input));
    });

    const errorBox = h('div', { class: 'cfg-errors', hidden: true });

    function collect() {
      let next = cfgMod.clone(opts.cfg);
      Object.keys(inputs).forEach(function (path) {
        const spec = inputs[path];
        let v;
        if (spec.type === 'checkbox') v = spec.input.checked;
        else if (spec.type === 'number') v = parseFloat(spec.input.value);
        else v = spec.input.value;
        next = setPath(next, path, v);
      });
      return next;
    }

    const saveBtn = h('button', { class: 'btn primary', onclick: function () {
      const next = collect();
      const check = cfgMod.validateConfig(next);
      if (!check.valid) {
        errorBox.hidden = false;
        errorBox.textContent = 'Cannot save:\n• ' + check.errors.join('\n• ');
        return;
      }
      errorBox.hidden = true;
      opts.onSave(next);
    } }, 'Save & apply');

    const cancelBtn = h('button', { class: 'btn', onclick: function () { opts.onCancel(); } }, 'Close');

    formEl.appendChild(errorBox);
    formEl.appendChild(h('div', { class: 'cfg-actions' }, saveBtn, cancelBtn));
  }

  root.MDP.ui.configtab = { render: render };
})(typeof self !== 'undefined' ? self : this);
