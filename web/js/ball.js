/**
 * Catching.
 *
 * The full sequence from the spec:
 *   1. the player swipes up      -> a ball is thrown (direction + speed matter)
 *   2. the ball flies through the air
 *   3. if it hits a Pokémon it bounces ~1 m up, the Pokémon fades into the ball,
 *      then the ball falls, SLAMS the ground, bounces ~15 cm, and finally
 *      wobbles 1–3 times (each shake takes 2 seconds): it tilts right, sweeps
 *      smoothly to the left, then settles back to the middle
 *        · 1 shake  -> the Pokémon breaks out and fades back to its spot
 *        · 2 shakes -> it breaks out, runs ~3 s, then disappears in smoke
 *        · 3 shakes -> caught: stars burst around the ball for ~1.5 s, then the
 *                      ball and the stars fade away
 *   4. a ball that MISSES the Pokémon drops to the ground and bounces 2–3 times.
 *      A Poké Ball is hard, so the hops are tiny and shrink fast; it then rolls
 *      a short way and fades out.
 *
 * Premier Balls only work on legendary Pokémon.
 */
import * as THREE from 'three'

import {
  state, emit, clamp, playSound, ASSET_SOUNDS,
} from './core.js?v=16'
import {GM} from './gamemaster.js?v=16'
import {getBall, pokemonName, STORAGE_LIMIT} from './data.js?v=16'
import {loadBallTemplate, instantiate, enableShadows} from './gltf.js?v=16'
import {cameraForward, cameraPosition, hitTestNormalized, groundLevelY} from './ar.js?v=16'

// No physics or timing constant lives here: gravity, throw strength, bounce
// heights, wobble timing and catch odds are all read live from `GM` — the game
// master (web/config/game-master.json, loaded at boot by gamemaster.js).

// Scratch vector for the rolling spin (perpendicular to the direction of travel).
const _rollAxis = new THREE.Vector3()

/** Smooth 0..1 easing, used by the shake. */
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/**
 * One shake, as a function of `k` in 0..1: tilt right, sweep smoothly across to
 * the left, then settle back to the middle. Velocity is zero at both extremes,
 * so the wobble eases in and out instead of snapping.
 */
function shakeAngle(k) {
  const a = GM.catch.shakeTiltRad
  if (k < 0.3) return a * easeInOut(k / 0.3)                    // 0 -> +a (right)
  if (k < 0.72) return a - 2 * a * easeInOut((k - 0.3) / 0.42)  // +a -> -a (left)
  return -a + a * easeInOut((k - 0.72) / 0.28)                  // -a -> 0 (centre)
}

// A five-point star sprite, drawn once into a canvas and reused for every catch.
let starTexture = null
function getStarTexture() {
  if (starTexture) return starTexture
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.translate(size / 2, size / 2)
  ctx.beginPath()
  const spikes = 5
  const outer = 28
  const inner = 12
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const ang = (Math.PI / spikes) * i - Math.PI / 2
    const x = Math.cos(ang) * r
    const y = Math.sin(ang) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.shadowColor = 'rgba(255, 214, 74, 0.95)'
  ctx.shadowBlur = 10
  ctx.fillStyle = '#fff6c8'
  ctx.fill()
  starTexture = new THREE.CanvasTexture(canvas)
  return starTexture
}

/** Ground height under the player: the tracked floor, or a sane fallback. */
function estimateGroundY() {
  // Advanced tracking knows the floor even where this single hit test would
  // miss it (streets, tables), so prefer it when enabled.
  if (GM.tracking?.advanced) return groundLevelY()
  const results = hitTestNormalized(0.5, 0.9)
  for (const r of results) {
    if (r?.position) return r.position.y
  }
  // The scene camera sits 1.6 m above the floor.
  const cam = state.camera
  return cam ? cam.position.y - 1.6 : 0
}

/**
 * The catch controller: owns the in-flight ball, the timing and the outcome.
 */
export class CatchController {
  constructor() {
    this.canvas = null
    this.active = null
    this.attached = false
    this._pointer = null
    this.ballPoint = new THREE.Vector3()
  }

