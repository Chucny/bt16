#!/usr/bin/env python3
"""
Back to 16 (bt16) — game server.

Serves the bt16 webpage over HTTPS on the LAN, stores player progress as plain
JSON, and collects the client's console output into log.json.

Endpoints
    GET  /api/health                     liveness probe
    POST /api/register   {username,password}
    POST /api/login      {username,password}
    GET  /api/player?username=NAME
    POST /api/save       {username, inventory, pokedex}
    POST /api/log        {username, entries:[{t, level, message}]}

Everything is stored as human-readable JSON:
    data/players/<username>.json
    logs/log.json

Hosting modes (no administrator rights needed for the last three)
    python server.py                 # LAN: HTTPS on 0.0.0.0:8443 (needs a firewall rule)
    python server.py --port 9443
    python server.py --public        # LAN, and also print your public IP
    python server.py --local         # http://127.0.0.1 only — same machine
    python server.py --usb           # Android over USB (adb reverse)
    python server.py --tunnel        # public HTTPS URL, no port forwarding
    python server.py --tunnel ssh    # force a specific provider

Only the Python standard library is required. `cryptography` is used as a
fallback for certificate generation when openssl is unavailable.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import hosting

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
SERVER_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SERVER_DIR.parent
WEB_DIR = PROJECT_DIR / "web"
ASSETS_DIR = PROJECT_DIR / "assets"
CERT_DIR = SERVER_DIR / "certs"
DATA_DIR = SERVER_DIR / "data"
PLAYERS_DIR = DATA_DIR / "players"
LOG_DIR = SERVER_DIR / "logs"
LOG_FILE = LOG_DIR / "log.json"

MAX_LOG_ENTRIES = 5000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")

_lock = threading.Lock()


# -----------------------------------------------------------------------------
# JSON helpers
# -----------------------------------------------------------------------------
def read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[bt16] warning: could not read {path}: {exc}")
        return default


def write_json(path: Path, payload: Any) -> None:
    """Write JSON atomically and in a human-readable, diff-friendly shape."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")
    os.replace(tmp, path)


def player_path(username: str) -> Path:
    # Keep the on-disk name filesystem-safe even though USERNAME_RE is strict.
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", username)
    return PLAYERS_DIR / f"{safe}.json"


def now_unix() -> int:
    return int(time.time())


# -----------------------------------------------------------------------------
# Player store
# -----------------------------------------------------------------------------
def new_player(username: str, password: str) -> dict:
    return {
        "username": username,
        "password": password,
        "pokemon": {},
        "pokedex": {},
        "items": {"poke": 30, "great": 15, "ultra": 8, "premier": 5},
        "accountCreated": now_unix(),
    }


def normalise_player(player: dict) -> dict:
    """Coerce a stored player into the shape the client expects."""
    player.setdefault("pokemon", {})
    player.setdefault("pokedex", {})
    player.setdefault("items", {"poke": 30, "great": 15, "ultra": 8, "premier": 5})
    player.setdefault("accountCreated", now_unix())
    return player


def get_player(username: str) -> dict | None:
    data = read_json(player_path(username))
    if not isinstance(data, dict):
        return None
    return normalise_player(data)


def register_player(username: str, password: str) -> tuple[bool, str, dict | None]:
    if not USERNAME_RE.match(username):
        return False, "Trainer name must be 1-32 characters (letters, digits, _ . -)", None
    if len(password) < 4:
        return False, "Password must be at least 4 characters", None
    with _lock:
        if player_path(username).exists():
            return False, "That trainer name is already taken", None
        player = new_player(username, password)
        write_json(player_path(username), player)
    return True, "ok", player


def login_player(username: str, password: str) -> tuple[bool, str, dict | None]:
    with _lock:
        player = get_player(username)
    if not player:
        return False, "No such trainer", None
    if player.get("password") != password:
        return False, "Wrong password", None
    return True, "ok", player


