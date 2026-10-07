/**
 * The AR layer.
 *
 * Camera pipeline modules ("functions") for 8th Wall, plus the SLAM helpers the
 * game logic uses: hit-testing, surface sampling, the camera pose, and the
 * hologram light.
 *
 * Boot order is handled by main.js: window.THREE is assigned, XR8 is configured
 * (`disableWorldTracking: false` = 6DoF), then these modules are installed and
 * XR8.run() is called.
 */
import * as THREE from 'three'

import {state, clamp} from './core.js?v=16'
import {GM} from './gamemaster.js?v=16'
import {SurfaceTracker} from './tracking.js?v=16'

/** Eye height of the scene camera, in metres (the SLAM world is metric). */
export const CAMERA_HEIGHT = 1.6

// The advanced surface model (see tracking.js). ar.js owns the engine side:
// it feeds the tracker hit tests every frame and adapts its answers back into
// three.js vectors, so nothing else in the game has to know how it works.
const surfaceTracker = new SurfaceTracker()
let surfaceConfigKey = ''
let lastTrackAt = 0

// -----------------------------------------------------------------------------
// Per-frame hook registry
// -----------------------------------------------------------------------------
const frameHooks = new Set()
let lastFrameTime = 0

/** Register a callback that runs every render frame: fn(dtSeconds, timeSeconds). */
export function onFrame(fn) {
  frameHooks.add(fn)
  return () => frameHooks.delete(fn)
}

function runFrameHooks() {
  const t = performance.now() / 1000
  const dt = lastFrameTime ? Math.min(0.1, t - lastFrameTime) : 0
  lastFrameTime = t
  state.frames = (state.frames ?? 0) + 1
  // Every hook is isolated: one misbehaving system must never be able to stop
  // the run loop, because a stopped loop freezes the whole camera feed.
  for (const fn of frameHooks) {
    try {
      fn(dt, t)
    } catch (err) {
      console.error('[ar] frame hook threw:', err)
      state.lastGameError = String(err?.message || err)
    }
  }
}

// -----------------------------------------------------------------------------
// Hit testing
// -----------------------------------------------------------------------------
const SURFACE_PREFERENCE = ['DETECTED_SURFACE', 'ESTIMATED_SURFACE', 'UNSPECIFIED', 'FEATURE_POINT']

/**
 * Run a SLAM hit test at normalised (0..1) camera-feed coordinates.
 * @returns {Array<{type:string, position:{x,y,z}, rotation?:object}>}
 */
export function hitTestNormalized(nx, ny) {
  try {
    const results = XR8.XrController.hitTest(nx, ny)
    return Array.isArray(results) ? results : []
  } catch {
    // Thrown when the SLAM chunk is missing or tracking has not started.
    return []
  }
}

/** Best hit-test estimate near a client (touch) point, or null. */
export function hitTestAtClientPoint(clientX, clientY) {
  const canvas = state.canvas
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const nx = (clientX - rect.left) / rect.width
  const ny = (clientY - rect.top) / rect.height
  const results = hitTestNormalized(nx, ny)
  if (!results.length) return null
  for (const type of SURFACE_PREFERENCE) {
    const match = results.find((r) => r.type === type)
    if (match) return match
  }
  return results[0]
}

/** World-space normal of a hit-test estimate. */
export function hitNormal(hit) {
  if (!hit?.rotation) return null
  const q = new THREE.Quaternion(hit.rotation.x, hit.rotation.y, hit.rotation.z, hit.rotation.w)
  return new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize()
}

const _cameraPos = new THREE.Vector3()

/** Camera position as a THREE.Vector3 (or null before the scene exists). */
export function cameraPosition() {
  const cam = state.camera
  if (!cam) return null
  cam.getWorldPosition(_cameraPos)
  return _cameraPos.clone()
}

/** Horizontal distance from the camera to a world point. */
export function distanceFromPlayer(point) {
  const cam = state.camera
  if (!cam || !point) return Infinity
  cam.getWorldPosition(_cameraPos)
  return Math.hypot(point.x - _cameraPos.x, point.z - _cameraPos.z)
}

/** Distance from the camera to a world point (3D). */
export function distance3D(point) {
  const cam = state.camera
  if (!cam || !point) return Infinity
  cam.getWorldPosition(_cameraPos)
  return Math.hypot(point.x - _cameraPos.x, point.y - _cameraPos.y, point.z - _cameraPos.z)
}

