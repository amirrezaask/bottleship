// Opt-in profile capture at paused CPU boundaries. No guest execution is driven here.
const sessions = new WeakMap();
const SHA = /^[a-f0-9]{64}$/;
const U64 = (1n << 64n) - 1n;
const limits = {
  blocks: 8192,
  functions: 8192,
  edges: 16384,
  indirects: 8192,
  translations: 8192,
};

function checkedCount(value) {
  if (typeof value !== 'bigint' || value < 0n || value > U64)
    throw new Error('Runtime must expose exact unsigned 64-bit profile counters');
  return value;
}

function config(exports) {
  return Array.from({ length: 22 }, (_, i) => exports.get_jit_config(i) >>> 0);
}

async function pageHash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function translationSnapshot(exports) {
  const count = exports.aot_profile_snapshot(Date.now());
  if (count > limits.translations) throw new Error('Runtime translation table exceeds budget');
  const rows = new Map();
  const fields = {
    translations: 'translations',
    cacheHits: 'cache_hits',
    translationUs: 'translation_us',
    wasmCompileUs: 'compile_us',
    wasmInstantiateUs: 'instantiate_us',
  };
  for (let i = 0; i < count; i++) {
    const address = exports.aot_profile_region(i) >>> 0;
    const row =
      rows.get(address) ?? Object.fromEntries(Object.keys(fields).map((key) => [key, 0n]));
    for (const [key, getter] of Object.entries(fields)) {
      row[key] += checkedCount(exports[`aot_profile_${getter}_u64`](i));
      if (row[key] > U64) throw new Error('Translation counter overflow');
    }
    rows.set(address, row);
  }
  return rows;
}

function validateOptions(cpu, options) {
  for (const key of ['gameContentHash', 'runtimeWasmSha256', 'runtimeJavascriptSha256'])
    if (!SHA.test(options[key])) throw new Error(`Invalid profile identity: ${key}`);
  if (
    typeof options.scenario !== 'string' ||
    !options.scenario.length ||
    new TextEncoder().encode(options.scenario).length > 256
  )
    throw new Error('Invalid profile scenario');
  if (!options.isPaused?.())
    throw new Error('Pause the CPU before starting or finishing a profile');
  const pagingEnabled = Boolean(cpu.cr?.[0] & 0x80000000);
  if (!Array.isArray(options.pages) || !options.pages.length || options.pages.length > 64)
    throw new Error('Choose between 1 and 64 virtual code pages');
  const pages = [...options.pages].sort((a, b) => a - b);
  const addressSpaceBytes = pagingEnabled ? 0x1_0000_0000 : cpu.mem8.length;
  for (let i = 0; i < pages.length; i++)
    if (
      !Number.isInteger(pages[i]) ||
      pages[i] < 0 ||
      pages[i] > 0xfffff000 ||
      pages[i] % 4096 ||
      pages[i] + 4096 > addressSpaceBytes ||
      pages[i] === pages[i - 1]
    )
      throw new Error('Invalid or duplicate watched page');
  if (!Array.isArray(options.modules) || options.modules.length > 4096)
    throw new Error('Module table exceeds budget');
  const modules = options.modules.map((module) => ({ ...module })).sort((a, b) => a.base - b.base);
  const hashes = new Set();
  for (let i = 0; i < modules.length; i++) {
    const module = modules[i];
    if (
      !SHA.test(module.sourceSha256) ||
      hashes.has(module.sourceSha256) ||
      !Number.isInteger(module.base) ||
      module.base < 0 ||
      module.base > 0xffffffff ||
      !Number.isInteger(module.size) ||
      module.size < 1 ||
      module.base + module.size > addressSpaceBytes ||
      (i && modules[i - 1].base + modules[i - 1].size > module.base)
    )
      throw new Error('Invalid, duplicate or overlapping profile module');
    hashes.add(module.sourceSha256);
  }
  return { pages, modules, pagingEnabled };
}

