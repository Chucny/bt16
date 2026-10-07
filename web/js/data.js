/**
 * Static game data: the Gen 1 Pokédex, item (ball) definitions and every
 * asset URL helper.
 *
 * The asset tree lives at /assets — see the repository README for the layout.
 */

// -----------------------------------------------------------------------------
// Gen 1 Pokédex — 151 entries
// -----------------------------------------------------------------------------
export const GEN1_NAMES = [
  'Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander', 'Charmeleon', 'Charizard',
  'Squirtle', 'Wartortle', 'Blastoise', 'Caterpie', 'Metapod', 'Butterfree',
  'Weedle', 'Kakuna', 'Beedrill', 'Pidgey', 'Pidgeotto', 'Pidgeot',
  'Rattata', 'Raticate', 'Spearow', 'Fearow', 'Ekans', 'Arbok',
  'Pikachu', 'Raichu', 'Sandshrew', 'Sandslash', 'Nidoran♀', 'Nidorina',
  'Nidoqueen', 'Nidoran♂', 'Nidorino', 'Nidoking', 'Clefairy', 'Clefable',
  'Vulpix', 'Ninetales', 'Jigglypuff', 'Wigglytuff', 'Zubat', 'Golbat',
  'Oddish', 'Gloom', 'Vileplume', 'Paras', 'Parasect', 'Venonat',
  'Venomoth', 'Diglett', 'Dugtrio', 'Meowth', 'Persian', 'Psyduck',
  'Golduck', 'Mankey', 'Primeape', 'Growlithe', 'Arcanine', 'Poliwag',
  'Poliwhirl', 'Poliwrath', 'Abra', 'Kadabra', 'Alakazam', 'Machop',
  'Machoke', 'Machamp', 'Bellsprout', 'Weepinbell', 'Victreebel', 'Tentacool',
  'Tentacruel', 'Geodude', 'Graveler', 'Golem', 'Ponyta', 'Rapidash',
  'Slowpoke', 'Slowbro', 'Magnemite', 'Magneton', "Farfetch'd", 'Doduo',
  'Dodrio', 'Seel', 'Dewgong', 'Grimer', 'Muk', 'Shellder',
  'Cloyster', 'Gastly', 'Haunter', 'Gengar', 'Onix', 'Drowzee',
  'Hypno', 'Krabby', 'Kingler', 'Voltorb', 'Electrode', 'Exeggcute',
  'Exeggutor', 'Cubone', 'Marowak', 'Hitmonlee', 'Hitmonchan', 'Lickitung',
  'Koffing', 'Weezing', 'Rhyhorn', 'Rhydon', 'Chansey', 'Tangela',
  'Kangaskhan', 'Horsea', 'Seadra', 'Goldeen', 'Seaking', 'Staryu',
  'Starmie', 'Mr. Mime', 'Scyther', 'Jynx', 'Electabuzz', 'Magmar',
  'Pinsir', 'Tauros', 'Magikarp', 'Gyarados', 'Lapras', 'Ditto',
  'Eevee', 'Vaporeon', 'Jolteon', 'Flareon', 'Porygon', 'Omanyte',
  'Omastar', 'Kabuto', 'Kabutops', 'Aerodactyl', 'Snorlax', 'Articuno',
  'Zapdos', 'Moltres', 'Dratini', 'Dragonair', 'Dragonite', 'Mewtwo', 'Mew',
]

export const GEN1_COUNT = GEN1_NAMES.length // 151

/**
 * Maximum Pokémon the storage screen will hold.
 *
 * Storage is per creature, not per species, so the same Pokémon can be caught
 * more than once — exactly like Pokémon GO. The Pokédex, by contrast, still has
 * one entry per species (`GEN1_COUNT`).
 */
export const STORAGE_LIMIT = 600

/**
 * Coerce a stored inventory into the `{id: entry}` shape the game expects.
 *
 * Older saves keyed the map by dex number, which allowed only one Pokémon per
 * species. They migrate transparently: each entry gains a `dex` field and keeps
 * its old key as its id. New catches use `dex-<time>-<rand>` keys, so duplicate
 * species are stored as separate Pokémon.
 * @param {object|null|undefined} raw
 * @returns {Record<string, object>}
 */
export function normaliseInventory(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    const dex = Number(entry.dex ?? entry.pokedex_entry ?? key)
    if (!Number.isInteger(dex) || dex < 1) continue
    out[String(entry.id ?? key)] = {...entry, dex, pokedex_entry: dex}
  }
  return out
}

