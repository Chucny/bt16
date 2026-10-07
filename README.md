# Back to 16 — `bt16`

A Pokémon GO–style **AR game with no map**, built on **6DoF SLAM**. Pokémon
spawn around you on their own every few seconds, wander across the floor, and
are caught by swiping Poké Balls at them. Everything runs in the browser; a small
Python server serves the page over HTTPS on your LAN and stores your progress as
plain JSON.

> [Credits and licensing](#credits-and-licensing).

---
### Screenshots
Coming soon!

### UI style

The interface **copies the style and colours of the Pokémon GO screenshots in
`references/` 1:1** — layout stays bt16's own, the vibe is GO's. That means: a
**mint-white sheet** inside the **green→teal edge frame** (`#b4f09c` → `#44b9b6`),
**slate ink** (`#44696c`) for every heading, title and number, gray-teal
captions (`#90a6a7`), and the **green→teal gradient pill** (`#a5db92` →
`#1fc9a6`) with bold white uppercase copy for primary buttons — secondary
actions are plain teal text (`#1d8696`), like GO's CANCEL. Green is reserved
for controls and a few small accents: **text and numbers are neutral, never
green**. Few borders, generous corner radii, and soft flat shadows; no
neumorphic insets. The **Pokédex** sits on GO's white→lavender→periwinkle
sheet with borderless cells, and the **item menu** is GO's ITEMS list — icon
with its pale count pill, bold slate name, hairline rows — showing a plain
count (bt16 items have no capacity). The mint discs and the rest of the icon
set are taken straight from the Pokémon GO button art in
`assets/pokemon-go/important-icons/menu/`, including the close X (teal disc,
mint cross), which is already exactly the reference button.

Two layout rules hold everywhere:

* **Every in-game UI is fullscreen** — the item menu, storage, Pokédex,
inspection and snapshot fill the viewport. None of them is a floating card.
* **Every one of them closes with the same X**: horizontally centred, at the
  bottom of the screen, floating above the panel. `ui.css` centres it with
  `left: 0; right: 0; margin: 0 auto` rather than `translateX(-50%)`, so the
  press feedback can shrink the button without sliding the hit box out from
  under your finger.

The **outdoor tutorial** is the one deliberate exception to "everything is
fullscreen": it is a single big centred card, because it is a message rather
than a screen. It has no X — its one large OK button is the only exit.

Item icons are the real Pokémon GO item sprites (`pokeball_sprite.png` and
friends, copied in as `assets/items/icons/png/*-ball.png`), and the bottom-right
bag button is `btn_items_encounter.png`.

---

## Layout

```
bt16/
├── assets/                     the asset tree the game actually uses
│   ├── pokemon/
│   │   ├── models/glb/gen1/    151 Pokémon GLB models (6 animations each)
│   │   ├── icons/png/gen1/     151 Pokémon icons (inventory / Pokédex)
│   │   └── cries/{1996,2016}/  cries
│   ├── items/
│   │   ├── models/             poke-ball / great-ball / ultra-ball / premier-ball GLBs
│   │   └── icons/png/          item sprites for the item menu
│   └── pokemon-go/
│       ├── important-icons/    menu buttons, backgrounds, type art, professor
│       ├── NEEDED_MAP_OBJECTS/  pokestop-open.glb / pokestop-closed.glb
│       ├── sounds/             menu / encounter / map sounds
│       ├── LOADING_SCREEN.webp
│       └── TITLE_SCREEN.mp3
│
├── web/                        the webpage (served at /)
│   ├── index.html
│   ├── config/
│   │   └── game-master.json    every gameplay tunable (see "Game master")
│   ├── css/ui.css
│   ├── js/
│   │   ├── main.js             boot: splash → login → loading → AR → game
│   │   ├── core.js             state, event bus, audio, helpers
│   │   ├── gamemaster.js       loads + merges the game-master JSON
│   │   ├── data.js             Gen 1 Pokédex, items, asset URLs
│   │   ├── net.js              server API, cookies, console logging, 10 s sync
│   │   ├── ar.js               8th Wall pipeline modules + SLAM helpers
│   │   ├── gltf.js             GLB loading, template caching, instancing
│   │   ├── pokemon.js          Pokémon behaviour + the timed spawner
│   │   ├── ball.js             throw physics + the catch sequence
│   │   ├── hologram.js         holographic Pokémon inspection
│   │   └── ui.js               splash / loading / login / HUD / menus
│   └── vendor/                 the only third-party code that ships
│       ├── xr/                 8th Wall engine (MIT)
│       ├── xr-binary/          8th Wall SLAM chunk (limited-use binary)
│       ├── xrextras/           8th Wall helpers (MIT)
│       └── three/              three.js + GLTFLoader (MIT)
│
├── server/
│   ├── server.py               HTTP(S) server, JSON player store, log.json
│   ├── hosting.py              non-admin hosting: USB (adb reverse) + tunnels
│   ├── selftest.py             in-process tests for routing, API and helpers
│   ├── requirements.txt
│   └── README.md
│
├── LICENSE                     GNU GPL v3.0
└── README.md
```

Only the parts of the AR engine the game needs are vendored — **no AR demos** —
and only the used slice of the asset tree is copied into `assets/`.

---

## Running it

### 1. Start the server

Pick the hosting mode that fits your setup. **Only the first one needs
administrator rights** (it has to open an inbound firewall port); the other three
work on a normal, locked-down account.

| Mode | Command | Who can reach it | Admin? |
| --- | --- | --- | --- |
| **LAN / Wi-Fi** | `python server.py` | every device on your network | yes, for the firewall rule |
| **USB** (Android) | `python server.py --usb` | the phone on the USB cable | **no** |
| **Tunnel** | `python server.py --tunnel` | any phone, anywhere — no Wi-Fi needed | **no** |
| **Local** | `python server.py --local` | this computer only | **no** |

All four work on **Windows, Linux and macOS**. Nothing in the Python is
platform-specific.

> **On Linux, use `python3`** (most distributions have no bare `python`):
> `python3 server.py --tunnel`. The three server scripts shebang `python3` and
> are executable, so `./server.py --tunnel` works too.
>
> The tunnel providers are architecture-aware: `cloudflared` is downloaded for
> the right CPU (Linux `amd64`, `arm64`, `arm` for ARMv6, `armhf` for ARMv7 hard
> float, and `386`), so a Raspberry Pi or an ARM NAS works like a server. Hosts
> with no build at all — RISC-V, POWER, s390x — fall through to the next
> provider, and a distribution whose `ssh` predates OpenSSH 7.6 still works
> because bt16 detects it and uses the prompt-free equivalent.
>
> `python3 server.py --tunnel-list` prints the platform and which tunnel tools
> are installed.

#### LAN / Wi-Fi (default)

```bash
cd server
python server.py
```

```
  Open this on your phone (same Wi-Fi):
    https://192.168.1.42:8443/
```

A self-signed certificate is generated on first run (via `openssl`, or
`cryptography` as a fallback). **Accept the browser warning** — the camera and
motion sensors require a secure context.

If the process is not elevated the server says so and prints the three
non-admin alternatives instead of leaving you with a silent failure.

#### USB — Android, no admin, no Wi-Fi (recommended when you cannot open a port)

```bash
python server.py --usb
```

This runs `adb reverse tcp:8443 tcp:8443`, which is an **outbound** connection to
the attached phone, so no firewall rule is involved. On the phone open:

```
http://localhost:8443/
```

`localhost` is itself a secure context, so the camera and motion sensors work
with **no certificate warning at all**. Requires
[Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)
(`adb`) and USB debugging enabled on the phone.

#### Tunnel — a public HTTPS URL, to play anywhere

**This is the one to use when you want to leave the house.** It hands you a
public HTTPS URL that opens on a phone that is on mobile data, with no Wi-Fi
anywhere in sight — a football court, a park, a forest, which is where the game
actually wants you (see the [outdoor tutorial](#what-it-looks-like)).

```bash
python server.py --tunnel           # auto: the no-account providers, best first
python server.py --tunnel pinggy    # or pick one
python server.py --tunnel-list      # list them all
```

The server stays bound to `127.0.0.1` and makes an **outbound** tunnel, printing a
public URL such as `https://calm-river-1234.trycloudflare.com/`. The certificate
is real, so the camera works without any warning and no port forwarding is
needed. It then fetches the URL through the tunnel before reporting success, so
you do not leave the house holding a URL that never worked.

**Providers** — the no-account ones work on a fresh machine:

| `--tunnel` | Account | Notes |
| --- | --- | --- |
| `auto` (default) | none | walks the no-account providers, then ngrok / Tailscale |
| `cloudflared` | none | Cloudflare quick tunnel; binary cached in `server/tools/` |
| `localhost.run` (`ssh`) | none | plain `ssh` client only, random URL each run |
| `pinggy` | none | plain `ssh`; free sessions last 60 minutes |
| `serveo` | none | plain `ssh`; a good fallback when the others are busy |
| `localtunnel` (`lt`) | none | needs Node.js; one-time tap-through page in the browser |
| `ngrok` | free | `ngrok config add-authtoken <token>`, or `$NGROK_AUTHTOKEN` |
| `tailscale` (`ts`) | free | Tailscale Funnel — the most stable once set up |
| `devtunnel` | free | Microsoft dev tunnels CLI + `devtunnel user login` |
| `custom` | depends | **any other service** that prints a URL |

**Any service you like** — `--tunnel custom` runs your own command and reads the
public URL out of its output (`{port}` is the server port):

```bash
python server.py --tunnel custom --tunnel-cmd "bore local {port} --to bore.pub"
```

Set `BT16_TUNNEL_CMD` to avoid repeating `--tunnel-cmd`, and
`BT16_TUNNEL_PROVIDER` to change what a bare `--tunnel` means.

The URL changes each time you restart the tunnel.

#### Local — this machine only

```bash
python server.py --local
```

Serves `http://127.0.0.1:8443/`. Useful for checking the UI; a desktop browser
cannot run SLAM, so use USB or a tunnel for a real phone.

You can also make a phone trust the LAN certificate permanently instead of
clicking through the warning — the server prints the exact command for your OS
(`certmgr.msc` on Windows, `security add-trusted-cert` on macOS,
`update-ca-certificates` on Linux).

### 2. Open the page on your phone

Open the URL the server printed (the LAN `https://…`, the USB
`http://localhost:…`, or the tunnel `https://…`), sign in (or create an account),
and grant camera permission.

### 3. Play

| Gesture | Action |
| --- | --- |
| **Wait** | Pokémon spawn on their own every ~10 s (max 4 at once, 2–10 m away) — best outside, in an open area |
| **Tap a PokéStop** | Spin it — 1–4 item bubbles pop out |
| **Tap a bubble** | Collect its 1–4 Poké Balls |
| **Swipe up on the feed** | Throw the selected ball — swipe faster/further to throw harder, add a little sideways drift by swiping diagonally |
| **Tap the hologram** | In inspection, make the Pokémon attack |
| **Action-menu button** (upper-left) | Open Pokémon storage (inventory) |
| **Pokédex button** (below it) | Open the Pokédex |
| **Tap a storage tile** | Open the holographic inspection |
| **Tap the red transfer disc** (in inspection) | Release the Pokémon and free its storage slot |
| **Camera button** (upper-right) | Take a snapshot |
| **Bag button** (bottom-right, the GO encounter bag) | Open the item menu and switch balls — the ball you are holding is badged on the button |

---

## How it plays

### Game master

Every gameplay number lives in **`web/config/game-master.json`**: spawn cadence
and distances, species rarity, catch chances, throw strength, ball physics, the
wobble and celebration timings, wander speeds, item defaults, and even the
tutorial copy. The client fetches it once at boot (`web/js/gamemaster.js`) and
the game reads it live, so **retuning the game is a JSON edit, not a code
change** — no build step, no constants to hunt down.

```json
{
  "spawn":       {"intervalMs": 10000, "intervalJitterMs": 4000, "maxAlive": 4,
                  "minDistanceM": 2, "maxDistanceM": 10, "minSeparationM": 2},
  "species":     {"legendaryChance": 0.08, "legendaryDex": [144, 145, 146, 150, 151]},
  "catch":       {"chance": {"poke": 0.5, "great": 0.65, "ultra": 0.8, "premier": 0.55},
                  "legendaryMultiplier": 0.4, "shakeSeconds": 2},
  "throw":       {"powerBase": 3.2, "powerPerLength": 7, "lateralPower": 3.2},
  "ball":        {"gravity": 9.81, "diameterM": 0.22, "hitBounceM": 1,
                  "groundBounceM": 0.15, "missBounceCount": 3,
                  "missBounceBaseM": 0.22, "rollSeconds": 1.6},
  "tracking":    {"lostAfterS": 3, "advanced": true,
                  "lostStatuses": ["LIMITED", "NOT_AVAILABLE"]},
  "celebration": {"starSeconds": 1.5, "fadeSeconds": 0.5, "starCount": 10},
  "pokemon":     {"wanderMinS": 5, "wanderMaxS": 6, "walkSpeedMps": 0.9,
                  "despawnAfterS": 1.5, "smokeSeconds": 2},
  "pokestops":   {"enabled": true, "maxAlive": 1, "cooldownS": 60,
                  "spin": {"initialSpeedRadS": 40, "friction": 1.4},
                  "bubbles": {"min": 1, "max": 4, "awardMin": 1, "awardMax": 4}},
  "items":       {"unlimited": false, "default": "poke"},
  "ui":          {"tutorialDelayMs": 1000, "outdoorHintEveryMs": 20000}
}
```

The sections are `spawn`, `species`, `catch`, `throw`, `ball`, `tracking`,
`celebration`, `pokemon`, `pokestops`, `items` and `ui`; the file itself carries a `_comment` key spelling
out the units (`_M` metres, `_S` seconds, `_Ms` milliseconds, `_Rad` radians).
`gamemaster.js` bakes in the same values as defaults, so a missing or malformed
file can never leave the game with `NaN` physics — the JSON simply wins when it
loads.

### Spawning

* Spawns happen **automatically**, roughly one every **10 seconds**, with a
  little jitter so the cadence feels random rather than metronomic. A miss
  retries in `spawn.retryMs` instead of losing the whole cycle, so an empty
  world fills in seconds.
* At most **4** Pokémon alive at once.
* They appear **2–10 m** from the player, on surfaces SLAM has marked as
  walkable floors — including **raised surfaces such as tables and benches** when
  [advanced tracking](#advanced-surface-tracking) is on — and **never closer
  than 2 m to each other**.
* Placement prefers ground the player is actually looking at, collapses
  duplicate surface samples and stops the feed scan early, so finding a spot is
  far cheaper than it used to be.
* **Streets work.** SLAM often finds no surface on asphalt, tarmac or plain
  concrete. When that happens bt16 falls back to the smoothed session floor
  line — the same plane the shadows sit on — and lays the spawn down in the arc
  you are facing. That is what stops a street from answering *“No luck here”*.
* They **fade in** rather than popping in.
* **Spawns want open space.** A Pokémon needs a lit, textured, walkable surface
  with room around it, and indoors a room offers very little of that — so they
  are far more likely to appear on a lawn, in a park or in any big open area.
  That is the whole reason for the
  [outdoor tutorial](#what-it-looks-like), and if the world stays empty for a
  while bt16 says so on screen: *“No luck here — try an open area outside, away
  from walls.”* (timings: `ui.outdoorHintEveryMs` / `ui.outdoorHintCooldownMs`).

Every one of those numbers is `spawn` / `species` in the
[game master](#game-master).

### PokéStops

One PokéStop is kept alive at a time, on a stable spot on the ground a few
metres in front of you. It is placed the same way a Pokémon is (front-biased
surface samples, with the smoothed-ground fallback for featureless streets).

* **Spin** — tap the stop and it launches into a fast rotation about Y that
  decelerates like real friction (`ω = ω₀·e^(−k·t)`), coasting through several
  full turns before it stops. `pokestops.spin.initialSpeedRadS` and
  `pokestops.spin.friction` tune both the speed and how many turns it makes.
* **Rewards** — a spin releases **1–4 soap bubbles** (`bubbles.min` / `.max`),
  each holding an item icon and worth **1–4 Poké Balls** (`.awardMin` / `.awardMax`,
  weighted by `.ballWeights`). Tap a bubble to collect it; an uncollected one
  pops and still pays out as it expires.
* **Cooldown** — a spun stop turns into the **closed, purple** model for
  `pokestops.cooldownS` (60 s). The recharge survives despawns, so you cannot
  farm a fresh stop for a free spin.
* **Despawn** — look away for `pokestops.despawnAfterS` and the stop goes, just
  like a Pokémon; a new one comes up after `pokestops.respawnDelayS`.
* Turn the whole system off with `pokestops.enabled: false`.

The stop GLBs are the open/closed cartridges from the Pokémon GO asset dump's
`NEEDED_MAP_OBJECTS`, normalised at load to `pokestops.heightM` metres tall with
their base on the floor.

### Behaviour

* Default animation is **idle**, played continuously.
* Every **5–6 seconds** a Pokémon plays **attack** once, turns semi-slowly to
  face its destination, then **walks** (looping walk animation) to a new surface
  point that is never closer than **1 m** to the player, and returns to idle.
* It **stays on the surface it is standing on** — a tabletop Pokémon will not
  walk off the edge into thin air, and a floor Pokémon will not climb a bench
  (`pokemon.walkMaxStepM`).
* If it leaves the camera view for **1.5 seconds** it despawns.
* **Lose the world and the Pokémon go with it.** If SLAM reports `LIMITED` or
  `NOT_AVAILABLE` for **3 seconds**, every spawned Pokémon is removed — their
  positions are stale guesses by then, and keeping them means creatures hanging
  in mid-air that drift when tracking returns (`tracking.lostAfterS` /
  `tracking.lostStatuses`).
* Shadows are real: every model casts onto a shadow-catching ground plane.

The six animations in each GLB are, in order: `attack`, `happy`, `idle`, `run`,
`sleep`, `walk`.

### Catching

1. The ball is thrown with the swipe.
2. It flies with gravity.
3. On a hit it bounces ~**1 m** up, the Pokémon fades into the ball, the ball
   falls and **slams** the ground, bounces ~**15 cm**, then **wobbles 1–3 times**
   (each shake takes **2 seconds**). A shake is a smooth wobble, not a spin: the
   ball tilts to the right, sweeps across to the left, then settles back to the
   middle.
   * **1 shake** — the Pokémon breaks out and fades back to its spot.
   * **2 shakes** — it breaks out, plays `run` for ~**3 s** in a random
     direction, then disappears in **smoke** over ~2 s.
   * **3 shakes** — caught! Stars burst and twinkle around the ball for ~**1.5 s**,
     then the ball and the stars fade away and the Pokémon is added to your
     inventory.
4. A ball that **misses** drops to the ground and **bounces 2–3 times**. A Poké
   Ball is hard, so the hops are **very low** (~22 cm, then ~9 cm, ~4 cm); it then
   **rolls** a short way and fades out (`ball.missBounce*`, `ball.roll*`,
   `ball.missFadeSeconds`).

Gravity, bounce heights, throw strength, shake count and timing, catch odds,
the miss bounce and star count are all `catch` / `throw` / `ball` /
`celebration` in the [game master](#game-master).

### Balls

| Ball | Notes |
| --- | --- |
| Poké Ball | default |
| Great Ball | better catch rate |
| Ultra Ball | best catch rate |
| Premier Ball | **legendary Pokémon only** |

**Counts are real.** The bag button badges the ball you are holding with how
many you have left, and every item slot shows its count. Each throw spends one
ball, and PokéStops are where new ones come from — so the bag is a live economy.
Set `items.unlimited: true` in the [game master](#game-master) to go back to
never spending a ball (and hide nothing: the counts still show).

Balls are **22 cm** in diameter (`ball.diameterM` in the
[game master](#game-master)). A trash/discard control is coded but deliberately
not shown (per the brief).

### Pokémon storage (inventory)

Opened from the upper-left action-menu button:

* A header with the storage count (`caught / 600`) and the Pokémon GO close X.
* A **search bar** that filters by nickname, species name or dex number.
* A **3 × X grid** of square, borderless **storage tiles** that grows downward —
  each tile is backed by the real
  `important-icons/pokemon-types/details_type_bg_*.png` art for that Pokémon's
  primary type, with the Pokémon's icon on top and its nickname underneath.
  **No dex number and no CP** are shown (the tiles stay clean).

Storage holds **individual Pokémon, up to 600**, so the same species can be
caught more than once (`STORAGE_LIMIT` in `web/js/data.js`) — exactly like
Pokémon GO. The **Pokédex** still tracks **one entry per species** (151), so a
duplicate catch fills the storage, not a new dex slot. Older saves, which were
keyed by dex number and allowed only one of each species, are migrated on load by
`normaliseInventory()`. When storage is full a caught Pokémon is still registered
in the Pokédex but is not kept, and a toast says so.

To free a slot, open a Pokémon and tap the **red transfer disc** in the
inspection bar. A confirm card asks first ("Transfer <name>?"); on confirm the
Pokémon is released for good and the storage grid is shown again, refreshed. The
**Pokédex entry stays** — releasing never un-registers a species, and it is the
only way to make room once storage reaches 600.

### Pokédex

Shows **001–151** as a borderless grid on the reference's white→lavender
sheet: uncaught entries show their number, caught entries show the Pokémon's
icon and name. Carries the same X as the storage screen.

### Inspection

Tapping a Pokémon in storage opens the **holographic inspection**:

* The Pokémon appears **in the AR world**, lit by the mysterious light-blue
  light that rises from the SLAM floor, standing on the floor and playing
  `idle` continuously. **Tapping it plays the `attack` animation once.**
* Top bar: the species name, the **nickname** as a subtitle (or the dex number
  when it has no custom nickname), and one **type chip per type**, drawn on the
  same `pokemon-types` art used by the storage tiles.
* A **rename pencil** in the Pokémon GO UI colour (the same blue as the X),
  which saves the nickname — it then shows in the inspection header and on the
  storage tile.
* The **X in the middle, below** (`btn_close_normal_dark.png`) fades the
  hologram away and plays `ui_back.mp3`.

---

## Networking

The client talks to the Python server with **GET and POST**:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness probe |
| `POST` | `/api/register` | create a trainer |
| `POST` | `/api/login` | sign in |
| `GET` | `/api/player?username=` | read a trainer |
| `POST` | `/api/save` | push inventory + Pokédex |
| `POST` | `/api/log` | push buffered console output |

* The **inventory and Pokédex sync every 10 seconds**, and on important events
  (a catch, a rename, leaving the page).
* The browser **console output is mirrored to `server/logs/log.json`**.
* Credentials are remembered in **cookies**, so the login screen is pre-filled
  and auto-signs-in on your next visit.
* The server keeps everything in **JSON files, never SQLite**:

`server/data/players/<username>.json`

```json
{
  "username": "player",
  "password": "password123",
  "pokemon": {
    "151-m9x2k-a1b2c": { "dex": 151, "nickname": "Mew", "caughtDate": 1759000000, "cp": 0, "pokedex_entry": 151 },
    "1-m9x2k-d4e5f":   { "dex": 1, "nickname": "Bulba-sauli", "caughtDate": 1759000000, "cp": 0, "pokedex_entry": 1 }
  },
  "pokedex": {
    "1": true,
    "2": false
  },
  "items": { "poke": 30, "great": 15, "ultra": 8, "premier": 5 },
  "accountCreated": 1759000000
}
```

---

## The AR layer

The game uses the **8th Wall engine** with world tracking enabled:

```js
XR8.XrController.configure({
  disableWorldTracking: false,   // 6DoF SLAM
  enableLighting: true,
  scale: 'absolute',             // real-world metres
})
```

`scale: 'absolute'` matters — the 2–10 m spawn rules, the 1 m walk limit and the
22 cm balls are all real distances.

The MIT engine (`vendor/xr/xr.js`) does **not** contain world tracking; it is
supplied by the SLAM chunk from the binary distribution
(`vendor/xr-binary/xr-slam.js`), preloaded via the engine's `data-preload-chunks`
attribute. Nothing is loaded from a CDN, so the game works fully offline on the
LAN.

Camera pipeline modules live in `web/js/ar.js`: scene + lights + shadow ground,
lighting estimation, tracking status, the per-frame driver the game systems hook
into (`bt16-frame`), and an exception trap that keeps one bad frame from taking
the camera feed down with it. `pokemon.js`, `ball.js` and `hologram.js` read
SLAM surfaces through the `sampleSurfaces()` / `hitTestAtClientPoint()` helpers.

### Advanced surface tracking

With `tracking.advanced` (the default), `web/js/ar.js` drives **`web/js/tracking.js`**
instead of scanning the feed on every query. The tracker keeps a persistent model
of the world's horizontal surfaces:

* a fixed lattice of hit-test points is refreshed a few points per frame
  (`tracking.surface.refreshPerFrame`), so the per-frame cost is bounded no
  matter how many systems ask for a spot;
* each hit is bucketed into a 3D grid and grouped into connected planar patches,
  so one big surface yields distinct spots rather than a cloud of duplicates;
* the **lowest well-supported horizontal layer is the floor** and anything above
  it, up to `tracking.surface.maxElevatedAboveM`, is an elevated surface — which
  is how a Pokémon ends up standing on a **table or bench** rather than floating
  over it. Lawns and floors are just the ground case.
* queries (`sampleSurfaces()`) are answered from the model and cost **zero hit
tests**.

Turning it off (`"advanced": false`) falls back to the simple per-query grid
scan, which is exactly what bt16 did before.

The tracker is dependency-free, so it has a headless test that stubs the camera
and a floor-plus-table world:

```bash
node web/js/tools/tracking.test.mjs
```

It checks floor detection, tabletop detection and classification, the per-frame
sampling budget, distance filtering, de-duplication, the featureless-ground
fallback and rejection of vertical faces.

`XR8.run()` resolves happily even when the camera pipeline never actually starts
(a refused permission, a desktop browser, a failed SLAM chunk). bt16 watches for
that: if no render frame has been produced roughly 12 s after the game starts, it
says so on screen instead of leaving you staring at a frozen feed.

---

## Browser support

A phone is required: the camera and world tracking need a **secure context** and
a **back camera**. Desktop browsers can load the page and the UI, but SLAM and
spawning need a mobile device.

For looking at the interface on a computer, append **`?device=any`** to the URL —
that drops the engine's `MOBILE_AND_HEADSETS` requirement so it will try to run
with a webcam.

### Diagnosing a stuck camera

Append **`?debug=1`** (which also implies `?device=any`) to show a diagnostics
strip below the top HUD row:

| Reading | Meaning |
| --- | --- |
| `fps` | engine frames per second |
| `tracking` | SLAM status — `NORMAL` means world tracking has locked on |
| `surfaces` | advanced tracker model: `patches / raised / cells / floor / hits-per-frame` (`off` when `tracking.advanced` is false) |
| `frames` | render frames bt16 has driven. **If this stays at `0`, the engine never started its run loop** and the feed cannot be live. |
| `engine` | the last exception the engine reported, if any |

---

## Client cache-busting

The browser caches by full URL, which makes a stale module the classic
"my change isn't showing" (or worse, "the page never leaves the splash screen")
bug. bt16 handles it with a single number, `CLIENT_VERSION`:

* **every** local import under `web/js/` carries the same `?v=N`
  (`from './ui.js?v=N'`), and so do the `<link>`/`<script>` tags in
  `index.html`;
* the server also sends `Cache-Control: no-store` for `.html`, `.css`, `.js`,
  `.mjs` and `.json`;
* **bump `N` everywhere together** whenever anything under `web/` changes.

Versioning only *some* imports is a trap: an unversioned module (`hologram.js`,
`gamemaster.js`) keeps the same URL for ever, so if a browser or proxy ever
stored an HTML error page for it, every reload hands that page back — and a
module that is not JavaScript fails with a *MIME type* error that says nothing
about the real problem, leaving the page on the splash screen.

`selftest.py` enforces this: it fails if any import disagrees with `index.html`,
and if any file the browser needs is missing from `web/`.

---

## Cloudflare tunnels and the `text/html` MIME error

A `cloudflared` quick tunnel (`python server.py --tunnel cloudflared`) forwards
every browser connection to the origin (`server.py`). If the app is reached
through a tunnel and the console shows a module **“blocked due to a disallowed
MIME type (`text/html`)”** while `GET /api/health` reports `{"missing": []}` and
the files are definitely on disk, the files are **not** the problem — the module
requests are being dropped, and Cloudflare is answering the dropped ones with
its own **HTML 502 page**, which the browser then reports as an HTML module.

The burst is what triggers it: Firefox requests the whole module graph at once,
and two old defaults made the origin unable to absorb it.

* Python's `SimpleHTTPRequestHandler` speaks **HTTP/1.0** by default, which opens
a fresh TCP connection for every response — so ~15 modules meant ~15 connections
through the tunnel at the same moment.
* `socketserver`'s listen **backlog was 5**, so once five connections were queued
the rest were refused and dropped.

`server.py` now fixes both at the source:

* the handler is **HTTP/1.1**, so responses are keep-alive and the tunnel reuses
a single origin connection instead of one per file (`Bt16Handler.protocol_version`);
* the server class raises the accept backlog to **128**
(`Bt16Server.request_queue_size`), so a parallel module burst drains in full.

Because a dropped module fails the *whole* graph, the symptom is the page never
leaving the splash screen, not a single broken feature. If you see it on an old
checkout, update `server.py` and restart the tunnel; the fixes live there, not in
the client.

`selftest.py` guards both: it fires every module in `web/js/` at the server
concurrently and fails if any request is dropped or answered with the wrong
content type, and it asserts `protocol_version == "HTTP/1.1"` and a backlog of at
least 64.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The phone cannot reach the LAN address | If you are not an administrator the inbound firewall rule is missing. Use `--usb` (Android) or `--tunnel` instead — both need no admin. |
| `--usb` says "adb was not found" | Install Android Platform Tools and put `adb` on your `PATH`, then enable USB debugging and accept the prompt on the phone. |
| `--tunnel` cannot get a URL | Run `python server.py --tunnel-list`, then name one explicitly (e.g. `--tunnel pinggy` or `--tunnel ssh`), or check that outbound network access is allowed. cloudflared is cached in `server/tools/`. For anything else: `--tunnel custom --tunnel-cmd "<command>"`. |
| Stuck on "Loading the AR engine…" | The engine needs HTTPS (or `localhost`) and a mobile device. Check the console; make sure `web/vendor/xr-binary/xr-slam.js` is served. |
| **Stuck on the splash screen and the console says a module was `blocked due to a disallowed MIME type ("text/html")`** | The browser is not being handed JavaScript. Either a file is missing from `web/` — the server prints the names at startup and `GET /api/health` lists them in `missing` — or a cache between the phone and the server is holding an old HTML error page. Restart the server, then reload the page (the `?v=` bump gives every module a new URL). See [Client cache-busting](#client-cache-busting). **Through a `cloudflared` tunnel** this happens when the parallel module burst overflows the origin accept queue and Cloudflare returns an HTML 502 — see [Cloudflare tunnels and the `text/html` MIME error](#cloudflare-tunnels-and-the-texthtml-mime-error). |
| Login fails | The server must be running on the same machine you opened the page from. Check `server/logs/log.json`. |
| No Pokémon ever spawn | Give it a few seconds — spawns are automatic. Indoors is the likeliest reason: a spawn needs a lit, textured, walkable surface with room around it, which a room barely has. Go outside to an open area (a lawn, a park, a football court) and they show up. Moving the camera slowly over the ground also helps SLAM map it. |
| Certificate warning | Expected — the certificate is self-signed. Accept it, or install it, to get a secure context. |
| Snapshot is black | Wait for the camera feed to paint before pressing the camera button. |
| **Camera frozen — the video never moves** | Add `?debug=1`. If `frames` stays `0` the engine never started its run loop: allow camera access, use `https://` (or `localhost`), make sure `web/vendor/xr-binary/xr-slam.js` is served, and run on a phone — a computer needs `?device=any`. bt16 also says this on screen about 12 s in. |
| The HUD appears over a blank/black feed | Same as above — the engine booted but its camera pipeline did not. |

---

## Credits and licensing

**Code** — this project is licensed under the **GNU General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

**Third-party code** vendored under `web/vendor/`:

| Component | Licence |
| --- | --- |
| 8th Wall `@8thwall/engine` (`vendor/xr/`) | MIT |
| 8th Wall `@8thwall/engine-binary` (`vendor/xr-binary/`) | **Limited-use, not open source.** No reverse engineering or derivative works; attribution required. |
| 8th Wall `@8thwall/xrextras` (`vendor/xrextras/`) | MIT |
| three.js (`vendor/three/`) | MIT |

**Art, models, sounds** — Pokémon and Pokémon GO assets under `assets/` belong to
The Pokémon Company / Nintendo / Game Freak / Niantic. They are NOT included in this repository.

**License**
The project is licensed under the **GPL-3.0** license. See `LICENSE` file for details.
