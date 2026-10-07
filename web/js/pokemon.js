/**
 * Pokémon: one spawned creature, and the spawner that decides where and when
 * they appear.
 *
 * Behaviour per the spec:
 *   - default animation is idle, played continuously
 *   - every 5–6 s they pick a new reachable spot (never < 1 m from the player),
 *     play "attack" once, turn semi-slowly to face it, then "walk" there
 *   - if they leave the camera view for 1.5 s they despawn
 *   - spawns are 2–10 m from the player, ≥ 2 m apart, at most 4 alive,
 *     and happen on their own roughly every 10 seconds
 */
import * as THREE from 'three'

import {state, emit, randRange, randInt, setOpacity, playSound, ASSET_SOUNDS, clamp} from './core.js?v=16'
import {GM} from './gamemaster.js?v=16'
import {loadPokemonTemplate, instantiate, enableShadows, clipMap} from './gltf.js?v=16'
import {pokemonName, isLegendary, cryUrl} from './data.js?v=16'
import {
  sampleSurfaces, isPointVisible, cameraPosition, cameraForward, groundLevelY,
} from './ar.js?v=16'

// Tunables ------------------------------------------------------------------
// Every number below is read live from `GM` — the game master
// (web/config/game-master.json, loaded at boot by gamemaster.js). Spawn cadence,
// distances, wander timings, speeds, fades and the smoke effect are all retuned
// there; nothing in this file is hard-coded any more.

