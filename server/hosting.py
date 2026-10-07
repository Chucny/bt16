#!/usr/bin/env python3
"""
Non-admin hosting helpers for the bt16 server.

The default LAN mode (see server.py) needs an inbound firewall rule, which
requires administrator rights. This module provides three ways to host the game
*without* elevation, all of which work on Windows, Linux and macOS:

    USB      adb reverse tcp:PORT tcp:PORT
             The phone reaches the computer through the USB cable. No firewall
             rule, no admin. Android only, needs adb + USB debugging.

    TUNNEL   a public HTTPS URL from any provider in PROVIDER_SPECS. The point
             of the tunnel is to walk somewhere else — a park, a football court,
             a forest — and keep playing, because the certificate is real and
             the phone only needs a mobile signal.

             The providers needing no account at all (cloudflared quick tunnels,
             localhost.run, pinggy, serveo, localtunnel) work on a fresh
             machine. ngrok, Tailscale Funnel and Microsoft dev tunnels work
             once you are signed in, and `custom` runs literally any command
             that prints a URL, so a brand-new service can be slotted in without
             touching this file.

    LOCAL    plain http://127.0.0.1 — same machine only.

Nothing here is imported unless the corresponding mode is used.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence
from urllib.parse import urlsplit

Log = Callable[[str], None]

# Matches any public host; the caller can prefer lines carrying a hint.
URL_RE = re.compile(
    r"https?://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?::\d+)?"
)

# Suffixes we trust by default when picking a URL out of noisy tunnel output.
_TUNNEL_SUFFIXES = (
    "trycloudflare.com",
    "lhr.life",
    "localhost.run",
    "pinggy.link",
    "pinggy.io",
    "pinggy.net",
    "serveo.net",
    "loca.lt",
    "ngrok-free.app",
    "ngrok.app",
    "ngrok.io",
    "ngrok-free.dev",
    "ts.net",
    "devtunnels.ms",
)

# Hosts that are never the public end of a tunnel (ngrok, for one, prints its
# own inspector URL on localhost before anything else).
_NOT_PUBLIC = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"})

CLOUDFLARED_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download"

# The real cloudflared is 20 MB+. Anything far smaller is the wreckage of an
# interrupted download, and reusing it fails with "Exec format error" on Linux.
_MIN_CLOUDFLARED_BYTES = 1_000_000

# Providers tried by a bare `--tunnel`, best first. Everything listed here is
# usable from a fresh machine except ngrok and Tailscale, which are worth a
# one-off free sign-in and are therefore kept at the end of the list.
AUTO_ORDER = (
    "cloudflared",     # Cloudflare quick tunnel: no account, real certificate
    "localhost.run",   # ssh, no account
    "pinggy",          # ssh, no account, 60-minute sessions
    "serveo",          # ssh, no account
    "ngrok",           # free account (authtoken)
    "tailscale",       # free account (Tailscale Funnel)
)

# Everything `--tunnel <name>` accepts. `localtunnel` and `devtunnel` are
# explicit-only: localtunnel makes npx download a package, and devtunnel needs a
# browser sign-in, so neither belongs in the automatic walk down the list.
PROVIDERS = ("auto",) + AUTO_ORDER + ("localtunnel", "devtunnel", "custom")

# Short aliases, so the documented `--tunnel ssh` keeps working.
PROVIDER_ALIASES = {
    "ssh": "localhost.run",
    "cf": "cloudflared",
    "lt": "localtunnel",
    "ts": "tailscale",
}


# -----------------------------------------------------------------------------
# Pure helpers (kept dependency-free so they are easy to test)
# -----------------------------------------------------------------------------
def is_admin() -> bool:
    """True when this process can change firewall rules (best effort)."""
    if os.name == "nt":
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    try:
        return os.geteuid() == 0  # type: ignore[attr-defined]
    except AttributeError:
        return False


def _is_public_url(url: str, *, require_subdomain: bool = False) -> bool:
    """True when a URL looks like a public tunnel endpoint rather than a local one."""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    if not host or host in _NOT_PUBLIC:
        return False
    if host.endswith((".local", ".localhost", ".internal", ".lan")):
        return False
    # Tunnel URLs carry a subdomain (`ab12cd.lhr.life`); a bare two-label host is
    # almost always a service's own marketing site printed in its banner.
    if require_subdomain and host.count(".") < 2:
        return False
    return True


def public_url_from_line(
    line: str,
    hosts: Sequence[str] | None = None,
    accept_any: bool = False,
) -> Optional[str]:
    """
    Pull a public URL out of one line of tunnel output.

    A URL is accepted when it carries one of `hosts` (default: every provider
    suffix we know about). Pass `accept_any=True` to accept the first
    non-loopback URL instead — that is what lets `custom` support a service this
    file has never heard of.
    """
    matches = URL_RE.findall(line or "")
    if not matches:
        return None

    if accept_any:
        for url in matches:
            if _is_public_url(url):
                return url.rstrip("/")
        return None

    for url in matches:
        if any(hint in url for hint in (hosts or _TUNNEL_SUFFIXES)):
            return url.rstrip("/")
    return None


def _machine_arches(machine: str) -> tuple[str, ...]:
    """
    Cloudflared's CPU names for this machine, best first.

    32-bit ARM gets two: `armhf` is the ARMv7 hard-float build, while plain
    `arm` is compiled for ARMv6 and therefore also runs on older boards, so it
    is both the ARMv6 answer and the ARMv7 fallback.
    """
    machine = (machine or "").lower()
    if machine in ("amd64", "x86_64", "x64", "amd64v2", "amd64v3"):
        return ("amd64",)
    if machine in ("arm64", "aarch64", "arm64e"):
        return ("arm64",)
    if machine in ("i386", "i486", "i586", "i686", "x86"):
        return ("386",)
    if machine in ("armv7l", "armv7", "armv8l", "armhf"):
        return ("armhf", "arm")
    if machine in ("armv6l", "armv5l", "arm"):
        return ("arm",)
    return ()


def cloudflared_assets(system: str | None = None, machine: str | None = None) -> list[str]:
    """
    Candidate cloudflared release assets for this platform, best first.

    Linux is the broad case and the reason this returns a list: Cloudflare
    publishes amd64, arm64, arm (ARMv6), armhf (ARMv7 hard float) and 386, which
    between them cover a Raspberry Pi, an ARM NAS, a container and a server.
    Anything not in the release list (Windows on ARM, RISC-V, POWER, s390x, …)
    yields no candidates — deliberately, so the caller can fall back to another
    provider instead of downloading something that cannot run.
    """
    system = (system or platform.system()).lower()
    assets: list[str] = []
    for arch in _machine_arches(machine or platform.machine()):
        if system == "linux":
            assets.append(f"cloudflared-linux-{arch}")
        elif system == "windows" and arch in ("amd64", "386"):
            assets.append(f"cloudflared-windows-{arch}.exe")
        elif system == "darwin" and arch in ("amd64", "arm64"):
            assets.append(f"cloudflared-darwin-{arch}.tgz")

    seen: set[str] = set()
    unique: list[str] = []
    for asset in assets:
        if asset not in seen:
            seen.add(asset)
            unique.append(asset)
    return unique


def cloudflared_asset(system: str | None = None, machine: str | None = None) -> Optional[str]:
    """The best cloudflared release asset for this platform, if there is one."""
    assets = cloudflared_assets(system, machine)
    return assets[0] if assets else None


# -----------------------------------------------------------------------------
# cloudflared
# -----------------------------------------------------------------------------
def _download_cloudflared(asset: str, target: Path, log: Log) -> bool:
    """
    Fetch one release asset onto `target`. True on success.

    The download lands in a temporary file and is moved into place only once it
    is complete. Writing straight to `target` used to leave a truncated
    executable behind when the network dropped — and because an existing
    `target` short-circuits every later run, that broken binary was then reused
    forever (on Linux it fails with "Exec format error").
    """
    url = f"{CLOUDFLARED_BASE}/{asset}"
    staging = target.with_name(target.name + ".part")
    try:
        if asset.endswith(".tgz"):
            with tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "cloudflared.tgz"
                urllib.request.urlretrieve(url, archive)
                with tarfile.open(archive) as tf:
                    if hasattr(tarfile, "data_filter"):
                        tf.extractall(tmp, filter="data")
                    else:
                        tf.extractall(tmp)
                extracted = Path(tmp) / "cloudflared"
                if not extracted.exists():
                    log("[bt16] cloudflared archive did not contain the binary")
                    return False
                staging.write_bytes(extracted.read_bytes())
        else:
            urllib.request.urlretrieve(url, staging)

        if not staging.exists() or staging.stat().st_size == 0:
            log(f"[bt16] cloudflared download was empty ({asset})")
            return False
        os.replace(staging, target)
    except (urllib.error.URLError, OSError, tarfile.TarError) as exc:
        log(f"[bt16] cloudflared download failed ({asset}): {exc}")
        return False
    finally:
        try:
            if staging.exists():
                staging.unlink()
        except OSError:
            pass
    return True


def ensure_cloudflared(tools_dir: Path, log: Log = print) -> Optional[str]:
    """
    Return a usable cloudflared path.

    Prefers an existing install on PATH, otherwise downloads the release asset
    for this CPU into `tools_dir` (inside the project — never a system location,
    so no admin rights are involved). ARM Linux is covered by the armhf/arm
    pair, so a Raspberry Pi works exactly like a server.
    """
    found = shutil.which("cloudflared")
    if found:
        return found

    assets = cloudflared_assets()
    if not assets:
        log("[bt16] no cloudflared build for this platform")
        log(f"        {platform.system()} {platform.machine()} is not in the release list")
        log("        Install cloudflared yourself, or pick another provider:")
        log("        python3 server.py --tunnel pinggy   (or: --tunnel-list)")
        return None

    tools_dir.mkdir(parents=True, exist_ok=True)
    exe_name = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    target = tools_dir / exe_name
    try:
        if target.stat().st_size > _MIN_CLOUDFLARED_BYTES:
            return str(target)
        log("[bt16] discarding an incomplete cloudflared download")
    except OSError:
        pass  # nothing there yet — the normal first-run case

    for asset in assets:
        log(f"[bt16] downloading cloudflared ({asset})…")
        if not _download_cloudflared(asset, target, log):
            continue
        try:
            target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        except OSError:
            pass
        log(f"[bt16] cloudflared ready at {target}")
        return str(target)
    return None


# -----------------------------------------------------------------------------
# Providers
#
# One entry per way of getting a public URL. A builder returns the argv to run,
# or None when its prerequisite (a binary, a sign-in) is missing — the log line
# it leaves behind is the only guidance the player gets, so it has to name what
# to install and how to get it.
# -----------------------------------------------------------------------------
# `StrictHostKeyChecking=accept-new` only exists from OpenSSH 7.6 (2017) on.
# Older ssh — Debian 9, Ubuntu 16.04, CentOS 7, Amazon Linux 1, and anything
# else still on a long-LTS branch — aborts with "Bad yes/no argument:
# accept-new", which makes every ssh provider look broken on a perfectly good
# Linux box. Those get the prompt-free equivalent instead.
_ACCEPT_NEW_SINCE = (7, 6)


def ssh_accept_new_ok(version_banner: str) -> bool:
    """Whether an `ssh -V` banner is new enough for StrictHostKeyChecking=accept-new."""
    match = re.search(r"OpenSSH_(\d+)\.(\d+)", version_banner or "")
    if not match:
        return False
    return (int(match.group(1)), int(match.group(2))) >= _ACCEPT_NEW_SINCE


def ssh_supports_accept_new(ssh: str) -> bool:
    """Run `ssh -V` (which prints its banner on stderr) and compare the version."""
    try:
        result = subprocess.run(
            [ssh, "-V"], check=False, capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return ssh_accept_new_ok(f"{result.stdout}\n{result.stderr}")


def _ssh_host_key_options(ssh: str) -> list[str]:
    """Host-key handling that works on every OpenSSH, old or new."""
    if ssh_supports_accept_new(ssh):
        return ["-o", "StrictHostKeyChecking=accept-new"]
    # No accept-new available: trust the host once and keep no record of it.
    # os.devnull keeps this path correct on Windows too.
    return [
        "-o", "StrictHostKeyChecking=no",
        "-o", f"UserKnownHostsFile={os.devnull}",
    ]


def _ssh_client(log: Log, provider: str) -> Optional[list[str]]:
    """Shared ssh preamble for the ssh-based tunnels."""
    ssh = shutil.which("ssh")
    if not ssh:
        log(f"[bt16] ssh not found — the {provider} tunnel needs an SSH client")
        log("        Debian/Ubuntu: sudo apt install openssh-client")
        log("        Fedora/RHEL:   sudo dnf install openssh-clients")
        log("        Alpine:        sudo apk add openssh-client")
        log("        Or pick another provider: python3 server.py --tunnel-list")
        return None

    return [
        ssh,
        *_ssh_host_key_options(ssh),
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=30",
        "-o", "ExitOnForwardFailure=yes",
    ]


def _build_cloudflared(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    exe = ensure_cloudflared(tools_dir, log)
    if not exe:
        return None
    return [exe, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"]


def _build_localhost_run(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    base = _ssh_client(log, "localhost.run")
    if not base:
        return None
    return [*base, "-R", f"80:127.0.0.1:{port}", "nokey@localhost.run"]


def _build_serveo(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    base = _ssh_client(log, "serveo")
    if not base:
        return None
    return [*base, "-R", f"80:127.0.0.1:{port}", "serveo.net"]


def _build_pinggy(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    base = _ssh_client(log, "pinggy")
    if not base:
        return None
    # Free tier: no account, 60-minute sessions, served from a random subdomain.
    return [*base, "-p", "443", "-R", f"0:127.0.0.1:{port}", "free@a.pinggy.io"]


def _build_ngrok(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    exe = shutil.which("ngrok")
    if not exe:
        log("[bt16] ngrok not found on PATH")
        log("        Install it (https://ngrok.com/download), sign up free, then run")
        log("        'ngrok config add-authtoken <token>' once.")
        return None
    cmd = [exe, "http", str(port)]
    # Useful in CI / on a fresh machine where the config file is not set up yet.
    token = os.environ.get("NGROK_AUTHTOKEN", "").strip()
    if token:
        cmd += ["--authtoken", token]
    return cmd


def _build_tailscale(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    exe = shutil.which("tailscale")
    if not exe:
        log("[bt16] tailscale not found on PATH")
        log("        Install it, run 'tailscale up', then enable Funnel for this")
        log("        machine once in the admin console.")
        return None
    return [exe, "funnel", "--bg", "--yes", str(port)]


def _build_localtunnel(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        log("[bt16] npx (Node.js) not found — localtunnel runs through npx")
        log("        Install Node.js, or pick another provider: --tunnel-list")
        return None
    return [npx, "--yes", "localtunnel", "--port", str(port)]


def _build_devtunnel(port: int, tools_dir: Path, log: Log) -> Optional[list[str]]:
    exe = shutil.which("devtunnel")
    if not exe:
        log("[bt16] devtunnel not found")
        log("        Install the Microsoft dev tunnels CLI, then run")
        log("        'devtunnel user login' once.")
        return None
    return [exe, "host", "-p", str(port), "--allow-anonymous"]


@dataclass(frozen=True)
class Provider:
    """One tunnel service: how to start it and how to recognise its URL."""

    name: str
    label: str
    hosts: tuple[str, ...]
    auth: str          # "no account" / "free account" / …
    note: str
    build: Optional[Callable[[int, Path, Log], Optional[list[str]]]] = None


PROVIDER_SPECS: dict[str, Provider] = {
    spec.name: spec
    for spec in (
        Provider(
            "cloudflared", "Cloudflare Quick Tunnel", ("trycloudflare.com",),
            "no account",
            "cloudflared is downloaded into server/tools/ on first use",
            _build_cloudflared,
        ),
        Provider(
            "localhost.run", "localhost.run (ssh)", ("lhr.life", "localhost.run"),
            "no account",
            "ssh only; the URL is random on every run",
            _build_localhost_run,
        ),
        Provider(
            "pinggy", "Pinggy (ssh)", ("pinggy.link", "pinggy.io", "pinggy.net"),
            "no account",
            "ssh only; free sessions last 60 minutes",
            _build_pinggy,
        ),
        Provider(
            "serveo", "Serveo (ssh)", ("serveo.net",),
            "no account",
            "ssh only; a handy fallback when the others are busy",
            _build_serveo,
        ),
        Provider(
            "ngrok", "ngrok",
            ("ngrok-free.app", "ngrok.app", "ngrok.io", "ngrok-free.dev"),
            "free account",
            "sign up once, then 'ngrok config add-authtoken <token>' "
            "(or set $NGROK_AUTHTOKEN)",
            _build_ngrok,
        ),
        Provider(
            "tailscale", "Tailscale Funnel", ("ts.net",),
            "free account",
            "install Tailscale, 'tailscale up', enable Funnel once",
            _build_tailscale,
        ),
        Provider(
            "localtunnel", "localtunnel (npx)", ("loca.lt",),
            "no account",
            "needs Node.js; the browser shows a one-time tap-through page",
            _build_localtunnel,
        ),
        Provider(
            "devtunnel", "Microsoft dev tunnels", ("devtunnels.ms",),
            "free account",
            "install the devtunnel CLI, then 'devtunnel user login' once",
            _build_devtunnel,
        ),
        Provider(
            "custom", "Custom command", (), "depends",
            "runs your own command (--tunnel-cmd / $BT16_TUNNEL_CMD) and reads "
            "the URL from its output",
            None,
        ),
    )
}


def resolve_tunnel_provider(provider: str | None) -> str:
    """Map a --tunnel value (or a short alias) onto a provider name."""
    name = (provider or "auto").strip().lower()
    return PROVIDER_ALIASES.get(name, name)


def custom_command_argv(command: str | None, port: int) -> Optional[list[str]]:
    """
    Split a user-supplied tunnel command into argv.

    `{port}` is substituted with the server port, so the same string keeps
    working when --port changes.
    """
    text = (command or "").strip()
    if not text:
        return None
    return shlex.split(text.replace("{port}", str(port)))


def provider_table() -> str:
    """Human-readable menu of every provider, printed by --tunnel-list."""
    width = max(len(name) for name in PROVIDERS)
    rows = []
    for name in PROVIDERS:
        if name == "auto":
            rows.append(f"  {'auto':<{width}} try the no-account providers in turn")
            continue
        spec = PROVIDER_SPECS[name]
        # Plain ASCII: this table is read on whatever terminal happens to be
        # open, and Windows consoles mangle the em dash the rest of the banner
        # uses. The two columns still line up.
        rows.append(f"  {spec.name:<{width}} {spec.label} - {spec.auth}")
        rows.append(f"  {'':<{width}} {spec.note}")
    return "\n".join(rows)


# -----------------------------------------------------------------------------
# Tunnel process
# -----------------------------------------------------------------------------
class Tunnel:
    """A running tunnel process plus the public URL it produced."""

    def __init__(
        self,
        provider: str,
        port: int,
        tools_dir: Path,
        log: Log = print,
        custom_command: str | None = None,
    ):
        self.provider = provider
        self.port = port
        self.tools_dir = tools_dir
        self.log = log
        self.custom_command = custom_command
        self.proc: Optional[subprocess.Popen] = None
        self.url: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        # Every public-looking URL this process printed, in order. Used as a
        # last-resort guess when a service answers on a host we do not know.
        self._urls_seen: list[str] = []

    # --- command construction ---------------------------------------------
    def _command(self) -> Optional[list[str]]:
        if self.provider == "custom":
            argv = custom_command_argv(self.custom_command, self.port)
            if not argv:
                self.log("[bt16] no custom tunnel command")
                self.log("        Pass --tunnel-cmd \"<command that prints a URL>\"")
                self.log("        or set BT16_TUNNEL_CMD. '{port}' becomes the port.")
                return None
            return argv

        spec = PROVIDER_SPECS.get(self.provider)
        if spec is None or spec.build is None:
            self.log(f"[bt16] unknown tunnel provider: {self.provider}")
            return None
        return spec.build(self.port, self.tools_dir, self.log)

    @property
    def _hosts(self) -> tuple[str, ...]:
        """Host suffixes this provider's URLs are known to use."""
        spec = PROVIDER_SPECS.get(self.provider)
        return spec.hosts if spec else ()

    # --- lifecycle ---------------------------------------------------------
    def start(self, timeout: float = 45.0) -> Optional[str]:
        """Start the tunnel and wait for a public URL. Returns it, or None."""
        cmd = self._command()
        if not cmd:
            return None

        self.log(f"[bt16] starting tunnel: {self.provider}")
        try:
            self.proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            self.log(f"[bt16] could not start {self.provider}: {exc}")
            return None

        found = threading.Event()
        accept_any = self.provider == "custom"

        def reader() -> None:
            assert self.proc and self.proc.stdout
            for line in self.proc.stdout:
                line = line.rstrip()
                if not line:
                    continue
                url = public_url_from_line(line, self._hosts, accept_any)
                if not url:
                    # Remember anything public-looking, for _fallback_url().
                    guess = public_url_from_line(
                        line, accept_any=True,
                    )
                    if guess and guess not in self._urls_seen:
                        self._urls_seen.append(guess)
                if url and not found.is_set():
                    self.url = url
                    found.set()
                # Verbose providers are noisy; keep only useful lines.
                if url or "error" in line.lower() or "fail" in line.lower():
                    self.log(f"    [{self.provider}] {line}")

        self._thread = threading.Thread(target=reader, daemon=True)
        self._thread.start()

        deadline = time.time() + timeout
        while time.time() < deadline:
            if found.is_set():
                return self.url
            if self.proc.poll() is not None:
                self.log(f"[bt16] {self.provider} exited early (code {self.proc.returncode})")
                return self._fallback_url()
            time.sleep(0.25)

        self.log(f"[bt16] timed out waiting for a {self.provider} URL")
        return self._fallback_url()

    def _fallback_url(self) -> Optional[str]:
        """
        Last resort: a single, unambiguous public URL we did not recognise.

        Services occasionally move to a new (or regional) domain before this
        file hears about it. Accepting one lone candidate keeps those usable
        without loosening the match for every other provider — two or more
        candidates means we are guessing, so we decline instead.
        """
        if self.url:
            return self.url
        candidates = [url for url in self._urls_seen if _is_public_url(url, require_subdomain=True)]
        if len(candidates) == 1:
            self.url = candidates[0]
            self.log(f"[bt16] using the only URL {self.provider} printed: {self.url}")
            return self.url
        return None

    def stop(self) -> None:
        if not self.proc:
            return
        try:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        except OSError:
            pass
        finally:
            self.proc = None


