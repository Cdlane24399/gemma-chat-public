import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AVAILABLE_MODELS,
  isCloudModel,
  modelInfo,
  type AgentMode,
  type ChatMessage,
  type ToolCall,
  type StreamChunk,
  type SetupStatus
} from '@shared/types'
import gemmaLogoUrl from '../assets/gemma-logo.png'
import Composer from './Composer'
import Message from './Message'
import Sidebar from './Sidebar'
import Canvas from './Canvas'
import {
  loadAllConversations,
  saveConversation,
  deleteConversationById,
  pushSnapshot,
  popSnapshot,
  type Conversation,
  type CanvasState
} from '../lib/storage'
import { showToast } from '../lib/toast'

interface Props {
  model: string
  onSwitchModel: (model: string) => void
  /** When set, a model switch is in flight — show an inline banner instead of blocking. */
  switching?: { fromModel: string; toModel: string; status: SetupStatus } | null
}

function newConversation(mode: AgentMode = 'code'): Conversation {
  const now = Date.now()
  return {
    id: `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: 'New chat',
    messages: [],
    createdAt: now,
    updatedAt: now,
    mode,
    canvasOpen: mode === 'code'
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function effectiveTitle(c: Conversation): string {
  return c.customTitle?.trim() || c.title || 'New chat'
}

export default function Chat({ model, onSwitchModel, switching }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [streaming, setStreaming] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const streamRef = useRef<{ abort: boolean }>({ abort: false })
  const persistTimers = useRef<Map<string, number>>(new Map())
  const conversationsRef = useRef<Conversation[]>([])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  // Initial load from IndexedDB
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const list = await loadAllConversations()
        if (!alive) return
        if (list.length === 0) {
          const seed = newConversation()
          await saveConversation(seed)
          setConversations([seed])
          setActiveId(seed.id)
        } else {
          setConversations(list)
          setActiveId(list[0].id)
        }
      } catch (e) {
        console.error('[chat] load failed', e)
        showToast({
          message: 'Could not load chat history. Starting fresh.',
          tone: 'error',
          duration: 8000
        })
        const seed = newConversation()
        setConversations([seed])
        setActiveId(seed.id)
      } finally {
        setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId),
    [conversations, activeId]
  )

  function schedulePersist(id: string): void {
    const timers = persistTimers.current
    const existing = timers.get(id)
    if (existing) window.clearTimeout(existing)
    const handle = window.setTimeout(() => {
      timers.delete(id)
      const c = conversationsRef.current.find((x) => x.id === id)
      if (c) saveConversation(c).catch((e) => console.warn('[chat] persist failed', e))
    }, 250)
    timers.set(id, handle)
  }

  function updateActive(fn: (c: Conversation) => Conversation): void {
    setConversations((cs) =>
      cs.map((c) => {
        if (c.id !== activeId) return c
        const next = fn(c)
        const stamped: Conversation = { ...next, updatedAt: Date.now() }
        schedulePersist(stamped.id)
        return stamped
      })
    )
  }

  function updateConversation(id: string, fn: (c: Conversation) => Conversation): void {
    setConversations((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c
        const next = fn(c)
        const stamped: Conversation = { ...next, updatedAt: Date.now() }
        schedulePersist(stamped.id)
        return stamped
      })
    )
  }

  function createConversation(mode?: AgentMode): void {
    const m: AgentMode = mode ?? activeConversation?.mode ?? 'code'
    const c = newConversation(m)
    setConversations((cs) => [c, ...cs])
    setActiveId(c.id)
    saveConversation(c).catch(() => {})
  }

  function deleteConversation(id: string): void {
    const victim = conversationsRef.current.find((c) => c.id === id)
    if (!victim) return
    const snapId = newId('snap')
    pushSnapshot({ id: snapId, kind: 'delete', conversation: victim, createdAt: Date.now() })
    deleteConversationById(id).catch(() => {})
    setConversations((cs) => {
      const filtered = cs.filter((c) => c.id !== id)
      if (filtered.length === 0) {
        const nc = newConversation()
        setActiveId(nc.id)
        saveConversation(nc).catch(() => {})
        return [nc]
      }
      if (id === activeId) setActiveId(filtered[0].id)
      return filtered
    })
    showToast({
      message: `Deleted "${effectiveTitle(victim)}"`,
      action: {
        label: 'Undo',
        onClick: () => {
          const snap = popSnapshot(snapId)
          if (!snap) return
          saveConversation(snap.conversation).catch(() => {})
          setConversations((cs) => [snap.conversation, ...cs])
          setActiveId(snap.conversation.id)
        }
      },
      duration: 6000
    })
  }

  function renameConversation(id: string, title: string): void {
    updateConversation(id, (c) => ({ ...c, customTitle: title.trim() || undefined }))
  }

  function pinConversation(id: string): void {
    const c = conversationsRef.current.find((x) => x.id === id)
    updateConversation(id, (cv) => ({ ...cv, pinned: !c?.pinned }))
  }

  function toggleMode(): void {
    updateActive((c) => {
      const nextMode: AgentMode = c.mode === 'code' ? 'chat' : 'code'
      return { ...c, mode: nextMode, canvasOpen: nextMode === 'code' }
    })
  }

  function toggleCanvas(): void {
    updateActive((c) => ({ ...c, canvasOpen: !c.canvasOpen }))
  }

  function updateCanvasState(patch: Partial<CanvasState>): void {
    updateActive((c) => ({ ...c, canvasState: { ...(c.canvasState ?? {}), ...patch } }))
  }

  async function handleSend(input: string): Promise<void> {
    if (!input.trim() || streaming) return
    const conv = conversationsRef.current.find((c) => c.id === activeId)
    if (!conv) return

    const userMsg: ChatMessage = {
      id: newId('m'),
      role: 'user',
      content: input,
      createdAt: Date.now()
    }
    const assistantMsg: ChatMessage = {
      id: newId('m'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      model,
      toolCalls: [],
      activity: { kind: 'thinking' }
    }

    updateActive((c) => {
      const autoTitle =
        !c.customTitle && c.messages.length === 0
          ? input.slice(0, 48) + (input.length > 48 ? '…' : '')
          : c.title
      return { ...c, title: autoTitle, messages: [...c.messages, userMsg, assistantMsg] }
    })

    const history = [...conv.messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls
    }))

    setStreaming(true)
    streamRef.current.abort = false

    try {
      await window.api.sendChat(
        {
          conversationId: activeId,
          messages: history,
          model,
          enableTools: true,
          mode: conv.mode
        },
        (chunk: StreamChunk) => {
          if (streamRef.current.abort) return
          setConversations((cs) =>
            cs.map((c) => {
              if (c.id !== activeId) return c
              const msgs = [...c.messages]
              const last = msgs[msgs.length - 1]
              if (!last || last.role !== 'assistant') return c
              if (chunk.type === 'token') {
                msgs[msgs.length - 1] = { ...last, content: last.content + chunk.text }
              } else if (chunk.type === 'tool_call') {
                const tc: ToolCall = { ...chunk.call, running: true }
                msgs[msgs.length - 1] = { ...last, toolCalls: [...(last.toolCalls ?? []), tc] }
              } else if (chunk.type === 'tool_result') {
                const tcs = (last.toolCalls ?? []).map((t) =>
                  t.id === chunk.id
                    ? { ...t, running: false, result: chunk.result, error: chunk.error }
                    : t
                )
                msgs[msgs.length - 1] = { ...last, toolCalls: tcs }
              } else if (chunk.type === 'activity') {
                msgs[msgs.length - 1] = { ...last, activity: chunk.activity }
              } else if (chunk.type === 'done') {
                msgs[msgs.length - 1] = { ...last, done: true, activity: { kind: 'idle' } }
              } else if (chunk.type === 'error') {
                msgs[msgs.length - 1] = {
                  ...last,
                  done: true,
                  activity: { kind: 'idle' },
                  content: last.content + (last.content ? '\n\n' : '') + `⚠️ ${chunk.error}`
                }
              }
              const stamped: Conversation = { ...c, messages: msgs, updatedAt: Date.now() }
              schedulePersist(stamped.id)
              return stamped
            })
          )
        }
      )
    } finally {
      setStreaming(false)
    }
  }

  async function handleStop(): Promise<void> {
    streamRef.current.abort = true
    await window.api.abortChat(activeId)
    setStreaming(false)
  }

  async function handleRegenerate(): Promise<void> {
    if (streaming) return
    const conv = conversationsRef.current.find((c) => c.id === activeId)
    if (!conv) return
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    pushSnapshot({
      id: newId('snap'),
      kind: 'regenerate',
      conversation: conv,
      createdAt: Date.now()
    })
    updateActive((c) => {
      const msgs = [...c.messages]
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') {
        msgs.pop()
      }
      return { ...c, messages: msgs.slice(0, -1) }
    })
    setTimeout(() => handleSend(lastUser.content), 0)
  }

  function handleEditMessage(messageId: string, newContent: string): void {
    if (streaming) return
    updateActive((c) => {
      const idx = c.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return c
      return { ...c, messages: c.messages.slice(0, idx) }
    })
    setTimeout(() => handleSend(newContent), 0)
  }

  function handleDeleteMessage(messageId: string): void {
    updateActive((c) => ({ ...c, messages: c.messages.filter((m) => m.id !== messageId) }))
  }

  // Keyboard shortcuts: Cmd+N new chat, Cmd+K focus sidebar search
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createConversation()
      } else if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('[data-sidebar-search]')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.mode])

  if (!loaded || !activeConversation) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="shimmer h-1 w-40 rounded-full" />
      </div>
    )
  }

  const canvasVisible =
    (activeConversation.mode === 'code' || activeConversation.canvasOpen === true) &&
    activeConversation.canvasOpen !== false
  const currentModel = modelInfo(model)

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => createConversation()}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onTogglePin={pinConversation}
        model={model}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {switching && (
          <SwitchingBanner status={switching.status} toModel={switching.toModel} />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Header
              model={model}
              mode={activeConversation.mode}
              canvasOpen={!!activeConversation.canvasOpen}
              onToggleMode={toggleMode}
              onToggleCanvas={toggleCanvas}
              onSwitchModel={onSwitchModel}
              disabled={!!switching}
            />
            <MessageList
              messages={activeConversation.messages}
              streaming={streaming}
              mode={activeConversation.mode}
              model={model}
              onRegenerate={handleRegenerate}
              onEditMessage={handleEditMessage}
              onDeleteMessage={handleDeleteMessage}
            />
            <Composer
              onSend={handleSend}
              onStop={handleStop}
              streaming={streaming}
              disabled={!!switching}
              model={model}
              placeholder={
                switching
                  ? `Switching to ${modelInfo(switching.toModel)?.label ?? 'new model'}…`
                  : activeConversation.mode === 'code'
                    ? 'Describe what to build'
                    : `Message ${currentModel?.label ?? 'the model'}…`
              }
            />
          </div>
          {canvasVisible && (
            <ResizableCanvas
              conversationId={activeId}
              streaming={streaming}
              initialWidth={activeConversation.canvasState?.width ?? 520}
              onWidthChange={(w) => updateCanvasState({ width: w })}
              initialTab={activeConversation.canvasState?.tab ?? 'preview'}
              initialSelectedFile={activeConversation.canvasState?.selectedFile ?? null}
              onTabChange={(tab) => updateCanvasState({ tab })}
              onSelectedFileChange={(f) => updateCanvasState({ selectedFile: f })}
              onClose={() => updateActive((c) => ({ ...c, canvasOpen: false }))}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SwitchingBanner({ status, toModel }: { status: SetupStatus; toModel: string }) {
  const target = modelInfo(toModel)?.label ?? toModel
  const pct = status.progress != null ? Math.round(status.progress * 100) : null
  return (
    <div
      role="status"
      aria-live="polite"
      className="anim-fade-in flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.03] px-4 py-2 text-[12.5px] text-ink-100"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-sky-400/60" />
        <span className="h-2 w-2 rounded-full bg-sky-400" />
      </span>
      <span className="font-medium">Switching to {target}</span>
      <span className="text-ink-400">{status.message}</span>
      <div className="flex-1" />
      {pct != null && (
        <>
          <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white/70 transition-[width] duration-200"
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          <span className="tabular-nums text-ink-400">{pct}%</span>
        </>
      )}
    </div>
  )
}

function ResizableCanvas({
  conversationId,
  streaming,
  initialWidth,
  onWidthChange,
  initialTab,
  initialSelectedFile,
  onTabChange,
  onSelectedFileChange,
  onClose
}: {
  conversationId: string
  streaming: boolean
  initialWidth: number
  onWidthChange: (w: number) => void
  initialTab: 'preview' | 'code' | 'files'
  initialSelectedFile: string | null
  onTabChange: (tab: 'preview' | 'code' | 'files') => void
  onSelectedFileChange: (f: string | null) => void
  onClose: () => void
}) {
  const [width, setWidth] = useState(initialWidth)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    setWidth(initialWidth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startW.current = width
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [width]
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const delta = startX.current - e.clientX
    const maxByViewport = Math.max(360, window.innerWidth - 480)
    const next = Math.max(320, Math.min(startW.current + delta, maxByViewport))
    setWidth(next)
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    onWidthChange(width)
  }, [onWidthChange, width])

  const handleDoubleClick = useCallback(() => {
    setWidth(520)
    onWidthChange(520)
  }, [onWidthChange])

  return (
    <div className="anim-slide-right relative h-full min-h-0 shrink-0 overflow-hidden" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize canvas"
        tabIndex={0}
        className="group/handle absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize select-none transition-colors hover:bg-white/15 active:bg-white/25 focus-visible:bg-white/20 focus-visible:outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            const next = Math.min(window.innerWidth - 480, width + 24)
            setWidth(next)
            onWidthChange(next)
          } else if (e.key === 'ArrowRight') {
            const next = Math.max(320, width - 24)
            setWidth(next)
            onWidthChange(next)
          }
        }}
        style={{ touchAction: 'none' }}
        title="Drag to resize · double-click to reset"
      />
      <Canvas
        conversationId={conversationId}
        streaming={streaming}
        initialTab={initialTab}
        initialSelectedFile={initialSelectedFile}
        onTabChange={onTabChange}
        onSelectedFileChange={onSelectedFileChange}
        onClose={onClose}
      />
    </div>
  )
}

function Header({
  model,
  mode,
  canvasOpen,
  onToggleMode,
  onToggleCanvas,
  onSwitchModel,
  disabled
}: {
  model: string
  mode: AgentMode
  canvasOpen: boolean
  onToggleMode: () => void
  onToggleCanvas: () => void
  onSwitchModel: (model: string) => void
  disabled: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(0)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function handleClick(e: MouseEvent): void {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setPickerOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => (i + 1) % AVAILABLE_MODELS.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => (i - 1 + AVAILABLE_MODELS.length) % AVAILABLE_MODELS.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const m = AVAILABLE_MODELS[focusIdx]
        if (m && m.name !== model) onSwitchModel(m.name)
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [pickerOpen, focusIdx, model, onSwitchModel])

  useEffect(() => {
    if (pickerOpen) {
      const idx = AVAILABLE_MODELS.findIndex((m) => m.name === model)
      setFocusIdx(idx >= 0 ? idx : 0)
    }
  }, [pickerOpen, model])

  const currentLabel = modelInfo(model)?.label ?? model
  const cloudModel = isCloudModel(model)

  return (
    <div className="drag flex h-11 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
      <div className="min-w-[8rem]" />
      <div
        className="no-drag segmented"
        role="tablist"
        aria-label="Mode"
      >
        <ModePill active={mode === 'chat'} onClick={() => mode === 'code' && onToggleMode()}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6.5C3 4.567 4.567 3 6.5 3h3C11.433 3 13 4.567 13 6.5v1C13 9.433 11.433 11 9.5 11H7l-2.5 2v-2.2A3.5 3.5 0 0 1 3 7.5v-1z" />
          </svg>
          Chat
        </ModePill>
        <ModePill active={mode === 'code'} onClick={() => mode === 'chat' && onToggleMode()}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 5L3 8l3 3" />
            <path d="M10 5l3 3-3 3" />
          </svg>
          Build
        </ModePill>
      </div>
      <div className="no-drag flex shrink-0 items-center justify-end gap-2">
        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            aria-label={`Model: ${currentLabel}. Click to switch.`}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11.5px] text-ink-400 transition-all duration-200 hover:bg-white/[0.05] hover:text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 disabled:opacity-50"
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${cloudModel ? 'bg-sky-400' : 'bg-emerald-400'}`}
            />
            {currentLabel}
            <svg
              viewBox="0 0 16 16"
              className={`h-3 w-3 transition-transform duration-200 ${pickerOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {pickerOpen && (
            <div
              role="listbox"
              aria-label="Switch model"
              className="anim-fade-scale absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-white/10 bg-[#1a1a1a] p-1.5 shadow-2xl backdrop-blur-xl"
            >
              <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-ink-400">
                Switch model
              </div>
              {AVAILABLE_MODELS.map((m, i) => {
                const selected = m.name === model
                const focused = i === focusIdx
                return (
                  <button
                    key={m.name}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setFocusIdx(i)}
                    onClick={() => {
                      setPickerOpen(false)
                      if (m.name !== model) onSwitchModel(m.name)
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-all duration-150 ${
                      selected
                        ? 'bg-white/[0.07] text-white'
                        : focused
                          ? 'bg-white/[0.04] text-ink-100'
                          : 'text-ink-200 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        {m.label}
                        {m.recommended && (
                          <span className="rounded-full bg-white/10 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-ink-200">
                            rec
                          </span>
                        )}
                        {m.provider === 'vercel-ai-gateway' && (
                          <span className="rounded-full bg-sky-400/15 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-sky-200">
                            cloud
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-400">{m.size}</div>
                    </div>
                    {selected && (
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5 text-emerald-400"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {mode === 'code' && (
          <button
            onClick={onToggleCanvas}
            title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
            aria-label={canvasOpen ? 'Hide canvas' : 'Show canvas'}
            aria-pressed={canvasOpen}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 ${
              canvasOpen ? 'bg-white/10 text-white' : 'text-ink-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M9 3v10" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

function ModePill({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`segmented-item ${active ? 'is-active' : ''}`}
    >
      {children}
    </button>
  )
}

function MessageList({
  messages,
  streaming,
  mode,
  model,
  onRegenerate,
  onEditMessage,
  onDeleteMessage
}: {
  messages: ChatMessage[]
  streaming: boolean
  mode: AgentMode
  model: string
  onRegenerate: () => void
  onEditMessage: (id: string, newText: string) => void
  onDeleteMessage: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      atBottomRef.current = isAtBottom
      setAtBottom(isAtBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (atBottomRef.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [messages])

  function scrollToBottom(): void {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const empty = messages.length === 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-live={streaming ? 'polite' : 'off'}
        aria-label="Chat messages"
      >
        {empty ? (
          <EmptyState mode={mode} model={model} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
            {messages.map((m, i) => (
              <div
                key={m.id}
                className="anim-float-in"
                style={{ animationDelay: `${Math.min(i * 30, 150)}ms` }}
              >
                <Message
                  message={m}
                  isLast={i === messages.length - 1}
                  streaming={streaming && i === messages.length - 1}
                  onRegenerate={
                    !streaming && m.role === 'assistant' && i === messages.length - 1
                      ? onRegenerate
                      : undefined
                  }
                  onEdit={
                    !streaming && m.role === 'user' ? (text) => onEditMessage(m.id, text) : undefined
                  }
                  onDelete={!streaming ? () => onDeleteMessage(m.id) : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {!empty && !atBottom && (
        <button
          onClick={scrollToBottom}
          className="anim-fade-in absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-[#1a1a1a]/95 px-3 py-1.5 text-[12px] text-ink-100 shadow-xl backdrop-blur transition hover:bg-[#1a1a1a]"
          aria-label="Jump to latest message"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}

function EmptyState({ mode, model }: { mode: AgentMode; model: string }) {
  const cloudModel = isCloudModel(model)
  const currentModel = modelInfo(model)
  const chatSuggestions = [
    { title: 'Search the web', prompt: 'What are the top AI news stories this week?' },
    { title: 'Explain a concept', prompt: 'Explain the transformer architecture in plain English.' },
    { title: 'Plan a trip', prompt: 'Help me plan a weekend trip to Tokyo for 4 days.' },
    { title: 'Debug code', prompt: 'Why is this JS promise not resolving? (paste code)' }
  ]
  const codeSuggestions = [
    {
      title: 'Landing page',
      prompt: 'Build a one-page landing site for a fake AI dog-walking app. Modern design, dark mode.'
    },
    {
      title: 'Pomodoro timer',
      prompt: 'Build a pomodoro timer web app with start/pause/reset buttons and a minimal UI.'
    },
    {
      title: 'Retro snake game',
      prompt: 'Make a playable snake game in a single index.html with keyboard controls.'
    },
    {
      title: 'Markdown preview',
      prompt: 'Build a live markdown editor — textarea on the left, rendered output on the right.'
    }
  ]
  const suggestions = mode === 'code' ? codeSuggestions : chatSuggestions

  function dispatchSuggestion(prompt: string): void {
    window.dispatchEvent(new CustomEvent('composer:insert', { detail: { text: prompt } }))
  }

  return (
    <div className="anim-fade-in flex h-full flex-col items-center justify-center px-8">
      <div className="anim-fade-up mb-12 text-center">
        <img src={gemmaLogoUrl} alt="Gemma" className="mx-auto mb-6 h-20 w-20" draggable={false} />
        <div className="mb-3 text-[32px] font-semibold tracking-tight text-white">
          {mode === 'code' ? 'What should we build?' : 'How can I help?'}
        </div>
        <div className="text-sm text-ink-400">
          {mode === 'code'
            ? `${currentModel?.label ?? 'The model'} will write files into a workspace and show a live preview on the right.`
            : cloudModel
              ? 'Using Vercel AI Gateway for this conversation.'
              : 'Running locally. Your messages never leave your Mac.'}
        </div>
      </div>
      <div className="anim-stagger grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s.title}
            onClick={() => dispatchSuggestion(s.prompt)}
            className="anim-fade-up rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 active:scale-[0.98]"
          >
            <div className="text-sm font-medium text-white">{s.title}</div>
            <div className="mt-0.5 text-[12.5px] text-ink-400">{s.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
