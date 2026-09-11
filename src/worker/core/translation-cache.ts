const CACHE_ROOT = 'translation-cache';
export const TRANSLATION_CACHE_SCHEMA_VERSION = 1;
export const TRANSLATION_ABI_VERSION = 1;
export const MAX_TRANSLATION_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DATABASE_NAME = 'bottleship-translation-cache';
const DATABASE_VERSION = 1;
const STORE_NAME = 'entries';

export interface TranslationCacheIdentity {
  gameId: string;
  moduleId: string;
  translatorVersion: string;
  abiVersion: number;
}

export interface TranslationProfileRow {
  region: number;
  stateFlags: number;
  executions: number;
  cacheHits: number;
  translations: number;
  translationUs: number;
  wasmCompileUs: number;
  wasmInstantiateUs: number;
  firstExecutionAt: number;
  lastExecutionAt: number;
}

export interface TranslationCacheManifest extends TranslationCacheIdentity {
  format: 'gamebox-v86-persistent-cache-1';
  artifactFormat: 'gamebox-v86-aot-1';
  schemaVersion: number;
  artifactBytes: number;
  artifactSha256: string;
  createdAt: number;
  updatedAt: number;
  profiles: TranslationProfileRow[];
}

export interface TranslationCacheEntry {
  manifest: TranslationCacheManifest;
  artifact: Uint8Array<ArrayBuffer>;
}

export interface TranslationCacheStatistics {
  backend: 'opfs' | 'indexeddb' | 'memory';
  entries: number;
  bytes: number;
  games: number;
  modules: number;
}

export interface TranslationCacheStore {
  readonly backend: TranslationCacheStatistics['backend'];
  get(key: string): Promise<TranslationCacheEntry | null>;
  put(key: string, entry: TranslationCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>>;
  clear(): Promise<void>;
}

type DirectoryWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function identityText(identity: TranslationCacheIdentity): string {
  return [
    TRANSLATION_CACHE_SCHEMA_VERSION,
    identity.gameId,
    identity.moduleId,
    identity.translatorVersion,
    identity.abiVersion,
  ].join('\0');
}

export async function translationCacheKey(identity: TranslationCacheIdentity): Promise<string> {
  return sha256(encoder.encode(identityText(identity)));
}

function sameIdentity(a: TranslationCacheIdentity, b: TranslationCacheIdentity): boolean {
  return (
    a.gameId === b.gameId &&
    a.moduleId === b.moduleId &&
    a.translatorVersion === b.translatorVersion &&
    a.abiVersion === b.abiVersion
  );
}

function validProfile(row: TranslationProfileRow): boolean {
  return (
    Number.isSafeInteger(row.region) &&
    row.region >= 0 &&
    Number.isSafeInteger(row.stateFlags) &&
    row.stateFlags >= 0 &&
    [
      'executions',
      'cacheHits',
      'translations',
      'translationUs',
      'wasmCompileUs',
      'wasmInstantiateUs',
      'firstExecutionAt',
      'lastExecutionAt',
    ].every(
      (field) =>
        Number.isSafeInteger(row[field as keyof TranslationProfileRow]) &&
        row[field as keyof TranslationProfileRow] >= 0,
    )
  );
}

function validManifest(value: unknown): value is TranslationCacheManifest {
  const manifest = value as Partial<TranslationCacheManifest> | null;
  return (
    manifest !== null &&
    manifest.format === 'gamebox-v86-persistent-cache-1' &&
    manifest.artifactFormat === 'gamebox-v86-aot-1' &&
    manifest.schemaVersion === TRANSLATION_CACHE_SCHEMA_VERSION &&
    typeof manifest.gameId === 'string' &&
    typeof manifest.moduleId === 'string' &&
    typeof manifest.translatorVersion === 'string' &&
    manifest.abiVersion === TRANSLATION_ABI_VERSION &&
    Number.isSafeInteger(manifest.artifactBytes) &&
    manifest.artifactBytes! >= 8 &&
    manifest.artifactBytes! <= MAX_TRANSLATION_ARTIFACT_BYTES &&
    typeof manifest.artifactSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.artifactSha256) &&
    Number.isSafeInteger(manifest.createdAt) &&
    Number.isSafeInteger(manifest.updatedAt) &&
    Array.isArray(manifest.profiles) &&
    manifest.profiles.length <= 4096 &&
    manifest.profiles.every(validProfile)
  );
}

