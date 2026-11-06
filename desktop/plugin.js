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
import { useEffect, useMemo, useState } from 'react'

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
  { id: 'Overview', label: 'Overview', icon: 'home' },
  { id: 'Gmail', label: 'Gmail', icon: 'mail' },
  { id: 'Calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'Drive', label: 'Drive', icon: 'cloud' },
  { id: 'Docs', label: 'Docs', icon: 'book' },
  { id: 'Sheets', label: 'Sheets', icon: 'table' },
  { id: 'Contacts', label: 'Contacts', icon: 'organization' },
  { id: 'Settings', label: 'Settings', icon: 'settings-gear' },
]

const SERVICE_ICONS = {
  gmail: 'mail',
  calendar: 'calendar',
  drive: 'cloud',
  docs: 'book',
  sheets: 'table',
  contacts: 'organization',
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
  letterSpacing: '0.02em',
  color: 'var(--ui-text-tertiary)',
  marginBottom: '0.35rem',
}

const inputStyle = { width: '100%' }

function Icon({ name, size = '1rem', color, style }) {
  return jsx(Codicon, { name, size, style: { color, ...style } })
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
        jsx('h2', { style: { margin: 0, fontSize: '1.05rem', fontWeight: 650, letterSpacing: '-0.01em' }, children: title }),
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
        jsx('h3', { style: { margin: 0, fontSize: '0.82rem', fontWeight: 650 }, children: title }),
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

function Avatar({ name, email, size = '1.7rem' }) {
  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      width: size, height: size, borderRadius: '999px', flexShrink: 0,
      display: 'grid', placeItems: 'center',
      background: 'color-mix(in srgb, var(--ui-accent) 16%, var(--ui-bg-tertiary))',
      color: 'var(--ui-text-secondary)', fontSize: `calc(${size} * 0.38)`, fontWeight: 700,
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
          children: jsx(Icon, { name: 'cloud', size: '1.15rem', color: 'var(--ui-accent)' }),
        }),
        jsxs('div', { style: { minWidth: 0 }, children: [
          jsx('h2', { style: { margin: 0, fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.02em' }, children: 'Connect Google Workspace' }),
          jsx('p', { style: { margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.55, maxWidth: '40rem' }, children: 'Hermes uses your own Google Cloud OAuth client. Nothing is bundled, no token is stored in this plugin, and you can revoke access from your Google Account at any time.' }),
        ] }),
      ] }),

      jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(15rem, 20rem)', gap: '1rem', alignItems: 'start' }, children: [
        jsxs(Panel, { style: { padding: '1rem' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.8rem' }, children: [
            jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 700, color: 'var(--ui-text-secondary)' }, children: '1' }),
            jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 650 }, children: 'Create a Desktop OAuth client' }),
          ] }),
          jsx('p', { style: { margin: '0 0 0.6rem', fontSize: '0.77rem', color: 'var(--ui-text-tertiary)', lineHeight: 1.55 }, children: 'In Google Cloud, enable Gmail, Calendar, Drive, Docs, Sheets, and People, then create an OAuth client of type “Desktop app”.' }),
          jsxs('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }, children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(GOOGLE_LINKS.cloud), children: 'Open Google Cloud credentials' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => openUrl(GOOGLE_LINKS.scopes), children: 'Scope guide' }),
          ] }),
        ] }),

        jsxs(Panel, { style: { padding: '1rem' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }, children: [
            jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 700, color: 'var(--ui-text-secondary)' }, children: '2' }),
            jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 650 }, children: 'Client status' }),
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
          jsx('span', { style: { width: '1.35rem', height: '1.35rem', borderRadius: '999px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', fontSize: '0.68rem', fontWeight: 700, color: 'var(--ui-text-secondary)' }, children: '3' }),
          jsx('h3', { style: { margin: 0, fontSize: '0.84rem', fontWeight: 650 }, children: 'Add the credentials and sign in' }),
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
          jsx('h3', { style: { margin: 0, fontSize: '0.82rem', fontWeight: 650 }, children: 'Service access' }),
          jsx('span', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)' }, children: 'Checked live against Google' }),
        ] }),
        jsx('div', { style: { ...surfaceStyle, overflow: 'hidden' }, children: rows.map((row, index) => jsxs('div', {
          style: { display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.65rem 0.8rem', borderTop: index ? '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent)' : 'none' },
          children: [
            jsx(Icon, { name: SERVICE_ICONS[row.id] || 'file', size: '0.9rem', color: 'var(--ui-text-tertiary)' }),
            jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
              jsx('div', { style: { fontSize: '0.78rem', fontWeight: 550 }, children: row.label }),
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
      jsx('span', { style: { fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.03em', color: 'var(--ui-text-tertiary)', textTransform: 'uppercase' }, children: label }),
      jsx(Icon, { name: icon, size: '0.85rem', color: 'var(--ui-text-quaternary)' }),
    ] }),
    jsx('div', { style: { fontSize: '1.5rem', fontWeight: 680, letterSpacing: '-0.03em', lineHeight: 1.15, marginTop: '0.45rem' }, children: value }),
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
      color: 'inherit', font: 'inherit', cursor: 'pointer',
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
      color: 'inherit', font: 'inherit', cursor: 'pointer',
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: [
      jsxs('div', { style: { width: '4.2rem', flexShrink: 0, textAlign: 'right', paddingTop: '0.05rem' }, children: [
        jsx('div', { style: { fontSize: '0.73rem', fontWeight: 600, color: 'var(--ui-text-secondary)' }, children: event.allDay ? 'All day' : fmtTime(event.start) }),
        showDay ? jsx('div', { style: { fontSize: '0.65rem', color: 'var(--ui-text-quaternary)' }, children: fmtDay(event.start) }) : null,
      ] }),
      jsxs('div', { style: { flex: 1, minWidth: 0, borderLeft: '2px solid color-mix(in srgb, var(--ui-accent) 35%, transparent)', paddingLeft: '0.6rem' }, children: [
        jsx('div', { style: { fontSize: '0.78rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: event.summary }),
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
      color: 'inherit', font: 'inherit', cursor: 'pointer',
    },
    onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
    children: [
      jsx('span', { style: { width: '1.7rem', height: '1.7rem', borderRadius: '6px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', flexShrink: 0 }, children: jsx(Icon, { name: fileIcon(file.mimeType), size: '0.85rem', color: 'var(--ui-text-tertiary)' }) }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '0.77rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: file.name }),
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
        jsx('span', { style: { fontSize: '0.78rem', fontWeight: 620 }, children: title }),
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

function OverviewTab({ status, overview, onOpenMessage, onOpenEvent, onOpenFile, onCompose, onEvent, onBrief, onOrganize, onInvoices }) {
  const data = overview.data || {}
  const errors = data.errors || {}
  const nextEvent = (data.events || [])[0]
  const unread = data.unread || 0
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', paddingBottom: '1.5rem' }, children: [
    jsx(PageHeading, {
      title: 'Your Google work, without the tab hunt',
      subtitle: status?.account ? `Signed in as ${status.account}. Reads are automatic; sends and shares wait for you.` : 'Reads are automatic; sends and shares wait for you.',
      actions: [
        jsx(Button, { variant: 'outline', size: 'sm', onClick: onCompose, children: 'Compose' }),
        jsx(Button, { variant: 'ghost', size: 'sm', onClick: onEvent, children: 'New event' }),
      ],
    }),

    jsx(GlobalSearch, { onOpenMessage, onOpenEvent, onOpenFile }),

    overview.isPending ? jsx(LoadingBlock, { label: 'Gathering unread mail, today’s agenda, and recent files…', rows: 4 })
      : overview.isError ? jsx(InlineError, { error: overview.error, onRetry: overview.refetch })
      : jsxs(Fragment, { children: [
        jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.6rem' }, children: [
          jsx(StatCard, { icon: 'mail', label: 'Unread', value: unread, detail: unread ? 'Waiting in your inbox' : 'Inbox is clear', onClick: () => onOpenMessage(null) }),
          jsx(StatCard, { icon: 'calendar', label: 'Next up', value: nextEvent ? fmtTime(nextEvent.start) : '—', detail: nextEvent ? nextEvent.summary : 'No events in the next day', onClick: () => onOpenEvent(nextEvent || null) }),
          jsx(StatCard, { icon: 'cloud', label: 'Recent files', value: (data.files || []).length, detail: 'Changed in Drive', onClick: () => onOpenFile(null) }),
        ] }),

        jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 0.85fr)', gap: '0.8rem', alignItems: 'start' }, children: [
          jsxs(Panel, { style: { padding: '0.7rem' }, children: [
            jsx(SectionHeading, { title: 'Today and tomorrow', detail: (data.events || []).length ? `${(data.events || []).length} event${(data.events || []).length === 1 ? '' : 's'}` : '', action: jsx(LinkAction, { icon: 'calendar', onClick: () => onOpenEvent(null), children: 'Calendar' }) }),
            errors.calendar ? jsx(InlineError, { error: errors.calendar, onRetry: overview.refetch }) : null,
            (data.events || []).length
              ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.1rem' }, children: (data.events || []).slice(0, 6).map((event) => jsx(EventRow, { event, onClick: () => onOpenEvent(event), showDay: true }, event.id)) })
              : !errors.calendar ? jsx(EmptyBlock, { icon: 'calendar', title: 'No meetings on the horizon', description: 'Enjoy the quiet, or put something on the calendar.', action: jsx(Button, { variant: 'outline', size: 'xs', onClick: onEvent, children: 'New event' }) }) : null,
          ] }),

          jsxs(Panel, { style: { padding: '0.7rem' }, children: [
            jsx(SectionHeading, { title: 'Inbox', detail: unread ? `${unread} unread` : 'All read', action: jsx(LinkAction, { icon: 'mail', onClick: () => onOpenMessage(null), children: 'Gmail' }) }),
            errors.gmail_inbox ? jsx(InlineError, { error: errors.gmail_inbox, onRetry: overview.refetch }) : null,
            (data.messages || []).length
              ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (data.messages || []).map((message) => jsx(MessageRow, { message, onClick: () => onOpenMessage(message.id) }, message.id)) })
              : !errors.gmail_inbox ? jsx(EmptyBlock, { icon: 'mail', title: 'Nothing new', description: 'The inbox is quiet.' }) : null,
          ] }),
        ] }),

        jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.8rem', alignItems: 'start' }, children: [
          jsxs(Panel, { style: { padding: '0.7rem' }, children: [
            jsx(SectionHeading, { title: 'Recent Drive files', detail: 'Most recently modified', action: jsx(LinkAction, { icon: 'cloud', onClick: () => onOpenFile(null), children: 'Drive' }) }),
            errors.drive ? jsx(InlineError, { error: errors.drive, onRetry: overview.refetch }) : null,
            (data.files || []).length
              ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: (data.files || []).map((file) => jsx(FileRow, { file, onClick: () => onOpenFile(file) }, file.id)) })
              : !errors.drive ? jsx(EmptyBlock, { icon: 'cloud', title: 'No files yet', description: 'Files you own or can edit show up here.' }) : null,
          ] }),

          jsxs(Panel, { style: { padding: '0.8rem' }, children: [
            jsx(SectionHeading, { title: 'Workflows', detail: 'The cross-app part' }),
            jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }, children: [
              jsx(WorkflowCard, { icon: 'note', title: 'Meeting brief', detail: 'Attendees, recent threads, related files, and an agenda in one page.', action: 'Pick a meeting →', onClick: () => onBrief(null) }),
              jsx(WorkflowCard, { icon: 'calendar', title: 'Email → event', detail: 'Read a date from a message and create the invitation.', action: 'Start from Gmail →', onClick: () => onOpenMessage(null) }),
              jsx(WorkflowCard, { icon: 'table', title: 'Invoices → Sheet', detail: 'Find invoice attachments and append a reviewable row per file.', action: 'Scan inbox →', onClick: onInvoices }),
              jsx(WorkflowCard, { icon: 'folder', title: 'Organize Drive', detail: 'Preview matching files, then move them into one folder.', action: 'Build a move plan →', onClick: onOrganize }),
            ] }),
          ] }),
        ] }),

        jsx('div', { style: { fontSize: '0.69rem', color: 'var(--ui-text-quaternary)', display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }, children: [
          jsx('span', { children: `Snapshot ${fmtTime(data.generatedAt)}` }),
          jsx('span', { children: '·' }),
          jsx(LinkAction, { icon: 'shield', onClick: () => openUrl('https://myaccount.google.com/permissions'), children: 'Manage Google access' }),
        ] }),
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
            jsx('span', { style: { fontSize: '0.72rem', fontWeight: 650, letterSpacing: '0.02em', color: 'var(--ui-text-tertiary)' }, children: query ? `Results for “${query}”` : 'Inbox' }),
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
          ] }) : jsx(EmptyBlock, { icon: 'mail', title: 'Pick a message', description: 'Select a conversation on the left. Reads stay private; nothing is marked or sent without a button.' }),
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
      if (action === 'archive') onSelect(null)
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
            jsx('h2', { style: { margin: 0, fontSize: '1.02rem', fontWeight: 650, lineHeight: 1.35 }, children: message.subject }),
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
    ] }),

    jsx(Separator, {}),

    message.body
      ? jsx('div', { style: { fontSize: '0.82rem', lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)' }, children: message.body })
      : jsx(EmptyBlock, { icon: 'mail', title: 'No readable body', description: 'This message may contain only HTML that could not be converted, or the body was too large.' }),

    (message.attachments || []).length ? jsxs('div', { style: { ...insetStyle, padding: '0.65rem' }, children: [
      jsx('div', { style: { fontSize: '0.7rem', fontWeight: 650, color: 'var(--ui-text-tertiary)', marginBottom: '0.4rem' }, children: 'Attachments' }),
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

function CalendarTab({ selectedId, onSelect, onCreateEvent, onBrief, narrow }) {
  const [days, setDays] = useState(7)
  const agenda = useApi(`/calendar?days=${days}&max_results=100`, { extra: [days] })
  const events = agenda.data?.events || []
  const selected = events.find((event) => event.id === selectedId) || null
  const groups = useMemo(() => groupEventsByDay(events), [events])

  const showList = !narrow || !selectedId
  const showDetail = !narrow || !!selectedId

  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.7rem', height: '100%', minHeight: 0 }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }, children: [
      jsx('div', { style: { display: 'flex', gap: '0.25rem', flex: 1 }, children: [7, 14, 30].map((value) => jsx(Button, {
        variant: days === value ? 'secondary' : 'ghost',
        size: 'sm',
        onClick: () => setDays(value),
        children: value === 7 ? 'Next 7 days' : `${value} days`,
      }, value)) }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => agenda.refetch(), children: 'Refresh' }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: onCreateEvent, children: 'New event' }),
    ] }),

    jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(17rem, 25rem) minmax(0, 1fr)', gap: '0.7rem', flex: 1, minHeight: 0 },
      children: [
        showList ? jsxs(Panel, { style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }, children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.55rem 0.75rem', borderBottom: '1px solid color-mix(in srgb, var(--ui-stroke-secondary) 65%, transparent)' }, children: [
            jsx('span', { style: { fontSize: '0.72rem', fontWeight: 650, letterSpacing: '0.02em', color: 'var(--ui-text-tertiary)' }, children: 'Agenda' }),
            agenda.data ? jsx('span', { style: { fontSize: '0.68rem', color: 'var(--ui-text-quaternary)' }, children: `${events.length} event${events.length === 1 ? '' : 's'}` }) : null,
          ] }),
          jsx('div', { style: { overflow: 'auto', minHeight: 0, padding: '0.35rem' }, children: agenda.isPending
            ? jsx(LoadingBlock, { label: 'Reading your calendar…', rows: 6 })
            : agenda.isError ? jsx(InlineError, { error: agenda.error, onRetry: agenda.refetch })
            : !events.length ? jsx(EmptyBlock, { icon: 'calendar', title: 'Nothing scheduled', description: `No events in the next ${days} days.`, action: jsx(Button, { variant: 'outline', size: 'xs', onClick: onCreateEvent, children: 'New event' }) })
            : groups.map((group) => jsxs('div', { style: { marginBottom: '0.35rem' }, children: [
              jsx('div', {
                style: {
                  position: 'sticky', top: 0, zIndex: 1, padding: '0.3rem 0.45rem',
                  fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                  color: 'var(--ui-text-quaternary)', background: 'var(--ui-bg-secondary)',
                },
                children: fmtDay(group.day),
              }),
              jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.05rem' }, children: group.events.map((event) => jsx('div', {
                style: { borderRadius: '7px', background: event.id === selectedId ? 'var(--ui-row-active-background, var(--ui-row-hover-background))' : 'transparent' },
                children: jsx(EventRow, { event, onClick: () => onSelect(event.id) }),
              }, event.id)) }),
            ] }, group.key)) }),
        ] }) : null,

        showDetail ? jsx(Panel, { style: { minHeight: 0, overflow: 'auto' }, children: selected
          ? jsx(EventDetail, { event: selected, onBrief, onCreateEvent, onClose: narrow ? () => onSelect(null) : null })
          : jsx(EmptyBlock, { icon: 'calendar', title: 'Pick a meeting', description: 'Choose an event to see guests, the agenda, and a briefing built from your mail and files.' }) }) : null,
      ],
    }),
  ] })
}