/**
 * Caught Pokémon as a stable list of `{id, dex, entry}`, in dex order and then
 * by catch time. The storage grid and its header count both read from this.
 */
export function inventoryEntries(inventory) {
  return Object.entries(inventory ?? {})
    .map(([id, entry]) => ({
      id,
      dex: Number(entry.dex ?? entry.pokedex_entry ?? id),
      entry,
    }))
    .filter((e) => Number.isInteger(e.dex) && e.dex >= 1)
    .sort((a, b) => a.dex - b.dex || (a.entry.caughtDate ?? 0) - (b.entry.caughtDate ?? 0))
}

/** Legendary / mythical Pokémon — catchable only with the Premier Ball. */
export const LEGENDARY_DEX = new Set([144, 145, 146, 150, 151])

export function isLegendary(dex) {
  return LEGENDARY_DEX.has(Number(dex))
}

/** Display name for a dex number (1..151). */
export function pokemonName(dex) {
  return GEN1_NAMES[Number(dex) - 1] ?? `#${dex}`
}

// -----------------------------------------------------------------------------
// Types (primary/secondary) — all 151 of Gen 1, in dex order
// -----------------------------------------------------------------------------
const GEN1_TYPES = [
  'grass/poison', 'grass/poison', 'grass/poison', 'fire', 'fire', 'fire/flying',
  'water', 'water', 'water', 'bug', 'bug', 'bug/flying',
  'bug/poison', 'bug/poison', 'bug/poison', 'normal/flying', 'normal/flying', 'normal/flying',
  'normal', 'normal', 'normal/flying', 'normal/flying', 'poison', 'poison',
  'electric', 'electric', 'ground', 'ground', 'poison', 'poison',
  'poison/ground', 'poison', 'poison', 'poison/ground', 'fairy', 'fairy',
  'fire', 'fire', 'normal/fairy', 'normal/fairy', 'poison/flying', 'poison/flying',
  'grass/poison', 'grass/poison', 'grass/poison', 'bug/grass', 'bug/grass', 'bug/poison',
  'bug/poison', 'ground', 'ground', 'normal', 'normal', 'water',
  'water', 'fighting', 'fighting', 'fire', 'fire', 'water',
  'water', 'water/fighting', 'psychic', 'psychic', 'psychic', 'fighting',
  'fighting', 'fighting', 'grass/poison', 'grass/poison', 'grass/poison', 'water/poison',
  'water/poison', 'rock/ground', 'rock/ground', 'rock/ground', 'fire', 'fire',
  'water/psychic', 'water/psychic', 'electric/steel', 'electric/steel', 'normal/flying', 'normal/flying',
  'normal/flying', 'water', 'water/ice', 'poison', 'poison', 'water',
  'water/ice', 'ghost/poison', 'ghost/poison', 'ghost/poison', 'rock/ground', 'psychic',
  'psychic', 'water', 'water', 'electric', 'electric', 'grass/psychic',
  'grass/psychic', 'ground', 'ground', 'fighting', 'fighting', 'normal',
  'poison', 'poison', 'ground/rock', 'ground/rock', 'normal', 'grass',
  'normal', 'water', 'water', 'water', 'water', 'water',
  'water/psychic', 'psychic/fairy', 'bug/flying', 'ice/psychic', 'electric', 'fire',
  'bug', 'normal', 'water', 'water/flying', 'water/ice', 'normal',
  'normal', 'water', 'electric', 'fire', 'normal', 'rock/water',
  'rock/water', 'rock/water', 'rock/water', 'rock/flying', 'normal', 'ice/flying',
  'electric/flying', 'fire/flying', 'dragon', 'dragon', 'dragon/flying', 'psychic',
  'psychic',
]

const KNOWN_TYPES = new Set([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison',
  'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'steel',
  'fairy', 'dark',
])

/** Standard type colours, used for the storage cards and type chips. */
export const TYPE_COLORS = {
  normal: '#a8a77a', fire: '#ee8130', water: '#6390f0', electric: '#f7d02c',
  grass: '#7ac74c', ice: '#96d9d6', fighting: '#c22e28', poison: '#a33ea1',
  ground: '#e2bf65', flying: '#a98ff3', psychic: '#f95587', bug: '#a6b91a',
  rock: '#b6a136', ghost: '#735797', dragon: '#6f35fc', steel: '#b7b7ce',
  fairy: '#d685ad', dark: '#705746', default: '#8d8d8d',
}

export function typeColor(type) {
  return TYPE_COLORS[type] ?? TYPE_COLORS.default
}

