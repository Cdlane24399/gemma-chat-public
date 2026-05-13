import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createReadStream } from 'fs'
import { mkdir, readFile, writeFile, readdir, stat, access, rm, rename } from 'fs/promises'
import { join, resolve, dirname, extname, relative, sep } from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

let server: Server | null = null
let serverPort = 0

interface ManagedDevServer {
  conversationId: string
  command: string
  proc: ChildProcessWithoutNullStreams
  startedAt: number
  url?: string
  lastOutput: string
  exitCode?: number | null
}

export interface DevServerStatus {
  running: boolean
  url?: string
  command?: string
  pid?: number
  startedAt?: number
  exitCode?: number | null
  lastOutput?: string
}

const devServers = new Map<string, ManagedDevServer>()

export function workspacesRoot(): string {
  return join(app.getPath('userData'), 'workspaces')
}

export function workspaceDir(conversationId: string): string {
  return join(workspacesRoot(), sanitizeId(conversationId))
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default'
}

function devServerKey(conversationId: string): string {
  return sanitizeId(conversationId)
}

export async function ensureWorkspace(conversationId: string): Promise<string> {
  const dir = workspaceDir(conversationId)
  await mkdir(dir, { recursive: true })
  return dir
}

export function assertInWorkspace(base: string, target: string): string {
  const resolved = resolve(base, target)
  const rel = relative(base, resolved)
  if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('..' + sep)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return resolved
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export async function startWorkspaceServer(): Promise<number> {
  if (server) return serverPort
  await mkdir(workspacesRoot(), { recursive: true })

  server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.setHeader('Pragma', 'no-cache')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', `http://localhost`)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length === 0) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('gemma-chat workspace server')
        return
      }
      const id = parts[0]
      const root = workspaceDir(id)
      const rel = parts.slice(1).join('/') || ''

      if (await proxyDevServer(id, rel, url.search, req, res)) {
        return
      }

      let target: string
      try {
        target = assertInWorkspace(root, rel)
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Bad path')
        return
      }

      let s
      try {
        s = await stat(target)
      } catch {
        // Maybe it's a root with no index yet — render placeholder
        if (rel === '' || rel === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderPlaceholder(id))
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }

      if (s.isDirectory()) {
        const indexPath = join(target, 'index.html')
        try {
          await access(indexPath)
          const body = await readFile(indexPath)
          res.writeHead(200, { 'content-type': MIME['.html'] })
          res.end(body)
          return
        } catch {
          // directory listing
          const entries = await readdir(target, { withFileTypes: true })
          const files = entries.map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? 'dir' : 'file'
          }))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(renderDirList(id, rel, files))
          return
        }
      }

      const ext = extname(target).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': mime,
        'content-length': s.size
      })
      createReadStream(target).pipe(res)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end((e as Error).message)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (addr && typeof addr !== 'string') {
    serverPort = addr.port
  }
  return serverPort
}

export function stopWorkspaceServer(): void {
  if (server) {
    server.close()
    server = null
    serverPort = 0
  }
}

export function getWorkspaceServerPort(): number {
  return serverPort
}

export function previewUrl(conversationId: string): string {
  const dev = workspaceDevServerStatus(conversationId)
  if (dev.running && dev.url) return dev.url
  return `http://127.0.0.1:${serverPort}/${sanitizeId(conversationId)}/`
}

async function proxyDevServer(
  conversationId: string,
  rel: string,
  search: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const dev = devServers.get(devServerKey(conversationId))
  if (!dev?.url || dev.exitCode !== undefined) return false

  try {
    const path = `/${rel}${search}`
    const target = new URL(path, dev.url)
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        accept: req.headers.accept ?? '*/*',
        'user-agent': req.headers['user-agent'] ?? 'gemma-chat-preview'
      }
    })

    const headers: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') return
      if (key.toLowerCase() === 'transfer-encoding') return
      headers[key] = value
    })
    res.writeHead(upstream.status, headers)
    const body = Buffer.from(await upstream.arrayBuffer())
    res.end(body)
    return true
  } catch {
    return false
  }
}

