"""mdmarks.py — server-side mirror of the JS remark engine (pure, no I/O).

The Mode-1 file list needs a per-file verdict + open-remark count without the
client fetching every file. That means re-deriving the same facts the browser
derives from web/js/remarks.js — so this module mirrors that logic in Python and
is unit-tested independently (tests/py/test_mdmarks.py). See PLAN.md §1 (#11), §4.

Everything here is pure text/data in -> data out. Config tokens (icons, labels,
templates) are passed in so both sides parse identically.
"""

from __future__ import annotations

import copy
import os
import re

# Mirror of web/js/config.js DEFAULT_CONFIG (PLAN.md §5). Kept in sync by tests.
DEFAULT_CONFIG = {
    "rootPath": "/data/aproj/mdplaner",
    "standaloneRoot": "../../plans",
    "author": "me",
    "fileGlob": "**/*.md",
    "dateFormat": "YYYY-MM-DD",
    "marker": {
        "blockquotePrefix": "> ",
        "iconOpen": "🔴",
        "iconResolved": "⚪",
        "replyPrefix": "↳ ",
        "types": {"question": "Q", "remark": "R", "wrong": "W", "fix": "F"},
        "resolvedSuffix": ", resolved",
        "headerTemplate": "**{type} ({author}{statusSuffix}):** ",
    },
    "approval": {
        "states": {
            "approved": {"icon": "✅", "label": "APPROVED"},
            "changes-requested": {"icon": "🟠", "label": "CHANGES REQUESTED"},
            "pending": {"icon": "⚪", "label": "PENDING"},
        },
        "template": "> {icon} **{label}** — {author} · {date}",
    },
    "render": {"hideFrontmatter": True, "syntaxHighlight": True, "mermaid": True},
    "ui": {
        "theme": "auto",
        "fontScale": 1.0,
        "remarkColor": "#e5484d",
        "resolvedColor": "#8a8f98",
        "typeColors": {"question": "#3b82f6", "remark": "#e5484d", "wrong": "#f5a623", "fix": "#30a46c"},
    },
    "server": {"host": "0.0.0.0", "port": 8787},
}

_BQ_RE = re.compile(r"^[ \t]*>")
_STRIP_RE = re.compile(r"^[ \t]*>[ \t]?")
_BOLD_RE = re.compile(r"^\*\*(.+?)\*\*[ \t]?")
_INNER_RE = re.compile(r"^(.*)\(([^)]*)\):?[ \t]*$")
_FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")


def deep_merge(base, over):
    """Return a new dict = base overlaid with over (recursive, no mutation)."""
    if not isinstance(over, dict):
        return copy.deepcopy(base) if isinstance(base, dict) else over
    out = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key, ov in over.items():
        bv = out.get(key)
        if isinstance(bv, dict) and isinstance(ov, dict):
            out[key] = deep_merge(bv, ov)
        else:
            out[key] = copy.deepcopy(ov)
    return out


def merge_config(overrides):
    return deep_merge(DEFAULT_CONFIG, overrides or {})


def _is_bq_line(line: str) -> bool:
    return bool(_BQ_RE.match(line))


def _strip_prefix(line: str) -> str:
    return _STRIP_RE.sub("", line, count=1)


def _code_mask(lines):
    """Bool per line: True if inside a fenced code block (``` or ~~~)."""
    mask = [False] * len(lines)
    fence = None  # (char, length)
    for i, line in enumerate(lines):
        m = _FENCE_RE.match(line)
        if fence is not None:
            mask[i] = True
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] and m.group(2).strip() == "":
                fence = None
        elif m:
            fence = (m.group(1)[0], len(m.group(1)))
            mask[i] = True
    return mask


def _iter_blocks(lines):
    """Yield (start, end_exclusive, block_lines) for each blockquote run,
    skipping any blockquote-looking lines inside fenced code blocks."""
    mask = _code_mask(lines)
    i, n = 0, len(lines)
    while i < n:
        if not _is_bq_line(lines[i]) or mask[i]:
            i += 1
            continue
        j = i
        while j < n and _is_bq_line(lines[j]) and not mask[j]:
            j += 1
        yield i, j, lines[i:j]
        i = j


