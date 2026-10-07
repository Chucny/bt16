/**
 * PokéStops.
 *
 * One stop is kept alive at a time, sitting on a stable spot on the ground in
 * front of the player. Tapping it spins it (real decaying angular velocity, a
 * few full 360° turns about Y); a spin releases 1–4 soap bubbles, each holding
 * an item icon and worth 1–4 Poké Balls. Spinning puts the stop on cooldown,
 * during which it swaps to the closed (purple) model. Look away for
 * `despawnAfterS` and it despawns exactly like a Pokémon; the manager then
 * brings a fresh one up in front of you.
 *
 * Everything tunable — on/off, distances, the whole spin physics, the bubbles —
 * is read live from `GM.pokestops` (web/config/game-master.json).
 */
import * as THREE from 'three'

import {
  state, emit, clamp, randInt, setOpacity, playSound, ASSET_SOUNDS,
} from './core.js?v=16'
import {GM} from './gamemaster.js?v=16'
import {BALLS} from './data.js?v=16'
import {loadPokestopTemplate, instantiate, enableShadows} from './gltf.js?v=16'
import {
  sampleSurfaces, isPointVisible, cameraPosition, cameraForward,
  groundPointInFront,
} from './ar.js?v=16'

// -----------------------------------------------------------------------------
// Shared bubble assets
// -----------------------------------------------------------------------------
const bubbleGeometry = new THREE.SphereGeometry(1, 32, 24)
const iconCache = new Map()
const textureLoader = new THREE.TextureLoader()

function getIconTexture(url) {
  if (iconCache.has(url)) return iconCache.get(url)
  const tex = textureLoader.load(url)
  tex.colorSpace = THREE.SRGBColorSpace
  iconCache.set(url, tex)
  return tex
}

