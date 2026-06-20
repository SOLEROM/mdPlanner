import json
import os
import threading
from http.client import HTTPConnection

import pytest

import server


@pytest.fixture()
def live_server(tmp_path):
    """A real PlannerServer bound to an ephemeral port over a temp md root."""
    (tmp_path / "alpha.md").write_text("# Alpha\n\n> 🔴 **Q (me):** why?\n", encoding="utf-8")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "beta.md").write_text("# Beta\n\n> ✅ **APPROVED** — me · 2026-06-19\n", encoding="utf-8")
    (tmp_path / "ignore.txt").write_text("not markdown", encoding="utf-8")
    # dependency-dir markdown must never appear in the plan list
    dep = tmp_path / "node_modules" / "argparse"
    dep.mkdir(parents=True)
    (dep / "README.md").write_text("# argparse\n", encoding="utf-8")

    srv = server.build_server(str(tmp_path), "127.0.0.1", 0)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"port": port, "root": tmp_path}
    finally:
        srv.shutdown()
        srv.server_close()


def request(port, method, path, body=None, raw=False):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {}
    data = None
    if body is not None:
        data = body if raw else json.dumps(body)
        if isinstance(data, str):
            data = data.encode("utf-8")  # http.client would otherwise assume latin-1
        headers["Content-Type"] = "text/markdown" if raw else "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    payload = resp.read().decode("utf-8")
    conn.close()
    return resp.status, payload


def test_list_files_returns_badges(live_server):
    status, payload = request(live_server["port"], "GET", "/api/files")
    assert status == 200
    data = json.loads(payload)["data"]
    paths = {e["path"]: e for e in data}
    assert "alpha.md" in paths and "sub/beta.md" in paths
    assert "ignore.txt" not in paths
    assert not any("node_modules" in p for p in paths), "dependency dirs must be pruned"
    assert paths["alpha.md"]["openCount"] == 1
    assert paths["alpha.md"]["status"] == "pending"
    assert paths["sub/beta.md"]["status"] == "approved"


def test_get_file_reads_text(live_server):
    status, payload = request(live_server["port"], "GET", "/api/file?path=alpha.md")
    assert status == 200
    data = json.loads(payload)["data"]
    assert data["text"].startswith("# Alpha")


def test_put_file_writes_atomically(live_server):
    new_text = "# Alpha\n\n> 🔴 **Q (me):** why?\n> ↳ **claude:** because.\n"
    status, payload = request(live_server["port"], "PUT", "/api/file?path=alpha.md", body=new_text, raw=True)
    assert status == 200
    on_disk = (live_server["root"] / "alpha.md").read_text(encoding="utf-8")
    assert on_disk == new_text
    # no stray temp files left behind
    assert not any(p.name.startswith(".mdp-") for p in live_server["root"].iterdir())


def test_path_traversal_is_rejected(live_server):
    status, payload = request(live_server["port"], "GET", "/api/file?path=../secret.md")
    assert status == 400
    assert json.loads(payload)["ok"] is False

    status2, _ = request(live_server["port"], "PUT", "/api/file?path=../evil.md", body="x", raw=True)
    assert status2 == 400


def test_non_markdown_write_rejected(live_server):
    status, _ = request(live_server["port"], "PUT", "/api/file?path=note.txt", body="x", raw=True)
    assert status == 400


def test_config_get_then_put_roundtrip(live_server):
    status, payload = request(live_server["port"], "GET", "/api/config")
    assert status == 200
    cfg = json.loads(payload)["data"]
    assert cfg["marker"]["iconOpen"] == "🔴"

    cfg["author"] = "rob"
    status2, _ = request(live_server["port"], "PUT", "/api/config", body=cfg)
    assert status2 == 200
    saved = json.loads((live_server["root"] / ".mdplanner" / "config.json").read_text(encoding="utf-8"))
    assert saved["author"] == "rob"


def test_static_index_is_served(live_server):
    status, payload = request(live_server["port"], "GET", "/")
    assert status == 200
    assert "MD&nbsp;Planner" in payload or "MD Planner" in payload


def test_unknown_api_endpoint_404(live_server):
    status, _ = request(live_server["port"], "GET", "/api/nope")
    assert status == 404


def test_null_byte_path_is_rejected_cleanly(live_server):
    status, payload = request(live_server["port"], "GET", "/api/file?path=foo%00bar.md")
    assert status == 400
    assert json.loads(payload)["ok"] is False


def test_security_headers_present(live_server):
    conn = HTTPConnection("127.0.0.1", live_server["port"], timeout=5)
    conn.request("GET", "/")
    resp = conn.getresponse()
    resp.read()
    assert resp.getheader("X-Content-Type-Options") == "nosniff"
    assert resp.getheader("X-Frame-Options") == "SAMEORIGIN"
    conn.close()


