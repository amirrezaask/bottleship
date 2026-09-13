import { describe, expect, test } from 'bun:test';
import {
  clearTranslationCacheStore,
  MemoryTranslationCacheStore,
  OpfsTranslationCacheStore,
  PersistentTranslationCache,
  TRANSLATION_ABI_VERSION,
  MAX_TRANSLATION_CACHE_ENTRIES,
  MAX_TRANSLATION_ARTIFACT_BYTES,
  mergeTranslationProfiles,
  sha256,
  translationCacheKey,
  type TranslationCacheIdentity,
  type TranslationCacheEntry,
  type TranslationCacheManifest,
  type TranslationProfileRow,
} from '../../src/worker/core/translation-cache';

const identity = (overrides: Partial<TranslationCacheIdentity> = {}): TranslationCacheIdentity => ({
  gameId: 'app:gamebox-' + '1'.repeat(64),
  moduleId: 'gamebox-' + '2'.repeat(64) + '.wgb',
  translatorVersion: '3'.repeat(64),
  abiVersion: TRANSLATION_ABI_VERSION,
  ...overrides,
});

const profile = (overrides: Partial<TranslationProfileRow> = {}): TranslationProfileRow => ({
  region: 0x401000,
  stateFlags: 7,
  executions: 10,
  cacheHits: 0,
  translations: 1,
  translationUs: 120,
  wasmCompileUs: 80,
  wasmInstantiateUs: 10,
  firstExecutionAt: 1000,
  lastExecutionAt: 2000,
  ...overrides,
});

const artifact = () => new Uint8Array([0x41, 0x4f, 0x54, 0x31, 1, 0, 0, 0]);

async function storedManifest(
  overrides: Partial<TranslationCacheManifest> = {},
  bytes = artifact(),
): Promise<{ manifest: TranslationCacheManifest; artifact: Uint8Array<ArrayBuffer> }> {
  return {
    manifest: {
      format: 'gamebox-v86-persistent-cache-1',
      artifactFormat: 'gamebox-v86-aot-1',
      schemaVersion: 1,
      ...identity(),
      artifactBytes: bytes.byteLength,
      artifactSha256: await sha256(bytes),
      createdAt: 1,
      updatedAt: 1,
      profiles: [],
      ...overrides,
    },
    artifact: bytes,
  };
}

class FakeOpfsDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeOpfsDirectory | FakeOpfsFile>();

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeOpfsDirectory> {
    const current = this.children.get(name);
    if (current?.kind === 'directory') return current;
    if (!options?.create)
      throw Object.assign(new Error('missing directory'), { name: 'NotFoundError' });
    const directory = new FakeOpfsDirectory();
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeOpfsFile> {
    const current = this.children.get(name);
    if (current?.kind === 'file') return current;
    if (!options?.create) throw Object.assign(new Error('missing file'), { name: 'NotFoundError' });
    const file = new FakeOpfsFile('');
    this.children.set(name, file);
    return file;
  }

  async *entries(): AsyncIterableIterator<[string, FakeOpfsDirectory | FakeOpfsFile]> {
    yield* this.children.entries();
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name))
      throw Object.assign(new Error('missing entry'), { name: 'NotFoundError' });
  }

  addDirectory(name: string, manifest?: string, bytes?: Uint8Array<ArrayBuffer>): void {
    const directory = new FakeOpfsDirectory();
    this.children.set(name, directory);
    if (manifest !== undefined) directory.children.set('manifest.json', new FakeOpfsFile(manifest));
    if (bytes !== undefined) directory.children.set('artifact.bin', new FakeOpfsFile(bytes));
  }
}

class FakeOpfsFile {
  readonly kind = 'file' as const;
  streamReads = 0;
  constructor(private contents: string | Uint8Array<ArrayBuffer>) {}
  replace(contents: string | Uint8Array<ArrayBuffer>): void {
    this.contents = contents;
  }
  async getFile(): Promise<File> {
    const file = new File([this.contents], 'cache.bin');
    const stream = file.stream.bind(file);
    Object.defineProperty(file, 'stream', {
      value: () => {
        this.streamReads++;
        return stream();
      },
    });
    return file;
  }
}

class DelayedMemoryStore extends MemoryTranslationCacheStore {
  readonly started: Promise<void>;
  private readonly releasePromise: Promise<void>;
  private signalStarted!: () => void;
  private releaseWrite!: () => void;
  private delayNextPut = true;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.signalStarted = resolve;
    });
    this.releasePromise = new Promise((resolve) => {
      this.releaseWrite = resolve;
    });
  }

  release(): void {
    this.releaseWrite();
  }

  override async put(key: string, entry: TranslationCacheEntry): Promise<void> {
    if (this.delayNextPut) {
      this.delayNextPut = false;
      this.signalStarted();
      await this.releasePromise;
    }
    await super.put(key, entry);
  }
}

class FailingListStore extends MemoryTranslationCacheStore {
  failNextList = false;

