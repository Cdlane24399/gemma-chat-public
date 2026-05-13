import { useEffect, useRef, useState } from 'react'
import { transcribeAudioBlob } from '../lib/whisper'

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled: boolean
  placeholder?: string
  model: string
}

type RecState = 'idle' | 'recording' | 'loading-model' | 'transcribing'

const MAX_RECORD_SECONDS = 300

export default function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  model: _model
}: Props) {
  const [text, setText] = useState('')
  const [recState, setRecState] = useState<RecState>('idle')
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [lastBlob, setLastBlob] = useState<Blob | null>(null)
  const [modelProgress, setModelProgress] = useState<{ pct: number; label: string } | null>(null)
  const [level, setLevel] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)

  // Auto-grow textarea
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = 220
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }, [text])

  // Focus on mount when enabled
  useEffect(() => {
    if (!disabled && recState === 'idle') {
      taRef.current?.focus()
    }
  }, [disabled, recState])

  // Listen for suggestion injections from EmptyState
  useEffect(() => {
    function onInsert(e: Event): void {
      const detail = (e as CustomEvent).detail as { text?: string } | undefined
      if (!detail?.text) return
      setText(detail.text)
      setTimeout(() => {
        taRef.current?.focus()
        const el = taRef.current
        if (el) el.setSelectionRange(el.value.length, el.value.length)
      }, 0)
    }
    window.addEventListener('composer:insert', onInsert as EventListener)
    return () => window.removeEventListener('composer:insert', onInsert as EventListener)
  }, [])

  function submit(): void {
    const t = text.trim()
    if (!t || streaming || disabled) return
    onSend(t)
    setText('')
    // Reset textarea height after clearing
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.style.height = 'auto'
        taRef.current.focus()
      }
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter or Cmd/Ctrl+Enter sends; Shift+Enter inserts newline
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (e.shiftKey) return
      e.preventDefault()
      submit()
    }
    // Escape stops streaming or clears the input
    if (e.key === 'Escape') {
      if (streaming) {
        e.preventDefault()
        onStop()
      } else if (text.length > 0) {
        e.preventDefault()
        setText('')
      }
    }
  }

  function teardownAudio(): void {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setLevel(0)
  }

  function setupLevelMeter(stream: MediaStream): void {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const tick = (): void => {
        if (!analyserRef.current) return
        analyserRef.current.getByteTimeDomainData(buf)
        // Peak deviation from 128 (silence)
        let peak = 0
        for (let i = 0; i < buf.length; i++) {
          const d = Math.abs(buf[i] - 128)
          if (d > peak) peak = d
        }
        setLevel(Math.min(1, peak / 96))
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // ignore level meter setup failures
    }
  }

  async function startRecording(): Promise<void> {
    setRecordError(null)
    setLastBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setupLevelMeter(stream)
      const mime = pickMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        teardownAudio()
        if (blob.size < 500) {
          setRecState('idle')
          setRecordSeconds(0)
          setRecordError('Recording too short')
          return
        }
        setLastBlob(blob)
        await transcribe(blob)
      }
      rec.start()
      mediaRef.current = rec
      setRecState('recording')
      setRecordSeconds(0)
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => {
          const next = s + 1
          if (next >= MAX_RECORD_SECONDS) {
            // Auto-stop at limit
            window.setTimeout(stopRecording, 0)
          }
          return next
        })
      }, 1000)
    } catch (e) {
      setRecordError((e as Error).message || 'Microphone access denied')
      setRecState('idle')
      teardownAudio()
    }
  }

  async function transcribe(blob: Blob): Promise<void> {
    setRecState('loading-model')
    try {
      const result = await transcribeAudioBlob(blob, (ev) => {
        if (ev.status === 'progress' && typeof ev.progress === 'number') {
          setModelProgress({ pct: ev.progress, label: ev.file ?? 'whisper model' })
        } else if (ev.status === 'ready' || ev.status === 'done') {
          setModelProgress(null)
          setRecState('transcribing')
        } else if (ev.status === 'initiate' || ev.status === 'download') {
          setModelProgress({ pct: 0, label: ev.file ?? 'whisper model' })
        }
      })
      setRecState('transcribing')
      if (result) {
        setText((prev) => (prev ? prev + ' ' + result : result))
        setLastBlob(null)
        setTimeout(() => taRef.current?.focus(), 0)
      } else {
        setRecordError("Couldn't pick up any speech. Try again a bit louder.")
      }
    } catch (e) {
      setRecordError((e as Error).message)
    } finally {
      setRecState('idle')
      setRecordSeconds(0)
      setModelProgress(null)
    }
  }

  function stopRecording(): void {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    mediaRef.current?.stop()
    mediaRef.current = null
  }

  function onMicClick(): void {
    if (recState === 'idle') {
      void startRecording()
    } else if (recState === 'recording') {
      stopRecording()
    }
  }

  const canSend = text.trim().length > 0 && !disabled && recState === 'idle'

  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="composer-shell group relative">
          {/* Ambient glow */}
          <div aria-hidden className="composer-glow" />
          <div className="composer-surface relative flex flex-col gap-1 rounded-[26px] px-4 pt-3 pb-2">
            <textarea
              ref={taRef}
              data-composer
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                recState === 'recording'
                  ? 'Listening…'
                  : recState === 'transcribing'
                    ? 'Transcribing…'
                    : (placeholder ?? 'Describe what to build')
              }
              rows={1}
              disabled={disabled || recState !== 'idle'}
              aria-label="Message input"
              className="min-h-[28px] w-full resize-none bg-transparent px-0 py-1 text-[15px] leading-relaxed text-white placeholder:text-ink-400/80 focus:outline-none disabled:opacity-50"
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <MicButton
                state={recState}
                seconds={recordSeconds}
                level={level}
                onClick={onMicClick}
                disabled={streaming || disabled}
              />
              {streaming ? (
                <button
                  onClick={onStop}
                  aria-label="Stop generating"
                  title="Stop generating (Esc)"
                  className="composer-action composer-action--stop"
                >
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                    <rect x="2" y="2" width="8" height="8" rx="1.5" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send (Enter)"
                  className={`composer-action composer-action--send ${canSend ? 'is-ready' : ''}`}
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 13.5V3" />
                    <path d="M3.5 7.5L8 3l4.5 4.5" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex min-h-[1.25rem] items-center justify-center gap-2 text-[11px] text-ink-400/90">
          {recordError ? (
            <span className="flex items-center gap-2 text-red-400/90">
              <span>{recordError}</span>
              {lastBlob && (
                <button
                  onClick={() => transcribe(lastBlob)}
                  className="rounded border border-red-400/30 px-1.5 py-0.5 text-[10px] text-red-200 hover:bg-red-500/10"
                >
                  Retry transcription
                </button>
              )}
              <button
                onClick={() => {
                  setRecordError(null)
                  setLastBlob(null)
                }}
                aria-label="Dismiss error"
                className="rounded p-0.5 hover:bg-white/5"
              >
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ) : recState === 'recording' ? (
            <span>
              Click mic again to stop.
              {recordSeconds > 30 && level < 0.05 && (
                <span className="ml-2 text-amber-300/90">No audio detected — speak up?</span>
              )}
            </span>
          ) : recState === 'loading-model' ? (
            modelProgress ? (
              <span className="shimmer-text">
                Downloading Whisper model… {Math.round(modelProgress.pct ?? 0)}%
              </span>
            ) : (
              <span className="shimmer-text">Loading Whisper…</span>
            )
          ) : recState === 'transcribing' ? (
            <span className="shimmer-text">Transcribing locally…</span>
          ) : (
            <span>Enter to send · Shift+Enter for newline · mic for voice</span>
          )}
        </div>
      </div>
    </div>
  )
}

