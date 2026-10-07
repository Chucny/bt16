/**
 * Entry point.
 *
 * Boot order
 *   1. splash (4 s)
 *   2. login (cookie pre-filled; auto sign-in when remembered)
 *   3. loading screen while the 8th Wall engine and its SLAM chunk come up
 *   4. XR8 configured for 6DoF, pipeline installed, XR8.run()
 *   5. HUD appears, the spawner starts, progress sync runs
 */
import * as THREE from 'three'

// CLIENT_VERSION — one cache-buster for the whole client.
//
// EVERY local module import in web/ carries the same `?v=N`, and so do the
// <link>/<script> tags in index.html. Bump N in all of them together whenever
// any file under web/ changes.
//
// Versioning only some imports (which is what this file used to do) leaves the
// rest of the graph addressable by an already-poisoned cache — a browser or a
// proxy that once stored an HTML error page for `/js/hologram.js` will keep
// handing it back as `text/html`, and the module fails with a baffling MIME
// error while the page sits on the splash screen for ever. selftest.py enforces
// that every import agrees with index.html, so this cannot rot again.
import {state, emit, on, playSound, ASSET_SOUNDS, preloadSound} from './core.js?v=16'
import {GM, loadGameMaster} from './gamemaster.js?v=16'
import {GEN1_NAMES, normaliseInventory} from './data.js?v=16'
import {api, installLogger, startSync, saveNow, flushLogs, rememberCredentials, recallCredentials} from './net.js?v=16'
import {
  createPipelineModules, optionalModules, onFrame, setHologram,
} from './ar.js?v=16'
import {Spawner, removePokemon} from './pokemon.js?v=16'
import {CatchController} from './ball.js?v=16'
import {Hologram} from './hologram.js?v=16'
import {PokestopManager} from './pokestop.js?v=16'
import * as ui from './ui.js?v=16'

// Every import above resolved, so the module graph loaded. index.html's boot
// watchdog watches this flag and only explains itself when it is still false.
window.__bt16ModuleLoaded = true

// The engine renders with its own copy of three; sharing ours keeps objects and
// engine internals on one set of classes. Must happen before `xrloaded`.
window.THREE = THREE

installLogger()

const canvas = document.getElementById('camerafeed')
state.canvas = canvas

const spawner = new Spawner()
const catcher = new CatchController()
const hologram = new Hologram()
const pokestops = new PokestopManager()
let engineReady = false
let gameStarted = false

// -----------------------------------------------------------------------------
// URL flags
//   ?debug=1      show the diagnostics HUD (fps / tracking / frames / errors)
//   ?device=any   let the engine run on a desktop browser too, which is the
//                 only way to exercise the run loop without a phone. Implied
//                 by ?debug=1.
// -----------------------------------------------------------------------------
const params = new URLSearchParams(location.search)
const DEBUG = params.has('debug')
const ANY_DEVICE = DEBUG || params.get('device') === 'any'

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------
function configureEngine() {
  window.XR8.XrController.configure({
    // SLAM ON -> world tracking / 6DoF. Never set this to true in bt16.
    disableWorldTracking: false,
    enableLighting: true,
    // Feature points give the sampler something to land on where a surface has
    // not been detected yet (asphalt, tarmac), which is what keeps Pokémon and
    // PokéStops grounded on a street instead of nowhere.
    enableWorldPoints: true,
    // 'absolute' reports real-world metres, which is what the 2–10 m spawn
    // rules and the 22 cm Poké Balls depend on.
    scale: 'absolute',
  })
}

