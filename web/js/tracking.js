/**
 * Advanced surface tracking.
 *
 * A pure computational-geometry module — no three.js, no engine imports — that
 * turns raw SLAM hit tests into a persistent, queryable model of the world's
 * horizontal surfaces: floors, lawns, tables, benches, steps.
 *
 * How it differs from a plain feed scan:
 *   - A fixed lattice of hit-test points is refreshed a few points per frame
 *     (round-robin), so the cost per frame is bounded no matter how many game
 *     systems ask for a spawn spot.
 *   - Every successful hit is kept, then bucketed into a 3D grid and grouped
 *     into connected planar patches, so one big surface yields distinct spots
 *     instead of a cloud of duplicates.
 *   - The lowest well-supported horizontal layer becomes the session floor, and
 *     anything above it (within a configurable band) is an elevated surface —
 *     which is how a Pokémon ends up standing on a table rather than floating
 *     over it.
 *   - Queries are answered from the model, so finding a place to spawn is a
 *     handful of array operations rather than dozens of hit tests.
 *
 * ar.js owns the engine side (feeding hit tests in) and adapts the plain
 * `{x,y,z,nx,ny,nz}` candidates back into three.js vectors.
 */

const DEFAULTS = {
  // Normalised feed lattice.
  nxMin: 0.08,
  nxMax: 0.92,
  nyMin: 0.28,
  nyMax: 0.96,
  sampleStep: 0.06,

  // Cost control. Steady state is deliberately light: the lattice is small
  // enough that even this refreshes every point several times a second.
  refreshPerFrame: 16,
  warmupMultiplier: 3,

  // World grid + plane extraction.
  gridM: 0.25,
  staleAfterS: 6,
  minNormalY: 0.7,
  minFloorCells: 3,
  minPatchCells: 2,
  floorSmooth: 0.2,

  // Elevated surfaces (tables, benches, steps).
  elevatedMinAboveM: 0.25,
  maxElevatedAboveM: 1.5,

  // Query.
  candidateStepM: 0.5,
  dedupeM: 0.25,
  maxCandidatesPerPatch: 24,
}

const TYPE_RANK = {
  DETECTED_SURFACE: 4,
  ESTIMATED_SURFACE: 3,
  UNSPECIFIED: 2,
  FEATURE_POINT: 1,
}

const DEFAULT_UP = {x: 0, y: 1, z: 0}

/** World-space up vector of a hit's plane, from its orientation quaternion. */
function planeUp(hit) {
  const q = hit?.rotation
  if (!q || typeof q.x !== 'number') return DEFAULT_UP
  const {x: qx, y: qy, z: qz, w: qw} = q
  // v' = v + 2·(q.xyz × v) + ... ; with v = (0,1,0) simplified.
  const tx = -2 * qz
  const ty = 0
  const tz = 2 * qx
  const cx = qy * tz - qz * ty
  const cy = qz * tx - qx * tz
  const cz = qx * ty - qy * tx
  return {
    x: qw * tx + cx,
    y: 1 + qw * ty + cy,
    z: qw * tz + cz,
  }
}

function normalise(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1
  return {x: v.x / l, y: v.y / l, z: v.z / l}
}

/** Pick the highest-ranked usable hit out of one hit-test result set. */
function bestHit(results) {
  let best = null
  let rank = -1
  for (const r of results) {
    if (!r || !r.position) continue
    const score = TYPE_RANK[r.type] ?? 0
    if (score > rank) {
      rank = score
      best = r
    }
  }
  return best
}

export class SurfaceTracker {
  constructor(opts = {}) {
    Object.assign(this, DEFAULTS, opts)
    this._buildLattice()
    this.reset()
  }

  /** Apply a new config (e.g. after the game master loads). */
  configure(opts = {}) {
    Object.assign(this, DEFAULTS, opts)
    this._buildLattice()
    // Keep the per-point observation store aligned with the new lattice.
    if (!this.points || this.points.length !== this.lattice.length) {
      this.points = new Array(this.lattice.length).fill(null)
      this.cursor = 0
    }
  }