  attach(canvas) {
    if (this.attached) return
    this.attached = true
    this.canvas = canvas

    this._onDown = (e) => {
      if (!this.canThrow()) return
      this._pointer = {id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now()}
    }
    this._onUp = (e) => {
      const start = this._pointer
      this._pointer = null
      if (!start || start.id !== e.pointerId) return
      if (!this.canThrow()) return

      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      const dt = Math.max(16, performance.now() - start.t)
      // Must be a deliberate upward swipe.
      if (-dy < GM.throw.minSwipePx) return
      this.throwBall({dx, dy, dt, width: window.innerWidth, height: window.innerHeight})
    }
    this._onCancel = () => { this._pointer = null }

    canvas.addEventListener('pointerdown', this._onDown)
    canvas.addEventListener('pointerup', this._onUp)
    canvas.addEventListener('pointercancel', this._onCancel)
  }

  canThrow() {
    if (this.active) return false
    if (state.dialogOpen || state.inspecting || state.busy) return false
    if (state.pokemon.length === 0) return false
    return true
  }

  /**
   * Launch a ball from the swipe.
   * @param {{dx:number, dy:number, dt:number, width:number, height:number}} swipe
   */
  async throwBall(swipe) {
    const itemId = state.selectedItem
    const ball = getBall(itemId)

    // Premier Balls are reserved for legendary Pokémon.
    if (ball.legendaryOnly && !state.pokemon.some((p) => p.legendary)) {
      emit('toast', {text: 'Premier Balls are only for legendary Pokémon'})
      playSound(ASSET_SOUNDS.decideError)
      return
    }

    // Counts are real now: you cannot throw a ball you do not have. PokéStops
    // are where they come from.
    if (!GM.items.unlimited && (state.items[itemId] ?? 0) <= 0) {
      emit('toast', {text: `Out of ${ball.name}s — spin a PokéStop`})
      playSound(ASSET_SOUNDS.decideError)
      return
    }

    const cam = cameraPosition()
    if (!cam) return

    this.active = {
      itemId,
      phase: 'flight',
      age: 0,
      shakes: 0,
      shakeTimer: 0,
      target: null,
      groundY: estimateGroundY(),
      bounces: 0,        // ground contacts after a catch (the slam + hop)
      missBounces: 0,    // ground bounces on a miss, before the roll
      rollTimer: 0,
      fadeTimer: 0,
      cooldown: 0,
    }

    const origin = new THREE.Vector3(cam.x, cam.y - GM.throw.originDropM, cam.z)
    const forward = cameraForward()
    // Camera-right vector, for the "slightly right" lateral component.
    const right = forward.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()

    const dxRatio = clamp(swipe.dx / (swipe.width || 1), -1, 1)
    const length = clamp(-swipe.dy / (swipe.height || 1), 0, 1)     // 0..1
    const speed = clamp(swipe.dt / 1000, GM.throw.swipeSpeedMinS, GM.throw.swipeSpeedMaxS)
    const velocityFactor = clamp(
      (GM.throw.velocityRefS - Math.min(speed, GM.throw.velocityRefS)) / GM.throw.velocityRefS,
      GM.throw.velocityFloor,
      1,
    )
    const power = GM.throw.powerBase +
      length * GM.throw.powerPerLength +
      velocityFactor * GM.throw.powerVelocityWeight                  // m/s along forward
    const velocity = forward.multiplyScalar(power)
      .add(right.multiplyScalar(dxRatio * GM.throw.lateralPower))
      .add(new THREE.Vector3(0, GM.throw.liftBase + length * GM.throw.liftPerLength, 0))

    this.active.velocity = velocity
    this.active.position = origin

    const {scene} = await loadBallTemplate(itemId)
    const mesh = instantiate(scene)
    enableShadows(mesh)
    mesh.position.copy(origin)
    if (state.scene) state.scene.add(mesh)
    this.active.mesh = mesh

    // Spend the ball (unless the game master says items are unlimited).
    if (!GM.items.unlimited) {
      state.items[itemId] = Math.max(0, (state.items[itemId] ?? 0) - 1)
    }
    emit('items:changed')
    emit('progress')
    const spin = GM.throw.spinMax
    this.active.spin = new THREE.Vector3(
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin,
    )
    this.active.radius = scene.userData.radius ?? GM.ball.diameterM / 2

    playSound(ASSET_SOUNDS.ballThrow, {volume: 0.8})
    emit('throw:start', {itemId})
  }

