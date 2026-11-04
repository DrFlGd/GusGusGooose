// Where saved builds live. On the desktop (Tauri) each build is a folder of
// plain files in the app's data folder, written by the Rust side; in the
// browser the same files go into IndexedDB, so the web version keeps a
// library too (per browser, and lost if the site's data is cleared).

/** A build as the library lists it; the heavy parts are separate files. */
export interface BuildMeta {
  version: 1;
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** the collection's id ('' when it is in none) */
  collection: string;
  /** what was made: an accessory from a model, one from a picture, or a garment */
  kind: 'model' | 'picture' | 'garment';
  /** the position on the goose (head, left_wing, neck…), '' for a garment */
  point: string;
  /** the file it was made from, as loaded ('' for a shirt made from nothing) */
  sourceName: string;
  created: number;
  updated: number;
  /** whether a fitted, painted part was saved with it */
  fitted: boolean;
  faces?: number;
  colours?: { name: string; color: string }[];
  /** the files kept in its folder */
  files: string[];
}

/** A holiday or a category that builds are filed under. */
export interface Collection {
  id: string;
  name: string;
  group: 'holiday' | 'category';
}

export const DEFAULT_COLLECTIONS: Collection[] = [
  { id: 'new-year', name: 'New Year', group: 'holiday' },
  { id: 'valentines', name: "Valentine's Day", group: 'holiday' },
  { id: 'st-patricks', name: "St. Patrick's Day", group: 'holiday' },
  { id: 'easter', name: 'Easter', group: 'holiday' },
  { id: 'fourth-of-july', name: 'Fourth of July', group: 'holiday' },
  { id: 'halloween', name: 'Halloween', group: 'holiday' },
  { id: 'thanksgiving', name: 'Thanksgiving', group: 'holiday' },
  { id: 'christmas', name: 'Christmas', group: 'holiday' },
  { id: 'birthday', name: 'Birthday', group: 'category' },
  { id: 'hats', name: 'Hats', group: 'category' },
  { id: 'clothing', name: 'Clothing', group: 'category' },
  { id: 'everyday', name: 'Everyday', group: 'category' },
];

export const KIND_WORDS: Record<BuildMeta['kind'], string> = { model: 'Model', picture: 'Picture', garment: 'Garment' };
export const pointWords = (p: string) => (p ? p.replace('_', ' ') : '');

/** Tags typed as "santa, red hat" → ['santa', 'red hat'], without repeats (ignoring case). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, 40));
  }
  return out;
}

/** Whether a build matches a search: every word somewhere in its name, description, tags, collection or source. */
export function matches(m: BuildMeta, query: string, collectionName = ''): boolean {
  const hay = [m.name, m.description, m.tags.join(' '), collectionName, m.sourceName, pointWords(m.point), KIND_WORDS[m.kind]].join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export interface LibraryStore {
  /** 'desktop' when the files are in a folder, 'browser' when in IndexedDB */
  readonly kind: 'desktop' | 'browser';
  /** where the library is, in words */
  where(): Promise<string>;
  list(): Promise<BuildMeta[]>;
  read(id: string, name: string): Promise<Uint8Array | null>;
  /** writes the build's files, then its meta (so a listed build always has its files) */
  save(meta: BuildMeta, files: Record<string, Uint8Array>): Promise<void>;
  remove(id: string): Promise<void>;
  collections(): Promise<Collection[]>;
  setCollections(list: Collection[]): Promise<void>;
}

const enc = new TextEncoder(), dec = new TextDecoder();
export const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v));
export const bytesJson = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T;

