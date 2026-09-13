const CACHE_ROOT = 'translation-cache';
export const TRANSLATION_CACHE_SCHEMA_VERSION = 1;
export const TRANSLATION_ABI_VERSION = 1;
export const MAX_TRANSLATION_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** Maximum number of complete artifacts retained by the persistent cache. */
export const MAX_TRANSLATION_CACHE_ENTRIES = 64;
/** Maximum aggregate artifact bytes retained by the persistent cache. */
export const MAX_TRANSLATION_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DATABASE_NAME = 'bottleship-translation-cache';
const DATABASE_VERSION = 2;
const STORE_NAME = 'entries';
const METADATA_STORE_NAME = 'metadata';
const CACHE_LOCK_NAME = 'gamebox:bottleship:translation-cache';

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
  /** Number of entries evicted by this cache instance since construction. */
  evictions: number;
  /** Alias exposing the evicted-entry count explicitly. */
  evictedEntries: number;
  /** Aggregate artifact bytes removed by eviction since construction. */
  evictedBytes: number;
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

let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withTranslationCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (locks) return locks.request(CACHE_LOCK_NAME, { mode: 'exclusive' }, operation);
  // A browser worker may have multiple independent realms. A same-realm queue
  // cannot coordinate those contexts, so refuse persistence and let the caller
  // continue on the ordinary JIT path when Web Locks are unavailable.
  if (typeof navigator !== 'undefined' && typeof location !== 'undefined')
    throw new Error('Persistent translation cache requires Web Locks in browser contexts');
  return enqueueMutation(operation);
}

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

function validProfile(value: unknown): value is TranslationProfileRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Partial<TranslationProfileRow>;
  const region = row.region;
  const stateFlags = row.stateFlags;
  return (
    Number.isSafeInteger(region) &&
    (region as number) >= 0 &&
    Number.isSafeInteger(stateFlags) &&
    (stateFlags as number) >= 0 &&
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
        (row[field as keyof TranslationProfileRow] as number) >= 0,
    )
  );
}

function validManifest(value: unknown): value is TranslationCacheManifest {
  const manifest = value as Partial<TranslationCacheManifest> | null;
  return (
    manifest !== null &&
    typeof manifest === 'object' &&
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
    const store = new OpfsTranslationCacheStore(cache);
    await reconcileTranslationCacheStore(store);
    return store;
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
    const invalidKeys: string[] = [];
    for await (const [key, handle] of (this.directory as DirectoryWithEntries).entries()) {
      if (handle.kind !== 'directory') continue;
      try {
        const file = await (await handle.getFileHandle('manifest.json')).getFile();
        const manifest: unknown = JSON.parse(
          decoder.decode(await readBounded(file, MAX_MANIFEST_BYTES)),
        );
        if (!validManifest(manifest)) throw new Error('Invalid translation cache manifest');
        const artifactFile = await (await handle.getFileHandle('artifact.bin')).getFile();
        // Listing is aggregate metadata maintenance. Do not stream every
        // artifact just to calculate admission totals; selected entries are
        // integrity-checked by get()/PersistentTranslationCache.load().
        if (artifactFile.size !== manifest.artifactBytes)
          throw new Error('Invalid translation cache artifact');
        rows.push({ key, manifest });
      } catch {
        // Maintenance is deliberately best-effort: a bad derived artifact must
        // not prevent other entries from being admitted or evicted.
        invalidKeys.push(key);
      }
    }
    for (const key of invalidKeys) await this.delete(key);
    return rows;
  }

  async clear(): Promise<void> {
    for await (const [name] of (this.directory as DirectoryWithEntries).entries())
      await this.directory.removeEntry(name, { recursive: true });
  }
}

interface IndexedDbRecord {
  key: string;
  manifest: unknown;
  artifact: ArrayBuffer;
}

