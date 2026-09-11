import { System } from './system';
import {
  PersistentTranslationCache,
  TRANSLATION_ABI_VERSION,
  mergeTranslationProfiles,
  openTranslationCacheStore,
  type TranslationCacheEntry,
  type TranslationProfileRow,
} from './translation-cache';
declare const __GAMEBOX_AOT_ABI__: string;
const LIMIT = 32 * 1024 * 1024;
let persistentCache: PersistentTranslationCache | null = null;
let previousPersistentEntry: TranslationCacheEntry | null = null;
let profileTimer: ReturnType<typeof setInterval> | null = null;
let persistentWriteDisabled = false;
const persistentMetrics = {
  cacheLoadMs: 0,
  cacheWriteMs: 0,
  persistentHits: 0,
  persistentMisses: 0,
  persistentInvalidations: 0,
};
interface AotExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  aot_stat(index: number): number;
  aot_capture_start(): void;
  aot_capture_finish(): number;
  aot_buffer_ptr(): number;
  aot_buffer_alloc(length: number): number;
  aot_buffer_commit(): number;
  aot_profile_snapshot(now: number): number;
  aot_profile_region(index: number): number;
  aot_profile_state_flags(index: number): number;
  aot_profile_executions(index: number): number;
  aot_profile_cache_hits(index: number): number;
  aot_profile_translations(index: number): number;
  aot_profile_translation_us(index: number): number;
  aot_profile_compile_us(index: number): number;
  aot_profile_instantiate_us(index: number): number;
  aot_profile_first_execution_at(index: number): number;
  aot_profile_last_execution_at(index: number): number;
}
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
async function bounded(url: URL, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('AOT artifact unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('AOT artifact exceeds its byte budget');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function exports(): AotExports | undefined {
  const v86 = System.getInstance().process?.v86 as
    { cpu?: unknown; v86?: { cpu?: unknown } } | undefined;
  const cpu = v86?.cpu || v86?.v86?.cpu;
  return (cpu as { wm?: { exports?: AotExports } } | undefined)?.wm?.exports;
}

function validatePackage(bytes: Uint8Array<ArrayBuffer>): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8) throw new Error('Invalid AOT package header');
  const count = view.getUint32(4, true);
  if (view.getUint32(0, true) !== 0x31544f41 || count < 1 || count > 2048)
    throw new Error('Invalid AOT package header');
  let offset = 8;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.length) throw new Error('Truncated AOT package');
    const length = view.getUint32(offset, true);
    offset += 4;
    const end = offset + length;
    if (length < 132 || length > 1024 * 1024 || end > bytes.length)
      throw new Error('Invalid AOT unit size');
    const pages = view.getUint32(offset + 120, true);
    const mappings = view.getUint32(offset + 124, true);
    const entries = view.getUint32(offset + 128, true);
    const reloc = offset + 132 + pages * 4100 + mappings * 8 + entries * 8;
    if (reloc + 4 > end) throw new Error('Invalid AOT unit metadata');
    const start = reloc + 4 + view.getUint32(reloc, true) * 4;
    if (start >= end || !WebAssembly.validate(bytes.subarray(start, end)))
      throw new Error('This browser cannot execute the AOT package');
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('Trailing AOT package data');
}

function loadPackage(e: AotExports, bytes: Uint8Array<ArrayBuffer>): void {
  validatePackage(bytes);
  const ptr = e.aot_buffer_alloc(bytes.length);
  if (!ptr) throw new Error('AOT allocation failed');
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
  if (!e.aot_buffer_commit()) throw new Error('Invalid AOT artifact');
}

function readProfiles(e: AotExports): TranslationProfileRow[] {
  const count = e.aot_profile_snapshot?.(Date.now()) ?? 0;
  const rows: TranslationProfileRow[] = [];
  for (let i = 0; i < count; i++)
    rows.push({
      region: e.aot_profile_region(i) >>> 0,
      stateFlags: e.aot_profile_state_flags(i) >>> 0,
      executions: Number(e.aot_profile_executions(i)),
      cacheHits: Number(e.aot_profile_cache_hits(i)),
      translations: Number(e.aot_profile_translations(i)),
      translationUs: Number(e.aot_profile_translation_us(i)),
      wasmCompileUs: Number(e.aot_profile_compile_us(i)),
      wasmInstantiateUs: Number(e.aot_profile_instantiate_us(i)),
      firstExecutionAt: Number(e.aot_profile_first_execution_at(i)),
      lastExecutionAt: Number(e.aot_profile_last_execution_at(i)),
    });
  return rows;
}

