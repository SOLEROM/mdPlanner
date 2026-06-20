#!/usr/bin/env bash
# MD Planner launcher.
#   ./run.sh [ROOT] [--host H] [--port P]    run the Mode-1 server in the foreground
#   ./run.sh [ROOT] [...] --service          install + start it as a systemd service
#   ./run.sh --status | --restart | --stop   manage the installed service (proxy systemctl)
#   ./run.sh --help                          show help (explains both run modes)
# ROOT defaults to this app's parent directory (the md root that contains app/).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3 || true)"
SERVICE_NAME="mdplanner"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
# When invoked via sudo, run the service as the real user, not root.
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || id -gn)"

# ---- arg scan: pull out --help / --service / service-control / --open; keep the rest ----
WANT_HELP=0
WANT_SERVICE=0
SVC_ACTION=""   # one of: status | restart | stop  (proxy to systemctl on the unit)
WANT_OPEN=0     # --open FILE: client mode (ask the running server to render an external plan)
OPEN_FILE=""
OPEN_DIRS=()    # --open-dir DIR (repeatable): where on-demand plans may live (server/service)
WANT_OPEN_ANY=0 # --open-any: allow on-demand plans from ANY path (no directory bound)
PASS=()
_expect=""      # set when the previous token expects a value (open | opendir)
for a in "$@"; do
  if [ -n "$_expect" ]; then
    case "$_expect" in
      open)    OPEN_FILE="$a"; WANT_OPEN=1 ;;
      opendir) OPEN_DIRS+=("$a") ;;
    esac
    _expect=""
    continue
  fi
  case "$a" in
    -h|--help)    WANT_HELP=1 ;;
    --service)    WANT_SERVICE=1 ;;
    --status)     SVC_ACTION="status" ;;
    --restart)    SVC_ACTION="restart" ;;
    --stop)       SVC_ACTION="stop" ;;
    --open)       _expect="open" ;;
    --open=*)     OPEN_FILE="${a#--open=}"; WANT_OPEN=1 ;;
    --open-dir)   _expect="opendir" ;;
    --open-dir=*) OPEN_DIRS+=("${a#--open-dir=}") ;;
    --open-any)   WANT_OPEN_ANY=1 ;;
    *)            PASS+=("$a") ;;
  esac
done
set -- "${PASS[@]+"${PASS[@]}"}"

# ---- ROOT detection (first non-flag arg; default = parent of app/) ----
if [[ "${1:-}" == "" || "${1:-}" == --* ]]; then
  ROOT="$(dirname "$HERE")"
else
  ROOT="$1"; shift
fi
# Remaining "$@" are passthrough flags for server.py (e.g. --host/--port).
PASSTHRU="$*"
# Writable scope for on-demand (--open) plans. UNRESTRICTED BY DEFAULT — any path is
# pinnable from the host, and the service drops FS hardening to match. Pass --open-dir
# (repeatable) to RESTRICT to specific dirs, which keeps the service sandboxed
# (ReadWritePaths = root + app dir + those dirs). Build the foreground arg array +
# the unit's ExecStart/hardening strings.
OPEN_DIR_ARGS=()           # for the foreground exec (space-safe)
OPEN_DIR_EXEC=""           # for the unit's ExecStart line
if [ "$WANT_OPEN_ANY" = 1 ] || [ "${#OPEN_DIRS[@]}" -eq 0 ]; then
  OPEN_ANY_MODE=1
  OPEN_DIR_ARGS=(--open-any)
  OPEN_DIR_EXEC=" --open-any"
  UNIT_PRIVATE_TMP="false"
  UNIT_HARDENING="ProtectSystem=off
ProtectHome=off"
else
  OPEN_ANY_MODE=0
  OPEN_DIR_RWP=""          # for the unit's ReadWritePaths line
  for _d in "${OPEN_DIRS[@]}"; do
    OPEN_DIR_ARGS+=(--open-dir "$_d")
    OPEN_DIR_EXEC="$OPEN_DIR_EXEC --open-dir \"$_d\""
    OPEN_DIR_RWP="$OPEN_DIR_RWP \"$_d\""
  done
  UNIT_PRIVATE_TMP="true"
  UNIT_HARDENING="ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=\"$ROOT\" \"$HERE\"$OPEN_DIR_RWP"
