// Test-only stand-in for '@hermes/plugin-sdk'. The real components ship inside Hermes Desktop.
// These keep the same names, the same area constants (checked against apps/desktop/src), and the
// same ConfirmDialog contract: run onConfirm, show the done label, close 600 ms later, and keep
// the dialog open with the error message when onConfirm throws.
import { useRef, useState } from 'react'
import { QueryClient, useQuery as reactUseQuery } from '@tanstack/react-query'

export const ROUTES_AREA = 'routes' // apps/desktop/src/app/routes.ts
export const SIDEBAR_NAV_AREA = 'sidebar.nav' // apps/desktop/src/app/routes.ts
export const PALETTE_AREA = 'palette' // apps/desktop/src/app/command-palette/contrib.ts

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
export const useQuery = reactUseQuery

export const notices = []
export const navigations = []
export const host = {
  notify: (notice) => { notices.push(notice) },
  navigate: (path) => { navigations.push(path) },
}

export function Button({ children, onClick, disabled, loading, variant, size, ...props }) {
  return (
    <button type="button" onClick={onClick} disabled={Boolean(disabled || loading)} aria-busy={loading || undefined} {...props}>
      {children}
    </button>
  )
}

export function Badge({ children }) {
  return <span>{children}</span>
}

export function Codicon({ name }) {
  return <span data-codicon={name} aria-hidden="true" />
}

export function Checkbox(props) {
  return <input type="checkbox" {...props} />
}

export function Separator() {
  return <hr />
}

export function Skeleton() {
  return <div />
}

export function Dialog({ open, children }) {
  return open ? <div role="dialog">{children}</div> : null
}

export function DialogContent({ children }) {
  return <div>{children}</div>
}

export function DialogHeader({ children }) {
  return <div>{children}</div>
}

export function DialogFooter({ children }) {
  return <div>{children}</div>
}

export function DialogTitle({ children }) {
  return <h2>{children}</h2>
}

export function DialogDescription({ children }) {
  return <p>{children}</p>
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel, busyLabel, doneLabel, children }) {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const timer = useRef(null)
  if (!open) return null
  const busy = status !== 'idle'

  async function run() {
    if (busy) return
    setError('')
    setStatus('saving')
    try {
      await onConfirm()
      setStatus('done')
      timer.current = window.setTimeout(() => { timer.current = null; onClose() }, 600)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  const label = status === 'saving' ? busyLabel || 'Working…' : status === 'done' ? doneLabel || 'Done' : confirmLabel || 'Confirm'
  return (
    <div role="alertdialog" aria-label={String(title)}>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {children}
      <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" onClick={run} disabled={busy}>{label}</button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}

export function Input({ value, onChange, ...props }) {
  return <input value={value ?? ''} onChange={(event) => onChange?.(event)} {...props} />
}

export function Textarea({ value, onChange, ...props }) {
  return <textarea value={value ?? ''} onChange={(event) => onChange?.(event)} {...props} />
}

// The SDK's SearchField reports the typed string, not the event.
export function SearchField({ value, onChange, onKeyDown, placeholder, variant, ...props }) {
  return (
    <input
      type="search"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label={props['aria-label']}
    />
  )
}
