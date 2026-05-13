import { useEffect, useState } from 'react'
import { DEFAULT_MODEL, type SetupStatus } from '@shared/types'
import Setup from './components/Setup'
import Chat from './components/Chat'

type AppState =
  | { phase: 'boot' }
  | { phase: 'setup'; status: SetupStatus; model: string }
  | { phase: 'ready'; model: string }
  | { phase: 'switching'; model: string; toModel: string; status: SetupStatus }

export default function App() {
  const [state, setState] = useState<AppState>({ phase: 'boot' })

  useEffect(() => {
    const rawUnsub = window.api.onRawChunk((ev) => {
      // eslint-disable-next-line no-console
      console.log('[gemma]', ev.chunk)
    })
    let unsub: (() => void) | undefined
    ;(async () => {
      unsub = window.api.onSetupStatus((status) => {
        setState((prev) => {
          if (status.stage === 'ready') {
            if (prev.phase === 'switching') {
              return { phase: 'ready', model: prev.toModel }
            }
            return { phase: 'ready', model: prev.phase === 'setup' ? prev.model : DEFAULT_MODEL }
          }
          if (status.stage === 'error') {
            if (prev.phase === 'switching') {
              return { phase: 'ready', model: prev.model }
            }
          }
          if (prev.phase === 'switching') {
            return { ...prev, status }
          }
          const model = prev.phase === 'setup' ? prev.model : DEFAULT_MODEL
          return { phase: 'setup', status, model }
        })
      })

      const local = await window.api.listLocalModels()
      const hasDefault = local.some(
        (m) => m === DEFAULT_MODEL || m.startsWith(DEFAULT_MODEL + ':')
      )
      if (hasDefault) {
        const { hasMLX } = await window.api.checkMLX()
        if (hasMLX) {
          setState({
            phase: 'setup',
            status: { stage: 'starting-mlx', message: 'Starting model runtime…' },
            model: DEFAULT_MODEL
          })
          window.api.startSetup(DEFAULT_MODEL)
          return
        }
      }
      setState({
        phase: 'setup',
        status: { stage: 'checking', message: 'Welcome' },
        model: DEFAULT_MODEL
      })
    })()
    return () => {
      unsub?.()
      rawUnsub?.()
    }
  }, [])

  function handleSwitchModel(newModel: string): void {
    setState((prev) => {
      if (prev.phase !== 'ready') return prev
      if (prev.model === newModel) return prev
      return {
        phase: 'switching',
        model: prev.model,
        toModel: newModel,
        status: { stage: 'downloading-model', message: 'Switching model…' }
      }
    })
    window.api.switchModel(newModel)
  }

  if (state.phase === 'boot') {
    return <BootSplash />
  }

  if (state.phase === 'setup') {
    return (
      <div key="setup" className="anim-fade-in h-full min-h-0 w-full overflow-hidden">
        <Setup
          status={state.status}
          model={state.model}
          onModelChange={(m) =>
            setState((s) => (s.phase === 'setup' ? { ...s, model: m } : s))
          }
          onStart={(model) => {
            setState({
              phase: 'setup',
              status: { stage: 'checking', message: 'Checking system…' },
              model
            })
            window.api.startSetup(model)
          }}
        />
      </div>
    )
  }

  // Both 'ready' and 'switching' render Chat — the difference is the inline switching banner.
  const effectiveModel = state.phase === 'switching' ? state.model : state.model
  const switching =
    state.phase === 'switching'
      ? { fromModel: state.model, toModel: state.toModel, status: state.status }
      : null

  return (
    <div key="chat" className="anim-fade-scale h-full min-h-0 w-full overflow-hidden">
      <Chat model={effectiveModel} onSwitchModel={handleSwitchModel} switching={switching} />
    </div>
  )
}

function BootSplash() {
  return (
    <div className="drag flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="shimmer h-1 w-40 rounded-full" />
      <p className="text-[12px] text-ink-400">Checking system…</p>
    </div>
  )
}
