// UI tests for desktop/plugin.js. The plugin runs unchanged; only '@hermes/plugin-sdk' and the
// backend (ctx.rest) are replaced. Every write is checked: it must wait for review and confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { host, navigations, notices, PALETTE_AREA, queryClient, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import fs from 'node:fs'
import path from 'node:path'
import plugin from '../../../desktop/plugin.js'

// `npm test` runs from tests/js, so this resolves to the plugin in the project root.
const PLUGIN_SOURCE = fs.readFileSync(path.resolve(process.cwd(), '../../desktop/plugin.js'), 'utf8')
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

const CONNECTED = {
  connected: true,
  account: 'me@example.com',
  services: [
    { id: 'gmail', label: 'Gmail', state: 'ready', detail: 'me@example.com' },
    { id: 'calendar', label: 'Calendar', state: 'ready', detail: '' },
    { id: 'drive', label: 'Drive', state: 'ready', detail: '' },
    { id: 'docs', label: 'Docs', state: 'ready', detail: '' },
    { id: 'sheets', label: 'Sheets', state: 'ready', detail: '' },
    { id: 'contacts', label: 'Contacts', state: 'ready', detail: '' },
  ],
  setup: {
    clientConfigured: true,
    signInCommand: 'hermes auth add google-workspace:google',
    statusCommand: 'hermes auth status google-workspace:google',
    signOutCommand: 'hermes auth logout google-workspace:google',
  },
}

const DISCONNECTED = {
  ...CONNECTED,
  connected: false,
  account: '',
  services: CONNECTED.services.map((row) => ({ ...row, state: 'untested', detail: '' })),
}

const OVERVIEW = { unread: 0, events: [], messages: [], files: [], errors: {}, generatedAt: '2026-11-06T09:00:00Z' }

const ok = (data) => ({ ok: true, data })

// Routes are matched in order against "METHOD /path?query". Put overrides before the defaults.
function defaultRoutes() {
  return [
    [/^GET \/status$/, () => ok(CONNECTED)],
    [/^GET \/overview$/, () => ok(OVERVIEW)],
  ]
}

function fakeContext(routes) {
  const registrations = []
  const rest = vi.fn(async (path, options = {}) => {
    const key = `${(options.method || 'GET').toUpperCase()} ${path}`
    const match = routes.find(([pattern]) => pattern.test(key))
    if (!match) throw new Error(`No test route for ${key}`)
    const value = await match[1](path, options)
    if (value instanceof Error) throw value
    return value
  })
  return {
    rest,
    registrations,
    register: (entry) => { registrations.push(entry); return () => {} },
    registerMany: (entries) => entries.map((entry) => { registrations.push(entry); return () => {} }),
    onDispose: () => {},
    i18n: { register: () => {}, t: (key) => key },
    os: { openExternal: vi.fn(async () => true), writeClipboard: vi.fn(async () => true) },
  }
}

let container = null
let root = null

function mount(ctx) {
  const page = ctx.registrations.find((entry) => entry.area === ROUTES_AREA)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, page.render()))
  })
}

async function until(check, description) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  }
  throw new Error(`Timed out waiting for ${description}.\nVisible text: ${container?.textContent.slice(0, 500)}`)
}

const tabs = () => [...container.querySelectorAll('[role="tab"]')]
const tab = (label) => tabs().find((node) => node.textContent.trim() === label)
const button = (label, scope = container) => [...scope.querySelectorAll('button')].find((node) => node.textContent.trim() === label) || null
const rowButton = (text) => [...container.querySelectorAll('button')].find((node) => node.textContent.includes(text)) || null
const dialog = () => document.querySelector('[role="alertdialog"]')
const writes = (ctx) => ctx.rest.mock.calls.filter(([, options]) => options?.method === 'POST')

async function click(node) {
  await act(async () => { node.click() })
}