function renderPlaceholder(_id: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title>
<style>
  html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0e0e0e;color:#888;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
  .box{max-width:360px;padding:28px;text-align:center}
  .ico{width:44px;height:44px;margin:0 auto 14px;opacity:.35}
  .title{color:#e8e8e8;font-weight:500;margin-bottom:6px}
</style></head><body>
<div class="box">
  <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>
  <div class="title">No preview yet</div>
  <div>Ask Gemma to create <code style="color:#bbb">index.html</code> to see it here.</div>
</div>
</body></html>`
}

function renderDirList(
  id: string,
  rel: string,
  files: Array<{ name: string; kind: string }>
): string {
  const rows = files
    .map(
      (f) =>
        `<li><a href="/${id}/${rel}${rel ? '/' : ''}${f.name}">${escapeHtml(f.name)}</a> <span class="k">${f.kind}</span></li>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(rel || id)}</title>
<style>
  body{margin:0;padding:24px 28px;background:#0e0e0e;color:#e8e8e8;font:13.5px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}
  h1{font-size:13px;color:#888;font-weight:500;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em}
  ul{list-style:none;padding:0;margin:0}
  li{padding:6px 0;border-bottom:1px solid #1a1a1a}
  a{color:#e8e8e8;text-decoration:none}
  a:hover{color:#7aa2f7}
  .k{color:#555;font-size:11px;margin-left:8px}
</style></head><body>
<h1>/${escapeHtml(rel || '')}</h1>
<ul>${rows}</ul>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface FileEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

export async function listTree(base: string, max = 200): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= max) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name === 'node_modules') continue
      const p = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push({ path: p, kind: 'dir' })
        await walk(join(dir, e.name), p)
      } else {
        try {
          const s = await stat(join(dir, e.name))
          out.push({ path: p, kind: 'file', size: s.size })
        } catch {
          out.push({ path: p, kind: 'file' })
        }
      }
      if (out.length >= max) return
    }
  }
  await walk(base, '')
  return out
}

export async function wsWriteFile(
  conversationId: string,
  path: string,
  content: string
): Promise<string> {
  const base = await ensureWorkspace(conversationId)
  const target = assertInWorkspace(base, path)
  await mkdir(dirname(target), { recursive: true })
  const tmp = target + '.tmp-' + Date.now()
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, target)
  return target
}

export async function wsReadFile(conversationId: string, path: string): Promise<string> {
  const base = await ensureWorkspace(conversationId)
  const target = assertInWorkspace(base, path)
  return readFile(target, 'utf-8')
}

export async function wsEditFile(
  conversationId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false
): Promise<{ occurrences: number }> {
  const content = await wsReadFile(conversationId, path)
  if (replaceAll) {
    const parts = content.split(oldString)
    if (parts.length === 1) throw new Error(`old_string not found in ${path}`)
    const next = parts.join(newString)
    await wsWriteFile(conversationId, path, next)
    return { occurrences: parts.length - 1 }
  }
  const idx = content.indexOf(oldString)
  if (idx < 0) throw new Error(`old_string not found in ${path}`)
  const second = content.indexOf(oldString, idx + oldString.length)
  if (second >= 0) {
    throw new Error(`old_string appears multiple times in ${path}. Use replace_all or add context.`)
  }
  const next = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  await wsWriteFile(conversationId, path, next)
  return { occurrences: 1 }
}

export async function wsDeleteFile(conversationId: string, path: string): Promise<void> {
  const base = await ensureWorkspace(conversationId)
  const target = assertInWorkspace(base, path)
  await rm(target, { recursive: true, force: true })
}

