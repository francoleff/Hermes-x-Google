/**
 * Google Workspace for Hermes Desktop.
 *
 * Plain disk-plugin ESM: JSX is not compiled on load, so every element is a
 * jsx()/jsxs() call. Backend routes live in ../dashboard/plugin_api.py and are
 * reached through ctx.rest(), which is scoped to this plugin and profile.
 *
 * Reads happen automatically. Every write is a button the human pressed, and
 * anything that notifies other people (email, invitations) gets a second
 * confirmation that names the recipients.
 */
import {
  Badge, Button, Checkbox, Codicon, ConfirmDialog, Dialog, DialogContent,
  DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Input, SearchField, Separator, Skeleton, Textarea, useQuery, queryClient, host,
  ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'

const PLUGIN_ID = 'google-workspace'
const QK = [PLUGIN_ID]
const PAGE_PATH = '/google-workspace'

const MIME_DOC = 'application/vnd.google-apps.document'
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet'
const MIME_FOLDER = 'application/vnd.google-apps.folder'

const GOOGLE_LINKS = {
  gmail: 'https://mail.google.com',
  calendar: 'https://calendar.google.com',
  drive: 'https://drive.google.com',
  docs: 'https://docs.google.com',
  sheets: 'https://docs.google.com/spreadsheets',
  contacts: 'https://contacts.google.com',
  cloud: 'https://console.cloud.google.com/apis/credentials',
  scopes: 'https://developers.google.com/workspace/guides/configure-oauth-consent',
}

const TABS = [
  { id: 'Overview', label: 'Workspace', icon: 'home' },
  { id: 'Gmail', label: 'Gmail', icon: 'mail', service: 'gmail' },
  { id: 'Calendar', label: 'Calendar', icon: 'calendar', service: 'calendar' },
  { id: 'Drive', label: 'Drive', icon: 'cloud', service: 'drive' },
  { id: 'Docs', label: 'Docs', icon: 'book', service: 'docs' },
  { id: 'Sheets', label: 'Sheets', icon: 'table', service: 'sheets' },
  { id: 'Contacts', label: 'Contacts', icon: 'organization', service: 'contacts' },
  { id: 'Changes', label: 'Changes', icon: 'history' },
  { id: 'Settings', label: 'Settings', icon: 'settings-gear' },
]

// ── Recent changes ───────────────────────────────────────────────────────────
// The Python hooks record each Google write Hermes makes and push the turn's batch as a plugin
// event. The feed is kept here, newest first, in plugin-scoped storage so a reload keeps it.

const CHANGES_EVENT = 'plugin.google-workspace.turn.changes'
const CHANGES_STORAGE_KEY = 'recentChanges'
const CHANGES_LIMIT = 50

let recentChanges = []
const changeListeners = new Set()

function cleanChange(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = String(entry.id || '')
  const action = String(entry.action || '')
  if (!id || !action) return null
  const url = typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url) ? entry.url : ''
  return {
    id,
    at: String(entry.at || ''),
    service: String(entry.service || ''),
    action,
    title: String(entry.title || ''),
    url,
  }
}

function readStoredChanges() {
  try {
    const stored = pluginCtx?.storage?.get?.(CHANGES_STORAGE_KEY, [])
    return Array.isArray(stored) ? stored.map(cleanChange).filter(Boolean).slice(0, CHANGES_LIMIT) : []
  } catch {
    return []
  }
}

function setRecentChanges(next) {
  recentChanges = next
  try { pluginCtx?.storage?.set?.(CHANGES_STORAGE_KEY, next) } catch { /* storage is optional */ }
  changeListeners.forEach((listener) => listener(next))
}

// A turn's entries arrive oldest first; the feed shows the newest first.
function recordChanges(entries) {
  if (!Array.isArray(entries)) return
  const fresh = entries.map(cleanChange).filter(Boolean).reverse()
  if (!fresh.length) return
  const known = new Set(fresh.map((entry) => entry.id))
  setRecentChanges([...fresh, ...recentChanges.filter((entry) => !known.has(entry.id))].slice(0, CHANGES_LIMIT))
}

function clearChanges() {
  setRecentChanges([])
}

function useRecentChanges() {
  const [changes, setChanges] = useState(recentChanges)
  useEffect(() => {
    changeListeners.add(setChanges)
    setChanges(recentChanges)
    return () => { changeListeners.delete(setChanges) }
  }, [])
  return changes
}

// ── Backend plumbing ─────────────────────────────────────────────────────────

let pluginCtx = null

async function rest(path, options) {
  if (!pluginCtx) throw new Error('Google Workspace is still loading.')
  const raw = await pluginCtx.rest(path, options)
  return raw && typeof raw === 'object' && raw.ok === true && 'data' in raw ? raw.data : raw
}

function post(path, body) {
  return rest(path, { method: 'POST', body: body || {} })
}

function payloadFromError(error) {
  const message = String(error?.message || error || '')
  const start = message.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(message.slice(start))
  } catch {
    return null
  }
}

function errorInfo(error, fallback = 'Something went wrong.') {
  const payload = payloadFromError(error)
  const detail = payload?.detail ?? payload
  const nested = detail?.detail ?? detail
  const code = String(nested?.code || '')
  const message = String(nested?.message || detail?.message || error?.message || fallback)
  const hint = String(nested?.hint || detail?.hint || '')
  return { code, message, hint }
}

function useApi(path, { enabled = true, extra = [], refetchInterval = false } = {}) {
  return useQuery({
    queryKey: [...QK, path, ...extra],
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchInterval,
    queryFn: () => rest(path),
  })
}

function refreshEverything() {
  queryClient.invalidateQueries({ queryKey: QK })
}

function openUrl(url) {
  if (!url) return
  try {
    Promise.resolve(pluginCtx?.os?.openExternal?.(url)).then(
      (ok) => {
        if (!ok) host.notify({ kind: 'warning', message: 'The system did not open that link.' })
      },
      () => host.notify({ kind: 'warning', message: 'Could not open that link.' }),
    )
  } catch {
    host.notify({ kind: 'warning', message: 'Could not open that link.' })
  }
}

async function copyText(text, label = 'Copied to clipboard.') {
  try {
    const ok = await pluginCtx?.os?.writeClipboard?.(String(text ?? ''))
    if (ok) host.notify({ kind: 'success', message: label })
  } catch {
    host.notify({ kind: 'error', message: 'Could not copy. Select the text and copy it manually.' })
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function asDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function fmtTime(value) {
  const date = asDate(value)
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
}

function fmtDay(value) {
  const date = asDate(value)
  if (!date) return ''
  const today = new Date()
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(date, today)) return 'Today'
  if (same(date, tomorrow)) return 'Tomorrow'
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtDateTime(value) {
  const date = asDate(value)
  if (!date) return ''
  return `${fmtDay(value)} · ${fmtTime(value)}`
}

function fmtRelative(value) {
  const date = asDate(value)
  if (!date) return ''
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  const unit = abs < 60 ? [Math.round(seconds), 'second'] : abs < 3600 ? [Math.round(seconds / 60), 'minute'] : abs < 86400 ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 86400), 'day']
  try {
    return new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(unit[0], unit[1])
  } catch {
    return fmtDateTime(value)
  }
}

function fmtBytes(size) {
  const value = Number(size || 0)
  if (!value) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let amount = value
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`
}

function senderName(from, fallback = 'Unknown sender') {
  const text = String(from || '').trim()
  if (!text) return fallback
  const match = text.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  return (match ? match[1] : text).trim() || fallback
}

function senderEmail(from) {
  const match = String(from || '').match(/<([^>]+)>/)
  return (match ? match[1] : String(from || '')).trim()
}

function initials(name, email) {
  const source = String(name || email || '?').trim()
  const words = source.split(/[\s@._-]+/).filter(Boolean)
  const letters = words.slice(0, 2).map((word) => word[0].toUpperCase()).join('')
  return letters || '?'
}

function mimeLabel(mimeType) {
  const mime = String(mimeType || '')
  if (mime === MIME_DOC) return 'Google Doc'
  if (mime === MIME_SHEET) return 'Google Sheet'
  if (mime === MIME_FOLDER) return 'Folder'
  if (mime.includes('presentation')) return 'Slides'
  if (mime.includes('pdf')) return 'PDF'
  if (mime.startsWith('image/')) return 'Image'
  if (mime.includes('spreadsheet')) return 'Spreadsheet'
  if (mime.includes('document')) return 'Document'
  return mime.split('/').pop() || 'File'
}

function fileIcon(mimeType) {
  const mime = String(mimeType || '')
  if (mime === MIME_DOC) return 'book'
  if (mime === MIME_SHEET) return 'table'
  if (mime === MIME_FOLDER) return 'folder'
  if (mime.includes('presentation')) return 'graph'
  if (mime.includes('pdf')) return 'file-pdf'
  if (mime.startsWith('image/')) return 'file-media'
  return 'file'
}

function extractId(value, kind) {
  const text = String(value || '').trim()
  if (!text) return ''
  const patterns = {
    doc: /\/document\/d\/([a-zA-Z0-9_-]+)/,
    sheet: /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    folder: /\/folders\/([a-zA-Z0-9_-]+)/,
    file: /\/d\/([a-zA-Z0-9_-]+)/,
  }
  const match = text.match(patterns[kind] || patterns.file)
  return match ? match[1] : text
}

function localInputValue(date) {
  const value = asDate(date) || new Date()
  const pad = (number) => String(number).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function isoFromLocal(value) {
  const date = asDate(value)
  return date ? date.toISOString() : ''
}

function eventDuration(event) {
  const start = asDate(event?.start)
  const end = asDate(event?.end)
  if (!start || !end) return ''
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000))
  if (!minutes) return ''
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

function groupEventsByDay(events) {
  const groups = []
  for (const event of events || []) {
    const key = asDate(event.start)?.toDateString() || 'Unscheduled'
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.events.push(event)
    else groups.push({ key, day: event.start, events: [event] })
  }
  return groups
}

// ── Shared presentation ──────────────────────────────────────────────────────

const surfaceStyle = {
  background: 'color-mix(in srgb, var(--ui-bg-secondary) 72%, transparent)',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: '10px',
}

const insetStyle = {
  background: 'color-mix(in srgb, var(--ui-bg-tertiary) 55%, transparent)',
  border: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 70%, transparent)',
  borderRadius: '8px',
}

const labelStyle = {
  display: 'block',
  fontSize: '0.7rem',
  fontWeight: 600,
  color: 'var(--ui-text-tertiary)',
  marginBottom: '0.35rem',
}

const inputStyle = { width: '100%' }

// One easing curve across the plugin: short for feedback on hover and selection.
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const rowTransition = `background-color 140ms ${EASE}, border-color 140ms ${EASE}`

function Icon({ name, size = '1rem', color, style }) {
  return jsx(Codicon, { name, size, style: { color, ...style } })
}

// The Google "G" mark. Used in the page header, the setup hero and — on Hermes builds
// that support a custom sidebar-nav icon — the sidebar row itself. The four colours are
// the brand's; the mark never takes the surrounding text colour.
function GoogleG({ className, size = '1rem' }) {
  return jsx('svg', {
    className,
    viewBox: '0 0 48 48',
    width: size,
    height: size,
    'aria-hidden': 'true',
    focusable: 'false',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'blue', fill: '#4285F4', d: 'M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z' }),
      jsx('path', { key: 'green', fill: '#34A853', d: 'M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z' }),
      jsx('path', { key: 'yellow', fill: '#FBBC05', d: 'M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z' }),
      jsx('path', { key: 'red', fill: '#EA4335', d: 'M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z' }),
    ],
  })
}

// The six Google product marks, from Google's 2026 Workspace icon set (Contacts from its
// November 2026 refresh). The artwork is copied from the gstatic productlogos files. Each mark's
// ids carry its own prefix, so marks can share a page. Each viewBox is centred on the visible
// artwork. Each mark takes only a size, so one component serves a 0.9rem tab glyph and a 10rem
// empty state.

// The Contacts raster fade is the official PNG from the same file. It is clipped to the figure.
const CONTACTS_2026_FADE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAvcAAAKLCAYAAAByn6cBAAAACXBIWXMAAC4jAAAuIwF4pT92AAAgAElEQVR4nOy9XZLkuLWlu0B6/GTWz5GqJVNLdsy67Nqxfqh+rAFoFD2eqh6PJqE7AD1KD6fbZJJd2SmpS0ep/I8IdwL3AdjAxiZA0j08MiMz1yqrcBIAQXqkh/uH5QsgQFEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEURVEU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'

function GmailIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'k0', fill: 'url(#gw-gmail-a)', d: 'M146 44h38v110c0 6.627-5.373 12-12 12h-20a6 6 0 0 1-6-6z' }),
      jsx('path', { key: 'k1', fill: '#fc413d', d: 'M46 44H8v110c0 6.627 5.373 12 12 12h20a6 6 0 0 0 6-6z' }),
      jsx('path', { key: 'k2', fill: 'url(#gw-gmail-b)', d: 'M39.226 30.456c-8.033-6.752-20.018-5.714-26.77 2.319-6.752 8.032-5.714 20.017 2.319 26.77l76.078 63.949a8 8 0 0 0 10.295 0l76.078-63.95c8.032-6.752 9.07-18.737 2.318-26.77-6.752-8.032-18.737-9.07-26.769-2.318L96 78.18z' }),
      jsx('defs', {
        key: 'k3',
        children: [
          jsx('linearGradient', {
            key: 'k0',
            id: 'gw-gmail-a',
            x1: '165',
            x2: '165',
            y1: '44',
            y2: '166',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', stopColor: '#60d673' }),
              jsx('stop', { key: 'k1', offset: '.17', stopColor: '#42c868' }),
              jsx('stop', { key: 'k2', offset: '.39', stopColor: '#0ebc5f' }),
              jsx('stop', { key: 'k3', offset: '.62', stopColor: '#00a9bb' }),
              jsx('stop', { key: 'k4', offset: '.86', stopColor: '#3c90ff' }),
              jsx('stop', { key: 'k5', offset: '1', stopColor: '#3186ff' }),
            ],
          }),
          jsx('linearGradient', {
            key: 'k1',
            id: 'gw-gmail-b',
            x1: '8',
            x2: '184',
            y1: '46.13',
            y2: '46.13',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', offset: '.08', stopColor: '#ff63a0' }),
              jsx('stop', { key: 'k1', offset: '.3', stopColor: '#fc413d' }),
              jsx('stop', { key: 'k2', offset: '.5', stopColor: '#fc413d' }),
              jsx('stop', { key: 'k3', offset: '.65', stopColor: '#fc413d' }),
              jsx('stop', { key: 'k4', offset: '.72', stopColor: '#fc5c30' }),
              jsx('stop', { key: 'k5', offset: '.86', stopColor: '#feb10c' }),
              jsx('stop', { key: 'k6', offset: '.91', stopColor: '#fec700' }),
              jsx('stop', { key: 'k7', offset: '.96', stopColor: '#ffdb0f' }),
            ],
          }),
        ],
      }),
    ],
  })
}

function CalendarIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 -6 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'k0', fill: '#bbe2ff', d: 'M32 36.8C32 20.894 44.894 8 60.8 8h70.4C147.106 8 160 20.894 160 36.8v30.4c0 15.906-12.894 28.8-28.8 28.8H60.8C44.894 96 32 83.106 32 67.2z' }),
      jsx('path', { key: 'k1', fill: '#3c90ff', d: 'M19.867 49.392C17.818 33.82 29.94 20 45.645 20h100.71c15.706 0 27.827 13.82 25.778 29.392L166 96l6.133 46.608C174.182 158.18 162.061 172 146.355 172H45.645c-15.706 0-27.827-13.82-25.778-29.392L26 96z' }),
      jsx('mask', {
        key: 'k2',
        id: 'gw-calendar-a',
        width: '154',
        height: '152',
        x: '19',
        y: '20',
        maskUnits: 'userSpaceOnUse',
        style: { maskType: 'alpha' },
        children: jsx('path', { fill: '#3c90ff', d: 'M19.867 49.392C17.818 33.82 29.94 20 45.645 20h100.71c15.706 0 27.827 13.82 25.778 29.392L166 96l6.133 46.608C174.182 158.18 162.061 172 146.355 172H45.645c-15.706 0-27.827-13.82-25.778-29.392L26 96z' }),
      }),
      jsx('g', {
        key: 'k3',
        mask: 'url(#gw-calendar-a)',
        children: jsx('path', { fill: 'url(#gw-calendar-b)', d: 'M0 0h166v76H0z', transform: 'matrix(1 0 0 -1 13 172)' }),
      }),
      jsx('mask', {
        key: 'k4',
        id: 'gw-calendar-c',
        width: '154',
        height: '152',
        x: '19',
        y: '20',
        maskUnits: 'userSpaceOnUse',
        style: { maskType: 'alpha' },
        children: jsx('path', { fill: '#3186ff', d: 'M19.867 49.392C17.818 33.82 29.94 20 45.645 20h100.71c15.706 0 27.827 13.82 25.778 29.392L166 96l6.133 46.608C174.182 158.18 162.061 172 146.355 172H45.645c-15.706 0-27.827-13.82-25.778-29.392L26 96z' }),
      }),
      jsx('g', {
        key: 'k5',
        mask: 'url(#gw-calendar-c)',
        children: jsx('path', { fill: 'url(#gw-calendar-d)', d: 'M32 27.2C32 16.596 40.596 8 51.2 8h89.6c10.604 0 19.2 8.596 19.2 19.2V96H32z', filter: 'url(#gw-calendar-e)' }),
      }),
      jsx('path', { key: 'k6', fill: '#fff', d: 'M75.353 133.336q-6.282 0-10.777-2.043t-7.61-5.465q-3.065-3.474-4.342-6.793T51.603 115a2.07 2.07 0 0 1 1.021-1.124l5.67-2.247q.714-.357 1.43-.102.714.204 1.685 2.349 1.022 2.145 2.86 4.546a14.3 14.3 0 0 0 4.495 3.728q2.606 1.328 6.435 1.328 6.18 0 9.807-3.575 3.677-3.575 3.677-9.091 0-5.976-3.882-9.194-3.881-3.269-10.266-3.269h-5.362a1.9 1.9 0 0 1-1.328-.51q-.51-.562-.511-1.277v-5.465q0-.767.51-1.277a1.82 1.82 0 0 1 1.329-.562h4.647q5.721 0 9.194-3.116t3.473-8.07q0-4.902-3.116-7.916t-8.58-3.014q-3.065 0-5.312 1.022a11.5 11.5 0 0 0-3.882 2.86 22.7 22.7 0 0 0-2.809 3.78q-1.174 1.941-1.89 2.145-.714.153-1.379-.255l-5.363-2.605q-.664-.358-.868-1.124t1.226-3.575q1.481-2.86 4.494-5.823a21 21 0 0 1 7.049-4.597q4.035-1.635 9.398-1.634 9.96 0 15.782 5.26 5.823 5.21 5.823 13.791 0 5.925-2.86 10.266-2.81 4.34-7.968 6.13v.204q6.231 1.838 9.806 6.741 3.627 4.853 3.626 11.594 0 9.654-6.742 15.834-6.74 6.18-17.57 6.18zm51.25-1.175q-.868 0-1.533-.664a2.25 2.25 0 0 1-.612-1.583V73.118l-11.492 8.274q-.614.46-1.431.307a1.96 1.96 0 0 1-1.225-.766l-3.32-4.7a1.98 1.98 0 0 1-.358-1.43q.153-.816.817-1.276l20.379-14.557q.256-.204.562-.306.307-.153.715-.153h4.291q.868 0 1.379.613.562.56.562 1.43v69.36q0 .92-.664 1.583a2 2 0 0 1-1.533.664z' }),
      jsx('defs', {
        key: 'k7',
        children: [
          jsx('linearGradient', {
            key: 'k0',
            id: 'gw-calendar-b',
            x1: '83',
            x2: '83',
            y1: '76',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', stopColor: '#4fa0ff' }),
              jsx('stop', { key: 'k1', offset: '1', stopColor: '#3186ff' }),
            ],
          }),
          jsx('linearGradient', {
            key: 'k1',
            id: 'gw-calendar-d',
            x1: '89.06',
            x2: '89.06',
            y1: '21.75',
            y2: '96.39',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', stopColor: '#a9a8ff' }),
              jsx('stop', { key: 'k1', offset: '.8', stopColor: '#3c90ff' }),
            ],
          }),
          jsx('filter', {
            key: 'k2',
            id: 'gw-calendar-e',
            width: '152',
            height: '112',
            x: '20',
            y: '-4',
            colorInterpolationFilters: 'sRGB',
            filterUnits: 'userSpaceOnUse',
            children: [
              jsx('feFlood', { key: 'k0', floodOpacity: '0', result: 'BackgroundImageFix' }),
              jsx('feBlend', { key: 'k1', in: 'SourceGraphic', in2: 'BackgroundImageFix', result: 'shape' }),
              jsx('feGaussianBlur', { key: 'k2', result: 'effect1_foregroundBlur_37330_7673', stdDeviation: '6' }),
            ],
          }),
        ],
      }),
    ],
  })
}

function DriveIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 -1 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('mask', {
        key: 'k0',
        id: 'gw-drive-a',
        width: '168',
        height: '154',
        x: '12',
        y: '18',
        maskUnits: 'userSpaceOnUse',
        style: { maskType: 'alpha' },
        children: jsx('path', { fill: '#b43333', d: 'M63.09 37c14.626-25.333 51.193-25.334 65.819 0l45.033 78c14.626 25.334-3.657 57.001-32.91 57.001H50.967c-29.253 0-47.536-31.667-32.91-57.001z' }),
      }),
      jsx('g', {
        key: 'k1',
        mask: 'url(#gw-drive-a)',
        children: [
          jsx('path', { key: 'k0', fill: 'url(#gw-drive-b)', d: 'M206.905 172.02h-91.888l-19.015-32.934 45.944-79.578z' }),
          jsx('path', { key: 'k1', fill: 'url(#gw-drive-c)', d: 'M-14.919 172.006 50.04 59.494v.002L31.032 92.422h38.02L115 172.004l-129.918.001z' }),
          jsx('path', { key: 'k2', fill: 'url(#gw-drive-d)', d: 'M96.007-20.085 141.954 59.5l-19.011 32.928H31.048z' }),
        ],
      }),
      jsx('defs', {
        key: 'k2',
        children: [
          jsx('linearGradient', {
            key: 'k0',
            id: 'gw-drive-b',
            x1: '193.6',
            x2: '103.09',
            y1: '165.6',
            y2: '111.21',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', offset: '.09', stopColor: '#ffe921' }),
              jsx('stop', { key: 'k1', offset: '1', stopColor: '#fec700' }),
            ],
          }),
          jsx('linearGradient', {
            key: 'k1',
            id: 'gw-drive-c',
            x1: '114.4',
            x2: '15.53',
            y1: '181.61',
            y2: '121.8',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', offset: '.15', stopColor: '#a9a8ff' }),
              jsx('stop', { key: 'k1', offset: '.33', stopColor: '#6d97ff' }),
              jsx('stop', { key: 'k2', offset: '.48', stopColor: '#3186ff' }),
            ],
          }),
          jsx('linearGradient', {
            key: 'k2',
            id: 'gw-drive-d',
            x1: '128.88',
            x2: '28.7',
            y1: '37.88',
            y2: '84.64',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', offset: '.55', stopColor: '#0ebc5f' }),
              jsx('stop', { key: 'k1', offset: '.85', stopColor: '#78c9ff' }),
            ],
          }),
        ],
      }),
    ],
  })
}

function DocsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('mask', {
        key: 'k0',
        id: 'gw-docs-mask0_37242_8762',
        style: { maskType: 'alpha' },
        maskUnits: 'userSpaceOnUse',
        x: '32',
        y: '8',
        width: '128',
        height: '176',
        children: jsx('path', { d: 'M130.334 184L61.6 184C52.6565 184 48.1848 184 44.6375 182.596C39.5029 180.563 35.4374 176.497 33.4045 171.362C32 167.815 32 163.343 32 154.4L32 37.6C32 28.6565 32 24.1848 33.4045 20.6375C35.4374 15.5029 39.5029 11.4374 44.6375 9.40447C48.1848 8 52.6565 8 61.6 8L100 8L154.793 62.7933L154.793 62.7934C156.454 64.4543 157.285 65.2848 157.923 66.2239C158.845 67.5811 159.479 69.1131 159.785 70.725C159.997 71.8404 159.997 73.0264 159.995 75.3985C159.96 124.317 159.938 124.799 159.937 154.366C159.937 163.332 159.937 167.816 158.532 171.363C156.499 176.498 152.434 180.562 147.299 182.596C143.752 184 139.279 184 130.334 184Z', fill: '#3186FF' }),
      }),
      jsx('g', {
        key: 'k1',
        mask: 'url(#gw-docs-mask0_37242_8762)',
        children: [
          jsx('path', { key: 'k0', d: 'M159.94 184L31.9999 184L31.9999 8.00001L99.9999 8L159.999 68L159.94 184Z', fill: '#3186FF' }),
          jsx('g', {
            key: 'k1',
            filter: 'url(#gw-docs-filter0_f_37242_8762)',
            children: jsx('path', { d: 'M43 192H149V70.2271V20H43V192Z', fill: 'url(#gw-docs-paint0_linear_37242_8762)' }),
          }),
        ],
      }),
      jsx('path', { key: 'k2', d: 'M154.995 62.9951C152.489 61.1143 149.375 60 146 60H112.8C105.731 60 100 54.2692 100 47.2002V8L154.995 62.9951Z', fill: '#76BBFF' }),
      jsx('rect', { key: 'k3', x: '64.001', y: '114', width: '64', height: '12', rx: '6', fill: 'white' }),
      jsx('rect', { key: 'k4', x: '64.001', y: '143', width: '48', height: '12', rx: '6', fill: 'white' }),
      jsx('defs', {
        key: 'k5',
        children: [
          jsx('filter', {
            key: 'k0',
            id: 'gw-docs-filter0_f_37242_8762',
            x: '31',
            y: '8',
            width: '130',
            height: '196',
            filterUnits: 'userSpaceOnUse',
            colorInterpolationFilters: 'sRGB',
            children: [
              jsx('feFlood', { key: 'k0', floodOpacity: '0', result: 'BackgroundImageFix' }),
              jsx('feBlend', { key: 'k1', mode: 'normal', in: 'SourceGraphic', in2: 'BackgroundImageFix', result: 'shape' }),
              jsx('feGaussianBlur', { key: 'k2', stdDeviation: '6', result: 'effect1_foregroundBlur_37242_8762' }),
            ],
          }),
          jsx('linearGradient', {
            key: 'k1',
            id: 'gw-docs-paint0_linear_37242_8762',
            x1: '96',
            y1: '59.2839',
            x2: '54.6124',
            y2: '171.338',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', offset: '0.33', stopColor: '#3186FF' }),
              jsx('stop', { key: 'k1', offset: '1', stopColor: '#A9A8FF' }),
            ],
          }),
        ],
      }),
    ],
  })
}

function SheetsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'k0', fill: '#009954', d: 'M183.96 117.4c0 8.94 0 13.41-1.4 16.96a20 20 0 0 1-11.23 11.24c-3.55 1.4-8.02 1.4-16.97 1.4h-60.8c-8.94 0-13.41 0-16.96-1.4a20 20 0 0 1-11.23-11.24c-1.4-3.55-1.4-8.02-1.4-16.96V74.6c0-8.94 0-13.42 1.4-16.96A20 20 0 0 1 76.6 46.4C80.15 45 84.62 45 93.56 45h60.8c8.95 0 13.42 0 16.97 1.4a20 20 0 0 1 11.23 11.24c1.4 3.54 1.4 8.02 1.4 16.96z' }),
      jsx('mask', {
        key: 'k1',
        id: 'gw-sheets-a',
        width: '161',
        height: '128',
        x: '7',
        y: '32',
        maskUnits: 'userSpaceOnUse',
        style: { maskType: 'alpha' },
        children: jsx('path', { fill: '#0ebc5f', d: 'M167.96 130.4c0 8.94 0 13.41-1.4 16.96a20 20 0 0 1-11.23 11.24c-3.55 1.4-8.02 1.4-16.97 1.4H37.56c-8.94 0-13.41 0-16.96-1.4a20 20 0 0 1-11.23-11.24c-1.4-3.55-1.4-8.02-1.4-16.96V61.6c0-8.94 0-13.42 1.4-16.96A20 20 0 0 1 20.6 33.4C24.15 32 28.62 32 37.56 32h100.8c8.95 0 13.42 0 16.97 1.4a20 20 0 0 1 11.23 11.24c1.4 3.54 1.4 8.02 1.4 16.96z' }),
      }),
      jsx('g', {
        key: 'k2',
        mask: 'url(#gw-sheets-a)',
        children: [
          jsx('path', { key: 'k0', fill: '#0ebc5f', d: 'M167.96 160h-160V32h160z' }),
          jsx('g', {
            key: 'k1',
            filter: 'url(#gw-sheets-b)',
            children: jsx('path', { fill: 'url(#gw-sheets-c)', d: 'M183.96 65a20 20 0 0 0-20-20h-104a20 20 0 0 0-20 20v62a20 20 0 0 0 20 20h104a20 20 0 0 0 20-20z' }),
          }),
        ],
      }),
      jsx('path', { key: 'k3', fill: '#fff', d: 'M47.96 122a6 6 0 0 1-6-6V77h-14a6 6 0 0 1 0-12h14V52a6 6 0 0 1 12 0v13h58a6 6 0 1 1 0 12h-58v39a6 6 0 0 1-6 6' }),
      jsx('defs', {
        key: 'k4',
        children: [
          jsx('linearGradient', {
            key: 'k0',
            id: 'gw-sheets-c',
            x1: '61.73',
            x2: '163.21',
            y1: '88.31',
            y2: '88.31',
            gradientUnits: 'userSpaceOnUse',
            children: [
              jsx('stop', { key: 'k0', stopColor: '#0ebc5f' }),
              jsx('stop', { key: 'k1', offset: '.95', stopColor: '#78c9ff' }),
            ],
          }),
          jsx('filter', {
            key: 'k1',
            id: 'gw-sheets-b',
            width: '168',
            height: '126',
            x: '27.96',
            y: '33',
            colorInterpolationFilters: 'sRGB',
            filterUnits: 'userSpaceOnUse',
            children: [
              jsx('feFlood', { key: 'k0', floodOpacity: '0', result: 'BackgroundImageFix' }),
              jsx('feBlend', { key: 'k1', in: 'SourceGraphic', in2: 'BackgroundImageFix', result: 'shape' }),
              jsx('feGaussianBlur', { key: 'k2', result: 'effect1_foregroundBlur_2015_872', stdDeviation: '6' }),
            ],
          }),
        ],
      }),
    ],
  })
}

function ContactsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 -4 192 192',
    width: size,
    height: size,
    'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('defs', {
        key: 'k0',
        children: jsx('clipPath', {
          id: 'gw-contacts-clippath',
          children: jsx('path', { fill: 'none', d: 'M52.04 152c0-14.89 0-22.33 1.96-28.36a40 40 0 0 1 25.68-25.68C85.71 96 93.15 96 108.04 96h18a38 38 0 1 1 0 76H69.58c-5.16 0-7.74 0-9.79-.78a12 12 0 0 1-6.97-6.96c-.78-2.06-.78-4.64-.78-9.79z' }),
        }),
      }),
      jsx('path', { key: 'k1', fill: 'none', d: 'M0 0h192v192H0z' }),
      jsx('g', {
        key: 'k2',
        children: [
          jsx('path', { key: 'k0', fill: '#336ef3', d: 'M28.04 151c0-13.96 0-20.93 1.72-26.61a40 40 0 0 1 26.67-26.67C62.11 96 69.09 96 83.04 96h17a38 38 0 1 1 0 76H45.58c-5.16 0-7.74 0-9.79-.78a12 12 0 0 1-6.96-6.96c-.78-2.06-.78-4.64-.78-9.79z' }),
          jsx('path', { key: 'k1', fill: '#3186ff', d: 'M52.04 136a40 40 0 0 1 40-40h34a38 38 0 1 1 0 76h-62a12 12 0 0 1-12-12z' }),
          jsx('g', {
            key: 'k2',
            clipPath: 'url(#gw-contacts-clippath)',
            children: jsx('image', { href: CONTACTS_2026_FADE_PNG, width: '759', height: '651', transform: 'matrix(.24 0 0 .24 -16.08 55.92)' }),
          }),
          jsx('path', { key: 'k3', fill: '#3186ff', d: 'M96.04 80a34 34 0 1 0 0-68 34 34 0 0 0 0 68' }),
        ],
      }),
    ],
  })
}

const APP_ICONS = {
  gmail: GmailIcon,
  calendar: CalendarIcon,
  drive: DriveIcon,
  docs: DocsIcon,
  sheets: SheetsIcon,
  contacts: ContactsIcon,
}

const appIcon = (service) => APP_ICONS[service] || GoogleG

function ServiceIcon({ service, size = '0.9rem' }) {
  const Mark = appIcon(service)
  return jsx(Mark, { size })
}

function Spinner({ size = '0.9rem' }) {
  return jsx(Codicon, { name: 'refresh', size, spinning: true })
}

function Panel({ children, style, ...props }) {
  return jsx('section', { ...props, style: { ...surfaceStyle, ...style }, children })
}

function PageHeading({ title, subtitle, actions }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' },
    children: [
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.01em' }, children: title }),
        subtitle ? jsx('p', { style: { margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: subtitle }) : null,
      ] }),
      actions ? jsx('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: actions }) : null,
    ],
  })
}

function SectionHeading({ title, detail, action }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.55rem' },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: '0.5rem', minWidth: 0 }, children: [
        jsx('h3', { style: { margin: 0, fontSize: '0.82rem', fontWeight: 600 }, children: title }),
        detail ? jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)' }, children: detail }) : null,
      ] }),
      action || null,
    ],
  })
}

function Field({ label, hint, children, style }) {
  return jsxs('label', { style: { display: 'block', ...style }, children: [
    jsx('span', { style: labelStyle, children: label }),
    children,
    hint ? jsx('span', { style: { display: 'block', marginTop: '0.3rem', fontSize: '0.68rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.4 }, children: hint }) : null,
  ] })
}

function InlineError({ error, onRetry }) {
  const info = errorInfo(error)
  return jsxs('div', {
    role: 'alert',
    style: {
      ...insetStyle,
      borderColor: 'color-mix(in srgb, var(--ui-red) 40%, var(--ui-stroke-secondary))',
      background: 'color-mix(in srgb, var(--ui-red) 7%, transparent)',
      padding: '0.7rem 0.8rem',
      display: 'flex',
      gap: '0.55rem',
      alignItems: 'flex-start',
    },
    children: [
      jsx(Icon, { name: 'warning', size: '0.9rem', color: 'var(--ui-red)', style: { marginTop: '0.1rem', flexShrink: 0 } }),
      jsxs('div', { style: { minWidth: 0, flex: 1 }, children: [
        jsx('div', { style: { fontSize: '0.78rem', fontWeight: 600 }, children: info.message }),
        info.hint ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', marginTop: '0.2rem', lineHeight: 1.45 }, children: info.hint }) : null,
        info.code === 'not_connected' ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', marginTop: '0.3rem' }, children: 'Reconnect: run the sign-in command shown in Settings, then press Check again.' }) : null,
      ] }),
      onRetry ? jsx(Button, { variant: 'outline', size: 'xs', onClick: onRetry, children: 'Retry' }) : null,
    ],
  })
}

function LoadingBlock({ label = 'Loading…', rows = 3 }) {
  return jsxs('div', { role: 'status', style: { display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.4rem 0' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.78rem', color: 'var(--ui-text-tertiary)' }, children: [jsx(Spinner, {}), label] }),
    ...Array.from({ length: rows }, (_, index) => jsx(Skeleton, { style: { height: index === 0 ? '2.4rem' : '1.8rem', width: '100%', borderRadius: '6px' } }, index)),
  ] })
}

function EmptyBlock({ icon = 'file', title, description, action }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '0.45rem', padding: '2rem 1rem', minHeight: '8rem' },
    children: [
      jsx('div', { style: { width: '2.2rem', height: '2.2rem', borderRadius: '999px', display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--ui-accent) 10%, transparent)' }, children: jsx(Icon, { name: icon, size: '1rem', color: 'var(--ui-accent)' }) }),
      jsx('div', { style: { fontSize: '0.84rem', fontWeight: 600 }, children: title }),
      description ? jsx('div', { style: { fontSize: '0.76rem', color: 'var(--ui-text-tertiary)', maxWidth: '26rem', lineHeight: 1.5 }, children: description }) : null,
      action || null,
    ],
  })
}

// The right-hand panel's empty state. The service's own mark sits in the middle of the pane on both
// axes, with the title and a short line underneath, so a blank panel still says what it is for.
// The mark's row is the middle of three equal rows, so it stays on the pane's centre line.
function ServiceEmpty({ service, title, description }) {
  return jsxs('div', {
    style: {
      height: '100%', minHeight: 0, boxSizing: 'border-box', padding: '2rem', textAlign: 'center',
      display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    },
    children: [
      jsx('div', { style: { gridRow: 2, justifySelf: 'center', width: '10rem', height: '10rem', display: 'grid', placeItems: 'center' }, children: jsx(ServiceIcon, { service, size: '10rem' }) }),
      jsxs('div', { style: { gridRow: 3, alignSelf: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.2rem', paddingTop: '1.2rem', minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '1rem', fontWeight: 600, letterSpacing: '-0.01em' }, children: title }),
        description ? jsx('div', { style: { fontSize: '0.8rem', color: 'var(--ui-text-tertiary)', maxWidth: '30rem', lineHeight: 1.55 }, children: description }) : null,
      ] }),
    ],
  })
}

function Avatar({ name, email, size = '1.7rem' }) {
  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      width: size, height: size, borderRadius: '999px', flexShrink: 0,
      display: 'grid', placeItems: 'center',
      background: 'color-mix(in srgb, var(--ui-accent) 16%, var(--ui-bg-tertiary))',
      color: 'var(--ui-text-secondary)', fontSize: `calc(${size} * 0.38)`, fontWeight: 600,
      border: '1px solid color-mix(in srgb, var(--ui-accent) 18%, transparent)',
    },
    children: initials(name, email),
  })
}

function StateDot({ state }) {
  const color = state === 'ready' ? 'var(--ui-accent)' : state === 'needs_permission' ? 'var(--ui-yellow)' : state === 'error' ? 'var(--ui-red)' : 'var(--ui-text-quaternary)'
  return jsx('span', { style: { width: 7, height: 7, borderRadius: '999px', background: color, flexShrink: 0, boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 35%, transparent)` } })
}

