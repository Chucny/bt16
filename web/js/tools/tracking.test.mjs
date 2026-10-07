/**
 * Headless test for the advanced surface tracker (web/js/tracking.js).
 *
 * tracking.js is dependency-free by design, so this runs it directly in Node
 * with a stubbed 6DoF camera and a synthetic world: an infinite floor at y = 0
 * and a tabletop at y = 0.75 in front of the camera. No browser, no engine.
 *
 *   node web/js/tools/tracking.test.mjs
 */
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const here = new URL('.', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('../tracking.js', here)), 'utf8')
const {SurfaceTracker} = await import(
  'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
)

// -----------------------------------------------------------------------------
// Tiny assertion helpers
// -----------------------------------------------------------------------------
let failed = 0
let passed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  [ok  ] ${name}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`)
  }
}
const approx = (a, b, eps) => Math.abs(a - b) <= eps

// -----------------------------------------------------------------------------
// Synthetic world: floor + a tabletop, seen by a pinhole camera
// -----------------------------------------------------------------------------
const CAM = {x: 0, y: 1.6, z: 0}
const FOV = (60 * Math.PI) / 180
const ASPECT = 1.5
const TAN_HALF = Math.tan(FOV / 2)

const FLOOR = {y: 0, minX: null, maxX: null, minZ: null, maxZ: null}
const TABLE = {y: 0.75, minX: -0.6, maxX: 0.6, minZ: -3.6, maxZ: -2.4}
const SURFACES = [FLOOR, TABLE]

let hitTestCalls = 0

function makeHitTest(surfaces, {count = false} = {}) {
  return (nx, ny) => {
    if (count) hitTestCalls++
    const xNdc = nx * 2 - 1
    const yNdc = 1 - ny * 2
    const dx = xNdc * TAN_HALF * ASPECT
    const dy = yNdc * TAN_HALF
    const dz = -1
    if (dy >= -1e-6) return [] // looking at or above the horizon
    let best = null
    for (const s of surfaces) {
      const k = (s.y - CAM.y) / dy
      if (k <= 0) continue
      const x = CAM.x + dx * k
      const z = CAM.z + dz * k
      if (s.minX !== null && (x < s.minX || x > s.maxX)) continue
      if (s.minZ !== null && (z < s.minZ || z > s.maxZ)) continue
      if (!best || k < best.k) best = {k, x, y: s.y, z}
    }
    if (!best) return []
    return [{
      type: 'DETECTED_SURFACE',
      position: {x: best.x, y: best.y, z: best.z},
      rotation: {x: 0, y: 0, z: 0, w: 1},
    }]
  }
}

function run(tracker, frames, sampleFn) {
  for (let i = 0; i < frames; i++) tracker.update(1 / 60, sampleFn)
}

function minPairDistance(list) {
  let min = Infinity
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y, list[i].z - list[j].z)
      if (d < min) min = d
    }
  }
  return min
}

// -----------------------------------------------------------------------------
// 1. Build the model from the floor + table world
// -----------------------------------------------------------------------------
console.log('surface model')
const tracker = new SurfaceTracker({sampleStep: 0.06, refreshPerFrame: 30, warmupMultiplier: 2})
run(tracker, 150, makeHitTest(SURFACES))

check('the tracker becomes ready', tracker.ready === true)
check('a floor is found', tracker.hasFloor === true)
check('floor height is tracked (~0 m)', approx(tracker.groundY(), 0, 0.12), `floorY=${tracker.groundY().toFixed(3)}`)

const stats = tracker.stats()
check('patches were extracted', stats.patches >= 2, JSON.stringify(stats))
check('raised surfaces were classified', stats.elevated >= 1, JSON.stringify(stats))

// -----------------------------------------------------------------------------
// 2. Query returns standable points on both the floor and the table
// -----------------------------------------------------------------------------
console.log('candidate query')
const cam = CAM
const cands = tracker.query({
  camera: cam,
  minDistance: 1,
  maxDistance: 9,
  minSurfaceY: 0.55,
  maxSamples: 40,
})

check('query returns candidates', cands.length > 0, `n=${cands.length}`)
const floorCands = cands.filter((c) => approx(c.y, 0, 0.1))
const tableCands = cands.filter((c) => approx(c.y, 0.75, 0.12) && c.elevated)
check('candidates include the floor', floorCands.length > 0, `floor=${floorCands.length}`)
check('candidates include the tabletop', tableCands.length > 0, `table=${tableCands.length}`)
check('the table is not merged into the floor', tableCands.every((c) => Math.abs(c.y - 0) > 0.4))
check(
  'every candidate respects the distance window',
  cands.every((c) => c.distance >= 1 - 1e-6 && c.distance <= 9 + 1e-6),
  cands.map((c) => c.distance.toFixed(2)).join(','),
)
check(
  'candidates are de-duplicated',
  minPairDistance(cands) > 0.1,
  `minPair=${minPairDistance(cands).toFixed(3)}`,
)

const limited = tracker.query({camera: cam, minDistance: 0, maxDistance: 2})
check('a range with no surface returns nothing (way for callers to fall back)', limited.length === 0, `n=${limited.length}`)

const noElevated = tracker.query({
  camera: cam,
  minDistance: 1,
  maxDistance: 9,
  allowElevated: false,
  maxSamples: 40,
})
check('allowElevated:false drops the table', noElevated.every((c) => !c.elevated && approx(c.y, 0, 0.1)))

// -----------------------------------------------------------------------------
// 3. The per-frame sampling budget is respected (the "faster" part)
// -----------------------------------------------------------------------------
console.log('sampling budget')
hitTestCalls = 0
const budgetTracker = new SurfaceTracker({refreshPerFrame: 30})
const counted = makeHitTest(SURFACES, {count: true})
run(budgetTracker, 200, counted)
hitTestCalls = 0
budgetTracker.update(1 / 60, counted)
check(
  'a warm frame costs no more than refreshPerFrame hit tests',
  hitTestCalls <= 30,
  `hits=${hitTestCalls}`,
)

// Cold-start warm-up may spend more, but never more than the warmup multiplier.
const cold = new SurfaceTracker({refreshPerFrame: 30, warmupMultiplier: 2})
hitTestCalls = 0
cold.update(1 / 60, counted)
check('a cold frame stays within the warm-up budget', hitTestCalls <= 60, `hits=${hitTestCalls}`)

// A query itself costs no hit tests at all.
hitTestCalls = 0
budgetTracker.query({camera: cam, minDistance: 1, maxDistance: 9, maxSamples: 40})
check('a query performs zero hit tests', hitTestCalls === 0)

// -----------------------------------------------------------------------------
// 4. Featureless ground: no data, no crash, no bogus candidates
// -----------------------------------------------------------------------------
console.log('featureless ground')
const blank = new SurfaceTracker()
const noHit = () => []
run(blank, 90, noHit)
check('a featureless world stays not-ready', blank.ready === false)
check('a featureless world has no floor', blank.hasFloor === false)
check('a featureless world yields no candidates', blank.query({camera: cam}).length === 0)
check('floor height defaults to 0 when unknown', blank.groundY() === 0)

// -----------------------------------------------------------------------------
// 5. Vertical faces are not standable surfaces
// -----------------------------------------------------------------------------
console.log('vertical faces')
const wall = new SurfaceTracker()
const wallHit = () => [{
  type: 'DETECTED_SURFACE',
  position: {x: 0, y: 1, z: -2},
  // 90° about X: up vector points along +Z (a wall), not up.
  rotation: {x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2},
}]
run(wall, 60, wallHit)
check('a wall alone produces no standable patches', wall.query({camera: cam}).length === 0)

// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