  _buildLattice() {
    const pts = []
    for (let ny = this.nyMin; ny <= this.nyMax + 1e-9; ny += this.sampleStep) {
      for (let nx = this.nxMin; nx <= this.nxMax + 1e-9; nx += this.sampleStep) {
        pts.push({nx, ny})
      }
    }
    // Deterministic Fisher-Yates so the round-robin refresh sweeps the whole
    // feed instead of always starting in the same corner.
    let seed = 1337
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const t = pts[i]
      pts[i] = pts[j]
      pts[j] = t
    }
    this.lattice = pts
  }

  reset() {
    // One latest observation per lattice point (null = miss).
    this.points = new Array(this.lattice.length).fill(null)
    this.cursor = 0
    this.time = 0
    this.hitTests = 0
    this.floorY = 0
    this.hasFloor = false
    this.cells = new Map()
    this.patches = []
    this.ready = false
  }

  get samplePoints() {
    return this.lattice.length
  }

  /**
   * Refresh one frame's worth of the lattice and rebuild the model.
   * @param {number} dt seconds since the last update
   * @param {(nx:number, ny:number) => Array} sampleFn hit-test function
   */
  update(dt, sampleFn) {
    this.time += (Number.isFinite(dt) ? dt : 0)
    this.hitTests = 0
    if (!sampleFn || !this.lattice.length) return

    // Warm up faster before the first patches exist, then settle to the budget.
    const base = Math.max(1, this.refreshPerFrame | 0)
    const budget = this.ready
      ? base
      : Math.min(this.lattice.length, base * Math.max(1, this.warmupMultiplier))
    for (let k = 0; k < budget; k++) {
      const i = this.cursor
      const p = this.lattice[i]
      this.cursor = (this.cursor + 1) % this.lattice.length
      this._samplePoint(i, p.nx, p.ny, sampleFn)
    }

    this._buildModel()
  }

  _samplePoint(index, nx, ny, sampleFn) {
    this.hitTests++
    let results
    try {
      results = sampleFn(nx, ny)
    } catch {
      results = []
    }
    if (!Array.isArray(results) || !results.length) {
      this.points[index] = null
      return
    }
    const hit = bestHit(results)
    if (!hit) {
      this.points[index] = null
      return
    }
    const n = planeUp(hit)
    if (n.y < this.minNormalY) {
      this.points[index] = null // vertical face — not a place to stand
      return
    }
    const p = hit.position
    this.points[index] = {
      x: p.x, y: p.y, z: p.z,
      nx: n.x, ny: n.y, nz: n.z,
      type: hit.type || 'UNSPECIFIED',
      at: this.time,
    }
  }

  _buildModel() {
    const cells = new Map()
    const cutoff = this.time - this.staleAfterS
    const g = this.gridM

    for (let i = 0; i < this.points.length; i++) {
      const o = this.points[i]
      if (!o || o.at < cutoff) continue
      const ix = Math.round(o.x / g)
      const iy = Math.round(o.y / g)
      const iz = Math.round(o.z / g)
      const key = `${ix}:${iy}:${iz}`
      let c = cells.get(key)
      if (!c) {
        c = {
          key, ix, iy, iz, layer: iy,
          n: 0, sx: 0, sy: 0, sz: 0,
          nx: 0, ny: 0, nz: 0,
          minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
          lastAt: 0, types: {},
        }
        cells.set(key, c)
      }
      c.n++
      c.sx += o.x
      c.sy += o.y
      c.sz += o.z
      c.nx += o.nx
      c.ny += o.ny
      c.nz += o.nz
      if (o.x < c.minX) c.minX = o.x
      if (o.x > c.maxX) c.maxX = o.x
      if (o.z < c.minZ) c.minZ = o.z
      if (o.z > c.maxZ) c.maxZ = o.z
      if (o.at > c.lastAt) c.lastAt = o.at
      c.types[o.type] = (c.types[o.type] || 0) + 1
    }

    for (const c of cells.values()) {
      c.x = c.sx / c.n
      c.y = c.sy / c.n
      c.z = c.sz / c.n
      const n = normalise({x: c.nx, y: c.ny, z: c.nz})
      c.nx = n.x
      c.ny = n.y
      c.nz = n.z
      c.type = dominantType(c.types)
      // A cell always covers at least one grid square of ground.
      c.minX = Math.min(c.minX, c.x - g / 2)
      c.maxX = Math.max(c.maxX, c.x + g / 2)
      c.minZ = Math.min(c.minZ, c.z - g / 2)
      c.maxZ = Math.max(c.maxZ, c.z + g / 2)
    }

    this.cells = cells
    this._extractPatches()
    this._updateFloor()
    this.ready = this.patches.length > 0
  }

  _extractPatches() {
    const patches = []
    const byLayer = new Map()
    for (const c of this.cells.values()) {
      let layer = byLayer.get(c.layer)
      if (!layer) {
        layer = []
        byLayer.set(c.layer, layer)
      }
      layer.push(c)
    }

    for (const layer of byLayer.values()) {
      const idx = new Map()
      for (let i = 0; i < layer.length; i++) idx.set(`${layer[i].ix}:${layer[i].iz}`, i)
      const parent = layer.map((_, i) => i)
      const find = (a) => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]]
          a = parent[a]
        }
        return a
      }
      const union = (a, b) => {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent[rb] = ra
      }
      for (let i = 0; i < layer.length; i++) {
        const c = layer[i]
        const north = idx.get(`${c.ix + 1}:${c.iz}`)
        const east = idx.get(`${c.ix}:${c.iz + 1}`)
        if (north !== undefined) union(i, north)
        if (east !== undefined) union(i, east)
      }

      const groups = new Map()
      for (let i = 0; i < layer.length; i++) {
        const r = find(i)
        let g = groups.get(r)
        if (!g) {
          g = []
          groups.set(r, g)
        }
        g.push(layer[i])
      }

      for (const g of groups.values()) {
        if (g.length < this.minPatchCells) continue
        let n = 0
        let sx = 0
        let sy = 0
        let sz = 0
        let nx = 0
        let ny = 0
        let nz = 0
        let minX = Infinity
        let maxX = -Infinity
        let minZ = Infinity
        let maxZ = -Infinity
        let lastAt = 0
        const types = {}
        for (const c of g) {
          n += c.n
          sx += c.sx
          sy += c.sy
          sz += c.sz
          nx += c.nx * c.n
          ny += c.ny * c.n
          nz += c.nz * c.n
          if (c.minX < minX) minX = c.minX
          if (c.maxX > maxX) maxX = c.maxX
          if (c.minZ < minZ) minZ = c.minZ
          if (c.maxZ > maxZ) maxZ = c.maxZ
          if (c.lastAt > lastAt) lastAt = c.lastAt
          types[c.type] = (types[c.type] || 0) + c.n
        }
        const nn = normalise({x: nx, y: ny, z: nz})
        patches.push({
          x: sx / n,
          y: sy / n,
          z: sz / n,
          nx: nn.x,
          ny: nn.y,
          nz: nn.z,
          count: n,
          cells: g.length,
          minX,
          maxX,
          minZ,
          maxZ,
          lastAt,
          type: dominantType(types),
          elevated: false,
        })
      }
    }
    this.patches = patches
  }

  /**
   * The floor is the lowest horizontal layer with real support. Tables sit
   * above it; anything inside the elevated band is a standable surface too.
   */
  _updateFloor() {
    let best = null
    for (const p of this.patches) {
      if (p.ny < this.minNormalY) continue
      if (p.cells < this.minFloorCells) continue
      if (!best || p.y < best.y) best = p
    }
    if (!best) {
      this._classifyElevated()
      return
    }
    if (!this.hasFloor) {
      this.floorY = best.y
      this.hasFloor = true
    } else {
      this.floorY += (best.y - this.floorY) * this.floorSmooth
    }
    this._classifyElevated()
  }

  _classifyElevated() {
    for (const p of this.patches) {
      const above = p.y - this.floorY
      p.elevated = p.ny >= this.minNormalY &&
        above >= this.elevatedMinAboveM &&
        above <= this.maxElevatedAboveM
    }
  }

  /** Best floor height estimate (0 until the first floor patch is seen). */
  groundY() {
    return this.hasFloor ? this.floorY : 0
  }

  /**
   * Candidate standable points, answered from the model.
   *
   * @param {object} opts
   * @param {{x,y,z}|null} opts.camera
   * @param {number} [opts.minDistance] 3D metres from the camera
   * @param {number} [opts.maxDistance]
   * @param {number} [opts.minSurfaceY] minimum plane normal.y
   * @param {number} [opts.maxSamples]
   * @param {boolean} [opts.allowElevated] include tables/benches (default true)
   * @returns {Array<{x,y,z,nx,ny,nz,distance,elevated,type}>}
   */
  query({
    camera = null,
    minDistance = 0,
    maxDistance = Infinity,
    minSurfaceY = null,
    maxSamples = 30,
    step = null,
    allowElevated = true,
  } = {}) {
    const minNorm = minSurfaceY ?? this.minNormalY
    const spacing = Math.max(0.15, Math.min(step ?? this.candidateStepM, 1.5))
    const cam = camera ? {x: camera.x, y: camera.y, z: camera.z} : null
    // Spatial-hash de-dupe with a real minimum separation: a candidate is only
    // kept if no already-kept candidate lies within dedupeM of it. A plain
    // per-cell rule would let points on either side of a cell boundary sit on
    // top of each other.
    const dedupeM = this.dedupeM
    const sep2 = dedupeM * dedupeM
    const buckets = new Map()
    const bucketKey = (x, y, z) =>
      `${Math.floor(x / dedupeM)}:${Math.floor(y / dedupeM)}:${Math.floor(z / dedupeM)}`
    const tooClose = (x, y, z) => {
      const gx = Math.floor(x / dedupeM)
      const gy = Math.floor(y / dedupeM)
      const gz = Math.floor(z / dedupeM)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const b = buckets.get(`${gx + dx}:${gy + dy}:${gz + dz}`)
            if (!b) continue
            for (const p of b) {
              const ax = p[0] - x
              const ay = p[1] - y
              const az = p[2] - z
              if (ax * ax + ay * ay + az * az < sep2) return true
            }
          }
        }
      }
      return false
    }
    const keep = (x, y, z) => {
      const key = bucketKey(x, y, z)
      let b = buckets.get(key)
      if (!b) {
        b = []
        buckets.set(key, b)
      }
      b.push([x, y, z])
    }

    // Highest-confidence, most useful patches first: floor, then big elevated
    // ones, then the rest.
    const ordered = this.patches
      .filter((p) => p.ny >= minNorm)
      .filter((p) => p.y >= this.floorY - 0.3 && p.y <= this.floorY + this.maxElevatedAboveM)
      .filter((p) => allowElevated || p.y - this.floorY < this.elevatedMinAboveM)
      .sort((a, b) => {
        const ea = a.elevated ? 1 : 0
        const eb = b.elevated ? 1 : 0
        if (ea !== eb) return ea - eb
        return b.count - a.count
      })

    // Build a per-patch candidate list first so they can be interleaved: a big
    // floor must not crowd a small tabletop out of the sample budget.
    const perPatch = []
    for (const p of ordered) {
      const list = []
      const w = p.maxX - p.minX
      const d = p.maxZ - p.minZ
      const push = (x, z) => {
        if (tooClose(x, p.y, z)) return
        const distance = cam
          ? Math.hypot(x - cam.x, p.y - cam.y, z - cam.z)
          : Math.hypot(x, p.y, z)
        if (distance < minDistance || distance > maxDistance) return
        keep(x, p.y, z)
        list.push({
          x, y: p.y, z,
          nx: p.nx, ny: p.ny, nz: p.nz,
          distance,
          elevated: p.elevated,
          type: p.type,
        })
      }
      // The patch centre first, then random points across its extent so spawns
      // spread over a lawn or across a whole tabletop.
      push(p.x, p.z)
      const tries = Math.min(
        this.maxCandidatesPerPatch,
        Math.max(1, Math.round((w * d) / (spacing * spacing))),
      )
      for (let i = 0; i < tries; i++) push(p.minX + Math.random() * w, p.minZ + Math.random() * d)
      perPatch.push(list)
    }

    // Round-robin across patches until the budget is spent or they run dry.
    const out = []
    let added = true
    while (out.length < maxSamples && added) {
      added = false
      for (const list of perPatch) {
        if (out.length >= maxSamples) break
        const next = list.shift()
        if (next) {
          out.push(next)
          added = true
        }
      }
    }

    this.lastQueryCount = out.length
    return out
  }

  /** Diagnostics for the ?debug=1 HUD. */
  stats() {
    const elevated = this.patches.reduce((n, p) => n + (p.elevated ? 1 : 0), 0)
    return {
      patches: this.patches.length,
      elevated,
      cells: this.cells.size,
      points: this.points.length,
      hitTests: this.hitTests,
      floorY: this.hasFloor ? Number(this.floorY.toFixed(2)) : null,
      ready: this.ready,
    }
  }
}

function dominantType(types) {
  let best = 'UNSPECIFIED'
  let bestN = -1
  for (const k in types) {
    if (types[k] > bestN) {
      bestN = types[k]
      best = k
    }
  }
  return best
}