  override async list(): Promise<Array<{ key: string; manifest: TranslationCacheManifest }>> {
    if (this.failNextList) {
      this.failNextList = false;
      throw new Error('synthetic list failure');
    }
    return super.list();
  }
}

describe('persistent translation cache identity', () => {
  test('same game, module, translator, and ABI produces the same key', async () => {
    expect(await translationCacheKey(identity())).toBe(await translationCacheKey(identity()));
  });

  test('game, executable, translator, and ABI changes select different entries', async () => {
    const base = await translationCacheKey(identity());
    for (const changed of [
      identity({ gameId: 'app:gamebox-' + '4'.repeat(64) }),
      identity({ moduleId: 'gamebox-' + '5'.repeat(64) + '.wgb' }),
      identity({ translatorVersion: '6'.repeat(64) }),
      identity({ abiVersion: TRANSLATION_ABI_VERSION + 1 }),
    ])
      expect(await translationCacheKey(changed)).not.toBe(base);
  });
});

describe('persistent translation cache lifecycle', () => {
  test('reuses an intact artifact and profile', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    await cache.save(artifact(), [profile()]);
    const loaded = await cache.load();
    expect(Array.from(loaded!.artifact)).toEqual(Array.from(artifact()));
    expect(loaded!.manifest.profiles[0].executions).toBe(10);
  });

  test('rejects and removes corrupted bytes', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    await cache.save(artifact(), []);
    const key = await translationCacheKey(identity());
    const stored = await store.get(key);
    stored!.artifact[0] ^= 0xff;
    await store.put(key, stored!);
    expect(await cache.load()).toBeNull();
    expect(await store.get(key)).toBeNull();
  });

  test('rejects malformed profile rows without throwing', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    const saved = await cache.save(artifact(), []);
    saved.manifest.profiles = [null as unknown as TranslationProfileRow];
    await store.put(await translationCacheKey(identity()), saved);
    expect(await cache.load()).toBeNull();
    expect(await store.get(await translationCacheKey(identity()))).toBeNull();
  });

  test('does not leak entries between games or modules', async () => {
    const store = new MemoryTranslationCacheStore();
    const first = new PersistentTranslationCache(store, identity());
    const second = new PersistentTranslationCache(
      store,
      identity({ gameId: 'app:gamebox-' + '4'.repeat(64) }),
    );
    await first.save(artifact(), []);
    expect(await second.load()).toBeNull();
  });

  test('clears one module, one game, or the whole cache', async () => {
    const store = new MemoryTranslationCacheStore();
    const a = new PersistentTranslationCache(store, identity());
    const b = new PersistentTranslationCache(
      store,
      identity({ moduleId: 'gamebox-' + '7'.repeat(64) + '.wgb' }),
    );
    const c = new PersistentTranslationCache(
      store,
      identity({ gameId: 'app:gamebox-' + '8'.repeat(64) }),
    );
    await Promise.all([a.save(artifact(), []), b.save(artifact(), []), c.save(artifact(), [])]);
    expect(await a.invalidateModule(b.identity.moduleId)).toBe(1);
    expect((await a.statistics()).entries).toBe(2);
    expect(await a.invalidateGame(a.identity.gameId)).toBe(1);
    expect((await a.statistics()).entries).toBe(1);
    await store.clear();
    expect((await a.statistics()).entries).toBe(0);
  });
});