let smokeTexture = null
function getSmokeTexture() {
  if (smokeTexture) return smokeTexture
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(235,235,235,0.9)')
  grad.addColorStop(0.5, 'rgba(210,210,210,0.5)')
  grad.addColorStop(1, 'rgba(200,200,200,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  smokeTexture = new THREE.CanvasTexture(c)
  return smokeTexture
}

// -----------------------------------------------------------------------------
// Pokémon
// -----------------------------------------------------------------------------
export class Pokemon {
  /**
   * @param {number} dex   1..151
   * @param {{x:number,y:number,z:number}} position
   */
  constructor(dex, position) {
    this.dex = dex
    this.name = pokemonName(dex)
    this.legendary = isLegendary(dex)
    this.root = new THREE.Group()
    this.root.position.set(position.x, position.y, position.z)
    this.root.name = `pokemon-${dex}`

    this.loaded = false
    this.state = 'loading'      // loading | fade-in | idle | attack | turning | walking | captured | fleeing | breaking-out | gone
    this.phaseTimer = 0
    this.nextWanderAt = 0
    this.hiddenFor = 0
    this.opacity = 0
    this.baseY = position.y
    this.walkTarget = null
    this.mixer = null
    this.actions = {}
    this.currentAction = null
    this.cry = null
  }

  /** Load the model + clips and fade the creature into the world. */
  async spawn() {
    const {scene, animations} = await loadPokemonTemplate(this.dex)
    const model = instantiate(scene)
    enableShadows(model)
    this.root.add(model)

    this.mixer = new THREE.AnimationMixer(model)
    const clips = clipMap(animations)
    for (const name of ['attack', 'happy', 'idle', 'run', 'sleep', 'walk']) {
      if (clips[name]) {
        this.actions[name] = this.mixer.clipAction(clips[name])
      }
    }

    // A short idle before the first wander decision.
    this.play('idle')
    this.setState('fade-in', GM.pokemon.fadeInS)
    setOpacity(this.root, 0)

    if (state.scene) state.scene.add(this.root)
    this.loaded = true

    playSound(ASSET_SOUNDS.appear, {volume: 0.5})
    this.cry = playSound(cryUrl(this.dex, 2016), {volume: 0.65})
    return this
  }

  /** Advance one frame: animation, fades, wander decisions, despawn rule. */
  update(dt, time) {
    if (!this.loaded || this.state === 'gone') return
    this.mixer?.update(dt)

    switch (this.state) {
      case 'fade-in': {
        this.opacity = clamp(this.opacity + dt / GM.pokemon.fadeInS, 0, 1)
        setOpacity(this.root, this.opacity)
        if (this.opacity >= 1) this.setState('idle')
        this.scheduleNextWander(time)
        break
      }
      case 'idle': {
        if (time >= this.nextWanderAt) this.beginWander()
        break
      }
      case 'attack': {
        if (this.phaseTimer <= 0) this.startTurning(time)
        break
      }
      case 'turning': {
        const done = this.turnTick(dt, time)
        if (done) this.startWalking(time)
        break
      }
      case 'walking': {
        const arrived = this.walkTick(dt)
        if (arrived) {
          this.play('idle')
          this.setState('idle')
          this.scheduleNextWander(time)
        }
        break
      }
      case 'fleeing': {
        this.fleeTick(dt)
        if (this.phaseTimer <= 0) this.startSmoke()
        break
      }
      case 'smoke': {
        // This case returns early, so tick the timer here.
        this.phaseTimer -= dt
        this.smokeTick(dt)
        if (this.phaseTimer <= 0) this.dispose()
        return
      }
      case 'breaking-out': {
        this.opacity = clamp(this.opacity + dt / GM.pokemon.fadeInS, 0, 1)
        setOpacity(this.root, this.opacity)
        if (this.opacity >= 1) {
          this.play('idle')
          this.setState('idle')
          this.scheduleNextWander(time)
        }
        break
      }
      default:
        break
    }

    if (this.phaseTimer > 0) this.phaseTimer -= dt
    this.trackVisibility(dt)
  }

  setState(next, duration = 0) {
    this.state = next
    this.phaseTimer = duration
  }

  scheduleNextWander(time) {
    this.nextWanderAt = time + randRange(GM.pokemon.wanderMinS, GM.pokemon.wanderMaxS)
  }

  // --- animation ------------------------------------------------------------
  play(name, {once = false} = {}) {
    const action = this.actions[name]
    if (!action || action === this.currentAction) return
    action.reset()
    action.enabled = true
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity)
    action.clampWhenFinished = once
    action.weight = 1
    if (this.currentAction) this.currentAction.fadeOut(0.18)
    action.fadeIn(0.18).play()
    this.currentAction = action
  }

  // --- wander sequence ------------------------------------------------------
  beginWander() {
    // Play the attack animation once *before* choosing to move.
    this.play('attack', {once: true})
    this.setState('attack', GM.pokemon.attackHoldS)
  }

  startTurning(time) {
    const target = this.pickWalkTarget()
    if (!target) {
      // Nothing reachable — stay put and try again later.
      this.play('idle')
      this.setState('idle')
      this.scheduleNextWander(time)
      return
    }
    this.walkTarget = target
    this.setState('turning')
  }

  /** Rotate toward the target heading at a semi-slow rate. */
  turnTick(dt) {
    if (!this.walkTarget) return true
    const dx = this.walkTarget.x - this.root.position.x
    const dz = this.walkTarget.z - this.root.position.z
    const desired = Math.atan2(dx, dz)
    let delta = desired - this.root.rotation.y
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const step = GM.pokemon.turnSpeedRadS * dt
    if (Math.abs(delta) <= step) {
      this.root.rotation.y = desired
      return true
    }
    this.root.rotation.y += Math.sign(delta) * step
    return false
  }

  startWalking(time) {
    this.play('walk')
    this.setState('walking')
    this._lastCry = time
  }

  /** Move toward the target, walking animation looping (spec: not once). */
  walkTick(dt) {
    const target = this.walkTarget
    if (!target) return true
    const dx = target.x - this.root.position.x
    const dz = target.z - this.root.position.z
    const dist = Math.hypot(dx, dz)
    if (dist < GM.pokemon.walkArriveM) {
      this.root.position.x = target.x
      this.root.position.z = target.z
      return true
    }
    const step = Math.min(dist, GM.pokemon.walkSpeedMps * dt)
    this.root.position.x += (dx / dist) * step
    this.root.position.z += (dz / dist) * step
    return false
  }

  /**
   * Choose a new walk destination: a sampled surface ≥ 1 m from the player,
   * on the same surface the Pokémon is already standing on.
   */
  pickWalkTarget() {
    const here = this.root.position
    const maxStep = GM.pokemon.walkMaxStepM ?? 0.3
    const candidates = sampleSurfaces({
      minDistance: GM.pokemon.walkTargetMinM,
      maxDistance: GM.spawn.maxDistanceM + GM.pokemon.walkTargetExtraM,
      minSurfaceY: GM.pokemon.walkSurfaceMinY,
      step: GM.pokemon.walkSurfaceStepM,
      maxSamples: 20,
    })
    if (!candidates.length) return null
    // Stay on the surface we are standing on: a tabletop Pokémon must not walk
    // off the edge into thin air, and a floor Pokémon must not climb a bench.
    const onSurface = candidates.filter(
      (c) => Math.abs(c.position.y - here.y) <= maxStep,
    )
    if (!onSurface.length) return null
    // Bias toward staying near the current spot so movement looks natural.
    onSurface.sort(
      (a, b) =>
        a.position.distanceTo(here) - b.position.distanceTo(here),
    )
    const near = onSurface.slice(0, Math.max(1, Math.ceil(onSurface.length / 3)))
    const chosen = near[randInt(0, near.length - 1)]
    return {x: chosen.position.x, y: chosen.position.y, z: chosen.position.z}
  }

  // --- visibility / despawn -------------------------------------------------
  trackVisibility(dt) {
    if (this.state === 'fleeing' || this.state === 'smoke') return
    const p = this.root.position
    const visible = isPointVisible({x: p.x, y: p.y + 0.5, z: p.z})
    if (visible) {
      this.hiddenFor = 0
      return
    }
    this.hiddenFor += dt
    if (this.hiddenFor >= GM.pokemon.despawnAfterS) this.dispose()
  }

  // --- catch interactions ---------------------------------------------------
  /** Fade the model away as it is drawn into the ball. */
  async captureIntoBall() {
    this.setState('captured')
    const start = this.opacity
    const duration = GM.pokemon.captureFadeS
    const t0 = performance.now()
    await new Promise((resolve) => {
      const step = () => {
        const k = clamp((performance.now() - t0) / (duration * 1000), 0, 1)
        this.opacity = start * (1 - k)
        setOpacity(this.root, this.opacity)
        if (k < 1) requestAnimationFrame(step)
        else resolve()
      }
      step()
    })
    this.root.visible = false
  }

  /** Break out of the ball: fade back to where it was standing. */
  async breakOut() {
    this.root.visible = true
    this.setState('breaking-out')
    const t0 = performance.now()
    await new Promise((resolve) => {
      const step = () => {
        const k = clamp((performance.now() - t0) / (GM.pokemon.fadeInS * 1000), 0, 1)
        this.opacity = k
        setOpacity(this.root, k)
        if (k < 1) requestAnimationFrame(step)
        else resolve()
      }
      step()
    })
    this.play('idle')
  }

  /** Run ~3 s in a random direction along the ground, then smoke + fade. */
  flee() {
    playSound(ASSET_SOUNDS.pokemonRun, {volume: 0.6})
    const dir = randRange(0, Math.PI * 2)
    this.fleeDir = {x: Math.sin(dir), z: Math.cos(dir)}
    this.root.rotation.y = dir
    this.play('run')
    this.setState('fleeing', GM.pokemon.fleeSeconds)
  }

  fleeTick(dt) {
    if (!this.fleeDir) return
    const step = GM.pokemon.fleeSpeedMps * dt // running
    this.root.position.x += this.fleeDir.x * step
    this.root.position.z += this.fleeDir.z * step
  }

  // --- smoke disappearance --------------------------------------------------
  startSmoke() {
    this.setState('smoke', GM.pokemon.smokeSeconds) // smoke + fade
    const count = GM.pokemon.smokeCount
    const positions = new Float32Array(count * 3)
    this.smokeVel = []
    for (let i = 0; i < count; i++) {
      const a = randRange(0, Math.PI * 2)
      const r = randRange(0, 0.28)
      positions[i * 3] = Math.sin(a) * r
      positions[i * 3 + 1] = randRange(0, 0.5)
      positions[i * 3 + 2] = Math.cos(a) * r
      this.smokeVel.push({x: randRange(-0.12, 0.12), y: randRange(0.25, 0.6), z: randRange(-0.12, 0.12)})
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      map: getSmokeTexture(),
      size: GM.pokemon.smokeSizeM,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.smoke = new THREE.Points(geo, mat)
    this.smoke.frustumCulled = false
    this.root.visible = true
    this.root.add(this.smoke)
    this.play('sleep')
  }

  smokeTick(dt) {
    if (!this.smoke) return
    const pos = this.smoke.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const v = this.smokeVel[i]
      pos.setX(i, pos.getX(i) + v.x * dt)
      pos.setY(i, pos.getY(i) + v.y * dt)
      pos.setZ(i, pos.getZ(i) + v.z * dt)
    }
    pos.needsUpdate = true
    const k = 1 - clamp(this.phaseTimer / GM.pokemon.smokeSeconds, 0, 1)
    this.smoke.material.opacity = 0.85 * (1 - k)
    this.smoke.material.size = GM.pokemon.smokeSizeM + k * 0.5
    // The model itself also fades out.
    setOpacity(this.root, Math.max(0, 1 - k))
  }

  /**
   * Remove this Pokémon from the world.
   *
   * Instances are SkeletonUtils clones, so their geometry and materials are
   * shared with the cached template (and with every other Pokémon of the same
   * species). Disposing them here would corrupt those other instances, so only
   * the per-instance smoke effect is released.
   */
  dispose() {
    if (this.state === 'gone') return
    this.setState('gone')
    this.root.parent?.remove(this.root)
    this.mixer?.stopAllAction()
    if (this.smoke) {
      this.smoke.geometry?.dispose()
      this.smoke.material?.dispose()
      this.smoke = null
    }
    emit('pokemon:despawn', {pokemon: this})
  }

  /** World-space centre used for ball collision tests. */
  centre() {
    return new THREE.Vector3(
      this.root.position.x,
      this.root.position.y + this.heightM / 2,
      this.root.position.z,
    )
  }

  get heightM() {
    return this._heightM ?? 1
  }
}