  /** Advance the whole sequence. Called every frame from main.js. */
  update(dt) {
    const a = this.active
    if (!a || !a.mesh) return
    a.age += dt

    switch (a.phase) {
      case 'flight':
      case 'drop':
        this.tickFlight(dt, a)
        break
      case 'rolling':
        this.tickRolling(dt, a)
        break
      case 'fading':
        this.tickMissFade(dt, a)
        break
      case 'shaking':
        this.tickShaking(dt, a)
        break
      case 'celebrate':
        this.tickCelebrate(dt, a)
        break
      case 'result':
        a.cooldown -= dt
        if (a.cooldown <= 0) this.finish()
        break
      default:
        break
    }

    // Tumble only while the ball is genuinely in the air. Once it settles the
    // spin stops, so the shake animation owns the rotation instead of fighting
    // it (that fight is what made the ball look like it was spinning).
    if (a.phase === 'flight' || a.phase === 'drop') {
      a.mesh.rotation.x += a.spin.x * dt
      a.mesh.rotation.y += a.spin.y * dt
      a.mesh.rotation.z += a.spin.z * dt
    }
  }

  /** Ballistic flight, with Pokémon collision and ground impact. */
  tickFlight(dt, a) {
    a.velocity.y -= GM.ball.gravity * dt
    a.position.addScaledVector(a.velocity, dt)
    a.mesh.position.copy(a.position)

    // --- Pokémon collision (sphere approximation) -------------------------
    if (a.phase === 'flight') {
      for (const pokemon of state.pokemon) {
        // Only fully spawned, currently visible Pokémon can be hit.
        if (!pokemon.loaded || pokemon.state === 'gone' || !pokemon.root.visible) continue
        const centre = pokemon.centre()
        const radius = Math.max(
          GM.ball.collisionMinRadiusM,
          pokemon.heightM * GM.ball.collisionHeightFactor,
        )
        if (a.position.distanceTo(centre) <= radius + a.radius) {
          this.onHit(pokemon, a)
          return
        }
      }
    }

    // --- ground ------------------------------------------------------------
    if (a.position.y - a.radius <= a.groundY) {
      a.position.y = a.groundY + a.radius
      a.mesh.position.copy(a.position)
      if (a.phase === 'flight') {
        this.onMissBounce(a)
      } else {
        this.onSlam(a)
      }
    }
  }

  /** The Pokémon is hit: bounce ~1 m up and draw the Pokémon into the ball. */
  onHit(pokemon, a) {
    a.target = pokemon
    a.phase = 'drop'
    a.position.y = Math.max(a.position.y, pokemon.root.position.y + 0.1)
    a.velocity.set(
      a.velocity.x * 0.25,
      Math.sqrt(2 * GM.ball.gravity * GM.ball.hitBounceM),
      a.velocity.z * 0.25,
    )
    a.groundY = pokemon.root.position.y
    playSound(ASSET_SOUNDS.ballTarget, {volume: 0.9})
    playSound(ASSET_SOUNDS.ballTakeIn, {volume: 0.7})
    pokemon.captureIntoBall().catch(() => {})
    emit('throw:hit', {pokemon})
  }

  /** The ball hits the ground after a catch: the SLAM, then a 15 cm hop. */
  onSlam(a) {
    playSound(ASSET_SOUNDS.ballGround, {volume: 1, interrupt: false})
    a.bounces++
    if (a.bounces <= 1) {
      a.velocity.y = Math.sqrt(2 * GM.ball.gravity * GM.ball.groundBounceM)
      a.velocity.x *= 0.2
      a.velocity.z *= 0.2
      playSound(ASSET_SOUNDS.ballBounce, {volume: 0.8})
      return
    }
    // Settled: stand the ball upright and begin the shake sequence.
    a.velocity.set(0, 0, 0)
    a.spin.set(0, 0, 0)
    a.mesh.rotation.set(0, 0, 0)
    a.phase = 'shaking'
    a.shakeTimer = 0
    a.shakes = 0
    a.totalShakes = this.decideShakes(a)
    console.log(`[bt16] ball settled — ${a.totalShakes} shake(s)`)
  }

  /**
   * A ball that missed the Pokémon hit the ground.
   *
   * A Poké Ball is rigid: the hop heights fall off fast from `missBounceBaseM`
   * (2–3 low bounces), then the ball rolls. Nothing here fades the ball out yet
   * — tickRolling() does that once friction has taken the speed away.
   */
  onMissBounce(a) {
    playSound(ASSET_SOUNDS.ballGround, {volume: 0.6, interrupt: false})
    a.missBounces += 1
    a.velocity.x *= GM.ball.missBounceFriction
    a.velocity.z *= GM.ball.missBounceFriction

    if (a.missBounces > GM.ball.missBounceCount) {
      // Out of hops: roll along the ground until friction stops it.
      a.phase = 'rolling'
      a.rollTimer = 0
      a.velocity.y = 0
      a.spin.set(0, 0, 0)
      return
    }

    const height = GM.ball.missBounceBaseM * Math.pow(GM.ball.missBounceDecay, a.missBounces - 1)
    a.velocity.y = Math.sqrt(2 * GM.ball.gravity * Math.max(0, height))
    playSound(ASSET_SOUNDS.ballBounce, {volume: 0.7})
  }