fi
PORT_HINT=8787
_prev=""
for a in "$@"; do
  case "$a" in --port=*) PORT_HINT="${a#--port=}" ;; esac
  [ "$_prev" = "--port" ] && PORT_HINT="$a"
  _prev="$a"
done

usage() {
  cat <<EOF
MD Planner — a dependency-light reviewer for Claude-Code markdown plan files.

Usage:
  ./run.sh [ROOT] [--host H] [--port P]     Run the Mode-1 server (foreground).
  ./run.sh [ROOT] [...] --service           Install & start it as a systemd service.
  ./run.sh --open FILE [--port P]           Render an external plan on demand (running server).
  ./run.sh --status | --restart | --stop    Manage the installed service (via systemctl).
  ./run.sh --help                           Show this help.

Run modes:
  Mode 1 — Server (this script):
      A Python stdlib server on the Linux host serves the web UI + a file API over
      ROOT. Open  http://<host-ip>:<port>/  from any browser on the same LAN to read
      and annotate plans; writes go straight into the .md files. Full read + write.

  Mode 2 — Standalone (no server):
      Open  web/index.standalone.html  directly in a browser (e.g. an Android tablet,
      even from the Files app) — a single self-contained file that works offline and
      saves in place where the browser allows, else exports a patched copy. This
      script regenerates that bundle from web/ on every start.

On-demand plans (no syncing): with the server running, render ANY plan on the host
without moving it into ROOT (ROOT only scopes the left-menu list) —
      ./run.sh --open /path/to/some-project/plan.md
  Pins it (host-only) and opens  http://127.0.0.1:<port>/?adhoc=<id>  in your browser;
  annotate + approve write straight back into that file. Unrestricted by default; pass
  --open-dir DIR (repeatable) to restrict + keep the service's FS hardening.

Arguments:
  ROOT          Markdown root to serve — scopes the left-menu list (default: $(dirname "$HERE")).
  --host H      Bind host   (default: config.server.host / \$MDPLANNER_HOST / 0.0.0.0).
  --port P      Bind port   (default: config.server.port / \$MDPLANNER_PORT / 8787).
  --open FILE   Ask the running server to render an external plan, then exit (client mode).
  --open-dir D  RESTRICT on-demand plans to this dir; repeatable (default: no restriction;
                or \$MDPLANNER_OPEN_DIR, os.pathsep-separated). Keeps the service hardened.
  --open-any    Allow on-demand from ANY path (already the default; relaxes the service's
                FS hardening). Pinning is still host-only (loopback).
  --service     Install $UNIT_PATH (runs as $RUN_USER), enable at boot, start now.
  --status      Show  systemctl status $SERVICE_NAME  (service state + recent log).
  --restart     Restart the $SERVICE_NAME service          (needs root/sudo).
  --stop        Stop the $SERVICE_NAME service             (needs root/sudo).
  --help, -h    Show this help.

Manage the service once installed (these shortcuts proxy systemctl):
  ./run.sh --status   ≡ systemctl status $SERVICE_NAME    journalctl -u $SERVICE_NAME -f
  ./run.sh --restart  ≡ systemctl restart $SERVICE_NAME    systemctl disable --now $SERVICE_NAME
  ./run.sh --stop     ≡ systemctl stop $SERVICE_NAME
EOF
}

build_bundle() {
  [ -n "$PY" ] || return 0
  "$PY" "$HERE/build-standalone.py" \
    || echo "warning: standalone bundle not rebuilt (continuing)" >&2
}

# Emit the systemd unit to stdout (used both to install and to print on no-systemd).
gen_unit() {
  cat <<EOF
[Unit]
Description=MD Planner — markdown plan reviewer (Mode 1 server)
Documentation=file://$HERE/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$HERE
Environment=PYTHONUNBUFFERED=1
# Refresh the Mode-2 standalone bundle on each start (non-fatal: leading '-').
ExecStartPre=-$PY $HERE/build-standalone.py
ExecStart=$PY $HERE/server.py "$ROOT"$OPEN_DIR_EXEC $PASSTHRU
Restart=on-failure
RestartSec=2

# Hardening — bounded mode keeps the FS read-only except the root, app dir and the
# on-demand dir(s); --open-any relaxes ProtectSystem/Home so on-demand can write anywhere.
NoNewPrivileges=true
PrivateTmp=$UNIT_PRIVATE_TMP
$UNIT_HARDENING
ProtectControlGroups=true
ProtectKernelTunables=true
ProtectKernelModules=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
EOF
}

