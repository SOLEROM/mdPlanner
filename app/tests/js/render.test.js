'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const config = require('../../web/js/config.js');
const Render = require('../../web/js/render.js');

const cfg = config.mergeConfig({});

test('splitFrontmatter separates YAML and counts delimiter lines', () => {
  const text = '---\nnoteId: x\ntags: [a]\n---\n\n# Body\n';
  const fm = Render.splitFrontmatter(text);
  assert.equal(fm.frontmatter, 'noteId: x\ntags: [a]');
  assert.equal(fm.frontmatterLines, 4);
  assert.ok(fm.body.startsWith('\n# Body'));
});

test('splitFrontmatter ignores a non-leading --- ', () => {
  const text = '# Title\n\n---\n';
  const fm = Render.splitFrontmatter(text);
  assert.equal(fm.frontmatterLines, 0);
  assert.equal(fm.frontmatter, '');
});

test('detectMermaid finds mermaid fences only', () => {
  assert.equal(Render.detectMermaid('```mermaid\ngraph TD;A-->B\n```'), true);
  assert.equal(Render.detectMermaid('```js\nconst a=1\n```'), false);
});

test('createRenderer stamps file-relative line numbers (offset past frontmatter)', () => {
  const text = '---\nnoteId: x\n---\n\n# Heading\n\npara\n';
  const r = Render.createRenderer(MarkdownIt, hljs, cfg);
  const out = r.render(text);
  // frontmatter is 3 lines, so the H1 (body line 1) maps to file line 4.
  assert.ok(out.html.includes('data-line-start="4"'), out.html);
  assert.ok(/<h1[^>]*data-line-end="5"/.test(out.html), out.html);
});

test('mermaid fences become <pre class="mermaid"> and are flagged', () => {
  const text = '# T\n\n```mermaid\ngraph TD;A-->B\n```\n';
  const r = Render.createRenderer(MarkdownIt, hljs, cfg);
  const out = r.render(text);
  assert.ok(out.hasMermaid);
  assert.ok(out.html.includes('<pre class="mermaid"'));
  assert.ok(out.html.includes('graph TD;A--&gt;B')); // escaped, not raw
});

test('raw HTML in the source is neutralised (html:false)', () => {
  const text = '# T\n\nHello <script>alert(1)</script> world\n';
  const r = Render.createRenderer(MarkdownIt, hljs, cfg);
  const out = r.render(text);
  assert.ok(!out.html.includes('<script>'), out.html);
  assert.ok(out.html.includes('&lt;script&gt;'));
});

test('syntax highlighting wraps known languages with hljs', () => {
  const text = '```js\nconst a = 1;\n```\n';
  const r = Render.createRenderer(MarkdownIt, hljs, cfg);
  const out = r.render(text);
  assert.ok(out.html.includes('class="hljs language-js"'), out.html);
});
