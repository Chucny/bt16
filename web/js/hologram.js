/**
 * Pokémon inspection.
 *
 * A holographic copy of the Pokémon appears in the AR world, standing on the
 * SLAM floor under the mysterious light-blue light that rises from it. It idles
 * continuously; tapping it plays the attack animation once. Closing it fades
 * the hologram away and plays ui_back.mp3.
 */
import * as THREE from 'three'

import {state, emit, setOpacity, playSound, ASSET_SOUNDS, clamp} from './core.js?v=16'
import {pokemonName, cryUrl} from './data.js?v=16'
import {loadPokemonTemplate, instantiate, clipMap} from './gltf.js?v=16'
import {cameraForward, cameraPosition, setHologram, setHologramTarget} from './ar.js?v=16'

export class Hologram {
  constructor() {
    this.root = null
    this.mixer = null
    this.actions = {}
    this.current = null
    this.dex = null
    this.fade = 0
    this.fadeTarget = 0
    this.pinned = false
  }

  get active() {
    return this.root !== null
  }

  /**
   * Show the hologram for a dex entry.
   * @param {number} dex
   */
  async show(dex) {
    // Replace any previous hologram outright (hide() would only start a fade,
    // and the old root would then be orphaned mid-fade).
    if (this.root) this.dispose()

    const {scene, animations} = await loadPokemonTemplate(dex)
    const model = instantiate(scene)
    this.makeHolographic(model)

    const root = new THREE.Group()
    root.add(model)
    root.name = `hologram-${dex}`

    // Stand it on the floor, roughly 1.6 m in front of the player.
    const cam = cameraPosition() ?? {x: 0, y: 1.6, z: 0}
    const forward = cameraForward()
    const floorY = cam.y - 1.6
    const pos = {
      x: cam.x + forward.x * 1.6,
      y: floorY,
      z: cam.z + forward.z * 1.6,
    }
    root.position.set(pos.x, pos.y, pos.z)
    root.rotation.y = Math.atan2(cam.x - pos.x, cam.z - pos.z)

    this.mixer = new THREE.AnimationMixer(model)
    const clips = clipMap(animations)
    for (const name of ['attack', 'happy', 'idle', 'run', 'sleep', 'walk']) {
      if (clips[name]) this.actions[name] = this.mixer.clipAction(clips[name])
    }
    this.play('idle')

    state.scene?.add(root)
    this.root = root
    this.dex = dex

    // Blue light from the SLAM floor.
    setHologramTarget({x: pos.x, y: pos.y, z: pos.z})
    setHologram(true, {x: pos.x, y: pos.y, z: pos.z})

    // Fade in.
    setOpacity(root, 0)
    this.fade = 0
    this.fadeTarget = 1

    state.inspecting = {dex, name: pokemonName(dex)}
    playSound(cryUrl(dex, 2016), {volume: 0.5})
    emit('inspection:open', {dex})
    return this
  }

  /** Clone every material into a translucent, blue-lit "glass" look. */
  makeHolographic(object) {
    object.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      const ghost = mats.map((m) => {
        if (!m) return m
        const c = m.clone()
        c.transparent = true
        c.opacity = 0.72
        c.depthWrite = false
        if (c.color) c.color.lerp(new THREE.Color(0x7fe0ff), 0.35)
        if ('emissive' in c) {
          c.emissive = new THREE.Color(0x1d5f86)
          c.emissiveIntensity = 1.1
        }
        return c
      })
      node.material = Array.isArray(node.material) ? ghost : ghost[0]
      node.renderOrder = 10
      node.castShadow = false
      node.receiveShadow = false
    })
  }

  play(name, {once = false} = {}) {
    const action = this.actions[name]
    if (!action || action === this.current) return
    action.reset()
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity)
    action.clampWhenFinished = once
    if (this.current) this.current.fadeOut(0.15)
    action.fadeIn(0.15).play()
    this.current = action
  }

  /** Tap handler: does the attack animation once, then returns to idle. */
  attack() {
    if (!this.actions.attack) return
    this.play('attack', {once: true})
    setTimeout(() => this.play('idle'), 900)
  }

  update(dt) {
    if (!this.root) return
    this.mixer?.update(dt)

    // Ease the fade toward its target.
    if (this.fade !== this.fadeTarget) {
      const step = dt / 0.5
      this.fade = this.fadeTarget > this.fade
        ? Math.min(this.fadeTarget, this.fade + step)
        : Math.max(this.fadeTarget, this.fade - step)
      setOpacity(this.root, clamp(this.fade, 0, 1))
      if (this.fade <= 0.001 && this.fadeTarget === 0) this.dispose()
    }

    // Keep the light under the Pokémon.
    if (this.root) {
      const p = this.root.position
      setHologramTarget({x: p.x, y: p.y, z: p.z})
    }
  }

  /** Close the inspection: fade out, hide the light, play ui_back.mp3. */
  async hide({silent = false} = {}) {
    if (!this.root) {
      state.inspecting = null
      return
    }
    this.fadeTarget = 0
    setHologram(false)
    if (!silent) playSound(ASSET_SOUNDS.uiBack, {volume: 0.8})
    state.inspecting = null
    emit('inspection:close', {dex: this.dex})
    // Let update() finish the fade + dispose, but resolve immediately.
  }

  dispose() {
    if (!this.root) return
    this.root.parent?.remove(this.root)
    this.root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return
      // Geometry is shared with the cached template — never dispose it. The
      // materials, however, were cloned per-hologram by makeHolographic().
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      for (const m of mats) m?.dispose()
    })
    this.mixer?.stopAllAction()
    this.root = null
    this.mixer = null
    this.actions = {}
    this.current = null
    this.dex = null
    setHologram(false)
  }

  /** Raycast a screen point against the hologram (for tap-to-attack). */
  hitTestScreen(clientX, clientY) {
    if (!this.root || !state.camera) return false
    const rect = state.canvas?.getBoundingClientRect()
    if (!rect) return false
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, state.camera)
    return raycaster.intersectObject(this.root, true).length > 0
  }
}