function MicButton({
  state,
  seconds,
  level,
  onClick,
  disabled
}: {
  state: RecState
  seconds: number
  level: number
  onClick: () => void
  disabled: boolean
}) {
  if (state === 'recording') {
    const timerColor =
      seconds > 290 ? 'text-red-200' : seconds > 270 ? 'text-amber-200' : 'text-white'
    return (
      <button
        onClick={onClick}
        className="flex h-9 items-center gap-1.5 rounded-full bg-red-500/90 px-3 text-[11.5px] font-medium text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_4px_14px_-4px_rgba(239,68,68,0.6)] transition-all duration-200 hover:bg-red-500 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_6px_18px_-4px_rgba(239,68,68,0.7)] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40"
        aria-label="Stop recording"
      >
        <span className="flex h-2 w-2 items-center justify-center">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
        </span>
        <LevelBars level={level} />
        <span className={`tabular-nums ${timerColor}`}>{formatTime(seconds)}</span>
      </button>
    )
  }
  if (state === 'transcribing' || state === 'loading-model') {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/5">
        <svg className="h-4 w-4 animate-spin text-ink-200" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 100" />
        </svg>
      </div>
    )
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Voice input"
      aria-label="Record voice"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-300 transition-all duration-200 hover:bg-white/[0.07] hover:text-white active:scale-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
        <path d="M8 2a2 2 0 0 0-2 2v5a2 2 0 0 0 4 0V4a2 2 0 0 0-2-2z" />
        <path
          d="M4 9a4 4 0 0 0 8 0M8 13v1.5"
          stroke="currentColor"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}

function LevelBars({ level }: { level: number }) {
  const bars = 5
  return (
    <span className="flex items-end gap-[1.5px]" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const threshold = (i + 1) / bars
        const active = level >= threshold - 0.1
        const h = 4 + i * 2
        return (
          <span
            key={i}
            className={`w-[2px] rounded-sm transition-all duration-75 ${active ? 'bg-white' : 'bg-white/30'}`}
            style={{ height: h }}
          />
        )
      })}
    </span>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function pickMime(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return undefined
}