const _forward = new THREE.Vector3()
const _camQuat = new THREE.Quaternion()

/** Unit vector the camera is looking along. */
export function cameraForward() {
  const cam = state.camera
  if (!cam) return new THREE.Vector3(0, 0, -1)
  cam.getWorldQuaternion(_camQuat)
  return _forward.set(0, 0, -1).applyQuaternion(_camQuat).normalize().clone()
}

// -----------------------------------------------------------------------------
// Ground level
// -----------------------------------------------------------------------------
// SLAM hands us floor estimates only where it has mapped a surface. Asphalt,
// tarmac and plain concrete are featureless, so on a street the hit tests often
// come back empty and the world looks "floorless". We keep one smoothed floor
// height for the whole session and fall back to it whenever a specific hit
// test fails, which is what lets Pokémon stand on a street instead of nowhere.
//
// With `tracking.advanced` (the default), the floor comes from the surface
// model instead, which also understands tables and other raised ground; the
// simple EMA below remains as the fallback when advanced tracking is off.
let groundY = 0
let groundSamples = 0

/** Best estimate of the world-space floor height, in metres. */
export function groundLevelY() {
  if (GM.tracking?.advanced && surfaceTracker.hasFloor) return surfaceTracker.floorY
  return groundY
}

/** Feed a freshly observed floor height into the smoothed estimate. */
export function noteGroundY(y) {
  if (!Number.isFinite(y)) return
  if (groundSamples === 0) {
    groundY = y
  } else {
    // Slow EMA: floor readings are noisy and a jittery floor makes Pokémon bob.
    groundY += (y - groundY) * 0.18
  }
  groundSamples += 1
}

/**
 * Is a world point inside the camera frustum? Used for the 1.5 s despawn rule.
 */
export function isPointVisible(point, margin = 0.06) {
  const cam = state.camera
  if (!cam || !point) return false
  cam.updateMatrixWorld()
  const ndc = new THREE.Vector3(point.x, point.y, point.z).project(cam)
  return (
    ndc.z > -1 && ndc.z < 1 &&
    ndc.x > -1 - margin && ndc.x < 1 + margin &&
    ndc.y > -1 - margin && ndc.y < 1 + margin
  )
}

/**
 * Sample the SLAM surfaces across the camera feed and return the candidate
 * floor-like points. Each candidate is `{position, normal, distance}`.
 *
 * Performance notes (this used to be the slowest thing in a frame):
 *   - the scan stops as soon as `maxSamples` points are found;
 *   - near-duplicate points are collapsed, so one big detected surface does not
 *     fill the whole result with the same place;
 *   - the grid start is jittered, so repeated calls explore different spots
 *     rather than always re-testing the same pixels.
 *
 * @param {object} [opts]
 * @param {number} [opts.minDistance] metres from the camera
 * @param {number} [opts.maxDistance] metres from the camera
 * @param {number} [opts.minSurfaceY] minimum world-space floor normal height
 * @param {number} [opts.step] normalised grid step
 * @param {number} [opts.maxSamples] stop after this many candidates
 */