def save_progress(username: str, inventory: dict, pokedex: dict, items: dict | None = None) -> tuple[bool, str]:
    with _lock:
        player = get_player(username)
        if not player:
            return False, "No such trainer"
        if isinstance(inventory, dict):
            player["pokemon"] = inventory
        if isinstance(pokedex, dict):
            # Coerce keys to strings so the JSON stays readable.
            player["pokedex"] = {str(k): bool(v) for k, v in pokedex.items()}
        if isinstance(items, dict):
            # Ball counts are whole numbers; anything else would corrupt the bag.
            player["items"] = {
                str(k): max(0, int(v))
                for k, v in items.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            }
        write_json(player_path(username), player)
    return True, "ok"


def append_logs(username: str, entries: list) -> None:
    if not isinstance(entries, list):
        return
    stamp = _dt.datetime.now().isoformat(timespec="seconds")
    with _lock:
        existing = read_json(LOG_FILE, default=[])
        if not isinstance(existing, list):
            existing = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            existing.append({
                "receivedAt": stamp,
                "user": username or "anonymous",
                "t": entry.get("t"),
                "level": entry.get("level", "log"),
                "message": str(entry.get("message", ""))[:4000],
            })
        if len(existing) > MAX_LOG_ENTRIES:
            existing = existing[-MAX_LOG_ENTRIES:]
        write_json(LOG_FILE, existing)


# -----------------------------------------------------------------------------
# HTTP handler
# -----------------------------------------------------------------------------
MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
    ".tflite": "application/octet-stream",
}


# -----------------------------------------------------------------------------
# Client file graph
# -----------------------------------------------------------------------------
# index.html -> main.js -> every local import it reaches. If one of those files
# is not on disk the browser shows a splash screen that never goes away plus a
# console full of "blocked due to a disallowed MIME type (text/html)" — because a
# 404 whose body is HTML is reported by the browser as a *MIME* problem, not as a
# missing file. Walking the graph turns that into one line that names the file.
_HTML_REF_RE = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""")
_JS_REF_RE = re.compile(r"""["'](\.{1,2}/[^"']*?\.m?js)(?:\?[^"']*)?["']""")
_IMPORTMAP_RE = re.compile(r'type=["\']importmap["\']\s*>(.*?)</script>', re.S)


def missing_client_files(web_dir: Path | None = None) -> list[str]:
    """
    Files the browser will ask for that are not on disk, as `web/`-relative paths.

    Starts at index.html, follows its <script>/<link> tags and the import map,
    then follows every relative `.js` import inside the modules it reaches. Bare
    specifiers (`three`) and `/assets/…` (a separate root) are skipped.
    """
    root = web_dir or WEB_DIR
    queue: list[Path] = [root / "index.html"]
    seen: set[Path] = set()
    missing: set[str] = set()

    while queue:
        target = queue.pop()
        if target in seen:
            continue
        seen.add(target)

        if not target.is_file():
            try:
                missing.add(target.relative_to(root).as_posix())
            except ValueError:
                pass
            continue

        if target.suffix not in (".html", ".js", ".mjs"):
            continue
        try:
            text = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        if target.suffix == ".html":
            refs = _HTML_REF_RE.findall(text)
            for block in _IMPORTMAP_RE.findall(text):
                try:
                    mapping = json.loads(block).get("imports", {})
                except ValueError:
                    continue
                refs.extend(
                    value for value in mapping.values()
                    if isinstance(value, str) and value.startswith("./") and not value.endswith("/")
                )
        else:
            refs = _JS_REF_RE.findall(text)

        for ref in refs:
            ref = ref.split("?", 1)[0].split("#", 1)[0]
            if ref.startswith("/"):
                if ref.startswith("/assets/"):
                    continue  # served from ASSETS_DIR; selftest covers those
                nxt = root / ref.lstrip("/")
            elif ref.startswith("."):
                nxt = target.parent / ref
            else:
                continue  # bare specifier or a remote URL
            try:
                nxt.resolve().relative_to(root.resolve())
            except ValueError:
                continue  # outside web/ — not ours to serve
            queue.append(nxt)

    return sorted(missing)


class Bt16Server(ThreadingHTTPServer):
    """
    Thread-per-connection server with a deep accept backlog.

    `request_queue_size` defaults to 5. A browser fetches its whole module graph
    in parallel, and a tunnel in front of the origin can present more than five
    near-simultaneous connections; anything past the backlog is refused, and the
    tunnel turns that refusal into its own HTML error page, which the browser
    then blames on the MIME type ("blocked ... text/html") while the app sits on
    the splash screen. 128 leaves room for the burst.
    """

    daemon_threads = True
    request_queue_size = 128