/** A new build id: time first, so folders sort by age, plus a random tail. */
export function newId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}-${rand}`;
}

/** A library file name: letters, digits, dot, dash, underscore (what the desktop side accepts). */
export const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'file';

/** True inside the Tauri desktop app. */
export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ---------- desktop: files in <app data>/library via the Rust commands ----------
class DesktopStore implements LibraryStore {
  readonly kind = 'desktop' as const;
  private core = import('@tauri-apps/api/core');
  private async invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
    const { invoke } = await this.core;
    return invoke<T>(cmd, args, headers ? { headers } : undefined);
  }
  where() { return this.invoke<string>('library_dir'); }
  async list() {
    const all = await this.invoke<BuildMeta[]>('library_list');
    return all.filter((m) => m && typeof m.id === 'string');
  }
  async read(id: string, name: string) {
    try {
      const r = await this.invoke<ArrayBuffer | number[]>('library_read', { path: `${id}/${name}` });
      return r instanceof ArrayBuffer ? new Uint8Array(r) : Uint8Array.from(r);
    } catch { return null; }
  }
  private write(path: string, bytes: Uint8Array) { return this.invoke<void>('library_write', bytes, { 'x-path': path }); }
  async save(meta: BuildMeta, files: Record<string, Uint8Array>) {
    for (const [name, bytes] of Object.entries(files)) await this.write(`${meta.id}/${name}`, bytes);
    await this.write(`${meta.id}/meta.json`, jsonBytes(meta));
  }
  remove(id: string) { return this.invoke<void>('library_remove', { path: id }); }
  async collections() {
    try {
      const r = await this.invoke<ArrayBuffer | number[]>('library_read', { path: 'collections.json' });
      const list = bytesJson<Collection[]>(r instanceof ArrayBuffer ? new Uint8Array(r) : Uint8Array.from(r));
      return Array.isArray(list) ? list : DEFAULT_COLLECTIONS.map((c) => ({ ...c }));
    } catch { return DEFAULT_COLLECTIONS.map((c) => ({ ...c })); }
  }
  setCollections(list: Collection[]) { return this.write('collections.json', jsonBytes(list)); }
}

// ---------- browser: IndexedDB ----------
class BrowserStore implements LibraryStore {
  readonly kind = 'browser' as const;
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('gusgus-library', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('files');
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('the browser would not open its storage'));
    }));
  }
  private async tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      let out: T;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('storage full or blocked'));
    });
  }
  async where() { return 'this browser (IndexedDB)'; }
  list() { return this.tx<BuildMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll()); }
  async read(id: string, name: string) {
    const v = await this.tx<ArrayBuffer | Uint8Array | undefined>(['files'], 'readonly', (t) => t.objectStore('files').get(`${id}/${name}`));
    return v ? new Uint8Array(v instanceof Uint8Array ? v.slice().buffer : v) : null;
  }
  async save(meta: BuildMeta, files: Record<string, Uint8Array>) {
    await this.tx(['meta', 'files'], 'readwrite', (t) => {
      const fs = t.objectStore('files');
      for (const [name, bytes] of Object.entries(files)) fs.put(bytes.slice().buffer, `${meta.id}/${name}`);
      t.objectStore('meta').put(meta);
    });
  }
  async remove(id: string) {
    await this.tx(['meta', 'files'], 'readwrite', (t) => {
      t.objectStore('meta').delete(id);
      t.objectStore('files').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    });
  }
  async collections() {
    const v = await this.tx<Collection[] | undefined>(['kv'], 'readonly', (t) => t.objectStore('kv').get('collections'));
    return Array.isArray(v) ? v : DEFAULT_COLLECTIONS.map((c) => ({ ...c }));
  }
  async setCollections(list: Collection[]) {
    await this.tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(list, 'collections'); });
  }
}

let store: LibraryStore | null = null;
export function libraryStore(): LibraryStore {
  return (store ??= isDesktop() ? new DesktopStore() : new BrowserStore());
}

/**
 * Saves an export: on the desktop through a Save dialog (true when saved,
 * false when cancelled), in the browser as a download.
 */
export async function saveExport(name: string, bytes: Uint8Array): Promise<boolean> {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const ascii = name.replace(/[^\x20-\x7e]+/g, '_');
    return (await invoke<string | null>('export_file', bytes, { headers: { 'x-name': ascii } })) !== null;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