function EventDetail({ event, onBrief, onCreateEvent, onClose }) {
  const description = String(event.description || '').trim()
  const attendees = event.attendees || []
  const response = (person) => RESPONSE_STYLE[person.response] || { color: 'var(--ui-text-quaternary)', label: person.response || 'Guest' }
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1.02rem', fontWeight: 650, lineHeight: 1.35 }, children: event.summary }),
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
      onCreateEvent ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: onCreateEvent, children: 'New event' }) : null,
    ] }),

    jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.45rem' }, children: [
      jsx(SectionHeading, { title: 'Guests', detail: attendees.length ? `${attendees.length}` : 'Just you' }),
      attendees.length ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.1rem' }, children: attendees.map((person) => {
        const style = response(person)
        return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.4rem', borderRadius: '6px' }, children: [
          jsx(Avatar, { name: person.name, email: person.email, size: '1.5rem' }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.75rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.name || person.email }),
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
                    jsx('div', { style: { fontSize: '0.74rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: person.name || person.email }),
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
                    jsx('div', { style: { fontSize: '0.73rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.subject }),
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
          ? jsx(FileDetail, { file: selected, onOpenDoc, onOpenSheet, onClose: narrow ? () => onSelect(null) : null })
          : jsx(EmptyBlock, { icon: 'cloud', title: 'Pick a file', description: 'Choose a file to see who owns it, when it changed, and where to open it.' }) }) : null,
      ],
    }),
  ] })
}

