/**
 * DOM UI.
 *
 * The 8th Wall camera path draws to a canvas, so the UI is ordinary HTML laid
 * over it. Everything here is one-way: UI -> actions, plus explicit render
 * calls when game state changes.
 */
import {state, emit, playSound, ASSET_SOUNDS} from './core.js?v=16'
import {GM} from './gamemaster.js?v=16'
import {
  BALLS, getBall, pokemonName, iconUrl, GEN1_COUNT,
  STORAGE_LIMIT, inventoryEntries,
  pokemonTypes, typeBackgroundUrl, typeLabel, typeColor,
} from './data.js?v=16'

const $ = (id) => document.getElementById(id)
const ACTIONS = {}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------
export function initUi(actions) {
  Object.assign(ACTIONS, actions)
  wireHud()
  wireOverlays()
}

function wireHud() {
  $('btn-inventory')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.clickOk)
    ACTIONS.openInventory?.()
  })
  $('btn-pokedex')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.clickOk)
    ACTIONS.openPokedex?.()
  })
  $('btn-snapshot')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.select)
    ACTIONS.snapshot?.()
  })
  $('btn-item-switch')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.select)
    ACTIONS.openItemMenu?.()
  })
  $('inventory-search')?.addEventListener('input', (e) => renderInventory(e.target.value))
}

function wireOverlays() {
  // Every [data-close] closes its overlay.
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      playSound(ASSET_SOUNDS.uiBack)
      closeAllOverlays()
    })
  }

  $('item-menu-close')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.uiBack)
    closeAllOverlays()
  })

  // The outdoor tutorial has no X — its one big OK button is the only exit.
  $('tutorial-ok')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.clickOk)
    hideTutorial()
  })
  $('inspection-close')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.uiBack)
    ACTIONS.closeInspection?.()
  })
  $('inspection-rename-save')?.addEventListener('click', () => {
    const input = $('inspection-nickname')
    if (!input) return
    playSound(ASSET_SOUNDS.clickOk)
    ACTIONS.renameInspection?.(input.value.trim())
  })
  $('inspection-transfer')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.select)
    ACTIONS.requestTransfer?.()
  })
  $('transfer-confirm-cancel')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.uiBack)
    closeTransferConfirm()
  })
  $('transfer-confirm-go')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.select)
    closeTransferConfirm()
    ACTIONS.confirmTransfer?.()
  })
  $('snapshot-close')?.addEventListener('click', () => {
    playSound(ASSET_SOUNDS.uiBack)
    $('snapshot')?.setAttribute('hidden', '')
    state.dialogOpen = isAnyOverlayOpen()
  })

  // The trash bin is coded but deliberately not used (spec).
  $('item-trash')?.setAttribute('hidden', '')
}

export function setActions(actions) {
  Object.assign(ACTIONS, actions)
}

// -----------------------------------------------------------------------------
// Splash
// -----------------------------------------------------------------------------
/** Show the 4-second bt16 splash. Resolves when it has finished. */
export function showSplash(seconds = 4) {
  const splash = $('splash')
  if (!splash) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(() => {
      splash.classList.add('leaving')
      setTimeout(() => {
        splash.setAttribute('hidden', '')
        resolve()
      }, 460)
    }, seconds * 1000)
  })
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------
export function showLoading() {
  $('loading')?.removeAttribute('hidden')
}

/**
 * No-op kept for callers in main.js.
 *
 * The loading screen is the Pokémon GO splash artwork only — there is no bar
 * or status copy to update while the AR engine boots.
 */
export function setLoadingProgress() {}

export function hideLoading() {
  const el = $('loading')
  el?.setAttribute('hidden', '')
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------
let loginResolve = null
let loginRegistering = false
let loginWired = false

function wireLogin() {
  if (loginWired) return
  loginWired = true

  $('login-register')?.addEventListener('click', () => {
    loginRegistering = true
    setLoginError('')
    $('login-form')?.requestSubmit()
  })

  $('login-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    const username = ($('login-username')?.value || '').trim()
    const password = $('login-password')?.value || ''
    if (!username || !password) {
      setLoginError('Enter a trainer name and a password.')
      return
    }
    setLoginError('')
    const resolve = loginResolve
    loginResolve = null
    resolve?.({
      username,
      password,
      remember: !!$('login-remember')?.checked,
      register: loginRegistering,
    })
  })
}

