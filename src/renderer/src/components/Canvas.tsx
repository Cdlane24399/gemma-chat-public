import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import type { WorkspaceFile } from '@shared/types'
import { getSetting, setSetting } from '../lib/storage'

interface Props {
  conversationId: string
  streaming: boolean
  initialTab: 'preview' | 'code' | 'files'
  initialSelectedFile: string | null
  onTabChange: (tab: 'preview' | 'code' | 'files') => void
  onSelectedFileChange: (f: string | null) => void
  onClose: () => void
}

type Tab = 'preview' | 'files' | 'code'

interface LiveFile {
  path: string
  content: string
  done: boolean
}

export default function Canvas({
  conversationId,
  streaming,
  initialTab,
  initialSelectedFile,
  onTabChange,
  onSelectedFileChange,
  onClose
}: Props) {
  const [tab, setTabState] = useState<Tab>(initialTab)
  const [previewBase, setPreviewBase] = useState('')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [selectedFile, setSelectedFileState] = useState<string | null>(initialSelectedFile)
  const [nonce, setNonce] = useState(0)
  const [liveFile, setLiveFile] = useState<LiveFile | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [autoSwitch, setAutoSwitch] = useState(false)
  const [codeWrap, setCodeWrap] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const refreshTimer = useRef<number | null>(null)

  function setTab(t: Tab): void {
    setTabState(t)
    onTabChange(t)
  }
  function setSelectedFile(f: string | null): void {
    setSelectedFileState(f)
    onSelectedFileChange(f)
  }

  // Hydrate user prefs once
  useEffect(() => {
    void (async () => {
      const [s, w] = await Promise.all([
        getSetting<boolean>('ui:canvasAutoSwitch'),
        getSetting<boolean>('ui:codeWrap')
      ])
      if (typeof s === 'boolean') setAutoSwitch(s)
      if (typeof w === 'boolean') setCodeWrap(w)
    })()
  }, [])

  useEffect(() => {
    void refreshPreviewInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // Whenever the active conversation changes, reset preview/state
  useEffect(() => {
    refreshFiles()
    setTabState(initialTab)
    setSelectedFileState(initialSelectedFile)
    setLiveFile(null)
    setPreviewError(false)
    setNonce((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  useEffect(() => {
    const unsub = window.api.onWorkspaceChanged((ev) => {
      if (ev.conversationId !== conversationId) return
      refreshFiles()
      void refreshPreviewInfo()
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        setNonce((n) => n + 1)
        setPreviewError(false)
      }, 350)
    })
    return unsub
  }, [conversationId])

  useEffect(() => {
    const unsub = window.api.onFileStreaming((ev) => {
      if (ev.conversationId !== conversationId) return
      setLiveFile({ path: ev.path, content: ev.content, done: ev.done })
      // Auto-switch is opt-in
      if (autoSwitch && !ev.done && tab !== 'code') {
        setTab('code')
      }
    })
    return unsub
  }, [conversationId, autoSwitch, tab])

  async function refreshFiles(): Promise<void> {
    try {
      const list = await window.api.listWorkspace(conversationId)
      setFiles(list)
    } catch {
      setFiles([])
    }
  }

  async function refreshPreviewInfo(): Promise<void> {
    try {
      const info = await window.api.getWorkspace(conversationId)
      setPreviewBase(info.previewUrl)
    } catch {
      setPreviewBase('')
    }
  }

  const previewSrc = useMemo(() => {
    if (!previewBase) return ''
    const base = previewBase.endsWith('/') ? previewBase : `${previewBase}/`
    const path = selectedFile ? encodeURI(selectedFile) : ''
    return `${base}${path}?v=${nonce}`
  }, [previewBase, nonce, selectedFile])

  const fileCount = files.filter((f) => f.kind === 'file').length

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-white/[0.06] bg-ink-950">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.06] px-3">
        <div className="segmented" role="tablist" aria-label="Canvas view">
          <TabButton
            active={tab === 'preview'}
            onClick={() => setTab('preview')}
            label={
              <>
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
                Preview
              </>
            }
          />
          <TabButton
            active={tab === 'code'}
            onClick={() => setTab('code')}
            label={
              <>
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 5L3 8l3 3" />
                  <path d="M10 5l3 3-3 3" />
                </svg>
                Code
                {liveFile && !liveFile.done && (
                  <span
                    className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
                    aria-label="Streaming"
                  />
                )}
              </>
            }
          />
          <TabButton
            active={tab === 'files'}
            onClick={() => setTab('files')}
            label={
              <>
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h2.586a1 1 0 0 1 .707.293L7.5 4.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5V5z" />
                </svg>
                Files{fileCount ? ` · ${fileCount}` : ''}
              </>
            }
          />
        </div>
        <div className="flex-1" />
        {streaming && (
          <span className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-[11px] text-ink-200">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            Building…
          </span>
        )}
        {tab === 'code' && (
          <IconButton
            title={codeWrap ? 'Disable line wrap' : 'Enable line wrap'}
            onClick={() => {
              const next = !codeWrap
              setCodeWrap(next)
              void setSetting('ui:codeWrap', next)
            }}
            pressed={codeWrap}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h12M2 8h9a2 2 0 1 1 0 4H8l1.5-1.5M9.5 13.5L8 12M2 12h3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        )}
        <IconButton
          title={autoSwitch ? 'Auto-switch to Code: on' : 'Auto-switch to Code: off'}
          onClick={() => {
            const next = !autoSwitch
            setAutoSwitch(next)
            void setSetting('ui:canvasAutoSwitch', next)
          }}
          pressed={autoSwitch}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 3l4 5-4 5M9 3l4 5-4 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
        <IconButton title="Refresh preview" onClick={() => { setNonce((n) => n + 1); setPreviewError(false) }}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
        <IconButton
          title="Open workspace folder"
          onClick={() => window.api.openWorkspace(conversationId)}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M2 4a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" />
          </svg>
        </IconButton>
        <IconButton title="Close canvas" onClick={onClose}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4L4 12" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'preview' && (
          <div key="preview" className="anim-fade-in relative h-full w-full">
            {previewSrc ? (
              <>
                <iframe
                  ref={iframeRef}
                  src={previewSrc}
                  className="h-full w-full border-0 bg-white"
                  title="Preview"
                  onError={() => setPreviewError(true)}
                />
                {previewError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/95 text-sm text-ink-200">
                    <div>Preview failed to load.</div>
                    <button
                      onClick={() => {
                        setPreviewError(false)
                        setNonce((n) => n + 1)
                      }}
                      className="rounded-md bg-white px-3 py-1.5 text-[12px] font-medium text-ink-900 hover:bg-white/90"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-ink-400">
                Starting preview server…
              </div>
            )}
            {selectedFile && (
              <div className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[11px] text-ink-100 backdrop-blur">
                {selectedFile}
                <button
                  onClick={() => setSelectedFile(null)}
                  aria-label="Clear selected file"
                  className="ml-2 text-ink-400 hover:text-white"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'code' && (
          <div key="code" className="anim-fade-in h-full">
            <CodeView live={liveFile} wrap={codeWrap} />
          </div>
        )}

        {tab === 'files' && (
          <div key="files" className="anim-fade-in h-full">
            <FileList
              files={files}
              onOpen={(path) => {
                setSelectedFile(path)
                setTab('preview')
                setNonce((n) => n + 1)
                setPreviewError(false)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function detectLang(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    css: 'css',
    scss: 'scss',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php'
  }
  return map[ext] ?? 'plaintext'
}

function CodeView({ live, wrap }: { live: LiveFile | null; wrap: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      userScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 60
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!ref.current || userScrolledRef.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [live?.content])

  const highlighted = useMemo(() => {
    if (!live) return ''
    const lang = detectLang(live.path)
    try {
      if (lang !== 'plaintext' && hljs.getLanguage(lang)) {
        return hljs.highlight(live.content, { language: lang, ignoreIllegals: true }).value
      }
    } catch {
      // fall through
    }
    return escapeHtml(live.content)
  }, [live?.content, live?.path])

  if (!live) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-ink-400">
        Nothing streaming right now. The code tab lights up while Gemma writes a file.
      </div>
    )
  }
  const lines = live.content.split('\n')
  const lineCount = lines.length
  return (
    <div className="flex h-full flex-col bg-[#0a0a0a]">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.05] px-4 py-2 text-[11.5px]">
        <div className="flex items-center gap-2">
          {!live.done ? (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-ink-400" />
          )}
          <span className="font-mono text-ink-100">{live.path}</span>
        </div>
        <div className="tabular-nums text-ink-400">
          {lineCount} line{lineCount === 1 ? '' : 's'} · {live.content.length.toLocaleString()} chars
          {!live.done && <span className="ml-2 shimmer-text">writing</span>}
        </div>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full font-mono text-[12px] leading-[1.55]">
          <div className="sticky left-0 shrink-0 select-none border-r border-white/[0.04] bg-[#0a0a0a] px-3 py-3 text-right text-ink-400/60 tabular-nums">
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre
            className={`flex-1 px-4 py-3 text-ink-100 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
          >
            <code
              className="hljs bg-transparent p-0"
              dangerouslySetInnerHTML={{
                __html: highlighted + (!live.done ? '<span class="anim-caret">▍</span>' : '')
              }}
            />
          </pre>
        </div>
      </div>
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick
}: {
  label: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`segmented-item ${active ? 'is-active' : ''}`}
    >
      {label}
    </button>
  )
}

function IconButton({
  title,
  onClick,
  children,
  pressed
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 ${
        pressed
          ? 'bg-white/10 text-white'
          : 'text-ink-400 hover:bg-white/5 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function FileList({
  files,
  onOpen
}: {
  files: WorkspaceFile[]
  onOpen: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  function toggleDir(path: string): void {
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function isHiddenByCollapse(path: string): boolean {
    for (const dir of collapsed) {
      if (path !== dir && path.startsWith(dir + '/')) return true
    }
    return false
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-ink-400">
        No files yet. Ask Gemma to build something — files appear here as it writes them.
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto p-2 font-mono text-[12.5px]" role="tree">
      {files.map((f) => {
        if (isHiddenByCollapse(f.path)) return null
        const depth = (f.path.match(/\//g) || []).length
        const name = f.path.split('/').pop() || f.path
        if (f.kind === 'dir') {
          const isCollapsed = collapsed.has(f.path)
          return (
            <button
              key={f.path}
              role="treeitem"
              aria-expanded={!isCollapsed}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggleDir(f.path)}
              className="flex w-full items-center py-1 text-left text-ink-300 hover:bg-white/[0.03] hover:text-white"
            >
              <span className={`mr-1 inline-block transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                ▸
              </span>
              {name}/
            </button>
          )
        }
        return (
          <button
            key={f.path}
            role="treeitem"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onOpen(f.path)}
            className="flex w-full items-center justify-between py-1 text-left text-ink-100 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40"
          >
            <span className="truncate">{name}</span>
            {f.size != null && (
              <span className="ml-2 shrink-0 text-[10.5px] text-ink-400">{formatSize(f.size)}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
