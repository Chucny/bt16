# bt16 server

The small Python server behind the Back to 16 webpage. It serves the app over
HTTPS, stores player progress as **plain JSON** (never SQLite) and collects the
browser's console output into `logs/log.json`.

## Run

Four hosting modes. Only the first needs administrator rights.

| Mode | Command | Reachable from | Admin |
| --- | --- | --- | --- |
| LAN / Wi-Fi | `python server.py` | any device on the network | **yes** (firewall rule) |
| USB (Android) | `python server.py --usb` | the phone on the USB cable | no |
| Tunnel | `python server.py --tunnel` | any phone, anywhere — no Wi-Fi needed | no |
| Local | `python server.py --local` | this computer only | no |

All four work on **Windows, Linux and macOS**.

Requires **Python 3.8+**. The standard library is enough; `cryptography`
(`pip install cryptography`) is used only as a fallback for certificate
generation if `openssl` is missing.

#### On Linux

Use `python3` — most distributions have no bare `python`:

```bash
python3 server.py --tunnel
```

`server.py`, `hosting.py` and `selftest.py` all shebang `python3` and are
executable, so `./server.py --tunnel` works too.

Nothing in the Python is platform-specific, and the tunnel providers are
architecture-aware:

* the ssh-based providers (`localhost.run`, `pinggy`, `serveo`) use the
distribution's `openssh-client`. If it is missing, the error names the package
for apt / dnf / apk.
* **`cloudflared` is downloaded for the right CPU.** Cloudflare builds linux
  `amd64`, `arm64`, `arm` (ARMv6), `armhf` (ARMv7 hard float) and `386`, so a
  Raspberry Pi, an ARM NAS, a container and a server are all covered. 32-bit ARM
  tries `armhf` first and falls back to `arm`, which is what makes an older Pi
  work.
* Hosts with no `cloudflared` build at all — RISC-V, POWER, s390x — fall through
  to the next provider instead of failing, and say so.
* Distributions whose `ssh` predates **OpenSSH 7.6** (Debian 9, Ubuntu 16.04,
  CentOS 7, Amazon Linux 1) do not understand
  `StrictHostKeyChecking=accept-new`; bt16 detects that and uses the prompt-free
  equivalent, so those ssh providers still start.

```bash
python3 server.py --tunnel-list   # platform + which tunnel tools are installed
```

### LAN / Wi-Fi (default)

```bash
python server.py                 # HTTPS, 0.0.0.0:8443
python server.py --port 9443
python server.py --public        # also print the public IP
```

Opens an inbound port, so it usually needs elevation. On first start a
self-signed certificate is written to `server/certs/` with a SAN covering
`localhost`, `127.0.0.1` and your LAN IP. Browsers warn — accept the warning, or
trust the certificate (the server prints the per-OS command).

Without elevation the server still starts but tells you the phone will not be
able to connect, and points at the three modes below.

### USB — Android (no admin)

```bash
python server.py --usb
```

Runs `adb reverse tcp:8443 tcp:8443`. Because that is an **outbound** connection
to the attached device there is no firewall rule and no elevation. On the phone:

```
http://localhost:8443/
```

`localhost` is a secure context, so the camera and motion sensors work with no
certificate warning. Needs
[Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)
(`adb`) on `PATH`, USB debugging enabled, and the "Allow USB debugging" prompt
accepted. The forwarding is removed again on Ctrl+C.

### Tunnel (no admin, iPhone-friendly) — play anywhere

This is the mode for **leaving the house**: it gives you a public HTTPS URL you
can open on a phone that is not on your Wi-Fi at all — a football court, a park,
a forest. You only need a mobile signal on the phone.

```bash
python server.py --tunnel           # auto: the no-account providers, best first
python server.py --tunnel pinggy    # or name one (see below)
python server.py --tunnel-list      # list every provider, and this machine's tools
```

The server binds `127.0.0.1` and opens an **outbound** tunnel, then prints a
public HTTPS URL (`https://….trycloudflare.com/`) — and then **checks it**: it
fetches the URL through the tunnel before telling you it is ready, so you do not
walk to the park with a URL that 502s. The certificate is real, so there is no
browser warning and no port forwarding to configure.