  /** Roll the missed ball along the floor, then start its fade-out. */
  tickRolling(dt, a) {
    a.rollTimer += dt
    const damp = Math.exp(-GM.ball.rollFriction * dt)
    a.velocity.x *= damp
    a.velocity.z *= damp
    a.position.x += a.velocity.x * dt
    a.position.z += a.velocity.z * dt
    a.position.y = a.groundY + a.radius
    a.mesh.position.copy(a.position)

    // Visual roll: turn about the horizontal axis perpendicular to travel, at
    // the rate a rigid sphere of this radius would (angle = distance / radius).
    const speed = Math.hypot(a.velocity.x, a.velocity.z)
    if (speed > 1e-3) {
      _rollAxis.set(a.velocity.z, 0, -a.velocity.x).normalize()
      a.mesh.rotateOnWorldAxis(_rollAxis, (speed * dt) / a.radius)
    }

    if (speed < GM.ball.rollStopMps || a.rollTimer >= GM.ball.rollSeconds) {
      a.phase = 'fading'
      a.fadeTimer = 0
      a.fadeMats = this.cloneBallMaterials(a.mesh)
    }
  }

  /** Fade the missed ball away, then remove it. */
  tickMissFade(dt, a) {
    a.fadeTimer += dt
    const alpha = clamp(1 - a.fadeTimer / GM.ball.missFadeSeconds, 0, 1)
    for (const m of a.fadeMats ?? []) m.opacity = alpha
    if (alpha <= 0) this.finish()
  }

  /** 1–3 shakes, two seconds each. Each one wobbles right, left, then centre. */
  tickShaking(dt, a) {
    a.shakeTimer += dt
    const k = clamp(a.shakeTimer / GM.catch.shakeSeconds, 0, 1)
    a.mesh.rotation.z = shakeAngle(k)

    if (a.shakeTimer < GM.catch.shakeSeconds) return

    a.shakes++
    a.shakeTimer = 0
    a.mesh.rotation.z = 0
    playSound(ASSET_SOUNDS.ballGrab, {volume: 0.7})

    if (a.shakes >= a.totalShakes) {
      this.resolve(a)
    }
  }

  /** How many shakes this throw gets. */
  decideShakes(a) {
    const ballId = a.itemId
    const target = a.target
    let chance = GM.catch.chance[ballId] ?? GM.catch.fallbackChance
    if (target?.legendary) chance *= GM.catch.legendaryMultiplier
    const caught = Math.random() < chance
    if (caught) return GM.catch.shakesOnCatch
    // Not caught: 1 or 2 shakes.
    return Math.random() < GM.catch.escapeShakeChance ? 1 : 2
  }

  /** Apply the outcome of the shake sequence. */
  resolve(a) {
    const target = a.target

    if (a.shakes >= GM.catch.shakesOnCatch) {
      // Caught: burst some stars, then fade the ball and the stars away.
      playSound(ASSET_SOUNDS.gotcha, {volume: 1})
      emit('catch:success', {pokemon: target})
      if (target) {
        this.registerCatch(target)
        target.setState('gone')
        target.root.parent?.remove(target.root)
      }
      this.startCelebration(a)
      return
    }

    a.phase = 'result'
    a.cooldown = GM.catch.escapeCooldownS
    playSound(ASSET_SOUNDS.ballOut, {volume: 0.9})
    if (target) {
      if (a.shakes === 1) {
        // Breaks out and fades back to its spot.
        target.breakOut().catch(() => {})
      } else {
        // Breaks out and fades back first — it was drawn into the ball, so
        // without this the fleeing Pokémon would still be invisible.
        target.breakOut()
          .then(() => {
            target.play('attack', {once: true})
            setTimeout(() => target.flee(), 500)
          })
          .catch(() => {})
      }
      emit('catch:escape', {pokemon: target, shakes: a.shakes})
    }
  }

