import assert from 'node:assert/strict';
import test from 'node:test';
import { startCpuProfile } from '../../src/worker/core/gamebox-cpu-profile.mjs';

function pagingFixture(remap = false, withRows = false) {
  let enabled = false;
  let physicalReads = 0;
  const observations = [{ virtual: 0xf0001000, physical: 0x3000, generation: 9n }];
  const exports = {
    memory: { buffer: new ArrayBuffer(0x4000) },
    get_jit_config: () => 0,
    trace2_enabled: () => Number(enabled),
    trace2_reset: () => {
      enabled = false;
    },
    trace2_watch_virtual_page: () => {
      enabled = true;
      return 1;
    },
    trace2_watch_page: () => 0,
    trace2_unwatch_all: () => {
      enabled = false;
    },
    trace2_watched_page_count: () => observations.length,
    trace2_page_observation_snapshot: () => observations.length,
    trace2_page_observation_virtual: (i) => observations[i].virtual,
    trace2_page_observation_physical: (i) => {
      physicalReads++;
      return remap && physicalReads > 1 ? 0x4000 : observations[i].physical;
    },
    trace2_page_observation_generation: (i) => observations[i].generation,
    trace2_page_observation_generation_overflow: () => 0,
    trace2_block_snapshot: () => 0,
    trace2_function_snapshot: () => 0,
    trace2_edge_snapshot: () => 0,
    trace2_indirect_snapshot: () => 0,
    trace2_counter_overflow: () => 0,
    trace2_slot_overflow_u64: () => 0n,
    trace2_function_overflow_u64: () => 0n,
    trace2_edge_overflow_u64: () => 0n,
    trace2_indirect_overflow_u64: () => 0n,
    trace2_watched_page_invalidations: () => 0n,
    aot_profile_snapshot: () => 0,
    aot_profile_overflow: () => 0n,
  };
  for (const name of [
    'trace2_block_exec_u64',
    'trace2_block_addr',
    'trace2_function_addr',
    'trace2_function_exec_u64',
    'trace2_edge_from',
    'trace2_edge_target',
    'trace2_edge_count_u64',
    'trace2_indirect_from',
    'trace2_indirect_target',
    'trace2_indirect_hits_u64',
    'aot_profile_translations_u64',
    'aot_profile_cache_hits_u64',
    'aot_profile_translation_us_u64',
    'aot_profile_compile_us_u64',
    'aot_profile_instantiate_us_u64',
  ])
    exports[name] = () => 0n;
  if (withRows) {
    exports.trace2_block_snapshot = () => 1;
    exports.trace2_block_exec_u64 = () => 3n;
    exports.trace2_block_addr = () => 0x3004;
    exports.trace2_function_snapshot = () => 1;
    exports.trace2_function_exec_u64 = () => 2n;
    exports.trace2_function_addr = () => 0x3004;
    exports.trace2_edge_snapshot = () => 1;
    exports.trace2_edge_count_u64 = () => 4n;
    exports.trace2_edge_from = () => 0x3004;
    exports.trace2_edge_target = () => 0x3008;
    exports.trace2_indirect_snapshot = () => 1;
    exports.trace2_indirect_hits_u64 = () => 5n;
    exports.trace2_indirect_from = () => 0x3004;
    exports.trace2_indirect_target = () => 0xf0001008;
  }
  const cpu = {
    cr: new Uint32Array([0x80000000]),
    mem8: new Uint8Array(exports.memory.buffer),
    wm: { exports },
  };
  cpu.mem8.fill(7, 0x3000, 0x5000);
  return cpu;
}

test('captures a non-identity virtual-to-physical paging observation in schema 4', async () => {
  const cpu = pagingFixture();
  const session = await startCpuProfile(cpu, {
    gameContentHash: 'a'.repeat(64),
    runtimeWasmSha256: 'b'.repeat(64),
    runtimeJavascriptSha256: 'c'.repeat(64),
    scenario: 'paging-fixture',
    modules: [],
    pages: [0xf0001000],
    isPaused: () => true,
  });
  const profile = await session.finish();
  assert.equal(profile.version, 4);
  assert.equal(profile.memoryObservation.pagingEnabled, true);
  assert.equal(profile.memoryObservation.pages[0].virtualAddress, 0xf0001000);
  assert.equal(profile.memoryObservation.pages[0].physicalAddress, 0x3000);
  assert.equal(profile.memoryObservation.pages[0].generation, '9');
  assert.equal(profile.memoryObservation.pages[0].bytes.length, 4096);
});

test('rejects a virtual-page remap at the profile finish boundary', async () => {
  const session = await startCpuProfile(pagingFixture(true), {
    gameContentHash: 'a'.repeat(64),
    runtimeWasmSha256: 'b'.repeat(64),
    runtimeJavascriptSha256: 'c'.repeat(64),
    scenario: 'paging-remap-fixture',
    modules: [],
    pages: [0xf0001000],
    isPaused: () => true,
  });
  await assert.rejects(session.finish(), /mapping changed|invalid final page mapping/);
});

test('attributes physical trace rows through the captured mapping while keeping indirect targets virtual', async () => {
  const session = await startCpuProfile(pagingFixture(false, true), {
    gameContentHash: 'a'.repeat(64),
    runtimeWasmSha256: 'b'.repeat(64),
    runtimeJavascriptSha256: 'c'.repeat(64),
    scenario: 'paging-attribution-fixture',
    modules: [{ sourceSha256: 'd'.repeat(64), base: 0xf0001000, size: 0x1000 }],
    pages: [0xf0001000],
    isPaused: () => true,
  });
  const profile = await session.finish();
  assert.equal(profile.blocks[0].address.rva, 4);
  assert.equal(profile.functions[0].address.rva, 4);
  assert.equal(profile.edges[0].from.rva, 4);
  assert.equal(profile.edges[0].to.rva, 8);
  assert.equal(profile.indirects[0].from.rva, 4);
  assert.equal(profile.indirects[0].to.rva, 8);
});