/** Human label for a type id, e.g. 'fire' -> 'Fire'. */
export function typeLabel(type) {
  return String(type).charAt(0).toUpperCase() + String(type).slice(1)
}

/** Types for a dex number, e.g. ['grass', 'poison']. */
export function pokemonTypes(dex) {
  return (GEN1_TYPES[Number(dex) - 1] ?? 'normal').split('/')
}

/** Type background image (used behind the type label). */
export function typeBackgroundUrl(type) {
  const known = KNOWN_TYPES.has(type) ? type : 'default'
  return `/assets/pokemon-go/important-icons/pokemon-types/details_type_bg_${known}.png`
}

// -----------------------------------------------------------------------------
// Asset URL helpers
// -----------------------------------------------------------------------------
export function modelUrl(dex) {
  return `/assets/pokemon/models/glb/gen1/${String(dex).padStart(3, '0')}.glb`
}

export function iconUrl(dex) {
  return `/assets/pokemon/icons/png/gen1/${Number(dex)}.png`
}

/**
 * Cry. 2016 are the modern (GO-era) cries, 1996 the originals.
 * @param {number} dex
 * @param {1996|2016} [year]
 */
export function cryUrl(dex, year = 2016) {
  return `/assets/pokemon/cries/${year}/${String(dex).padStart(3, '0')}.mp3`
}

// -----------------------------------------------------------------------------
// PokéStops and Gyms
// -----------------------------------------------------------------------------
// Only the NEEDED_MAP_OBJECTS slice of the Pokémon GO asset dump is used.
// Cartridge GLBs are normalised at load time, so their authored scale (≈8 units
// tall) does not matter here.
export function pokestopModelUrl(kind = 'open') {
  return `/assets/pokemon-go/NEEDED_MAP_OBJECTS/pokestop-${kind === 'closed' ? 'closed' : 'open'}.glb`
}

// -----------------------------------------------------------------------------
// Items (Poké Balls)
// -----------------------------------------------------------------------------
export const BALLS = [
  {
    id: 'poke',
    name: 'Poké Ball',
    model: '/assets/items/models/poke-ball.glb',
    icon: '/assets/items/icons/png/poke-ball.png',
    legendaryOnly: false,
  },
  {
    id: 'great',
    name: 'Great Ball',
    model: '/assets/items/models/great-ball.glb',
    icon: '/assets/items/icons/png/great-ball.png',
    legendaryOnly: false,
  },
  {
    id: 'ultra',
    name: 'Ultra Ball',
    model: '/assets/items/models/ultra-ball.glb',
    icon: '/assets/items/icons/png/ultra-ball.png',
    legendaryOnly: false,
  },
  {
    id: 'premier',
    name: 'Premier Ball',
    model: '/assets/items/models/premier-ball.glb',
    icon: '/assets/items/icons/png/premier-ball.png',
    legendaryOnly: true,
  },
]

export function getBall(id) {
  return BALLS.find((b) => b.id === id) ?? BALLS[0]
}

// The real-world ball diameter (22 cm) lives in the game master as
// `ball.diameterM` — see web/config/game-master.json and gamemaster.js.

// -----------------------------------------------------------------------------
// UI icons (Pokémon GO important-icons)
// -----------------------------------------------------------------------------
const ICONS = '/assets/pokemon-go/important-icons/menu'
export const UI_ICONS = {
  actionMenu: `${ICONS}/btn_action_menu.png`,
  pokedex: `${ICONS}/btn_pokedex.png`,
  pokemon: `${ICONS}/btn_pokemon.png`,
  camera: `${ICONS}/btn_camera_dark.png`,
  cameraCircle: `${ICONS}/btn_camera_circle.png`,
  close: `${ICONS}/btn_close_normal_dark.png`,
  closeLight: `${ICONS}/btn_close_normal_dark.png`,
  exit: `${ICONS}/btn_exit.png`,
  runAway: `${ICONS}/btn_run_away.png`,
  items: `${ICONS}/btn_items_encounter.png`,
  challenge: `${ICONS}/btn_challenge.png`,
  candy: `${ICONS}/ic_candy.png`,
  action: `${ICONS}/ic_action.png`,
  footprints: `${ICONS}/ic_footprints.png`,
  arOn: `${ICONS}/ui_enc_ar_on.png`,
  arOff: `${ICONS}/ui_enc_ar_off.png`,
}

export const LOADING_SCREEN = '/assets/pokemon-go/LOADING_SCREEN.webp'
export const TITLE_SOUND = '/assets/pokemon-go/TITLE_SCREEN.mp3'