interface IndexedDbMetadataRecord {
  key: string;
  manifest: unknown;
  artifactBytes: number;
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
      const database = request.result;
      const transaction = request.transaction;
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      if (database.objectStoreNames.contains(METADATA_STORE_NAME)) return;
      const metadata = database.createObjectStore(METADATA_STORE_NAME, { keyPath: 'key' });
      // v1 stored the artifact and manifest together. Copy only metadata from
      // each record during the versionchange cursor; artifact buffers are not
      // retained after each cursor callback.
      if (!transaction) return;
      const entries = transaction.objectStore(STORE_NAME);
      const cursorRequest = entries.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as Partial<IndexedDbRecord> | null;
        if (value && typeof value.key === 'string') {
          metadata.put({
            key: value.key,
            manifest: value.manifest,
            artifactBytes: value.artifact instanceof ArrayBuffer ? value.artifact.byteLength : -1,
          } satisfies IndexedDbMetadataRecord);
        }
        cursor.continue();
      };
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      request.onsuccess = () => {
        // A blocked request can still report success after the rejection. Do
        // not hand that connection to the caller or leave it open.
        let database: IDBDatabase;
        try {
          database = request.result;
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          return;
        }
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        resolve(database);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB open blocked by another connection'));
      };
    });
    const store = new IndexedDbTranslationCacheStore(database);
    await reconcileTranslationCacheStore(store);
    return store;
  }

  async get(key: string): Promise<TranslationCacheEntry | null> {
    const transaction = this.database.transaction(STORE_NAME, 'readonly');
    const record = (await requestResult(transaction.objectStore(STORE_NAME).get(key))) as
      IndexedDbRecord | undefined | null;
    await transactionDone(transaction);
    if (!record) return null;
    if (
      typeof record !== 'object' ||
      !(record.artifact instanceof ArrayBuffer) ||
      !validManifest(record.manifest) ||
      record.artifact.byteLength !== record.manifest.artifactBytes
    ) {
      await this.delete(key);
      return null;
    }
    return { manifest: record.manifest, artifact: new Uint8Array(record.artifact) };
  }

  async put(key: string, entry: TranslationCacheEntry): Promise<void> {
    const transaction = this.database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      key,
      manifest: entry.manifest,
      artifact: entry.artifact.buffer.slice(
        entry.artifact.byteOffset,
        entry.artifact.byteOffset + entry.artifact.byteLength,
      ),
    } satisfies IndexedDbRecord);
    transaction.objectStore(METADATA_STORE_NAME).put({
      key,
      manifest: entry.manifest,
      artifactBytes: entry.artifact.byteLength,
    } satisfies IndexedDbMetadataRecord);
    await transactionDone(transaction);
  }

  async delete(key: string): Promise<void> {
    const transaction = this.database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.objectStore(METADATA_STORE_NAME).delete(key);
    await transactionDone(transaction);
  }

  async list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>> {
    const transaction = this.database.transaction(METADATA_STORE_NAME, 'readonly');
    const records: IndexedDbMetadataRecord[] = [];
    await new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(METADATA_STORE_NAME).openCursor();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as Partial<IndexedDbMetadataRecord> | null;
        records.push({
          key: typeof record?.key === 'string' ? record.key : '',
          manifest: record?.manifest,
          artifactBytes: record?.artifactBytes ?? -1,
        });
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    const valid: Array<{ key: string; manifest: TranslationCacheManifest }> = [];
    const invalidKeys: string[] = [];
    for (const record of records) {
      if (
        record.key &&
        validManifest(record.manifest) &&
        record.artifactBytes === record.manifest.artifactBytes
      )
        valid.push({ key: record.key, manifest: record.manifest });
      else if (record.key) invalidKeys.push(record.key);
    }
    await Promise.all(invalidKeys.map((key) => this.delete(key)));
    return valid;
  }

  async clear(): Promise<void> {
    const transaction = this.database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    transaction.objectStore(METADATA_STORE_NAME).clear();
    await transactionDone(transaction);
  }
}

export class MemoryTranslationCacheStore implements TranslationCacheStore {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, TranslationCacheEntry>();