install_service() {
  [ -n "$PY" ] || { echo "error: python3 not found in PATH" >&2; exit 1; }
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemctl not found — this host isn't running systemd." >&2
    echo "Install the unit below manually (or use the foreground/nohup launch):" >&2
    echo >&2
    gen_unit >&2
    exit 1
  fi

  local sudo=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 \
      || { echo "error: need root (or sudo) to write $UNIT_PATH" >&2; exit 1; }
    sudo="sudo"
  fi

  build_bundle

  if [ "$OPEN_ANY_MODE" = 1 ]; then
    echo "WARNING: on-demand plans are UNRESTRICTED (the default), so the service is" >&2
    echo "         installed WITHOUT filesystem hardening (ProtectSystem/ProtectHome off)" >&2
    echo "         — on-demand plans can be written anywhere your user can. Pinning stays" >&2
    echo "         host-only (loopback). Pass --open-dir DIR to restrict + re-harden." >&2
    echo >&2
  fi
  echo "Installing $UNIT_PATH  (User=$RUN_USER, ROOT=$ROOT):"
  echo
  gen_unit | sed 's/^/    /'
  echo
  local tmp; tmp="$(mktemp)"
  gen_unit >"$tmp"
  $sudo install -m 0644 "$tmp" "$UNIT_PATH"
  rm -f "$tmp"
  $sudo systemctl daemon-reload
  $sudo systemctl enable --now "${SERVICE_NAME}.service"

  echo
  $sudo systemctl --no-pager --full status "${SERVICE_NAME}.service" 2>/dev/null | sed -n '1,8p' || true
  echo
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "MD Planner is running as a service."
  [ -n "$ip" ] && echo "  LAN:   http://$ip:${PORT_HINT}/"
  echo "  logs:  journalctl -u $SERVICE_NAME -f"
  echo "  stop:  systemctl disable --now $SERVICE_NAME"
}

# Proxy a systemctl action (status/restart/stop) onto the installed unit.
# status is read-only (no sudo); restart/stop mutate state and escalate to root.
service_ctl() {
  local action="$1"
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemctl not found — this host isn't running systemd." >&2
    echo "Install the service first with:  ./run.sh --service" >&2
    exit 1
  fi

  local sudo=""
  if [ "$action" != "status" ] && [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 \
      || { echo "error: need root (or sudo) to $action $SERVICE_NAME" >&2; exit 1; }
    sudo="sudo"
  fi

  if [ "$action" = "status" ]; then
    # status exits non-zero when the unit is inactive/missing; don't let that abort.
    $sudo systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    $sudo systemctl "$action" "${SERVICE_NAME}.service"
    echo "$SERVICE_NAME: $action ok."
    $sudo systemctl --no-pager status "${SERVICE_NAME}.service" 2>/dev/null | sed -n '1,4p' || true
  fi
}

# Dispatch only when executed directly (sourcing exposes the helpers for tests).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ "$WANT_HELP" = 1 ]; then usage; exit 0; fi
  # Service-control shortcuts don't need python3 or a ROOT — handle them first.
  if [ -n "$SVC_ACTION" ]; then service_ctl "$SVC_ACTION"; exit 0; fi
  [ -n "$PY" ] || { echo "error: python3 not found in PATH" >&2; exit 1; }
  chmod +x "$HERE/run.sh" 2>/dev/null || true
  # --open FILE: client mode — hand the path to the already-running server and exit.
  if [ "$WANT_OPEN" = 1 ]; then exec "$PY" "$HERE/server.py" --open "$OPEN_FILE" "$@"; fi
  if [ "$WANT_SERVICE" = 1 ]; then install_service; exit 0; fi
  build_bundle
  exec "$PY" "$HERE/server.py" "$ROOT" "${OPEN_DIR_ARGS[@]}" "$@"
fi