export async function createViteReactProject(
  conversationId: string,
  name = 'gemma-site',
  reset = false
): Promise<string[]> {
  const base = await ensureWorkspace(conversationId)
  const packagePath = join(base, 'package.json')
  if (!reset) {
    try {
      await access(packagePath)
      throw new Error(
        'package.json already exists. Read the current project first, or pass reset=true to replace the starter project files.'
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  if (reset) {
    await Promise.all([
      rm(join(base, 'src'), { recursive: true, force: true }),
      rm(join(base, 'index.html'), { force: true }),
      rm(join(base, 'vite.config.ts'), { force: true }),
      rm(join(base, 'tsconfig.json'), { force: true }),
      rm(packagePath, { force: true })
    ])
  }

  const projectName = packageName(name)
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: projectName,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
          dev: 'vite --host 127.0.0.1',
          build: 'tsc --noEmit && vite build',
          preview: 'vite preview --host 127.0.0.1'
        },
        dependencies: {
          '@vitejs/plugin-react': '^4.3.4',
          'lucide-react': '^0.468.0',
          react: '^19.0.0',
          'react-dom': '^19.0.0'
        },
        devDependencies: {
          '@types/react': '^19.0.7',
          '@types/react-dom': '^19.0.3',
          typescript: '^5.7.3',
          vite: '^6.0.11'
        }
      },
      null,
      2
    ) + '\n',
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(projectName)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1'
  },
  preview: {
    host: '127.0.0.1'
  }
})
`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
`,
    'src/main.tsx':
      "import React from 'react'\n" +
      "import { createRoot } from 'react-dom/client'\n" +
      "import App from './App'\n" +
      "import './styles.css'\n" +
      '\n' +
      "createRoot(document.getElementById('root')!).render(\n" +
      '  <React.StrictMode>\n' +
      '    <App />\n' +
      '  </React.StrictMode>\n' +
      ')\n',
    'src/App.tsx':
      "import { Sparkles } from 'lucide-react'\n" +
      '\n' +
      'export default function App() {\n' +
      '  return (\n' +
      '    <main className="shell">\n' +
      '      <section className="hero" aria-label="Generated site starter">\n' +
      '        <p className="eyebrow">Vite React workspace</p>\n' +
      '        <h1>Ready for the next website.</h1>\n' +
      '        <p className="lede">\n' +
      "          Ask Gemma to shape this starter into a polished site. It can edit components,\n" +
      '          add files, install packages, and run the local preview server.\n' +
      '        </p>\n' +
      '        <div className="status"><Sparkles size={16} /> Live project mode enabled</div>\n' +
      '      </section>\n' +
      '    </main>\n' +
      '  )\n' +
      '}\n',
    'src/styles.css': `:root {
  color: #f5f2ec;
  background: #15130f;
  font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

.shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background:
    linear-gradient(145deg, rgba(245, 242, 236, 0.08), transparent 40%),
    radial-gradient(circle at 70% 20%, rgba(125, 180, 149, 0.18), transparent 28%),
    #15130f;
}

.hero {
  width: min(720px, 100%);
}

.eyebrow {
  margin: 0 0 14px;
  color: #a8cbb7;
  font: 700 12px/1.2 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  max-width: 11ch;
  font-size: clamp(54px, 10vw, 104px);
  line-height: 0.9;
  letter-spacing: 0;
}

.lede {
  max-width: 620px;
  margin: 24px 0 0;
  color: rgba(245, 242, 236, 0.72);
  font: 18px/1.65 ui-sans-serif, system-ui, sans-serif;
}

.status {
  width: fit-content;
  margin-top: 26px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: #15130f;
  background: #a8cbb7;
  border-radius: 999px;
  padding: 10px 14px;
  font: 700 13px/1 ui-sans-serif, system-ui, sans-serif;
}
`
  }

  const written: string[] = []
  for (const [path, content] of Object.entries(files)) {
    await wsWriteFile(conversationId, path, content)
    written.push(path)
  }
  return written
}

function packageName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 214) || 'gemma-site'
  )
}

type PackageManager = 'npm' | 'pnpm' | 'yarn'

async function detectPackageManager(base: string): Promise<PackageManager> {
  try {
    const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf-8')) as {
      packageManager?: string
    }
    if (pkg.packageManager?.startsWith('pnpm@')) return 'pnpm'
    if (pkg.packageManager?.startsWith('yarn@')) return 'yarn'
  } catch {
    // Fall through to lockfile detection.
  }

  try {
    await access(join(base, 'pnpm-lock.yaml'))
    return 'pnpm'
  } catch {
    // no-op
  }
  try {
    await access(join(base, 'yarn.lock'))
    return 'yarn'
  } catch {
    // no-op
  }
  return 'npm'
}

function assertPackageSpec(spec: string): string {
  const trimmed = spec.trim()
  if (!trimmed) throw new Error('Package names cannot be empty.')
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9._~^>=<*-]+)?$/i.test(trimmed)) {
    throw new Error(`Unsafe package spec: ${spec}`)
  }
  return trimmed
}

export async function wsInstallPackages(
  conversationId: string,
  packages: string[] = [],
  dev = false,
  timeoutMs = 180_000
): Promise<BashResult> {
  const base = await ensureWorkspace(conversationId)
  await access(join(base, 'package.json'))
  const manager = await detectPackageManager(base)
  const safePackages = packages.map(assertPackageSpec)

  const args = (() => {
    if (manager === 'npm') {
      if (safePackages.length === 0) return ['install']
      return ['install', dev ? '--save-dev' : '--save', ...safePackages]
    }
    if (manager === 'pnpm') {
      if (safePackages.length === 0) return ['install']
      return ['add', dev ? '-D' : '', ...safePackages].filter(Boolean)
    }
    if (safePackages.length === 0) return ['install']
    return ['add', dev ? '--dev' : '', ...safePackages].filter(Boolean)
  })()

  return runWorkspaceCommand(base, manager, args, timeoutMs, 24_000)
}

async function runWorkspaceCommand(
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number
): Promise<BashResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      truncated = true
    }, timeoutMs)

    const append = (current: string, chunk: Buffer, label: string): string => {
      if (current.length >= maxBytes) return current
      let next = current + chunk.toString('utf-8')
      if (next.length >= maxBytes) {
        next = next.slice(0, maxBytes) + `\n[…${label} truncated]`
        truncated = true
      }
      return next
    }

    proc.stdout.on('data', (d: Buffer) => {
      stdout = append(stdout, d, 'output')
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr = append(stderr, d, 'stderr')
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ exitCode: code, stdout, stderr, truncated, durationMs: Date.now() - start })
    })
    proc.on('error', (e) => {
      clearTimeout(killTimer)
      resolve({
        exitCode: -1,
        stdout,
        stderr: (stderr + '\n' + String(e)).trim(),
        truncated,
        durationMs: Date.now() - start
      })
    })
  })
}