class Bt16Handler(SimpleHTTPRequestHandler):
    server_version = "bt16/1.0"

    # HTTP/1.1 keeps the connection open between requests. The default
    # (HTTP/1.0) closes the socket after every response, so the origin has to
    # accept a brand new TCP connection for each of the ~15 modules the page
    # loads at once — the burst that overflows the listen backlog (see
    # Bt16Server). Every response here sets Content-Length (or is a HEAD), so
    # keep-alive is safe.
    protocol_version = "HTTP/1.1"

    # ---- logging tweaks ---------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401
        sys.stderr.write(f"[bt16] {self.address_string()} — {fmt % args}\n")

    def guess_type(self, path):  # noqa: D401
        _, ext = os.path.splitext(str(path))
        if ext.lower() in MIME_OVERRIDES:
            return MIME_OVERRIDES[ext.lower()]
        return super().guess_type(path)

    # ---- route resolution -------------------------------------------------
    def translate_path(self, path: str) -> str:
        """Serve web/ at the root and the asset tree at /assets.

        Deliberately avoids urllib.request.url2pathname: on Windows that turns
        every "/" into "\\", which breaks the URL -> filesystem split. URLs are
        always POSIX-style, so split on "/" and only then build a native path.
        """
        from urllib.parse import unquote

        clean = path.split("?", 1)[0].split("#", 1)[0]
        clean = unquote(clean).replace("\\", "/")
        parts = [p for p in clean.split("/") if p not in ("", ".", "..")]

        if parts and parts[0] == "assets":
            root = ASSETS_DIR
            parts = parts[1:]
        else:
            root = WEB_DIR
            if not parts:
                parts = ["index.html"]

        target = root.joinpath(*parts)
        return str(target)

    # ---- GET --------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self.send_json({
                "ok": True,
                "name": "bt16",
                "time": now_unix(),
                # A non-empty list means the browser cannot start the app at all.
                "missing": missing_client_files(),
            })
            return
        if path == "/api/player":
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            username = (query.get("username") or [""])[0]
            player = get_player(username)
            if not player:
                self.send_json({"ok": False, "error": "No such trainer"}, HTTPStatus.NOT_FOUND)
                return
            player = dict(player)
            player.pop("password", None)
            self.send_json({"ok": True, "player": player})
            return
        self.serve_static(send_body=True)

    # ---- POST -------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json({"ok": False, "error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)
            return
        if not isinstance(payload, dict):
            self.send_json({"ok": False, "error": "Expected a JSON object"}, HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/register":
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            ok, message, player = register_player(username, password)
            if not ok:
                self.send_json({"ok": False, "error": message}, HTTPStatus.CONFLICT)
                return
            public = dict(player)
            public.pop("password", None)
            print(f"[bt16] registered {username}")
            self.send_json({"ok": True, "player": public})
            return

        if path == "/api/login":
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            ok, message, player = login_player(username, password)
            if not ok:
                self.send_json({"ok": False, "error": message}, HTTPStatus.UNAUTHORIZED)
                return
            public = dict(player)
            public.pop("password", None)
            self.send_json({"ok": True, "player": public})
            return

        if path == "/api/save":
            username = str(payload.get("username", "")).strip()
            ok, message = save_progress(
                username,
                payload.get("inventory", {}),
                payload.get("pokedex", {}),
                payload.get("items"),
            )
            if not ok:
                self.send_json({"ok": False, "error": message}, HTTPStatus.NOT_FOUND)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/log":
            username = str(payload.get("username", "")).strip()
            append_logs(username, payload.get("entries", []))
            self.send_json({"ok": True})
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)

    # ---- helpers ----------------------------------------------------------
    def send_plain_error(self, status: HTTPStatus, note: str) -> None:
        """
        An error with a text/plain body and no-store.

        HTML error pages are a trap here: a browser loading a
        `<script type="module">` reports an HTML body as a *MIME type* error
        rather than a 404, which hides the real cause, and a cache in front of
        the tunnel is free to hold on to the wrong body.
        """
        body = f"{status.value} {status.phrase}: {note}\n".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, send_body: bool = True) -> None:
        path = self.translate_path(self.path)
        target = Path(path)

        if target.is_dir():
            target = target / "index.html"

        if not target.exists() or not target.is_file():
            self.send_plain_error(
                HTTPStatus.NOT_FOUND,
                f"{self.path} is not on disk — see the startup check for client files",
            )
            return

        try:
            size = target.stat().st_size
            with target.open("rb") as fh:
                start, end = 0, size - 1
                range_header = self.headers.get("Range")
                partial = False
                if range_header and range_header.startswith("bytes="):
                    spec = range_header[len("bytes="):].split("-", 1)
                    try:
                        if spec[0]:
                            start = int(spec[0])
                        if len(spec) > 1 and spec[1]:
                            end = int(spec[1])
                    except ValueError:
                        start, end = 0, size - 1
                    start = max(0, min(start, size - 1))
                    end = max(start, min(end, size - 1))
                    partial = True

                length = end - start + 1
                self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
                self.send_header("Content-Type", self.guess_type(str(target)))
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                if partial:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                # Markup and code must always be fresh — a cached ui.css or
                # main.js is the classic "my change isn't showing" bug. The big
                # binaries (models, sounds, sprites) can still be cached.
                if target.suffix.lower() in (".html", ".css", ".js", ".mjs", ".json", ".webmanifest"):
                    self.send_header("Cache-Control", "no-store")
                else:
                    self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                if not send_body:
                    return
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            print(f"[bt16] static error for {target}: {exc}")
            self.send_plain_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not read the file")


