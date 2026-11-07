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
  { id: 'Settings', label: 'Settings', icon: 'settings-gear' },
]

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

// The six Google product marks, drawn from the official artwork. Each takes only a size,
// so the same component serves a 0.9rem tab glyph and a 7rem empty state.
function GmailIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '52 42 88 66', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'b', fill: '#4285f4', d: 'M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6' }),
      jsx('path', { key: 'g', fill: '#34a853', d: 'M120 108h14c3.32 0 6-2.69 6-6V59l-20 15' }),
      jsx('path', { key: 'y', fill: '#fbbc04', d: 'M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2' }),
      jsx('path', { key: 'r', fill: '#ea4335', d: 'M72 74V48l24 18 24-18v26L96 92' }),
      jsx('path', { key: 'd', fill: '#c5221f', d: 'M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2' }),
    ],
  })
}

function CalendarIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 200 200', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: jsx('g', { transform: 'translate(3.75 3.75)', children: [
      jsx('path', { key: 'w', fill: '#FFFFFF', d: 'M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579l5.263-53.947L148.882,43.618z' }),
      jsx('path', { key: 't1', fill: '#1A73E8', d: 'M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342c2.053,1.737,4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421C73.408,129.263,69.145,127.934,65.211,125.276z' }),
      jsx('path', { key: 't2', fill: '#1A73E8', d: 'M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z' }),
      jsx('path', { key: 'r', fill: '#EA4335', d: 'M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z' }),
      jsx('path', { key: 'g', fill: '#34A853', d: 'M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z' }),
      jsx('path', { key: 'b', fill: '#4285F4', d: 'M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75H12.039z' }),
      jsx('path', { key: 'dg', fill: '#188038', d: 'M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z' }),
      jsx('path', { key: 'y', fill: '#FBBC04', d: 'M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z' }),
      jsx('path', { key: 'db', fill: '#1967D2', d: 'M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z' }),
    ] }),
  })
}

function DriveIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 87.3 78', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'b', fill: '#0066da', d: 'm6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z' }),
      jsx('path', { key: 'g', fill: '#00ac47', d: 'm43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z' }),
      jsx('path', { key: 'r', fill: '#ea4335', d: 'm73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z' }),
      jsx('path', { key: 'dg', fill: '#00832d', d: 'm43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z' }),
      jsx('path', { key: 'y', fill: '#fbbc04', d: 'm59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z' }),
    ],
  })
}

function DocsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 64 88', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'a', fill: '#3086F6', d: 'M58,88H6c-3.3,0-6-2.7-6-6V6c0-3.3,2.7-6,6-6h36l22,22v60C64,85.3,61.3,88,58,88z' }),
      jsx('path', { key: 'b', fill: '#0C67D6', d: 'M42,0l22,22H42V0z' }),
      jsx('path', { key: 'c', fill: '#FDFFFF', d: 'M50,39H14v-5h36V39z M50,46H14v5h36V46z M40,58H14v5h26V58z' }),
    ],
  })
}

function SheetsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 64 88', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'a', fill: '#188038', d: 'M 42,0 64,22 53,24 42,22 40,11 Z' }),
      jsx('path', { key: 'b', fill: '#34a853', d: 'M 42,22 V 0 H 6 C 2.685,0 0,2.685 0,6 v 76 c 0,3.315 2.685,6 6,6 h 52 c 3.315,0 6,-2.685 6,-6 V 22 Z' }),
      jsx('path', { key: 'c', fill: '#fff', d: 'M 12,34 V 63 H 52 V 34 Z M 29.5,58 H 17 v -7 h 12.5 z m 0,-12 H 17 V 39 H 29.5 Z M 47,58 H 34.5 V 51 H 47 Z M 47,46 H 34.5 V 39 H 47 Z' }),
    ],
  })
}

function ContactsIcon({ size = '1rem' }) {
  return jsx('svg', {
    viewBox: '0 0 500 500', width: size, height: size, 'aria-hidden': 'true',
    style: { display: 'block', flexShrink: 0 },
    children: [
      jsx('path', { key: 'a', fill: '#86a9ff', d: 'M199 244c-89 0-161 71-161 160v67c0 16 13 29 29 29h77l77-256z' }),
      jsx('path', { key: 'b', fill: '#578cff', d: 'M462 349c0-58-48-105-106-105h-77v256h77c58 0 106-47 106-106' }),
      jsx('path', { key: 'c', fill: '#0057cc', d: 'M115 349c0-58 48-105 106-105h58c58 0 106 47 106 105v45c0 59-48 106-106 106H144c-16 0-29-13-29-29z' }),
      jsx('circle', { key: 'd', cx: '250', cy: '99.4', r: '99.4', fill: '#0057cc' }),
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

// The right-hand panel's empty state. The service's own mark fills the pane, with the
// title underneath, so a blank panel still says what it is for.
function ServiceEmpty({ service, title, description }) {
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '1.2rem', padding: '2rem', flex: 1, minHeight: 0 },
    children: [
      jsx('div', { style: { width: '10rem', height: '10rem', display: 'grid', placeItems: 'center' }, children: jsx(ServiceIcon, { service, size: '10rem' }) }),
      jsx('div', { style: { fontSize: '1rem', fontWeight: 600, letterSpacing: '-0.01em' }, children: title }),
      description ? jsx('div', { style: { fontSize: '0.8rem', color: 'var(--ui-text-tertiary)', maxWidth: '30rem', lineHeight: 1.55 }, children: description }) : null,
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
            children: jsx(Icon, { name: 'grip-vertical', size: '0.9rem' }),
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