async function persistentStart(e: AotExports) {
  const globals = globalThis as typeof globalThis & {
    __gameboxGameId?: string;
    __gameboxCacheKey?: string;
    __disablePersistentTranslationCache?: boolean;
  };
  if (globals.__disablePersistentTranslationCache) return { enabled: false, reason: 'disabled' };
  if (!globals.__gameboxGameId || !globals.__gameboxCacheKey)
    throw new Error('Persistent translation cache requires a configured GameBox identity');
  const startedAt = performance.now();
  const store = await openTranslationCacheStore();
  persistentCache = new PersistentTranslationCache(store, {
    gameId: globals.__gameboxGameId,
    moduleId: globals.__gameboxCacheKey,
    translatorVersion: __GAMEBOX_AOT_ABI__,
    abiVersion: TRANSLATION_ABI_VERSION,
  });
  persistentWriteDisabled = false;
  try {
    previousPersistentEntry = await persistentCache.load();
    if (previousPersistentEntry) {
      try {
        loadPackage(e, previousPersistentEntry.artifact);
        persistentMetrics.persistentHits++;
      } catch {
        persistentMetrics.persistentInvalidations++;
        await persistentCache.delete().catch(() => {});
        previousPersistentEntry = null;
      }
    } else persistentMetrics.persistentMisses++;
  } finally {
    persistentMetrics.cacheLoadMs += performance.now() - startedAt;
  }
  e.aot_capture_start();
  profileTimer = setInterval(() => e.aot_profile_snapshot?.(Date.now()), 5000);
  return {
    enabled: true,
    backend: store.backend,
    loaded: previousPersistentEntry !== null,
    bytes: previousPersistentEntry?.artifact.byteLength ?? 0,
  };
}

export async function finishPersistentTranslationCache(): Promise<void> {
  if (profileTimer !== null) {
    clearInterval(profileTimer);
    profileTimer = null;
  }
  if (!persistentCache || persistentWriteDisabled) return;
  const e = exports();
  if (!e?.aot_capture_finish) return;
  const profiles = readProfiles(e);
  const length = e.aot_capture_finish();
  if (length < 8 || length > LIMIT) return;
  const artifact = new Uint8Array(e.memory.buffer, e.aot_buffer_ptr(), length).slice();
  // An empty capture is not a reusable package. Preserve an earlier valid cache
  // if one exists; otherwise leave storage empty.
  if (new DataView(artifact.buffer).getUint32(4, true) === 0) return;
  validatePackage(artifact);
  const startedAt = performance.now();
  await persistentCache.save(artifact, profiles, previousPersistentEntry);
  persistentMetrics.cacheWriteMs += performance.now() - startedAt;
}

