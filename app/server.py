#!/usr/bin/env python3
"""server.py — Mode 1 server for MD Planner (Python standard library only).

Serves the shared web/ UI and a tiny file API over the markdown root so a tablet
on the LAN can read/write plan files with zero install. No third-party packages.

    python3 server.py [ROOT] [--host H] [--port P]

ROOT defaults to the parent of this file's directory (the md root that contains
the app/ folder), or config.rootPath. Bind/host/port come from <ROOT>/.mdplanner/
config.json (server section) unless overridden on the command line.

Security (PLAN.md §4): every client path is resolved against ROOT and must stay
inside it (no .., no symlink escape); only *.md files are read/written via the file
API; request bodies are size-capped; responses use a consistent JSON envelope.
There is intentionally NO auth — bind is for a trusted home LAN only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import mdmarks

MD_SUFFIXES = (".md", ".markdown")

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, "web")
CONFIG_REL = os.path.join(".mdplanner", "config.json")
MAX_BODY = 5 * 1024 * 1024  # 5 MiB cap on request bodies

# Dependency / build / cache dirs whose .md files are never plan files — pruned
# from the listing (hidden dirs are pruned separately). Keeps node_modules docs,
# vendored package READMEs, etc. out of the plan list.
IGNORE_DIRS = frozenset({
    "node_modules", "__pycache__", "site-packages",
    "venv", "env", "dist", "build", "target", "vendor",
})

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def content_type_for(path: str) -> str:
    return CONTENT_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


# ---- config I/O ------------------------------------------------------------

def config_path(root: str) -> str:
    return os.path.join(root, CONFIG_REL)


def read_config(root: str) -> dict:
    """Merged defaults <- on-disk overrides (if any)."""
    path = config_path(root)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                overrides = json.load(fh)
        except (OSError, ValueError) as exc:
            raise ValueError("could not read config.json: %s" % exc)
        return mdmarks.merge_config(overrides)
    return mdmarks.merge_config({})


def atomic_write(path: str, data: bytes) -> float:
    """Write bytes via a temp file + os.replace; returns the new mtime."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".mdp-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return os.path.getmtime(path)