function StateBadge({ state }) {
  const map = {
    ready: ['success', 'Ready'],
    needs_permission: ['warn', 'Permission'],
    error: ['destructive', 'Error'],
    untested: ['muted', 'Not checked'],
  }
  const [variant, label] = map[state] || ['muted', state || 'Unknown']
  return jsx(Badge, { variant, size: 'xs', children: label })
}

function LinkAction({ children, onClick, icon = 'link-external' }) {
  return jsxs('button', {
    type: 'button',
    onClick,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '0.28rem', border: 0, padding: 0,
      background: 'transparent', color: 'var(--ui-text-tertiary)', fontSize: '0.72rem',
      cursor: 'pointer', font: 'inherit',
    },
    children: [jsx(Icon, { name: icon, size: '0.72rem' }), children],
  })
}

function CopyRow({ text, label }) {
  return jsxs('div', {
    style: { ...insetStyle, display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.6rem' },
    children: [
      jsx('code', { style: { flex: 1, minWidth: 0, fontSize: '0.72rem', fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)' }, children: text }),
      jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => copyText(text, `${label} copied.`), children: 'Copy' }),
    ],
  })
}

function MetaLine({ icon, children, title }) {
  return jsxs('span', {
    title,
    style: { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', minWidth: 0 },
    children: [jsx(Icon, { name: icon, size: '0.72rem' }), jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children })],
  })
}

// ── Setup ────────────────────────────────────────────────────────────────────

function SetupView({ status, onRetry, retrying }) {
  const setup = status?.setup || {}
  const rows = status?.services || []
  const clientReady = !!setup.clientConfigured
  return jsxs('div', {
    style: { maxWidth: '56rem', margin: '0 auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' },
    children: [
      jsxs('div', { style: { display: 'flex', gap: '0.9rem', alignItems: 'flex-start' }, children: [
        jsx('div', {
          style: { width: '2.6rem', height: '2.6rem', borderRadius: '12px', display: 'grid', placeItems: 'center', flexShrink: 0, background: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--ui-accent) 22%, transparent)' },
          children: jsx(GoogleG, { size: '1.3rem' }),
        }),
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('h2', { style: { margin: 0, fontSize: '1.25rem', fontWeight: 600, letterSpacing: '-0.02em' }, children: 'Connect Google Workspace' }),
          jsx('p', { style: { margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.55, maxWidth: '40rem' }, children: 'Hermes uses your own Google Cloud OAuth client. Nothing is bundled, no token is stored in this plugin, and you can revoke access from your Google Account at any time.' }),
        ] }),
      ] }),

      jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(15rem, 20rem)', gap: '1rem', alignItems: 'start' }, children: [
        jsxs(Panel, { style: { padding: '1rem' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.8rem' }, children: [
            jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)' }, children: '1' }),
            jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 600 }, children: 'Create a Desktop OAuth client' }),
          ] }),
          jsx('p', { style: { margin: '0 0 0.6rem', fontSize: '0.77rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.55 }, children: 'In Google Cloud, enable Gmail, Calendar, Drive, Docs, Sheets, and People, then create an OAuth client of type “Desktop app”.' }),
          jsxs('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(GOOGLE_LINKS.cloud), children: 'Open Google Cloud credentials' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => openUrl(GOOGLE_LINKS.scopes), children: 'Scope guide' }),
          ] }),
        ] }),

        jsxs(Panel, { style: { padding: '1rem' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }, children: [
            jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)' }, children: '2' }),
            jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 600 }, children: 'Client status' }),
          ] }),
          jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.76rem' }, children: [
              jsx(StateDot, { state: clientReady ? 'ready' : 'needs_permission' }),
              jsx('span', { children: clientReady ? 'Client credentials found' : 'Client credentials not found' }),
            ] }),
            jsx('p', { style: { margin: 0, fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.45 }, children: clientReady ? 'They are read from the Hermes environment at request time.' : 'Add them to the Hermes .env file, then restart Hermes Desktop so the backend picks them up.' }),
          ] }),
        ] }),
      ] }),

      jsxs(Panel, { style: { padding: '1rem' }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.7rem' }, children: [
          jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 600, color: 'var(--ui-text-secondary)' }, children: '3' }),
          jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 600 }, children: 'Add the credentials and sign in' }),
        ] }),
        jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.55rem' }, children: [
          jsx('p', { style: { margin: 0, fontSize: '0.75rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: 'Add these two lines to ~/.hermes/.env, replacing the values with the client id and secret Google gave you:' }),
          jsxs('div', { style: { ...insetStyle, padding: '0.6rem', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.7rem', lineHeight: 1.65, color: 'var(--ui-text-secondary)', overflowWrap: 'anywhere' }, children: [
            jsx('div', { children: 'GOOGLE_WORKSPACE_CLIENT_ID=…apps.googleusercontent.com' }),
            jsx('div', { children: 'GOOGLE_WORKSPACE_CLIENT_SECRET=…' }),
          ] }),
          jsx('p', { style: { margin: '0.2rem 0 0', fontSize: '0.75rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: 'Then run this in a terminal. Hermes opens the browser and stores the refresh token in its own credential store:' }),
          jsx(CopyRow, { text: setup.signInCommand || 'hermes auth add google-workspace:google', label: 'Sign-in command' }),
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.15rem' }, children: [
            jsx(Button, { variant: 'default', size: 'sm', onClick: onRetry, loading: retrying, children: retrying ? 'Checking…' : 'I signed in — check again' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => copyText(setup.statusCommand || 'hermes auth status google-workspace:google', 'Status command copied.'), children: 'Copy status command' }),
          ] }),
        ] }),
      ] }),

      jsxs('div', { children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }, children: [
          jsx('h3', { style: { margin: 0, fontSize: '0.82rem', fontWeight: 600 }, children: 'Service access' }),
          jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)' }, children: 'Checked live against Google' }),
        ] }),
        jsx('div', { style: { ...surfaceStyle, overflow: 'hidden' }, children: rows.map((row, index) => jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.65rem 0.8rem', borderTop: index ? '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)' : 'none' },
          children: [
            jsx(ServiceIcon, { service: row.id, size: '0.9rem' }),
            jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
              jsx('div', { style: { fontSize: '0.78rem', fontWeight: 500 }, children: row.label }),
              row.detail ? jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.detail }) : null,
            ] }),
            jsx(StateBadge, { state: row.state }),
          ],
        }, row.id)) }),
      ] }),

      jsxs('p', { style: { margin: 0, fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.5 }, children: [
        'Access is limited to what the features need: Gmail (read, labels, send, drafts), Calendar events, Drive, Docs, Sheets, and Contacts (read and create). Sign out any time with ',
        jsx('code', { style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' }, children: setup.signOutCommand || 'hermes auth logout google-workspace:google' }),
        '.',
      ] }),
    ],
  })
}

// ── Overview ─────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, detail, onClick }) {
  const content = jsxs(Fragment, { children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }, children: [
      jsx('span', { style: { fontSize: '0.7rem', fontWeight: 600, color: 'var(--ui-text-tertiary)' }, children: label }),
      jsx(Icon, { name: icon, size: '0.85rem', color: 'var(--ui-text-quaternary)' }),
    ] }),
    jsx('div', { style: { fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.15, marginTop: '0.45rem' }, children: value }),
    detail ? jsx('div', { style: { fontSize: '0.71rem', color: 'var(--ui-text-quaternary)', marginTop: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: detail }) : null,
  ] })
  if (!onClick) return jsx('div', { style: { ...surfaceStyle, padding: '0.8rem 0.9rem', minWidth: 0 }, children: content })
  return jsx('button', {
    type: 'button', onClick,
    style: { ...surfaceStyle, padding: '0.8rem 0.9rem', minWidth: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' },
    children: content,
  })
}

function MessageRow({ message, onClick, showSnippet = true }) {
  return jsxs('button', {
    type: 'button',
    onClick,
    style: {
      width: '100%', display: 'flex', gap: '0.65rem', alignItems: 'flex-start', textAlign: 'left',
      padding: '0.6rem 0.7rem', border: 0, borderRadius: '7px', background: 'transparent',
      color: 'inherit', font: 'inherit', cursor: 'pointer', transition: rowTransition,
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: [
      jsx(Avatar, { name: senderName(message.from), email: senderEmail(message.from), size: '1.55rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }, children: [
            message.unread ? jsx('span', { style: { width: 6, height: 6, borderRadius: '999px', background: 'var(--ui-accent)', flexShrink: 0 } }) : null,
            jsx('span', { style: { fontSize: '0.78rem', fontWeight: message.unread ? 650 : 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: senderName(message.from) }),
          ] }),
          jsx('span', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)', flexShrink: 0 }, children: fmtRelative(message.received || message.date) }),
        ] }),
        jsx('div', { style: { fontSize: '0.77rem', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: message.subject }),
        showSnippet && message.snippet ? jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: message.snippet }) : null,
      ] }),
    ],
  })
}

