import { describe, expect, test } from 'bun:test';
import {
  MemoryTranslationCacheStore,
  PersistentTranslationCache,
  TRANSLATION_ABI_VERSION,
  mergeTranslationProfiles,
  translationCacheKey,
  type TranslationCacheIdentity,
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