export function sampleSurfaces(opts = {}) {
  const {
    minDistance = 0,
    maxDistance = Infinity,
    minSurfaceY = 0.5,
    step = 0.1,
    maxSamples = 30,
    allowElevated = true,
  } = opts

  // Advanced path: answer from the persistent surface model, which costs no hit
  // tests at all — the model is kept fresh a few points per frame by
  // updateSurfaceTracking(). It also returns floor *and* elevated surfaces
  // (tables, benches), with the floor already known.
  if (GM.tracking?.advanced && surfaceTracker.ready) {
    const cam = cameraPosition()
    if (!cam) return []
    return surfaceTracker.query({
      camera: cam,
      minDistance,
      maxDistance,
      minSurfaceY,
      step,
      maxSamples,
      allowElevated,
    }).map((c) => ({
      position: new THREE.Vector3(c.x, c.y, c.z),
      normal: new THREE.Vector3(c.nx, c.ny, c.nz),
      distance: c.distance,
      type: c.type,
      elevated: c.elevated,
    }))
  }

  const out = []
  const cam = state.camera
  if (!cam) return out
  cam.getWorldPosition(_cameraPos)

  const jx = Math.random() * step
  const jy = Math.random() * step
  const minSep2 = 0.12 * 0.12
  const ys = []

  outer:
  // Lower half of the feed is where the ground lives when the phone is upright.
  for (let ny = 0.42 + jy; ny <= 0.94; ny += step) {
    for (let nx = 0.12 + jx; nx <= 0.9; nx += step) {
      const results = hitTestNormalized(nx, ny)
      if (!results.length) continue

      let best = null
      for (const type of SURFACE_PREFERENCE) {
        best = results.find((r) => r.type === type)
        if (best) break
      }
      if (!best?.position) continue

      const normal = hitNormal(best)
      if (normal && normal.y < minSurfaceY) continue

      const p = best.position
      const dist = Math.hypot(p.x - _cameraPos.x, p.y - _cameraPos.y, p.z - _cameraPos.z)
      if (dist < minDistance || dist > maxDistance) continue

      // Collapse duplicates so a single big surface yields distinct spots.
      let duplicate = false
      for (const seen of ys) {
        const dx = seen.x - p.x
        const dz = seen.z - p.z
        if (dx * dx + dz * dz < minSep2) { duplicate = true; break }
      }
      if (duplicate) continue

      ys.push(p)
      out.push({
        position: new THREE.Vector3(p.x, p.y, p.z),
        normal: normal ?? new THREE.Vector3(0, 1, 0),
        distance: dist,
      })
      if (out.length >= maxSamples) break outer
    }
  }

  // Keep the session floor estimate fresh from what we just observed.
  if (ys.length) {
    const sorted = ys.map((p) => p.y).sort((a, b) => a - b)
    noteGroundY(sorted[Math.floor(sorted.length / 2)])
  }
  return out
}

/**
 * A point on the ground `distanceM` in front of the player.
 *
 * The belt-and-braces fallback for featureless ground: when SLAM hit tests give
 * us nothing, we still know which way the phone is looking and roughly where
 * the floor is, so we can lay a spawn down anyway.
 */
export function groundPointInFront(distanceM = 3, groundYOverride = null) {
  const cam = state.camera
  if (!cam) return null
  cam.getWorldPosition(_cameraPos)
  const f = cameraForward()
  f.y = 0
  if (f.lengthSq() < 1e-6) f.set(0, 0, -1)
  f.normalize()
  const y = groundYOverride ?? groundLevelY()
  return new THREE.Vector3(_cameraPos.x + f.x * distanceM, y, _cameraPos.z + f.z * distanceM)
}


// -----------------------------------------------------------------------------
// Hologram light (inspection + Pokédex)
// -----------------------------------------------------------------------------
const hologram = {light: null, disc: null, target: null, intensity: 0, discBase: 0}

/**
 * Show/hide the mysterious light-blue light that comes up from the SLAM floor.
 * @param {boolean} on
 * @param {{x,y,z}|null} [position] world position to place it at
 */
export function setHologram(on, position = null) {
  hologram.on = on
  if (position) hologram.target = new THREE.Vector3(position.x, position.y, position.z)
  if (hologram.light) hologram.light.visible = on
  if (hologram.disc) hologram.disc.visible = on
}

export function setHologramTarget(position) {
  if (position) hologram.target = new THREE.Vector3(position.x, position.y, position.z)
}

