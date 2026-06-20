/*
 * config.js — default config, deep-merge, validation, header rendering.
 *
 * Pure logic, no DOM. Loadable both in the browser (attaches to window.MDP.config)
 * and in Node (module.exports) so the same code is unit-tested under `node --test`.
 *
 * The config file lives at <root>/.mdplanner/config.json and rides the Syncthing
 * share so both devices parse markers identically. Every behavioural token the app
 * uses is sourced from here — changing an icon, prefix, colour or template needs no
 * code change. See PLAN.md §5.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MDP = root.MDP || {}; root.MDP.config = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The single source of truth for defaults. Mirrors PLAN.md §5 exactly.
  const DEFAULT_CONFIG = {
    rootPath: '/data/aproj/mdplaner',          // server (Mode 1) markdown root
    standaloneRoot: '../../plans',             // standalone (Mode 2) plans folder,
                                               // resolved relative to index.standalone.html
    author: 'me',
    fileGlob: '**/*.md',
    dateFormat: 'YYYY-MM-DD',

    marker: {
      blockquotePrefix: '> ',
      iconOpen: '🔴',
      iconResolved: '⚪',
      replyPrefix: '↳ ',
      types: { question: 'Q', remark: 'R', wrong: 'W', fix: 'F' },
      resolvedSuffix: ', resolved',
      headerTemplate: '**{type} ({author}{statusSuffix}):** '
    },

    approval: {
      states: {
        approved: { icon: '✅', label: 'APPROVED' },
        'changes-requested': { icon: '🟠', label: 'CHANGES REQUESTED' },
        pending: { icon: '⚪', label: 'PENDING' }
      },
      template: '> {icon} **{label}** — {author} · {date}'
    },

    render: { hideFrontmatter: true, syntaxHighlight: true, mermaid: true },

    ui: {
      theme: 'auto', fontScale: 1.0,
      remarkColor: '#e5484d', resolvedColor: '#8a8f98',
      // Per-type accent for each addable note. remark keeps the classic red so the
      // app's identity is unchanged; the others get distinct hues.
      typeColors: { question: '#3b82f6', remark: '#e5484d', wrong: '#f5a623', fix: '#30a46c' }
    },

    server: { host: '0.0.0.0', port: 8787 }
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Structural deep clone for config-shaped data (no functions/dates/cycles).
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // Recursively merge `over` onto a fresh copy of `base`. Never mutates inputs
  // (immutability rule): objects merge key-by-key, everything else is replaced.
  function deepMerge(base, over) {
    if (!isPlainObject(over)) return isPlainObject(base) ? clone(base) : over;
    const out = isPlainObject(base) ? clone(base) : {};
    for (const key of Object.keys(over)) {
      const bv = out[key];
      const ov = over[key];
      out[key] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : clone(ov);
    }
    return out;
  }

  // Produce an effective config = defaults <- user overrides.
  function mergeConfig(overrides) {
    return deepMerge(DEFAULT_CONFIG, overrides || {});
  }

  // Validate at the boundary. Returns { valid, errors:[...] }. Fails loud, never
  // silently coerces — callers decide whether to reject or fall back to defaults.
  function validateConfig(cfg) {
    const errors = [];
    const req = (cond, msg) => { if (!cond) errors.push(msg); };

    req(isPlainObject(cfg), 'config must be an object');
    if (!isPlainObject(cfg)) return { valid: false, errors };

    req(typeof cfg.author === 'string' && cfg.author.length > 0, 'author must be a non-empty string');
    req(cfg.rootPath === undefined || typeof cfg.rootPath === 'string', 'rootPath must be a string');
    req(cfg.standaloneRoot === undefined || typeof cfg.standaloneRoot === 'string', 'standaloneRoot must be a string');

    const m = cfg.marker;
    req(isPlainObject(m), 'marker must be an object');
    if (isPlainObject(m)) {
      for (const k of ['blockquotePrefix', 'iconOpen', 'iconResolved', 'replyPrefix', 'resolvedSuffix', 'headerTemplate']) {
        req(typeof m[k] === 'string', `marker.${k} must be a string`);
      }
      req(m.iconOpen !== m.iconResolved, 'marker.iconOpen and marker.iconResolved must differ');
      req(isPlainObject(m.types), 'marker.types must be an object');
      if (isPlainObject(m.types)) {
        for (const tk of ['question', 'remark', 'wrong', 'fix']) {
          req(typeof m.types[tk] === 'string' && m.types[tk].length > 0,
            `marker.types.${tk} must be a non-empty string`);
        }
        // The parser maps a label back to its type, so labels must be distinct.
        const labels = Object.keys(m.types).map(function (k) { return m.types[k]; });
        req(new Set(labels).size === labels.length, 'marker.types labels must be unique');
      }
      req(typeof m.headerTemplate === 'string' && m.headerTemplate.indexOf('{type}') !== -1,
        'marker.headerTemplate must contain {type}');
    }

    const a = cfg.approval;
    req(isPlainObject(a) && isPlainObject(a.states), 'approval.states must be an object');
    if (isPlainObject(a) && isPlainObject(a.states)) {
      for (const key of ['approved', 'changes-requested', 'pending']) {
        const st = a.states[key];
        req(isPlainObject(st) && typeof st.icon === 'string' && typeof st.label === 'string',
          `approval.states.${key} must have string icon and label`);
      }
      req(typeof a.template === 'string' && a.template.indexOf('{label}') !== -1,
        'approval.template must contain {label}');
    }

    const ui = cfg.ui;
    req(isPlainObject(ui), 'ui must be an object');
    if (isPlainObject(ui)) {
      req(typeof ui.fontScale === 'number' && ui.fontScale > 0 && ui.fontScale <= 4,
        'ui.fontScale must be a number in (0, 4]');
      req(['auto', 'light', 'dark'].indexOf(ui.theme) !== -1, "ui.theme must be 'auto', 'light' or 'dark'");
      req(/^#[0-9a-fA-F]{3,8}$/.test(String(ui.remarkColor)), 'ui.remarkColor must be a hex colour');
      if (isPlainObject(ui.typeColors)) {
        for (const tk of Object.keys(ui.typeColors)) {
          req(/^#[0-9a-fA-F]{3,8}$/.test(String(ui.typeColors[tk])),
            `ui.typeColors.${tk} must be a hex colour`);
        }
      }
    }

    const s = cfg.server;
    req(isPlainObject(s), 'server must be an object');
    if (isPlainObject(s)) {
      req(Number.isInteger(s.port) && s.port > 0 && s.port < 65536, 'server.port must be an integer in (0, 65536)');
      req(typeof s.host === 'string' && s.host.length > 0, 'server.host must be a non-empty string');
    }

    return { valid: errors.length === 0, errors };
  }

  // Render the per-remark header text, e.g. "**Q (me):** " or "**R (me, resolved):** ".
  // `type` is a key of marker.types ('question'|'remark'); `status` is 'open'|'resolved'.
  function renderHeader(cfg, type, author, status) {
    const m = cfg.marker;
    const typeLabel = m.types[type];
    if (typeLabel === undefined) throw new Error('unknown remark type: ' + type);
    const statusSuffix = status === 'resolved' ? m.resolvedSuffix : '';
    return m.headerTemplate
      .split('{type}').join(typeLabel)
      .split('{author}').join(author)
      .split('{statusSuffix}').join(statusSuffix);
  }

  return { DEFAULT_CONFIG, clone, deepMerge, mergeConfig, validateConfig, renderHeader, isPlainObject };
});