function FileDetail({ file, onOpenDoc, onOpenSheet, onClose }) {
  const isDoc = file.mimeType === MIME_DOC
  const isSheet = file.mimeType === MIME_SHEET
  const owners = file.owners || []
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsx('span', { style: { width: '2.3rem', height: '2.3rem', borderRadius: '8px', background: 'var(--ui-bg-quaternary)', display: 'grid', placeItems: 'center', flexShrink: 0 }, children: jsx(Icon, { name: fileIcon(file.mimeType), size: '1.1rem', color: 'var(--ui-text-tertiary)' }) }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 650, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: file.name }),
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
    ] }),

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
            jsx('div', { style: { fontSize: '0.74rem', fontWeight: 550 }, children: owner.name || owner.email }),
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
                jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 650, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: reader.data?.title || current.name }),
                jsxs('div', { style: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }, children: [
                  jsx(MetaLine, { icon: 'book', children: reader.data ? `${reader.data.characters.toLocaleString()} characters` : 'Google Doc' }),
                  current.modified ? jsx(MetaLine, { icon: 'history', children: fmtRelative(current.modified) }) : null,
                ] }),
              ] }),
            ] }),
            jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
              jsx(Button, { variant: 'default', size: 'sm', onClick: () => setAppendOpen(true), disabled: !reader.data, children: 'Append text' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(reader.data?.webUrl || current.webUrl), children: 'Open in Docs' }),
              onOpenFile ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenFile(current), children: 'File details' }) : null,
            ] }),
            reader.isPending ? jsx(LoadingBlock, { label: 'Reading the document…', rows: 6 })
              : reader.isError ? jsx(InlineError, { error: reader.error, onRetry: reader.refetch })
              : jsx('div', { style: { ...insetStyle, padding: '0.85rem 0.95rem', fontSize: '0.8rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ui-text-secondary)', minHeight: '10rem' }, children: reader.data?.text || 'This document is empty. Use “Append text” to add the first paragraph.' }),
            jsx('div', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: `Read-only view. Characters beyond ${'20,000'} are truncated in Hermes; open the doc for the full text.` }),
          ] })
          : jsx(EmptyBlock, { icon: 'book', title: 'Pick a document', description: 'Select a doc to read it here, or create a new one.' }) }) : null,
      ],
    }),
    createOpen ? jsx(CreateDocDialog, {
      onClose: () => setCreateOpen(false),
      onCreated: (doc) => onSelect({ id: doc.id, name: doc.title, mimeType: MIME_DOC, webUrl: doc.webUrl }),
    }) : null,
    appendOpen && current ? jsx(AppendDocDialog, { doc: current, onClose: () => setAppendOpen(false) }) : null,
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
                jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 650, lineHeight: 1.35, overflowWrap: 'anywhere' }, children: current.name }),
                jsx('div', { style: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }, children: [
                  jsx(MetaLine, { icon: 'table', children: preview.data ? `${plural(preview.data.rows || 0, 'row')} in view` : 'Google Sheet' }),
                  current.modified ? jsx(MetaLine, { icon: 'history', children: fmtRelative(current.modified) }) : null,
                ] }),
              ] }),
            ] }),
            jsxs('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children: [
              jsx(Button, { variant: 'default', size: 'sm', onClick: () => setAppendOpen(true), children: 'Add rows' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => openUrl(current.webUrl || sheetUrl(current.id)), children: 'Open in Sheets' }),
            ] }),
            preview.isPending ? jsx(LoadingBlock, { label: 'Reading the sheet…', rows: 6 })
              : preview.isError ? jsx(InlineError, { error: preview.error, onRetry: preview.refetch })
              : jsx(SheetGrid, { values: preview.data?.values || [] }),
            jsx('div', { style: { fontSize: '0.67rem', color: 'var(--ui-text-quaternary)' }, children: `Showing ${SHEET_PREVIEW_RANGE}. Open the sheet for everything else.` }),
          ] })
          : jsx(EmptyBlock, { icon: 'table', title: 'Pick a spreadsheet', description: 'Select one to preview its data here, or create a new one.' }) }) : null,
      ],
    }),
    createOpen ? jsx(CreateSheetDialog, { onClose: () => setCreateOpen(false), onCreated: (sheet) => onSelect(sheet) }) : null,
    appendOpen && current ? jsx(AppendSheetDialog, { sheet: current, onClose: () => setAppendOpen(false) }) : null,
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
      color: 'inherit', font: 'inherit', cursor: 'pointer',
    },
    onMouseEnter: (event) => { if (!selected) event.currentTarget.style.background = 'var(--ui-row-hover-background)' },
    onMouseLeave: (event) => { if (!selected) event.currentTarget.style.background = 'transparent' },
    children: [
      jsx(Avatar, { name: contact.name, email, size: '1.6rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('div', { style: { fontSize: '0.78rem', fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: contact.name || email || 'No name' }),
        jsx('div', { style: { fontSize: '0.7rem', color: 'var(--ui-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [contact.organization, email].filter(Boolean).join(' · ') }),
      ] }),
    ],
  })
}