function onXrLoaded() {
  ui.setLoadingProgress(0.5, 'Starting the camera…')
  configureEngine()

  window.XR8.addCameraPipelineModules([
    ...createPipelineModules(),
    ...optionalModules(),
  ])

  // XR8.run() returns a promise: a rejected run is the difference between
  // "nothing happens" and a message the player can act on.
  Promise.resolve(
    window.XR8.run({
      canvas,
      allowedDevices: ANY_DEVICE
        ? window.XR8.XrConfig.device().ANY
        : window.XR8.XrConfig.device().MOBILE_AND_HEADSETS,
      cameraConfig: {direction: window.XR8.XrConfig.camera().BACK},
      glContextConfig: {
        alpha: false,
        antialias: true,
        // Needed for the snapshot feature (canvas -> PNG).
        preserveDrawingBuffer: true,
      },
    }),
  ).catch((err) => {
    console.error('[bt16] XR8.run failed:', err)
    fatal(err)
  })

  onFrame((dt, t) => gameFrame(dt, t))

  engineReady = true
  ui.setLoadingProgress(0.8, 'Reading the room…')
  // Give SLAM a moment to initialise, then start the game regardless.
  setTimeout(startGame, 1500)
}

/**
 * Called on the first tracking status event.
 *
 * This only drives the loading screen now. The old top-centre pill that printed
 * "NORMAL · unspecified" is gone — the outdoor tutorial says something useful
 * about tracking instead.
 */
window.addEventListener('bt16:tracking', (e) => {
  const detail = e.detail || {}
  if (detail.status === 'NORMAL') ui.setLoadingProgress(0.95, 'Tracking locked')
})

// -----------------------------------------------------------------------------
// Game lifecycle
// -----------------------------------------------------------------------------
function startGame() {
  if (gameStarted) return
  gameStarted = true
  ui.hideLoading()
  ui.showApp()
  catcher.attach(canvas)
  pokestops.attach(canvas)
  spawner.start()
  pokestops.start()
  startSync(10000)
  ui.hint('Best outside, in an open area — Pokémon appear near you every few seconds!', 5200)
  console.log('[bt16] game started')

  // The outdoor tutorial: one big popup, one second into the session. It is the
  // player's first piece of real advice now that the tracking pill is gone.
  setTimeout(() => ui.showTutorial(), GM.ui.tutorialDelayMs)

  // Fullscreen is requested on the first tap *after* the camera is live.
  // Asking for it while the engine is still bringing the camera up resizes the
  // viewport mid-boot, which can leave the feed showing a single stale frame.
  for (const evt of ['pointerdown', 'touchstart']) {
    window.addEventListener(evt, onArGesture, {passive: true})
  }

  if (DEBUG) {
    document.getElementById('hud-debug')?.removeAttribute('hidden')
    setInterval(updateDebugHud, 500)
    updateDebugHud()
  }

  // Watchdog.
  //
  // XR8.run() resolves happily even when the camera pipeline never starts — a
  // refused permission, a desktop browser, or a failed SLAM chunk all leave the
  // page completely inert and *silent*. The player then just sees a frozen feed.
  // If our frame module has not ticked by now, say so out loud.
  setTimeout(() => {
    if ((state.frames ?? 0) > 0) return
    console.error('[bt16] the camera pipeline never produced a frame')
    ui.toast(
      state.lastEngineError
        ? `Camera stalled: ${state.lastEngineError}`
        : 'Camera never started. Allow camera access, use https://, and run on a phone or tablet. ' +
          'On a computer, add ?device=any.',
      10000,
    )
  }, 12000)
}

/** Diagnostics HUD, enabled with ?debug=1. */
function updateDebugHud() {
  const set = (id, value) => {
    const el = document.getElementById(id)
    if (el && el.textContent !== String(value)) el.textContent = String(value)
  }
  set('debug-fps', state.fps ?? '–')
  set('debug-track', state.trackingStatus ?? '–')
  set('debug-frames', state.frames ?? 0)
  const s = state.surfaceStats
  set(
    'debug-surfaces',
    s
      ? `${s.patches} patch / ${s.elevated} raised / ${s.cells} cells / floor ${s.floorY ?? '–'} / ${s.hitTests} hits`
      : 'off',
  )
  set('debug-err', state.lastEngineError ?? state.lastGameError ?? 'none')
}

/**
 * The world, or nothing.
 *
 * When SLAM loses tracking, every Pokémon standing in the scene is standing on
 * a stale guess: the engine no longer knows where the floor or the phone is, so
 * keeping them means keeping creatures that hang in mid-air and drift when
 * tracking returns. If the world stays lost for `GM.tracking.lostAfterS`, they
 * go. The timer resets the moment tracking is back, so a blink costs nothing.
 */
