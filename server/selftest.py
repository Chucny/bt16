#!/usr/bin/env python3
"""
In-process self-test for the bt16 server.

Boots the real handler on a loopback port in a background thread, exercises the
static routing (including the /assets rewrite) and every API endpoint, then
exits. Uses a throwaway data directory so it never touches real player files.

    python selftest.py
"""

from __future__ import annotations

import json
import platform
import re
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hosting  # noqa: E402
import server  # noqa: E402

PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "ok  " if condition else "FAIL"
    print(f"  [{status}] {name}{'' if condition else f' — {detail}'}")
    if not condition:
        failures.append(name)


def get(path: str):
    try:
        with urllib.request.urlopen(BASE + path, timeout=5) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), exc.read()


def post(path: str, payload: dict):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="bt16-selftest-"))
    server.PLAYERS_DIR = tmp / "players"
    server.LOG_DIR = tmp / "logs"
    server.LOG_FILE = server.LOG_DIR / "log.json"
    server.PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
    server.LOG_DIR.mkdir(parents=True, exist_ok=True)

    httpd = server.Bt16Server(("127.0.0.1", PORT), server.Bt16Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    try:
        print("static")
        status, ctype, body = get("/")
        check("GET / serves index.html", status == 200 and b"bt16" in body, f"{status}")
        status, ctype, _ = get("/css/ui.css")
        check("GET /css/ui.css", status == 200 and "css" in ctype, f"{status} {ctype}")
        status, ctype, _ = get("/js/main.js")
        check("GET /js/main.js is JS", status == 200 and "javascript" in ctype, f"{status} {ctype}")
        status, ctype, body = get("/config/game-master.json")
        check(
            "GET /config/game-master.json is JSON",
            status == 200 and ctype == "application/json; charset=utf-8" and b"spawn" in body,
            f"{status} {ctype}",
        )
        gm_file = json.loads(
            (server.WEB_DIR / "config" / "game-master.json").read_text(encoding="utf-8")
        )
        check(
            "game master carries the miss-bounce tunables",
            all(
                isinstance(gm_file.get("ball", {}).get(k), (int, float))
                for k in (
                    "missBounceCount", "missBounceBaseM", "missBounceDecay",
                    "missBounceFriction", "rollSeconds", "rollFriction",
                    "rollStopMps", "missFadeSeconds",
                )
            ),
            str(gm_file.get("ball", {})),
        )
        check(
            "game master carries the tracking-loss rule",
            gm_file.get("tracking", {}).get("lostAfterS") == 3
            and gm_file.get("tracking", {}).get("lostStatuses") == ["LIMITED", "NOT_AVAILABLE"],
            str(gm_file.get("tracking")),
        )
        check(
            "miss-bounce and tracking tunables are still referenced by the code",
            "GM.ball.missBounceCount" in (server.WEB_DIR / "js" / "ball.js").read_text(encoding="utf-8")
            and "GM.tracking.lostAfterS" in (server.WEB_DIR / "js" / "main.js").read_text(encoding="utf-8"),
            "a tunable was added to the JSON but nothing reads it",
        )
        gm_js = (server.WEB_DIR / "js" / "gamemaster.js").read_text(encoding="utf-8")
        check(
            "the baked-in defaults mirror the new tunables",
            "missBounceCount: 3" in gm_js and "lostAfterS: 3" in gm_js,
            "gamemaster.js defaults drift from game-master.json",
        )

        status, _, _ = get("/assets/pokemon-go/important-icons/tutorials/findAPlane.png")
        check("GET the tutorial illustration", status == 200, f"{status}")
        status, ctype, _ = get("/assets/pokemon/icons/png/gen1/1.png")
        check("GET /assets/.../1.png", status == 200 and "image" in ctype, f"{status} {ctype}")
        status, ctype, _ = get("/assets/pokemon/models/glb/gen1/001.glb")
        check("GET /assets/.../001.glb", status == 200 and ctype == "model/gltf-binary", f"{status} {ctype}")
        status, _, _ = get("/vendor/xr-binary/xr-slam.js")
        check("GET /vendor/xr-binary/xr-slam.js", status == 200, f"{status}")
        status, ctype, body = get("/nope.txt")
        check("missing file is 404", status == 404, f"{status}")
        check(
            "a missing file answers text/plain, never HTML",
            "text/plain" in ctype and b"404" in body,
            f"{status} {ctype} — an HTML body makes the browser report a MIME error",
        )
        check(
            "the client module graph is complete",
            server.missing_client_files() == [],
            f"missing: {server.missing_client_files()}",
        )

        # A browser asks for the whole module graph at once. With the old
        # HTTP/1.0 + backlog-5 defaults a tunnel answered the overflow
        # connections with its own HTML error page, which the browser then
        # reported as "blocked ... MIME type (text/html)" for whichever modules
        # lost the race — and the app never left the splash screen. Every request
        # in the burst must be served, with the right type.
        modules = sorted(f"/js/{p.name}" for p in (server.WEB_DIR / "js").glob("*.js"))
        burst: list[tuple[int, str]] = []

        def fetch(path: str) -> None:
            status, ctype, _ = get(path)
            burst.append((path, status, ctype))

        threads = [threading.Thread(target=fetch, args=(m,)) for m in modules]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        check(
            "a burst of module requests is served in full",
            len(burst) == len(modules)
            and all(status == 200 and "javascript" in ctype for _, status, ctype in burst),
            f"{burst}",
        )
        check(
            "keep-alive is on so a tunnel reuses one origin connection",
            server.Bt16Handler.protocol_version == "HTTP/1.1"
            and server.Bt16Server.request_queue_size >= 64,
            f"protocol={server.Bt16Handler.protocol_version} "
            f"backlog={server.Bt16Server.request_queue_size}",
        )

        # A file that never got copied must be reported by name — that is the
        # difference between a named fix and a splash screen that never ends.
        fake = Path(tempfile.mkdtemp(prefix="bt16-graph-"))
        (fake / "js").mkdir(parents=True)
        (fake / "index.html").write_text(
            '<script src="./js/main.js?v=1"></script>', encoding="utf-8",
        )
        (fake / "js" / "main.js").write_text(
            "import {a} from './here.js?v=1'\n"
            "import {b} from './gone.js?v=1'\n"
            "import * as T from 'three'\n",
            encoding="utf-8",
        )
        (fake / "js" / "here.js").write_text("export const a = 1\n", encoding="utf-8")
        found = server.missing_client_files(fake)
        check(
            "a module that did not get copied is named, present ones are not",
            found == ["js/gone.js"],
            f"got {found}",
        )
        shutil.rmtree(fake, ignore_errors=True)

        status, _, body = get("/api/health")
        check(
            "health reports the client file inventory",
            json.loads(body).get("missing") == [],
            f"{body[:120]}",
        )

        # The cache-buster has to cover the WHOLE module graph. Versioning only
        # some imports is how a browser ends up holding an HTML error page for an
        # unversioned module for ever (the classic "stuck on the splash screen").
        index_text = (server.WEB_DIR / "index.html").read_text(encoding="utf-8")
        entry = re.search(r'src="\./js/main\.js\?v=(\d+)"', index_text)
        sheet = re.search(r'href="\./css/ui\.css\?v=(\d+)"', index_text)
        check(
            "index.html versions the entry module and the stylesheet",
            entry is not None and sheet is not None,
            "the ?v= tags are missing from index.html",
        )
        if entry and sheet:
            version = entry.group(1)
            # Only real import specifiers count — a JSDoc `import('./x.js')`
            # type reference is not fetched by the browser and needs no version.
            specifier = re.compile(
                r"""(?:\bfrom|\bimport)\s*["'](\.{1,2}/[^"']*?\.m?js)(?:\?v=(\d+))?"""
            )
            offenders: list[str] = []
            for js in sorted((server.WEB_DIR / "js").glob("*.js")):
                for path, ref_version in specifier.findall(
                    js.read_text(encoding="utf-8")
                ):
                    if ref_version != version:
                        offenders.append(
                            f"{js.name} -> {path}"
                            + (f"?v={ref_version}" if ref_version else " (no ?v=)")
                        )
            check(
                "every local import carries the same ?v= cache-buster",
                not offenders,
                f"mismatched: {offenders}",
            )
            check(
                "the stylesheet uses the same cache-buster as the modules",
                sheet.group(1) == version,
                f"css v{sheet.group(1)} vs js v{version}",
            )

        print("api")
        status, _, body = get("/api/health")
        check("GET /api/health", status == 200 and json.loads(body)["ok"], f"{status}")

        status, body = post("/api/register", {"username": "ash", "password": "pikachu1"})
        check("POST /api/register", status == 200 and body.get("ok"), str(body))

        status, body = post("/api/register", {"username": "ash", "password": "pikachu1"})
        check("duplicate register rejected", status == 409, f"{status} {body}")

        status, body = post("/api/register", {"username": "bad name!", "password": "pikachu1"})
        check("invalid username rejected", status == 409, f"{status} {body}")

        status, body = post("/api/login", {"username": "ash", "password": "pikachu1"})
        check("POST /api/login", status == 200 and body.get("player", {}).get("username") == "ash", str(body))
        check("login never echoes the password", "password" not in body.get("player", {}), str(body))

        status, body = post("/api/login", {"username": "ash", "password": "wrong"})
        check("wrong password rejected", status == 401, f"{status} {body}")

        inventory = {"25": {"nickname": "Sparky", "caughtDate": 1, "cp": 0, "pokedex_entry": 25}}
        status, body = post("/api/save", {"username": "ash", "inventory": inventory, "pokedex": {"25": True}})
        check("POST /api/save", status == 200 and body.get("ok"), str(body))

        player_file = server.player_path("ash")
        saved = json.loads(player_file.read_text(encoding="utf-8"))
        check("progress persisted to JSON", saved["pokemon"]["25"]["nickname"] == "Sparky", str(saved))

        status, body = post("/api/log", {"username": "ash", "entries": [{"t": 1, "level": "log", "message": "hi"}]})
        check("POST /api/log", status == 200 and body.get("ok"), str(body))
        logs = json.loads(server.LOG_FILE.read_text(encoding="utf-8"))
        check("log.json written", logs and logs[0]["message"] == "hi", str(logs))

        status, _, body = get("/api/player?username=ash")
        player = json.loads(body)["player"]
        check("GET /api/player", status == 200 and player["pokemon"]["25"]["nickname"] == "Sparky", f"{status}")
        check("player endpoint hides the password", "password" not in player, str(player))

        print("hosting helpers (non-admin modes)")
        check(
            "parses a cloudflared URL",
            hosting.public_url_from_line("INF |  https://calm-river-1234.trycloudflare.com  |")
            == "https://calm-river-1234.trycloudflare.com",
        )
        check(
            "parses a localhost.run URL",
            hosting.public_url_from_line("** your connection id is 8f2 https://ab12cd.lhr.life ready")
            == "https://ab12cd.lhr.life",
        )
        check("ignores URLs that are not tunnels", hosting.public_url_from_line("see https://example.com/docs") is None)
        check("ignores empty output", hosting.public_url_from_line("") is None)
        check(
            "parses a pinggy URL",
            hosting.public_url_from_line("  https://rnxyz.a.free.pinggy.link  ")
            == "https://rnxyz.a.free.pinggy.link",
        )
        check(
            "parses a serveo URL",
            hosting.public_url_from_line("Forwarding HTTP traffic from https://abc.serveo.net")
            == "https://abc.serveo.net",
        )
        check(
            "a custom command may use any host",
            hosting.public_url_from_line("tunnel at https://my-tunnel.example.net") is None
            and hosting.public_url_from_line(
                "tunnel at https://my-tunnel.example.net", accept_any=True,
            )
            == "https://my-tunnel.example.net",
        )
        check(
            "never mistakes a loopback URL for the public one",
            hosting.public_url_from_line("http://localhost:4040", accept_any=True) is None
            and hosting.public_url_from_line("http://127.0.0.1:8443/", accept_any=True) is None,
        )
        check(
            "provider table and CLI list agree",
            set(hosting.PROVIDER_SPECS) == set(hosting.PROVIDERS) - {"auto"}
            and set(hosting.AUTO_ORDER) <= set(hosting.PROVIDERS),
            "PROVIDERS / PROVIDER_SPECS / AUTO_ORDER are out of sync",
        )
        check(
            "provider aliases resolve",
            hosting.resolve_tunnel_provider("ssh") == "localhost.run"
            and hosting.resolve_tunnel_provider("cf") == "cloudflared"
            and hosting.resolve_tunnel_provider(None) == "auto"
            and hosting.resolve_tunnel_provider("PINGGY") == "pinggy",
        )
        check(
            "custom commands substitute {port} and split on quotes",
            hosting.custom_command_argv("bore local {port} --to bore.pub", 8443)
            == ["bore", "local", "8443", "--to", "bore.pub"]
            and hosting.custom_command_argv('mytool --label "two words"', 9000)
            == ["mytool", "--label", "two words"]
            and hosting.custom_command_argv("", 8443) is None
            and hosting.custom_command_argv(None, 8443) is None,
        )
        check(
            "custom is the only provider without a canned command",
            hosting.PROVIDER_SPECS["custom"].build is None
            and all(
                spec.build is not None
                for name, spec in hosting.PROVIDER_SPECS.items()
                if name != "custom"
            ),
        )
        table = hosting.provider_table()
        check(
            "--tunnel-list mentions every provider",
            all(name in table for name in hosting.PROVIDERS),
        )
        check(
            "cloudflared asset per platform",
            hosting.cloudflared_asset("Windows", "AMD64") == "cloudflared-windows-amd64.exe"
            and hosting.cloudflared_asset("Linux", "x86_64") == "cloudflared-linux-amd64"
            and hosting.cloudflared_asset("Linux", "aarch64") == "cloudflared-linux-arm64"
            and hosting.cloudflared_asset("Darwin", "arm64") == "cloudflared-darwin-arm64.tgz",
            "platform mapping is wrong",
        )
        check("unknown arch has no asset", hosting.cloudflared_asset("Linux", "sparc") is None)
        check(
            "cloudflared covers every Linux CPU in the release list",
            hosting.cloudflared_assets("Linux", "x86_64") == ["cloudflared-linux-amd64"]
            and hosting.cloudflared_assets("Linux", "aarch64") == ["cloudflared-linux-arm64"]
            and hosting.cloudflared_assets("Linux", "i686") == ["cloudflared-linux-386"]
            and hosting.cloudflared_assets("Linux", "armv6l") == ["cloudflared-linux-arm"],
            "linux asset mapping is wrong",
        )
        check(
            "32-bit ARM Linux prefers armhf, then falls back to arm",
            hosting.cloudflared_assets("Linux", "armv7l")
            == ["cloudflared-linux-armhf", "cloudflared-linux-arm"]
            and hosting.cloudflared_assets("Linux", "armv8l")
            == ["cloudflared-linux-armhf", "cloudflared-linux-arm"]
            and hosting.cloudflared_assets("Linux", "arm") == ["cloudflared-linux-arm"],
            "arm fallback chain is wrong",
        )
        check(
            "CPUs with no build return nothing rather than a bad URL",
            hosting.cloudflared_assets("Linux", "riscv64") == []
            and hosting.cloudflared_assets("Linux", "s390x") == []
            and hosting.cloudflared_assets("Linux", "ppc64le") == []
            and hosting.cloudflared_assets("Windows", "ARM64") == []
            and hosting.cloudflared_asset("FreeBSD", "x86_64") is None,
        )
        check(
            "old OpenSSH (pre-7.6) is detected so the ssh providers still start",
            hosting.ssh_accept_new_ok("OpenSSH_7.4p1, OpenSSL 1.0.2k") is False
            and hosting.ssh_accept_new_ok("OpenSSH_7.6p1 Ubuntu-4ubuntu0.7") is True
            and hosting.ssh_accept_new_ok("OpenSSH_9.6p1 Ubuntu-3ubuntu13.5") is True
            and hosting.ssh_accept_new_ok("") is False
            and hosting.ssh_accept_new_ok("nonsense") is False,
        )
        report = hosting.platform_report()
        check(
            "platform report names this machine and its tunnel tooling",
            platform.system() in report and "cloudflared" in report and "ssh" in report,
            "platform report is missing something",
        )
        check("is_admin returns a bool", isinstance(hosting.is_admin(), bool))

        def args(**kw):
            base = dict(tunnel=None, usb=False, local=False, http=False, host="0.0.0.0", port=8443)
            base.update(kw)
            return type("A", (), base)

        check(
            "mode resolution prefers the safest explicit flag",
            server.resolve_mode(args(tunnel="auto", usb=True)) == "tunnel"
            and server.resolve_mode(args(usb=True, local=True)) == "usb"
            and server.resolve_mode(args(local=True, http=True)) == "local"
            and server.resolve_mode(args(http=True)) == "http"
            and server.resolve_mode(args()) == "lan",
            "mode precedence is wrong",
        )
    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