# ---- on-demand (ad-hoc) external plans ------------------------------------

@pytest.fixture()
def adhoc_server(tmp_path):
    """A server whose ROOT and on-demand dir differ, with an external plan to pin.

      <tmp>/opendir/proj/plan.md   external plan (inside open_dir, OUTSIDE root)
      <tmp>/root/inside.md         a normal rooted plan
      <tmp>/elsewhere/secret.md    OUTSIDE open_dir (must never be pinnable)
    """
    open_dir = tmp_path / "opendir"
    (open_dir / "proj").mkdir(parents=True)
    plan = open_dir / "proj" / "plan.md"
    plan.write_text("# External Plan\n\n> 🔴 **Q (me):** outside the root?\n", encoding="utf-8")
    (open_dir / "proj" / "notes.txt").write_text("not markdown", encoding="utf-8")

    root = tmp_path / "root"
    root.mkdir()
    (root / "inside.md").write_text("# Inside\n", encoding="utf-8")

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    secret = elsewhere / "secret.md"
    secret.write_text("# Secret\n", encoding="utf-8")

    srv = server.build_server(str(root), "127.0.0.1", 0, open_dir=str(open_dir))
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"port": port, "root": root, "plan": plan, "secret": secret, "txt": open_dir / "proj" / "notes.txt"}
    finally:
        srv.shutdown()
        srv.server_close()


def _pin(port, path):
    status, payload = request(port, "POST", "/api/adhoc", body={"path": str(path)})
    return status, json.loads(payload)


def test_adhoc_pin_read_write_roundtrip(adhoc_server):
    port = adhoc_server["port"]
    status, body = _pin(port, adhoc_server["plan"])
    assert status == 200 and body["ok"] is True
    aid = body["data"]["id"]
    assert body["data"]["name"] == "plan.md"

    # pinning is idempotent — same realpath ⇒ same id
    _, body2 = _pin(port, adhoc_server["plan"])
    assert body2["data"]["id"] == aid

    # it shows up in the on-demand listing with its badges (1 open remark)
    _, listing = request(port, "GET", "/api/adhoc")
    entries = json.loads(listing)["data"]
    assert [e["path"] for e in entries] == ["adhoc:" + aid]
    assert entries[0]["external"] is True and entries[0]["openCount"] == 1

    # read by id (never by path)
    rstatus, rpayload = request(port, "GET", "/api/file?adhoc=" + aid)
    assert rstatus == 200
    assert json.loads(rpayload)["data"]["text"].startswith("# External Plan")

    # annotate + save writes straight back into the external file on disk
    new_text = "# External Plan\n\n> ✅ **APPROVED** — me · 2026-06-19\n"
    wstatus, _ = request(port, "PUT", "/api/file?adhoc=" + aid, body=new_text, raw=True)
    assert wstatus == 200
    assert adhoc_server["plan"].read_text(encoding="utf-8") == new_text


def test_adhoc_external_file_absent_from_rooted_listing(adhoc_server):
    _, listing = request(adhoc_server["port"], "GET", "/api/files")
    paths = {e["path"] for e in json.loads(listing)["data"]}
    assert paths == {"inside.md"}              # the external plan is NOT in the root listing


def test_adhoc_rejects_path_outside_open_dir(adhoc_server):
    status, body = _pin(adhoc_server["port"], adhoc_server["secret"])
    assert status == 400 and body["ok"] is False


def test_adhoc_rejects_non_markdown(adhoc_server):
    status, _ = _pin(adhoc_server["port"], adhoc_server["txt"])
    assert status == 400


def test_adhoc_rejects_traversal_and_null_byte(adhoc_server):
    # a path that escapes open_dir via .. resolves outside ⇒ rejected
    escape = str(adhoc_server["plan"].parent) + "/../../elsewhere/secret.md"
    status, _ = _pin(adhoc_server["port"], escape)
    assert status == 400
    status2, _ = _pin(adhoc_server["port"], "/tmp/foo\x00bar.md")
    assert status2 == 400


def test_adhoc_unknown_id_is_404(adhoc_server):
    status, _ = request(adhoc_server["port"], "GET", "/api/file?adhoc=deadbeef")
    assert status == 404


def test_adhoc_unpin_removes_it(adhoc_server):
    port = adhoc_server["port"]
    _, body = _pin(port, adhoc_server["plan"])
    aid = body["data"]["id"]
    status, payload = request(port, "DELETE", "/api/adhoc?id=" + aid)
    assert status == 200 and json.loads(payload)["data"]["removed"] is True
    # gone from the listing and no longer readable
    _, listing = request(port, "GET", "/api/adhoc")
    assert json.loads(listing)["data"] == []
    rstatus, _ = request(port, "GET", "/api/file?adhoc=" + aid)
    assert rstatus == 404


