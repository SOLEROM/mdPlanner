/* dom.js — minimal DOM helpers shared by the UI modules. No dependencies. */
(function (root) {
  'use strict';
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'dataset') { for (const dk of Object.keys(v)) el.dataset[dk] = v[dk]; }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child == null) continue;
      if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
      else append(el, child);
    }
    return el;
  }
  function append(el, child) {
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  root.MDP = root.MDP || {};
  root.MDP.ui = root.MDP.ui || {};
  root.MDP.ui.dom = { h: h, clear: clear };
})(typeof self !== 'undefined' ? self : this);