describe('persistent translation cache aggregate bounds', () => {
  test('replacement subtracts the existing key before admission', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    for (let index = 0; index < MAX_TRANSLATION_CACHE_ENTRIES - 1; index++)
      await store.put(`other-${index}`, await storedManifest({ moduleId: `module-${index}` }));

    await cache.save(artifact(), []);
    await cache.save(new Uint8Array(16).fill(0x42), []);

    const stats = await cache.statistics();
    expect(stats.entries).toBe(MAX_TRANSLATION_CACHE_ENTRIES);
    expect(stats.evictions).toBe(0);
    expect(stats.evictedBytes).toBe(0);
  });

  test('evicts the oldest entry and breaks timestamp ties by key', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    for (let index = 0; index < MAX_TRANSLATION_CACHE_ENTRIES - 2; index++)
      await store.put(
        `other-${index}`,
        await storedManifest({ moduleId: `module-${index}`, updatedAt: 20 }),
      );
    await store.put('z-tie', await storedManifest({ moduleId: 'z-tie', updatedAt: 10 }));
    await store.put('a-tie', await storedManifest({ moduleId: 'a-tie', updatedAt: 10 }));

    await cache.save(artifact(), []);

    expect(await store.get('a-tie')).toBeNull();
    expect(await store.get('z-tie')).not.toBeNull();
    const stats = await cache.statistics();
    expect(stats.entries).toBe(MAX_TRANSLATION_CACHE_ENTRIES);
    expect(stats.evictions).toBe(1);
    expect(stats.evictedEntries).toBe(1);
    expect(stats.evictedBytes).toBe(artifact().byteLength);
  });

  test('serializes concurrent instances and restores the aggregate entry bound', async () => {
    const store = new MemoryTranslationCacheStore();
    for (let index = 0; index < MAX_TRANSLATION_CACHE_ENTRIES - 1; index++)
      await store.put(`other-${index}`, await storedManifest({ moduleId: `module-${index}` }));
    const first = new PersistentTranslationCache(
      store,
      identity({ moduleId: 'gamebox-' + 'a'.repeat(64) + '.wgb' }),
    );
    const second = new PersistentTranslationCache(
      store,
      identity({ moduleId: 'gamebox-' + 'b'.repeat(64) + '.wgb' }),
    );

    await Promise.all([first.save(artifact(), []), second.save(artifact(), [])]);

    const stats = await first.statistics();
    expect(stats.entries).toBeLessThanOrEqual(MAX_TRANSLATION_CACHE_ENTRIES);
    expect(stats.bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  test('serializes clear behind an in-flight save', async () => {
    const store = new DelayedMemoryStore();
    const cache = new PersistentTranslationCache(store, identity());
    const save = cache.save(artifact(), []);
    await store.started;
    const clear = cache.clear();
    store.release();
    await save;
    await clear;
    expect(await store.get(await translationCacheKey(identity()))).toBeNull();
  });

  test('clear-all helper stays behind an in-flight save', async () => {
    const store = new DelayedMemoryStore();
    const cache = new PersistentTranslationCache(store, identity());
    const save = cache.save(artifact(), []);
    await store.started;
    const clear = clearTranslationCacheStore(store);
    store.release();
    await save;
    expect(await clear).toBe(1);
    expect(await cache.load()).toBeNull();
  });

  test('preserves an existing key when listing fails before put', async () => {
    const store = new FailingListStore();
    const cache = new PersistentTranslationCache(store, identity());
    await cache.save(artifact(), []);
    store.failNextList = true;
    await expect(cache.save(new Uint8Array(16).fill(0x42), [])).rejects.toThrow(
      'synthetic list failure',
    );
    expect(await cache.load()).not.toBeNull();
  });

  test('rejects an artifact larger than the per-entry budget before writing', async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(store, identity());
    await expect(
      cache.save(new Uint8Array(MAX_TRANSLATION_ARTIFACT_BYTES + 1), []),
    ).rejects.toThrow('Translation artifact exceeds its byte budget');
    expect(await store.list()).toHaveLength(0);
  });
});

describe('OPFS translation cache maintenance', () => {
  test('removes orphaned, malformed, and corrupt directories while listing', async () => {
    const source = new MemoryTranslationCacheStore();
    const cache = new PersistentTranslationCache(source, identity());
    const saved = await cache.save(artifact(), []);
    const key = await translationCacheKey(identity());
    const root = new FakeOpfsDirectory();
    root.addDirectory(key, JSON.stringify(saved.manifest), saved.artifact);
    root.addDirectory('orphan');
    root.addDirectory('malformed', '{not-json', saved.artifact);
    root.addDirectory('truncated', JSON.stringify(saved.manifest), saved.artifact.slice(0, 7));
    root.addDirectory(
      'oversized',
      JSON.stringify({ ...saved.manifest, artifactBytes: MAX_TRANSLATION_ARTIFACT_BYTES + 1 }),
      saved.artifact,
    );

    const store = new OpfsTranslationCacheStore(root as unknown as FileSystemDirectoryHandle);
    expect(await store.list()).toHaveLength(1);
    const validDirectory = root.children.get(key) as FakeOpfsDirectory;
    const validArtifact = validDirectory.children.get('artifact.bin') as FakeOpfsFile;
    expect(validArtifact.streamReads).toBe(0);
    expect(root.children.has(key)).toBe(true);
    expect(root.children.has('orphan')).toBe(false);
    expect(root.children.has('malformed')).toBe(false);
    expect(root.children.has('truncated')).toBe(false);
    expect(root.children.has('oversized')).toBe(false);

    const corrupt = saved.artifact.slice();
    corrupt[0] ^= 0xff;
    validArtifact.replace(corrupt);
    expect(await store.list()).toHaveLength(1);
    expect(validArtifact.streamReads).toBe(0);
    const opfsCache = new PersistentTranslationCache(store, identity());
    expect(await opfsCache.load()).toBeNull();
    expect(validArtifact.streamReads).toBe(1);
    expect(root.children.has(key)).toBe(false);
  });
});

test('profile merge accumulates counters and keeps the execution time range', () => {
  const [merged] = mergeTranslationProfiles(
    [profile()],
    [
      profile({
        executions: 20,
        cacheHits: 1,
        translations: 0,
        firstExecutionAt: 500,
        lastExecutionAt: 3000,
      }),
    ],
  );
  expect(merged).toMatchObject({
    executions: 30,
    cacheHits: 1,
    translations: 1,
    translationUs: 240,
    wasmCompileUs: 160,
    wasmInstantiateUs: 20,
    firstExecutionAt: 500,
    lastExecutionAt: 3000,
  });
});