/**
 * Show the login screen and resolve with the submitted credentials.
 * Wires its listeners exactly once, so repeated attempts do not stack handlers.
 * @param {{username:string, password:string}} prefill
 * @returns {Promise<{username:string, password:string, remember:boolean, register:boolean}>}
 */
export function showLogin(prefill = {username: '', password: ''}) {
  wireLogin()
  $('login')?.removeAttribute('hidden')
  loginRegistering = false

  const userInput = $('login-username')
  const passInput = $('login-password')
  if (userInput) userInput.value = prefill.username || ''
  if (passInput) passInput.value = prefill.password || ''
  const serverUrl = $('login-server-url')
  if (serverUrl) serverUrl.textContent = location.origin
  setLoginError('')

  return new Promise((resolve) => {
    loginResolve = resolve
  })
}

export function setLoginError(message) {
  const errorEl = $('login-error')
  if (!errorEl) return
  if (!message) {
    errorEl.setAttribute('hidden', '')
    return
  }
  errorEl.textContent = message
  errorEl.removeAttribute('hidden')
}

export function setLoginBusy(busy, label = 'Sign in') {
  const submit = $('login-submit')
  if (!submit) return
  submit.disabled = busy
  submit.textContent = busy ? 'Please wait…' : label
}

export function hideLogin() {
  $('login')?.setAttribute('hidden', '')
}

// -----------------------------------------------------------------------------
// HUD
// -----------------------------------------------------------------------------
export function showApp() {
  $('app')?.removeAttribute('hidden')
  state.hudVisible = true
  updateItemSwitch()
}

let hintTimer = 0
export function hint(text, ms = GM.ui.hintMs) {
  const el = $('hud-hint')
  if (!el) return
  el.textContent = text
  el.removeAttribute('hidden')
  el.style.opacity = '1'
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.setAttribute('hidden', ''), 380)
  }, ms)
}