async function persistentOperation(
  mode: string,
  message: { gameId?: string; moduleId?: string; entry?: TranslationCacheEntry },
) {
  if (!persistentCache && mode !== 'persistent-clear-all') {
    const globals = globalThis as typeof globalThis & {
      __gameboxGameId?: string;
      __gameboxCacheKey?: string;
    };
    if (!globals.__gameboxGameId || !globals.__gameboxCacheKey)
      throw new Error('Persistent translation cache is not configured');
    persistentCache = new PersistentTranslationCache(await openTranslationCacheStore(), {
      gameId: globals.__gameboxGameId,
      moduleId: globals.__gameboxCacheKey,
      translatorVersion: __GAMEBOX_AOT_ABI__,
      abiVersion: TRANSLATION_ABI_VERSION,
    });
  }
  if (mode === 'persistent-stats')
    return { ...(await persistentCache!.statistics()), ...persistentMetrics };
  if (mode === 'persistent-report') {
    const current = exports();
    const entry = await persistentCache!.load();
    const rows = mergeTranslationProfiles(
      entry?.manifest.profiles ?? [],
      current?.aot_profile_snapshot ? readProfiles(current) : [],
    );
    const top = rows.sort((a, b) => b.executions - a.executions).slice(0, 20);
    const header = 'RVA/EIP     executions  cache_hits  translate_ms  wasm_compile_ms';
    const text = [
      header,
      ...top.map(
        (row) =>
          `0x${row.region.toString(16).padStart(8, '0')}  ${String(row.executions).padStart(10)}  ` +
          `${String(row.cacheHits).padStart(10)}  ${(row.translationUs / 1000).toFixed(3).padStart(12)}  ` +
          `${(row.wasmCompileUs / 1000).toFixed(3).padStart(15)}`,
      ),
    ].join('\n');
    console.info(`Top translated regions\n${text}`);
    return { text, rows: top };
  }
  if (mode === 'persistent-clear') {
    await persistentCache!.delete();
    persistentWriteDisabled = true;
    previousPersistentEntry = null;
    return { cleared: 1 };
  }
  if (mode === 'persistent-clear-game') {
    const gameId = message.gameId ?? persistentCache!.identity.gameId;
    const cleared = await persistentCache!.invalidateGame(gameId);
    if (gameId === persistentCache!.identity.gameId) {
      persistentWriteDisabled = true;
      previousPersistentEntry = null;
    }
    return { cleared };
  }
  if (mode === 'persistent-clear-module') {
    const moduleId = message.moduleId ?? persistentCache!.identity.moduleId;
    const cleared = await persistentCache!.invalidateModule(moduleId);
    if (moduleId === persistentCache!.identity.moduleId) {
      persistentWriteDisabled = true;
      previousPersistentEntry = null;
    }
    return { cleared };
  }
  if (mode === 'persistent-clear-all') {
    const store = persistentCache?.store ?? (await openTranslationCacheStore());
    const count = (await store.list()).length;
    await store.clear();
    persistentWriteDisabled = true;
    previousPersistentEntry = null;
    return { cleared: count };
  }
  if (mode === 'persistent-export') return persistentCache!.load();
  if (mode === 'persistent-import') {
    const entry = message.entry;
    if (
      !entry ||
      entry.manifest.gameId !== persistentCache!.identity.gameId ||
      entry.manifest.moduleId !== persistentCache!.identity.moduleId ||
      entry.manifest.translatorVersion !== __GAMEBOX_AOT_ABI__ ||
      entry.manifest.abiVersion !== TRANSLATION_ABI_VERSION
    )
      throw new Error('Imported translation cache identity is incompatible');
    validatePackage(entry.artifact);
    await persistentCache!.save(entry.artifact, entry.manifest.profiles);
    persistentWriteDisabled = false;
    return { imported: 1, bytes: entry.artifact.byteLength };
  }
  throw new Error('Unknown persistent cache operation');
}

export async function gameboxAot(message: {
  mode: string;
  url?: string;
  gameId?: string;
  moduleId?: string;
  entry?: TranslationCacheEntry;
}) {
  const e = exports();
  if (!e?.aot_stat) throw new Error('This runtime has no AOT support');
  if (message.mode.startsWith('persistent-')) {
    if (message.mode === 'persistent-start') return persistentStart(e);
    return persistentOperation(message.mode, message);
  }
  if (message.mode === 'capture') {
    e.aot_capture_start();
    return { abi: __GAMEBOX_AOT_ABI__ };
  }
  if (message.mode === 'finish') {
    const length = e.aot_capture_finish();
    const bytes = new Uint8Array(e.memory.buffer, e.aot_buffer_ptr(), length).slice();
    return { abi: __GAMEBOX_AOT_ABI__, bytes };
  }
  if (message.mode === 'load') {
    const url = new URL(message.url!);
    if (
      url.origin !== location.origin ||
      !/^\/assets\/[^/]+\/[^/]+\/aot\.json$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid GameBox AOT manifest URL');
    const manifest = JSON.parse(new TextDecoder().decode(await bounded(url, 4096)));
    if (
      manifest.format !== 'gamebox-v86-aot-1' ||
      manifest.abi !== __GAMEBOX_AOT_ABI__ ||
      manifest.file !== 'aot.bin' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes < 8 ||
      manifest.bytes > LIMIT
    )
      throw new Error('AOT manifest does not match this runtime');
    const bytes = await bounded(new URL(manifest.file, url), manifest.bytes);
    if (bytes.length !== manifest.bytes || (await digest(bytes)) !== manifest.sha256)
      throw new Error('AOT artifact integrity check failed');
    loadPackage(e, bytes);
  } else if (message.mode !== 'stats') throw new Error('Unknown AOT operation');
  return {
    ...Object.fromEntries(
      [
        'hits',
        'fallbackCompilations',
        'mismatches',
        'units',
        'bytes',
        'capDrops',
        'translationUs',
        'wasmCompileUs',
        'wasmInstantiateUs',
        'validationUs',
        'translationsGenerated',
        'guestCodeInvalidations',
      ].map((name, i) => [name, Number(e.aot_stat(i))]),
    ),
    persistent: persistentCache
      ? { ...(await persistentCache.statistics()), ...persistentMetrics }
      : null,
  };
}