function EventRow({ event, onClick, showDay = false }) {
  return jsxs('button', {
    type: 'button', onClick,
    style: {
      width: '100%', display: 'flex', gap: '0.65rem', alignItems: 'flex-start', textAlign: 'left',
      padding: '0.55rem 0.7rem', border: 0, borderRadius: '7px', background: 'transparent',
      color: 'inherit', font: 'inherit', cursor: 'pointer', transition: rowTransition,
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: [
      jsxs('div', { style: { width: '4.2rem', flexShrink: 0, textAlign: 'right', paddingTop: '0.05rem' }, children: [
        jsx('div', { style: { fontSize: '0.73rem', fontWeight: 600, color: 'var(--ui-text-secondary)' }, children: event.allDay ? 'All day' : fmtTime(event.start) }),
        showDay ? jsx('div', { style: { fontSize: '0.65rem', color: 'var(--ui-text-quaternary)' }, children: fmtDay(event.start) }) : null,
      ] }),
      jsxs('div', { style: { flex: 1, minWidth: 0, borderLeft: '2px solid color-mix(in srgb, var(--ui-accent) 35%, transparent)', paddingLeft: '0.6rem' }, children: [
        jsx('div', { style: { fontSize: '0.78rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: event.summary }),
        jsxs('div', { style: { display: 'flex', gap: '0.6rem', marginTop: '0.15rem', flexWrap: 'wrap' }, children: [
          event.location ? jsx(MetaLine, { icon: 'location', children: event.location }) : null,
          event.attendeeCount ? jsx(MetaLine, { icon: 'organization', children: `${event.attendeeCount} guest${event.attendeeCount === 1 ? '' : 's'}` }) : null,
          event.meetingLink ? jsx(MetaLine, { icon: 'device-camera-video', children: 'Video call' }) : null,
        ] }),
      ] }),
    ],
  })
}

function FileRow({ file, onClick }) {
  return jsxs('button', {
    type: 'button', onClick,
    style: {
      width: '100%', display: 'flex', gap: '0.6rem', alignItems: 'center', textAlign: 'left',
      padding: '0.55rem 0.7rem', border: 0, borderRadius: '7px', background: 'transparent',
      color: 'inherit', font: 'inherit', cursor: 'pointer', transition: rowTransition,
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: [
      jsx('span', { style: { width: '1.7rem', height: '1.7rem', borderRadius: '6px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', flexShrink: 0 }, children: jsx(Icon, { name: fileIcon(file.mimeType), size: '0.85rem', color: 'var(--ui-text-tertiary)' }) }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '0.77rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }),
        jsxs('div', { style: { display: 'flex', gap: '0.5rem', fontSize: '0.67rem', color: 'var(--ui-text-quaternary)', marginTop: '0.1rem' }, children: [
          jsx('span', { children: mimeLabel(file.mimeType) }),
          file.modified ? jsx('span', { children: `· ${fmtRelative(file.modified)}` }) : null,
          file.size ? jsx('span', { children: `· ${fmtBytes(file.size)}` }) : null,
        ] }),
      ] }),
    ],
  })
}

function WorkflowCard({ icon, title, detail, action, onClick }) {
  return jsxs('button', {
    type: 'button', onClick,
    style: { ...surfaceStyle, padding: '0.8rem', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', display: 'flex', flexDirection: 'column', gap: '0.35rem', minWidth: 0 },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem' }, children: [
        jsx(Icon, { name: icon, size: '0.85rem', color: 'var(--ui-accent)' }),
        jsx('span', { style: { fontSize: '0.78rem', fontWeight: 600 }, children: title }),
      ] }),
      jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.45 }, children: detail }),
      jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-tertiary)', marginTop: '0.1rem' }, children: action }),
    ],
  })
}

// One query across Gmail, Calendar and Drive. Each result says which service it came from.
function GlobalSearch({ onOpenMessage, onOpenEvent, onOpenFile }) {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const result = useApi(`/search?query=${encodeURIComponent(query)}`, { enabled: !!query, extra: [query] })
  const data = result.data || {}
  const groups = [
    { key: 'messages', service: 'Gmail', items: data.messages || [] },
    { key: 'events', service: 'Calendar', items: data.events || [] },
    { key: 'files', service: 'Drive', items: data.files || [] },
  ]
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const submit = () => setQuery(text.trim())

  function renderItem(group, item) {
    if (group.key === 'messages') return jsx(MessageRow, { message: item, onClick: () => onOpenMessage(item.id) }, item.id)
    if (group.key === 'events') return jsx(EventRow, { event: item, onClick: () => onOpenEvent(item), showDay: true }, item.id)
    return jsx(FileRow, { file: item, onClick: () => onOpenFile(item) }, item.id)
  }

  return jsxs(Panel, { style: { padding: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
    jsxs('div', { style: { display: 'flex', gap: '0.35rem' }, children: [
      jsx(SearchField, {
        placeholder: 'Search Gmail, Calendar and Drive at once',
        value: text,
        onChange: setText,
        onKeyDown: (event) => { if (event.key === 'Enter') submit() },
        variant: 'box',
        'aria-label': 'Search across Google Workspace',
      }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: submit, disabled: !text.trim(), children: 'Search' }),
    ] }),
    !query ? null
      : result.isPending ? jsx(LoadingBlock, { label: `Searching for “${query}”…`, rows: 3 })
      : result.isError ? jsx(InlineError, { error: result.error, onRetry: result.refetch })
      : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
        total === 0 ? jsx(EmptyBlock, { icon: 'search', title: 'Nothing matched', description: `No Gmail, Calendar or Drive item matched “${query}”.` }) : null,
        ...groups.filter((group) => group.items.length).map((group) => jsxs('div', { children: [
          jsx(SectionHeading, { title: group.service, detail: plural(group.items.length, 'result') }),
          jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: group.items.map((item) => renderItem(group, item)) }),
        ] }, group.key)),
        ...Object.entries(data.errors || {}).map(([key, error]) => jsx(InlineError, { error }, key)),
      ] }),
  ] })
}

// ── Overview widgets ─────────────────────────────────────────────────────────
// The home tab is a grid of widgets. The arrangement — order and which widgets are
// hidden — is saved per profile through ctx.storage, so each person keeps their own.

const WIDGET_DEFS = [
  { id: 'search', label: 'Search', span: 'full' },
  { id: 'stats', label: 'At a glance', span: 'full' },
  { id: 'agenda', label: 'Today and tomorrow', span: 'half' },
  { id: 'inbox', label: 'Inbox', span: 'half' },
  { id: 'drive', label: 'Recent Drive files', span: 'half' },
  { id: 'workflows', label: 'Workflows', span: 'half' },
]

const DEFAULT_LAYOUT = { order: WIDGET_DEFS.map((def) => def.id), hidden: [] }

const widgetDef = (id) => WIDGET_DEFS.find((def) => def.id === id) || WIDGET_DEFS[0]

// Keep the stored layout valid: only known widget ids, every widget present exactly
// once, and `hidden` a subset of `order`. A corrupt or old value falls back to default.
function normalizeLayout(value) {
  if (!value || !Array.isArray(value.order)) return null
  const order = value.order.filter((id) => WIDGET_DEFS.some((def) => def.id === id))
  for (const def of WIDGET_DEFS) if (!order.includes(def.id)) order.push(def.id)
  const hidden = Array.isArray(value.hidden) ? value.hidden.filter((id) => order.includes(id)) : []
  return { order, hidden }
}

function readStoredLayout() {
  try {
    return normalizeLayout(pluginCtx?.storage?.get?.('overview.layout', null)) || DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

function useOverviewLayout() {
  const [layout, setLayoutState] = useState(readStoredLayout)
  const ref = useRef(layout)
  // Accepts a value or an updater, so a drag can reorder against the latest layout
  // without a stale closure.
  const setLayout = (updater) => {
    const next = typeof updater === 'function' ? updater(ref.current) : updater
    const clean = normalizeLayout(next) || DEFAULT_LAYOUT
    ref.current = clean
    setLayoutState(clean)
    try { pluginCtx?.storage?.set?.('overview.layout', clean) } catch { /* storage is optional */ }
  }
  return [layout, setLayout]
}

function WidgetButton({ icon, label, onClick }) {
  return jsx('button', {
    type: 'button',
    onClick,
    'aria-label': label,
    title: label,
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '1.4rem', height: '1.4rem', padding: 0, border: 0, borderRadius: '5px',
      background: 'transparent', color: 'var(--ui-text-tertiary)', cursor: 'pointer', font: 'inherit',
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: jsx(Icon, { name: icon, size: '0.8rem' }),
  })
}

// Placeholder shown while the overview is loading. It keeps the grid's shape so the
// widgets do not jump when the data arrives.
function WidgetSkeleton({ rows = 3 }) {
  return jsxs('div', {
    style: { ...surfaceStyle, padding: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' },
    children: [
      jsx(Skeleton, { style: { height: '0.95rem', width: '38%', borderRadius: '6px' } }),
      ...Array.from({ length: rows }, (_, index) => jsx(Skeleton, { style: { height: '1.9rem', width: '100%', borderRadius: '6px' } }, index)),
    ],
  })
}

// A widget plus, in edit mode, a drag handle and a hide button. The toolbar floats over
// the widget's corner so it never pushes the content around. The frame carries a ref so
// the drag logic can measure the real grid cells.
const WidgetFrame = forwardRef(function WidgetFrame({ def, editing, dragging, dropTarget, onDragStart, onHide, children }, ref) {
  return jsxs('div', {
    ref,
    'data-widget-id': def.id,
    style: {
      gridColumn: def.span === 'full' ? '1 / -1' : undefined,
      position: 'relative',
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      outline: editing ? `1px dashed ${dropTarget ? 'var(--ui-accent)' : 'color-mix(in srgb, var(--ui-stroke-secondary) 90%, transparent)'}` : undefined,
      outlineOffset: editing ? '3px' : undefined,
      borderRadius: editing ? '12px' : undefined,
      opacity: dragging ? 0.5 : 1,
      transition: rowTransition,
    },
    children: [
      children,
      editing ? jsxs('div', {
        style: {
          position: 'absolute', top: '0.4rem', right: '0.4rem', zIndex: 3,
          display: 'flex', gap: '0.1rem', padding: '0.12rem',
          background: 'var(--ui-bg-secondary)', border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: '8px',
        },
        children: [
          jsx('button', {
            type: 'button',
            'aria-label': `Drag ${def.label}`,
            title: `Drag ${def.label}`,
            onPointerDown: (event) => onDragStart(def.id, event),
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '1.5rem', height: '1.4rem', padding: 0, border: 0, borderRadius: '5px',
              background: 'transparent', color: 'var(--ui-text-tertiary)', cursor: 'grab', font: 'inherit',
              touchAction: 'none',
            },
            children: jsx(Icon, { name: 'gripper', size: '0.9rem' }),
          }),
          jsx(WidgetButton, { icon: 'close', label: `Hide ${def.label}`, onClick: () => onHide(def.id) }),
        ],
      }) : null,
    ],
  })
})

function OverviewTab({ status, overview, onOpenMessage, onOpenEvent, onOpenFile, onCompose, onEvent, onBrief, onOrganize, onInvoices }) {
  const data = overview.data || {}
  const errors = data.errors || {}
  const nextEvent = (data.events || [])[0]
  const unread = data.unread || 0
  const [layout, setLayout] = useOverviewLayout()
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const itemNodes = useRef(new Map())
  const overIdRef = useRef(null)

  const visible = layout.order.filter((id) => !layout.hidden.includes(id))
  const hiddenDefs = WIDGET_DEFS.filter((def) => layout.hidden.includes(def.id))

  const registerItem = (id) => (node) => {
    if (node) itemNodes.current.set(id, node)
    else itemNodes.current.delete(id)
  }

  // Drop the dragged widget at the target's position in the order.
  function dropOn(id, targetId) {
    setLayout((prev) => {
      const from = prev.order.indexOf(id)
      const to = prev.order.indexOf(targetId)
      if (from < 0 || to < 0 || from === to) return prev
      const order = [...prev.order]
      order.splice(to, 0, order.splice(from, 1)[0])
      return { ...prev, order }
    })
  }

  // Pointer-driven drag: track the pointer, find the cell it is over, and live-reorder.
  function startDrag(id, event) {
    event.preventDefault()
    setDragId(id)
    overIdRef.current = null
    const onMove = (pointer) => {
      const x = pointer.clientX
      const y = pointer.clientY
      let hit = null
      for (const [key, node] of itemNodes.current) {
        if (key === id) continue
        const rect = node.getBoundingClientRect()
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) { hit = key; break }
      }
      if (hit && hit !== overIdRef.current) {
        overIdRef.current = hit
        setOverId(hit)
        dropOn(id, hit)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      overIdRef.current = null
      setDragId(null)
      setOverId(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function hide(id) { setLayout((prev) => ({ ...prev, hidden: [...prev.hidden, id] })) }
  function show(id) { setLayout((prev) => ({ ...prev, hidden: prev.hidden.filter((item) => item !== id) })) }
  function resetLayout() { setLayout(DEFAULT_LAYOUT) }

  const loading = overview.isPending
  const failed = overview.isError

  function renderWidget(id) {
    // Search and workflows read nothing from the overview, so they are always available.
    if (id === 'search') return jsx(GlobalSearch, { onOpenMessage, onOpenEvent, onOpenFile })
    if (id === 'workflows') return jsxs(Panel, { style: { padding: '0.8rem' }, children: [
      jsx(SectionHeading, { title: 'Workflows', detail: 'The cross-app part' }),
      jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }, children: [
        jsx(WorkflowCard, { icon: 'note', title: 'Meeting brief', detail: 'Attendees, recent threads, related files, and an agenda in one page.', action: 'Pick a meeting →', onClick: () => onBrief(null) }),
        jsx(WorkflowCard, { icon: 'calendar', title: 'Email → event', detail: 'Read a date from a message and create the invitation.', action: 'Start from Gmail →', onClick: () => onOpenMessage(null) }),
        jsx(WorkflowCard, { icon: 'table', title: 'Invoices → Sheet', detail: 'Find invoice attachments and append a reviewable row per file.', action: 'Scan inbox →', onClick: onInvoices }),
        jsx(WorkflowCard, { icon: 'folder', title: 'Organize Drive', detail: 'Preview matching files, then move them into one folder.', action: 'Build a move plan →', onClick: onOrganize }),
      ] }),
    ] })
    if (loading) return jsx(WidgetSkeleton, { rows: id === 'stats' ? 3 : 4 })
    if (failed) return jsx(InlineError, { error: overview.error, onRetry: overview.refetch })
    if (id === 'stats') return jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.6rem' }, children: [
      jsx(StatCard, { icon: 'mail', label: 'Unread', value: unread, detail: unread ? 'Waiting in your inbox' : 'Inbox is clear', onClick: () => onOpenMessage(null) }),
      jsx(StatCard, { icon: 'calendar', label: 'Next up', value: nextEvent ? fmtTime(nextEvent.start) : '—', detail: nextEvent ? nextEvent.summary : 'No events in the next day', onClick: () => onOpenEvent(nextEvent || null) }),
      jsx(StatCard, { icon: 'cloud', label: 'Recent files', value: (data.files || []).length, detail: 'Changed in Drive', onClick: () => onOpenFile(null) }),
    ] })
    if (id === 'agenda') return jsxs(Panel, { style: { padding: '0.7rem' }, children: [
      jsx(SectionHeading, { title: 'Today and tomorrow', detail: (data.events || []).length ? `${(data.events || []).length} event${(data.events || []).length === 1 ? '' : 's'}` : '', action: jsx(LinkAction, { icon: 'calendar', onClick: () => onOpenEvent(null), children: 'Calendar' }) }),
      errors.calendar ? jsx(InlineError, { error: errors.calendar, onRetry: overview.refetch }) : null,
      (data.events || []).length
        ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.1rem' }, children: (data.events || []).slice(0, 6).map((event) => jsx(EventRow, { event, onClick: () => onOpenEvent(event), showDay: true }, event.id)) })
        : !errors.calendar ? jsx(EmptyBlock, { icon: 'calendar', title: 'No meetings on the horizon', description: 'Enjoy the quiet, or put something on the calendar.', action: jsx(Button, { variant: 'outline', size: 'xs', onClick: onEvent, children: 'New event' }) }) : null,
    ] })
    if (id === 'inbox') return jsxs(Panel, { style: { padding: '0.7rem' }, children: [
      jsx(SectionHeading, { title: 'Inbox', detail: unread ? `${unread} unread` : 'All read', action: jsx(LinkAction, { icon: 'mail', onClick: () => onOpenMessage(null), children: 'Gmail' }) }),
      errors.gmail_inbox ? jsx(InlineError, { error: errors.gmail_inbox, onRetry: overview.refetch }) : null,
      (data.messages || []).length
        ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (data.messages || []).map((message) => jsx(MessageRow, { message, onClick: () => onOpenMessage(message.id) }, message.id)) })
        : !errors.gmail_inbox ? jsx(EmptyBlock, { icon: 'mail', title: 'Nothing new', description: 'The inbox is quiet.' }) : null,
    ] })
    return jsxs(Panel, { style: { padding: '0.7rem' }, children: [
      jsx(SectionHeading, { title: 'Recent Drive files', detail: 'Most recently modified', action: jsx(LinkAction, { icon: 'cloud', onClick: () => onOpenFile(null), children: 'Drive' }) }),
      errors.drive ? jsx(InlineError, { error: errors.drive, onRetry: overview.refetch }) : null,
      (data.files || []).length
        ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (data.files || []).map((file) => jsx(FileRow, { file, onClick: () => onOpenFile(file) }, file.id)) })
        : !errors.drive ? jsx(EmptyBlock, { icon: 'cloud', title: 'No files yet', description: 'Files you own or can edit show up here.' }) : null,
    ] })
  }

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', paddingBottom: '1.5rem' }, children: [
    jsx(PageHeading, {
      title: 'Your Google work, without the tab hunt',
      subtitle: status?.account ? `Signed in as ${status.account}. Reads are automatic; sends and shares wait for you.` : 'Reads are automatic; sends and shares wait for you.',
      actions: [
        jsx(Button, { key: 'customize', variant: editing ? 'secondary' : 'outline', size: 'sm', onClick: () => setEditing((value) => !value), children: editing ? 'Done' : 'Customize' }),
        jsx(Button, { key: 'compose', variant: 'outline', size: 'sm', onClick: onCompose, children: 'Compose' }),
        jsx(Button, { key: 'event', variant: 'ghost', size: 'sm', onClick: onEvent, children: 'New event' }),
      ],
    }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gridAutoFlow: 'dense', gap: '0.8rem', alignItems: 'start' },
      children: [
        ...visible.map((id) => jsx(WidgetFrame, {
          ref: registerItem(id),
          def: widgetDef(id),
          editing,
          dragging: dragId === id,
          dropTarget: overId === id,
          onDragStart: startDrag,
          onHide: hide,
          children: renderWidget(id),
        }, id)),
        editing && hiddenDefs.length ? jsxs('div', {
          style: { gridColumn: '1 / -1', display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.6rem 0.7rem', borderRadius: '10px', border: '1px dashed color-mix(in srgb, var(--ui-stroke-secondary) 80%, transparent)' },
          children: [
            jsx('span', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)' }, children: 'Hidden widgets' }),
            ...hiddenDefs.map((def) => jsx(Button, { variant: 'outline', size: 'xs', onClick: () => show(def.id), children: `Add ${def.label}` }, def.id)),
            jsx(Button, { variant: 'ghost', size: 'xs', onClick: resetLayout, children: 'Reset to default' }),
          ],
        }, 'hidden-widgets') : null,
      ],
    }),

    jsx('div', { style: { fontSize: '0.69rem', color: 'var(--ui-text-quaternary)', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }, children: [
      jsx('span', { children: `Snapshot ${fmtTime(data.generatedAt)}` }),
      jsx('span', { children: '·' }),
      jsx(LinkAction, { icon: 'shield', onClick: () => openUrl('https://myaccount.google.com/permissions'), children: 'Manage Google access' }),
    ] }),
  ] })
}

// ── Gmail ────────────────────────────────────────────────────────────────────

function GmailTab({ selectedId, onSelect, onCompose, onEmailToEvent, narrow }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [pageToken, setPageToken] = useState('')
  const path = `/gmail?query=${encodeURIComponent(query)}&max_results=25${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`
  const list = useApi(path, { extra: [query, pageToken] })
  const detail = useApi(`/gmail/${encodeURIComponent(selectedId || '')}`, { enabled: !!selectedId })

  function submitSearch() {
    setPageToken('')
    setQuery(search.trim())
    onSelect(null)
  }

  const showList = !narrow || !selectedId
  const showDetail = !narrow || !!selectedId

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.35rem', flex: 1, minWidth: '14rem' }, children: [
        jsx(SearchField, {
          placeholder: 'Search Gmail — try from:alex, has:attachment, newer_than:7d',
          value: search,
          onChange: setSearch,
          onKeyDown: (event) => { if (event.key === 'Enter') submitSearch() },
          variant: 'box',
          'aria-label': 'Search Gmail',
        }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: submitSearch, children: 'Search' }),
      ] }),
      query ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => { setSearch(''); setQuery(''); setPageToken(''); onSelect(null) }, children: 'Clear' }) : null,
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => onCompose({}), children: 'Compose' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(16rem, 23rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsxs(Panel, { style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.55rem 0.7rem', borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)' }, children: [
            jsx('span', { style: { fontSize: '0.72rem', fontWeight: 600, color: 'var(--ui-text-tertiary)' }, children: query ? `Results for “${query}”` : 'Inbox' }),
            jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => list.refetch(), children: 'Refresh' }),
          ] }),
          jsxs('div', { style: { overflow: 'auto', minHeight: 0, padding: '0.3rem' }, children: [
            list.isPending ? jsx(LoadingBlock, { label: 'Loading messages…', rows: 6 })
              : list.isError ? jsx(InlineError, { error: list.error, onRetry: list.refetch })
              : !(list.data?.messages || []).length ? jsx(EmptyBlock, { icon: 'mail', title: query ? 'Nothing matched' : 'Inbox is clear', description: query ? 'Try a broader Gmail query, or clear the search.' : 'No messages in the inbox right now.' })
              : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (list.data.messages || []).map((message) => jsx('div', {
                style: { borderRadius: '7px', background: message.id === selectedId ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
                children: jsx(MessageRow, { message, onClick: () => onSelect(message.id) }),
              }, message.id)) }),
            list.data?.nextPageToken ? jsx('div', { style: { padding: '0.55rem 0.4rem' }, children: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setPageToken(list.data.nextPageToken), children: 'Load more' }) }) : null,
          ] }),
        ] }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }, children: [
          selectedId ? jsxs(Fragment, { children: [
            jsxs('div', { style: { padding: '0.7rem 0.85rem', borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)', display: 'flex', alignItems: 'center', gap: '0.45rem' }, children: [
              narrow ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => onSelect(null), children: 'Back' }) : null,
              jsx(Icon, { name: 'mail-read', size: '0.85rem', color: 'var(--ui-text-quaternary)' }),
              jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)' }, children: 'Message' }),
              jsx('span', { style: { flex: 1 } }),
              detail.data ? jsx(LinkAction, { onClick: () => openUrl(detail.data.webUrl), children: 'Open in Gmail' }) : null,
            ] }),
            jsx('div', { style: { overflow: 'auto', minHeight: 0, padding: '1rem' }, children: detail.isPending
              ? jsx(LoadingBlock, { label: 'Opening message…', rows: 5 })
              : detail.isError ? jsx(InlineError, { error: detail.error, onRetry: detail.refetch })
              : jsx(MessageDetail, { message: detail.data, onCompose, onEmailToEvent, onSelect }) }),
          ] }) : jsx(ServiceEmpty, { service: 'gmail', title: 'Pick a message', description: 'Select a conversation on the left. Reads stay private; nothing is marked or sent without a button.' }),
        ] }) : null,
      ],
    }),
  ] })
}