async function readBounded(file: File, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (file.size > limit) throw new Error('Translation cache file exceeds its byte budget');
  const reader = file.stream().getReader();
  const result = new Uint8Array(file.size);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > limit || offset + value.byteLength > result.byteLength)
        throw new Error('Translation cache file changed while reading');
      result.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (offset !== result.byteLength) throw new Error('Truncated translation cache file');
  return result;
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  contents: Uint8Array<ArrayBuffer> | string,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(contents);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export class OpfsTranslationCacheStore implements TranslationCacheStore {
  readonly backend = 'opfs' as const;
  constructor(private readonly directory: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsTranslationCacheStore> {
    const root = await navigator.storage.getDirectory();
    const bottleship = await root.getDirectoryHandle('bottleship', { create: true });
    const cache = await bottleship.getDirectoryHandle(CACHE_ROOT, { create: true });
    return new OpfsTranslationCacheStore(cache);
  }

  async get(key: string): Promise<TranslationCacheEntry | null> {
    try {
      const directory = await this.directory.getDirectoryHandle(key);
      const manifestFile = await (await directory.getFileHandle('manifest.json')).getFile();
      const manifestBytes = await readBounded(manifestFile, MAX_MANIFEST_BYTES);
      const manifest: unknown = JSON.parse(decoder.decode(manifestBytes));
      if (!validManifest(manifest)) throw new Error('Invalid translation cache manifest');
      const artifactFile = await (await directory.getFileHandle('artifact.bin')).getFile();
      const artifact = await readBounded(artifactFile, MAX_TRANSLATION_ARTIFACT_BYTES);
      return { manifest, artifact };
    } catch (error) {
      if ((error as DOMException)?.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async put(key: string, entry: TranslationCacheEntry): Promise<void> {
    const directory = await this.directory.getDirectoryHandle(key, { create: true });
    // Commit the manifest last. A crash can leave an orphaned artifact, but never
    // a new manifest pointing at partially written bytes.
    await writeFile(directory, 'artifact.bin', entry.artifact);
    await writeFile(directory, 'manifest.json', JSON.stringify(entry.manifest));
  }

  async delete(key: string): Promise<void> {
    await this.directory.removeEntry(key, { recursive: true }).catch((error) => {
      if ((error as DOMException)?.name !== 'NotFoundError') throw error;
    });
  }

  async list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>> {
    const rows: Array<{ key: string; manifest: TranslationCacheManifest }> = [];
    for await (const [key, handle] of (this.directory as DirectoryWithEntries).entries()) {
      if (handle.kind !== 'directory') continue;
      try {
        const file = await (await handle.getFileHandle('manifest.json')).getFile();
        const manifest: unknown = JSON.parse(
          decoder.decode(await readBounded(file, MAX_MANIFEST_BYTES)),
        );
        if (validManifest(manifest)) rows.push({ key, manifest });
      } catch {
        /* Corrupt entries are excluded and removed on direct lookup. */
      }
    }
    return rows;
  }

  async clear(): Promise<void> {
    for await (const [name] of (this.directory as DirectoryWithEntries).entries())
      await this.directory.removeEntry(name, { recursive: true });
  }
}

interface IndexedDbRecord {
  key: string;
  manifest: TranslationCacheManifest;
  artifact: ArrayBuffer;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IndexedDbTranslationCacheStore implements TranslationCacheStore {
  readonly backend = 'indexeddb' as const;
  constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbTranslationCacheStore> {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    return new IndexedDbTranslationCacheStore(await requestResult(request));
  }

  async get(key: string): Promise<TranslationCacheEntry | null> {
    const transaction = this.database.transaction(STORE_NAME, 'readonly');
    const record = (await requestResult(transaction.objectStore(STORE_NAME).get(key))) as
      IndexedDbRecord | undefined;
    await transactionDone(transaction);
    return record ? { manifest: record.manifest, artifact: new Uint8Array(record.artifact) } : null;
  }

  async put(key: string, entry: TranslationCacheEntry): Promise<void> {
    const transaction = this.database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      key,
      manifest: entry.manifest,
      artifact: entry.artifact.buffer.slice(
        entry.artifact.byteOffset,
        entry.artifact.byteOffset + entry.artifact.byteLength,
      ),
    } satisfies IndexedDbRecord);
    await transactionDone(transaction);
  }

  async delete(key: string): Promise<void> {
    const transaction = this.database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    await transactionDone(transaction);
  }

  async list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>> {
    const transaction = this.database.transaction(STORE_NAME, 'readonly');
    const records = (await requestResult(
      transaction.objectStore(STORE_NAME).getAll(),
    )) as IndexedDbRecord[];
    await transactionDone(transaction);
    return records
      .filter((record) => validManifest(record.manifest))
      .map(({ key, manifest }) => ({ key, manifest }));
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  }
}

export class MemoryTranslationCacheStore implements TranslationCacheStore {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, TranslationCacheEntry>();

  async get(key: string): Promise<TranslationCacheEntry | null> {
    const entry = this.entries.get(key);
    return entry
      ? { manifest: structuredClone(entry.manifest), artifact: entry.artifact.slice() }
      : null;
  }
  async put(key: string, entry: TranslationCacheEntry): Promise<void> {
    this.entries.set(key, {
      manifest: structuredClone(entry.manifest),
      artifact: entry.artifact.slice(),
    });
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>> {
    return Array.from(this.entries, ([key, entry]) => ({
      key,
      manifest: structuredClone(entry.manifest),
    }));
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export async function openTranslationCacheStore(): Promise<TranslationCacheStore> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function')
      return await OpfsTranslationCacheStore.open();
  } catch {
    /* Fall through to IndexedDB. */
  }
  return IndexedDbTranslationCacheStore.open();
}

function profileKey(row: TranslationProfileRow): string {
  return `${row.region >>> 0}:${row.stateFlags >>> 0}`;
}

export function mergeTranslationProfiles(
  previous: readonly TranslationProfileRow[],
  current: readonly TranslationProfileRow[],
): TranslationProfileRow[] {
  const merged = new Map<string, TranslationProfileRow>();
  for (const row of [...previous, ...current]) {
    const key = profileKey(row);
    const old = merged.get(key);
    if (!old) {
      merged.set(key, { ...row });
      continue;
    }
    old.executions += row.executions;
    old.cacheHits += row.cacheHits;
    old.translations += row.translations;
    old.translationUs += row.translationUs;
    old.wasmCompileUs += row.wasmCompileUs;
    old.wasmInstantiateUs += row.wasmInstantiateUs;
    old.firstExecutionAt = Math.min(
      old.firstExecutionAt || Number.MAX_SAFE_INTEGER,
      row.firstExecutionAt || Number.MAX_SAFE_INTEGER,
    );
    if (old.firstExecutionAt === Number.MAX_SAFE_INTEGER) old.firstExecutionAt = 0;
    old.lastExecutionAt = Math.max(old.lastExecutionAt, row.lastExecutionAt);
  }
  return Array.from(merged.values())
    .sort((a, b) => b.executions - a.executions || a.region - b.region)
    .slice(0, 4096);
}

export class PersistentTranslationCache {
  private keyPromise: Promise<string>;
  constructor(
    readonly store: TranslationCacheStore,
    readonly identity: TranslationCacheIdentity,
  ) {
    this.keyPromise = translationCacheKey(identity);
  }

  async load(): Promise<TranslationCacheEntry | null> {
    const key = await this.keyPromise;
    let entry: TranslationCacheEntry | null;
    try {
      entry = await this.store.get(key);
    } catch {
      await this.store.delete(key).catch(() => {});
      return null;
    }
    if (!entry) return null;
    const valid =
      validManifest(entry.manifest) &&
      sameIdentity(entry.manifest, this.identity) &&
      entry.artifact.byteLength === entry.manifest.artifactBytes &&
      (await sha256(entry.artifact)) === entry.manifest.artifactSha256;
    if (valid) return entry;
    await this.store.delete(key).catch(() => {});
    return null;
  }

  async save(
    artifact: Uint8Array<ArrayBuffer>,
    profiles: readonly TranslationProfileRow[],
    previous?: TranslationCacheEntry | null,
  ): Promise<TranslationCacheEntry> {
    if (artifact.byteLength < 8 || artifact.byteLength > MAX_TRANSLATION_ARTIFACT_BYTES)
      throw new Error('Translation artifact exceeds its byte budget');
    const now = Date.now();
    const entry: TranslationCacheEntry = {
      manifest: {
        format: 'gamebox-v86-persistent-cache-1',
        artifactFormat: 'gamebox-v86-aot-1',
        schemaVersion: TRANSLATION_CACHE_SCHEMA_VERSION,
        ...this.identity,
        artifactBytes: artifact.byteLength,
        artifactSha256: await sha256(artifact),
        createdAt: previous?.manifest.createdAt ?? now,
        updatedAt: now,
        profiles: mergeTranslationProfiles(previous?.manifest.profiles ?? [], profiles),
      },
      artifact,
    };
    await this.store.put(await this.keyPromise, entry);
    return entry;
  }

  async delete(): Promise<void> {
    await this.store.delete(await this.keyPromise);
  }

  async invalidateGame(gameId: string): Promise<number> {
    return this.invalidate((row) => row.gameId === gameId);
  }

  async invalidateModule(moduleId: string): Promise<number> {
    return this.invalidate((row) => row.moduleId === moduleId);
  }

  private async invalidate(
    predicate: (manifest: TranslationCacheManifest) => boolean,
  ): Promise<number> {
    const rows = await this.store.list();
    const matches = rows.filter((row) => predicate(row.manifest));
    await Promise.all(matches.map((row) => this.store.delete(row.key)));
    return matches.length;
  }

  async statistics(): Promise<TranslationCacheStatistics> {
    const rows = await this.store.list();
    return {
      backend: this.store.backend,
      entries: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0),
      games: new Set(rows.map((row) => row.manifest.gameId)).size,
      modules: new Set(rows.map((row) => row.manifest.moduleId)).size,
    };
  }
}