function ContactDetail({ contact, onCompose, onClose }) {
  const primary = (contact.emails || [])[0] || ''
  const context = [contact.title, contact.organization].filter(Boolean).join(' · ')
  return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.9rem 1rem 1.2rem' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '0.6rem' }, children: [
      onClose ? jsx(Button, { variant: 'ghost', size: 'xs', onClick: onClose, children: 'Back' }) : null,
      jsx(Avatar, { name: contact.name, email: primary, size: '2.3rem' }),
      jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
        jsx('h2', { style: { margin: 0, fontSize: '1rem', fontWeight: 650, overflowWrap: 'anywhere' }, children: contact.name || 'No name' }),
        context ? jsx('div', { style: { marginTop: '0.2rem', fontSize: '0.75rem', color: 'var(--ui-text-tertiary)' }, children: context }) : null,
      ] }),
    ] }),
    primary ? jsx('div', { style: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }, children:
      jsx(Button, { variant: 'default', size: 'sm', onClick: () => onCompose({ to: primary }), children: 'Write email' }) }) : null,
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
          : jsx(EmptyBlock, { icon: 'organization', title: 'Pick a contact', description: 'Select someone to see their details, or add a new contact.' }) }) : null,
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
          jsx(Icon, { name: SERVICE_ICONS[scope.id] || 'file', size: '0.9rem', color: 'var(--ui-text-tertiary)' }),
          jsxs('div', { style: { flex: 1, minWidth: 0 }, children: [
            jsx('div', { style: { fontSize: '0.78rem', fontWeight: 550 }, children: scope.label }),
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
        children: [jsx(Icon, { name: item.icon, size: '0.8rem' }), jsx('span', { children: item.label })],
      }, item.id)
    }),
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
        return jsx(CalendarTab, { selectedId: selectedEventId, onSelect: setSelectedEventId, onCreateEvent: () => setEventOpen(true), onBrief: openBrief, narrow })
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
          jsx(Icon, { name: 'globe', size: '1rem', color: 'var(--ui-accent)' }),
          jsx('h1', { style: { margin: 0, fontSize: '0.95rem', fontWeight: 650 }, children: 'Google Workspace' }),
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
      data: { codicon: 'globe', label: 'Google Workspace', path: PAGE_PATH },
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