function MessageDetail({ message, onCompose, onEmailToEvent, onSelect }) {
  const [busy, setBusy] = useState('')
  const labels = message.labels || []
  const starred = labels.includes('STARRED')
  const inInbox = labels.includes('INBOX')

  // Reversible label changes. They notify nobody, so they run without an approval step.
  async function modify(action) {
    setBusy(action)
    try {
      await post(`/gmail/${encodeURIComponent(message.id)}/modify`, { action })
      refreshEverything()
      if (action === 'archive' || action === 'trash') onSelect(null)
    } catch (err) {
      host.notify({ kind: 'error', message: errorInfo(err, 'Could not change that message.').message })
    } finally {
      setBusy('')
    }
  }

  const replyTo = senderEmail(message.from)
  const replySubject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`
  const recipients = [message.to, message.cc].filter(Boolean).join(', ')
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem' }, children: [
    jsxs('div', { style: { display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }, children: [
      jsx(Avatar, { name: senderName(message.from), email: replyTo, size: '2.1rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }, children: [
          jsxs('div', { style: { minWidth: 0 }, children: [
            jsx('h2', { style: { margin: 0, fontSize: '1.02rem', fontWeight: 600, lineHeight: 1.35 }, children: message.subject }),
            jsxs('div', { style: { marginTop: '0.35rem', fontSize: '0.75rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: [
              jsx('strong', { style: { color: 'var(--ui-text-secondary)', fontWeight: 600 }, children: senderName(message.from) }),
              replyTo ? jsx('span', { children: ` <${replyTo}>` }) : null,
            ] }),
          ] }),
          jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', textAlign: 'right', flexShrink: 0 }, children: fmtDateTime(message.received || message.date) }),
        ] }),
        jsxs('div', { style: { display: 'flex', gap: '0.8rem', flexWrap: 'wrap', marginTop: '0.45rem' }, children: [
          recipients ? jsx(MetaLine, { icon: 'person', children: `to ${recipients}`, title: recipients }) : null,
          message.hasAttachments ? jsx(MetaLine, { icon: 'paperclip', children: `${(message.attachments || []).length || 'Has'} attachment${(message.attachments || []).length === 1 ? '' : 's'}` }) : null,
          message.unread ? jsx(MetaLine, { icon: 'circle-filled', children: 'Unread' }) : null,
        ] }),
      ] }),
    ] }),

    jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsx(Button, { variant: 'default', size: 'sm', onClick: () => onCompose({ to: replyTo, subject: replySubject, threadId: message.threadId, inReplyTo: message.messageIdHeader || '', body: `\n\nOn ${fmtDateTime(message.received || message.date)}, ${senderName(message.from)} wrote:\n${(message.body || '').split('\n').map((line) => `> ${line}`).join('\n')}` }), children: 'Reply' }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => onCompose({ subject: `Fwd: ${message.subject}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${message.from}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${message.body || ''}` }), children: 'Forward' }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => onEmailToEvent(message), children: 'Create event' }),
    ] }),

    jsxs('div', { style: { display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '-0.5rem' }, children: [
      jsx(Button, { variant: 'ghost', size: 'xs', loading: busy === 'mark_read' || busy === 'mark_unread', onClick: () => modify(message.unread ? 'mark_read' : 'mark_unread'), children: message.unread ? 'Mark as read' : 'Mark as unread' }),
      jsx(Button, { variant: 'ghost', size: 'xs', loading: busy === 'star' || busy === 'unstar', onClick: () => modify(starred ? 'unstar' : 'star'), children: starred ? 'Unstar' : 'Star' }),
      inInbox ? jsx(Button, { variant: 'ghost', size: 'xs', loading: busy === 'archive', onClick: () => modify('archive'), children: 'Archive' }) : null,
      jsx(Button, { variant: 'ghost', size: 'xs', loading: busy === 'trash', onClick: () => modify('trash'), children: 'Trash' }),
    ] }),

    jsx(Separator, {}),

    message.body
      ? jsx('div', { style: { fontSize: '0.82rem', lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)' }, children: message.body })
      : jsx(EmptyBlock, { icon: 'mail', title: 'No readable body', description: 'This message may contain only HTML that could not be converted, or the body was too large.' }),

    (message.attachments || []).length ? jsxs('div', { style: { ...insetStyle, padding: '0.65rem' }, children: [
      jsx('div', { style: { fontSize: '0.7rem', fontWeight: 600, color: 'var(--ui-text-tertiary)', marginBottom: '0.4rem' }, children: 'Attachments' }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.3rem' }, children: [
        message.attachments.map((attachment, index) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.74rem' }, children: [
          jsx(Icon, { name: 'file', size: '0.8rem', color: 'var(--ui-text-quaternary)' }),
          jsx('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: attachment.filename }),
          jsx('span', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: fmtBytes(attachment.size) }),
        ] }, `${attachment.filename}-${index}`)),
        jsx('span', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: 'Open the message in Gmail to download attachments.' }),
      ] }),
    ] }) : null,
  ] })
}

function ComposeDialog({ initial, onClose }) {
  const source = initial || {}
  const [to, setTo] = useState(source.to || '')
  const [cc, setCc] = useState(source.cc || '')
  const [bcc, setBcc] = useState(source.bcc || '')
  const [subject, setSubject] = useState(source.subject || '')
  const [body, setBody] = useState(source.body || '')
  const [showCc, setShowCc] = useState(!!(source.cc || source.bcc))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState(null)

  const recipients = [to, cc, bcc].map((value) => value.trim()).filter(Boolean)
  const ready = !!to.trim() && !!subject.trim()

  async function send() {
    try {
      const result = await post('/send', {
        to: to.trim(), cc: cc.trim(), bcc: bcc.trim(), subject: subject.trim(), body,
        thread_id: source.threadId || '', in_reply_to: source.inReplyTo || '', confirm: true,
      })
      refreshEverything()
      host.notify({ kind: 'success', message: `Sent to ${to.trim()}.`, title: 'Email sent' })
      try { if (result?.webUrl) pluginCtx?.storage?.set?.('lastSentUrl', result.webUrl) } catch { /* optional */ }
      onClose()
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not send the email.').message)
    }
  }

  async function saveDraft() {
    setBusy(true)
    setError(null)
    try {
      const result = await post('/draft', {
        to: to.trim(), cc: cc.trim(), bcc: bcc.trim(), subject: subject.trim(), body,
        thread_id: source.threadId || '', in_reply_to: source.inReplyTo || '',
      })
      setDraft(result)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Draft saved in Gmail.' })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-2xl',
      bodyClassName: 'gap-3 p-0 overflow-hidden',
      children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 }, children: [
        jsx(DialogHeader, { style: { padding: '1rem 1rem 0.4rem' }, children: jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', paddingRight: '1.5rem' }, children: [
          jsxs('div', { children: [
            jsx(DialogTitle, { children: source.threadId ? 'Reply' : 'New message' }),
            jsx(DialogDescription, { children: source.threadId ? 'The reply stays in the same Gmail thread.' : 'Sending is the only step that leaves your account.' }),
          ] }),
          jsx('span', { style: { fontSize: '0.68rem', color: 'var(--ui-text-quaternary)' }, children: '⌘/Ctrl + Enter' }),
        ] }) }),

        jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.55rem', padding: '0.4rem 1rem', overflow: 'auto', minHeight: 0 }, children: [
          jsxs('div', { style: { display: 'flex', gap: '0.4rem', alignItems: 'flex-end' }, children: [
            jsx(Field, { label: 'To', style: { flex: 1 }, children: jsx(Input, { value: to, onChange: (event) => setTo(event.target.value), placeholder: 'name@company.com', autoFocus: true, style: inputStyle }) }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setShowCc((value) => !value), children: showCc ? 'Hide Cc' : 'Cc/Bcc' }),
          ] }),
          showCc ? jsxs('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }, children: [
            jsx(Field, { label: 'Cc', children: jsx(Input, { value: cc, onChange: (event) => setCc(event.target.value), placeholder: 'optional' }) }),
            jsx(Field, { label: 'Bcc', children: jsx(Input, { value: bcc, onChange: (event) => setBcc(event.target.value), placeholder: 'optional' }) }),
          ] }) : null,
          jsx(Field, { label: 'Subject', children: jsx(Input, { value: subject, onChange: (event) => setSubject(event.target.value), placeholder: 'What is this about?', style: inputStyle }) }),
          jsx(Field, { label: 'Message', children: jsx(Textarea, {
            value: body,
            onChange: (event) => setBody(event.target.value),
            placeholder: 'Write like a person. Short sentences land better.',
            style: { width: '100%', minHeight: '13rem', resize: 'vertical', lineHeight: 1.55 },
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && ready) {
                event.preventDefault()
                setConfirmOpen(true)
              }
            },
          }) }),
          error ? jsx(InlineError, { error }) : null,
          draft ? jsxs('div', { style: { ...insetStyle, padding: '0.55rem 0.65rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }, children: [
            jsx(Icon, { name: 'check', size: '0.8rem', color: 'var(--ui-accent)' }),
            jsx('span', { style: { fontSize: '0.73rem', flex: 1 }, children: 'Saved to Gmail drafts.' }),
            jsx(LinkAction, { icon: 'link-external', onClick: () => openUrl(draft.webUrl), children: 'Open drafts' }),
          ] }) : null,
        ] }),

        jsx(DialogFooter, { style: { padding: '0.6rem 1rem 0.9rem', display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }, children: [
          jsx('span', { style: { flex: 1, fontSize: '0.68rem', color: 'var(--ui-text-quaternary)' }, children: ready ? `${recipients.length} recipient${recipients.length === 1 ? '' : 's'} · nothing sent yet` : 'Add a recipient and subject to send' }),
          jsx(Button, { variant: 'ghost', size: 'sm', onClick: saveDraft, loading: busy, disabled: !to.trim(), children: 'Save draft' }),
          jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
          jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !ready, children: 'Send…' }),
        ] }),
      ] }),
    }) }),

    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: send,
      title: 'Send this email?',
      description: `It goes to ${recipients.join(', ')}. This is the point of no return.`,
      confirmLabel: 'Send email',
      busyLabel: 'Sending…',
      doneLabel: 'Sent',
      children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.5rem' }, children: [
        jsxs('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem' }, children: [
          jsxs('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', display: 'flex', flexDirection: 'column', gap: '0.15rem' }, children: [
            jsx('div', { children: jsxs('strong', { children: ['To: ', to.trim()] }) }),
            cc.trim() ? jsx('div', { children: `Cc: ${cc.trim()}` }) : null,
            bcc.trim() ? jsx('div', { children: `Bcc: ${bcc.trim()}` }) : null,
            jsx('div', { children: `Subject: ${subject.trim() || '(no subject)'}` }),
          ] }),
        ] }),
        jsx('div', { style: { maxHeight: '10rem', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.75rem', lineHeight: 1.55, color: 'var(--ui-text-secondary)' }, children: body.trim() || '(empty body)' }),
      ] }),
    }),
  ] })
}

function EmailToEventDialog({ message, onClose }) {
  const proposal = useApi(`/email-to-event?message_id=${encodeURIComponent(message.id)}&duration_minutes=60`, { extra: [message.id] })
  const data = proposal.data
  const [summary, setSummary] = useState('')
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState(60)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [created, setCreated] = useState(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    if (!data?.proposal || initialized) return
    setSummary(data.proposal.summary || '')
    setStart(localInputValue(data.proposal.start))
    setDuration(Number(data.proposal.durationMinutes) || 60)
    setInitialized(true)
  }, [data, initialized])

  const attendees = data?.proposal?.attendees || []
  const localStart = isoFromLocal(start)

  async function create() {
    try {
      const result = await post('/email-to-event', {
        messageId: message.id,
        start: localStart,
        durationMinutes: Number(duration) || 60,
        confirm: true,
      })
      setCreated(result.event || null)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Event created and invitations sent.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not create the event.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-xl',
      bodyClassName: 'gap-3',
      children: jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'Email → calendar event' }),
          jsx(DialogDescription, { children: 'The date was read from the message. Check it before anything is sent.' }),
        ] }) }),

        proposal.isPending ? jsx(LoadingBlock, { label: 'Reading the message and proposing a time…', rows: 4 })
          : proposal.isError ? jsx(InlineError, { error: proposal.error, onRetry: proposal.refetch })
          : created ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
            jsx(EmptyBlock, { icon: 'check', title: 'Event created', description: `${created.summary} — ${fmtDateTime(created.start)}` }),
            jsx('div', { style: { display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }, children: [
              created.webUrl ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(created.webUrl), children: 'Open in Calendar' }) : null,
              jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
            ] }),
          ] })
          : jsxs(Fragment, { children: [
            jsxs('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem' }, children: [
              jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', marginBottom: '0.2rem' }, children: 'From message' }),
              jsx('div', { style: { fontSize: '0.79rem', fontWeight: 600 }, children: data?.source?.subject || message.subject }),
              jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-tertiary)', marginTop: '0.15rem' }, children: data?.source?.from || message.from }),
            ] }),

            jsx('div', { style: { display: 'flex', gap: '0.45rem', alignItems: 'center', fontSize: '0.71rem', color: data?.certainty === 'parsed' ? 'var(--ui-accent)' : 'var(--ui-yellow)' }, children: [
              jsx(Icon, { name: data?.certainty === 'parsed' ? 'check' : 'warning', size: '0.75rem' }),
              jsx('span', { children: data?.note || '' }),
            ] }),

            jsx(Field, { label: 'Title', children: jsx(Input, { value: summary, onChange: (event) => setSummary(event.target.value), style: inputStyle }) }),
            jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 7rem', gap: '0.5rem' }, children: [
              jsx(Field, { label: 'Starts', children: jsx(Input, { type: 'datetime-local', value: start, onChange: (event) => setStart(event.target.value) }) }),
              jsx(Field, { label: 'Minutes', children: jsx(Input, { type: 'number', min: 5, max: 480, step: 5, value: duration, onChange: (event) => setDuration(event.target.value) }) }),
            ] }),
            jsxs('div', { style: { ...insetStyle, padding: '0.55rem 0.65rem' }, children: [
              jsxs('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', marginBottom: '0.25rem' }, children: [`Guests (${attendees.length})`] }),
              attendees.length
                ? jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }, children: attendees.map((email) => jsx(Badge, { variant: 'muted', size: 'xs', children: email }, email)) })
                : jsx('span', { style: { fontSize: '0.73rem', color: 'var(--ui-text-tertiary)' }, children: 'No other addresses were found on the message.' }),
            ] }),

            jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
              jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
              jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !summary.trim() || !localStart, children: attendees.length ? 'Review invitation…' : 'Create event' }),
            ] }),
          ] }),
      ] }),
    }) }),

    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: create,
      title: attendees.length ? 'Create event and invite guests?' : 'Create this event?',
      description: attendees.length
        ? `Google will email ${attendees.length} guest${attendees.length === 1 ? '' : 's'} when the event is created.`
        : 'The event is added to your primary calendar.',
      confirmLabel: attendees.length ? 'Create and invite' : 'Create event',
      busyLabel: 'Creating…',
      doneLabel: 'Created',
      children: jsxs('div', { style: { ...insetStyle, padding: '0.65rem 0.7rem', display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }, children: [
        jsx('strong', { children: summary }),
        jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: fmtDateTime(localStart) }),
        attendees.length ? jsx('span', { style: { color: 'var(--ui-text-tertiary)', overflowWrap: 'anywhere' }, children: `Guests: ${attendees.join(', ')}` }) : null,
      ] }),
    }),
  ] })
}

// ── Calendar ─────────────────────────────────────────────────────────────────

const RESPONSE_STYLE = {
  accepted: { color: 'var(--ui-accent)', label: 'Accepted' },
  declined: { color: 'var(--ui-red)', label: 'Declined' },
  tentative: { color: 'var(--ui-yellow)', label: 'Maybe' },
  needsAction: { color: 'var(--ui-text-quaternary)', label: 'No reply' },
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonthKey(key, delta) {
  const [year, mon] = String(key || '').split('-').map(Number)
  const base = year && mon ? new Date(year, mon - 1, 1) : new Date()
  base.setMonth(base.getMonth() + delta)
  return monthKey(base)
}

function monthLabel(month) {
  const [year, mon] = String(month || '').split('-').map(Number)
  if (!year || !mon) return ''
  return new Date(year, mon - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function fmtDayKey(key) {
  const [year, mon, day] = String(key || '').split('-').map(Number)
  if (!year || !mon || !day) return ''
  return new Date(year, mon - 1, day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// The real month: a grid of days with the events that fall on them, so the calendar
// shows the shape of the month rather than a flat list.
function MonthCalendar({ month, events, selectedDay, onSelectDay }) {
  const [year, mon] = String(month || '').split('-').map(Number)
  const valid = Boolean(year && mon >= 1 && mon <= 12)
  const first = valid ? new Date(year, mon - 1, 1) : new Date()
  const daysInMonth = valid ? new Date(year, mon, 0).getDate() : 0
  const cells = []
  for (let index = 0; index < first.getDay(); index += 1) cells.push(null)
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(new Date(year, mon - 1, day))
  while (cells.length % 7) cells.push(null)

  const byDay = new Map()
  for (const event of events || []) {
    const start = asDate(event.start)
    if (!start) continue
    const key = dayKey(start)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(event)
  }

  const todayKey = dayKey(new Date())

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
    jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.25rem' }, children: WEEKDAYS.map((day, index) => jsx('div', { style: { fontSize: '0.62rem', fontWeight: 600, color: 'var(--ui-text-quaternary)', textAlign: 'center', padding: '0.15rem 0' }, children: day }, index)) }),
    jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.25rem' }, children: cells.map((date, index) => {
      if (!date) return jsx('div', { style: { minHeight: '5rem', borderRadius: '8px' } }, `blank-${index}`)
      const key = dayKey(date)
      const dayEvents = byDay.get(key) || []
      const isToday = key === todayKey
      const isSelected = selectedDay === key
      return jsxs('button', {
        type: 'button',
        onClick: () => onSelectDay(isSelected ? '' : key),
        style: {
          minHeight: '5rem', borderRadius: '8px',
          border: isToday ? '1px solid var(--ui-accent)' : '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)',
          background: isSelected ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent',
          color: 'inherit', font: 'inherit', cursor: 'pointer',
          padding: '0.3rem 0.32rem', display: 'flex', flexDirection: 'column', gap: '0.12rem', textAlign: 'left',
          transition: rowTransition,
        },
        children: [
          jsx('span', { style: { fontSize: '0.7rem', fontWeight: isToday ? 600 : 500, color: isToday ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)', lineHeight: 1 }, children: String(date.getDate()) }),
          ...dayEvents.slice(0, 3).map((event) => jsx('span', { style: { fontSize: '0.57rem', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ui-text-secondary)', borderLeft: '2px solid var(--ui-accent)', paddingLeft: '0.22rem' }, children: event.allDay ? event.summary : `${fmtTime(event.start)} ${event.summary}` }, event.id)),
          dayEvents.length > 3 ? jsx('span', { style: { fontSize: '0.55rem', color: 'var(--ui-text-quaternary)' }, children: `+${dayEvents.length - 3} more` }) : null,
        ],
      }, key)
    }) }),
  ] })
}

function CalendarTab({ selectedId, onSelect, onCreateEvent, onBrief, narrow, account }) {
  const [view, setView] = useState('agenda')
  const [days, setDays] = useState(7)
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [selectedDay, setSelectedDay] = useState('')
  const agenda = useApi(`/calendar?days=${days}&max_results=100`, { extra: [days] })
  const monthData = useApi(`/calendar/month?month=${month}`, { extra: [month] })
  const agendaEvents = agenda.data?.events || []
  const monthEvents = monthData.data?.events || []
  const events = view === 'month' ? monthEvents : agendaEvents
  const selected = events.find((event) => event.id === selectedId) || null
  const groups = useMemo(() => groupEventsByDay(events), [events])
  const dayEvents = useMemo(() => {
    if (!selectedDay) return []
    return monthEvents.filter((event) => {
      const start = asDate(event.start)
      return start ? dayKey(start) === selectedDay : false
    })
  }, [monthEvents, selectedDay])

  const showList = !narrow || !selectedId
  const showDetail = !narrow || !!selectedId

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.15rem', padding: '0.15rem', background: 'var(--ui-bg-secondary)', borderRadius: '8px', border: '1px solid var(--ui-stroke-secondary)' }, children: [
        jsx(Button, { variant: view === 'agenda' ? 'secondary' : 'ghost', size: 'sm', onClick: () => setView('agenda'), children: 'Agenda' }),
        jsx(Button, { variant: view === 'month' ? 'secondary' : 'ghost', size: 'sm', onClick: () => setView('month'), children: 'Month' }),
      ] }),
      view === 'agenda'
        ? jsx('div', { style: { display: 'flex', gap: '0.25rem' }, children: [7, 14, 30].map((value) => jsx(Button, {
            variant: days === value ? 'secondary' : 'ghost',
            size: 'sm',
            onClick: () => setDays(value),
            children: value === 7 ? 'Next 7 days' : `${value} days`,
          }, value)) })
        : jsxs('div', { style: { display: 'flex', gap: '0.25rem' }, children: [
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setMonth((key) => shiftMonthKey(key, -1)), children: '‹' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => { setMonth(monthKey(new Date())); setSelectedDay('') }, children: 'Today' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setMonth((key) => shiftMonthKey(key, 1)), children: '›' }),
          ] }),
      jsx('span', { style: { flex: 1 } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => (view === 'month' ? monthData.refetch() : agenda.refetch()), children: 'Refresh' }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: onCreateEvent, children: 'New event' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(17rem, 25rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsxs(Panel, { style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.55rem 0.75rem', borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)' }, children: [
            jsx('span', { style: { fontSize: '0.72rem', fontWeight: 600, color: 'var(--ui-text-tertiary)' }, children: view === 'month' ? monthLabel(month) : 'Agenda' }),
            (view === 'month' ? monthData.data : agenda.data) ? jsx('span', { style: { fontSize: '0.68rem', color: 'var(--ui-text-quaternary)' }, children: `${events.length} event${events.length === 1 ? '' : 's'}` }) : null,
          ] }),
          jsx('div', { style: { overflow: 'auto', minHeight: 0, padding: '0.35rem' }, children: view === 'month'
            ? monthData.isPending
              ? jsx(LoadingBlock, { label: 'Reading your calendar…', rows: 6 })
              : monthData.isError ? jsx(InlineError, { error: monthData.error, onRetry: monthData.refetch })
                : jsx(MonthCalendar, { month, events: monthEvents, selectedDay, onSelectDay: setSelectedDay })
            : agenda.isPending
              ? jsx(LoadingBlock, { label: 'Reading your calendar…', rows: 6 })
              : agenda.isError ? jsx(InlineError, { error: agenda.error, onRetry: agenda.refetch })
                : !agendaEvents.length ? jsx(EmptyBlock, { icon: 'calendar', title: 'Nothing scheduled', description: `No events in the next ${days} days.`, action: jsx(Button, { variant: 'outline', size: 'xs', onClick: onCreateEvent, children: 'New event' }) })
                : groups.map((group) => jsxs('div', { style: { marginBottom: '0.35rem' }, children: [
                    jsx('div', {
                      style: {
                        position: 'sticky', top: 0, zIndex: 1, padding: '0.3rem 0.45rem',
                        fontSize: '0.66rem', fontWeight: 600,
                        color: 'var(--ui-text-quaternary)', background: 'var(--ui-bg-secondary)',
                      },
                      children: fmtDay(group.day),
                    }),
                    jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: group.events.map((event) => jsx('div', {
                      style: { borderRadius: '7px', background: event.id === selectedId ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
                      children: jsx(EventRow, { event, onClick: () => onSelect(event.id) }),
                    }, event.id)) }),
                  ] }, group.key)) }),
          view === 'month' && selectedDay ? jsxs('div', { style: { borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)', padding: '0.5rem 0.6rem' }, children: [
            jsx('div', { style: { fontSize: '0.66rem', fontWeight: 600, color: 'var(--ui-text-quaternary)', marginBottom: '0.3rem' }, children: fmtDayKey(selectedDay) }),
            jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: dayEvents.length
              ? dayEvents.map((event) => jsx('div', { style: { borderRadius: '7px', background: event.id === selectedId ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' }, children: jsx(EventRow, { event, onClick: () => onSelect(event.id) }) }, event.id))
              : jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', padding: '0.2rem 0.45rem' }, children: 'Nothing scheduled that day.' }) }),
          ] }) : null,
        ] }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: selected
          ? jsx(EventDetail, { event: selected, account, onBrief, onCreateEvent, onClose: narrow ? () => onSelect(null) : null })
          : jsx(ServiceEmpty, { service: 'calendar', title: 'Pick a meeting', description: 'Choose an event to see guests, the agenda, and a briefing built from your mail and files.' }) }) : null,
      ],
    }),
  ] })
}

function EventDetail({ event, account, onBrief, onCreateEvent, onClose }) {
  const [editOpen, setEditOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const isOrganizer = !!account && event.organizer === account
  const description = String(event.description || '').trim()
  const attendees = event.attendees || []
  const response = (person) => RESPONSE_STYLE[person.response] || { color: 'var(--ui-text-quaternary)', label: person.response || 'Guest' }
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1.02rem', fontWeight: 600, lineHeight: 1.35 }, children: event.summary }),
        jsxs('div', { style: { display: 'flex', gap: '0.85rem', flexWrap: 'wrap', marginTop: '0.4rem' }, children: [
          jsx(MetaLine, { icon: 'calendar', children: event.allDay ? `${fmtDay(event.start)} · all day` : `${fmtDateTime(event.start)} – ${fmtTime(event.end)}` }),
          eventDuration(event) ? jsx(MetaLine, { icon: 'watch', children: eventDuration(event) }) : null,
          event.location ? jsx(MetaLine, { icon: 'location', children: event.location, title: event.location }) : null,
          event.recurring ? jsx(MetaLine, { icon: 'sync', children: 'Recurring' }) : null,
        ] }),
      ] }),
    ] }),

    jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsx(Button, { variant: 'default', size: 'sm', onClick: () => onBrief(event.id), children: 'Meeting brief' }),
      event.meetingLink ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(event.meetingLink), children: 'Join call' }) : null,
      event.webUrl ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => openUrl(event.webUrl), children: 'Open in Calendar' }) : null,
      isOrganizer ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setEditOpen(true), children: 'Edit event' }) : null,
      isOrganizer ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setCancelOpen(true), children: 'Cancel event' }) : null,
      onCreateEvent ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: onCreateEvent, children: 'New event' }) : null,
    ] }),
    isOrganizer ? null : jsx(RsvpControls, { event }),
    editOpen ? jsx(EditEventDialog, { event, onClose: () => setEditOpen(false) }) : null,
    cancelOpen ? jsx(CancelEventDialog, { event, onClose: () => setCancelOpen(false) }) : null,

    jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
      jsx(SectionHeading, { title: 'Guests', detail: attendees.length ? `${attendees.length}` : 'Just you' }),
      attendees.length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.1rem' }, children: attendees.map((person) => {
        const style = response(person)
        return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.4rem', borderRadius: '6px' }, children: [
          jsx(Avatar, { name: person.name, email: person.email, size: '1.5rem' }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.75rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.name || person.email }),
            person.name && person.email ? jsx('div', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.email }) : null,
          ] }),
          person.organizer ? jsx(Badge, { variant: 'muted', size: 'xs', children: 'Organizer' }) : null,
          jsx('span', { style: { fontSize: '0.66rem', fontWeight: 600, color: style.color, flexShrink: 0 }, children: style.label }),
        ] }, person.email || person.name)
      }) }) : jsx('span', { style: { fontSize: '0.75rem', color: 'var(--ui-text-quaternary)' }, children: 'No other guests on this event.' }),
    ] }),

    description ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
      jsx(SectionHeading, { title: 'Description' }),
      jsx('div', { style: { ...insetStyle, padding: '0.65rem 0.75rem', fontSize: '0.78rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)', maxHeight: '18rem', overflow: 'auto' }, children: description }),
    ] }) : null,

    jsxs('div', { style: { ...insetStyle, padding: '0.7rem 0.8rem', display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }, children: [
      jsx(Icon, { name: 'lightbulb', size: '0.85rem', color: 'var(--ui-accent)', style: { marginTop: '0.1rem' } }),
      jsxs('div', { style: { minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '0.76rem', fontWeight: 600 }, children: 'Walk in prepared' }),
        jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5, marginTop: '0.15rem' }, children: 'The brief pulls recent threads with each guest, files that match the topic, and notes from earlier meetings. It reads; it does not send anything.' }),
      ] }),
    ] }),
  ] })
}

function EventDialog({ onClose }) {
  const now = new Date()
  const rounded = new Date(now.getTime() + (60 - now.getMinutes()) * 60_000)
  rounded.setSeconds(0, 0)
  const [summary, setSummary] = useState('')
  const [start, setStart] = useState(localInputValue(rounded))
  const [duration, setDuration] = useState(30)
  const [location, setLocation] = useState('')
  const [attendees, setAttendees] = useState('')
  const [description, setDescription] = useState('')
  const [addMeet, setAddMeet] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [created, setCreated] = useState(null)

  const guestList = attendees.split(/[;,]/).map((value) => value.trim()).filter(Boolean)
  const localStart = isoFromLocal(start)
  const ready = !!summary.trim() && !!localStart
  // Read-only. Shows clashes while the user is still choosing a time.
  const endIso = localStart ? new Date(new Date(localStart).getTime() + (Number(duration) || 30) * 60_000).toISOString() : ''
  const availability = useApi(
    `/calendar/availability?start=${encodeURIComponent(localStart)}&end=${encodeURIComponent(endIso)}`,
    { enabled: !!localStart && !created, extra: [localStart, endIso] },
  )

  async function create() {
    try {
      const result = await post('/event', {
        summary: summary.trim(),
        start: localStart,
        durationMinutes: Number(duration) || 30,
        location: location.trim(),
        description,
        attendees: guestList,
        addMeet,
        confirm: true,
      })
      setCreated(result)
      refreshEverything()
      host.notify({ kind: 'success', message: guestList.length ? 'Event created and invitations sent.' : 'Event added to your calendar.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not create the event.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-xl',
      bodyClassName: 'gap-3',
      children: jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'New calendar event' }),
          jsx(DialogDescription, { children: 'Guests are only emailed after you confirm the invitation.' }),
        ] }) }),

        created ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
          jsx(EmptyBlock, { icon: 'check', title: 'Event created', description: `${created.summary} — ${fmtDateTime(created.start)}` }),
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }, children: [
            created.meetingLink ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(created.meetingLink), children: 'Join call' }) : null,
            created.webUrl ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(created.webUrl), children: 'Open in Calendar' }) : null,
            jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
          ] }),
        ] }) : jsxs(Fragment, { children: [
          jsx(Field, { label: 'Title', children: jsx(Input, { value: summary, onChange: (event) => setSummary(event.target.value), placeholder: 'What is this meeting about?', autoFocus: true, style: inputStyle }) }),
          jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 7rem', gap: '0.5rem' }, children: [
            jsx(Field, { label: 'Starts', children: jsx(Input, { type: 'datetime-local', value: start, onChange: (event) => setStart(event.target.value) }) }),
            jsx(Field, { label: 'Minutes', children: jsx(Input, { type: 'number', min: 5, max: 480, step: 5, value: duration, onChange: (event) => setDuration(event.target.value) }) }),
          ] }),
          availability.data ? jsxs('div', { role: 'status', style: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', color: availability.data.free ? 'var(--ui-accent)' : 'var(--ui-yellow)' }, children: [
            jsx(Icon, { name: availability.data.free ? 'check' : 'warning', size: '0.75rem' }),
            jsx('span', { children: availability.data.free
              ? 'Free at that time.'
              : `Overlaps ${plural((availability.data.conflicts || []).length, 'event')}: ${(availability.data.conflicts || []).map((event) => event.summary).join(', ')}` }),
          ] }) : null,
          jsx(Field, { label: 'Location', hint: 'Optional. A street address or a room name.', children: jsx(Input, { value: location, onChange: (event) => setLocation(event.target.value), placeholder: 'Boardroom, or a video link', style: inputStyle }) }),
          jsx(Field, {
            label: 'Guests',
            hint: guestList.length ? `${guestList.length} guest${guestList.length === 1 ? '' : 's'} will be invited: ${guestList.join(', ')}` : 'Comma or semicolon separated email addresses. Optional.',
            children: jsx(Input, { value: attendees, onChange: (event) => setAttendees(event.target.value), placeholder: 'alex@company.com, sam@company.com', style: inputStyle }),
          }),
          jsx(Field, { label: 'Description', children: jsx(Textarea, { value: description, onChange: (event) => setDescription(event.target.value), placeholder: 'Agenda, context, or links.', style: { width: '100%', minHeight: '6rem', resize: 'vertical', lineHeight: 1.5 } }) }),
          jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.75rem', cursor: 'pointer' }, children: [
            jsx(Checkbox, { checked: addMeet, onCheckedChange: (value) => setAddMeet(!!value) }),
            jsx('span', { children: 'Add a Google Meet link' }),
          ] }),
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !ready, children: guestList.length ? 'Review invitation…' : 'Create event' }),
          ] }),
        ] }),
      ] }),
    }) }),

    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: create,
      title: guestList.length ? 'Create event and invite guests?' : 'Create this event?',
      description: guestList.length
        ? `Google will email ${guestList.length} guest${guestList.length === 1 ? '' : 's'} when this is created.`
        : 'This adds the event to your primary calendar. No one is notified.',
      confirmLabel: guestList.length ? 'Create and invite' : 'Create event',
      busyLabel: 'Creating…',
      doneLabel: 'Created',
      children: jsxs('div', { style: { ...insetStyle, padding: '0.65rem 0.7rem', display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem' }, children: [
        jsx('strong', { children: summary.trim() }),
        jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: `${fmtDateTime(localStart)} · ${duration} minutes` }),
        location.trim() ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: location.trim() }) : null,
        guestList.length ? jsx('span', { style: { color: 'var(--ui-text-tertiary)', overflowWrap: 'anywhere' }, children: `Guests: ${guestList.join(', ')}` }) : null,
        addMeet ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: 'A Google Meet link will be attached.' }) : null,
      ] }),
    }),
  ] })
}

// ── Meeting brief ────────────────────────────────────────────────────────────

function BriefDialog({ eventId, query, onClose, onOpenMessage, onOpenFile }) {
  const params = new URLSearchParams()
  if (eventId) params.set('event_id', eventId)
  if (query) params.set('query', query)
  const brief = useApi(`/brief?${params.toString()}`, { enabled: !!(eventId || query), extra: [eventId, query] })
  const data = brief.data
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saved, setSaved] = useState(null)

  async function save() {
    try {
      const result = await post('/brief/save', { eventId: eventId || '', query: query || '', days: 14, confirm: true })
      setSaved(result.document)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Brief saved to Google Docs.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not save the brief.').message)
    }
  }

  const event = data?.event || {}
  const evidence = data?.evidence || {}

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-3xl',
      bodyClassName: 'gap-0 p-0 overflow-hidden',
      children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 }, children: [
        jsx(DialogHeader, { style: { padding: '1rem 1rem 0.6rem', borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent)' }, children: jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', paddingRight: '1.25rem' }, children: [
          jsxs('div', { style: { minWidth: 0 }, children: [
            jsx(DialogTitle, { children: event.summary || 'Meeting brief' }),
            jsx(DialogDescription, { children: event.start ? `${fmtDateTime(event.start)}${event.location ? ` · ${event.location}` : ''}` : 'Built from your own Gmail and Drive.' }),
          ] }),
          data ? jsxs('div', { style: { display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'flex-end' }, children: [
            event.webUrl ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => openUrl(event.webUrl), children: 'Open event' }) : null,
            jsx(Button, { variant: 'outline', size: 'xs', onClick: () => setConfirmOpen(true), children: 'Save as Doc' }),
          ] }) : null,
        ] }) }),

        jsx('div', { style: { overflow: 'auto', minHeight: 0, padding: '0.9rem 1rem 1.1rem' }, children: brief.isPending
          ? jsx(LoadingBlock, { label: 'Reading recent threads, matching files, and notes…', rows: 6 })
          : brief.isError ? jsx(InlineError, { error: brief.error, onRetry: brief.refetch })
          : !data ? jsx(EmptyBlock, { icon: 'note', title: 'No event selected', description: 'Open a meeting from the Calendar tab to build its brief.' })
          : jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem' }, children: [
            saved ? jsxs('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }, children: [
              jsx(Icon, { name: 'check', size: '0.8rem', color: 'var(--ui-accent)' }),
              jsx('span', { style: { flex: 1, fontSize: '0.74rem' }, children: 'Saved to Google Docs.' }),
              jsx(LinkAction, { onClick: () => openUrl(saved.webUrl), children: 'Open document' }),
            ] }) : null,

            jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
              jsx(Badge, { variant: 'muted', size: 'xs', children: `${evidence.attendees || 0} attendees` }),
              jsx(Badge, { variant: 'muted', size: 'xs', children: `${evidence.gmailThreads || 0} threads` }),
              jsx(Badge, { variant: 'muted', size: 'xs', children: `${evidence.driveFiles || 0} files` }),
              data.externalAttendees?.length ? jsx(Badge, { variant: 'warn', size: 'xs', children: `${data.externalAttendees.length} outside your domain` }) : null,
            ] }),

            (data.suggestedAgenda || []).length ? jsxs('div', { children: [
              jsx(SectionHeading, { title: 'Suggested agenda', detail: 'Edit before you share it' }),
              jsx('ol', { style: { margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.78rem', lineHeight: 1.55, color: 'var(--ui-text-secondary)' }, children: (data.suggestedAgenda || []).map((item, index) => jsx('li', { children: item }, index)) }),
            ] }) : null,

            jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem', alignItems: 'start' }, children: [
              jsxs('div', { children: [
                jsx(SectionHeading, { title: 'Guests' }),
                (data.attendees || []).length ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.1rem' }, children: (data.attendees || []).map((person) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', padding: '0.25rem 0' }, children: [
                  jsx(Avatar, { name: person.name, email: person.email, size: '1.4rem' }),
                  jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
                    jsx('div', { style: { fontSize: '0.74rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.name || person.email }),
                    jsx('div', { style: { fontSize: '0.66rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.email }),
                  ] }),
                  jsx('span', { style: { fontSize: '0.64rem', color: (RESPONSE_STYLE[person.response] || {}).color || 'var(--ui-text-quaternary)', flexShrink: 0 }, children: (RESPONSE_STYLE[person.response] || {}).label || person.response || '' }),
                ] }, person.email)) }) : jsx('div', { style: { fontSize: '0.73rem', color: 'var(--ui-text-quaternary)' }, children: 'No other attendees.' }),
              ] }),

              jsxs('div', { children: [
                jsx(SectionHeading, { title: 'Recent threads' }),
                (data.conversations || []).length ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (data.conversations || []).map((item) => jsx('button', {
                  type: 'button',
                  onClick: () => onOpenMessage(item.id),
                  style: { textAlign: 'left', border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: '0.35rem 0.4rem', borderRadius: '6px', cursor: 'pointer' },
                  onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
                  onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                  children: jsxs(Fragment, { children: [
                    jsx('div', { style: { fontSize: '0.73rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.subject }),
                    jsxs('div', { style: { fontSize: '0.65rem', color: 'var(--ui-text-quaternary)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [senderName(item.from), ' · ', fmtRelative(item.date)] }),
                  ] }),
                }, item.id)) }) : jsx('div', { style: { fontSize: '0.73rem', color: 'var(--ui-text-quaternary)' }, children: 'No recent email with these guests.' }),
              ] }),
            ] }),

            ((data.relatedFiles || []).length || (data.priorNotes || []).length || (data.sharedWithAttendees || []).length) ? jsxs('div', { children: [
              jsx(SectionHeading, { title: 'Files worth opening' }),
              jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: [
                ...(data.priorNotes || []).map((file) => jsx('button', {
                  type: 'button', onClick: () => onOpenFile(file),
                  style: { textAlign: 'left', border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: '0.35rem 0.4rem', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.45rem' },
                  onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
                  onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                  children: [jsx(Icon, { name: fileIcon(file.mimeType), size: '0.8rem', color: 'var(--ui-text-quaternary)' }), jsx('span', { style: { fontSize: '0.74rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }), jsx(Badge, { variant: 'muted', size: 'xs', children: 'Prior notes' })],
                }, `note-${file.id}`)),
                ...(data.relatedFiles || []).map((file) => jsx('button', {
                  type: 'button', onClick: () => onOpenFile(file),
                  style: { textAlign: 'left', border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: '0.35rem 0.4rem', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.45rem' },
                  onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
                  onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                  children: [jsx(Icon, { name: fileIcon(file.mimeType), size: '0.8rem', color: 'var(--ui-text-quaternary)' }), jsx('span', { style: { fontSize: '0.74rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name })],
                }, `related-${file.id}`)),
                ...(data.sharedWithAttendees || []).map((file) => jsx('button', {
                  type: 'button', onClick: () => onOpenFile(file),
                  style: { textAlign: 'left', border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: '0.35rem 0.4rem', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.45rem' },
                  onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
                  onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                  children: [jsx(Icon, { name: fileIcon(file.mimeType), size: '0.8rem', color: 'var(--ui-text-quaternary)' }), jsx('span', { style: { fontSize: '0.74rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }), jsx(Badge, { variant: 'muted', size: 'xs', children: `with ${String(file.with || '').split('@')[0]}` })],
                }, `shared-${file.id}`)),
              ] }),
            ] }) : null,

            jsx('div', { style: { fontSize: '0.69rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.5, borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)', paddingTop: '0.7rem' }, children: 'Prepared from your own mail and files. It reads only; nothing here is sent or shared until you choose an action.' }),
          ] }) }),
      ] }),
    }) }),

    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: save,
      title: 'Save this brief as a Google Doc?',
      description: 'A new document is created in your Drive. Nothing is shared with the guests.',
      confirmLabel: 'Create document',
      busyLabel: 'Writing…',
      doneLabel: 'Saved',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.75rem' }, children: `Meeting brief — ${event.summary || 'Meeting'}` }),
    }),
  ] })
}

// ── Drive ────────────────────────────────────────────────────────────────────

const DRIVE_FILTERS = [
  { id: '', label: 'Everything', mime: '' },
  { id: 'docs', label: 'Docs', mime: MIME_DOC },
  { id: 'sheets', label: 'Sheets', mime: MIME_SHEET },
  { id: 'folders', label: 'Folders', mime: MIME_FOLDER },
  { id: 'pdfs', label: 'PDFs', mime: 'application/pdf' },
  { id: 'images', label: 'Images', mime: 'image/' },
]

function DriveTab({ selectedFile, onSelect, onOrganize, onOpenDoc, onOpenSheet, narrow }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const activeMime = (DRIVE_FILTERS.find((item) => item.id === filter) || {}).mime || ''
  const params = new URLSearchParams({ max_results: '40' })
  if (query) params.set('query', query)
  if (activeMime) params.set('mime_type', activeMime)
  const listing = useApi(`/drive?${params.toString()}`, { extra: [query, filter] })
  const files = listing.data?.files || []
  const selected = selectedFile && files.find((file) => file.id === selectedFile.id) ? selectedFile : files.find((file) => file.id === selectedFile?.id) || selectedFile

  function submitSearch() {
    setQuery(search.trim())
  }

  const showList = !narrow || !selected
  const showDetail = !narrow || !!selected

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.35rem', flex: 1, minWidth: '13rem' }, children: [
        jsx(SearchField, {
          placeholder: 'Search Drive by name or content',
          value: search,
          onChange: setSearch,
          onKeyDown: (event) => { if (event.key === 'Enter') submitSearch() },
          variant: 'box',
          'aria-label': 'Search Drive',
        }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: submitSearch, children: 'Search' }),
      ] }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: onOrganize, children: 'Organize' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => listing.refetch(), children: 'Refresh' }),
    ] }),

    jsx('div', { role: 'group', 'aria-label': 'Filter by type', style: { display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }, children: DRIVE_FILTERS.map((item) => jsx(Button, {
      variant: filter === item.id ? 'secondary' : 'ghost',
      size: 'xs',
      onClick: () => setFilter(item.id),
      children: item.label,
    }, item.id)) }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(17rem, 26rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsxs(Panel, { style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }, children: [
          jsx('div', { style: { overflow: 'auto', minHeight: 0, padding: '0.3rem' }, children: listing.isPending
            ? jsx(LoadingBlock, { label: 'Reading Drive…', rows: 7 })
            : listing.isError ? jsx(InlineError, { error: listing.error, onRetry: listing.refetch })
            : !files.length ? jsx(EmptyBlock, { icon: 'cloud', title: 'No files here', description: query ? `Nothing matched “${query}”.` : 'Files you own or can edit appear here.' })
            : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: files.map((file) => jsx('div', {
              style: { borderRadius: '7px', background: selected?.id === file.id ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
              children: jsx(FileRow, { file, onClick: () => onSelect(file) }),
            }, file.id)) }) }),
          jsxs('div', { style: { borderTop: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 60%, transparent)', padding: '0.45rem 0.7rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [
            jsx('span', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '' }),
            jsx(LinkAction, { onClick: () => openUrl(GOOGLE_LINKS.drive), children: 'Open Drive' }),
          ] }),
        ] }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: selected
          ? jsx(FileDetail, { file: selected, onOpenDoc, onOpenSheet, onChanged: (next) => onSelect(next), onClose: narrow ? () => onSelect(null) : null })
          : jsx(ServiceEmpty, { service: 'drive', title: 'Pick a file', description: 'Choose a file to see who owns it, when it changed, and where to open it.' }) }) : null,
      ],
    }),
  ] })
}

function FileDetail({ file, onOpenDoc, onOpenSheet, onChanged, onClose }) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const isDoc = file.mimeType === MIME_DOC
  const isSheet = file.mimeType === MIME_SHEET
  const owners = file.owners || []
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsx('span', { style: { width: '2.3rem', height: '2.3rem', borderRadius: '8px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', flexShrink: 0 }, children: jsx(Icon, { name: fileIcon(file.mimeType), size: '1.1rem', color: 'var(--ui-text-tertiary)' }) }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: file.name }),
        jsxs('div', { style: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.35rem' }, children: [
          jsx(MetaLine, { icon: 'symbol-class', children: mimeLabel(file.mimeType) }),
          file.modified ? jsx(MetaLine, { icon: 'history', children: `Modified ${fmtRelative(file.modified)}` }) : null,
          file.size ? jsx(MetaLine, { icon: 'database', children: fmtBytes(file.size) }) : null,
          file.starred ? jsx(MetaLine, { icon: 'star-full', children: 'Starred' }) : null,
        ] }),
      ] }),
    ] }),

    jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      isDoc && onOpenDoc ? jsx(Button, { variant: 'default', size: 'sm', onClick: () => onOpenDoc(file), children: 'Read in Hermes' }) : null,
      isSheet && onOpenSheet ? jsx(Button, { variant: 'default', size: 'sm', onClick: () => onOpenSheet(file), children: 'View in Hermes' }) : null,
      file.webUrl ? jsx(Button, { variant: isDoc || isSheet ? 'outline' : 'default', size: 'sm', onClick: () => openUrl(file.webUrl), children: 'Open in Drive' }) : null,
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setRenameOpen(true), children: 'Rename' }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setShareOpen(true), children: 'Share' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setTrashOpen(true), children: 'Trash' }),
    ] }),
    renameOpen ? jsx(RenameFileDialog, { file, onClose: () => setRenameOpen(false), onRenamed: (next) => onChanged?.(next) }) : null,
    shareOpen ? jsx(ShareFileDialog, { file, onClose: () => setShareOpen(false) }) : null,
    trashOpen ? jsx(TrashFileDialog, { file, onClose: () => setTrashOpen(false), onTrashed: () => onChanged?.(null) }) : null,

    file.description ? jsxs('div', { children: [
      jsx(SectionHeading, { title: 'Description' }),
      jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.77rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--ui-text-secondary)' }, children: file.description }),
    ] }) : null,

    jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))', gap: '0.8rem' }, children: [
      jsxs('div', { children: [
        jsx(SectionHeading, { title: 'Owner' }),
        owners.length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.25rem' }, children: owners.map((owner) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem' }, children: [
          jsx(Avatar, { name: owner.name, email: owner.email, size: '1.4rem' }),
          jsxs('div', { style: { minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.74rem', fontWeight: 500 }, children: owner.name || owner.email }),
            owner.name ? jsx('div', { style: { fontSize: '0.66rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis' }, children: owner.email }) : null,
          ] }),
        ] }, owner.email)) }) : jsx('span', { style: { fontSize: '0.73rem', color: 'var(--ui-text-quaternary)' }, children: 'Owner is hidden by Drive permissions.' }),
      ] }),

      jsxs('div', { children: [
        jsx(SectionHeading, { title: 'Details' }),
        jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.72rem', color: 'var(--ui-text-tertiary)' }, children: [
          file.created ? jsx('span', { children: `Created ${fmtRelative(file.created)}` }) : null,
          file.modified ? jsx('span', { children: `Modified ${fmtDateTime(file.modified)}` }) : null,
          jsx('span', { style: { overflowWrap: 'anywhere', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.66rem', color: 'var(--ui-text-quaternary)' }, children: file.id }),
        ] }),
      ] }),
    ] }),
  ] })
}

function OrganizeDialog({ onClose }) {
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [maxFiles, setMaxFiles] = useState(25)
  const [preview, setPreview] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState(null)

  const params = new URLSearchParams({ query: query.trim(), folder: folder.trim(), max_files: String(maxFiles) })
  const plan = useApi(`/organize?${params.toString()}`, { enabled: preview && !!query.trim() && !!folder.trim(), extra: [query, folder, maxFiles, preview] })
  const files = plan.data?.files || []
  const canPreview = !!query.trim() && !!folder.trim()

  async function apply() {
    try {
      const payload = await post('/organize', {
        query: query.trim(),
        folder: folder.trim(),
        maxFiles: Number(maxFiles) || 25,
        confirm: true,
      })
      setResult(payload)
      refreshEverything()
      host.notify({ kind: 'success', message: `Moved ${(payload.moved || []).length} file${(payload.moved || []).length === 1 ? '' : 's'}.` })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not move the files.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-2xl',
      bodyClassName: 'gap-3',
      children: jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'Organize Drive' }),
          jsx(DialogDescription, { children: 'Search for files, choose a destination folder, review the exact list, then move. Nothing moves until the last step.' }),
        ] }) }),

        result ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
          jsx(EmptyBlock, { icon: 'check', title: `${(result.moved || []).length} file${(result.moved || []).length === 1 ? '' : 's'} moved`, description: result.folderCreated ? `Created the folder “${result.folder?.name}”.` : `Into “${result.folder?.name}”.` }),
          (result.moved || []).length ? jsxs('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', display: 'flex', flexDirection: 'column', gap: '0.2rem', maxHeight: '14rem', overflow: 'auto' }, children: isFailed(result) }) : null,
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }, children: [
            result.folder?.webUrl ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(result.folder.webUrl), children: 'Open folder' }) : null,
            jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
          ] }),
        ] }) : jsxs(Fragment, { children: [
          jsx(Field, { label: 'Find files', hint: 'A name, a topic, or words that appear inside the file.', children: jsx(Input, { value: query, onChange: (event) => { setQuery(event.target.value); setPreview(false) }, placeholder: 'invoices 2026', autoFocus: true, style: inputStyle }) }),
          jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 7rem', gap: '0.5rem' }, children: [
            jsx(Field, { label: 'Destination folder', hint: 'Created if it does not exist. Existing files in it are left alone.', children: jsx(Input, { value: folder, onChange: (event) => { setFolder(event.target.value); setPreview(false) }, placeholder: 'Finance / 2026', style: inputStyle }) }),
            jsx(Field, { label: 'Max files', children: jsx(Input, { type: 'number', min: 1, max: 50, value: maxFiles, onChange: (event) => { setMaxFiles(event.target.value); setPreview(false) } }) }),
          ] }),

          jsxs('div', { style: { display: 'flex', gap: '0.45rem', alignItems: 'center' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setPreview(true), disabled: !canPreview, loading: plan.isFetching, children: preview ? 'Refresh preview' : 'Preview matches' }),
            preview && plan.data ? jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)' }, children: plan.data.note || `${files.length} file${files.length === 1 ? '' : 's'} would move` }) : null,
          ] }),

          preview ? (plan.isPending ? jsx(LoadingBlock, { label: 'Finding matches…', rows: 3 })
            : plan.isError ? jsx(InlineError, { error: plan.error, onRetry: plan.refetch })
            : jsxs('div', { children: [
              jsxs('div', { style: { ...insetStyle, padding: '0.55rem 0.65rem', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.4rem' }, children: [
                jsx(Icon, { name: plan.data?.folderExists ? 'folder' : 'new-folder', size: '0.85rem', color: 'var(--ui-text-tertiary)' }),
                jsx('span', { style: { fontSize: '0.74rem', flex: 1 }, children: plan.data?.folderExists ? `Folder “${plan.data.folder?.name}” exists` : `Folder “${folder.trim()}” will be created` }),
              ] }),
              files.length ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem', maxHeight: '16rem', overflow: 'auto' }, children: files.map((file) => jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.45rem', padding: '0.3rem 0.4rem' }, children: [
                jsx(Icon, { name: 'file', size: '0.8rem', color: 'var(--ui-text-quaternary)' }),
                jsx('span', { style: { fontSize: '0.74rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }),
              ] }, file.id)) }) : jsx(EmptyBlock, { icon: 'search', title: 'No matches', description: 'Try fewer words, or a different folder name.' }),
              jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem', marginTop: '0.6rem' }, children: [
                jsx(Button, { variant: 'ghost', size: 'sm', onClick: onClose, children: 'Cancel' }),
                jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !files.length, children: `Move ${files.length} file${files.length === 1 ? '' : 's'}` }),
              ] }),
            ] })) : null,
        ] }),
      ] }),
    }) }),

    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: apply,
      title: `Move ${files.length} file${files.length === 1 ? '' : 's'}?`,
      description: `They leave their current folders and land in “${folder.trim()}”. Files in the folder already are skipped.`,
      confirmLabel: 'Move files',
      busyLabel: 'Moving…',
      doneLabel: 'Moved',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.74rem', maxHeight: '9rem', overflow: 'auto' }, children: files.map((file) => jsx('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }, file.id)) }),
    }),
  ] })
}

function isFailed(plan) {
  return (plan.moved || []).map((item) => jsxs('div', { style: { fontSize: '0.73rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }, children: [
    jsx(Icon, { name: item.error ? 'warning' : 'check', size: '0.75rem', color: item.error ? 'var(--ui-red)' : 'var(--ui-accent)' }),
    jsx('span', { children: item.error ? `${item.name} — ${item.error}` : item.name }),
  ] }, item.id))
}

// ── Docs ─────────────────────────────────────────────────────────────────────

function DocsTab({ selectedDoc, onSelect, onOpenFile, narrow }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [appendOpen, setAppendOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const params = new URLSearchParams({ max_results: '40', mime_type: MIME_DOC })
  if (query) params.set('query', query)
  const listing = useApi(`/drive?${params.toString()}`, { extra: [query] })
  const docs = listing.data?.files || []
  const current = selectedDoc
  const reader = useApi(`/docs/${encodeURIComponent(current?.id || '')}`, { enabled: !!current?.id, extra: [current?.id] })

  const showList = !narrow || !current
  const showDetail = !narrow || !!current

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.35rem', flex: 1, minWidth: '13rem' }, children: [
        jsx(SearchField, { placeholder: 'Search your Google Docs', value: search, onChange: setSearch, onKeyDown: (event) => { if (event.key === 'Enter') setQuery(search.trim()) }, variant: 'box', 'aria-label': 'Search Google Docs' }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setQuery(search.trim()), children: 'Search' }),
      ] }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setCreateOpen(true), children: 'New doc' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => listing.refetch(), children: 'Refresh' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(15rem, 21rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsx(Panel, { style: { overflow: 'auto', minHeight: 0, padding: '0.3rem' }, children: listing.isPending
          ? jsx(LoadingBlock, { label: 'Listing documents…', rows: 6 })
          : listing.isError ? jsx(InlineError, { error: listing.error, onRetry: listing.refetch })
          : !docs.length ? jsx(EmptyBlock, { icon: 'book', title: 'No documents found', description: query ? `Nothing matched “${query}”.` : 'Create one, or open a doc from Drive.' })
          : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: docs.map((file) => jsx('div', {
            style: { borderRadius: '7px', background: current?.id === file.id ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
            children: jsx(FileRow, { file, onClick: () => onSelect(file) }),
          }, file.id)) }) }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: current
          ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.85rem', padding: '0.9rem 1rem 1.3rem' }, children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }, children: [
              jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => onSelect(null), children: 'Back' }),
              jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
                jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: reader.data?.title || current.name }),
                jsxs('div', { style: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }, children: [
                  jsx(MetaLine, { icon: 'book', children: reader.data ? `${reader.data.characters.toLocaleString()} characters` : 'Google Doc' }),
                  current.modified ? jsx(MetaLine, { icon: 'history', children: fmtRelative(current.modified) }) : null,
                ] }),
              ] }),
            ] }),
            jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
              jsx(Button, { variant: 'default', size: 'sm', onClick: () => setAppendOpen(true), disabled: !reader.data, children: 'Append text' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setReplaceOpen(true), disabled: !reader.data, children: 'Replace text' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(reader.data?.webUrl || current.webUrl), children: 'Open in Docs' }),
              onOpenFile ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenFile(current), children: 'File details' }) : null,
            ] }),
            reader.isPending ? jsx(LoadingBlock, { label: 'Reading the document…', rows: 6 })
              : reader.isError ? jsx(InlineError, { error: reader.error, onRetry: reader.refetch })
              : jsx('div', { style: { ...insetStyle, padding: '0.85rem 0.95rem', fontSize: '0.8rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)', minHeight: '10rem' }, children: reader.data?.text || 'This document is empty. Use “Append text” to add the first paragraph.' }),
            jsx('div', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: `Read-only view. Characters beyond ${'20,000'} are truncated in Hermes; open the doc for the full text.` }),
          ] })
          : jsx(ServiceEmpty, { service: 'docs', title: 'Pick a document', description: 'Select a doc to read it here, or create a new one.' }) }) : null,
      ],
    }),
    createOpen ? jsx(CreateDocDialog, {
      onClose: () => setCreateOpen(false),
      onCreated: (doc) => onSelect({ id: doc.id, name: doc.title, mimeType: MIME_DOC, webUrl: doc.webUrl }),
    }) : null,
    appendOpen && current ? jsx(AppendDocDialog, { doc: current, onClose: () => setAppendOpen(false) }) : null,
    replaceOpen && current ? jsx(ReplaceDocTextDialog, { doc: current, onClose: () => setReplaceOpen(false) }) : null,
  ], })
}

function CreateDocDialog({ onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const document = await post('/docs', { title: title.trim(), text, confirm: true })
      refreshEverything()
      host.notify({ kind: 'success', message: 'Document created in Drive.' })
      onCreated?.(document)
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
    className: 'max-w-lg',
    bodyClassName: 'gap-3',
    children: jsxs(Fragment, { children: [
      jsx(DialogHeader, { children: jsxs('div', { children: [
        jsx(DialogTitle, { children: 'New Google Doc' }),
        jsx(DialogDescription, { children: 'Created in your Drive with the text you paste. Nothing is shared.' }),
      ] }) }),
      jsx(Field, { label: 'Title', children: jsx(Input, { value: title, onChange: (event) => setTitle(event.target.value), placeholder: 'Meeting notes — 6 Nov', autoFocus: true, style: inputStyle }) }),
      jsx(Field, { label: 'Starting text', hint: 'Optional. You can append more later.', children: jsx(Textarea, { value: text, onChange: (event) => setText(event.target.value), placeholder: 'Paste or write the opening paragraphs…', style: { width: '100%', minHeight: '10rem', resize: 'vertical', lineHeight: 1.55 } }) }),
      error ? jsx(InlineError, { error }) : null,
      jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
        jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
        jsx(Button, { variant: 'default', size: 'sm', onClick: create, loading: busy, disabled: !title.trim(), children: 'Create document' }),
      ] }),
    ] }),
  }) })
}

function AppendDocDialog({ doc, onClose }) {
  const [text, setText] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [done, setDone] = useState(null)

  async function append() {
    try {
      const result = await post(`/docs/${encodeURIComponent(doc.id)}/append`, { text, confirm: true })
      setDone(result)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Text appended to the document.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not append the text.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-lg',
      bodyClassName: 'gap-3',
      children: done ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
        jsx(EmptyBlock, { icon: 'check', title: 'Text appended', description: `${done.appendedCharacters.toLocaleString()} characters added to the end of the document.` }),
        jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }, children: [
          jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(done.webUrl), children: 'Open in Docs' }),
          jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
        ] }),
      ] }) : jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'Append to document' }),
          jsx(DialogDescription, { children: `${doc.name} — new text is added at the end. Existing text is untouched.` }),
        ] }) }),
        jsx(Field, { label: 'Text to add', children: jsx(Textarea, { value: text, onChange: (event) => setText(event.target.value), placeholder: 'Paste the update, notes, or a status block…', autoFocus: true, style: { width: '100%', minHeight: '11rem', resize: 'vertical', lineHeight: 1.55 } }) }),
        jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
          jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
          jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !text.trim(), children: 'Append text' }),
        ] }),
      ] }),
    }) }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: append,
      title: 'Append this text?',
      description: 'It goes at the end of the document and is visible to anyone who can already open it.',
      confirmLabel: 'Append',
      busyLabel: 'Writing…',
      doneLabel: 'Appended',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.75rem', maxHeight: '9rem', overflow: 'auto', whiteSpace: 'pre-wrap' }, children: text }),
    }),
  ] })
}

// ── Sheets ───────────────────────────────────────────────────────────────────

const SHEET_PREVIEW_RANGE = 'A1:H30'
const MAX_SHEET_ROWS = 500

function sheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id || '')}/edit`
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// One row per line. Cells are separated by tabs (what copying from a spreadsheet gives) or commas.
function parseRows(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length)
    .map((line) => (line.includes('\t') ? line.split('\t') : line.split(',')).map((cell) => cell.trim()))
}