def start_tunnel(
    port: int,
    provider: str,
    tools_dir: Path,
    log: Log = print,
    custom_command: str | None = None,
) -> Optional[Tunnel]:
    """
    Start a tunnel, honouring `auto`, the aliases and the custom command.

    `auto` walks AUTO_ORDER — cloudflared first (no account, real certificate),
    then the ssh-based free services, then the two that want a sign-in. An
    explicit provider is retried once, because the free ssh tiers do sometimes
    drop the very first connection. `custom` runs the caller's own command, so
    **any** service that prints a URL works without touching this file.
    """
    name = resolve_tunnel_provider(provider)

    if name == "custom" or (name == "auto" and custom_command):
        order = ["custom"]
    elif name == "auto":
        order = list(AUTO_ORDER)
    elif name in PROVIDER_SPECS:
        order = [name]
    else:
        log(f"[bt16] unknown tunnel provider '{provider}'")
        log(f"        known providers: {', '.join(PROVIDERS)}")
        log(f"        aliases: {', '.join(sorted(PROVIDER_ALIASES))}")
        return None

    # Retry a single explicit provider once (the free ssh tiers do drop the
    # first connection), but never a custom command: it is deterministic, and a
    # second start could leave a duplicate process holding the port.
    attempts = 2 if len(order) == 1 and order[0] != "custom" else 1

    for provider_name in order:
        for attempt in range(attempts):
            if attempt:
                log(f"[bt16] retrying {provider_name}…")
            tunnel = Tunnel(provider_name, port, tools_dir, log, custom_command)
            if tunnel.start():
                return tunnel
            tunnel.stop()
        if len(order) > 1:
            log(f"[bt16] {provider_name} did not produce a URL — trying the next option")

    return None


