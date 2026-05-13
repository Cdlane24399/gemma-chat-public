import { useEffect, useMemo, useRef, useState } from 'react'
import { isCloudModel } from '@shared/types'
import { getSetting, setSetting, type Conversation } from '../lib/storage'

interface Props {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string) => void
  model: string
}

const MIN_WIDTH = 200
const MAX_WIDTH = 420
const DEFAULT_WIDTH = 256

function effectiveTitle(c: Conversation): string {
  return (c.customTitle?.trim() || c.title || 'New chat').trim() || 'New chat'
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onTogglePin,
  model
}: Props) {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH)
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Hydrate width once
  useEffect(() => {
    void (async () => {
      const w = await getSetting<number>('ui:sidebarWidth')
      if (typeof w === 'number') {
        setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)))
      }
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => {
      if (effectiveTitle(c).toLowerCase().includes(q)) return true
      return c.messages.some((m) => m.content.toLowerCase().includes(q))
    })
  }, [conversations, query])

  // Keyboard navigation on the list
  function onListKeyDown(e: React.KeyboardEvent): void {
    if (renamingId) return
    const idx = filtered.findIndex((c) => c.id === activeId)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = filtered[Math.min(filtered.length - 1, idx + 1)]
      if (next) onSelect(next.id)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = filtered[Math.max(0, idx - 1)]
      if (next) onSelect(next.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = filtered[idx]
      if (c) startRename(c)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if ((e.metaKey || e.ctrlKey) && filtered[idx]) {
        e.preventDefault()
        onDelete(filtered[idx].id)
      }
    }
  }

  function startRename(c: Conversation): void {
    setRenamingId(c.id)
    setRenameValue(effectiveTitle(c))
  }

  function commitRename(): void {
    if (renamingId) {
      onRename(renamingId, renameValue)
      setRenamingId(null)
    }
  }

  // Resize handle
  function onResizeDown(e: React.PointerEvent): void {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onResizeMove(e: React.PointerEvent): void {
    if (!dragging.current) return
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW.current + (e.clientX - startX.current)))
    setWidth(next)
  }
  function onResizeUp(): void {
    if (!dragging.current) return
    dragging.current = false
    void setSetting('ui:sidebarWidth', width)
  }

  const cloudModel = isCloudModel(model)

  // Split into pinned and rest while preserving array order (already sorted pinned-first by storage)
  const pinned = filtered.filter((c) => c.pinned)
  const rest = filtered.filter((c) => !c.pinned)

  return (
    <div
      className="drag relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-white/[0.06] bg-white/[0.015]"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            const next = Math.max(MIN_WIDTH, width - 16)
            setWidth(next)
            void setSetting('ui:sidebarWidth', next)
          } else if (e.key === 'ArrowRight') {
            const next = Math.min(MAX_WIDTH, width + 16)
            setWidth(next)
            void setSetting('ui:sidebarWidth', next)
          }
        }}
        className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-white/15 focus-visible:bg-white/20 focus-visible:outline-none"
        style={{ touchAction: 'none' }}
        title="Drag to resize"
      />

      {/* Header */}
      <div className="no-drag flex h-11 shrink-0 items-center justify-between px-3 pt-1">
        <span className="pl-[68px] text-[11.5px] font-medium uppercase tracking-wider text-ink-400">
          Chats
        </span>
        <button
          onClick={onNew}
          title="New chat (⌘N)"
          aria-label="New chat"
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-400 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="no-drag px-3 pb-2 pt-1">
        <div className="relative">
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="4" />
            <path d="M13 13l-3-3" strokeLinecap="round" />
          </svg>
          <input
            data-sidebar-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="w-full rounded-md border border-white/[0.05] bg-white/[0.025] py-1 pl-7 pr-2 text-[12.5px] text-ink-100 placeholder:text-ink-500 focus:border-white/15 focus:bg-white/[0.04] focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-500 hover:bg-white/5 hover:text-ink-100"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div
        ref={listRef}
        className="no-drag scrollable min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        role="listbox"
        aria-label="Conversations"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-ink-500">
            {query ? 'No matching chats.' : 'No chats yet.'}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Pinned
              </div>
            )}
            {pinned.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                active={c.id === activeId}
                renaming={renamingId === c.id}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                onSelect={onSelect}
                onDelete={onDelete}
                onTogglePin={onTogglePin}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
              />
            ))}
            {pinned.length > 0 && rest.length > 0 && (
              <div className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Recent
              </div>
            )}
            {rest.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                active={c.id === activeId}
                renaming={renamingId === c.id}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                onSelect={onSelect}
                onDelete={onDelete}
                onTogglePin={onTogglePin}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
              />
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="no-drag shrink-0 border-t border-white/[0.06] px-3 py-2 text-[11px] text-ink-400">
        <div className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${cloudModel ? 'bg-sky-400' : 'bg-emerald-400'}`}
          />
          <span>{cloudModel ? 'Cloud · Vercel AI Gateway' : 'Running locally'}</span>
        </div>
      </div>
    </div>
  )
}

function ConversationRow({
  c,
  active,
  renaming,
  renameValue,
  setRenameValue,
  onSelect,
  onDelete,
  onTogglePin,
  onStartRename,
  onCommitRename,
  onCancelRename
}: {
  c: Conversation
  active: boolean
  renaming: boolean
  renameValue: string
  setRenameValue: (s: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string) => void
  onStartRename: (c: Conversation) => void
  onCommitRename: () => void
  onCancelRename: () => void
}) {
  const title = effectiveTitle(c)
  const subtitle = c.messages.length
    ? `${c.messages.length} msg · ${formatRelative(c.updatedAt ?? c.createdAt)}`
    : formatRelative(c.updatedAt ?? c.createdAt)

  return (
    <div
      role="option"
      aria-selected={active}
      onClick={() => !renaming && onSelect(c.id)}
      onDoubleClick={() => onStartRename(c)}
      title={title}
      className={`group/row relative my-0.5 cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
        active ? 'bg-white/[0.06] text-white' : 'text-ink-200 hover:bg-white/[0.03]'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {c.pinned && (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 shrink-0 text-amber-300" fill="currentColor">
            <path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.2L6 8.5 3 10l.6-3.2L1.2 4.5 4.5 4 6 1z" />
          </svg>
        )}
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancelRename()
              }
              e.stopPropagation()
            }}
            className="w-full rounded border border-white/15 bg-black/30 px-1 py-0.5 text-[12.5px] text-white focus:outline-none"
          />
        ) : (
          <span className="truncate text-[12.5px]">{title}</span>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin(c.id)
            }}
            aria-label={c.pinned ? 'Unpin chat' : 'Pin chat'}
            title={c.pinned ? 'Unpin' : 'Pin'}
            className="rounded p-1 text-ink-400 hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill={c.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
              <path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.2L6 8.5 3 10l.6-3.2L1.2 4.5 4.5 4 6 1z" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(c.id)
            }}
            aria-label="Delete chat"
            title="Delete"
            className="rounded p-1 text-ink-400 hover:bg-red-500/15 hover:text-red-300"
          >
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2.5 3.5h7M5 5.5v3M7 5.5v3M3.5 3.5l.5 6.5h4l.5-6.5M4.5 3.5V2.5h3v1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      {!renaming && <div className="mt-0.5 truncate text-[10.5px] text-ink-500">{subtitle}</div>}
    </div>
  )
}