# -----------------------------------------------------------------------------
# Certificates
# -----------------------------------------------------------------------------
def local_ip() -> str:
    """Best-effort LAN IP of this machine."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.4)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return "127.0.0.1"


def public_ip() -> str | None:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            with urllib.request.urlopen(url, timeout=4) as resp:
                value = resp.read().decode("utf-8").strip()
                if value:
                    return value
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return None


def ensure_certificate(host: str) -> tuple[Path, Path]:
    """Create certs/cert.pem + certs/key.pem if they do not exist yet."""
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    cert = CERT_DIR / "cert.pem"
    key = CERT_DIR / "key.pem"
    if cert.exists() and key.exists():
        return cert, key

    san = f"DNS:localhost,IP:127.0.0.1,IP:{host}"
    print("[bt16] generating a self-signed certificate…")

    if shutil_which("openssl"):
        cmd = [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert),
            "-days", "3650", "-subj", "/CN=bt16",
            "-addext", f"subjectAltName={san}",
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print("[bt16] certificate written to server/certs/")
            return cert, key
        except (subprocess.CalledProcessError, OSError) as exc:
            print(f"[bt16] openssl failed: {exc}")

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import ipaddress
        from datetime import timedelta

        key_obj = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "bt16")])
        alt_names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
        try:
            alt_names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            alt_names.append(x509.DNSName(host))
        now = _dt.datetime.utcnow()
        cert_obj = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key_obj.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
            .sign(key_obj, hashes.SHA256())
        )
        with key.open("wb") as fh:
            fh.write(key_obj.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            ))
        with cert.open("wb") as fh:
            fh.write(cert_obj.public_bytes(serialization.Encoding.PEM))
        print("[bt16] certificate written to server/certs/ (cryptography)")
        return cert, key
    except ImportError:
        pass

    raise SystemExit(
        "Could not create a TLS certificate.\n"
        "Install openssl (recommended) or run: pip install cryptography\n"
        "Or start the server with --http for desktop testing."
    )


def shutil_which(cmd: str) -> str | None:
    import shutil
    return shutil.which(cmd)


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Back to 16 (bt16) game server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Hosting modes:\n"
            "  (default)      LAN over HTTPS — needs an inbound firewall rule\n"
            "  --local        http://127.0.0.1 only (same machine, no admin)\n"
            "  --usb          Android over USB via 'adb reverse' (no admin)\n"
            "  --tunnel       public HTTPS URL through a tunnel (no admin)\n"
            "  --tunnel-list  show the available tunnel providers\n"
        ),
    )
    parser.add_argument("--host", default="0.0.0.0", help="interface to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8443, help="port (default: 8443)")
    parser.add_argument("--public", action="store_true",
                        help="LAN mode: also detect and print the public address")
    parser.add_argument("--http", action="store_true",
                        help="serve plain HTTP on all interfaces (desktop testing only)")
    parser.add_argument("--local", action="store_true",
                        help="serve only on http://127.0.0.1 (no admin required)")
    parser.add_argument("--usb", action="store_true",
                        help="Android over USB using adb reverse (no admin required)")
    parser.add_argument(
        "--tunnel", nargs="?", default=None,
        # $BT16_TUNNEL_PROVIDER lets a shell profile pick the default, so the
        # usual `python server.py --tunnel` keeps working with no arguments.
        const=os.environ.get("BT16_TUNNEL_PROVIDER", "").strip() or "auto",
        choices=list(hosting.PROVIDERS) + sorted(hosting.PROVIDER_ALIASES),
        help="expose a public HTTPS URL; providers: "
             + ", ".join(hosting.PROVIDERS)
             + " (aliases: " + ", ".join(sorted(hosting.PROVIDER_ALIASES)) + ")",
    )
    parser.add_argument(
        "--tunnel-cmd", default=None, metavar="COMMAND",
        help="command to run for '--tunnel custom' (defaults to $BT16_TUNNEL_CMD); "
             "the first public URL it prints is used, and {port} is the port",
    )
    parser.add_argument(
        "--tunnel-list", action="store_true",
        help="print the tunnel providers (free / account / custom) and exit",
    )
    return parser.parse_args()


def resolve_mode(args: argparse.Namespace) -> str:
    """Pick the hosting mode from the flags, most specific first."""
    if args.tunnel is not None:
        return "tunnel"
    if args.usb:
        return "usb"
    if args.local:
        return "local"
    if args.http:
        return "http"
    return "lan"


def print_non_admin_help(port: int) -> None:
    print("  " + "-" * 58)
    print("  No administrator rights? The LAN mode needs an inbound firewall")
    print("  rule, which requires elevation. Three alternatives that do not:")
    print()
    print(f"    python server.py --usb      # Android over USB, then open"
          f" http://localhost:{port}/")
    print(f"    python server.py --tunnel   # public HTTPS URL — play anywhere")
    print(f"    python server.py --local    # this computer only")
    print()
    print("  --tunnel needs no account by default. To pick a service (or see")
    print("  what is available): python server.py --tunnel-list")
    print("  " + "-" * 58)


def main() -> None:
    args = parse_args()

    if args.tunnel_list:
        print("Hosting providers accepted by --tunnel:")
        print(hosting.provider_table())
        print()
        print("This machine:")
        print(hosting.platform_report())
        print()
        print("  Anything else - bring your own command, and bt16 reads the public")
        print("  URL straight out of its output:")
        print('    python server.py --tunnel custom --tunnel-cmd "<your command>"')
        return

    mode = resolve_mode(args)

    for directory in (PLAYERS_DIR, LOG_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    if not LOG_FILE.exists():
        write_json(LOG_FILE, [])

    host_ip = local_ip()
    use_tls = mode == "lan"

    # The tunnel / USB / local modes terminate TLS elsewhere (or not at all) and
    # stay on the loopback interface, so they never touch the firewall.
    bind_host = "127.0.0.1" if mode in ("tunnel", "usb", "local") else args.host
    scheme = "https" if use_tls else "http"

    httpd = Bt16Server((bind_host, args.port), Bt16Handler)

    if use_tls:
        cert, key = ensure_certificate(host_ip)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(cert), keyfile=str(key))
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    banner = "=" * 62
    print(banner)
    print("  Back to 16 (bt16) — game server")
    print(banner)
    print(f"  Mode    : {mode}")
    print(f"  Serving : {WEB_DIR}")
    print(f"  Assets  : {ASSETS_DIR}")
    print(f"  Players : {PLAYERS_DIR}")
    print(f"  Logs    : {LOG_FILE}")
    print(banner)

    # A missing file under web/ is the one failure the browser reports in a way
    # nobody can act on (a splash screen that never ends, plus MIME errors in the
    # console). Say it plainly here instead.
    missing = missing_client_files()
    if missing:
        print(f"  !! {len(missing)} client file(s) are MISSING from {WEB_DIR}")
        for name in missing:
            print(f"       web/{name}")
        print("     The page will sit on the splash screen until these are restored.")
        print(f"     (Ask the server for the truth: GET /api/health -> 'missing'.)")
        print(banner)

    if mode == "lan":
        print("  Open this on your phone (same Wi-Fi):")
        print(f"    {scheme}://{host_ip}:{args.port}/")
        print("    local desktop:")
        print(f"    {scheme}://localhost:{args.port}/")
        if args.public:
            pip = public_ip()
            if pip:
                print("  Public (requires port forwarding / a tunnel):")
                print(f"    {scheme}://{pip}:{args.port}/")
            else:
                print("  Public: could not determine the public IP")
        print("\n  The certificate is self-signed — accept the browser warning.")
        print("  Closing the warning away permanently:")
        print("    " + hosting.download_root_ca_hint())
        if not hosting.is_admin():
            print()
            print_non_admin_help(args.port)
    elif mode == "local":
        print("  Same-machine only. Open in a browser on this computer:")
        print(f"    http://127.0.0.1:{args.port}/")
        print("\n  A desktop browser cannot run SLAM; use --usb or --tunnel for a phone.")
    elif mode == "http":
        print("  Open this on your phone (same Wi-Fi):")
        print(f"    http://{host_ip}:{args.port}/")
        print("\n  Plain HTTP is not a secure context: the camera and motion")
        print("  sensors will stay unavailable on a phone.")

    print(banner)
    print("  Ctrl+C to stop.\n")

    tunnel = None
    # Serve from a background thread so the tunnel can be started *and then
    # checked* against the live server: a URL that 502s is worse than no URL at
    # all once the phone is already on its way to the football court.
    serve_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    serve_thread.start()

    try:
        if mode == "usb":
            adb = hosting.adb_reverse(args.port)
            print()
            if adb:
                print("  USB forwarding is active. On the phone, open:")
                print(f"    http://localhost:{args.port}/")
                print("  (localhost is a secure context, so the camera works")
                print("  with no certificate warning.)")
            else:
                print("  USB forwarding is not active — see the notes above.")
                print_non_admin_help(args.port)
            print()

        elif mode == "tunnel":
            custom_cmd = args.tunnel_cmd or os.environ.get("BT16_TUNNEL_CMD")
            print("  Starting the tunnel (outbound only — no admin needed)…\n")
            tunnel = hosting.start_tunnel(
                args.port, args.tunnel, SERVER_DIR / "tools",
                custom_command=custom_cmd,
            )
            print()
            if tunnel and tunnel.url:
                print("  Public URL — open this anywhere, on any phone:")
                print()
                print(f"    {tunnel.url}/")
                print()
                print(f"  Provider: {tunnel.provider}")
                print("  The certificate is real, so the camera and motion sensors")
                print("  work with no warning — walk to the park and keep playing.")
                if hosting.verify_url(tunnel.url) is None:
                    print("  (Not answering from this machine yet — it may still be")
                    print("   coming up. Give it a moment and reload on the phone.)")
                print("\n  Tip: the URL changes every time you restart the tunnel.")
            else:
                print("  Could not establish a tunnel.")
                print("  Every free provider was tried or skipped; see the notes above.")
                print("  Pick one explicitly, or list them all:")
                print("    python server.py --tunnel pinggy")
                print("    python server.py --tunnel-list")
                print("  Or bring your own command:")
                print('    python server.py --tunnel custom --tunnel-cmd "<command>"')
            print()

        while serve_thread.is_alive():
            serve_thread.join(1)
    except KeyboardInterrupt:
        print("\n[bt16] shutting down")
    finally:
        httpd.server_close()
        if tunnel:
            tunnel.stop()
        if mode == "usb":
            hosting.adb_reverse_remove(args.port)
        print("[bt16] stopped")


if __name__ == "__main__":
    main()
