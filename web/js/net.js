/**
 * Networking: the bridge to the Python server.
 *
 * Responsibilities
 *   - login / register / save / log, over GET and POST
 *   - remember the username + password in cookies (spec)
 *   - mirror the browser console to the server's log.json
 *   - sync the inventory + Pokédex to the server every 10 seconds
 *
 * The server is plain JSON over HTTP(S); nothing here assumes a session.
 */
import {state, on} from './core.js?v=16'

const API = {
  health: '/api/health',
  login: '/api/login',
  register: '/api/register',
  save: '/api/save',
  log: '/api/log',
  player: '/api/player',
}

// -----------------------------------------------------------------------------
// Cookies
// -----------------------------------------------------------------------------
const COOKIE_USER = 'bt16_user'
const COOKIE_PASS = 'bt16_pass'
const COOKIE_DAYS = 365

function encode(value) {
  try {
    return btoa(unescape(encodeURIComponent(value)))
  } catch {
    return ''
  }
}

function decode(value) {
  try {
    return decodeURIComponent(escape(atob(value)))
  } catch {
    return ''
  }
}

export function setCookie(name, value, days = COOKIE_DAYS) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`
}

export function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : ''
}

export function clearCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`
}

/** Save the credentials so the login screen can pre-fill them next time. */
export function rememberCredentials(username, password) {
  setCookie(COOKIE_USER, encode(username))
  setCookie(COOKIE_PASS, encode(password))
}

export function recallCredentials() {
  return {
    username: decode(getCookie(COOKIE_USER)),
    password: decode(getCookie(COOKIE_PASS)),
  }
}

export function forgetCredentials() {
  clearCookie(COOKIE_USER)
  clearCookie(COOKIE_PASS)
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------
async function request(path, {method = 'GET', body = null, timeout = 8000} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(path, {
      method,
      headers: body ? {'Content-Type': 'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const message = json?.error || `HTTP ${res.status}`
      throw new Error(message)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  health: () => request(API.health),
  login: (username, password) => request(API.login, {method: 'POST', body: {username, password}}),
  register: (username, password) => request(API.register, {method: 'POST', body: {username, password}}),
  player: (username) => request(`${API.player}?username=${encodeURIComponent(username)}`),
  save: (username, inventory, pokedex, items) =>
    request(API.save, {method: 'POST', body: {username, inventory, pokedex, items}}),
  log: (username, entries) => request(API.log, {method: 'POST', body: {username, entries}}),
}

// -----------------------------------------------------------------------------
// Console mirror -> server log.json
// -----------------------------------------------------------------------------
const logBuffer = []
const MAX_BUFFER = 400
let logInstall = false

function fmt(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

/** Install the console interceptors. Safe to call more than once. */
export function installLogger() {
  if (logInstall) return
  logInstall = true

  const push = (level, message) => {
    logBuffer.push({t: Date.now(), level, message})
    if (logBuffer.length > MAX_BUFFER) logBuffer.splice(0, logBuffer.length - MAX_BUFFER)
  }

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      push(level, fmt(args))
      original(...args)
    }
  }

  window.addEventListener('error', (e) => {
    push('error', `window.error: ${e.message} (${e.filename}:${e.lineno})`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    push('error', `unhandledrejection: ${e.reason?.message || e.reason}`)
  })
}

/** Flush buffered console lines to the server. */
export async function flushLogs() {
  if (!logBuffer.length) return
  const entries = logBuffer.splice(0, logBuffer.length)
  try {
    await api.log(state.user?.username ?? 'anonymous', entries)
  } catch {
    // Keep them so the next flush can retry — but never grow unbounded.
    logBuffer.unshift(...entries)
    if (logBuffer.length > MAX_BUFFER) logBuffer.splice(0, logBuffer.length - MAX_BUFFER)
  }
}

// -----------------------------------------------------------------------------
// Progress sync (every 10 seconds)
// -----------------------------------------------------------------------------
let syncTimer = null
let dirty = false

/** Mark local progress as changed; it will be pushed on the next tick. */
export function markDirty() {
  dirty = true
}

export function startSync(intervalMs = 10000) {
  if (syncTimer) return
  syncTimer = setInterval(async () => {
    await flushLogs()
    if (!state.user || !dirty) return
    dirty = false
    try {
      await api.save(state.user.username, state.inventory, state.pokedex, state.items)
    } catch (err) {
      dirty = true
      console.warn('[net] save failed:', err.message)
    }
  }, intervalMs)

  // Flush logs even when there is nothing to save.
  on('progress', () => markDirty())
}

/** Force an immediate save (used when closing the app / catching). */
export async function saveNow() {
  if (!state.user) return
  try {
    await api.save(state.user.username, state.inventory, state.pokedex, state.items)
    dirty = false
  } catch (err) {
    console.warn('[net] saveNow failed:', err.message)
  }
}

export function isDirty() {
  return dirty
}