function SheetGrid({ values }) {
  if (!values.length) {
    return jsx(EmptyBlock, {
      icon: 'table',
      title: 'This range is empty',
      description: 'Add rows to fill it in. Nothing is written until you confirm.',
    })
  }
  const width = Math.max(1, ...values.map((row) => row.length))
  const cell = {
    padding: '0.35rem 0.55rem',
    borderBottom: '1px solid var(--ui-stroke-secondary)',
    borderRight: '1px solid var(--ui-stroke-secondary)',
    textAlign: 'left',
    maxWidth: '14rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  }
  return jsx('div', {
    style: { ...insetStyle, overflow: 'auto', maxHeight: '26rem' },
    children: jsxs('table', {
      style: { borderCollapse: 'collapse', width: '100%', fontSize: '0.74rem' },
      children: values.map((row, rowIndex) => jsxs('tr', {
        children: Array.from({ length: width }, (_, column) => {
          const header = rowIndex === 0
          const value = row[column]
          return jsx(header ? 'th' : 'td', {
            style: {
              ...cell,
              fontWeight: header ? 600 : 400,
              color: header ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
              background: header ? 'var(--ui-bg-quaternary)' : 'transparent',
            },
            children: value === undefined || value === null ? '' : String(value),
          }, column)
        }),
      }, rowIndex)),
    }),
  })
}

function SheetsTab({ selectedSheet, onSelect, narrow }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [appendOpen, setAppendOpen] = useState(false)
  const [writeOpen, setWriteOpen] = useState(false)
  const [tabOpen, setTabOpen] = useState(false)
  const params = new URLSearchParams({ max_results: '40', mime_type: MIME_SHEET })
  if (query) params.set('query', query)
  const listing = useApi(`/drive?${params.toString()}`, { extra: [query] })
  const sheets = listing.data?.files || []
  const current = selectedSheet
  const preview = useApi(
    `/sheets/${encodeURIComponent(current?.id || '')}?range=${encodeURIComponent(SHEET_PREVIEW_RANGE)}`,
    { enabled: !!current?.id, extra: [current?.id] },
  )
  const showList = !narrow || !current
  const showDetail = !narrow || !!current

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.35rem', flex: 1, minWidth: '13rem' }, children: [
        jsx(SearchField, {
          placeholder: 'Search your spreadsheets',
          value: search,
          onChange: setSearch,
          onKeyDown: (event) => { if (event.key === 'Enter') setQuery(search.trim()) },
          variant: 'box',
          'aria-label': 'Search Google Sheets',
        }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setQuery(search.trim()), children: 'Search' }),
      ] }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setCreateOpen(true), children: 'New sheet' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => listing.refetch(), children: 'Refresh' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(15rem, 21rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsx(Panel, { style: { overflow: 'auto', minHeight: 0, padding: '0.3rem' }, children: listing.isPending
          ? jsx(LoadingBlock, { label: 'Listing spreadsheets…', rows: 6 })
          : listing.isError ? jsx(InlineError, { error: listing.error, onRetry: listing.refetch })
          : !sheets.length ? jsx(EmptyBlock, { icon: 'table', title: 'No spreadsheets found', description: query ? `Nothing matched “${query}”.` : 'Create one, or open a sheet from Drive.' })
          : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: sheets.map((file) => jsx('div', {
            style: { borderRadius: '7px', background: current?.id === file.id ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
            children: jsx(FileRow, { file, onClick: () => onSelect(file) }),
          }, file.id)) }) }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: current
          ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.85rem', padding: '0.9rem 1rem 1.3rem' }, children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }, children: [
              narrow ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: () => onSelect(null), children: 'Back' }) : null,
              jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
                jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: current.name }),
                jsx('div', { style: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }, children: [
                  jsx(MetaLine, { icon: 'table', children: preview.data ? `${plural(preview.data.rows || 0, 'row')} in view` : 'Google Sheet' }),
                  current.modified ? jsx(MetaLine, { icon: 'history', children: fmtRelative(current.modified) }) : null,
                ] }),
              ] }),
            ] }),
            jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
              jsx(Button, { variant: 'default', size: 'sm', onClick: () => setAppendOpen(true), children: 'Add rows' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setWriteOpen(true), children: 'Write cells' }),
              jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setTabOpen(true), children: 'Add tab' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(current.webUrl || sheetUrl(current.id)), children: 'Open in Sheets' }),
            ] }),
            preview.isPending ? jsx(LoadingBlock, { label: 'Reading the sheet…', rows: 6 })
              : preview.isError ? jsx(InlineError, { error: preview.error, onRetry: preview.refetch })
              : jsx(SheetGrid, { values: preview.data?.values || [] }),
            jsx('div', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: `Showing ${SHEET_PREVIEW_RANGE}. Open the sheet for everything else.` }),
          ] })
          : jsx(ServiceEmpty, { service: 'sheets', title: 'Pick a spreadsheet', description: 'Select one to preview its data here, or create a new one.' }) }) : null,
      ],
    }),
    createOpen ? jsx(CreateSheetDialog, { onClose: () => setCreateOpen(false), onCreated: (sheet) => onSelect(sheet) }) : null,
    appendOpen && current ? jsx(AppendSheetDialog, { sheet: current, onClose: () => setAppendOpen(false) }) : null,
    writeOpen && current ? jsx(WriteRangeDialog, { sheet: current, onClose: () => setWriteOpen(false) }) : null,
    tabOpen && current ? jsx(AddTabDialog, { sheet: current, onClose: () => setTabOpen(false) }) : null,
  ] })
}