// -----------------------------------------------------------------------------
// Spawner
// -----------------------------------------------------------------------------
export class Spawner {
  constructor() {
    this.lastSpawnAt = 0
    this.enabled = false
    this._timer = 0
  }

  start() {
    this.enabled = true
    this._scheduleNext()
    console.log(
      `[bt16] spawner started — Pokémon appear on their own, roughly every ${GM.spawn.intervalMs / 1000} s`,
    )
  }

  stop() {
    this.enabled = false
    clearTimeout(this._timer)
    this._timer = 0
  }

  /**
   * Queue the next spawn.
   *
   * A successful spawn waits the full (jittered) interval; a miss retries much
   * sooner, so an empty frame after one unlucky attempt resolves in seconds
   * instead of skipping the whole cycle.
   */
  _scheduleNext(retryMs = null) {
    clearTimeout(this._timer)
    let delay
    if (retryMs !== null) {
      delay = retryMs
    } else {
      const jitter = randRange(-GM.spawn.intervalJitterMs, GM.spawn.intervalJitterMs)
      delay = Math.max(GM.spawn.minIntervalMs, GM.spawn.intervalMs + jitter)
    }
    this._timer = setTimeout(() => this.tick(), delay)
  }

  /** One timer beat: try to spawn a Pokémon, then queue the next beat. */
  async tick() {
    if (!this.enabled) return
    const spawned = await this.trySpawn()
    if (this.enabled) this._scheduleNext(spawned ? null : GM.spawn.retryMs)
  }