def test_adhoc_open_any_allows_any_path(tmp_path):
    """--open-any drops the directory bound: a plan anywhere is pinnable (still .md,
    still loopback-gated). A non-.md is still refused."""
    far = tmp_path / "totally" / "elsewhere"
    far.mkdir(parents=True)
    plan = far / "scratch.md"
    plan.write_text("# Scratch\n\n> 🔴 **F (me):** quick\n", encoding="utf-8")
    txt = far / "note.txt"
    txt.write_text("nope", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()

    srv = server.build_server(str(root), "127.0.0.1", 0, open_dir=None, open_any=True)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = _pin(port, plan)
        assert status == 200 and body["ok"] is True
        aid = body["data"]["id"]
        rstatus, rpayload = request(port, "GET", "/api/file?adhoc=" + aid)
        assert rstatus == 200 and json.loads(rpayload)["data"]["text"].startswith("# Scratch")
        assert _pin(port, txt)[0] == 400          # not markdown ⇒ still refused
    finally:
        srv.shutdown()
        srv.server_close()


def test_adhoc_open_dir_root_is_unrestricted(tmp_path):
    """`--open-dir /` is just the unrestricted case spelled as a directory."""
    plan = tmp_path / "p.md"
    plan.write_text("# P\n", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    srv = server.build_server(str(root), "127.0.0.1", 0, open_dir=[os.sep])
    assert srv.open_any is True
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        assert _pin(port, plan)[0] == 200
    finally:
        srv.shutdown()
        srv.server_close()


def test_adhoc_disabled_when_no_open_dir(tmp_path):
    """With on-demand mode off (open_dir=None), pinning is refused."""
    (tmp_path / "x.md").write_text("# X\n", encoding="utf-8")
    srv = server.build_server(str(tmp_path), "127.0.0.1", 0, open_dir=None)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        status, payload = request(port, "POST", "/api/adhoc", body={"path": str(tmp_path / "x.md")})
        assert status == 403 and json.loads(payload)["ok"] is False
    finally:
        srv.shutdown()
        srv.server_close()


def test_resolve_open_dirs_precedence(tmp_path, monkeypatch):
    root = tmp_path / "md"
    root.mkdir()
    monkeypatch.delenv("MDPLANNER_OPEN_DIR", raising=False)
    # default: NO restriction (empty) — on-demand is unrestricted unless dirs are named
    assert server.resolve_open_dirs(str(root), None) == []
    # explicit flags win, and multiple are kept (de-duplicated, in order)
    other = tmp_path / "other"; other.mkdir()
    another = tmp_path / "another"; another.mkdir()
    assert server.resolve_open_dirs(str(root), [str(other), str(another), str(other)]) == [str(other), str(another)]
    # non-directories are dropped
    assert server.resolve_open_dirs(str(root), [str(root / "nope")]) == []
    # env var (os.pathsep-separated) is the fallback when no flags
    monkeypatch.setenv("MDPLANNER_OPEN_DIR", os.pathsep.join([str(other), str(another)]))
    assert server.resolve_open_dirs(str(root), None) == [str(other), str(another)]


def test_wants_open_any_default_unrestricted():
    # no dirs + no flag ⇒ unrestricted by default
    assert server.wants_open_any(False, []) is True
    # naming dirs restricts (bounded) unless --open-any forces it
    assert server.wants_open_any(False, ["/data/aproj"]) is False
    assert server.wants_open_any(True, ["/data/aproj"]) is True
    # `--open-dir /` is the unrestricted case spelled as a directory
    assert server.wants_open_any(False, [os.sep]) is True


def test_adhoc_accepts_multiple_open_dirs(tmp_path):
    """A plan in EITHER whitelisted dir is pinnable; one outside both is not."""
    a = tmp_path / "a"; (a / "p").mkdir(parents=True)
    b = tmp_path / "b"; b.mkdir()
    pa = a / "p" / "plan.md"; pa.write_text("# A\n", encoding="utf-8")
    pb = b / "plan.md"; pb.write_text("# B\n", encoding="utf-8")
    outside = tmp_path / "c"; outside.mkdir()
    pc = outside / "plan.md"; pc.write_text("# C\n", encoding="utf-8")
    root = tmp_path / "root"; root.mkdir()

    srv = server.build_server(str(root), "127.0.0.1", 0, open_dir=[str(a), str(b)])
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        assert _pin(port, pa)[0] == 200
        assert _pin(port, pb)[0] == 200
        assert _pin(port, pc)[0] == 400          # outside both whitelisted dirs
    finally:
        srv.shutdown()
        srv.server_close()