  async get(key: string): Promise<TranslationCacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (
      !validManifest(entry.manifest) ||
      !(entry.artifact instanceof Uint8Array) ||
      entry.artifact.byteLength !== entry.manifest.artifactBytes
    ) {
      this.entries.delete(key);
      return null;
    }
    return { manifest: structuredClone(entry.manifest), artifact: entry.artifact.slice() };
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
    const rows: Array<{ key: string; manifest: TranslationCacheManifest }> = [];
    for (const [key, entry] of this.entries) {
      if (
        entry &&
        validManifest(entry.manifest) &&
        entry.artifact instanceof Uint8Array &&
        entry.artifact.byteLength === entry.manifest.artifactBytes
      )
        rows.push({ key, manifest: structuredClone(entry.manifest) });
      else this.entries.delete(key);
    }
    return rows;
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

async function reconcileStoreBounds(store: TranslationCacheStore): Promise<void> {
  const rows = await store.list();
  let entries = rows.length;
  let bytes = rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
  const candidates = rows
    .slice()
    .sort(
      (a, b) =>
        a.manifest.updatedAt - b.manifest.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  while (entries > MAX_TRANSLATION_CACHE_ENTRIES || bytes > MAX_TRANSLATION_CACHE_BYTES) {
    const candidate = candidates.shift();
    if (!candidate) throw new Error('Translation cache quota reconciliation failed');
    await store.delete(candidate.key);
    entries--;
    bytes -= candidate.manifest.artifactBytes;
  }
  const finalRows = await store.list();
  const finalBytes = finalRows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
  if (finalRows.length > MAX_TRANSLATION_CACHE_ENTRIES || finalBytes > MAX_TRANSLATION_CACHE_BYTES)
    throw new Error('Translation cache quota reconciliation failed');
}

/** Reconcile an existing backend immediately while holding the global cache lock. */
export async function reconcileTranslationCacheStore(store: TranslationCacheStore): Promise<void> {
  await withTranslationCacheLock(() => reconcileStoreBounds(store));
}

/** Clear every persistent translation entry while holding the global cache lock. */
export async function clearTranslationCacheStore(store: TranslationCacheStore): Promise<number> {
  return withTranslationCacheLock(async () => {
    const count = (await store.list()).length;
    await store.clear();
    return count;
  });
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
  private evictedEntries = 0;
  private evictedBytes = 0;
  constructor(
    readonly store: TranslationCacheStore,
    readonly identity: TranslationCacheIdentity,
  ) {
    this.keyPromise = translationCacheKey(identity);
  }

  async load(): Promise<TranslationCacheEntry | null> {
    return withTranslationCacheLock(async () => {
      const key = await this.keyPromise;
      let entry: TranslationCacheEntry | null;
      try {
        entry = await this.store.get(key);
      } catch {
        await this.store.delete(key).catch(() => {});
        return null;
      }
      if (!entry) return null;
      let valid: boolean;
      try {
        valid =
          validManifest(entry.manifest) &&
          sameIdentity(entry.manifest, this.identity) &&
          entry.artifact instanceof Uint8Array &&
          entry.artifact.byteLength === entry.manifest.artifactBytes &&
          (await sha256(entry.artifact)) === entry.manifest.artifactSha256;
      } catch {
        valid = false;
      }
      if (valid) return entry;
      await this.store.delete(key).catch(() => {});
      return null;
    });
  }

  async save(
    artifact: Uint8Array<ArrayBuffer>,
    profiles: readonly TranslationProfileRow[],
    previous?: TranslationCacheEntry | null,
  ): Promise<TranslationCacheEntry> {
    return withTranslationCacheLock(async () => {
      if (artifact.byteLength < 8 || artifact.byteLength > MAX_TRANSLATION_ARTIFACT_BYTES)
        throw new Error('Translation artifact exceeds its byte budget');
      if (artifact.byteLength > MAX_TRANSLATION_CACHE_BYTES)
        throw new Error('Translation artifact cannot fit the aggregate cache byte budget');
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
      const key = await this.keyPromise;
      let putAttempted = false;
      try {
        const rows = await this.store.list();
        const existing = rows.find((row) => row.key === key);
        const entries = rows.length - (existing ? 1 : 0);
        let bytes = rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
        if (existing) bytes -= existing.manifest.artifactBytes;

        // The key being replaced is removed from the aggregate before deciding
        // whether the new artifact fits. It is never selected as an eviction
        // candidate, so a larger replacement cannot evict itself.
        await this.evictUntilFits(rows, key, artifact.byteLength, entries, bytes);
        putAttempted = true;
        await this.store.put(key, entry);
        await this.reconcileAfterWrite(key);
      } catch (error) {
        // Before put is attempted, preserve an existing valid replacement key;
        // admission/list failures must not turn a cache miss into data loss.
        // Once put starts, OPFS cannot promise atomicity, so delete the key and
        // reconcile before exposing an error.
        let recoveryError: unknown;
        if (putAttempted) {
          try {
            await this.store.delete(key);
          } catch (cleanupError) {
            recoveryError = cleanupError;
          }
        }
        try {
          await this.reconcileAfterFailedSave(key, putAttempted);
        } catch (reconcileError) {
          recoveryError ??= reconcileError;
        }
        if (recoveryError)
          throw new AggregateError(
            [error, recoveryError],
            putAttempted
              ? 'Translation cache save recovery failed'
              : 'Translation cache save failed',
            { cause: error },
          );
        throw error;
      }
      return entry;
    });
  }

  private async reconcileAfterFailedSave(key: string, putAttempted: boolean): Promise<void> {
    if (putAttempted) {
      await this.reconcileAll();
      return;
    }
    const rows = await this.store.list();
    const existing = rows.find((row) => row.key === key);
    if (!existing) {
      await this.reconcileAll();
      return;
    }
    await this.evictUntilFits(
      rows,
      key,
      existing.manifest.artifactBytes,
      rows.length - 1,
      rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0) -
        existing.manifest.artifactBytes,
    );
    const finalRows = await this.store.list();
    const finalBytes = finalRows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
    if (
      finalRows.length > MAX_TRANSLATION_CACHE_ENTRIES ||
      finalBytes > MAX_TRANSLATION_CACHE_BYTES
    )
      throw new Error('Translation cache quota reconciliation failed');
  }

  private async evictUntilFits(
    rows: Array<{ key: string; manifest: TranslationCacheManifest }>,
    protectedKey: string | null,
    bytesNeeded: number,
    initialEntries = rows.length -
      (protectedKey !== null && rows.some((row) => row.key === protectedKey) ? 1 : 0),
    initialBytes = rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0) -
      (protectedKey === null
        ? 0
        : (rows.find((row) => row.key === protectedKey)?.manifest.artifactBytes ?? 0)),
    reserveEntry = true,
  ): Promise<void> {
    let entries = initialEntries;
    let bytes = initialBytes;
    const candidates = rows
      .filter((row) => row.key !== protectedKey)
      .sort(
        (a, b) =>
          a.manifest.updatedAt - b.manifest.updatedAt ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
    while (
      (reserveEntry ? entries + 1 : entries) > MAX_TRANSLATION_CACHE_ENTRIES ||
      bytes + bytesNeeded > MAX_TRANSLATION_CACHE_BYTES
    ) {
      const candidate = candidates.shift();
      if (!candidate) throw new Error('Translation artifact cannot fit the aggregate cache budget');
      await this.store.delete(candidate.key);
      entries--;
      bytes -= candidate.manifest.artifactBytes;
      this.evictedEntries++;
      this.evictedBytes += candidate.manifest.artifactBytes;
    }
  }

  private async reconcileAfterWrite(key: string): Promise<void> {
    const rows = await this.store.list();
    const current = rows.find((row) => row.key === key);
    if (!current) throw new Error('Translation cache write was not visible during reconciliation');
    await this.evictUntilFits(rows, key, current.manifest.artifactBytes);
    const finalRows = await this.store.list();
    const bytes = finalRows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
    if (finalRows.length > MAX_TRANSLATION_CACHE_ENTRIES || bytes > MAX_TRANSLATION_CACHE_BYTES)
      throw new Error('Translation cache quota reconciliation failed');
  }

  private async reconcileAll(): Promise<void> {
    const rows = await this.store.list();
    await this.evictUntilFits(rows, null, 0, undefined, undefined, false);
    const finalRows = await this.store.list();
    const bytes = finalRows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0);
    if (finalRows.length > MAX_TRANSLATION_CACHE_ENTRIES || bytes > MAX_TRANSLATION_CACHE_BYTES)
      throw new Error('Translation cache quota reconciliation failed');
  }

  async delete(): Promise<void> {
    await withTranslationCacheLock(async () => {
      await this.store.delete(await this.keyPromise);
    });
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
    return withTranslationCacheLock(async () => {
      const rows = await this.store.list();
      const matches = rows.filter((row) => predicate(row.manifest));
      await Promise.all(matches.map((row) => this.store.delete(row.key)));
      return matches.length;
    });
  }

  async clear(): Promise<void> {
    await withTranslationCacheLock(() => this.store.clear());
  }

  async statistics(): Promise<TranslationCacheStatistics> {
    return withTranslationCacheLock(async () => {
      const rows = await this.store.list();
      return {
        backend: this.store.backend,
        entries: rows.length,
        bytes: rows.reduce((sum, row) => sum + row.manifest.artifactBytes, 0),
        games: new Set(rows.map((row) => row.manifest.gameId)).size,
        modules: new Set(rows.map((row) => row.manifest.moduleId)).size,
        evictions: this.evictedEntries,
        evictedEntries: this.evictedEntries,
        evictedBytes: this.evictedBytes,
      };
    });
  }
}
