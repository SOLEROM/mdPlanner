import os

import mdmarks


CFG = mdmarks.DEFAULT_CONFIG


def test_count_open_remarks_ignores_resolved_and_plain_quotes():
    text = "\n".join([
        "# Plan",
        "",
        "> **Status:** proposal",          # plain plan blockquote -> not a remark
        "",
        "> 🔴 **Q (me):** open one",
        "",
        "> ⚪ **R (me, resolved):** done",  # resolved -> not counted
    ])
    assert mdmarks.count_open_remarks(text, CFG) == 1


def test_parse_remarks_extracts_type_status_author():
    # Separate blockquotes (blank line between) — adjacent > lines are one quote.
    text = "> 🔴 **Q (me):** why?\n\n> ⚪ **R (rob, resolved):** ok"
    rs = mdmarks.parse_remarks(text, CFG)
    assert [r["type"] for r in rs] == ["question", "remark"]
    assert rs[0]["status"] == "open"
    assert rs[1]["status"] == "resolved"
    assert rs[1]["author"] == "rob"


def test_parse_wrong_and_fix_note_types():
    text = "> 🔴 **W (me):** this is incorrect\n\n> 🔴 **F (rob):** do it this way"
    rs = mdmarks.parse_remarks(text, CFG)
    assert [r["type"] for r in rs] == ["wrong", "fix"]
    assert mdmarks.count_open_remarks(text, CFG) == 2
    assert rs[1]["author"] == "rob"


def test_parse_multi_word_type_labels():
    # Verbose, multi-word labels (mirrors a real user config). Every type must
    # parse — not only the single-token "FixThat:".
    cfg = mdmarks.merge_config({
        "marker": {
            "types": {
                "question": "Question about that, i need answer to:",
                "remark": "i have some Remarks here:",
                "wrong": "that is Wrong, do: ",   # trailing space, as configured
                "fix": "FixThat:",
            }
        }
    })
    text = "\n".join([
        "# a",
        "",
        "> 🔴 **Question about that, i need answer to: (me):** 0",
        "",
        "> 🔴 **i have some Remarks here: (me):** 1",
        "",
        "> 🔴 **FixThat: (me):** 2",
        "",
        "> 🔴 **that is Wrong, do:  (me):** 3",   # double space: label space + template space
    ])
    rs = mdmarks.parse_remarks(text, cfg)
    assert [r["type"] for r in rs] == ["question", "remark", "fix", "wrong"]
    assert mdmarks.count_open_remarks(text, cfg) == 4


def test_detect_approval_states_and_default_pending():
    assert mdmarks.detect_approval("# T\n\n> ✅ **APPROVED** — me · 2026-06-19", CFG) == "approved"
    assert mdmarks.detect_approval("# T\n\n> 🟠 **CHANGES REQUESTED** — me · x", CFG) == "changes-requested"
    assert mdmarks.detect_approval("# T\n\nno verdict here", CFG) == "pending"


def test_pending_banner_is_not_a_remark():
    text = "# T\n\n> ⚪ **PENDING** — me · 2026-06-19"
    assert mdmarks.parse_remarks(text, CFG) == []


def test_markers_inside_code_fences_are_ignored():
    text = "\n".join([
        "# Doc",
        "",
        "```markdown",
        "> 🔴 **Q (me):** example only",
        "```",
        "",
        "> 🔴 **Q (me):** real one",
    ])
    assert mdmarks.count_open_remarks(text, CFG) == 1
    fenced_approval = "# T\n\n```\n> ✅ **APPROVED** — me · d\n```\n"
    assert mdmarks.detect_approval(fenced_approval, CFG) == "pending"


def test_detect_approval_not_fooled_by_label_in_remark_body():
    a = "# T\n\n> ⚪ **R (me, resolved):** clear the **PENDING** list first"
    assert mdmarks.detect_approval(a, CFG) == "pending"  # default; no real banner
    b = "# T\n\n> 🔴 **Q (me):** check\n> ⚪ **PENDING** — continuation, not a banner"
    assert mdmarks.detect_approval(b, CFG) == "pending"
    c = "# T\n\n> ✅ **APPROVED** — me · d"
    assert mdmarks.detect_approval(c, CFG) == "approved"


def test_safe_join_rejects_null_byte():
    assert mdmarks.safe_join("/data/aproj/mdplaner", "foo\x00bar.md") is None


def test_file_summary_shape():
    text = "# T\n\n> ✅ **APPROVED** — me · d\n\n> 🔴 **Q (me):** q"
    s = mdmarks.file_summary(text, CFG)
    assert s == {"status": "approved", "openCount": 1}


def test_merge_config_is_deep_and_immutable():
    merged = mdmarks.merge_config({"author": "rob", "ui": {"fontScale": 1.4}})
    assert merged["author"] == "rob"
    assert merged["ui"]["fontScale"] == 1.4
    assert merged["marker"]["iconOpen"] == "🔴"
    assert merged["standaloneRoot"] == "../../plans"  # per-mode root default
    assert mdmarks.DEFAULT_CONFIG["author"] == "me"  # untouched


def test_default_config_carries_seeded_note_bank():
    bank = mdmarks.DEFAULT_CONFIG["noteBank"]
    for tk in ("question", "remark", "wrong", "fix"):
        assert isinstance(bank[tk], list) and bank[tk]
        assert all(isinstance(s, str) for s in bank[tk])


def test_merge_config_replaces_note_bank_type_wholesale():
    merged = mdmarks.merge_config({"noteBank": {"question": ["only one"]}})
    assert merged["noteBank"]["question"] == ["only one"]   # overridden, not appended
    assert merged["noteBank"]["remark"]                     # other types keep defaults


def test_safe_join_accepts_inside_paths(tmp_path):
    root = str(tmp_path)
    target = mdmarks.safe_join(root, "sub/plan.md")
    assert target == os.path.join(root, "sub", "plan.md")


def test_safe_join_rejects_traversal_and_absolute():
    root = "/data/aproj/mdplaner"
    assert mdmarks.safe_join(root, "../etc/passwd") is None
    assert mdmarks.safe_join(root, "/etc/passwd") is None
    assert mdmarks.safe_join(root, "a/../../b") is None
    assert mdmarks.safe_join(root, "") is None
    assert mdmarks.safe_join(root, None) is None


def test_is_within(tmp_path):
    root = str(tmp_path)
    inside = os.path.join(root, "a", "b.md")
    assert mdmarks.is_within(root, inside) is True
    assert mdmarks.is_within(root, "/etc/passwd") is False
