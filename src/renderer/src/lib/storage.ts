/**
 * IndexedDB-backed conversation store.
 *
 * Replaces the original `localStorage` persistence which silently failed when
 * conversations approached the ~5MB quota. On first run we migrate the
 * existing `gemma-chat:conversations:v2` payload across and clear the
 * localStorage key.
 */

import type { ChatMessage, AgentMode } from '@shared/types'

export interface CanvasState {
  width?: number
  tab?: 'preview' | 'code' | 'files'
  selectedFile?: string | null
}

export interface Conversation {
  id: string
  title: string
  /** User-provided title (overrides auto title when set) */
  customTitle?: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  mode: AgentMode
  canvasOpen?: boolean
  canvasState?: CanvasState
  pinned?: boolean
}

export interface UISettings {
  sidebarWidth?: number
  canvasAutoSwitch?: boolean
  codeWrap?: boolean
}

const DB_NAME = 'gemma-chat'
const DB_VERSION = 1
const STORE_CONVERSATIONS = 'conversations'
const STORE_META = 'meta'
const LEGACY_KEY = 'gemma-chat:conversations:v2'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const store = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode)
        const store = t.objectStore(storeName)
        const r = fn(store)
        if (r instanceof Promise) {
          r.then((val) => {
            t.oncomplete = () => resolve(val)
            t.onerror = () => reject(t.error)
          }, reject)
        } else {
          r.onsuccess = () => {
            t.oncomplete = () => resolve(r.result)
          }
          r.onerror = () => reject(r.error)
          t.onerror = () => reject(t.error)
        }
      })
  )
}

export async function loadAllConversations(): Promise<Conversation[]> {
  try {
    await migrateFromLocalStorage()
  } catch (e) {
    console.warn('[storage] migration failed', e)
  }
  try {
    const list = await tx<Conversation[]>(STORE_CONVERSATIONS, 'readonly', (store) => {
      return new Promise<Conversation[]>((resolve, reject) => {
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result as Conversation[])
        req.onerror = () => reject(req.error)
      }) as unknown as IDBRequest<Conversation[]>
    })
    // Normalize older records that may be missing updatedAt
    const normalized = list.map((c) => ({
      ...c,
      updatedAt: c.updatedAt ?? c.createdAt ?? Date.now(),
      mode: c.mode ?? 'code'
    }))
    return normalized.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  } catch (e) {
    console.error('[storage] load failed', e)
    throw e
  }
}

export async function saveConversation(c: Conversation): Promise<void> {
  await tx(STORE_CONVERSATIONS, 'readwrite', (store) => store.put(c))
}

export async function saveConversations(cs: Conversation[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_CONVERSATIONS, 'readwrite')
    const store = t.objectStore(STORE_CONVERSATIONS)
    for (const c of cs) store.put(c)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function deleteConversationById(id: string): Promise<void> {
  await tx(STORE_CONVERSATIONS, 'readwrite', (store) => store.delete(id))
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  try {
    const row = await tx<{ key: string; value: T } | undefined>(
      STORE_META,
      'readonly',
      (store) => store.get(key)
    )
    return row?.value
  } catch {
    return undefined
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  try {
    await tx(STORE_META, 'readwrite', (store) => store.put({ key, value }))
  } catch (e) {
    console.warn('[storage] setting failed', key, e)
  }
}

async function migrateFromLocalStorage(): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return
  // Check if we've already migrated
  const flag = await getSetting<boolean>('migrated:v2-to-idb')
  if (flag) {
    localStorage.removeItem(LEGACY_KEY)
    return
  }
  try {
    const arr = JSON.parse(raw) as Conversation[]
    if (Array.isArray(arr) && arr.length) {
      const now = Date.now()
      const normalized = arr.map((c) => ({
        ...c,
        mode: c.mode ?? 'code',
        updatedAt: c.updatedAt ?? c.createdAt ?? now
      }))
      await saveConversations(normalized)
    }
    await setSetting('migrated:v2-to-idb', true)
    localStorage.removeItem(LEGACY_KEY)
    // Keep a one-time backup in case anything went sideways
    localStorage.setItem(LEGACY_KEY + ':backup', raw)
  } catch (e) {
    console.warn('[storage] could not parse legacy localStorage payload', e)
    await setSetting('migrated:v2-to-idb', true) // don't keep retrying
  }
}

/** Snapshots — last N delete/regenerate ops for undo */
const STORE_SNAPSHOTS = 'snapshots'
const MAX_SNAPSHOTS = 10

export interface Snapshot {
  id: string
  kind: 'delete' | 'regenerate' | 'clear'
  conversation: Conversation
  createdAt: number
}

// Lazy snapshot store: lives in a localStorage queue so we don't bloat the
// IndexedDB upgrade dance. Cheap, since N <= 10.
const SNAPSHOT_KEY = 'gemma-chat:snapshots'

export function pushSnapshot(snap: Snapshot): void {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    const list: Snapshot[] = raw ? JSON.parse(raw) : []
    list.unshift(snap)
    while (list.length > MAX_SNAPSHOTS) list.pop()
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list))
  } catch (e) {
    // Snapshot is best-effort; if it can't fit we just skip
    console.warn('[storage] snapshot push failed', e)
  }
}

export function popSnapshot(id: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const list: Snapshot[] = JSON.parse(raw)
    const idx = list.findIndex((s) => s.id === id)
    if (idx < 0) return null
    const [snap] = list.splice(idx, 1)
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list))
    return snap
  } catch {
    return null
  }
}

void STORE_SNAPSHOTS // reserved for future migration
