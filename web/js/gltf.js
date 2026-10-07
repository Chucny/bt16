/**
 * GLB loading.
 *
 * 8th Wall's `XR8.Threejs` has no glTF loader, so we use three's. `window.THREE`
 * is set to this same three instance in main.js, which is what the engine
 * renders with — one copy of three for the whole app.
 *
 * A "template" is a pre-fitted Object3D kept in the cache; each spawn is a
 * SkeletonUtils clone of it (correct for skinned meshes).
 */
import * as THREE from 'three'
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js'

import {modelUrl, getBall, pokestopModelUrl} from './data.js?v=16'
import {GM} from './gamemaster.js?v=16'

const loader = new GLTFLoader()
const cache = new Map() // url -> Promise<gltf>
// Fitted templates, keyed by model identity. Fitting mutates the scene's
// transform, so it must happen exactly once per model, not once per spawn.
const templates = new Map()

/** Fetch + parse a GLB (cached by URL; failures are not cached). */
export function loadGLTF(url) {
  if (cache.has(url)) return cache.get(url)
  const promise = new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      (err) => reject(new Error(`Failed to load ${url}: ${err?.message || err}`)),
    )
  })
  promise.catch(() => cache.delete(url))
  cache.set(url, promise)
  return promise
}

/**
 * Load a Pokémon template and remember its animation clips.
 *
 * The model keeps its authored scale (spec: "Pokémon sizes are their default
 * sizes in the GLB models"); we only re-seat it so the feet sit at y = 0.
 *
 * @param {number} dex
 * @returns {Promise<{scene: THREE.Object3D, animations: THREE.AnimationClip[], heightM: number}>}
 */
export function loadPokemonTemplate(dex) {
  const key = `pokemon:${dex}`
  if (templates.has(key)) return templates.get(key)
  const promise = (async () => {
    const gltf = await loadGLTF(modelUrl(dex))
    const scene = gltf.scene
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(scene)
    const size = new THREE.Vector3()
    const centre = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(centre)

    // Seat on the ground and centre horizontally without touching scale.
    scene.position.x -= centre.x
    scene.position.z -= centre.z
    scene.position.y -= box.min.y
    scene.updateMatrixWorld(true)

    return {scene, animations: gltf.animations ?? [], heightM: size.y}
  })()
  promise.catch(() => templates.delete(key))
  templates.set(key, promise)
  return promise
}

/**
 * Load a ball template, scaled to the real-world 22 cm diameter.
 * @param {string} id  one of data.js BALLS ids
 */
export function loadBallTemplate(id) {
  const key = `ball:${id}`
  if (templates.has(key)) return templates.get(key)
  const promise = (async () => {
    const ball = getBall(id)
    const gltf = await loadGLTF(ball.model)
    const scene = gltf.scene
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(scene)
    const size = new THREE.Vector3()
    const centre = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(centre)

    const diameterM = GM.ball.diameterM // real-world ball size, from the game master
    const scale = size.y > 1e-6 ? diameterM / size.y : 1
    const wrapper = new THREE.Group()
    wrapper.add(scene)
    scene.position.set(-centre.x, -centre.y, -centre.z) // centre at the origin
    wrapper.scale.setScalar(scale)
    wrapper.userData.radius = diameterM / 2
    wrapper.updateMatrixWorld(true)
    return {scene: wrapper, animations: gltf.animations ?? [], radiusM: diameterM / 2}
  })()
  promise.catch(() => templates.delete(key))
  templates.set(key, promise)
  return promise
}

/**
 * Load a PokéStop template, normalised to `GM.pokestops.heightM` metres tall
 * with its base on y = 0.
 *
 * The cartridges are authored ~8 units tall, so every instance is scaled and
 * re-seated here. The "closed" stop is tinted purple because the source GLB is
 * authored in the same blue as the open one.
 *
 * @param {'open'|'closed'} kind
 */
export function loadPokestopTemplate(kind) {
  const key = `pokestop:${kind}`
  if (templates.has(key)) return templates.get(key)
  const promise = (async () => {
    const gltf = await loadGLTF(pokestopModelUrl(kind))
    const scene = gltf.scene
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(scene)
    const size = new THREE.Vector3()
    const centre = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(centre)

    const heightM = GM.pokestops.heightM
    const scale = size.y > 1e-6 ? heightM / size.y : 1

    const wrapper = new THREE.Group()
    wrapper.add(scene)
    // Centre horizontally, seat the base on y = 0, then scale the whole rig.
    scene.position.set(-centre.x, -box.min.y, -centre.z)
    wrapper.scale.setScalar(scale)

    tintProp(wrapper, kind === 'closed')
    wrapper.updateMatrixWorld(true)
    return {scene: wrapper, animations: gltf.animations ?? [], heightM}
  })()
  promise.catch(() => templates.delete(key))
  templates.set(key, promise)
  return promise
}

/**
 * Give a prop its own materials so it can be tinted without touching the cache.
 * Open stops keep their blue with a soft glow; closed stops go purple.
 * @param {THREE.Object3D} root
 * @param {boolean} purple
 */
function tintProp(root, purple) {
  const tint = new THREE.Color(purple ? 0x9b5cff : 0x2f9bff)
  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return
    const swap = (m) => {
      const c = m.clone()
      if (c.color) c.color.copy(tint)
      if ('emissive' in c) {
        c.emissive = new THREE.Color(purple ? 0x6a1bb5 : 0x1d6fa8)
        c.emissiveIntensity = purple ? 0.9 : 0.6
      }
      return c
    }
    node.material = Array.isArray(node.material)
      ? node.material.map(swap)
      : swap(node.material)
  })
}

/** Deep clone a template, keeping skinned meshes intact. */
export function instantiate(template) {
  return cloneSkeleton(template)
}

/** Enable shadow casting/receiving on every mesh under an object. */
export function enableShadows(object, {cast = true, receive = true} = {}) {
  object.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return
    node.castShadow = cast
    node.receiveShadow = receive
    node.frustumCulled = false
    if (node.material) node.material.envMapIntensity = 1
  })
}

/** Turn a list of animation clips into a name -> clip map. */
export function clipMap(animations) {
  const map = {}
  for (const clip of animations) map[clip.name] = clip
  return map
}