let trackingLostFor = 0
let clearedForTracking = false

function trackWorldLoss(dt) {
  const status = state.trackingStatus
  const lost = !!status && GM.tracking.lostStatuses.includes(status)
  if (!lost) {
    trackingLostFor = 0
    clearedForTracking = false
    return
  }
  trackingLostFor += dt
  if (trackingLostFor < GM.tracking.lostAfterS || clearedForTracking) return
  clearedForTracking = true
  // The stop's ground position is as stale as the Pokémon's — take it with them.
  pokestops.clear()
  if (!state.pokemon.length) return
  console.log(
    `[bt16] tracking lost for ${trackingLostFor.toFixed(1)} s — removing ${state.pokemon.length} Pokémon`,
  )
  for (const p of state.pokemon.slice()) p.dispose()
}

/** Per-frame update for every game system. */
function gameFrame(dt, t) {
  if (!engineReady) return

  // World tracking: a lost world means the placed Pokémon are no longer real.
  trackWorldLoss(dt)

  // Pokémon
  for (let i = state.pokemon.length - 1; i >= 0; i--) {
    const p = state.pokemon[i]
    p.update(dt, t)
    if (p.state === 'gone') state.pokemon.splice(i, 1)
  }

  // PokéStops (spin physics, bubbles, cooldown, look-away despawn)
  pokestops.update(dt, t)

  // In-flight ball
  catcher.update(dt)

  // Inspection hologram
  hologram.update(dt)
}

// -----------------------------------------------------------------------------
// HUD actions
// -----------------------------------------------------------------------------
ui.initUi({
  openInventory: () => ui.openInventory(),
  openPokedex: () => ui.openPokedex(),
  openItemMenu: () => ui.openItemMenu(),
  snapshot: () => takeSnapshot(),
  inspect: (id) => inspectPokemon(id),
  closeInspection: () => closeInspection(),
  renameInspection: (nickname) => renameInspected(nickname),
  requestTransfer: () => requestTransfer(),
  confirmTransfer: () => confirmTransfer(),
})

/** The storage id of the Pokémon currently open in inspection. */
let inspectedId = null

async function inspectPokemon(id) {
  const entry = state.inventory[id]
  if (!entry) return
  const dex = Number(entry.dex ?? entry.pokedex_entry ?? id)
  inspectedId = id
  ui.closeAllOverlays()
  ui.openInspectionUi(dex, entry)
  try {
    await hologram.show(dex)
  } catch (err) {
    console.error('[bt16] inspection failed:', err)
    ui.showFatal(err)
  }
}

function closeInspection() {
  ui.closeInspectionUi()
  hologram.hide()
  inspectedId = null
}

function renameInspected(nickname) {
  const entry = inspectedId ? state.inventory[inspectedId] : null
  if (!entry) return
  const dex = Number(entry.dex ?? entry.pokedex_entry ?? inspectedId)
  entry.nickname = nickname || GEN1_NAMES[dex - 1]
  ui.renderInventory()
  emit('progress')
  flushLogs()
  ui.toast('Renamed!')
}

/** Ask before releasing: the hologram stays up, a confirm card appears over it. */
function requestTransfer() {
  const entry = inspectedId ? state.inventory[inspectedId] : null
  if (!entry) return
  const dex = Number(entry.dex ?? entry.pokedex_entry ?? inspectedId)
  ui.openTransferConfirm(entry.nickname || GEN1_NAMES[dex - 1])
}

/**
 * Release the inspected Pokémon.
 *
 * Transfer frees the storage slot for good — that is the whole point — but it
 * never touches the Pokédex: a species stays registered once seen and caught.
 * Afterwards the player lands back on the (now refreshed) storage screen.
 */
