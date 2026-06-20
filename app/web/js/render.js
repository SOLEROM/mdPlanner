/*
 * render.js — markdown -> HTML pipeline.
 *
 * markdown-it and highlight.js are INJECTED (createRenderer(MarkdownIt, hljs, cfg))
 * rather than imported, so the browser passes the vendored globals and Node tests
 * pass the npm copies — the wiring is identical and testable. See PLAN.md §3.2, §4.
 *
 * Two jobs beyond plain rendering:
 *   1. Stamp every top-level block with data-line-start/-end (full-file line numbers)
 *      so the reader can splice a remark immediately after the tapped block.
 *   2. Leave ```mermaid fences as <pre class="mermaid"> for lazy client rendering.
 *
 * Security: html:false (no raw HTML injection); mermaid runs securityLevel:'strict'
 * in the browser. We never trust file content. See PLAN.md §4.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else { root.MDP = root.MDP || {}; root.MDP.render = factory(root.MDP.config); }
})(typeof self !== 'undefined' ? self : this, function (configMod) {
  'use strict';

  // Split a leading YAML frontmatter block. Returns { frontmatter, frontmatterLines, body }.
  // frontmatterLines counts the delimiters too, so body's line 0 == full-file line
  // `frontmatterLines` — used to offset markdown-it line maps back to file coordinates.
  function splitFrontmatter(text) {
    const lines = String(text).split('\n');
    if (lines.length === 0 || lines[0].trim() !== '---') {
      return { frontmatter: '', frontmatterLines: 0, body: String(text) };
    }
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return {
          frontmatter: lines.slice(1, i).join('\n'),
          frontmatterLines: i + 1,
          body: lines.slice(i + 1).join('\n')
        };
      }
    }
    return { frontmatter: '', frontmatterLines: 0, body: String(text) }; // unterminated -> treat as body
  }

  // Does the document contain a ```mermaid fence? Drives lazy-loading the heavy lib.
  function detectMermaid(text) {
    return /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b/.test(String(text));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Build a renderer bound to a markdown-it constructor, optional hljs, and config.
  function createRenderer(MarkdownIt, hljs, cfg) {
    const useHl = !!(cfg.render && cfg.render.syntaxHighlight) && !!hljs;

    const md = new MarkdownIt({
      html: false,        // never emit raw HTML from file content (XSS guard)
      linkify: true,
      breaks: false,
      typographer: false,
      highlight: function (str, lang) {
        if (lang === 'mermaid') return null; // handled by the fence rule below
        if (useHl && lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; }
          catch (e) { /* fall through to escaped default */ }
        }
        return '';
      }
    });

    // Custom fence rule: mermaid -> <pre class="mermaid">, everything else uses the
    // highlight option above. We re-implement just enough to keep data-line attrs.
    md.renderer.rules.fence = function (tokens, idx) {
      const token = tokens[idx];
      const info = token.info ? token.info.trim().split(/\s+/)[0] : '';
      const lineAttrs = attrString(token);
      if (info === 'mermaid') {
        return '<pre class="mermaid"' + lineAttrs + '>' + escapeHtml(token.content) + '</pre>\n';
      }
      let body;
      const hl = md.options.highlight ? md.options.highlight(token.content, info, '') : '';
      if (hl) body = '<code class="hljs language-' + escapeHtml(info) + '">' + hl + '</code>';
      else body = '<code' + (info ? ' class="language-' + escapeHtml(info) + '"' : '') + '>' + escapeHtml(token.content) + '</code>';
      return '<pre' + lineAttrs + '>' + body + '</pre>\n';
    };

    function attrString(token) {
      const s = token.attrGet('data-line-start');
      const e = token.attrGet('data-line-end');
      if (s == null && e == null) return '';
      return ' data-line-start="' + s + '" data-line-end="' + e + '"';
    }

    // Stamp top-level block-open (and self-contained) tokens with file-line numbers.
    function stampLines(tokens, offset) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.level !== 0 || !t.map) continue;
        if (t.nesting === 1 || t.nesting === 0) {
          t.attrSet('data-line-start', String(t.map[0] + offset));
          t.attrSet('data-line-end', String(t.map[1] + offset));
        }
      }
    }

    // Render a full file. Returns { html, hasMermaid, frontmatter }.
    function render(text) {
      const fm = splitFrontmatter(text);
      const env = {};
      const tokens = md.parse(fm.body, env);
      stampLines(tokens, fm.frontmatterLines);
      const html = md.renderer.render(tokens, md.options, env);
      return { html: html, hasMermaid: detectMermaid(fm.body), frontmatter: fm.frontmatter };
    }

    return { render: render, md: md };
  }

  return {
    splitFrontmatter: splitFrontmatter,
    detectMermaid: detectMermaid,
    escapeHtml: escapeHtml,
    createRenderer: createRenderer
  };
});