# -----------------------------------------------------------------------------
# Verifying the public URL
# -----------------------------------------------------------------------------
def verify_url(url: str, timeout: float = 10.0, attempts: int = 3, log: Log = print) -> Optional[int]:
    """
    Best-effort check that the public URL really serves the game.

    A tunnel can hand out a URL seconds before it can serve traffic, and a
    URL that 502s is much worse than no URL at all when the phone is already in
    a backpack. Returns the HTTP status code, or None if nothing answered.

    A 4xx is not automatically wrong: localtunnel answers 511 with a tap-through
    page on the first request, which a phone browser handles fine.
    """
    target = url.rstrip("/") + "/"
    status: Optional[int] = None
    for attempt in range(max(1, attempts)):
        request = urllib.request.Request(
            target, headers={"User-Agent": "bt16-tunnel-check"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = response.status
                break
        except urllib.error.HTTPError as exc:
            status = exc.code
            break
        except (urllib.error.URLError, OSError, ValueError) as exc:
            if attempt == max(1, attempts) - 1:
                log(f"[bt16] could not reach {target} yet: {exc}")
                return None
            time.sleep(2)

    if status is None:
        return None
    if 200 <= status < 300:
        log(f"[bt16] tunnel verified — {target} answers HTTP {status}")
        report_client_files(url, timeout, log)
        report_module_type(url, timeout, log)
    else:
        log(f"[bt16] {target} answers HTTP {status} (open it in a browser once)")
    return status


def report_client_files(url: str, timeout: float = 10.0, log: Log = print) -> list[str]:
    """
    Ask the server behind the tunnel whether its client files are all present.

    `/api/health` reports the ones that are not, which is the difference between
    "the page sits on the splash screen for ever" and a named file to restore.
    Returns the missing list (empty when everything is fine).
    """
    target = url.rstrip("/") + "/api/health"
    try:
        with urllib.request.urlopen(target, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return []  # older server without the field — nothing to report

    missing = payload.get("missing") or []
    if missing:
        log(f"[bt16] !! the server is missing {len(missing)} client file(s):")
        for name in missing[:12]:
            log(f"        web/{name}")
        log("        The page will stay on the splash screen. Restore them and")
        log("        reload — this is a copy problem, not a tunnel problem.")
    return missing


def report_module_type(url: str, timeout: float = 10.0, log: Log = print) -> Optional[str]:
    """
    Check that a real module comes back as JavaScript.

    A tunnel that answers `/` with the page but a `.js` with HTML (a stale cached
    error page, a proxy in the middle) fails in the browser with a MIME error and
    a splash screen that never ends. Catching it here means finding out before
    the phone is out of the house.
    """
    target = url.rstrip("/") + "/js/main.js"
    try:
        with urllib.request.urlopen(target, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        log(f"[bt16] !! {target} did not load ({exc})")
        log("        The game cannot start. Check the server's startup output.")
        return None

    if "javascript" not in content_type:
        log(f"[bt16] !! {target} came back as {content_type!r}, not JavaScript")
        log("        Something between the phone and the server is serving HTML for")
        log("        the modules (usually a cached error page). Bump the ?v= number")
        log("        in web/index.html and every import in web/js/, then reload.")
    return content_type


# -----------------------------------------------------------------------------
# USB hosting (adb reverse) — Android
# -----------------------------------------------------------------------------
def ensure_adb(log: Log = print) -> Optional[str]:
    """Return an adb path if one is available, else None."""
    return shutil.which("adb")


def adb_reverse(port: int, log: Log = print) -> bool:
    """
    Forward the phone's localhost:PORT to this computer's localhost:PORT.

    `adb reverse` makes an *outbound* connection to the attached device, so no
    firewall rule and no administrator rights are required.
    """
    adb = ensure_adb(log)
    if not adb:
        log("[bt16] adb was not found on PATH.")
        log("        Install Android Platform Tools, then enable USB debugging")
        log("        on the phone and run this mode again.")
        return False

    try:
        devices = subprocess.run(
            [adb, "devices"], check=False, capture_output=True, text=True, timeout=20,
        ).stdout
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"[bt16] could not run adb: {exc}")
        return False

    attached = [
        line.split("\t")[0]
        for line in devices.splitlines()[1:]
        if line.strip() and "\tdevice" in line
    ]
    if not attached:
        log("[bt16] no USB device found.")
        log("        Connect the phone by USB, enable USB debugging, then accept")
        log("        the 'Allow USB debugging' prompt on the phone.")
        return False

    try:
        result = subprocess.run(
            [adb, "reverse", f"tcp:{port}", f"tcp:{port}"],
            check=False, capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"[bt16] adb reverse failed: {exc}")
        return False

    if result.returncode != 0:
        log(f"[bt16] adb reverse failed: {result.stderr.strip() or result.stdout.strip()}")
        return False

    log(f"[bt16] adb reverse active for {len(attached)} device(s): tcp:{port} -> tcp:{port}")
    return True


def adb_reverse_remove(port: int, log: Log = print) -> None:
    adb = ensure_adb(log)
    if not adb:
        return
    try:
        subprocess.run(
            [adb, "reverse", "--remove", f"tcp:{port}"],
            check=False, capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


# -----------------------------------------------------------------------------
# Diagnostics
# -----------------------------------------------------------------------------
def platform_report() -> str:
    """
    What this machine can actually run, printed by --tunnel-list.

    Every provider behaves the same on Windows, Linux and macOS, but which ones
    are *available* depends on the box: a bare container has no ssh, a Windows
    shell has no npx unless Node is installed, and a RISC-V or POWER host has no
    cloudflared build at all. This answers "will the tunnel work here?" before a
    single provider is tried.
    """
    lines = [
        f"  platform     {platform.system()} {platform.machine()} "
        f"(Python {platform.python_version()})",
    ]
    tools = (
        ("ssh", "localhost.run / pinggy / serveo"),
        ("ngrok", "ngrok (free account)"),
        ("tailscale", "Tailscale Funnel (free account)"),
        ("npx", "localtunnel (needs Node.js)"),
        ("devtunnel", "Microsoft dev tunnels (free account)"),
    )
    for tool, why in tools:
        found = shutil.which(tool)
        if not found and os.name == "nt":
            found = shutil.which(f"{tool}.cmd")
        mark = "found" if found else "missing"
        lines.append(f"  {mark:<12}{tool:<12}{why}")

    assets = cloudflared_assets()
    if shutil.which("cloudflared"):
        note = "on PATH"
    elif assets:
        note = f"downloads {', '.join(assets)}"
    else:
        note = "no build for this CPU — use another provider"
    lines.append(f"  {'':<12}{'cloudflared':<12}{note}")
    return "\n".join(lines)


def download_root_ca_hint() -> str:
    """One-line hint about trusting the self-signed certificate (LAN mode)."""
    if os.name == "nt":
        return "Windows: install server/certs/cert.pem into 'Trusted Root Certification Authorities' (certmgr.msc)."
    if sys.platform == "darwin":
        return "macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain server/certs/cert.pem"
    return "Linux (Debian/Ubuntu): sudo cp server/certs/cert.pem /usr/local/share/ca-certificates/bt16.crt && sudo update-ca-certificates"