def list_md_files(root: str, cfg: dict):
    """Recursive *.md listing with verdict + open-remark badges (relative paths)."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        # skip hidden dirs (.mdplanner, .stfolder, .git, ...) and dependency/build
        # noise (node_modules, __pycache__, ...) — never recurse in.
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in IGNORE_DIRS]
        for name in filenames:
            if not name.lower().endswith(".md"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            try:
                with open(full, "r", encoding="utf-8") as fh:
                    text = fh.read()
                summary = mdmarks.file_summary(text, cfg)
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            out.append({
                "path": rel.replace(os.sep, "/"),
                "status": summary["status"],
                "openCount": summary["openCount"],
                "mtime": mtime,
            })
    out.sort(key=lambda e: e["path"].lower())
    return out


class PlannerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, root: str, open_dir=None, open_any=False):
        self.root = os.path.realpath(root)
        # On-demand ("ad-hoc") plans: an in-memory {id -> realpath} registry of files
        # OUTSIDE the root that a LOCAL process explicitly pinned via POST /api/adhoc.
        # Files are only ever reached by their opaque id (never a client-supplied path).
        # open_any ⇒ any path is pinnable (the host owner opted out of the bound);
        # otherwise the target must resolve inside one of open_dirs. Neither ⇒ disabled.
        # open_dir may be a str or a list of dirs. See §4.
        raw = [] if open_dir is None else ([open_dir] if isinstance(open_dir, str) else list(open_dir))
        seen, dirs = set(), []
        for d in raw:
            if d and os.path.isdir(d):
                real = os.path.realpath(d)
                if real not in seen:
                    seen.add(real)
                    dirs.append(real)
        self.open_dirs = dirs
        # `--open-dir /` is just the unrestricted case spelled as a directory.
        self.open_any = bool(open_any) or any(d == os.sep for d in dirs)
        self.adhoc = {}
        self.adhoc_lock = threading.Lock()
        super().__init__(server_address, PlannerHandler)


class PlannerHandler(BaseHTTPRequestHandler):
    server_version = "MDPlanner/1.0"
    protocol_version = "HTTP/1.1"
    timeout = 30  # socket read timeout — frees a thread if a client stalls (slow-loris)

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")

    # ---- response helpers -------------------------------------------------

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _ok(self, data=None, status=200):
        self._send_json(status, {"ok": True, "data": data, "error": None})

    def _err(self, status: int, message: str):
        self._send_json(status, {"ok": False, "data": None, "error": message})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length) if length else b""

    def _is_loopback(self) -> bool:
        """True iff the client connected over loopback — the gate for pinning
        on-demand files. Only a process on the host may name a new external path;
        LAN clients can merely view/annotate ids the host already pinned."""
        host = self.client_address[0] if self.client_address else ""
        if host == "::1" or host.startswith("127."):
            return True
        # IPv4-mapped loopback (::ffff:127.x.x.x) on a dual-stack IPv6 socket
        if host.lower().startswith("::ffff:"):
            return host[7:].startswith("127.")
        return False

    # ---- routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                return self._api_get(path, parse_qs(parsed.query))
            return self._serve_static(path)
        except Exception as exc:  # never leak a stack trace to the client
            self.log_error("GET %s failed: %s", path, exc)
            return self._err(500, "internal error")

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                return self._api_put(path, parse_qs(parsed.query))
            return self._err(405, "method not allowed")
        except Exception as exc:
            self.log_error("PUT %s failed: %s", path, exc)
            return self._err(500, "internal error")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/adhoc":
                return self._pin_adhoc()
            return self._err(404, "unknown endpoint")
        except Exception as exc:
            self.log_error("POST %s failed: %s", path, exc)
            return self._err(500, "internal error")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/adhoc":
                return self._unpin_adhoc(parse_qs(parsed.query))
            return self._err(404, "unknown endpoint")
        except Exception as exc:
            self.log_error("DELETE %s failed: %s", path, exc)
            return self._err(500, "internal error")

    # ---- static -----------------------------------------------------------

    def _serve_static(self, path: str):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = mdmarks.safe_join(WEB_DIR, rel)
        if target is None or not os.path.isfile(target):
            return self._err(404, "not found")
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._err(404, "not found")
        self.send_response(200)
        self.send_header("Content-Type", content_type_for(target))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # ---- API: GET ---------------------------------------------------------

    def _api_get(self, path: str, query: dict):
        root = self.server.root
        if path == "/api/files":
            cfg = read_config(root)
            return self._ok(list_md_files(root, cfg))
        if path == "/api/adhoc":
            return self._ok(self._list_adhoc())
        if path == "/api/file":
            return self._get_file(root, query)
        if path == "/api/config":
            return self._ok(read_config(root))
        return self._err(404, "unknown endpoint")

    def _get_file(self, root: str, query: dict):
        aid = (query.get("adhoc") or [None])[0]
        if aid:
            target = self._adhoc_target(aid)
            if target is None:
                return self._err(404, "unknown on-demand file")
            if not os.path.isfile(target):
                return self._err(404, "file not found")
            with open(target, "r", encoding="utf-8") as fh:
                text = fh.read()
            return self._ok(self._adhoc_doc(aid, target, text))
        rel = (query.get("path") or [None])[0]
        target = mdmarks.safe_join(root, rel)
        if target is None or not rel.lower().endswith(".md"):
            return self._err(400, "invalid path")
        if not os.path.isfile(target):
            return self._err(404, "file not found")
        with open(target, "r", encoding="utf-8") as fh:
            text = fh.read()
        return self._ok({"path": rel, "text": text, "mtime": os.path.getmtime(target)})

    # ---- on-demand (ad-hoc) external plans --------------------------------
    # The registry maps an opaque id (hash of the realpath) to a file outside the
    # root. Clients pass the id, never the path, so the reachable set is exactly
    # what a local process pinned. Every access re-validates: still inside open_dir,
    # still an .md file (defends against open_dir changing or a file moving).

    def _adhoc_doc(self, aid: str, target: str, text: str | None = None):
        # Disambiguating label WITHOUT leaking the full host path to LAN clients:
        # only the parent dir + filename (e.g. "proj/plan.md"), not the realpath.
        label = os.path.join(os.path.basename(os.path.dirname(target)), os.path.basename(target))
        doc = {"path": "adhoc:" + aid, "name": os.path.basename(target),
               "title": label, "external": True, "mtime": os.path.getmtime(target)}
        if text is not None:
            doc["text"] = text
        return doc

    def _adhoc_target(self, aid: str):
        """The registered realpath for an id, re-validated, or None."""
        if not aid:
            return None
        with self.server.adhoc_lock:
            target = self.server.adhoc.get(aid)
        return self._validate_adhoc(target)

    def _validate_adhoc(self, target):
        if not target or "\x00" in target:
            return None
        if not target.lower().endswith(MD_SUFFIXES):
            return None
        if self.server.open_any:                       # unrestricted (--open-any)
            return target
        dirs = self.server.open_dirs
        if dirs and any(mdmarks.is_within(d, target) for d in dirs):
            return target
        return None

    def _list_adhoc(self):
        cfg = read_config(self.server.root)
        with self.server.adhoc_lock:
            items = list(self.server.adhoc.items())
        out = []
        for aid, target in items:
            if self._validate_adhoc(target) is None or not os.path.isfile(target):
                continue
            try:
                with open(target, "r", encoding="utf-8") as fh:
                    text = fh.read()
                summary = mdmarks.file_summary(text, cfg)
            except OSError:
                continue
            entry = self._adhoc_doc(aid, target)
            entry.update({"status": summary["status"], "openCount": summary["openCount"]})
            out.append(entry)
        out.sort(key=lambda e: e["name"].lower())
        return out

    def _pin_adhoc(self):
        if not self._is_loopback():
            return self._err(403, "on-demand pinning is allowed from the host only")
        if not self.server.open_dirs and not self.server.open_any:
            return self._err(403, "on-demand mode is disabled (pass --open-dir or --open-any)")
        body = self._read_body()
        if body is None:
            return self._err(413, "body too large")
        try:
            data = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._err(400, "body must be valid JSON")
        raw = data.get("path") if isinstance(data, dict) else None
        if not raw or "\x00" in raw:
            return self._err(400, "missing or invalid path")
        target = os.path.realpath(os.path.expanduser(raw))
        if self._validate_adhoc(target) is None or not os.path.isfile(target):
            if self.server.open_any:
                return self._err(400, "not a readable .md/.markdown file: %s" % raw)
            return self._err(400, "not a readable .md file inside the on-demand dir(s): %s"
                             % (", ".join(self.server.open_dirs) or "(disabled)"))
        aid = hashlib.sha1(target.encode("utf-8")).hexdigest()[:12]
        with self.server.adhoc_lock:
            self.server.adhoc[aid] = target
        return self._ok({"id": aid, "name": os.path.basename(target), "path": target})

    def _unpin_adhoc(self, query: dict):
        if not self._is_loopback():
            return self._err(403, "on-demand unpinning is allowed from the host only")
        aid = (query.get("id") or [None])[0]
        if not aid:
            return self._err(400, "missing id")
        with self.server.adhoc_lock:
            existed = self.server.adhoc.pop(aid, None) is not None
        return self._ok({"id": aid, "removed": existed})

    # ---- API: PUT ---------------------------------------------------------

    def _api_put(self, path: str, query: dict):
        root = self.server.root
        if path == "/api/file":
            return self._put_file(root, query)
        if path == "/api/config":
            return self._put_config(root)
        return self._err(404, "unknown endpoint")

    def _put_file(self, root: str, query: dict):
        aid = (query.get("adhoc") or [None])[0]
        if aid:
            target = self._adhoc_target(aid)
            if target is None:
                return self._err(404, "unknown on-demand file")
            body = self._read_body()
            if body is None:
                return self._err(413, "body too large")
            mtime = atomic_write(target, body)
            return self._ok({"path": "adhoc:" + aid, "name": os.path.basename(target), "mtime": mtime})
        rel = (query.get("path") or [None])[0]
        target = mdmarks.safe_join(root, rel)
        if target is None or not rel.lower().endswith(".md"):
            return self._err(400, "invalid path")
        body = self._read_body()
        if body is None:
            return self._err(413, "body too large")
        mtime = atomic_write(target, body)
        return self._ok({"path": rel, "mtime": mtime})

    def _put_config(self, root: str):
        body = self._read_body()
        if body is None:
            return self._err(413, "body too large")
        try:
            cfg = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._err(400, "config must be valid JSON")
        if not isinstance(cfg, dict):
            return self._err(400, "config must be an object")
        merged = mdmarks.merge_config(cfg)
        mtime = atomic_write(config_path(root), json.dumps(merged, ensure_ascii=False, indent=2).encode("utf-8"))
        return self._ok({"mtime": mtime})

    def log_message(self, fmt, *args):  # concise single-line access log to stderr
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def build_server(root: str, host: str, port: int, open_dir=None, open_any=False) -> PlannerServer:
    if not os.path.isdir(root):
        raise SystemExit("root is not a directory: %s" % root)
    return PlannerServer((host, port), root, open_dir, open_any)


def resolve_open_dirs(root: str, cli_values) -> list:
    """Directories that *restrict* where on-demand plans may live. Empty ⇒ no
    restriction (the default; see wants_open_any). Sources: repeatable --open-dir,
    else $MDPLANNER_OPEN_DIR (os.pathsep-separated). Existing realpaths, de-duped."""
    if cli_values:                                  # one or more --open-dir flags
        raws = list(cli_values)
    else:
        env = os.environ.get("MDPLANNER_OPEN_DIR")
        raws = env.split(os.pathsep) if env else []
    out = []
    for raw in raws:
        if not raw or not raw.strip():
            continue
        real = os.path.realpath(os.path.expanduser(raw.strip()))
        if os.path.isdir(real) and real not in out:
            out.append(real)
    return out


def wants_open_any(open_any_flag, open_dirs) -> bool:
    """On-demand is UNRESTRICTED by default — bounded only when --open-dir (or the
    env var) names real directories. `--open-any` forces it; `--open-dir /` is the
    unrestricted case spelled as a directory."""
    return bool(open_any_flag) or not open_dirs or any(d == os.sep for d in open_dirs)


def open_remote(file_path: str, port: int) -> int:
    """Client mode for `--open`: ask the already-running local server to pin an
    external plan, then print (and try to open) its on-demand view URL."""
    import urllib.error
    import urllib.request

    target = os.path.realpath(os.path.expanduser(file_path))
    if not os.path.isfile(target):
        sys.stderr.write("not a file: %s\n" % target)
        return 2
    payload = json.dumps({"path": target}).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:%d/api/adhoc" % port, data=payload,
                                 method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error") or detail
        except ValueError:
            pass
        sys.stderr.write("server refused (%d): %s\n" % (exc.code, detail))
        return 1
    except (urllib.error.URLError, OSError) as exc:
        sys.stderr.write("could not reach the server on 127.0.0.1:%d (%s).\n"
                         "Start it first:  ./run.sh   (or ./run.sh --service)\n" % (port, exc))
        return 1
    if not data.get("ok"):
        sys.stderr.write("server refused: %s\n" % data.get("error"))
        return 1
    url = "http://127.0.0.1:%d/?adhoc=%s" % (port, data["data"]["id"])
    sys.stdout.write(url + "\n")
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass
    return 0


def parse_args(argv):
    parser = argparse.ArgumentParser(description="MD Planner Mode-1 server")
    default_root = os.path.dirname(APP_DIR)
    parser.add_argument("root", nargs="?", default=None, help="markdown root (default: %s)" % default_root)
    parser.add_argument("--host", default=None, help="bind host (default from config.server.host)")
    parser.add_argument("--port", type=int, default=None, help="bind port (default from config.server.port)")
    parser.add_argument("--open", default=None, metavar="FILE",
                        help="ask the running server to render an external plan on demand, then exit")
    parser.add_argument("--open-dir", action="append", default=None, metavar="DIR",
                        help="RESTRICT on-demand plans to this directory (repeatable; default: no restriction)")
    parser.add_argument("--open-any", action="store_true",
                        help="allow on-demand plans from ANY path (the default; ignored unless --open-dir is set)")
    return parser.parse_args(argv), default_root


def main(argv=None):
    args, default_root = parse_args(argv if argv is not None else sys.argv[1:])
    root = os.path.realpath(args.root or default_root)
    cfg = read_config(root)
    host = args.host or os.environ.get("MDPLANNER_HOST") or cfg["server"]["host"]
    port = args.port or int(os.environ.get("MDPLANNER_PORT") or cfg["server"]["port"])
    if args.open is not None:                      # client mode: talk to the running server, don't bind
        return open_remote(args.open, port)
    open_dirs = resolve_open_dirs(root, args.open_dir)
    open_any = wants_open_any(args.open_any, open_dirs)
    server = build_server(root, host, port, open_dirs, open_any)
    shown = host if host != "0.0.0.0" else "<this-host-LAN-IP>"
    sys.stderr.write("MD Planner serving %s\n  local:  http://127.0.0.1:%d/\n  LAN:    http://%s:%d/\n"
                     % (root, port, shown, port))
    if open_any:
        sys.stderr.write("  on-demand plans: enabled for ANY path (--open-any)  (./run.sh --open FILE)\n")
    elif open_dirs:
        sys.stderr.write("  on-demand plans: enabled under %s  (./run.sh --open FILE)\n" % ", ".join(open_dirs))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nshutting down\n")
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
