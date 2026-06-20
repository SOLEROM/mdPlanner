/*
 * remarks.js — the heart of MD Planner.
 *
 * Pure functions over raw markdown TEXT. No DOM, no I/O. The same splice/parse
 * logic runs identically in Mode 1 (server) and Mode 2 (standalone) — only the
 * persistence (storage.js) differs. Because it is pure text in / text out, it is
 * fully unit-testable under `node --test`. See PLAN.md §2.
 *
 * Remarks are real markdown blockquotes distinguished by a sentinel icon:
 *
 *     > 🔴 **Q (me):** why three planes and not two?
 *     > ↳ **claude:** consolidated to two; see §0.
 *
 * Every token (prefix, icons, header template, reply prefix) is config-driven.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else { root.MDP = root.MDP || {}; root.MDP.remarks = factory(root.MDP.config); }
})(typeof self !== 'undefined' ? self : this, function (configMod) {
  'use strict';

  const renderHeader = configMod.renderHeader;

  function splitLines(text) { return String(text).split('\n'); }
  function isBlockquoteLine(line) { return /^[ \t]*>/.test(line); }

  // Mark lines that live inside fenced code blocks (``` or ~~~), so example
  // markers documented inside fences are never mistaken for real remarks.
  function codeMask(lines) {
    const mask = new Array(lines.length).fill(false);
    let fence = null; // { char, len }
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        mask[i] = true;
        if (m && m[1].charAt(0) === fence.char && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      } else if (m) {
        fence = { char: m[1].charAt(0), len: m[1].length };
        mask[i] = true;
      }
    }
    return mask;
  }
  // Strip one level of "> " (or ">") plus a single optional space.
  function stripPrefix(line) { return line.replace(/^[ \t]*>[ \t]?/, ''); }
  // Match a leading **bold** run, returning [whole, inner] or null.
  function matchBold(s) { return s.match(/^\*\*(.+?)\*\*[ \t]?/); }

  // ---- parsing -------------------------------------------------------------

  // Parse a single blockquote block (array of raw lines) into a remark, or null
  // if it is not a remark (plain plan blockquote, or the approval banner).
  function parseRemarkBlock(blockLines, cfg) {
    const m = cfg.marker;
    const first = stripPrefix(blockLines[0]);

    let icon = null;
    if (first.indexOf(m.iconOpen) === 0) icon = m.iconOpen;
    else if (first.indexOf(m.iconResolved) === 0) icon = m.iconResolved;
    if (icon === null) return null;

    const afterIcon = first.slice(icon.length).replace(/^[ \t]/, '');
    const bold = matchBold(afterIcon);
    if (!bold) return null;

    // Inner header looks like "Q (me)" or "R (me, resolved)", optionally with a
    // trailing colon. The type label may be a multi-word phrase ("that is Wrong,
    // do:"), so anchor on the *last* parenthesised run (the author group, which
    // can't contain ")") and take everything before it as the label.
    const inner = bold[1].match(/^(.*)\(([^)]*)\):?[ \t]*$/);
    if (!inner) return null;

    // The header template puts one space before "(", and a configured label may
    // carry its own trailing space — so compare with trailing whitespace trimmed
    // off both sides to map the label back to its type key.
    const typeLabel = inner[1].replace(/[ \t]+$/, '');
    let type = null;
    for (const key of Object.keys(m.types)) {
      if (m.types[key].replace(/[ \t]+$/, '') === typeLabel) { type = key; break; }
    }
    if (type === null) return null; // unknown type ⇒ not one of our remarks

    let author = inner[2];
    let status = icon === m.iconResolved ? 'resolved' : 'open';
    if (m.resolvedSuffix && author.endsWith(m.resolvedSuffix)) {
      author = author.slice(0, author.length - m.resolvedSuffix.length);
      status = 'resolved';
    }

    const inlineBody = afterIcon.slice(bold[0].length);

    // Remaining lines are either reply lines or continuation body lines.
    const bodyParts = [inlineBody];
    const replies = [];
    let cursor = { kind: 'body' };
    for (let k = 1; k < blockLines.length; k++) {
      const content = stripPrefix(blockLines[k]);
      if (m.replyPrefix && content.indexOf(m.replyPrefix) === 0) {
        const rWhole = content.slice(m.replyPrefix.length);
        const rBold = matchBold(rWhole);
        const who = rBold ? rBold[1].replace(/:$/, '') : '';
        const rBody = rBold ? rWhole.slice(rBold[0].length) : rWhole;
        replies.push({ who: who, body: rBody });
        cursor = { kind: 'reply', idx: replies.length - 1 };
      } else if (cursor.kind === 'body') {
        bodyParts.push(content);
      } else {
        replies[cursor.idx].body += '\n' + content;
      }
    }

    const body = bodyParts.join('\n').replace(/^\n+|\n+$/g, '');
    return {
      type: type,
      author: author,
      status: status,
      icon: icon,
      inlineBody: inlineBody,
      body: body,
      replies: replies,
      prefix: m.blockquotePrefix
    };
  }

  // Parse all remarks in a file. Each carries lineStart (0-based, first blockquote
  // line) and lineEnd (exclusive) so callers can locate it for toggle/reply/render.
  function parseRemarks(text, cfg) {
    const lines = splitLines(text);
    const mask = codeMask(lines);
    const remarks = [];
    let i = 0;
    while (i < lines.length) {
      if (!isBlockquoteLine(lines[i]) || mask[i]) { i++; continue; }
      let j = i;
      while (j < lines.length && isBlockquoteLine(lines[j]) && !mask[j]) j++;
      const parsed = parseRemarkBlock(lines.slice(i, j), cfg);
      if (parsed) remarks.push(Object.assign({}, parsed, { lineStart: i, lineEnd: j }));
      i = j;
    }
    return remarks;
  }

  function countOpen(remarks) { return remarks.filter(function (r) { return r.status === 'open'; }).length; }

  // ---- building & splicing -------------------------------------------------

  // Build the raw markdown for a new remark blockquote (no surrounding blanks).
  function buildRemark(cfg, opts) {
    const status = opts.status || 'open';
    const author = opts.author != null ? opts.author : cfg.author;
    const m = cfg.marker;
    const icon = status === 'resolved' ? m.iconResolved : m.iconOpen;
    const header = renderHeader(cfg, opts.type, author, status);
    const pfx = m.blockquotePrefix;
    const bodyLines = String(opts.body == null ? '' : opts.body).split('\n');
    const firstLine = pfx + icon + ' ' + header + (bodyLines[0] || '');
    const rest = bodyLines.slice(1).map(function (l) { return pfx + l; });
    return [firstLine].concat(rest).join('\n');
  }

  // Insert a block of markdown immediately after the line at `lastLineIdx`
  // (0-based, inclusive — the last content line of the tapped block), keeping
  // exactly one blank line on each side. Returns new text; never mutates input.
  function insertAfterLine(text, lastLineIdx, blockText) {
    const lines = splitLines(text);
    const idx = Math.max(-1, Math.min(lastLineIdx, lines.length - 1));
    const before = lines.slice(0, idx + 1);
    const after = lines.slice(idx + 1);
    const out = before.slice();
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push.apply(out, blockText.split('\n'));
    if (after.length && after[0].trim() !== '') out.push('');
    return out.concat(after).join('\n');
  }

  // Convenience: build a remark and splice it after the given block.
  function addRemarkAfterLine(text, lastLineIdx, cfg, opts) {
    return insertAfterLine(text, lastLineIdx, buildRemark(cfg, opts));
  }

  // ---- mutation by location ------------------------------------------------

  // Rebuild the header (first) line of a remark for a given status.
  function headerLine(cfg, remark, status) {
    const m = cfg.marker;
    const icon = status === 'resolved' ? m.iconResolved : m.iconOpen;
    const header = renderHeader(cfg, remark.type, remark.author, status);
    const pfx = remark.prefix || m.blockquotePrefix;
    return pfx + icon + ' ' + header + (remark.inlineBody || '');
  }

  // Replace a single line by index, returning new text (no in-place mutation).
  function replaceLine(text, idx, newLine) {
    return splitLines(text).map(function (l, i) { return i === idx ? newLine : l; }).join('\n');
  }

  // Flip a remark between open/resolved by rewriting only its header line.
  function toggleResolved(text, remark, cfg) {
    const newStatus = remark.status === 'resolved' ? 'open' : 'resolved';
    return replaceLine(text, remark.lineStart, headerLine(cfg, remark, newStatus));
  }

  // Set a remark to an explicit status (idempotent).
  function setStatus(text, remark, status, cfg) {
    if (remark.status === status) return text;
    return replaceLine(text, remark.lineStart, headerLine(cfg, remark, status));
  }

  // Append a threaded reply inside the same blockquote, after its last line.
  function addReply(text, remark, who, replyBody, cfg) {
    const m = cfg.marker;
    const pfx = remark.prefix || m.blockquotePrefix;
    const bodyLines = String(replyBody == null ? '' : replyBody).split('\n');
    const firstLine = pfx + m.replyPrefix + '**' + who + ':** ' + (bodyLines[0] || '');
    const rest = bodyLines.slice(1).map(function (l) { return pfx + l; });
    const replyLines = [firstLine].concat(rest);
    const lines = splitLines(text);
    const out = lines.slice(0, remark.lineEnd).concat(replyLines, lines.slice(remark.lineEnd));
    return out.join('\n');
  }

  // Remove an entire remark blockquote (header + body + replies) and collapse the
  // blank line it left behind, so deleting leaves no trace. Returns new text.
  function removeRemark(text, remark) {
    const lines = splitLines(text);
    let before = lines.slice(0, remark.lineStart);
    let after = lines.slice(remark.lineEnd);
    if (before.length && after.length &&
        before[before.length - 1].trim() === '' && after[0].trim() === '') {
      after = after.slice(1);                                  // collapse the double blank
    } else if (!before.length) {
      while (after.length && after[0].trim() === '') after = after.slice(1);          // top of file
    } else if (!after.length) {
      while (before.length && before[before.length - 1].trim() === '') before = before.slice(0, -1); // end of file
    }
    return before.concat(after).join('\n');
  }

  // ---- approval banner -----------------------------------------------------

  function buildApprovalLine(cfg, stateKey, author, date) {
    const st = cfg.approval.states[stateKey];
    if (!st) throw new Error('unknown approval state: ' + stateKey);
    return cfg.approval.template
      .split('{icon}').join(st.icon)
      .split('{label}').join(st.label)
      .split('{author}').join(author != null ? author : cfg.author)
      .split('{date}').join(date || '');
  }

  // Locate an existing approval banner line. Returns { lineIdx, state } or null.
  function findApproval(text, cfg) {
    const lines = splitLines(text);
    const mask = codeMask(lines);
    const states = cfg.approval.states;
    let i = 0;
    while (i < lines.length) {
      if (!isBlockquoteLine(lines[i]) || mask[i]) { i++; continue; }
      const content = stripPrefix(lines[i]); // inspect only the first line of each block
      for (const key of Object.keys(states)) {
        const st = states[key];
        if (content.indexOf(st.icon) !== 0) continue;
        // the bold label must follow the icon immediately (per approval.template),
        // so a remark body that merely mentions the label is not matched.
        const rest = content.slice(st.icon.length).replace(/^\s+/, '');
        if (rest.indexOf('**' + st.label + '**') === 0) return { lineIdx: i, state: key };
      }
      while (i < lines.length && isBlockquoteLine(lines[i]) && !mask[i]) i++;
    }
    return null;
  }

  // Upsert the verdict blockquote directly under the H1 (replaced, never duplicated).
  function upsertApproval(text, stateKey, cfg, author, date) {
    const line = buildApprovalLine(cfg, stateKey, author, date);
    const existing = findApproval(text, cfg);
    const lines = splitLines(text);
    if (existing) {
      lines[existing.lineIdx] = line;
      return lines.join('\n');
    }
    const mask = codeMask(lines);
    // Skip a leading YAML frontmatter block so a "#"-leading frontmatter line is
    // never mistaken for the H1.
    let startScan = 0;
    if (lines.length && lines[0].trim() === '---') {
      for (let k = 1; k < lines.length; k++) { if (lines[k].trim() === '---') { startScan = k + 1; break; } }
    }
    let h1 = -1;
    for (let i = startScan; i < lines.length; i++) { if (!mask[i] && /^#[ \t]+\S/.test(lines[i])) { h1 = i; break; } }
    // Anchor the banner after the H1, else after the frontmatter, else at the top.
    const anchor = h1 !== -1 ? h1 : startScan - 1;
    const before = lines.slice(0, anchor + 1);
    const after = lines.slice(anchor + 1);
    const out = before.slice();
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(line);
    if (after.length && after[0].trim() !== '') out.push('');
    return out.concat(after).join('\n');
  }

  return {
    parseRemarks: parseRemarks,
    parseRemarkBlock: parseRemarkBlock,
    countOpen: countOpen,
    buildRemark: buildRemark,
    insertAfterLine: insertAfterLine,
    addRemarkAfterLine: addRemarkAfterLine,
    toggleResolved: toggleResolved,
    setStatus: setStatus,
    addReply: addReply,
    removeRemark: removeRemark,
    buildApprovalLine: buildApprovalLine,
    findApproval: findApproval,
    upsertApproval: upsertApproval
  };
});