function initHologram(scene) {
  const light = new THREE.PointLight(0x6fd6ff, 0, 6, 1.6)
  light.name = 'hologram-light'
  light.visible = false
  scene.add(light)
  hologram.light = light

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 48),
    new THREE.MeshBasicMaterial({
      color: 0x6fd6ff,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  disc.rotation.x = -Math.PI / 2
  disc.name = 'hologram-disc'
  disc.visible = false
  disc.renderOrder = 5
  scene.add(disc)
  hologram.disc = disc
}

function updateHologram(t) {
  const {light, disc, on} = hologram
  if (!light || !disc) return
  const target = hologram.target
  if (on && target) {
    light.position.set(target.x, target.y + 0.35, target.z)
    disc.position.set(target.x, target.y + 0.005, target.z)
  }
  // Ease the intensity in and out so the light "breathes".
  const goal = on ? 1 : 0
  hologram.intensity += (goal - hologram.intensity) * 0.12
  light.intensity = hologram.intensity * 3.2
  const pulse = 1 + Math.sin(t * 2.4) * 0.06
  light.distance = 6 * pulse
  disc.material.opacity = hologram.intensity * 0.28 * pulse
  disc.visible = hologram.intensity > 0.01
  light.visible = hologram.intensity > 0.01
}

// -----------------------------------------------------------------------------
// Pipeline modules
// -----------------------------------------------------------------------------
const refs = {}

export function sceneInitPipelineModule() {
  return {
    name: 'bt16-scene',
    onStart({canvas}) {
      // The whole scene bootstrap is guarded: if any of it throws, the run loop
      // would otherwise carry on with a half-built scene and stall the camera.
      try {
        bootstrapScene(canvas)
      } catch (err) {
        state.lastEngineError = String(err?.message || err)
        console.error('[bt16] scene bootstrap failed:', err)
      }
    },

    onUpdate() {
      const now = performance.now() / 1000
      const dt = lastTrackAt ? Math.min(0.1, now - lastTrackAt) : 0
      lastTrackAt = now
      // Keep the surface model current before any game system asks it for a spot.
      try {
        updateSurfaceTracking(dt)
      } catch (err) {
        state.lastGameError = String(err?.message || err)
      }
      state.scene?.userData?.onFrame?.()
      updateHologram(now)
    },
  }
}

/**
 * One frame of advanced surface tracking.
 *
 * Enabled by `tracking.advanced` (true by default). When it is off the tracker
 * is dropped and everything falls back to the simple grid scan in
 * sampleSurfaces().
 */
function updateSurfaceTracking(dt) {
  const cfg = GM.tracking
  if (!cfg || cfg.advanced === false) {
    if (surfaceConfigKey) {
      surfaceTracker.reset()
      surfaceConfigKey = ''
      state.surfaceStats = null
    }
    return
  }
  const key = JSON.stringify(cfg.surface ?? {})
  if (key !== surfaceConfigKey) {
    surfaceTracker.configure(cfg.surface ?? {})
    surfaceConfigKey = key
  }
  surfaceTracker.update(dt, hitTestNormalized)
  state.surfaceStats = surfaceTracker.stats()
}

function bootstrapScene(canvas) {
  const {scene, camera, renderer} = XR8.Threejs.xrScene()
  state.scene = scene
  state.camera = camera
  state.renderer = renderer
  state.canvas = canvas

  // Shadows: the only way "proper, realistic shadows" land on the floor.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  // 6DoF origin: camera above y = 0 so SLAM has a ground plane to lock to.
  camera.position.set(0, CAMERA_HEIGHT, 0)
  camera.rotation.set(0, 0, 0)
  camera.lookAt(new THREE.Vector3(0, 0, -1))
  XR8.XrController.updateCameraProjectionMatrix({
    origin: camera.position,
    facing: camera.quaternion,
  })

  // --- lights -----------------------------------------------------------
  refs.ambient = new THREE.AmbientLight(0xffffff, 0.55)
  scene.add(refs.ambient)

  refs.key = new THREE.DirectionalLight(0xffffff, 1.0)
  refs.key.castShadow = true
  refs.key.name = 'key-light'
  refs.key.shadow.mapSize.set(2048, 2048)
  refs.key.shadow.camera.near = 0.1
  refs.key.shadow.camera.far = 24
  const s = 6
  refs.key.shadow.camera.left = -s
  refs.key.shadow.camera.right = s
  refs.key.shadow.camera.top = s
  refs.key.shadow.camera.bottom = -s
  refs.key.shadow.bias = -0.0004
  refs.key.shadow.normalBias = 0.02
  scene.add(refs.key)
  scene.add(refs.key.target)

  refs.fill = new THREE.DirectionalLight(0xffffff, 0.28)
  refs.fill.position.set(-3, 2, -2)
  scene.add(refs.fill)

  // --- shadow-catching ground -------------------------------------------
  // Invisible except where it receives a shadow.
  refs.ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.ShadowMaterial({opacity: 0.42}),
  )
  refs.ground.rotation.x = -Math.PI / 2
  refs.ground.receiveShadow = true
  refs.ground.name = 'ground'
  scene.add(refs.ground)

  initHologram(scene)

  // Keep the shadow frustum centred on the player so shadows stay sharp.
  scene.userData.onFrame = () => {
    const cam = state.camera
    if (!cam) return
    cam.getWorldPosition(_cameraPos)
    refs.key.position.set(_cameraPos.x + 2.5, _cameraPos.y + 4, _cameraPos.z + 2)
    refs.key.target.position.set(_cameraPos.x, groundLevelY(), _cameraPos.z)
    refs.key.target.updateMatrixWorld()
    refs.fill.position.set(_cameraPos.x - 3, _cameraPos.y + 2, _cameraPos.z - 2)
    // The shadow-catcher rides the smoothed floor line, so Pokémon cast onto
    // the same plane they are standing on even where SLAM never saw a surface.
    refs.ground.position.y = groundLevelY()
  }

  // Stop iOS from scrolling when dragging across the camera feed.
  if (canvas) {
    canvas.style.touchAction = 'none'
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), {passive: false})
  }

  console.log('[bt16] scene ready')
}