export async function startWorkspaceDevServer(
  conversationId: string,
  script = 'dev'
): Promise<DevServerStatus> {
  if (!/^[a-zA-Z0-9:_-]+$/.test(script)) {
    throw new Error(`Unsafe npm script name: ${script}`)
  }
  await stopWorkspaceDevServer(conversationId)

  const base = await ensureWorkspace(conversationId)
  await access(join(base, 'package.json'))
  const manager = await detectPackageManager(base)
  const args = ['run', script, '--', '--host', '127.0.0.1']
  const command = `${manager} ${args.join(' ')}`
  const proc = spawn(manager, args, {
    cwd: base,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' }
  })
  const key = devServerKey(conversationId)
  const managed: ManagedDevServer = {
    conversationId,
    command,
    proc,
    startedAt: Date.now(),
    lastOutput: ''
  }
  devServers.set(key, managed)

  const appendOutput = (chunk: Buffer): void => {
    managed.lastOutput = (managed.lastOutput + chunk.toString('utf-8')).slice(-12_000)
    const url = findLocalUrl(managed.lastOutput)
    if (url) managed.url = url
  }

  proc.stdout.on('data', appendOutput)
  proc.stderr.on('data', appendOutput)
  proc.on('close', (code) => {
    managed.exitCode = code
    if (devServers.get(key) === managed) devServers.delete(key)
  })
  proc.on('error', (e) => {
    managed.exitCode = -1
    managed.lastOutput = (managed.lastOutput + '\n' + String(e)).trim().slice(-12_000)
  })

  await new Promise<void>((resolve) => {
    const started = Date.now()
    const check = (): void => {
      if (managed.url || managed.exitCode !== undefined || Date.now() - started > 15_000) {
        resolve()
        return
      }
      setTimeout(check, 150)
    }
    check()
  })

  return workspaceDevServerStatus(conversationId)
}

function findLocalUrl(output: string): string | undefined {
  const matches = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/g)
  if (!matches?.length) return undefined
  return matches[matches.length - 1].replace('localhost', '127.0.0.1').replace(/\/?$/, '/')
}

export async function stopWorkspaceDevServer(conversationId: string): Promise<DevServerStatus> {
  const key = devServerKey(conversationId)
  const managed = devServers.get(key)
  if (!managed) return { running: false }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (managed.exitCode === undefined) managed.proc.kill('SIGKILL')
      resolve()
    }, 2_000)
    managed.proc.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    managed.proc.kill('SIGTERM')
  })
  devServers.delete(key)
  return { running: false, lastOutput: managed.lastOutput, exitCode: managed.exitCode ?? null }
}

export function workspaceDevServerStatus(conversationId: string): DevServerStatus {
  const managed = devServers.get(devServerKey(conversationId))
  if (!managed || managed.exitCode !== undefined) return { running: false }
  return {
    running: true,
    url: managed.url,
    command: managed.command,
    pid: managed.proc.pid,
    startedAt: managed.startedAt,
    lastOutput: managed.lastOutput
  }
}

export async function stopAllWorkspaceDevServers(): Promise<void> {
  await Promise.all([...devServers.values()].map((s) => stopWorkspaceDevServer(s.conversationId)))
}

export interface BashResult {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

const BASH_DENY =
  /\b(rm\s+-rf\s+\/|sudo|:\(\)\s*\{|chmod\s+777\s+\/|mkfs|dd\s+if=|shutdown|reboot)/i

export async function wsRunBash(
  conversationId: string,
  command: string,
  timeoutMs = 60_000,
  maxBytes = 16_000
): Promise<BashResult> {
  if (BASH_DENY.test(command)) {
    throw new Error('Blocked by safety policy: command contains a denied pattern.')
  }
  const base = await ensureWorkspace(conversationId)
  const start = Date.now()

  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', ['-lc', command], {
      cwd: base,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      truncated = true
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxBytes) {
        stdout += d.toString('utf-8')
        if (stdout.length >= maxBytes) {
          stdout = stdout.slice(0, maxBytes) + '\n[…output truncated]'
          truncated = true
        }
      }
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxBytes) {
        stderr += d.toString('utf-8')
        if (stderr.length >= maxBytes) {
          stderr = stderr.slice(0, maxBytes) + '\n[…stderr truncated]'
          truncated = true
        }
      }
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({
        exitCode: code,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - start
      })
    })
    proc.on('error', (e) => {
      clearTimeout(killTimer)
      resolve({
        exitCode: -1,
        stdout,
        stderr: (stderr + '\n' + String(e)).trim(),
        truncated,
        durationMs: Date.now() - start
      })
    })
  })
}
