import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readSSE, type MLXChatMessage } from './mlx'

const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1'

export interface GatewayChatOptions {
  model: string
  messages: MLXChatMessage[]
  signal?: AbortSignal
  temperature?: number
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function envCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(process.cwd(), '.env.local'),
    join(process.cwd(), '.env'),
    join(app.getAppPath(), '.env.local'),
    join(app.getAppPath(), '.env'),
    join(here, '../../.env.local'),
    join(here, '../../.env')
  ]
}

function gatewayToken(): string | null {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY
  if (process.env.VERCEL_OIDC_TOKEN) return process.env.VERCEL_OIDC_TOKEN

  for (const candidate of envCandidates()) {
    const env = parseEnvFile(candidate)
    if (env.AI_GATEWAY_API_KEY) return env.AI_GATEWAY_API_KEY
    if (env.VERCEL_OIDC_TOKEN) return env.VERCEL_OIDC_TOKEN
  }

  return null
}

function requireGatewayToken(): string {
  const token = gatewayToken()
  if (!token) {
    throw new Error(
      'Vercel AI Gateway credentials not found. Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN before launching the app, or add one to .env.local.'
    )
  }
  return token
}

function gatewayMessages(messages: MLXChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.content
      }
    }
    return {
      role: m.role,
      content: m.content
    }
  })
}

export async function verifyGatewayModel(model: string): Promise<void> {
  const token = requireGatewayToken()
  const res = await fetch(`${GATEWAY_BASE_URL}/models/${encodeURIComponent(model)}`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI Gateway model check failed: ${res.status} ${res.statusText} — ${text}`)
  }
}

export async function* gatewayChatStream(
  opts: GatewayChatOptions
): AsyncGenerator<{ content?: string; done?: boolean }> {
  const token = requireGatewayToken()
  const res = await fetch(`${GATEWAY_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: opts.model,
      messages: gatewayMessages(opts.messages),
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: 8192
    }),
    signal: opts.signal
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI Gateway chat request failed: ${res.status} ${res.statusText} — ${text}`)
  }

  const stream = res.body as unknown as ReadableStream<Uint8Array>
  for await (const event of readSSE(stream)) {
    if (event === '[DONE]') {
      yield { done: true }
      return
    }
    try {
      const parsed = JSON.parse(event) as {
        choices?: Array<{
          delta?: { content?: string; role?: string }
          finish_reason?: string | null
        }>
      }
      const choice = parsed.choices?.[0]
      if (choice?.delta?.content) {
        yield { content: choice.delta.content }
      }
      if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') {
        yield { done: true }
        return
      }
    } catch {
      // Skip malformed events
    }
  }
  yield { done: true }
}