let toastTimer = 0
export function toast(text, ms = GM.ui.toastMs) {
  const el = $('hud-toast')
  if (!el) return
  el.textContent = text
  el.removeAttribute('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.setAttribute('hidden', ''), ms)
}

export function updateItemSwitch() {
  const ball = getBall(state.selectedItem)
  const icon = $('item-switch-icon')
  if (icon) icon.src = ball.icon
  const count = $('item-switch-count')
  if (count) count.textContent = String(state.items[ball.id] ?? 0)
}

// -----------------------------------------------------------------------------
// Outdoor tutorial
// -----------------------------------------------------------------------------
let tutorialShown = false

/**
 * The one-off "go outside" popup.
 *
 * Shown a second after the AR session goes live (main.js -> startGame) and only
 * once per session: the illustration and copy are pulled from the game master
 * (`ui.tutorialArt` / `ui.tutorialText`), so both are editable without code.
 */
export function showTutorial() {
  if (tutorialShown) return
  const overlay = $('tutorial')
  if (!overlay) return
  tutorialShown = true

  const art = $('tutorial-art')
  if (art && GM.ui.tutorialArt) art.src = GM.ui.tutorialArt
  const text = $('tutorial-text')
  if (text && GM.ui.tutorialText) text.textContent = GM.ui.tutorialText

  overlay.removeAttribute('hidden')
  state.dialogOpen = true
  playSound(ASSET_SOUNDS.open, {volume: 0.6})
}

export function hideTutorial() {
  $('tutorial')?.setAttribute('hidden', '')
  state.dialogOpen = isAnyOverlayOpen()
}

// -----------------------------------------------------------------------------
// Overlays (item menu / inventory / pokedex)
// -----------------------------------------------------------------------------
export function isAnyOverlayOpen() {
  return ['tutorial', 'item-menu', 'inventory', 'pokedex', 'snapshot', 'inspection', 'transfer-confirm']
    .some((id) => !$(id)?.hasAttribute('hidden'))
}

export function closeAllOverlays() {
  for (const id of ['item-menu', 'inventory', 'pokedex', 'snapshot', 'transfer-confirm']) {
    $(id)?.setAttribute('hidden', '')
  }
  state.dialogOpen = false
  updateItemSwitch()
}

/**
 * Confirm a transfer (release). Opened from the inspection screen; the overlay
 * sits above it so the Pokémon stays on screen while the player decides.
 * @param {string} name display name for the Pokémon about to be released
 */
export function openTransferConfirm(name) {
  const text = $('transfer-text')
  if (text) text.textContent = `Transfer ${name || 'this Pokémon'}?`
  $('transfer-confirm')?.removeAttribute('hidden')
  state.dialogOpen = true
}

export function closeTransferConfirm() {
  $('transfer-confirm')?.setAttribute('hidden', '')
  state.dialogOpen = isAnyOverlayOpen()
}

export function openItemMenu() {
  closeAllOverlays()
  renderItemMenu()
  $('item-menu')?.removeAttribute('hidden')
  state.dialogOpen = true
}

export function renderItemMenu() {
  const wrap = $('item-menu-items')
  if (!wrap) return
  wrap.innerHTML = ''
  for (const ball of BALLS) {
    const selected = ball.id === state.selectedItem
    const count = state.items[ball.id] ?? 0
    const slot = document.createElement('button')
    slot.type = 'button'
    slot.className = 'item-slot'
    slot.dataset.selected = String(selected)
    slot.dataset.empty = String(count <= 0)
    if (ball.legendaryOnly) slot.dataset.legendaryOnly = 'true'
    // Counts are shown on every slot; spinning a PokéStop tops them back up.
    slot.innerHTML = `
      <img src="${ball.icon}" alt="${ball.name}">
      <span class="item-slot-label">${ball.name}</span>
      <span class="item-slot-count">×${count}</span>`
    slot.addEventListener('click', () => {
      state.selectedItem = ball.id
      playSound(ASSET_SOUNDS.select)
      renderItemMenu()
      updateItemSwitch()
      emit('items:changed')
    })
    wrap.appendChild(slot)
  }
  const name = $('item-menu-name')
  if (name) {
    const ball = getBall(state.selectedItem)
    const count = state.items[ball.id] ?? 0
    name.textContent = `${ball.name} ×${count}` + (ball.legendaryOnly ? ' · legendary only' : '')
  }

  // The header count: total items carried — a plain count, never "x / y"
  // (the reference shows a capacity here, but bt16 items have no maximum).
  const total = BALLS.reduce((sum, b) => sum + (state.items[b.id] ?? 0), 0)
  const headTotal = $('item-menu-total')
  if (headTotal) headTotal.textContent = String(total)
}

export function openInventory() {
  closeAllOverlays()
  renderInventory($('inventory-search')?.value ?? '')
  $('inventory')?.removeAttribute('hidden')
  state.dialogOpen = true
}

/**
 * Pokémon storage.
 *
 * One card per caught Pokémon: the type-coloured art from
 * important-icons/pokemon-types as the tile background, the Pokémon's icon on
 * top, and its nickname / dex number underneath. CP is deliberately absent
 * (it does not exist yet).
 */
export function renderInventory(filter = '') {
  const grid = $('inventory-grid')
  const empty = $('inventory-empty')
  if (!grid) return

  const query = filter.trim().toLowerCase()
  const all = inventoryEntries(state.inventory)

  const entries = all.filter(({dex, entry}) => {
    if (!query) return true
    return (
      pokemonName(dex).toLowerCase().includes(query) ||
      String(dex).includes(query) ||
      String(entry.nickname || '').toLowerCase().includes(query)
    )
  })

  grid.innerHTML = ''
  for (const {id, dex, entry} of entries) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'storage-card'
    card.setAttribute('aria-label', `${entry.nickname || pokemonName(dex)} (#${dex})`)

    const types = pokemonTypes(dex)
    // Name + art only — the storage tiles deliberately omit the dex number.
    card.innerHTML = `
      <span class="storage-art" style="background-image:url('${typeBackgroundUrl(types[0])}')">
        <img src="${iconUrl(dex)}" alt="" loading="lazy">
      </span>
      <span class="storage-name">${entry.nickname || pokemonName(dex)}</span>`

    card.addEventListener('click', () => {
      playSound(ASSET_SOUNDS.clickOk)
      ACTIONS.inspect?.(id)
    })
    grid.appendChild(card)
  }

  const count = $('storage-count')
  if (count) count.textContent = `${all.length} / ${STORAGE_LIMIT}`

  if (empty) {
    if (entries.length === 0) empty.removeAttribute('hidden')
    else empty.setAttribute('hidden', '')
  }
}