#### Providers

| `--tunnel` | Account needed | Notes |
| --- | --- | --- |
| `auto` (default) | none | walks the no-account providers in turn, then ngrok / Tailscale |
| `cloudflared` | none | Cloudflare quick tunnel; the binary is downloaded into `server/tools/` |
| `localhost.run` (`ssh`) | none | plain `ssh`, random URL each run |
| `pinggy` | none | plain `ssh`; free sessions last 60 minutes |
| `serveo` | none | plain `ssh`; a good fallback when the others are busy |
| `localtunnel` (`lt`) | none | needs Node.js; the browser shows a one-time tap-through page |
| `ngrok` | free account | `ngrok config add-authtoken <token>`, or set `$NGROK_AUTHTOKEN` |
| `tailscale` (`ts`) | free account | Tailscale Funnel — the most stable option once set up |
| `devtunnel` | free account | Microsoft dev tunnels CLI + `devtunnel user login` |
| `custom` | depends | **any other service** — see below |

`cloudflared` is downloaded on demand to `server/tools/` — inside the project,
never a system location. A copy already on `PATH` is used instead.

The public URL changes on every restart.

#### Bringing your own tunnel service

`--tunnel custom` runs any command you like and reads the public URL straight out
of its output, so a service bt16 has never heard of still works. `{port}` is
substituted with the server port:

```bash
python server.py --tunnel custom --tunnel-cmd "bore local {port} --to bore.pub"
python server.py --tunnel-cmd "ngrok http {port} --domain my-name.ngrok-free.app"
```

Set `BT16_TUNNEL_CMD` instead of passing `--tunnel-cmd` every time, and
`BT16_TUNNEL_PROVIDER` to change what a bare `--tunnel` means.

Only `custom` accepts *any* host: for the known providers the URL is matched
against that service's own domains (and their usual variants), which is what
stops a banner line like `https://ngrok.com/download` from being mistaken for
the tunnel.

### Local (no admin)

```bash
python server.py --local
```

Serves `http://127.0.0.1:8443/` for this machine only. Good for checking the UI;
a desktop browser cannot run SLAM.

## What it serves

| URL | Source |
| --- | --- |
| `/` and everything else | `../web/` |
| `/assets/…` | `../assets/` |

The client uses absolute `/assets/…` URLs; the handler rewrites them onto the
asset tree at the project root.

## API

| Method | Endpoint | Body / Query | Result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{"ok":true,"missing":[]}` — `missing` lists any client file that is not on disk |
| `POST` | `/api/register` | `{username,password}` | creates the player, `409` if taken |
| `POST` | `/api/login` | `{username,password}` | `{ok, player}`, `401` on bad credentials |
| `GET` | `/api/player` | `?username=` | `{ok, player}` |
| `POST` | `/api/save` | `{username, inventory, pokedex}` | writes the player file |
| `POST` | `/api/log` | `{username, entries:[{t,level,message}]}` | appends to `logs/log.json` |

## Storage

```
server/
├── certs/           generated TLS cert + key (git-ignored, LAN mode only)
├── data/players/    <username>.json — one file per trainer (git-ignored)
├── logs/log.json    newest 5000 console lines (git-ignored)
└── tools/           cloudflared downloaded on demand (git-ignored)
```

Player files are written atomically (temp file + rename) so a crash mid-write
cannot corrupt progress. Passwords are stored in clear text, matching the
human-readable format the project specifies — **this is a LAN fan project, not a
production service**; do not reuse an important password.

## Tests

```bash
python selftest.py
```

Boots the real handler on a loopback port in a thread and exercises static
routing (including the `/assets` rewrite), every API endpoint, JSON persistence,
and the non-admin hosting helpers (tunnel URL parsing, per-platform cloudflared
asset selection, mode precedence). Uses a throwaway data directory, so it never
touches real player files.

## Exposing it beyond the LAN

`--public` detects and prints your public IP, but you still need port forwarding
and a firewall rule. `--tunnel` is almost always the better answer: it needs no
elevation, gives you real HTTPS, and works for iPhones.