def parse_remark_block(block_lines, cfg):
    """Parse one blockquote into {type, author, status} or None (mirror of JS)."""
    m = cfg["marker"]
    first = _strip_prefix(block_lines[0])

    icon = None
    if first.startswith(m["iconOpen"]):
        icon = m["iconOpen"]
    elif first.startswith(m["iconResolved"]):
        icon = m["iconResolved"]
    if icon is None:
        return None

    after = first[len(icon):]
    if after[:1] in (" ", "\t"):
        after = after[1:]
    bold = _BOLD_RE.match(after)
    if not bold:
        return None
    inner = _INNER_RE.match(bold.group(1))
    if not inner:
        return None

    # The type label may be a multi-word phrase; the header template adds one
    # space before "(" and a configured label may carry its own trailing space,
    # so map back with trailing whitespace trimmed off both sides (mirror of JS).
    type_label = inner.group(1).rstrip(" \t")
    type_key = None
    for key, label in m["types"].items():
        if label.rstrip(" \t") == type_label:
            type_key = key
            break
    if type_key is None:
        return None

    author = inner.group(2)
    status = "resolved" if icon == m["iconResolved"] else "open"
    suffix = m.get("resolvedSuffix") or ""
    if suffix and author.endswith(suffix):
        author = author[: len(author) - len(suffix)]
        status = "resolved"

    return {"type": type_key, "author": author, "status": status}


def parse_remarks(text, cfg=None):
    cfg = cfg or DEFAULT_CONFIG
    lines = str(text).split("\n")
    out = []
    for start, _end, block in _iter_blocks(lines):
        parsed = parse_remark_block(block, cfg)
        if parsed:
            parsed["lineStart"] = start
            out.append(parsed)
    return out


def count_open_remarks(text, cfg=None):
    return sum(1 for r in parse_remarks(text, cfg) if r["status"] == "open")


def detect_approval(text, cfg=None):
    """Return the approval state key found in the file, or 'pending' if none."""
    cfg = cfg or DEFAULT_CONFIG
    states = cfg["approval"]["states"]
    lines = str(text).split("\n")
    for _start, _end, block in _iter_blocks(lines):
        content = _strip_prefix(block[0])  # inspect only the first line of each block
        for key, st in states.items():
            if not content.startswith(st["icon"]):
                continue
            # the bold label must follow the icon immediately (per approval.template)
            rest = content[len(st["icon"]):].lstrip()
            if rest.startswith("**" + st["label"] + "**"):
                return key
    return "pending"


def file_summary(text, cfg=None):
    """The per-file badge data used by GET /api/files."""
    return {"status": detect_approval(text, cfg), "openCount": count_open_remarks(text, cfg)}


# ---- path safety -----------------------------------------------------------

def is_within(root: str, candidate: str) -> bool:
    """True iff realpath(candidate) is inside realpath(root) (symlink-safe)."""
    root_real = os.path.realpath(root)
    cand_real = os.path.realpath(candidate)
    if cand_real == root_real:
        return True
    return cand_real.startswith(root_real + os.sep)


def safe_join(root: str, rel: str):
    """Resolve a client-supplied relative path against root, or None if it escapes.

    Rejects absolute paths, parent traversal, and symlink escapes. The returned
    path is NOT required to exist (callers handle missing files).
    """
    if rel is None:
        return None
    rel = str(rel).strip()
    if rel == "" or "\x00" in rel or rel.startswith("/") or rel.startswith("\\"):
        return None
    if os.path.isabs(rel) or ".." in rel.replace("\\", "/").split("/"):
        return None
    candidate = os.path.normpath(os.path.join(root, rel))
    if not is_within(root, candidate):
        return None
    return candidate