function setInput(node, value) {
  const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  act(() => {
    set.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Finds each POST call site and the object literal passed as its body.
function postCallSites(source) {
  const sites = []
  for (const match of source.matchAll(/\bpost\(\s*([`'"])([^`'"]+)\1\s*,/g)) {
    const start = source.indexOf('{', match.index + match[0].length)
    let depth = 0
    let end = start
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      if (source[index] === '}') {
        depth -= 1
        if (depth === 0) { end = index; break }
      }
    }
    sites.push({ path: match[2], body: source.slice(start, end + 1) })
  }
  return sites
}

beforeEach(() => {
  queryClient.clear()
  notices.length = 0
  navigations.length = 0
})

afterEach(() => {
  if (root) act(() => { root.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('registration', () => {
  it('registers a page, a sidebar entry and a palette command', () => {
    const ctx = fakeContext([])
    plugin.register(ctx)
    expect(plugin.id).toBe('google-workspace')
    expect(ctx.registrations.find((entry) => entry.area === ROUTES_AREA)?.data).toEqual({ path: '/google-workspace' })
    expect(ctx.registrations.find((entry) => entry.area === SIDEBAR_NAV_AREA)?.data).toMatchObject({
      label: 'Google Workspace',
      path: '/google-workspace',
    })
    const palette = ctx.registrations.find((entry) => entry.area === PALETTE_AREA)
    expect(palette.data.label).toBe('Open Google Workspace')
    palette.data.run()
    expect(navigations.at(-1)).toBe('/google-workspace')
  })
})

describe('connection', () => {
  it('shows the connection steps and fetches no account data while Google is not connected', async () => {
    const ctx = fakeContext([[/^GET \/status$/, () => ok(DISCONNECTED)]])
    plugin.register(ctx)
    mount(ctx)
    await until(() => container.textContent.includes('Connect Google Workspace'), 'the connect screen')
    expect(container.textContent).toContain('hermes auth add google-workspace:google')
    expect(ctx.rest.mock.calls.map(([path]) => path)).toEqual(['/status'])
    expect(tabs()).toHaveLength(0)
  })

  it('lists all eight areas once connected and loads a tab only when it is opened', async () => {
    const ctx = fakeContext([...defaultRoutes(), [/^GET \/contacts/, () => ok({ contacts: [], count: 0 })]])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    expect(tabs().map((node) => node.textContent.trim())).toEqual([
      'Overview', 'Gmail', 'Calendar', 'Drive', 'Docs', 'Sheets', 'Contacts', 'Settings',
    ])
    expect(tab('Overview').getAttribute('aria-selected')).toBe('true')

    await click(tab('Contacts'))
    await until(() => ctx.rest.mock.calls.some(([path]) => path.startsWith('/contacts')), 'the contacts request')
    const paths = ctx.rest.mock.calls.map(([path]) => path)
    expect(paths.some((path) => path.startsWith('/gmail'))).toBe(false)
    expect(paths.some((path) => path.startsWith('/calendar'))).toBe(false)
  })

  it('moves between tabs with the arrow, Home and End keys', async () => {
    const ctx = fakeContext(defaultRoutes())
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    const list = container.querySelector('[role="tablist"]')
    const press = async (key) => act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    const selected = () => tabs().find((node) => node.getAttribute('aria-selected') === 'true')?.textContent.trim()

    await press('ArrowRight')
    expect(selected()).toBe('Gmail')
    await press('ArrowLeft')
    expect(selected()).toBe('Overview')
    await press('ArrowLeft')
    expect(selected()).toBe('Settings')
    await press('Home')
    expect(selected()).toBe('Overview')
    await press('End')
    expect(selected()).toBe('Settings')
  })

  it('shows the Gmail permission fix in plain words when a request is refused', async () => {
    const refused = new Error('HTTP 403: ' + JSON.stringify({
      detail: {
        code: 'scope_missing',
        message: 'Gmail is not allowed for this action.',
        hint: 'Sign in again and approve the Gmail permission.',
      },
    }))
    const ctx = fakeContext([...defaultRoutes(), [/^GET \/gmail\?/, () => refused]])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Gmail'))
    await until(() => container.textContent.includes('Gmail is not allowed for this action.'), 'the permission message')
    expect(container.textContent).toContain('Sign in again and approve the Gmail permission.')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('writes wait for review and confirmation', () => {
  it('adds rows to a sheet only after review and an explicit confirm', async () => {
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/drive\?.*mime_type=application%2Fvnd\.google-apps\.spreadsheet/, () => ok({
        files: [{ id: 's1', name: 'Budget', mimeType: SHEET_MIME }],
      })],
      [/^GET \/sheets\/s1\?range=/, () => ok({ id: 's1', values: [['Item', 'Cost'], ['Rent', '900']], rows: 2 })],
      [/^POST \/sheets\/s1\/append$/, () => ok({ updatedRows: 2, appended: true, webUrl: 'https://docs.google.com/spreadsheets/d/s1/edit' })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Sheets'))
    await until(() => container.textContent.includes('Budget'), 'the spreadsheet list')
    await click(rowButton('Budget'))
    await until(() => button('Add rows'), 'the Add rows action')
    await click(button('Add rows'))
    await until(() => container.querySelector('textarea'), 'the rows field')
    setInput(container.querySelector('textarea'), 'Coffee\t4.50\nTea\t3.20')
    await until(() => button('Review 2 rows'), 'the review button')
    await click(button('Review 2 rows'))
    await until(() => dialog(), 'the confirmation')
    expect(dialog().textContent).toContain('Add 2 rows to “Budget”?')
    expect(writes(ctx)).toHaveLength(0)

    await click(button('Add rows', dialog()))
    await until(() => writes(ctx).length === 1, 'the append request')
    const [path, options] = writes(ctx)[0]
    expect(path).toBe('/sheets/s1/append')
    expect(options.body).toEqual({ rows: [['Coffee', '4.50'], ['Tea', '3.20']], range: 'A1', confirm: true })
  })

  it('writes nothing when the sheet review is cancelled', async () => {
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/drive\?.*mime_type=application%2Fvnd\.google-apps\.spreadsheet/, () => ok({
        files: [{ id: 's1', name: 'Budget', mimeType: SHEET_MIME }],
      })],
      [/^GET \/sheets\/s1\?range=/, () => ok({ id: 's1', values: [], rows: 0 })],
      [/^POST \/sheets\/s1\/append$/, () => ok({ updatedRows: 1 })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Sheets'))
    await until(() => container.textContent.includes('Budget'), 'the spreadsheet list')
    await click(rowButton('Budget'))
    await until(() => button('Add rows'), 'the Add rows action')
    await click(button('Add rows'))
    await until(() => container.querySelector('textarea'), 'the rows field')
    setInput(container.querySelector('textarea'), 'Lunch\t12.00')
    await until(() => button('Review 1 row'), 'the review button')
    await click(button('Review 1 row'))
    await until(() => dialog(), 'the confirmation')
    await click(button('Cancel', dialog()))
    await until(() => !dialog(), 'the confirmation to close')
    expect(writes(ctx)).toHaveLength(0)
  })

  it('enables contact creation only with a name and an email or phone, then asks first', async () => {
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/contacts/, () => ok({ contacts: [], count: 0 })],
      [/^POST \/contacts$/, () => ok({ resourceName: 'people/c9', name: 'Ana Lopez', emails: ['ana@acme.test'], created: true })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Contacts'))
    await until(() => button('New contact'), 'the New contact button')
    await click(button('New contact'))
    await until(() => document.querySelector('input[placeholder="Ana Lopez"]'), 'the contact form')

    expect(button('Review contact').disabled).toBe(true)
    setInput(document.querySelector('input[placeholder="Ana Lopez"]'), 'Ana Lopez')
    expect(button('Review contact').disabled).toBe(true)
    setInput(document.querySelector('input[placeholder="ana@acme.test"]'), 'ana@acme.test')
    expect(button('Review contact').disabled).toBe(false)

    await click(button('Review contact'))
    await until(() => dialog(), 'the confirmation')
    expect(writes(ctx)).toHaveLength(0)
    await click(button('Add contact', dialog()))
    await until(() => writes(ctx).length === 1, 'the create request')
    expect(writes(ctx)[0][0]).toBe('/contacts')
    expect(writes(ctx)[0][1].body).toMatchObject({ name: 'Ana Lopez', email: 'ana@acme.test', confirm: true })
  })

  it('stars a message at once, because the change is reversible and notifies nobody', async () => {
    const message = {
      id: 'm1',
      threadId: 't1',
      subject: 'Pricing',
      from: 'Ana <ana@acme.test>',
      received: '2026-11-06T09:00:00Z',
      snippet: 'hello',
      unread: true,
      labels: ['INBOX', 'UNREAD'],
    }
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/gmail\?/, () => ok({ messages: [message] })],
      [/^GET \/gmail\/m1$/, () => ok({ ...message, to: 'me@example.com', cc: '', date: 'Fri, 6 Nov 2026 10:00:00 +0100', body: 'Numbers attached', hasAttachments: false, attachments: [] })],
      [/^POST \/gmail\/m1\/modify$/, () => ok({ id: 'm1', labels: ['INBOX', 'UNREAD', 'STARRED'], starred: true })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Gmail'))
    await until(() => rowButton('Pricing'), 'the message list')
    await click(rowButton('Pricing'))
    await until(() => button('Star'), 'the Star action')
    await click(button('Star'))
    await until(() => writes(ctx).length === 1, 'the modify request')
    expect(writes(ctx)[0][0]).toBe('/gmail/m1/modify')
    expect(writes(ctx)[0][1].body).toEqual({ action: 'star' })
    expect(dialog()).toBeNull()
  })
})

describe('error text from the host', () => {
  it('still shows a plain message when the host does not pass through the JSON envelope', async () => {
    const plain = new Error('Gmail sign-in is missing. Run hermes auth add google-workspace:google.')
    const ctx = fakeContext([...defaultRoutes(), [/^GET \/gmail\?/, () => plain]])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Gmail'))
    await until(() => container.textContent.includes('Gmail sign-in is missing.'), 'the plain error message')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('search across services', () => {
  it('searches Gmail, Calendar and Drive together, labels each result by service, and opens it', async () => {
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/search\?query=pricing$/, () => ok({
        query: 'pricing',
        messages: [{ id: 'm1', subject: 'Pricing thread', from: 'Ana <ana@acme.test>', snippet: 'numbers', received: '2026-11-05T09:00:00Z', unread: false }],
        events: [{ id: 'e1', summary: 'Pricing review', start: '2026-11-12T10:00:00+01:00', end: '2026-11-12T11:00:00+01:00', attendees: [] }],
        files: [{ id: 'd1', name: 'Pricing notes', mimeType: 'application/vnd.google-apps.document', webUrl: 'https://docs.google.com/document/d/d1/edit', modified: '2026-11-04T08:00:00Z' }],
        errors: {},
      })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    const input = container.querySelector('input[placeholder="Search Gmail, Calendar and Drive at once"]')
    setInput(input, 'pricing')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await until(() => container.textContent.includes('Pricing notes'), 'the search results')
    const text = container.textContent
    for (const service of ['Gmail', 'Calendar', 'Drive']) expect(text).toContain(service)
    expect(text).toContain('Pricing thread')
    expect(text).toContain('Pricing review')

    await click(rowButton('Pricing notes'))
    expect(tab('Drive').getAttribute('aria-selected')).toBe('true')
  })
})

describe('calendar', () => {
  it('warns about a clash while the time is being chosen, and creates nothing', async () => {
    const ctx = fakeContext([
      ...defaultRoutes(),
      [/^GET \/calendar\?/, () => ok({ events: [], count: 0 })],
      [/^GET \/calendar\/availability\?/, () => ok({
        free: false,
        conflicts: [{ id: 'e1', summary: 'Standup' }],
      })],
    ])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Calendar'))
    await until(() => button('New event'), 'the New event button')
    await click(button('New event'))
    await until(() => container.textContent.includes('Overlaps 1 event: Standup'), 'the clash warning')
    expect(container.querySelector('[role="status"]').textContent).toContain('Standup')
    expect(writes(ctx)).toHaveLength(0)
  })
})

describe('settings', () => {
  it('lists what Hermes can reach and the connection commands, with no sign-out button', async () => {
    const ctx = fakeContext(defaultRoutes())
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 8, 'the eight service tabs')
    await click(tab('Settings'))
    await until(() => container.textContent.includes('What Hermes can reach'), 'the settings page')
    for (const area of ['Gmail', 'Calendar', 'Drive', 'Docs', 'Sheets', 'Contacts']) {
      expect(container.textContent).toContain(area)
    }
    expect(container.textContent).toContain('hermes auth logout google-workspace:google')
    expect(button('Sign out')).toBeNull()
  })
})

describe('source guards', () => {
  it('uses theme variables instead of hard-coded colours, in both themes', () => {
    expect(PLUGIN_SOURCE.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })

  it('sends confirm: true from every write except drafts and reversible label changes', () => {
    const sites = postCallSites(PLUGIN_SOURCE)
    expect(sites.length).toBeGreaterThanOrEqual(10)
    const exempt = (path) => path.includes('/draft') || path.includes('/modify')
    for (const site of sites) {
      if (exempt(site.path)) continue
      expect(site.body, `write to ${site.path} must confirm`).toMatch(/confirm:\s*true/)
    }
  })

  it('reports successes through the host, not with a silent write', () => {
    expect(host.notify).toBeTypeOf('function')
    expect(notices).toEqual([])
  })
})