function confirmTransfer() {
  const id = inspectedId
  const entry = id ? state.inventory[id] : null
  if (!entry) return
  const dex = Number(entry.dex ?? entry.pokedex_entry ?? id)
  const name = entry.nickname || GEN1_NAMES[dex - 1]
  delete state.inventory[id]
  console.log(`[bt16] transferred ${name} (#${dex})`)
  emit('progress')
  flushLogs()
  saveNow()
  closeInspection()
  ui.openInventory()
  ui.toast('Transferred to the Professor')
}

/** Coded but intentionally not wired to any control (spec: no trash bin yet). */
// eslint-disable-next-line no-unused-vars
function discardSelectedItem() {
  const id = state.selectedItem
  if ((state.items[id] ?? 0) <= 0) return
  state.items[id] -= 1
  ui.updateItemSwitch()
  ui.renderItemMenu()
  emit('progress')
}

function takeSnapshot() {
  try {
    // Prefer the renderer's canvas, but fall back to the camera canvas so the
    // button still does something sensible if the engine has not finished
    // starting. preserveDrawingBuffer is on, so toDataURL() is not blank.
    const target = state.renderer?.domElement ?? state.canvas
    const dataUrl = target?.toDataURL?.('image/png')
    if (!dataUrl || dataUrl === 'data:,') throw new Error('nothing to capture yet')
    ui.showSnapshot(dataUrl)
    console.log('[bt16] snapshot taken')
  } catch (err) {
    console.error('[bt16] snapshot failed:', err)
    ui.toast('Snapshot failed')
  }
}

// -----------------------------------------------------------------------------
// Canvas taps: the inspection hologram, and general "attack me" pokes
// -----------------------------------------------------------------------------
canvas.addEventListener('pointerdown', (e) => {
  if (!state.inspecting) return
  if (hologram.hitTestScreen(e.clientX, e.clientY)) hologram.attack()
})

// -----------------------------------------------------------------------------
// Toast / hint events from game systems
// -----------------------------------------------------------------------------
on('toast', ({text}) => ui.toast(text))
on('catch:success', ({pokemon}) => {
  ui.toast(`${pokemon?.name ?? 'Pokémon'} was caught!`)
  ui.hint('Keep an eye out — more Pokémon are on the way', 3200)
  setTimeout(saveNow, 400)
})
on('catch:escape', ({pokemon, shakes}) => {
  if (pokemon) ui.toast(`${pokemon.name} broke free!`)
  console.log(`[bt16] escape after ${shakes} shake(s)`)
})
on('pokemon:spawn', () => ui.hint('A wild Pokémon appeared!', 2000))
on('pokestop:reward', ({name, amount}) => {
  ui.toast(`+${amount} ${name}${amount === 1 ? '' : 's'}`)
  setTimeout(saveNow, 400)
})
let pokestopHinted = false
on('pokestop:spawn', () => {
  if (pokestopHinted) return
  pokestopHinted = true
  ui.hint('A PokéStop appeared — tap it to spin!', 2600)
})
let bubbleHinted = false
on('pokestop:spin', () => {
  if (bubbleHinted) return
  bubbleHinted = true
  ui.hint('Tap the bubbles to collect your items!', 2600)
})

// The only "where do I find Pokémon?" prompt bt16 gives: when the world has been
// empty for a while, say the thing that actually helps. Indoors, SLAM has little
// open, well-lit floor to place anything on, so the answer is outside.
// A self-rescheduling timeout rather than setInterval, so both timings are read
// live from the game master (same rule as everything else).
let lastOutdoorHintAt = 0
function scheduleOutdoorHint() {
  setTimeout(() => {
    const idle = gameStarted && !state.dialogOpen && !state.inspecting
    if (idle && state.pokemon.length === 0) {
      const now = Date.now()
      if (now - lastOutdoorHintAt >= GM.ui.outdoorHintCooldownMs) {
        lastOutdoorHintAt = now
        ui.hint('No luck here — try an open area outside, away from walls.', 5200)
      }
    }
    scheduleOutdoorHint()
  }, GM.ui.outdoorHintEveryMs)
}
scheduleOutdoorHint()
on('items:changed', () => ui.updateItemSwitch())
// Drop stale entities from the array when one despawns by itself.
on('pokemon:despawn', ({pokemon}) => removePokemon(pokemon))