/** Caller supplies independently verified identities and pauses the CPU at both boundaries. */
export async function startCpuProfile(cpu, options) {
  options = { ...options };
  const { pages, modules, pagingEnabled } = validateOptions(cpu, options);
  const exports = cpu.wm.exports;
  if (sessions.has(cpu) || exports.trace2_enabled() || options.calls?.isRunning?.())
    throw new Error('A CPU profile is already active');
  const required = [
    'trace2_block_exec_u64',
    'trace2_function_snapshot',
    'trace2_function_addr',
    'trace2_function_exec_u64',
    'trace2_function_overflow_u64',
    'trace2_edge_snapshot',
    'trace2_edge_count_u64',
    'trace2_indirect_hits_u64',
    'trace2_watched_page_invalidations',
    'aot_profile_overflow',
    'aot_profile_translations_u64',
    'aot_profile_cache_hits_u64',
    'aot_profile_translation_us_u64',
    'aot_profile_compile_us_u64',
    'aot_profile_instantiate_us_u64',
    'trace2_counter_overflow',
    'trace2_slot_overflow_u64',
    'trace2_edge_overflow_u64',
    'trace2_indirect_overflow_u64',
  ];
  for (const name of required)
    if (typeof exports[name] !== 'function') throw new Error(`Missing profiling export: ${name}`);
  const observationExports = [
    'trace2_watch_virtual_page',
    'trace2_page_observation_snapshot',
    'trace2_page_observation_virtual',
    'trace2_page_observation_physical',
    'trace2_page_observation_generation',
    'trace2_page_observation_generation_overflow',
  ];
  const observesVirtualPages = observationExports.every(
    (name) => typeof exports[name] === 'function',
  );
  if (pagingEnabled && !observesVirtualPages)
    throw new Error('Paging profile requires virtual-page observation exports');
  const owner = {};
  sessions.set(cpu, owner);
  let active = false;
  let callsStarted = false;
  try {
    if (!options.isPaused()) throw new Error('CPU resumed while preparing the profile');
    exports.trace2_reset();
    const jitConfig = config(exports);
    const beforeTranslations = translationSnapshot(exports);
    const beforeDroppedTranslations = checkedCount(exports.aot_profile_overflow());
    for (const page of pages) {
      const watched = observesVirtualPages
        ? exports.trace2_watch_virtual_page(page)
        : exports.trace2_watch_page(page);
      if (watched !== 1) throw new Error('Runtime rejected a watched page');
    }
    const watchedPages = [];
    const physicalToVirtual = new Map();
    if (observesVirtualPages) {
      const count = exports.trace2_page_observation_snapshot();
      if (count !== pages.length) throw new Error('Runtime virtual-page observation count mismatch');
      for (let i = 0; i < count; i++) {
        const address = exports.trace2_page_observation_virtual(i) >>> 0;
        const physicalAddress = exports.trace2_page_observation_physical(i) >>> 0;
        if (
          physicalAddress % 4096 !== 0 ||
          physicalAddress + 4096 > cpu.mem8.length ||
          !pages.includes(address) ||
          physicalToVirtual.has(physicalAddress)
        )
          throw new Error('Runtime returned an invalid watched page mapping');
        physicalToVirtual.set(physicalAddress, address);
        watchedPages.push({
          address,
          physicalAddress,
          sha256: await pageHash(cpu.mem8.slice(physicalAddress, physicalAddress + 4096)),
        });
      }
    } else {
      for (const address of pages)
        watchedPages.push({
          address,
          physicalAddress: address,
          sha256: await pageHash(cpu.mem8.slice(address, address + 4096)),
        });
      for (const page of watchedPages) physicalToVirtual.set(page.physicalAddress, page.address);
    }
    options.calls?.start();
    callsStarted = Boolean(options.calls);
    active = true;
    const started = performance.now();
    const addressOf = (address) => {
      const module = modules.find(
        (module) => address >= module.base && address < module.base + module.size,
      );
      return module
        ? { kind: 'module', sha256: module.sourceSha256, rva: address - module.base }
        : { kind: 'dynamic', address };
    };
    // trace2 block/function/direct-edge records use physical JIT addresses.
    // Indirect targets remain virtual guest addresses and use addressOf directly.
    const addressOfPhysical = (address) => {
      const virtualPage = physicalToVirtual.get(address & 0xfffff000);
      return addressOf(
        virtualPage === undefined ? address : (virtualPage + (address & 0xfff)) >>> 0,
      );
    };
    function close() {
      try {
        if (active) exports.trace2_unwatch_all();
      } finally {
        active = false;
        if (callsStarted) {
          options.calls?.stop();
          callsStarted = false;
        }
        if (sessions.get(cpu) === owner) sessions.delete(cpu);
      }
    }
    return {
      isActive() {
        return active;
      },
      cancel() {
        if (active) {
          close();
          exports.trace2_reset();
        }
      },
      async finish() {
        if (!active) throw new Error('Profile session has already ended');
        if (!options.isPaused()) throw new Error('Pause the CPU before finishing a profile');
        const durationMs = Math.round(performance.now() - started);
        try {
          if (
            durationMs > 86400000 ||
            JSON.stringify(config(exports)) !== JSON.stringify(jitConfig)
          )
            throw new Error(
              'Profile duration or JIT configuration changed beyond the capture contract',
            );
          if (!exports.trace2_enabled() || exports.trace2_watched_page_count() !== pages.length)
            throw new Error('Native profile recording was reset during capture');
          const droppedTranslations =
            checkedCount(exports.aot_profile_overflow()) - beforeDroppedTranslations;
          if (droppedTranslations < 0n)
            throw new Error('Translation counters were reset during capture');
          const coverage = {
            jitOnly: true,
            nativeWin32Observed: false,
            wasmMemoryBytes: String(exports.memory.buffer.byteLength),
            guestMemoryBytes: String(cpu.mem8.byteLength),
            counterOverflow: {
              blocks: Boolean(exports.trace2_counter_overflow() & 1),
              functions: Boolean(exports.trace2_counter_overflow() & 8),
              edges: Boolean(exports.trace2_counter_overflow() & 2),
              indirects: Boolean(exports.trace2_counter_overflow() & 4),
              win32: false,
              translations: false,
            },
            droppedBlocks: checkedCount(exports.trace2_slot_overflow_u64()).toString(),
            droppedFunctions: checkedCount(exports.trace2_function_overflow_u64()).toString(),
            droppedEdges: checkedCount(exports.trace2_edge_overflow_u64()).toString(),
            droppedIndirects: checkedCount(exports.trace2_indirect_overflow_u64()).toString(),
            droppedWin32: '0',
            droppedTranslations: droppedTranslations.toString(),
            watchedPageInvalidations: checkedCount(
              exports.trace2_watched_page_invalidations(),
            ).toString(),
          };
          const blocks = [],
            functions = [],
            edges = [],
            indirects = [],
            translations = [];
          let count = exports.trace2_block_snapshot();
          if (count > limits.blocks) throw new Error('Runtime block table exceeds budget');
          for (let i = 0; i < count; i++) {
            const hits = checkedCount(exports.trace2_block_exec_u64(i));
            if (hits)
              blocks.push({
                address: addressOfPhysical(exports.trace2_block_addr(i) >>> 0),
                count: hits.toString(),
              });
          }
          count = exports.trace2_function_snapshot();
          if (count > limits.functions) throw new Error('Runtime function table exceeds budget');
          for (let i = 0; i < count; i++) {
            const hits = checkedCount(exports.trace2_function_exec_u64(i));
            if (hits)
              functions.push({
                address: addressOfPhysical(exports.trace2_function_addr(i) >>> 0),
                count: hits.toString(),
              });
          }
          for (const [prefix, output, limit, getter] of [
            ['edge', edges, limits.edges, 'count'],
            ['indirect', indirects, limits.indirects, 'hits'],
          ]) {
            count = exports[`trace2_${prefix}_snapshot`]();
            if (count > limit) throw new Error('Runtime edge table exceeds budget');
            for (let i = 0; i < count; i++) {
              const hits = checkedCount(exports[`trace2_${prefix}_${getter}_u64`](i));
              if (hits)
                output.push({
                  from: addressOfPhysical(exports[`trace2_${prefix}_from`](i) >>> 0),
                  to:
                    prefix === 'indirect'
                      ? addressOf(exports[`trace2_${prefix}_target`](i) >>> 0)
                      : addressOfPhysical(exports[`trace2_${prefix}_target`](i) >>> 0),
                  count: hits.toString(),
                });
            }
          }
          for (const [address, row] of translationSnapshot(exports)) {
            const previous = beforeTranslations.get(address);
            const delta = {};
            for (const [field, value] of Object.entries(row)) {
              if (value === U64) coverage.counterOverflow.translations = true;
              const difference = value - (previous?.[field] ?? 0n);
              if (difference < 0n)
                throw new Error('Translation counters were reset during capture');
              delta[field] = difference.toString();
            }
            if (Object.values(delta).some((value) => value !== '0'))
              translations.push({ address: addressOf(address), ...delta });
          }
          const calls = options.calls?.snapshot() ?? { rows: [], dropped: '0' };
          coverage.droppedWin32 = calls.dropped;
          coverage.counterOverflow.win32 = (calls.counterOverflow ?? '0') !== '0';
          const finalObservations = new Map();
          if (observesVirtualPages) {
            if (exports.trace2_page_observation_generation_overflow())
              throw new Error('Runtime virtual-page generation token overflowed');
            const count = exports.trace2_page_observation_snapshot();
            if (count !== watchedPages.length)
              throw new Error('Runtime virtual-page observation count changed at finish');
            for (let i = 0; i < count; i++) {
              const virtualAddress = exports.trace2_page_observation_virtual(i) >>> 0;
              const physicalAddress = exports.trace2_page_observation_physical(i) >>> 0;
              if (physicalAddress % 4096 !== 0 || physicalAddress + 4096 > cpu.mem8.length)
                throw new Error('Runtime returned an invalid final page mapping');
              finalObservations.set(virtualAddress, {
                physicalAddress,
                generation: checkedCount(
                  exports.trace2_page_observation_generation(i),
                ).toString(),
              });
            }
            for (const page of watchedPages) {
              const final = finalObservations.get(page.address);
              if (!final || final.physicalAddress !== page.physicalAddress)
                throw new Error('Virtual page mapping changed during profile capture');
            }
          }
          const finalPages = watchedPages.map(({ physicalAddress }) =>
            cpu.mem8.slice(physicalAddress, physicalAddress + 4096),
          );
          const memoryObservation = observesVirtualPages
            ? {
                memoryBytes: String(cpu.mem8.byteLength),
                pagingEnabled,
                generationOverflow: Boolean(exports.trace2_page_observation_generation_overflow()),
                pages: await Promise.all(
                  watchedPages.map(async ({ address, physicalAddress }, index) => ({
                    virtualAddress: address,
                    physicalAddress,
                    generation: finalObservations.get(address)?.generation ?? '0',
                    sha256: await pageHash(finalPages[index]),
                    bytes: Array.from(finalPages[index]),
                  })),
                ),
              }
            : null;
          close();
          for (let i = 0; i < watchedPages.length; i++)
            if (
              (await pageHash(finalPages[i])) !== watchedPages[i].sha256 &&
              coverage.watchedPageInvalidations === '0'
            )
              coverage.watchedPageInvalidations = '1';
          return {
            version: 4,
            gameContentHash: options.gameContentHash,
            runtimeWasmSha256: options.runtimeWasmSha256,
            runtimeJavascriptSha256: options.runtimeJavascriptSha256,
            scenario: options.scenario,
            durationMs,
            modules,
            watchedPages: watchedPages.map(({ address, sha256 }) => ({ address, sha256 })),
            jitConfig,
            blocks,
            functions,
            edges,
            indirects,
            translations,
            win32: calls.rows,
            coverage,
            memoryObservation,
            caveats: [
              'Only JIT executions on watched physical pages are counted; interpreter warmup is excluded.',
              'Direct edges include resolved compiled successors; indirect rows include observed absolute-EIP terminals.',
              'Win32 rows cover the JS dispatcher only; nativeCrossings separately reports bounded native hypercall and write-buffer counts, but does not provide crossing timing.',
              'Translation timings include completed callbacks at the capture boundary; pending costs are excluded.',
              'Watched-page invalidations conservatively mark potentially mixed code versions.',
              'Function counts are observed guest CALL targets; they are not sums of basic-block counts.',
            ],
          };
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    exports.trace2_reset();
    if (callsStarted) options.calls?.stop();
    if (sessions.get(cpu) === owner) sessions.delete(cpu);
    throw error;
  }
}