  /** Spawn a Pokémon when the rules allow it (max alive, no open dialog). */
  async trySpawn() {
    if (state.pokemon.length >= GM.spawn.maxAlive) return false
    if (state.dialogOpen || state.inspecting) return false
    this.lastSpawnAt = performance.now()
    return !!(await this.spawnOne())
  }

  /** Choose a species and a valid surface spot, then spawn. */
  async spawnOne() {
    const position = this.findSpawnPosition()
    if (!position) {
      console.log('[bt16] no valid spawn surface found')
      return null
    }
    const dex = this.pickSpecies()
    const pokemon = new Pokemon(dex, position)
    state.pokemon.push(pokemon)
    emit('pokemon:spawn', {pokemon})
    try {
      await pokemon.spawn()
      // Record the height so ball collisions use the real bounding size.
      const box = new THREE.Box3().setFromObject(pokemon.root)
      const size = new THREE.Vector3()
      box.getSize(size)
      pokemon._heightM = Math.max(0.2, size.y)
    } catch (err) {
      console.error('[bt16] spawn failed:', err)
      pokemon.dispose()
      state.pokemon.splice(state.pokemon.indexOf(pokemon), 1)
      return null
    }
    playSound(cryUrl(dex, 2016), {volume: 0.55})
    console.log(`[bt16] spawned ${pokemon.name} (#${dex})`)
    return pokemon
  }