function CreateSheetDialog({ onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [tabName, setTabName] = useState('Sheet1')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cleanTitle = title.trim()
  const cleanTab = tabName.trim() || 'Sheet1'

  async function create() {
    try {
      const sheet = await post('/sheets', { title: cleanTitle, sheetTitle: cleanTab, confirm: true })
      refreshEverything()
      host.notify({ kind: 'success', message: 'Spreadsheet created in Drive.' })
      onCreated?.({ id: sheet.id, name: sheet.title, mimeType: MIME_SHEET, webUrl: sheet.webUrl })
      onClose()
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not create the spreadsheet.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-lg',
      bodyClassName: 'gap-3',
      children: jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'New spreadsheet' }),
          jsx(DialogDescription, { children: 'Creates an empty sheet in your Drive. You confirm before it is created.' }),
        ] }) }),
        jsx(Field, { label: 'Title', children: jsx(Input, { value: title, onChange: (event) => setTitle(event.target.value), placeholder: 'Q4 invoices', autoFocus: true }) }),
        jsx(Field, { label: 'First tab name', children: jsx(Input, { value: tabName, onChange: (event) => setTabName(event.target.value), placeholder: 'Sheet1' }) }),
        jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
          jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
          jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !cleanTitle, children: 'Create sheet' }),
        ] }),
      ] }),
    }) }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: create,
      title: 'Create this spreadsheet?',
      description: `“${cleanTitle}” is created in your Drive with its first tab named “${cleanTab}”.`,
      confirmLabel: 'Create',
      busyLabel: 'Creating…',
      doneLabel: 'Created',
    }),
  ] })
}

function AppendSheetDialog({ sheet, onClose }) {
  const [text, setText] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [done, setDone] = useState(null)
  const rows = parseRows(text)
  const overLimit = rows.length > MAX_SHEET_ROWS

  async function append() {
    try {
      const result = await post(`/sheets/${encodeURIComponent(sheet.id)}/append`, { rows, range: 'A1', confirm: true })
      setDone(result)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Rows added to the spreadsheet.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not add the rows.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-lg',
      bodyClassName: 'gap-3',
      children: done
        ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
          jsx(EmptyBlock, { icon: 'check', title: 'Rows added', description: `${plural(done.updatedRows || 0, 'row')} went into “${sheet.name}”.` }),
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(done.webUrl || sheetUrl(sheet.id)), children: 'Open in Sheets' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
          ] }),
        ] })
        : jsxs(Fragment, { children: [
          jsx(DialogHeader, { children: jsxs('div', { children: [
            jsx(DialogTitle, { children: 'Add rows' }),
            jsx(DialogDescription, { children: `${sheet.name}. Rows go after the last filled row. Existing cells are not changed.` }),
          ] }) }),
          jsx(Field, { label: 'Rows', hint: 'One row per line. Separate cells with tabs or commas.', children: jsx(Textarea, {
            value: text,
            onChange: (event) => setText(event.target.value),
            placeholder: 'Acme\t1234.50\tEUR\n2026-11-02\tInvoice 42',
            autoFocus: true,
            style: { width: '100%', minHeight: '10rem', resize: 'vertical', lineHeight: 1.55, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.78rem' },
          }) }),
          overLimit ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-red)' }, children: `Add at most ${MAX_SHEET_ROWS} rows at a time.` }) : null,
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !rows.length || overLimit, children: rows.length ? `Review ${plural(rows.length, 'row')}` : 'Add rows' }),
          ] }),
        ] }),
    }) }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: append,
      title: `Add ${plural(rows.length, 'row')} to “${sheet.name}”?`,
      description: 'The rows are appended to the sheet. Formulas such as =SUM(B2:B9) are evaluated by Google Sheets.',
      confirmLabel: 'Add rows',
      busyLabel: 'Writing…',
      doneLabel: 'Added',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.74rem', maxHeight: '9rem', overflow: 'auto', whiteSpace: 'pre', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }, children: rows.slice(0, 6).map((row) => row.join('  ·  ')).join('\n') + (rows.length > 6 ? `\n… and ${rows.length - 6} more` : '') }),
    }),
  ] })
}