// -----------------------------------------------------------------------------
// First-gesture chores: audio unlock, then (once the AR view is up) fullscreen
// -----------------------------------------------------------------------------
let audioUnlocked = false
function onFirstGesture() {
  if (audioUnlocked) return
  audioUnlocked = true
  // Preload the common sounds now that playback is unlocked.
  for (const src of Object.values(ASSET_SOUNDS)) preloadSound(src)
}
for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
  window.addEventListener(evt, onFirstGesture, {passive: true})
}

let fullscreenAsked = false
/** The browser always tries to go fullscreen (spec) — see startGame(). */
function onArGesture() {
  if (fullscreenAsked) return
  fullscreenAsked = true
  const el = document.documentElement
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen
  if (req && !document.fullscreenElement) {
    req.call(el).catch(() => { /* a user gesture may still be refused */ })
  }
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------
async function loginFlow() {
  const remembered = recallCredentials()
  const credentials = await ui.showLogin(remembered)

  ui.setLoginBusy(true)
  try {
    const result = credentials.register
      ? await api.register(credentials.username, credentials.password)
      : await api.login(credentials.username, credentials.password)

    state.user = {username: credentials.username, player: result?.player ?? result}
    state.server.online = true

    // Load whatever progress the server has.
    const player = state.user.player ?? {}
    state.inventory = normaliseInventory(player.pokemon ?? player.inventory ?? {})
    state.pokedex = player.pokedex ?? {}
    state.items = {...state.items, ...(player.items ?? {})}

    if (credentials.remember) rememberCredentials(credentials.username, credentials.password)
    ui.hideLogin()
    console.log(`[bt16] signed in as ${credentials.username}`)
    return true
  } catch (err) {
    console.warn('[bt16] login failed:', err.message)
    ui.setLoginError(
      `${err.message}. Is the Python server running? (see server/README.md)`,
    )
    return false
  } finally {
    ui.setLoginBusy(false)
  }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
async function boot() {
  // 0. Game master (web/config/game-master.json) — the JSON that tunes spawning,
  //    catching, ball physics and the tutorial. Started first so the 4 s splash
  //    hides the fetch; it never rejects, so a missing file just means defaults.
  const gameMaster = loadGameMaster()

  ui.setLoadingProgress(0.02, 'Starting…')

  // 1. Splash (4 s, bt16 + Chucny Studios).
  await ui.showSplash(4)

  await gameMaster
  state.items = {...GM.items.starting}
  state.selectedItem = GM.items.default

  // 2. Login (retry until the server accepts).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await loginFlow()
    if (ok) break
  }

  // 3. Loading screen while the engine boots.
  ui.showLoading('Loading the AR engine…')
  playSound(ASSET_SOUNDS.title, {volume: 0.7})

  if (window.XR8) {
    onXrLoaded()
  } else {
    window.addEventListener('xrloaded', onXrLoaded, {once: true})
    window.addEventListener('error', bootErrorHandler)
    window.addEventListener('unhandledrejection', bootErrorHandler)
    ui.setLoadingProgress(0.25, 'Loading the AR engine…')
    // If the engine never arrives, say so rather than hanging on the splash.
    setTimeout(() => {
      if (!engineReady) fatal(new Error('The AR engine did not load in time.'))
    }, 20000)
  }
}

/**
 * Window-level error hook used while the engine is still booting.
 *
 * Once the game is running this only records the error: a single failing asset
 * or frame must not replace a live AR session with the fatal card.
 */
function bootErrorHandler(event) {
  const err = event?.reason ?? event?.error ?? event?.message ?? event
  if (gameStarted) {
    state.lastGameError = String(err?.message || err)
    console.error('[bt16] non-fatal error:', err)
    return
  }
  fatal(err)
}

function fatal(err) {
  console.error('[bt16] fatal:', err)
  setHologram(false)
  pokestops.stop()
  ui.showFatal(err)
}

// Save on the way out.
window.addEventListener('pagehide', () => { saveNow(); flushLogs() })
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveNow(); flushLogs() }
})

boot().catch(fatal)