// A soap-film shader: transparent in the middle, bright iridescent rim, and a
// thin-film interference hue that shifts with the viewing angle. This is what
// makes the bubbles read as hyper-realistic soap rather than tinted glass.
const BUBBLE_VERT = `
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // Transform the normal as a direction (w = 0); the bubble scale is uniform,
  // so this is correct without the inverse-transpose.
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const BUBBLE_FRAG = `
uniform float uOpacity;
uniform float uTime;
uniform float uHue;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vec3 N = normalize(vNormalW);
  N *= gl_FrontFacing ? 1.0 : -1.0;   // back faces of the shell
  vec3 V = normalize(vViewW);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.0);   // bright rim, open centre

  // Thin-film interference: the hue sweeps with the viewing angle, the way a
  // soap film's colour does as it thins toward the rim.
  float phase = (1.0 - ndv) * 3.5 + uHue + uTime * 0.15;
  vec3 irid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + phase));
  vec3 base = mix(vec3(0.80, 0.92, 1.0), irid, 0.70);

  // A cheap sky/ground gradient reflection, so the film reads as a curved
  // surface even without an environment map.
  vec3 env = mix(vec3(0.42, 0.50, 0.60), vec3(0.95, 0.98, 1.0), N.y * 0.5 + 0.5);
  base = mix(base, env, 0.18 * (1.0 - fres));

  float alpha = (0.05 + 0.66 * fres) * uOpacity;

  // Two sharp moving highlights, like the reflections on real soap film.
  vec3 L1 = normalize(vec3(0.45, 0.9, 0.35));
  vec3 L2 = normalize(vec3(-0.6, 0.3, -0.5));
  float spec = pow(max(dot(reflect(-L1, N), V), 0.0), 54.0) * 1.5
             + pow(max(dot(reflect(-L2, N), V), 0.0), 32.0) * 0.5;
  base += spec;

  gl_FragColor = vec4(base, clamp(alpha, 0.0, 1.0));
}
`

function makeBubbleMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: BUBBLE_VERT,
    fragmentShader: BUBBLE_FRAG,
    uniforms: {
      uOpacity: {value: 1},
      uTime: {value: 0},
      uHue: {value: Math.random()},
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

function easeOutCubic(k) {
  const c = clamp(k, 0, 1)
  return 1 - Math.pow(1 - c, 3)
}

/** Add `amount` of an item and let the UI keep up. */
function awardItem(ball, amount) {
  state.items[ball.id] = (state.items[ball.id] ?? 0) + amount
  emit('items:changed')
  emit('progress')
  emit('pokestop:reward', {
    id: ball.id,
    name: ball.name,
    amount,
    total: state.items[ball.id],
  })
}

// -----------------------------------------------------------------------------
// Bubble
// -----------------------------------------------------------------------------
class Bubble {
  /**
   * @param {{id:string, icon:string}} ball
   * @param {number} amount 1..4 poké balls inside
   */
  constructor(ball, amount) {
    const cfg = GM.pokestops.bubbles
    this.ball = ball
    this.amount = amount
    this.radius = cfg.radiusM
    this.life = cfg.lifetimeS
    this.age = 0
    this.popped = false
    this.popTimer = 0
    this.dead = false
    this.bobPhase = Math.random() * Math.PI * 2

    this.group = new THREE.Group()
    this.base = this.group.position.clone()

    this.material = makeBubbleMaterial()
    this.mesh = new THREE.Mesh(bubbleGeometry, this.material)
    this.mesh.scale.setScalar(this.radius)
    this.mesh.renderOrder = 3
    this.group.add(this.mesh)

    // The item icon floats inside the shell.
    this.icon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getIconTexture(ball.icon),
      transparent: true,
      depthWrite: false,
      depthTest: true,
    }))
    this.icon.scale.setScalar(this.radius * 1.15)
    this.icon.renderOrder = 4
    this.group.add(this.icon)

    this.rise = 0
    this.sway = Math.random() * Math.PI * 2
  }

  place(x, y, z) {
    this.group.position.set(x, y, z)
    this.base.copy(this.group.position)
  }

  /** Take the item out of the bubble (once) and start the pop. */
  pop() {
    if (this.popped) return
    this.popped = true
    this.popTimer = 0
    awardItem(this.ball, this.amount)
  }

  update(dt, t) {
    this.material.uniforms.uTime.value = t
    const cfg = GM.pokestops.bubbles

    if (this.popped) {
      this.popTimer += dt
      const k = clamp(this.popTimer / 0.26, 0, 1)
      this.group.scale.setScalar(1 + k * 1.6)
      this.material.uniforms.uOpacity.value = 1 - k
      this.icon.material.opacity = 1 - k
      if (k >= 1) this.dead = true
      return
    }

    this.age += dt
    if (this.age >= this.life) {
      // Never lose an award the player simply did not tap: pop it on the way out.
      this.pop()
      return
    }

    const k = clamp(this.age / this.life, 0, 1)
    this.rise = cfg.riseHeightM * easeOutCubic(k)
    const bob = Math.sin(t * 2.4 + this.bobPhase) * 0.03
    const swayX = Math.sin(t * 1.1 + this.sway) * 0.02
    const swayZ = Math.cos(t * 1.3 + this.sway) * 0.02
    this.group.position.set(
      this.base.x + swayX,
      this.base.y + this.rise + bob,
      this.base.z + swayZ,
    )
    // Pop-in over the first third of a second.
    const grow = easeOutCubic(clamp(this.age / 0.3, 0, 1))
    this.group.scale.setScalar(grow)
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.material.dispose()
    this.icon.material.dispose()
  }
}

// -----------------------------------------------------------------------------
// PokéStop
// -----------------------------------------------------------------------------
export class Pokestop {
  /** @param {{x:number,y:number,z:number}} position */
  constructor(position) {
    this.root = new THREE.Group()
    this.root.position.set(position.x, position.y, position.z)
    this.root.name = 'pokestop'

    this.state = 'loading' // loading | fade-in | open | spinning | closed | gone
    this.phaseTimer = 0
    this.opacity = 0
    this.hiddenFor = 0
    this.angularVelocity = 0
    this.bubbles = []
    this.openMesh = null
    this.closedMesh = null
    this.light = null
    this.afterFadeState = 'open'
    this.afterFadeTimer = 0
  }

  get heightM() {
    return GM.pokestops.heightM
  }

  /** Load the open + closed models and add the stop to the world. */
  async spawn() {
    const [openT, closedT] = await Promise.all([
      loadPokestopTemplate('open'),
      loadPokestopTemplate('closed'),
    ])
    this.openMesh = instantiate(openT.scene)
    this.closedMesh = instantiate(closedT.scene)
    enableShadows(this.openMesh)
    enableShadows(this.closedMesh)
    this.root.add(this.openMesh)
    this.root.add(this.closedMesh)

    this.light = new THREE.PointLight(0x39a8ff, 0, 5, 2)
    this.light.position.set(0, this.heightM * 0.85, 0)
    this.root.add(this.light)

    this.state = 'fade-in'
    this.phaseTimer = GM.pokestops.fadeInS
    this.updateVisual()
    setOpacity(this.root, 0)
    state.scene?.add(this.root)
    emit('pokestop:spawn', {pokestop: this})
    return this
  }

  /** Queue the state to enter once the fade-in has finished. */
  beginClosed(seconds) {
    this.afterFadeState = 'closed'
    this.afterFadeTimer = seconds
  }

  setState(next, duration = 0) {
    this.state = next
    this.phaseTimer = duration
    this.updateVisual()
  }

  updateVisual() {
    const closed = this.state === 'closed'
    if (this.openMesh) this.openMesh.visible = !closed
    if (this.closedMesh) this.closedMesh.visible = closed
    if (this.light) this.light.color.set(closed ? 0x9b5cff : 0x39a8ff)
  }

  /** Can this stop be spun right now? */
  get open() {
    return this.state === 'open'
  }

  /**
   * Start a spin: high angular velocity that decays exponentially, i.e. it
   * whips around fast and coasts to a stop after several full turns.
   * @returns {boolean} true if the spin started
   */
  spin() {
    if (!this.open) return false
    this.angularVelocity = GM.pokestops.spin.initialSpeedRadS
    this.setState('spinning')
    this.spawnBubbles()
    playSound(ASSET_SOUNDS.pokestop, {volume: 0.8})
    emit('pokestop:spin', {pokestop: this})
    return true
  }

  update(dt, time) {
    if (this.state === 'gone') return

    switch (this.state) {
      case 'fade-in': {
        this.opacity = clamp(this.opacity + dt / GM.pokestops.fadeInS, 0, 1)
        setOpacity(this.root, this.opacity)
        if (this.opacity >= 1) {
          this.setState(this.afterFadeState, this.afterFadeTimer)
        }
        break
      }
      case 'spinning': {
        // Real decaying spin: ω' = -k·ω  ->  ω = ω₀·e^(-kt)
        this.angularVelocity *= Math.exp(-GM.pokestops.spin.friction * dt)
        this.root.rotation.y += this.angularVelocity * dt
        if (this.angularVelocity <= GM.pokestops.spin.minSpeedRadS) {
          this.angularVelocity = 0
          this.setState('closed', GM.pokestops.cooldownS)
        }
        break
      }
      case 'closed': {
        this.phaseTimer -= dt
        if (this.phaseTimer <= 0) this.setState('open')
        break
      }
      default:
        break
    }

    if (this.light) {
      const pulse = 1 + Math.sin(time * 2.6) * 0.18
      const base = this.state === 'closed' ? 0.7 : 1.6
      this.light.intensity = base * pulse
    }

    this.updateBubbles(dt, time)
    this.trackVisibility(dt)
  }

  // --- bubbles --------------------------------------------------------------
  spawnBubbles() {
    const cfg = GM.pokestops.bubbles
    const count = randInt(cfg.min, cfg.max)
    const base = this.root.position
    for (let i = 0; i < count; i++) {
      const bubble = new Bubble(this.pickBall(), randInt(cfg.awardMin, cfg.awardMax))
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.7
      const r = cfg.spreadM * (0.5 + Math.random() * 0.6)
      bubble.place(
        base.x + Math.cos(ang) * r,
        base.y + this.heightM * 0.72 + Math.random() * 0.14,
        base.z + Math.sin(ang) * r,
      )
      state.scene?.add(bubble.group)
      this.bubbles.push(bubble)
    }
    emit('pokestop:bubbles', {count})
  }

  /** Weighted pick across the balls, per `bubbles.ballWeights`. */
  pickBall() {
    const weights = GM.pokestops.bubbles.ballWeights ?? {}
    let total = 0
    for (const ball of BALLS) total += Math.max(0, weights[ball.id] ?? 0)
    if (total <= 0) return BALLS[0]
    let roll = Math.random() * total
    for (const ball of BALLS) {
      roll -= Math.max(0, weights[ball.id] ?? 0)
      if (roll <= 0) return ball
    }
    return BALLS[0]
  }

  updateBubbles(dt, time) {
    if (!this.bubbles.length) return
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]
      b.update(dt, time)
      if (b.dead) {
        b.dispose()
        this.bubbles.splice(i, 1)
      }
    }
  }

  /** Pop a bubble the player tapped; returns true when one was collected. */
  collectAt(clientX, clientY) {
    const bubble = this.pickBubbleAt(clientX, clientY)
    if (!bubble) return false
    bubble.pop()
    playSound(ASSET_SOUNDS.bubble, {volume: 0.65})
    emit('pokestop:collect', {id: bubble.ball.id, amount: bubble.amount})
    return true
  }

  /** Nearest un-popped bubble within a screen-space threshold, or null. */
  pickBubbleAt(clientX, clientY) {
    if (!state.camera || !this.bubbles.length) return null
    const rect = state.canvas?.getBoundingClientRect()
    if (!rect?.width) return null
    const cam = state.camera
    const thresholdPx = Math.max(56, Math.min(rect.width, rect.height) * 0.14)
    let best = null
    let bestDist = Infinity
    const p = new THREE.Vector3()
    for (const b of this.bubbles) {
      if (b.popped) continue
      p.copy(b.group.position).project(cam)
      if (p.z < -1 || p.z > 1) continue
      const sx = rect.left + (p.x * 0.5 + 0.5) * rect.width
      const sy = rect.top + (-p.y * 0.5 + 0.5) * rect.height
      const d = Math.hypot(sx - clientX, sy - clientY)
      if (d < thresholdPx && d < bestDist) {
        bestDist = d
        best = b
      }
    }
    return best
  }

  // --- tap / visibility -----------------------------------------------------
  /** Is a screen point on the stop itself? */
  hitTestScreen(clientX, clientY) {
    if (!this.root || !state.camera) return false
    const rect = state.canvas?.getBoundingClientRect()
    if (!rect?.width) return false

    // A generous screen-space halo around the orb makes the stop easy to tap
    // even when its pole is thin.
    const orb = new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.heightM * 0.82,
      this.root.position.z,
    ).project(state.camera)
    if (orb.z > -1 && orb.z < 1) {
      const sx = rect.left + (orb.x * 0.5 + 0.5) * rect.width
      const sy = rect.top + (-orb.y * 0.5 + 0.5) * rect.height
      const halo = Math.max(72, Math.min(rect.width, rect.height) * 0.18)
      if (Math.hypot(sx - clientX, sy - clientY) < halo) return true
    }

    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, state.camera)
    return raycaster.intersectObject(this.root, true).length > 0
  }

  /** Look away long enough and the stop despawns, exactly like a Pokémon. */
  trackVisibility(dt) {
    const p = this.root.position
    const visible = isPointVisible(
      {x: p.x, y: p.y + this.heightM * 0.6, z: p.z},
      0.12,
    )
    if (visible) {
      this.hiddenFor = 0
      return
    }
    this.hiddenFor += dt
    if (this.hiddenFor >= GM.pokestops.despawnAfterS) this.dispose()
  }

  dispose() {
    if (this.state === 'gone') return
    this.setState('gone')
    for (const b of this.bubbles) b.dispose()
    this.bubbles = []
    this.root.parent?.remove(this.root)
    emit('pokestop:despawn', {pokestop: this})
  }
}

// -----------------------------------------------------------------------------
// Manager
// -----------------------------------------------------------------------------
export class PokestopManager {
  constructor() {
    this.active = null
    this.enabled = false
    this.respawnAt = 0
    this.cooldownLeft = 0
    this.spawning = false
    this._tap = null
    this._boundDown = null
    this._boundUp = null
  }

  attach(canvas) {
    if (!canvas || this._boundDown) return
    this._boundDown = (e) => {
      this._tap = {id: e.pointerId, x: e.clientX, y: e.clientY}
    }
    this._boundUp = (e) => {
      const start = this._tap
      this._tap = null
      if (!start || start.id !== e.pointerId) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 14) return
      this.handleTap(e.clientX, e.clientY)
    }
    canvas.addEventListener('pointerdown', this._boundDown)
    canvas.addEventListener('pointerup', this._boundUp)
  }

  start() {
    this.enabled = true
    if (GM.pokestops.enabled) this.trySpawn()
  }

  stop() {
    this.enabled = false
    this.clear()
  }

  /** Remove the active stop immediately (used on world loss / shutdown). */
  clear() {
    if (this.active) {
      this.active.dispose()
      this.active = null
    }
    // Give the world a moment before a fresh stop is placed on the new map.
    this.respawnAt = Math.max(this.respawnAt, GM.pokestops.respawnDelayS)
  }

  update(dt, time) {
    if (!GM.pokestops.enabled) {
      if (this.active) this.clear()
      return
    }

    if (this.active) {
      this.active.update(dt, time)
      // Remember a running cooldown so the next stop cannot be spun for free.
      if (this.active.state === 'closed') this.cooldownLeft = this.active.phaseTimer
      if (this.active.state === 'gone') {
        this.active = null
        this.respawnAt = GM.pokestops.respawnDelayS
      }
    } else {
      if (this.cooldownLeft > 0) this.cooldownLeft = Math.max(0, this.cooldownLeft - dt)
      this.respawnAt -= dt
      if (this.enabled && this.respawnAt <= 0 && !this.spawning) this.trySpawn()
    }
  }

  async trySpawn() {
    if (this.active || this.spawning) return
    if (this.countStops() >= GM.pokestops.maxAlive) return
    const spot = this.findSpot()
    if (!spot) {
      // No plausible spot yet — come back shortly rather than waiting a full cycle.
      this.respawnAt = 2
      return
    }
    this.spawning = true
    const stop = new Pokestop(spot)
    this.active = stop
    try {
      await stop.spawn()
      if (this.cooldownLeft > 0) stop.beginClosed(this.cooldownLeft)
    } catch (err) {
      console.error('[bt16] pokestop spawn failed:', err)
      stop.dispose()
      this.active = null
      this.respawnAt = GM.pokestops.respawnDelayS
    } finally {
      this.spawning = false
    }
  }

  countStops() {
    return this.active ? 1 : 0
  }

  /**
   * A stable floor spot within the spawn ring, biased toward the part of the
   * world the player is looking at. Falls back to a point on the estimated
   * ground plane when SLAM has not mapped the surface (streets, tarmac).
   *
   * Placement is deliberately **floor-first**. A stop on a tabletop reads as
   * floating in the air, and an elevated patch that is only briefly detected
   * leaves the stop hanging in space until it despawns. So the query excludes
   * raised surfaces, then drops anything well above the lowest candidate and
   * picks the best-facing spot from what is left. All of that is array work on
   * the surface model the engine has already built, so it adds no hit tests and
   * nothing to the per-frame cost.
   */
  findSpot() {
    const cfg = GM.pokestops
    const cam = cameraPosition()
    if (!cam) return null

    const forward = cameraForward()
    forward.y = 0
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1)
    forward.normalize()
    const maxCos = Math.cos((GM.spawn.preferFrontDeg ?? 75) * Math.PI / 180)

    // `allowElevated: false` keeps the stop off tables and benches; the lowest
    // band below does the rest for the plain feed-scan fallback, which has no
    // floor/elevated distinction of its own.
    const candidates = sampleSurfaces({
      minDistance: cfg.minDistanceM,
      maxDistance: cfg.maxDistanceM,
      minSurfaceY: cfg.surfaceMinY,
      step: cfg.surfaceStepM,
      maxSamples: 24,
      allowElevated: false,
    })

    const valid = []
    for (const c of candidates) {
      const dx = c.position.x - cam.x
      const dz = c.position.z - cam.z
      const d = Math.hypot(dx, dz)
      if (d < cfg.minDistanceM || d > cfg.maxDistanceM) continue
      const facing = (dx * forward.x + dz * forward.z) / (d || 1)
      if (facing < maxCos) continue
      let blocked = false
      for (const p of state.pokemon) {
        const ox = p.root.position.x - c.position.x
        const oz = p.root.position.z - c.position.z
        if (ox * ox + oz * oz < Math.pow(GM.spawn.minSeparationM * 1.5, 2)) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      valid.push({position: c.position, d, facing})
    }

    if (valid.length) {
      // Lowest ground first: ignore anything more than `floorBandM` above the
      // lowest candidate, then choose the best-facing spot among the rest.
      const band = cfg.floorBandM ?? 0.35
      let lowest = Infinity
      for (const v of valid) if (v.position.y < lowest) lowest = v.position.y
      const onFloor = valid.filter((v) => v.position.y <= lowest + band)
      const pool = onFloor.length ? onFloor : valid
      let best = pool[0]
      let bestScore = -Infinity
      for (const v of pool) {
        const score = v.facing * 2 - v.d * 0.05 + Math.random() * 0.15
        if (score > bestScore) {
          bestScore = score
          best = v
        }
      }
      return {x: best.position.x, y: best.position.y, z: best.position.z}
    }

    // Street fallback: straight ahead, on the smoothed floor line.
    const d = (cfg.minDistanceM + cfg.maxDistanceM) / 2
    const p = groundPointInFront(d)
    return p ? {x: p.x, y: p.y, z: p.z} : null
  }

  handleTap(clientX, clientY) {
    if (state.dialogOpen || state.busy) return
    if (!this.active || this.active.state === 'gone') return
    // Bubbles sit in front of the stop, so they get first refusal on a tap.
    if (this.active.collectAt(clientX, clientY)) return
    if (!this.active.hitTestScreen(clientX, clientY)) return
    if (this.active.spin()) return
    // Closed: tell the player how long the recharge has left.
    if (this.active.state === 'closed') {
      emit('toast', {text: `PokéStop is recharging — ${Math.ceil(this.active.phaseTimer)}s`})
    }
  }
}