  /**
   * Legendaries are rare, and only catchable with the Premier Ball.
   */
  pickSpecies() {
    if (Math.random() < GM.species.legendaryChance) {
      // One of the legendaries / mythicals listed in the game master.
      const legendaries = GM.species.legendaryDex
      return legendaries[randInt(0, legendaries.length - 1)]
    }
    let dex = randInt(GM.species.dexMin, GM.species.dexMax)
    // Never spawn a legendary through the common path.
    while (isLegendary(dex)) dex = randInt(GM.species.dexMin, GM.species.dexMax)
    return dex
  }

  /**
   * A floor-ish spot 2–10 m from the player, at least `minSeparationM` from
   * every other Pokémon, biased toward ground the player is actually looking at.
   *
   * When SLAM has no surface to offer — a street, tarmac, plain concrete — it
   * falls back to a point on the smoothed ground plane in front of the camera,
   * so the world is never mysteriously empty just because the floor is
   * featureless. Returns null only when there is nowhere sensible at all.
   */
  findSpawnPosition() {
    const cam = cameraPosition()
    const forward = cameraForward()
    forward.y = 0
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1)
    forward.normalize()
    const maxCos = Math.cos((GM.spawn.preferFrontDeg ?? 75) * Math.PI / 180)

    const candidates = sampleSurfaces({
      minDistance: GM.spawn.minDistanceM,
      maxDistance: GM.spawn.maxDistanceM,
      minSurfaceY: GM.spawn.surfaceMinY,
      step: GM.spawn.surfaceStepM,
      maxSamples: GM.spawn.maxSamples,
    })

    const valid = []
    for (const c of candidates) {
      const d = cam
        ? Math.hypot(c.position.x - cam.x, c.position.z - cam.z)
        : c.distance
      if (d < GM.spawn.minDistanceM || d > GM.spawn.maxDistanceM) continue
      let blocked = false
      for (const other of state.pokemon) {
        const o = other.root.position
        if (Math.hypot(c.position.x - o.x, c.position.z - o.z) < GM.spawn.minSeparationM) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      const facing = cam
        ? ((c.position.x - cam.x) * forward.x + (c.position.z - cam.z) * forward.z) / (d || 1)
        : 1
      valid.push({c, d, facing})
    }

    if (valid.length) {
      // Prefer what the player can see; randomise within that shortlist so
      // spawns do not march in a line.
      valid.sort((a, b) => (b.facing - a.facing) || (a.d - b.d))
      const shortlist = valid.filter((v) => v.facing >= maxCos)
      const pool = shortlist.length ? shortlist : valid
      const chosen = pool[randInt(0, pool.length - 1)]
      return {x: chosen.c.position.x, y: chosen.c.position.y, z: chosen.c.position.z}
    }

    return this.fallbackSpawnPosition(forward)
  }

  /**
   * Street fallback: lay a spawn on the estimated floor somewhere in the arc
   * the player is facing, skipping any spot that crowds another Pokémon.
   */
  fallbackSpawnPosition(forward) {
    const cam = cameraPosition()
    if (!cam) return null
    const groundY = groundLevelY()
    const spread = (GM.spawn.preferFrontDeg ?? 75) * Math.PI / 180
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = randRange(-spread, spread)
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      const dirX = forward.x * cos - forward.z * sin
      const dirZ = forward.x * sin + forward.z * cos
      const d = randRange(GM.spawn.minDistanceM, GM.spawn.maxDistanceM)
      const x = cam.x + dirX * d
      const z = cam.z + dirZ * d
      let blocked = false
      for (const other of state.pokemon) {
        const o = other.root.position
        if (Math.hypot(x - o.x, z - o.z) < GM.spawn.minSeparationM) {
          blocked = true
          break
        }
      }
      if (!blocked) return {x, y: groundY, z}
    }
    return null
  }
}

/** Keep the entity list in sync when one is removed. */
export function removePokemon(pokemon) {
  const i = state.pokemon.indexOf(pokemon)
  if (i !== -1) state.pokemon.splice(i, 1)
}