function pad3(n) {
  return String(n).padStart(3, '0')
}

export function openPokedex() {
  closeAllOverlays()
  renderPokedex()
  $('pokedex')?.removeAttribute('hidden')
  state.dialogOpen = true
}

export function renderPokedex() {
  const grid = $('pokedex-grid')
  if (!grid) return
  grid.innerHTML = ''
  let caught = 0
  for (let dex = 1; dex <= GEN1_COUNT; dex++) {
    const isCaught = !!state.pokedex[dex]
    if (isCaught) caught++
    const cell = document.createElement('div')
    cell.className = `dex-cell${isCaught ? ' caught' : ''}`
    if (isCaught) {
      cell.innerHTML = `
        <img src="${iconUrl(dex)}" alt="${pokemonName(dex)}">
        <span class="dex-cell-name">${pokemonName(dex)}</span>`
    } else {
      cell.innerHTML = `<span class="dex-num">${String(dex).padStart(3, '0')}</span>`
    }
    grid.appendChild(cell)
  }
  const count = $('pokedex-count')
  if (count) count.textContent = `${caught} / ${GEN1_COUNT}`
}

// -----------------------------------------------------------------------------
// Inspection chrome
// -----------------------------------------------------------------------------
export function openInspectionUi(dex, entry) {
  const overlay = $('inspection')
  overlay?.removeAttribute('hidden')

  const species = pokemonName(dex)
  const nickname = entry?.nickname || species

  const nameEl = $('inspection-name')
  if (nameEl) nameEl.textContent = species

  // Show the nickname as a subtitle when it differs from the species name.
  const nickEl = $('inspection-nick')
  if (nickEl) {
    const showNick = nickname && nickname !== species
    nickEl.textContent = showNick ? `“${nickname}”` : `#${pad3(dex)}`
  }

  // Type chips, drawn on the type art from important-icons/pokemon-types.
  const typesEl = $('inspection-types')
  if (typesEl) {
    typesEl.innerHTML = ''
    for (const type of pokemonTypes(dex)) {
      const chip = document.createElement('span')
      chip.className = 'type-chip'
      chip.textContent = typeLabel(type)
      chip.style.backgroundImage = `url('${typeBackgroundUrl(type)}')`
      chip.style.borderColor = typeColor(type)
      typesEl.appendChild(chip)
    }
  }

  const input = $('inspection-nickname')
  if (input) input.value = nickname

  state.dialogOpen = true
}

export function closeInspectionUi() {
  $('inspection')?.setAttribute('hidden', '')
  state.dialogOpen = isAnyOverlayOpen()
}

// -----------------------------------------------------------------------------
// Snapshot
// -----------------------------------------------------------------------------
export function showSnapshot(dataUrl) {
  const overlay = $('snapshot')
  const img = $('snapshot-img')
  const link = $('snapshot-download')
  if (img) img.src = dataUrl
  if (link) link.href = dataUrl
  overlay?.removeAttribute('hidden')
  state.dialogOpen = true
}

// -----------------------------------------------------------------------------
// Fatal
// -----------------------------------------------------------------------------
export function showFatal(message) {
  hideLoading()
  $('login')?.setAttribute('hidden', '')
  const el = $('fatal')
  const msg = $('fatal-msg')
  if (msg) msg.textContent = String(message?.message || message)
  el?.removeAttribute('hidden')
}