  /** A successful catch: stars burst, then the ball and stars fade away. */
  startCelebration(a) {
    a.phase = 'celebrate'
    a.celebrateTimer = 0
    a.fadeMats = this.cloneBallMaterials(a.mesh)
    this.spawnStars(a)
  }

  /**
   * Clone the ball's (template-shared) materials so this one ball can fade out
   * without dimming the cached template. The clones are disposed in finish().
   */
  cloneBallMaterials(mesh) {
    const mats = []
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material) return
      const clone = (m) => {
        const c = m.clone()
        c.transparent = true
        mats.push(c)
        return c
      }
      o.material = Array.isArray(o.material) ? o.material.map(clone) : clone(o.material)
    })
    return mats
  }

  /** Ring of twinkling stars around the settled ball. */
  spawnStars(a) {
    const tex = getStarTexture()
    const group = new THREE.Group()
    const count = GM.celebration.starCount
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }))
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5
      const rad = 0.16 + Math.random() * 0.16
      const scale = 0.1 + Math.random() * 0.08
      sprite.position.set(Math.cos(ang) * rad, Math.random() * 0.18, Math.sin(ang) * rad)
      sprite.scale.setScalar(scale)
      sprite.userData = {
        vel: new THREE.Vector3(
          Math.cos(ang) * (0.16 + Math.random() * 0.12),
          0.22 + Math.random() * 0.28,
          Math.sin(ang) * (0.16 + Math.random() * 0.12),
        ),
        phase: Math.random() * Math.PI * 2,
        speed: 3.5 + Math.random() * 4,
      }
      group.add(sprite)
    }
    group.position.copy(a.mesh.position)
    state.scene?.add(group)
    a.stars = group
  }

  /** Stars sparkle around the ball for STAR_SECONDS, then everything fades. */
  tickCelebrate(dt, a) {
    a.celebrateTimer += dt
    const t = a.celebrateTimer
    const alpha = t <= GM.celebration.starSeconds
      ? 1
      : clamp(1 - (t - GM.celebration.starSeconds) / GM.celebration.fadeSeconds, 0, 1)

    for (const sprite of a.stars?.children ?? []) {
      const u = sprite.userData
      sprite.position.addScaledVector(u.vel, dt)
      u.vel.multiplyScalar(Math.max(0, 1 - 2.2 * dt))
      // Twinkle: fade each star in and out on its own phase.
      const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * u.speed + u.phase))
      sprite.material.opacity = alpha * twinkle
    }

    if (a.fadeMats) for (const m of a.fadeMats) m.opacity = alpha
    if (alpha <= 0) this.finish()
  }

  /**
   * Persist a caught Pokémon locally and mark the Pokédex entry.
   *
   * Each catch is its own storage slot (duplicates allowed), keyed by a unique
   * id rather than the dex number. With storage full the Pokémon still counts
   * for the Pokédex but is not kept — the same rule as Pokémon GO.
   */
  registerCatch(pokemon) {
    const dex = pokemon.dex
    const held = Object.keys(state.inventory).length
    if (held >= STORAGE_LIMIT) {
      state.pokedex[dex] = true
      emit('pokemon:caught', {dex, pokemon})
      emit('progress')
      emit('toast', {text: `Storage full (${STORAGE_LIMIT}) — Pokémon not kept`})
      console.warn(`[bt16] storage full (${STORAGE_LIMIT}) — released ${pokemonName(dex)} (#${dex})`)
      return
    }
    const id = `${dex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    state.inventory[id] = {
      dex,
      nickname: pokemonName(dex),
      caughtDate: Date.now(),
      cp: 0,
      pokedex_entry: dex,
    }
    state.pokedex[dex] = true
    emit('pokemon:caught', {dex, pokemon})
    emit('progress')
    console.log(`[bt16] caught ${pokemonName(dex)} (#${dex})`)
  }

  /**
   * Tidy up the ball and clear the active throw.
   *
   * The mesh is a clone of the cached ball template, so its geometry and the
   * template's own materials are shared — the mesh is only detached. Anything
   * cloned for the catch fade, plus the star sprites, is ours to dispose.
   */
  finish() {
    const a = this.active
    if (!a) return
    a.mesh?.parent?.remove(a.mesh)
    if (a.fadeMats) for (const m of a.fadeMats) m.dispose()
    if (a.stars) {
      a.stars.parent?.remove(a.stars)
      for (const sprite of a.stars.children) sprite.material?.dispose()
    }
    this.active = null
    emit('throw:end')
  }
}