export function lightingPipelineModule() {
  const MIN = 0.15
  const MAX = 1.0
  return {
    name: 'bt16-lighting',
    onProcessCpu({processCpuResult}) {
      const lighting = processCpuResult?.reality?.lighting
      if (!lighting) return
      state.lighting = {exposure: clamp(lighting.exposure, MIN, MAX)}
    },
    onUpdate() {
      if (!state.lighting || !refs.key) return
      const t = (state.lighting.exposure - MIN) / (MAX - MIN)
      refs.key.intensity = 0.3 + t * 1.5
      refs.ambient.intensity = 0.35 + t * 0.45
      if (state.renderer) state.renderer.toneMappingExposure = 0.7 + t * 0.65
    },
  }
}

export function trackingPipelineModule() {
  let frames = 0
  let windowStart = performance.now()
  return {
    name: 'bt16-tracking',
    listeners: [
      {
        event: 'reality.trackingstatus',
        process({detail}) {
          state.trackingStatus = detail?.status ?? null
          state.trackingReason = detail?.reason ?? null
          window.dispatchEvent(new CustomEvent('bt16:tracking', {detail}))
        },
      },
    ],
    onProcessCpu({processCpuResult}) {
      const reality = processCpuResult?.reality
      if (!reality || !state.camera) return
      state.trackingStatus = reality.trackingStatus ?? state.trackingStatus
      state.trackingReason = reality.trackingReason ?? state.trackingReason
      state.camera.getWorldPosition(_cameraPos)
      state.cameraPosition = {x: _cameraPos.x, y: _cameraPos.y, z: _cameraPos.z}
    },
    onUpdate() {
      frames++
      const now = performance.now()
      if (now - windowStart >= 1000) {
        state.fps = Math.round((frames * 1000) / (now - windowStart))
        frames = 0
        windowStart = now
      }
    },
  }
}

/** Per-frame driver for the game systems. */
export function framePipelineModule() {
  return {name: 'bt16-frame', onUpdate: runFrameHooks}
}

/**
 * Records engine exceptions instead of letting one bad frame take the camera
 * feed down with it. Returning `true` tells the engine the error was handled.
 */
export function exceptionPipelineModule() {
  return {
    name: 'bt16-exceptions',
    onException({error, isFatal}) {
      const message = String(error?.message || error || 'unknown engine error')
      state.lastEngineError = message
      console.error(`[bt16] engine exception (fatal=${!!isFatal}):`, error)
      window.dispatchEvent(
        new CustomEvent('bt16:engineerror', {detail: {message, isFatal: !!isFatal}}),
      )
      return !isFatal
    },
  }
}

/** Every first-party module, in install order. */
export function createPipelineModules() {
  return [
    trackingPipelineModule(),
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    sceneInitPipelineModule(),
    lightingPipelineModule(),
    // Drives the game systems. Without it the hooks registered by main.js never
    // run and the world stands still.
    framePipelineModule(),
    exceptionPipelineModule(),
  ]
}

/** Optional helpers, only if their script tags loaded. */
export function optionalModules() {
  const modules = []
  if (window.XRExtras?.FullWindowCanvas) {
    modules.push(XRExtras.FullWindowCanvas.pipelineModule())
  }
  return modules
}
