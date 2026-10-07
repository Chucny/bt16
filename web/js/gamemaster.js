/**
 * Game master.
 *
 * Every gameplay tunable lives in `web/config/game-master.json`; this module
 * fetches it once at boot and merges it into the mutable `GM` object below.
 * Game code reads `GM.<section>.<key>` at call time (never as a module-level
 * constant), so a value changed in the JSON takes effect without touching code.
 *
 * The defaults baked in here are deliberately identical to the JSON: they are
 * the fallback if the file is missing or malformed, so a bad edit can never
 * leave the game with `NaN` physics. The JSON always wins when it loads.
 */

/** Path is served from `web/` by server.py (see translate_path). */
const GM_URL = '/config/game-master.json'
const LOAD_TIMEOUT_MS = 4000

export const GM = {
  version: 0,
  spawn: {
    intervalMs: 10000,
    intervalJitterMs: 4000,
    minIntervalMs: 2000,
    retryMs: 2500,
    maxAlive: 4,
    minDistanceM: 2,
    maxDistanceM: 10,
    minSeparationM: 2,
    surfaceMinY: 0.55,
    surfaceStepM: 0.1,
    surfaceCacheMs: 200,
    maxSamples: 30,
    preferFrontDeg: 75,
  },
  species: {
    dexMin: 1,
    dexMax: 151,
    legendaryChance: 0.08,
    legendaryDex: [144, 145, 146, 150, 151],
  },
  catch: {
    chance: {poke: 0.5, great: 0.65, ultra: 0.8, premier: 0.55},
    fallbackChance: 0.5,
    legendaryMultiplier: 0.4,
    shakesOnCatch: 3,
    escapeShakeChance: 0.5,
    shakeSeconds: 2,
    shakeTiltRad: 0.62,
    escapeCooldownS: 1.4,
  },
  throw: {
    originDropM: 0.25,
    powerBase: 3.2,
    powerPerLength: 7,
    powerVelocityWeight: 4,
    lateralPower: 3.2,
    liftBase: 1.4,
    liftPerLength: 3,
    minSwipePx: 40,
    swipeSpeedMinS: 0.05,
    swipeSpeedMaxS: 1,
    velocityRefS: 0.35,
    velocityFloor: 0.15,
    spinMax: 12,
  },
  ball: {
    gravity: 9.81,
    diameterM: 0.22,
    groundBounceM: 0.15,
    hitBounceM: 1,
    missBounceCount: 3,
    missBounceBaseM: 0.22,
    missBounceDecay: 0.42,
    missBounceFriction: 0.62,
    rollSeconds: 1.6,
    rollFriction: 2.6,
    rollStopMps: 0.25,
    missFadeSeconds: 0.5,
    collisionMinRadiusM: 0.25,
    collisionHeightFactor: 0.4,
  },
  tracking: {
    // Lose the world for this long and the placed Pokémon are thrown away —
    // their SLAM positions are stale, so keeping them means keeping drift.
    lostAfterS: 3,
    lostStatuses: ['LIMITED', 'NOT_AVAILABLE'],
    // Advanced surface tracking (web/js/tracking.js): a persistent model of
    // floors, lawns and raised surfaces (tables, benches) that is refreshed a
    // few hit tests per frame and answers spawn queries instantly. On by
    // default; set false to fall back to the simple per-query grid scan.
    advanced: true,
    surface: {
      sampleStep: 0.06,
      refreshPerFrame: 16,
      warmupMultiplier: 3,
      gridM: 0.25,
      staleAfterS: 6,
      minNormalY: 0.7,
      minFloorCells: 3,
      minPatchCells: 2,
      floorSmooth: 0.2,
      elevatedMinAboveM: 0.25,
      maxElevatedAboveM: 1.5,
      candidateStepM: 0.5,
      dedupeM: 0.25,
      maxCandidatesPerPatch: 24,
    },
  },
  celebration: {
    starSeconds: 1.5,
    fadeSeconds: 0.5,
    starCount: 10,
  },
  pokemon: {
    walkTargetMinM: 1,
    walkTargetExtraM: 4,
    walkSurfaceMinY: 0.45,
    walkSurfaceStepM: 0.14,
    walkMaxStepM: 0.3,
    walkArriveM: 0.12,
    wanderMinS: 5,
    wanderMaxS: 6,
    walkSpeedMps: 0.9,
    turnSpeedRadS: 2.2439,
    fadeInS: 0.9,
    captureFadeS: 0.6,
    attackHoldS: 0.9,
    despawnAfterS: 1.5,
    fleeSpeedMps: 2.2,
    fleeSeconds: 3,
    smokeSeconds: 2,
    smokeCount: 26,
    smokeSizeM: 0.55,
  },
  pokestops: {
    // On/off, plus the whole spin-physics and bubble setup. All live tunables.
    enabled: true,
    maxAlive: 1,
    minDistanceM: 2.5,
    maxDistanceM: 9,
    heightM: 1.9,
    surfaceMinY: 0.4,
    surfaceStepM: 0.1,
    floorBandM: 0.35,
    cooldownS: 60,
    despawnAfterS: 1.5,
    respawnDelayS: 4,
    fadeInS: 0.6,
    spin: {
      // Exponential angular decay: total rotations ≈ initialSpeed / (friction · 2π).
      initialSpeedRadS: 40,
      friction: 1.4,
      minSpeedRadS: 0.6,
    },
    bubbles: {
      min: 1,
      max: 4,
      radiusM: 0.17,
      lifetimeS: 9,
      riseHeightM: 0.8,
      spreadM: 0.34,
      awardMin: 1,
      awardMax: 4,
      ballWeights: {poke: 6, great: 3, ultra: 2, premier: 1},
    },
  },
  items: {
    unlimited: false,
    default: 'poke',
    starting: {poke: 30, great: 15, ultra: 8, premier: 5},
  },
  ui: {
    tutorialDelayMs: 1000,
    tutorialText:
      'Back to 16 works better outside. Try going to a lawn, forest, a big open area. Pokemon may not spawn inside.',
    tutorialArt: '/assets/pokemon-go/important-icons/tutorials/findAPlane.png',
    hintMs: 3200,
    toastMs: 2200,
    outdoorHintEveryMs: 20000,
    outdoorHintCooldownMs: 60000,
  },
}

/** Recursively fold `source` into `target`; arrays replace wholesale. */
function merge(target, source) {
  if (!source || typeof source !== 'object') return target
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('_')) continue // `_comment` and friends are prose
    if (Array.isArray(value)) {
      target[key] = value.slice()
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      merge(target[key], value)
    } else if (value !== undefined) {
      target[key] = value
    }
  }
  return target
}

let loadPromise = null

/**
 * Fetch the game master and merge it over the defaults above.
 *
 * Never rejects: a missing file, an offline LAN or a malformed JSON simply
 * leaves the baked-in defaults in place, and the game boots anyway.
 * @returns {Promise<typeof GM>}
 */
export function loadGameMaster() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const res = await Promise.race([
        fetch(GM_URL, {cache: 'no-store'}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), LOAD_TIMEOUT_MS),
        ),
      ])
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      merge(GM, await res.json())
      console.log(`[bt16] game master v${GM.version} loaded from ${GM_URL}`)
    } catch (err) {
      console.warn(`[bt16] game master not loaded (${err.message}) — using defaults`)
    }
    return GM
  })()
  return loadPromise
}
