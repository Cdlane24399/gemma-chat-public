/**
 * Minimal toast / notification system. No external deps.
 * Use `showToast({ message, action })` from anywhere.
 */
import { useEffect, useState } from 'react'

export interface Toast {
  id: string
  message: string
  tone?: 'default' | 'error' | 'success'
  action?: { label: string; onClick: () => void }
  /** Auto-dismiss after ms; 0 = sticky */
  duration?: number
}

type Listener = (toasts: Toast[]) => void
const listeners = new Set<Listener>()
let toasts: Toast[] = []

function emit(): void {
  for (const l of listeners) l(toasts)
}

export function showToast(t: Omit<Toast, 'id'>): string {
  const id = 't_' + Math.random().toString(36).slice(2, 10)
  const toast: Toast = { duration: 5000, tone: 'default', ...t, id }
  toasts = [toast, ...toasts]
  emit()
  if (toast.duration && toast.duration > 0) {
    window.setTimeout(() => dismissToast(id), toast.duration)
  }
  return id
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts)
  useEffect(() => {
    listeners.add(setList)
    return () => {
      listeners.delete(setList)
    }
  }, [])
  return list
}

export function ToastContainer(): React.ReactElement {
  const list = useToasts()
  return (
    <div
      className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`anim-fade-up pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-2.5 text-[13px] shadow-2xl backdrop-blur ${
            t.tone === 'error'
              ? 'border-red-500/30 bg-red-500/15 text-red-100'
              : t.tone === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-100'
                : 'border-white/10 bg-[#1a1a1a]/95 text-ink-100'
          }`}
        >
          <span className="flex-1">{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick()
                dismissToast(t.id)
              }}
              className="shrink-0 rounded-md bg-white/10 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-white/20"
            >
              {t.action.label}
            </button>
          )}
          <button
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-1 text-ink-400 transition hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4L4 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