// ── Contacts ─────────────────────────────────────────────────────────────────

function ContactRow({ contact, selected, onClick }) {
  const email = (contact.emails || [])[0] || ''
  return jsxs('button', {
    type: 'button',
    onClick,
    'aria-current': selected ? 'true' : undefined,
    style: {
      width: '100%', display: 'flex', gap: '0.65rem', alignItems: 'center', textAlign: 'left',
      padding: '0.55rem 0.7rem', border: 0, borderRadius: '7px',
      background: selected ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent',
      color: 'inherit', font: 'inherit', cursor: 'pointer', transition: rowTransition,
    },
    onMouseEnter: (event) => { if (!selected) event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { if (!selected) event.currentTarget.style.background = 'transparent' },
    children: [
      jsx(Avatar, { name: contact.name, email, size: '1.6rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '0.78rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: contact.name || email || 'No name' }),
        jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [contact.organization, email].filter(Boolean).join(' · ') }),
      ] }),
    ],
  })
}

function ContactDetail({ contact, onCompose, onClose }) {
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const primary = (contact.emails || [])[0] || ''
  const context = [contact.title, contact.organization].filter(Boolean).join(' · ')
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsx(Avatar, { name: contact.name, email: primary, size: '2.3rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 600, overflowWrap: 'anywhere' }, children: contact.name || 'No name' }),
        context ? jsx('div', { style: { marginTop: '0.2rem', fontSize: '0.75rem', color: 'var(--ui-text-tertiary)' }, children: context }) : null,
      ] }),
    ] }),
    primary ? jsx('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children:
      jsx(Button, { variant: 'default', size: 'sm', onClick: () => onCompose({ to: primary }), children: 'Write email' }) }) : null,
    jsx('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setEditOpen(true), children: 'Edit contact' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => setDeleteOpen(true), children: 'Delete' }),
    ] }) }),
    editOpen ? jsx(EditContactDialog, { contact, onClose: () => setEditOpen(false) }) : null,
    deleteOpen ? jsx(DeleteContactDialog, { contact, onClose: () => setDeleteOpen(false), onDeleted: () => onClose?.() }) : null,
    (contact.emails || []).length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.4rem' }, children: [
      jsx(SectionHeading, { title: 'Email' }),
      ...contact.emails.map((email) => jsx(CopyRow, { text: email, label: 'Email' }, email)),
    ] }) : null,
    (contact.phones || []).length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.4rem' }, children: [
      jsx(SectionHeading, { title: 'Phone' }),
      ...contact.phones.map((phone) => jsx(CopyRow, { text: phone, label: 'Phone number' }, phone)),
    ] }) : null,
  ] })
}

function ChangesTab() {
  const changes = useRecentChanges()
  return jsxs(Panel, { style: { padding: '0.9rem 1rem' }, children: [
    jsx(SectionHeading, {
      title: 'Recent changes',
      detail: 'From Hermes tasks',
      action: changes.length ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: clearChanges, children: 'Clear changes' }) : null,
    }),
    !changes.length
      ? jsx(EmptyBlock, { icon: 'history', title: 'No changes yet', description: 'When Hermes sends, creates or edits something in your Google account, it shows up here with a link.' })
      : jsx('div', { style: { display: 'flex', flexDirection: 'column' }, children: changes.map((entry) => jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.6rem 0.1rem', borderTop: '1px solid var(--ui-border-subtle, var(--border))' },
        children: [
          jsx(ServiceIcon, { service: entry.service }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.78rem', fontWeight: 600 }, children: entry.action }),
            entry.title ? jsx('div', { style: { fontSize: '0.73rem', color: 'var(--ui-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry.title }) : null,
          ] }),
          jsx(MetaLine, { icon: 'history', title: entry.at, children: fmtRelative(entry.at) }),
          entry.url ? jsx(LinkAction, { onClick: () => openUrl(entry.url), children: 'Open' }) : null,
        ],
      }, entry.id)) }),
  ] })
}

function ContactsTab({ selectedId, onSelect, onCompose, narrow }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const params = new URLSearchParams({ max_results: '40' })
  if (query) params.set('query', query)
  const listing = useApi(`/contacts?${params.toString()}`, { extra: [query] })
  const contacts = listing.data?.contacts || []
  const selected = contacts.find((contact) => contact.resourceName === selectedId) || null
  const showList = !narrow || !selectedId
  const showDetail = !narrow || !!selectedId

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsxs('div', { style: { display: 'flex', gap: '0.35rem', flex: 1, minWidth: '13rem' }, children: [
        jsx(SearchField, {
          placeholder: 'Search by name, email or phone',
          value: search,
          onChange: setSearch,
          onKeyDown: (event) => { if (event.key === 'Enter') setQuery(search.trim()) },
          variant: 'box',
          'aria-label': 'Search Google Contacts',
        }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setQuery(search.trim()), children: 'Search' }),
      ] }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setCreateOpen(true), children: 'New contact' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => listing.refetch(), children: 'Refresh' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(15rem, 21rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsx(Panel, { style: { overflow: 'auto', minHeight: 0, padding: '0.3rem' }, children: listing.isPending
          ? jsx(LoadingBlock, { label: 'Loading contacts…', rows: 6 })
          : listing.isError ? jsx(InlineError, { error: listing.error, onRetry: listing.refetch })
          : !contacts.length ? jsx(EmptyBlock, { icon: 'organization', title: 'No contacts found', description: query ? `Nothing matched “${query}”.` : 'Add a contact to get started.', action: jsx(Button, { variant: 'outline', size: 'xs', onClick: () => setCreateOpen(true), children: 'New contact' }) })
          : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: contacts.map((contact) => jsx(ContactRow, {
            contact,
            selected: !!selected && contact.resourceName === selected.resourceName,
            onClick: () => onSelect(contact.resourceName),
          }, contact.resourceName || contact.name)) }) }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: selected
          ? jsx(ContactDetail, { contact: selected, onCompose, onClose: narrow ? () => onSelect(null) : null })
          : jsx(ServiceEmpty, { service: 'contacts', title: 'Pick a contact', description: 'Select someone to see their details, or add a new contact.' }) }) : null,
      ],
    }),
    createOpen ? jsx(CreateContactDialog, { onClose: () => setCreateOpen(false), onCreated: (person) => onSelect(person.resourceName) }) : null,
  ] })
}

function CreateContactDialog({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [organization, setOrganization] = useState('')
  const [title, setTitle] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const ready = !!name.trim() && !!(email.trim() || phone.trim())

  async function create() {
    try {
      const person = await post('/contacts', {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        organization: organization.trim(),
        title: title.trim(),
        confirm: true,
      })
      refreshEverything()
      host.notify({ kind: 'success', message: 'Contact added to Google Contacts.' })
      onCreated?.(person)
      onClose()
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not add the contact.').message)
    }
  }

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-lg',
      bodyClassName: 'gap-3',
      children: jsxs(Fragment, { children: [
        jsx(DialogHeader, { children: jsxs('div', { children: [
          jsx(DialogTitle, { children: 'New contact' }),
          jsx(DialogDescription, { children: 'Adds a person to your Google Contacts. Give a name and an email address or phone number.' }),
        ] }) }),
        jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.6rem' }, children: [
          jsx(Field, { label: 'Name', children: jsx(Input, { value: name, onChange: (event) => setName(event.target.value), placeholder: 'Ana Lopez', autoFocus: true }) }),
          jsx(Field, { label: 'Email', children: jsx(Input, { value: email, onChange: (event) => setEmail(event.target.value), placeholder: 'ana@acme.test', type: 'email' }) }),
          jsx(Field, { label: 'Phone', children: jsx(Input, { value: phone, onChange: (event) => setPhone(event.target.value), placeholder: '+31 6 1234 5678' }) }),
          jsx(Field, { label: 'Organisation', children: jsx(Input, { value: organization, onChange: (event) => setOrganization(event.target.value), placeholder: 'Acme' }) }),
          jsx(Field, { label: 'Job title', children: jsx(Input, { value: title, onChange: (event) => setTitle(event.target.value), placeholder: 'CFO' }) }),
        ] }),
        !email.trim() && !phone.trim() && name.trim() ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-tertiary)' }, children: 'Add an email address or a phone number to save the contact.' }) : null,
        jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
          jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
          jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !ready, children: 'Review contact' }),
        ] }),
      ] }),
    }) }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: create,
      title: `Add ${name.trim() || 'this contact'} to Google Contacts?`,
      description: 'The contact is saved to your Google account and syncs to your devices.',
      confirmLabel: 'Add contact',
      busyLabel: 'Saving…',
      doneLabel: 'Saved',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.75rem', lineHeight: 1.6 }, children: [
        name.trim(), email.trim(), phone.trim(), [title.trim(), organization.trim()].filter(Boolean).join(' · '),
      ].filter(Boolean).join('\n') }),
    }),
  ] })
}

// ── Invoices → Sheet ─────────────────────────────────────────────────────────

function InvoicesDialog({ onClose }) {
  const [query, setQuery] = useState('')
  const [days, setDays] = useState('45')
  const [target, setTarget] = useState('')
  const [preview, setPreview] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, setResult] = useState(null)
  const windowDays = Math.min(365, Math.max(1, Number(days) || 45))
  const params = new URLSearchParams({ days: String(windowDays), max_results: '15' })
  if (query.trim()) params.set('query', query.trim())
  const plan = useApi(`/invoices?${params.toString()}`, { enabled: preview, extra: [query, windowDays, preview] })
  const rows = plan.data?.rows || []
  const spreadsheetId = extractId(target, 'sheet')
  const ready = preview && plan.isSuccess && rows.length > 0

  function changed(next) {
    setPreview(false)
    return next
  }

  async function write() {
    try {
      const payload = await post('/invoices', {
        query: query.trim(),
        days: windowDays,
        maxResults: 15,
        spreadsheetId,
        confirm: true,
      })
      setResult(payload)
      refreshEverything()
      host.notify({ kind: 'success', message: 'Invoice rows are in the sheet.' })
    } catch (err) {
      throw new Error(errorInfo(err, 'Could not write the invoice rows.').message)
    }
  }

  const sheetLink = result ? (result.spreadsheet?.webUrl || sheetUrl(result.spreadsheet?.id || spreadsheetId)) : ''

  return jsxs(Fragment, { children: [
    jsx(Dialog, { open: true, onOpenChange: (open) => { if (!open) onClose() }, children: jsx(DialogContent, {
      className: 'max-w-2xl',
      bodyClassName: 'gap-3',
      children: result
        ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.75rem' }, children: [
          jsx(EmptyBlock, {
            icon: 'check',
            title: result.created ? `Added ${plural(result.appended?.updatedRows || 0, 'invoice row')}` : 'Nothing new to add',
            description: result.created
              ? (result.skipped ? `${plural(result.skipped, 'invoice')} already in the sheet ${result.skipped === 1 ? 'was' : 'were'} skipped.` : 'Every invoice row is in the sheet now.')
              : (result.note || 'Those invoices are already recorded.'),
          }),
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(sheetLink), children: 'Open sheet' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: onClose, children: 'Done' }),
          ] }),
        ] })
        : jsxs(Fragment, { children: [
          jsx(DialogHeader, { children: jsxs('div', { children: [
            jsx(DialogTitle, { children: 'Invoices → Sheet' }),
            jsx(DialogDescription, { children: 'Finds emails with attachments that look like invoices or receipts. Preview first. Nothing is written until you confirm.' }),
          ] }) }),
          jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 8rem', gap: '0.6rem' }, children: [
            jsx(Field, { label: 'Extra search terms', hint: 'Optional, e.g. from:acme.test', children: jsx(Input, { value: query, onChange: (event) => setQuery(changed(event.target.value)), placeholder: 'Any Gmail search terms' }) }),
            jsx(Field, { label: 'Look back (days)', children: jsx(Input, { type: 'number', min: 1, max: 365, value: days, onChange: (event) => setDays(changed(event.target.value)) }) }),
          ] }),
          jsx(Field, { label: 'Spreadsheet', hint: 'Paste a Sheets link or id. Leave empty to create “Invoices (Hermes)”.', children: jsx(Input, { value: target, onChange: (event) => setTarget(event.target.value), placeholder: 'Optional' }) }),
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Close' }),
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setPreview(true), loading: plan.isFetching, children: 'Preview invoices' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !ready, children: 'Write to sheet…' }),
          ] }),
          !preview ? null
            : plan.isPending ? jsx(LoadingBlock, { label: 'Scanning your inbox for invoices…', rows: 4 })
            : plan.isError ? jsx(InlineError, { error: plan.error, onRetry: plan.refetch })
            : !rows.length ? jsx(EmptyBlock, { icon: 'table', title: 'No matching invoices', description: plan.data?.note || 'Try a longer look-back window or other search terms.' })
            : jsxs('div', { style: { ...insetStyle, maxHeight: '18rem', overflow: 'auto' }, children: [
              jsx('div', { style: { padding: '0.45rem 0.6rem', fontSize: '0.7rem', color: 'var(--ui-text-tertiary)' }, children: `${plural(rows.length, 'invoice row')} found. Check each amount against its attachment. Amounts are read from the email text and can be wrong.` }),
              ...rows.map((row, index) => jsxs('div', {
                style: { display: 'grid', gridTemplateColumns: '5.5rem minmax(0, 1fr) 7.5rem minmax(0, 1fr)', gap: '0.5rem', padding: '0.4rem 0.6rem', borderTop: '1px solid var(--ui-stroke-secondary)', fontSize: '0.73rem', alignItems: 'baseline' },
                children: [
                  jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: row.date || '—' }),
                  jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: senderName(row.from) }),
                  jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: row.amount ? `${row.currency ? `${row.currency} ` : ''}${row.amount}` : 'not found' }),
                  jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ui-text-tertiary)' }, children: row.file }),
                ],
              }, `${row.date}-${index}`)),
            ] }),
        ] }),
    }) }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm: write,
      title: 'Write these rows to Google Sheets?',
      description: spreadsheetId
        ? 'Rows go after the last row of that spreadsheet. Invoices already recorded there are skipped.'
        : 'A new spreadsheet named “Invoices (Hermes)” is created and the rows are added. Invoices already recorded are skipped.',
      confirmLabel: 'Write rows',
      busyLabel: 'Writing…',
      doneLabel: 'Written',
      children: jsx('div', { style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.74rem' }, children: `${plural(rows.length, 'invoice row')} from the preview above.` }),
    }),
  ] })
}

// ── Settings ─────────────────────────────────────────────────────────────────

const SCOPE_ROWS = [
  { id: 'gmail', label: 'Gmail', detail: 'Read mail and change labels (read, star, archive) without asking. Sending and drafting ask first.' },
  { id: 'calendar', label: 'Calendar', detail: 'Read your agenda and check conflicts. Creating events and inviting people asks first.' },
  { id: 'drive', label: 'Drive', detail: 'Search and read files. Creating folders and moving files ask first.' },
  { id: 'docs', label: 'Docs', detail: 'Read documents. Creating documents and adding text asks first.' },
  { id: 'sheets', label: 'Sheets', detail: 'Read spreadsheets. Creating sheets and adding rows asks first.' },
  { id: 'contacts', label: 'Contacts', detail: 'Read and search contacts. Creating a contact asks first.' },
]

function SettingsView({ status, onRetry, retrying }) {
  const setup = status?.setup || {}
  const byId = Object.fromEntries((status?.services || []).map((row) => [row.id, row]))
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', overflow: 'auto', paddingBottom: '1.5rem' }, children: [
    jsx(PageHeading, { title: 'Settings', subtitle: 'Your connection, what Hermes can reach, and how to change it.' }),

    jsxs(Panel, { style: { padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(SectionHeading, { title: 'Account' }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }, children: [
        jsx(StateDot, { state: status?.connected ? 'ready' : 'needs_permission' }),
        jsx('span', { children: status?.account || 'Not signed in' }),
      ] }),
      jsx('p', { style: { margin: 0, fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: 'Hermes keeps one Google account per profile. To change accounts, sign out and sign in again.' }),
    ] }),

    jsxs(Panel, { style: { padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }, children: [
      jsx(SectionHeading, { title: 'What Hermes can reach', detail: 'Granted when you signed in' }),
      ...SCOPE_ROWS.map((scope, index) => jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.55rem 0', borderTop: index ? '1px solid var(--ui-stroke-secondary)' : 'none' },
        children: [
          jsx(ServiceIcon, { service: scope.id, size: '0.9rem' }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.78rem', fontWeight: 500 }, children: scope.label }),
            jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.45, marginTop: '0.1rem' }, children: scope.detail }),
          ] }),
          jsx(StateBadge, { state: byId[scope.id]?.state || 'untested' }),
        ],
      }, scope.id)),
    ] }),

    jsxs(Panel, { style: { padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }, children: [
      jsx(SectionHeading, { title: 'Connection commands', detail: 'Run in a terminal' }),
      jsx(CopyRow, { text: setup.signInCommand || 'hermes auth add google-workspace:google', label: 'Sign-in command' }),
      jsx(CopyRow, { text: setup.statusCommand || 'hermes auth status google-workspace:google', label: 'Status command' }),
      jsx(CopyRow, { text: setup.signOutCommand || 'hermes auth logout google-workspace:google', label: 'Sign-out command' }),
      jsx('p', { style: { margin: '0.2rem 0 0', fontSize: '0.72rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.5 }, children: 'Hermes stores the refresh token in its own credential store. This plugin never sees it, and signing out removes it.' }),
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }, children: [
        jsx(Button, { variant: 'default', size: 'sm', onClick: onRetry, loading: retrying, children: retrying ? 'Checking…' : 'Check again' }),
        jsx(LinkAction, { icon: 'shield', onClick: () => openUrl('https://myaccount.google.com/permissions'), children: 'Manage Google access' }),
      ] }),
    ] }),
  ] })
}

// ── Page ─────────────────────────────────────────────────────────────────────

const NARROW_QUERY = '(max-width: 760px)'

// Callers pass an id, a row object, or a click event. Only the id or object is meaningful.
const idOf = (value) => (typeof value === 'string' ? value : value?.id) || null

function useNarrow() {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(NARROW_QUERY).matches : false))
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = () => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function TabBar({ value, onChange }) {
  const onKeyDown = (event) => {
    const index = TABS.findIndex((item) => item.id === value)
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = TABS.length - 1
    if (next < 0) return
    event.preventDefault()
    onChange(TABS[next].id)
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus()
  }
  return jsx('div', {
    role: 'tablist',
    'aria-label': 'Google services',
    onKeyDown,
    style: { display: 'flex', gap: '0.15rem', flexWrap: 'wrap', padding: '0.2rem', borderRadius: '9px', background: 'var(--ui-bg-quaternary)' },
    children: TABS.map((item) => {
      const selected = item.id === value
      return jsxs('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': selected,
        tabIndex: selected ? 0 : -1,
        onClick: () => onChange(item.id),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.3rem 0.6rem',
          border: 0, borderRadius: '7px', font: 'inherit', fontSize: '0.76rem',
          fontWeight: selected ? 600 : 500, cursor: 'pointer',
          color: selected ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
          background: selected ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent',
        },
        children: [
          item.service
            ? jsx(ServiceIcon, { service: item.service, size: '0.95rem' })
            : jsx(Icon, { name: item.icon, size: '0.85rem' }),
          jsx('span', { children: item.label }),
        ],
      }, item.id)
    }),
  })
}

// ── Changes to existing items ────────────────────────────────────────────────
// Each change follows one path: a form, a review that names the change, then an explicit confirm.
// The write itself sends confirm: true, so nothing changes unless the person pressed confirm.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_UPDATE_CELLS = 1000
const RSVP_OPTIONS = [
  { response: 'accepted', label: 'Going' },
  { response: 'tentative', label: 'Maybe' },
  { response: 'declined', label: 'Decline' },
]
const ROLE_OPTIONS = [
  { value: 'reader', label: 'Can view' },
  { value: 'commenter', label: 'Can comment' },
  { value: 'writer', label: 'Can edit' },
]

const rowsText = (count) => `${count} ${count === 1 ? 'row' : 'rows'}`
const cellsText = (count) => `${count} ${count === 1 ? 'cell' : 'cells'}`
const matchesText = (count) => (count === 1 ? '1 match' : `${count} matches`)

function parseEmails(text) {
  return String(text || '').split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean)
}

// One confirmed write. A failure is thrown, so the confirmation stays open and shows the message.
async function confirmedWrite(request, { fallback, success, onDone }) {
  try {
    const result = await request()
    refreshEverything()
    host.notify({ kind: 'success', message: success(result) })
    onDone?.(result)
  } catch (err) {
    throw new Error(errorInfo(err, fallback).message)
  }
}

function CheckRow({ checked, onChange, children }) {
  return jsxs('label', {
    style: { display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.78rem', color: 'var(--ui-text-secondary)', cursor: 'pointer' },
    children: [
      jsx('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked), style: { accentColor: 'var(--ui-accent)', margin: 0 } }),
      children,
    ],
  })
}

function SelectField({ value, onChange, options }) {
  return jsx('select', {
    value,
    onChange: (event) => onChange(event.target.value),
    style: {
      ...inputStyle,
      height: '2rem',
      padding: '0 0.5rem',
      borderRadius: '6px',
      border: '1px solid var(--ui-stroke-secondary)',
      background: 'var(--ui-bg-secondary)',
      color: 'inherit',
      fontSize: '0.8rem',
    },
    children: options.map((option) => jsx('option', { value: option.value, children: option.label }, option.value)),
  })
}

// A form, a review step that names the change, and the confirmation that sends it.
function ReviewDialog({ title, description, ready, reviewLabel, confirmTitle, confirmDescription, confirmLabel, summary, onConfirm, onClose, children }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  return jsxs(Fragment, { children: [
    jsx(Dialog, {
      open: true,
      onOpenChange: (open) => { if (!open) onClose() },
      children: jsx(DialogContent, {
        className: 'max-w-lg',
        bodyClassName: 'gap-3',
        children: jsxs(Fragment, { children: [
          jsx(DialogHeader, { children: jsxs('div', { children: [
            jsx(DialogTitle, { children: title }),
            description ? jsx(DialogDescription, { children: description }) : null,
          ] }) }),
          children,
          jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: onClose, children: 'Cancel' }),
            jsx(Button, { variant: 'default', size: 'sm', onClick: () => setConfirmOpen(true), disabled: !ready, children: reviewLabel }),
          ] }),
        ] }),
      }),
    }),
    jsx(ConfirmDialog, {
      open: confirmOpen,
      onClose: () => setConfirmOpen(false),
      onConfirm,
      title: confirmTitle,
      description: confirmDescription,
      confirmLabel,
      busyLabel: 'Saving…',
      doneLabel: 'Saved',
      children: jsx('div', {
        style: { ...insetStyle, padding: '0.6rem 0.7rem', fontSize: '0.75rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '9rem', overflow: 'auto' },
        children: summary,
      }),
    }),
  ] })
}

