/**
 * Core: shared state, a tiny event bus, audio, and small helpers.
 *
 * Everything in the app imports from here so there is exactly one copy of the
 * mutable game state, one place to fire events, and one audio element.
 */

// -----------------------------------------------------------------------------
// Event bus
// -----------------------------------------------------------------------------
const listeners = new Map()

/** Subscribe to a named event. Returns an unsubscribe function. */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(fn)
  return () => listeners.get(event)?.delete(fn)
}

/** Fire a named event. Listener errors never break the caller. */
export function emit(event, detail) {
  const set = listeners.get(event)
  if (!set) return
  for (const fn of set) {
    try {
      fn(detail)
    } catch (err) {
      console.error(`[core] listener for "${event}" threw:`, err)
    }
  }
}

// -----------------------------------------------------------------------------
// Game state
// -----------------------------------------------------------------------------
export const state = {
  // --- engine plumbing -------------------------------------------------
  canvas: null,
  scene: null,
  camera: null,
  renderer: null,

  // --- SLAM ------------------------------------------------------------
  trackingStatus: null,
  trackingReason: null,
  lighting: null,
  /** 6DoF camera pose from the engine, updated each frame. */
  cameraPosition: null,

  // --- diagnostics (shown by the ?debug=1 HUD block) -------------------
  /** Render frames driven by our own frame pipeline module. */
  frames: 0,
  fps: 0,
  lastEngineError: null,
  lastGameError: null,
  /** Advanced surface-tracker diagnostics (see ar.js / tracking.js). */
  surfaceStats: null,

  // --- account ---------------------------------------------------------
  user: null, // {username, player}
  server: {online: false, url: location.origin},

  // --- world -----------------------------------------------------------
  /** @type {import('./pokemon.js').Pokemon[]} */
  pokemon: [],
  lastSpawnAt: 0,
  /** @type {null | {ball: object, phase: string}} */
  activeThrow: null,

  // --- inventory (mirrors the server) ----------------------------------
  inventory: {},   // { [dex]: {nickname, caughtDate, cp, pokedex_entry} }
  pokedex: {},     // { [dex]: boolean }
  items: {poke: 30, great: 15, ultra: 8, premier: 5},
  selectedItem: 'poke',

  // --- ui --------------------------------------------------------------
  hudVisible: false,
  dialogOpen: false,
  inspecting: null,
  busy: false,
}

// -----------------------------------------------------------------------------
// Audio
// -----------------------------------------------------------------------------
let audioEl = null
let currentAudio = null
const soundCache = new Map()

function getAudio() {
  if (!audioEl) audioEl = document.getElementById('sfx')
  return audioEl
}

/**
 * Play a sound effect. Re-uses a single <audio> element via WebAudio-free
 * HTMLAudio playback so overlapping UI sounds stay inexpensive.
 *
 * @param {string} src   absolute path (usually /assets/...)
 * @param {object} [opts]
 * @param {number} [opts.volume]
 * @param {boolean} [opts.loop]
 * @param {boolean} [opts.interrupt] stop the current one first
 * @returns {HTMLAudioElement|null}
 */
export function playSound(src, {volume = 1, loop = false, interrupt = false} = {}) {
  if (!src) return null
  try {
    if (interrupt && currentAudio) {
      currentAudio.pause()
      currentAudio.currentTime = 0
    }
    const a = new Audio(src)
    a.volume = volume
    a.loop = loop
    a.play().catch(() => { /* autoplay guard — user gesture will unlock it */ })
    a.addEventListener('ended', () => {
      if (currentAudio === a) currentAudio = null
    })
    currentAudio = a
    return a
  } catch (err) {
    console.warn('[audio] failed to play', src, err)
    return null
  }
}

/** Looping background sound (returns the element so the caller can stop it). */
export function playLoop(src, volume = 0.6) {
  return playSound(src, {volume, loop: true})
}

export function stopSound(a) {
  if (!a) return
  try { a.pause(); a.currentTime = 0 } catch { /* ignore */ }
  if (currentAudio === a) currentAudio = null
}

/** Preload a sound so the first play has no latency. */
export function preloadSound(src) {
  if (!src || soundCache.has(src)) return
  const a = new Audio()
  a.preload = 'auto'
  a.src = src
  soundCache.set(src, a)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
export const ASSET_SOUNDS = {
  uiBack: '/assets/pokemon-go/sounds/menu-sounds/ui_back.mp3',
  clickOk: '/assets/pokemon-go/sounds/menu-sounds/click_ok.mp3',
  clickCancel: '/assets/pokemon-go/sounds/menu-sounds/click_cancel.mp3',
  decideError: '/assets/pokemon-go/sounds/menu-sounds/SEQ_SE_DECIDE4_error.mp3',
  ballThrow: '/assets/pokemon-go/sounds/encounter/se_go_ball_throw.mp3',
  ballTarget: '/assets/pokemon-go/sounds/encounter/se_go_ball_target.mp3',
  ballTakeIn: '/assets/pokemon-go/sounds/encounter/se_go_ball_take_in.mp3',
  ballGround: '/assets/pokemon-go/sounds/encounter/se_go_ball_ground.mp3',
  ballBounce: '/assets/pokemon-go/sounds/encounter/se_go_ball_bowa1.mp3',
  ballOut: '/assets/pokemon-go/sounds/encounter/se_go_ball_out.mp3',
  ballGrab: '/assets/pokemon-go/sounds/encounter/se_go_ball_grab.mp3',
  gotcha: '/assets/pokemon-go/sounds/encounter/101_gotcha.mp3',
  flee: '/assets/pokemon-go/sounds/encounter/encounter_flee.mp3',
  appear: '/assets/pokemon-go/sounds/encounter/se_go_pokemon_appear.mp3',
  pokemonRun: '/assets/pokemon-go/sounds/encounter/se_go_pokemon_run.mp3',
  title: '/assets/pokemon-go/TITLE_SCREEN.mp3',
  close: '/assets/pokemon-go/sounds/menu-sounds/SEQ_SE_SYS_002_close.mp3',
  open: '/assets/pokemon-go/sounds/menu-sounds/SEQ_SE_OPEN2.mp3',
  select: '/assets/pokemon-go/sounds/menu-sounds/ui_select_02.mp3',
  pokestop: '/assets/pokemon-go/sounds/menu-sounds/se_go_quests_pokestop.mp3',
  bubble: '/assets/pokemon-go/sounds/menu-sounds/se_go_quests_get_rewards.mp3',
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

/** Deterministic-ish random helpers. */
export function randRange(min, max) {
  return min + Math.random() * (max - min)
}

export function randInt(min, max) {
  return Math.floor(randRange(min, max + 1))
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function pad3(n) {
  return String(n).padStart(3, '0')
}

/** Seconds since the engine started, in seconds (float). */
export function nowSec() {
  return performance.now() / 1000
}

/**
 * Set a mesh's materials to a given opacity (transparent fade).
 * Walks children, handles material arrays, and remembers the original opacity.
 */
export function setOpacity(object, opacity) {
  object.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return
    const mats = Array.isArray(node.material) ? node.material : [node.material]
    for (const m of mats) {
      if (!m) continue
      if (m.userData.baseOpacity === undefined) {
        m.userData.baseOpacity = m.opacity ?? 1
        m.userData.baseTransparent = m.transparent
      }
      const base = m.userData.baseOpacity
      if (opacity >= 0.999) {
        m.transparent = m.userData.baseTransparent
        m.opacity = base
        m.depthWrite = true
      } else {
        m.transparent = true
        m.opacity = base * opacity
        m.depthWrite = false
      }
      m.needsUpdate = true
    }
  })
}