function EditEventDialog({ event, onClose }) {
  const timed = !event.allDay
  const [title, setTitle] = useState(event.summary || '')
  const [start, setStart] = useState(timed ? localInputValue(event.start) : '')
  const [end, setEnd] = useState(timed ? localInputValue(event.end) : '')
  const [place, setPlace] = useState(event.location || '')
  const [guests, setGuests] = useState('')
  const [notify, setNotify] = useState(true)

  const newGuests = parseEmails(guests)
  const badGuests = newGuests.filter((address) => !EMAIL_RE.test(address))
  const changes = {}
  if (title.trim() && title.trim() !== event.summary) changes.summary = title.trim()
  if (place.trim() !== (event.location || '')) changes.location = place.trim()
  if (timed && start && start !== localInputValue(event.start)) changes.start = isoFromLocal(start)
  if (timed && end && end !== localInputValue(event.end)) changes.end = isoFromLocal(end)
  if (newGuests.length && !badGuests.length) changes.addAttendees = newGuests
  const timesOk = !timed || (!!start && !!end && new Date(end) > new Date(start))
  const ready = Object.keys(changes).length > 0 && timesOk && !badGuests.length && !!title.trim()
  const summary = [
    changes.summary ? `Title: ${changes.summary}` : null,
    changes.start ? `Starts: ${fmtDateTime(changes.start)}` : null,
    changes.end ? `Ends: ${fmtDateTime(changes.end)}` : null,
    'location' in changes ? `Place: ${changes.location || '(cleared)'}` : null,
    changes.addAttendees ? `Add guests: ${changes.addAttendees.join(', ')}` : null,
    Object.keys(changes).length ? `Tell guests: ${notify ? 'yes' : 'no'}` : null,
  ].filter(Boolean).join('\n')

  return jsx(ReviewDialog, {
    title: 'Edit event',
    description: 'Change what you need. Nothing is saved until you review and confirm.',
    ready,
    reviewLabel: 'Review changes',
    confirmTitle: `Save changes to “${event.summary}”?`,
    confirmDescription: notify ? 'Guests are told about the change.' : 'Guests are not told.',
    confirmLabel: 'Save changes',
    summary,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/calendar/events/${encodeURIComponent(event.id)}/update`, { ...changes, sendUpdates: notify ? 'all' : 'none', confirm: true }),
      { fallback: 'Could not change the event.', success: () => 'Event updated.', onDone: onClose },
    ),
    children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(Field, { label: 'Title', children: jsx(Input, { value: title, onChange: (event) => setTitle(event.target.value) }) }),
      timed
        ? jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.6rem' }, children: [
          jsx(Field, { label: 'Starts', children: jsx(Input, { type: 'datetime-local', value: start, onChange: (event) => setStart(event.target.value) }) }),
          jsx(Field, { label: 'Ends', children: jsx(Input, { type: 'datetime-local', value: end, onChange: (event) => setEnd(event.target.value) }) }),
        ] })
        : jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-text-quaternary)', lineHeight: 1.5 }, children: 'All-day events keep their dates here. Change the dates in Google Calendar.' }),
      timed && start && end && !timesOk ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-red)' }, children: 'The end must be after the start.' }) : null,
      jsx(Field, { label: 'Place', children: jsx(Input, { value: place, placeholder: 'Room, address or link', onChange: (event) => setPlace(event.target.value) }) }),
      jsx(Field, { label: 'Add guests', hint: 'Email addresses separated by commas. Current guests stay.', children: jsx(Input, { value: guests, placeholder: 'bo@acme.test', onChange: (event) => setGuests(event.target.value) }) }),
      badGuests.length ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-red)' }, children: `Check ${badGuests.join(', ')}.` }) : null,
      jsx(CheckRow, { checked: notify, onChange: setNotify, children: 'Tell guests about the change' }),
    ] }),
  })
}

// Accept, maybe or decline. The organiser is told, so each reply is confirmed first.
function RsvpControls({ event }) {
  const [pending, setPending] = useState(null)
  const me = (event.attendees || []).find((person) => person.self)
  if (!me) return null
  const option = RSVP_OPTIONS.find((item) => item.response === pending)
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
    jsx(SectionHeading, { title: 'Your reply', detail: (RESPONSE_STYLE[me.response] || {}).label || 'No reply' }),
    jsx('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: RSVP_OPTIONS.map((item) => jsx(Button, {
      variant: me.response === item.response ? 'secondary' : 'outline',
      size: 'sm',
      onClick: () => setPending(item.response),
      children: item.label,
    }, item.response)) }),
    option ? jsx(ConfirmDialog, {
      open: true,
      onClose: () => setPending(null),
      onConfirm: () => confirmedWrite(
        () => post(`/calendar/events/${encodeURIComponent(event.id)}/rsvp`, { response: option.response, confirm: true }),
        { fallback: 'Could not send your reply.', success: () => `Reply sent: ${option.label}.`, onDone: () => setPending(null) },
      ),
      title: `Reply “${option.label}” to “${event.summary}”?`,
      description: 'The organiser is told how you replied. Nothing else changes.',
      confirmLabel: 'Send reply',
      busyLabel: 'Sending…',
      doneLabel: 'Sent',
    }) : null,
  ] })
}

// Deleting an event is final for the calendar, so it is confirmed. Guests are told only when ticked.
function CancelEventDialog({ event, onClose }) {
  const hasGuests = (event.attendees || []).length > 0
  const [notify, setNotify] = useState(true)
  return jsx(ConfirmDialog, {
    open: true,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/calendar/events/${encodeURIComponent(event.id)}/cancel`, { sendUpdates: hasGuests && notify ? 'all' : 'none', confirm: true }),
      { fallback: 'Could not cancel the event.', success: () => 'Event cancelled.', onDone: onClose },
    ),
    title: `Cancel “${event.summary}”?`,
    description: 'The event is deleted from your calendar.',
    confirmLabel: 'Delete event',
    busyLabel: 'Deleting…',
    doneLabel: 'Deleted',
    children: hasGuests ? jsx(CheckRow, { checked: notify, onChange: setNotify, children: 'Tell the guests' }) : null,
  })
}

function RenameFileDialog({ file, onClose, onRenamed }) {
  const [name, setName] = useState(file.name || '')
  const next = name.trim()
  return jsx(ReviewDialog, {
    title: 'Rename file',
    description: 'Collaborators see the new name straight away.',
    ready: !!next && next !== file.name,
    reviewLabel: 'Review rename',
    confirmTitle: `Rename “${file.name}”?`,
    confirmDescription: 'Only the name changes. Sharing and version history stay the same.',
    confirmLabel: 'Rename file',
    summary: `From: ${file.name}\nTo: ${next}`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/drive/files/${encodeURIComponent(file.id)}/rename`, { name: next, confirm: true }),
      { fallback: 'Could not rename the file.', success: () => 'File renamed.', onDone: (result) => { onRenamed?.(result); onClose() } },
    ),
    children: jsx(Field, { label: 'New name', children: jsx(Input, { value: name, autoFocus: true, onChange: (event) => setName(event.target.value) }) }),
  })
}

function TrashFileDialog({ file, onClose, onTrashed }) {
  return jsx(ReviewDialog, {
    title: 'Trash file',
    description: 'The file leaves its folder and goes to your Google Drive trash.',
    ready: true,
    reviewLabel: 'Review',
    confirmTitle: `Trash “${file.name}”?`,
    confirmDescription: 'You can restore it from Google Drive for 30 days. Shared links keep working until then.',
    confirmLabel: 'Trash file',
    summary: `File: ${file.name}\nRecoverable from Google Drive`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/drive/files/${encodeURIComponent(file.id)}/trash`, { confirm: true }),
      { fallback: 'Could not trash the file.', success: () => 'Moved to trash.', onDone: () => { onTrashed?.(); onClose() } },
    ),
    children: jsx('div', { style: { fontSize: '0.78rem', color: 'var(--ui-text-secondary)', lineHeight: 1.5 }, children: 'Anything shared with others keeps working until the file is permanently deleted from the trash.' }),
  })
}

function DeleteContactDialog({ contact, onClose, onDeleted }) {
  return jsx(ReviewDialog, {
    title: 'Delete contact',
    description: 'The contact is removed from your Google Contacts.',
    ready: true,
    reviewLabel: 'Review',
    confirmTitle: `Delete “${contact.name || 'this contact'}”?`,
    confirmDescription: 'Google keeps a 30-day undo in the People app, so you can bring them back.',
    confirmLabel: 'Delete contact',
    summary: `Contact: ${contact.name || 'Unnamed'}\nRecoverable in the People app for 30 days`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post('/contacts/delete', { resourceName: contact.resourceName, confirm: true }),
      { fallback: 'Could not delete the contact.', success: () => 'Contact deleted.', onDone: () => { onDeleted?.(); onClose() } },
    ),
    children: jsx('div', { style: { fontSize: '0.78rem', color: 'var(--ui-text-secondary)', lineHeight: 1.5 }, children: 'Their email history is not affected — only the contact entry is removed.' }),
  })
}

function ShareFileDialog({ file, onClose }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('reader')
  const [notify, setNotify] = useState(false)
  const address = email.trim()
  const roleLabel = (ROLE_OPTIONS.find((item) => item.value === role) || ROLE_OPTIONS[0]).label
  return jsx(ReviewDialog, {
    title: 'Share file',
    description: 'Gives one person access. You can change or remove it later in Google Drive.',
    ready: EMAIL_RE.test(address),
    reviewLabel: 'Review share',
    confirmTitle: `Share “${file.name}” with ${address}?`,
    confirmDescription: 'Only this person gets access. Anyone else needs their own share.',
    confirmLabel: 'Share file',
    summary: `Person: ${address}\nAccess: ${roleLabel}\nEmail them: ${notify ? 'yes' : 'no'}`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/drive/files/${encodeURIComponent(file.id)}/share`, { email: address, role, notify, confirm: true }),
      { fallback: 'Could not share the file.', success: () => `Shared with ${address}.`, onDone: onClose },
    ),
    children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(Field, { label: 'Person', hint: 'Their Google account email address.', children: jsx(Input, { type: 'email', value: email, placeholder: 'name@example.com', autoFocus: true, onChange: (event) => setEmail(event.target.value) }) }),
      jsx(Field, { label: 'Access', children: jsx(SelectField, { value: role, onChange: setRole, options: ROLE_OPTIONS }) }),
      jsx(CheckRow, { checked: notify, onChange: setNotify, children: 'Email them about this share' }),
    ] }),
  })
}

function ReplaceDocTextDialog({ doc, onClose }) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [matchCase, setMatchCase] = useState(true)
  const target = find.trim()
  return jsx(ReviewDialog, {
    title: 'Replace text',
    description: 'Every match in this document changes at once. Google Docs keeps version history if you need to go back.',
    ready: !!target,
    reviewLabel: 'Review replacement',
    confirmTitle: `Replace “${target}” in “${doc.name}”?`,
    confirmDescription: 'Every match is changed.',
    confirmLabel: 'Replace text',
    summary: `Find: ${target}\nReplace with: ${replace || '(nothing: the matches are deleted)'}\nMatch capitals: ${matchCase ? 'yes' : 'no'}`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/docs/${encodeURIComponent(doc.id)}/replace`, { find: target, replace, matchCase, confirm: true }),
      {
        fallback: 'Could not replace the text.',
        success: (result) => (result.occurrencesChanged ? `Replaced ${matchesText(result.occurrencesChanged)}.` : 'No matches found. Nothing changed.'),
        onDone: onClose,
      },
    ),
    children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(Field, { label: 'Find', children: jsx(Input, { value: find, placeholder: 'Text to find', autoFocus: true, onChange: (event) => setFind(event.target.value) }) }),
      jsx(Field, { label: 'Replace with', hint: 'Leave empty to delete the matches.', children: jsx(Input, { value: replace, placeholder: 'Replacement text (leave empty to delete)', onChange: (event) => setReplace(event.target.value) }) }),
      jsx(CheckRow, { checked: matchCase, onChange: setMatchCase, children: 'Match capitals exactly' }),
    ] }),
  })
}

function WriteRangeDialog({ sheet, onClose }) {
  const [range, setRange] = useState('')
  const [text, setText] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const rows = parseRows(text)
  const cells = rows.reduce((total, row) => total + row.length, 0)
  const overLimit = cells > MAX_UPDATE_CELLS
  const target = range.trim()
  return jsx(ReviewDialog, {
    title: 'Write cells',
    description: `${sheet.name}. Start the range at the first cell to fill, for example Budget!A5:B5.`,
    ready: !!target && rows.length > 0 && !overLimit,
    reviewLabel: rows.length ? `Review ${rowsText(rows.length)}` : 'Review',
    confirmTitle: `Write ${rowsText(rows.length)} to ${target} in “${sheet.name}”?`,
    confirmDescription: overwrite
      ? 'Cells that already have values are replaced.'
      : 'If any of those cells already has a value, nothing is written.',
    confirmLabel: 'Write cells',
    summary: `Range: ${target}\nRows: ${rows.length} (${cellsText(cells)})\n${overwrite ? 'Replace cells that already have values' : 'Keep cells that already have values'}`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/sheets/${encodeURIComponent(sheet.id)}/range`, { range: target, rows, overwrite, confirm: true }),
      { fallback: 'Could not write the cells.', success: (result) => `${cellsText(result.updatedCells || 0)} written.`, onDone: onClose },
    ),
    children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(Field, { label: 'Range', hint: 'The tab name and the cells, for example Budget!A5:B5.', children: jsx(Input, { value: range, placeholder: 'Budget!A5:B5', autoFocus: true, onChange: (event) => setRange(event.target.value) }) }),
      jsx(Field, { label: 'Rows', hint: 'One row per line. Separate cells with tabs or commas.', children: jsx(Textarea, {
        value: text,
        onChange: (event) => setText(event.target.value),
        placeholder: 'Lunch\t12.00',
        style: { width: '100%', minHeight: '8rem', resize: 'vertical', lineHeight: 1.55, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.75rem' },
      }) }),
      overLimit ? jsx('div', { style: { fontSize: '0.72rem', color: 'var(--ui-red)' }, children: `Write at most ${MAX_UPDATE_CELLS} cells at a time.` }) : null,
      jsx(CheckRow, { checked: overwrite, onChange: setOverwrite, children: 'Replace cells that already have values' }),
    ] }),
  })
}

function AddTabDialog({ sheet, onClose }) {
  const [title, setTitle] = useState('')
  const name = title.trim()
  return jsx(ReviewDialog, {
    title: 'Add a tab',
    description: `${sheet.name}. The new tab starts empty.`,
    ready: !!name,
    reviewLabel: 'Review tab',
    confirmTitle: `Add a tab named “${name}” to “${sheet.name}”?`,
    confirmDescription: 'Existing tabs and their data are not changed.',
    confirmLabel: 'Add tab',
    summary: `New tab: ${name}`,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post(`/sheets/${encodeURIComponent(sheet.id)}/tabs`, { title: name, confirm: true }),
      { fallback: 'Could not add the tab.', success: () => `Tab “${name}” added.`, onDone: onClose },
    ),
    children: jsx(Field, { label: 'Tab name', children: jsx(Input, { value: title, placeholder: 'Q4', autoFocus: true, onChange: (event) => setTitle(event.target.value) }) }),
  })
}

function EditContactDialog({ contact, onClose }) {
  const [name, setName] = useState(contact.name || '')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [organization, setOrganization] = useState(contact.organization || '')
  const [title, setTitle] = useState(contact.title || '')
  const changes = {}
  if (name.trim() && name.trim() !== (contact.name || '')) changes.name = name.trim()
  if (email.trim()) changes.email = email.trim()
  if (phone.trim()) changes.phone = phone.trim()
  if (organization.trim() && organization.trim() !== (contact.organization || '')) changes.organization = organization.trim()
  if (title.trim() && title.trim() !== (contact.title || '')) changes.title = title.trim()
  const emailOk = !email.trim() || EMAIL_RE.test(email.trim())
  const summary = [
    changes.name ? `Name: ${changes.name}` : null,
    changes.email ? `Add email: ${changes.email}` : null,
    changes.phone ? `Add phone: ${changes.phone}` : null,
    changes.organization ? `Organisation: ${changes.organization}` : null,
    changes.title ? `Job title: ${changes.title}` : null,
  ].filter(Boolean).join('\n')

  return jsx(ReviewDialog, {
    title: 'Edit contact',
    description: 'Only the fields you change are saved. Existing emails and phone numbers are kept.',
    ready: Object.keys(changes).length > 0 && emailOk,
    reviewLabel: 'Review changes',
    confirmTitle: `Save changes to “${contact.name || 'this contact'}”?`,
    confirmDescription: 'The contact syncs to your devices.',
    confirmLabel: 'Save contact',
    summary,
    onClose,
    onConfirm: () => confirmedWrite(
      () => post('/contacts/update', { resourceName: contact.resourceName, ...changes, confirm: true }),
      { fallback: 'Could not save the contact.', success: () => 'Contact saved.', onDone: onClose },
    ),
    children: jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.6rem' }, children: [
      jsx(Field, { label: 'Name', hint: 'Leave as it is to keep the current name.', children: jsx(Input, { value: name, onChange: (event) => setName(event.target.value) }) }),
      jsx(Field, { label: 'Add email', hint: !emailOk ? 'Check the email address.' : 'Keeps the addresses already on the contact.', children: jsx(Input, { value: email, type: 'email', placeholder: 'ana@acme.test', onChange: (event) => setEmail(event.target.value) }) }),
      jsx(Field, { label: 'Add phone', children: jsx(Input, { value: phone, placeholder: '+31 6 1234 5678', onChange: (event) => setPhone(event.target.value) }) }),
      jsx(Field, { label: 'Organisation', children: jsx(Input, { value: organization, placeholder: 'Acme', onChange: (event) => setOrganization(event.target.value) }) }),
      jsx(Field, { label: 'Job title', hint: 'To remove a value, edit it in Google Contacts.', children: jsx(Input, { value: title, placeholder: 'CFO', onChange: (event) => setTitle(event.target.value) }) }),
    ] }),
  })
}

function GoogleWorkspacePage() {
  const narrow = useNarrow()
  const [tab, setTab] = useState('Overview')
  const [selectedMessageId, setSelectedMessageId] = useState(null)
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [selectedSheet, setSelectedSheet] = useState(null)
  const [selectedContactId, setSelectedContactId] = useState(null)
  const [compose, setCompose] = useState(null)
  const [emailToEventMessage, setEmailToEventMessage] = useState(null)
  const [eventOpen, setEventOpen] = useState(false)
  const [brief, setBrief] = useState(null)
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [invoicesOpen, setInvoicesOpen] = useState(false)

  const status = useApi('/status')
  const connected = !!status.data?.connected
  const overview = useApi('/overview', { enabled: connected })

  const openMessage = (value) => { setSelectedMessageId(idOf(value)); setTab('Gmail') }
  const openEvent = (value) => { setSelectedEventId(idOf(value)); setTab('Calendar') }
  const openFile = (value) => { setSelectedFile(value && typeof value === 'object' ? value : null); setTab('Drive') }
  const openDoc = (file) => { setSelectedDoc(file); setTab('Docs') }
  const openSheet = (file) => { setSelectedSheet(file); setTab('Sheets') }
  const openCompose = (initial) => setCompose({ initial: initial || {} })
  // A brief needs a meeting. Without one, send the user to the calendar to pick it.
  const openBrief = (eventId) => {
    const id = idOf(eventId)
    if (id) setBrief({ eventId: id, query: '' })
    else setTab('Calendar')
  }

  function renderTab() {
    switch (tab) {
      case 'Gmail':
        return jsx(GmailTab, { selectedId: selectedMessageId, onSelect: setSelectedMessageId, onCompose: openCompose, onEmailToEvent: setEmailToEventMessage, narrow })
      case 'Calendar':
        return jsx(CalendarTab, { selectedId: selectedEventId, onSelect: setSelectedEventId, onCreateEvent: () => setEventOpen(true), onBrief: openBrief, narrow, account: status.data?.account || '' })
      case 'Drive':
        return jsx(DriveTab, { selectedFile, onSelect: setSelectedFile, onOrganize: () => setOrganizeOpen(true), onOpenDoc: openDoc, onOpenSheet: openSheet, narrow })
      case 'Docs':
        return jsx(DocsTab, { selectedDoc, onSelect: setSelectedDoc, onOpenFile: openFile, narrow })
      case 'Sheets':
        return jsx(SheetsTab, { selectedSheet, onSelect: setSelectedSheet, narrow })
      case 'Contacts':
        return jsx(ContactsTab, { selectedId: selectedContactId, onSelect: setSelectedContactId, onCompose: openCompose, narrow })
      case 'Changes':
        return jsx(ChangesTab, {})
      case 'Settings':
        return jsx(SettingsView, { status: status.data, onRetry: () => status.refetch(), retrying: status.isFetching })
      default:
        return jsx(OverviewTab, {
          status: status.data,
          overview,
          onOpenMessage: openMessage,
          onOpenEvent: openEvent,
          onOpenFile: openFile,
          onCompose: () => openCompose({}),
          onEvent: () => setEventOpen(true),
          onBrief: openBrief,
          onOrganize: () => setOrganizeOpen(true),
          onInvoices: () => setInvoicesOpen(true),
        })
    }
  }

  let body
  if (status.isPending) body = jsx(LoadingBlock, { label: 'Checking your Google connection…', rows: 4 })
  else if (status.isError) body = jsx(InlineError, { error: status.error, onRetry: status.refetch })
  else if (!connected) body = jsx(SetupView, { status: status.data, onRetry: () => status.refetch(), retrying: status.isFetching })
  else body = renderTab()

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '0.8rem', height: '100%', minHeight: 0, boxSizing: 'border-box', padding: narrow ? '0.8rem' : '1rem 1.1rem' },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'space-between' }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }, children: [
          jsx(GoogleG, { size: '1.05rem' }),
          jsx('h1', { style: { margin: 0, fontSize: '0.95rem', fontWeight: 600 }, children: 'Google Workspace' }),
          connected && status.data?.account ? jsx('span', { style: { fontSize: '0.72rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: status.data.account }) : null,
        ] }),
        connected ? jsx(TabBar, { value: tab, onChange: setTab }) : null,
      ] }),

      jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }, children: body }),

      compose ? jsx(ComposeDialog, { initial: compose.initial, onClose: () => setCompose(null) }) : null,
      emailToEventMessage ? jsx(EmailToEventDialog, { message: emailToEventMessage, onClose: () => setEmailToEventMessage(null) }) : null,
      eventOpen ? jsx(EventDialog, { onClose: () => setEventOpen(false) }) : null,
      brief ? jsx(BriefDialog, {
        eventId: brief.eventId,
        query: brief.query,
        onClose: () => setBrief(null),
        onOpenMessage: (id) => { setBrief(null); openMessage(id) },
        onOpenFile: (file) => { setBrief(null); openFile(file) },
      }) : null,
      organizeOpen ? jsx(OrganizeDialog, { onClose: () => setOrganizeOpen(false) }) : null,
      invoicesOpen ? jsx(InvoicesDialog, { onClose: () => setInvoicesOpen(false) }) : null,
    ],
  })
}

// ── Registration ─────────────────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: 'Google Workspace',
  description: 'Gmail, Calendar, Drive, Docs, Sheets and Contacts in one place. Hermes works across them and asks before it sends or changes anything.',
  defaultEnabled: true,
  register(ctx) {
    pluginCtx = ctx
    recentChanges = readStoredChanges()
    ctx.onEvent?.(CHANGES_EVENT, (event) => recordChanges(event?.payload?.changes))
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: PAGE_PATH },
      render: () => jsx(GoogleWorkspacePage, {}),
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 60,
      data: { codicon: 'globe', label: 'Google Workspace', path: PAGE_PATH, icon: GoogleG },
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'google-workspace.open',
        label: 'Open Google Workspace',
        keywords: ['google', 'gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts', 'workspace', 'email', 'invoice'],
        run: () => host.navigate(PAGE_PATH),
      },
    })
  },
}
