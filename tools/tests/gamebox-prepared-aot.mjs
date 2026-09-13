import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preflightPreparedAot } from '../../src/worker/core/gamebox-prepared-aot.mjs';

const fixtureRoot = new URL('./fixtures/gamebox-prepared/', import.meta.url);

const WASM_SHA = '11'.repeat(32);
const JS_SHA = '22'.repeat(32);
const MEMORY = 0x40000000;
const ROOT = 0x00401000;
const CONFIG = Array.from({ length: 22 }, () => 0);

function unit({ memory = MEMORY, config = CONFIG, virtualAddress = ROOT, aliases = [] } = {}) {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const mappings = [virtualAddress, ...aliases];
  const bytes = new Uint8Array(132 + 4100 + mappings.length * 8 + 8 + 4 + wasm.length);
  const view = new DataView(bytes.buffer);
  const put = (offset, value) => view.setUint32(offset, value >>> 0, true);
  put(0, ROOT);
  put(16, memory);
  config.forEach((value, index) => put((8 + index) * 4, value));
  put(120, 1);
  put(124, mappings.length);
  put(128, 1);
  put(132, ROOT);
  mappings.forEach((address, index) => {
    put(132 + 4100 + index * 8, address);
    put(132 + 4100 + index * 8 + 4, ROOT);
  });
  const entryStart = 132 + 4100 + mappings.length * 8;
  put(entryStart, ROOT);
  put(entryStart + 4, 0);
  const wasmStart = entryStart + 8 + 4;
  bytes.set(wasm, wasmStart);
  return bytes;
}

function packageOf(...units) {
  const bytes = new Uint8Array(8 + units.reduce((sum, value) => sum + 4 + value.length, 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x31544f41, true);
  view.setUint32(4, units.length, true);
  let offset = 8;
  for (const value of units) {
    view.setUint32(offset, value.length, true);
    bytes.set(value, offset + 4);
    offset += 4 + value.length;
  }
  return bytes;
}

async function digest(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function archive(files) {
  return {
    async read(path, maxBytes) {
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      assert.ok(value.length <= maxBytes);
      return value;
    },
  };
}

function cpu(config = CONFIG) {
  return { wm: { exports: { get_jit_config: (index) => config[index] } } };
}

function fixtureCpu(config, memory) {
  return {
    memory_size: new Uint32Array([memory]),
    wm: { exports: { get_jit_config: (index) => config[index] } },
  };
}

const installed = {
  wasmSha256: WASM_SHA,
  javascriptSha256: JS_SHA,
  memoryBytes: MEMORY,
  jitConfig: CONFIG,
};

function profileInstalled(jitConfig = CONFIG, mapping = 'profile') {
  return {
    ...installed,
    cpuMode: 'protected32-flat',
    paging: 'enabled',
    mapping,
    jitConfig,
  };
}

function profileManifest(artifact, artifactHash, mapping = 'profile') {
  const moduleHash = 'a'.repeat(64);
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    runtimeWasmSha256: WASM_SHA,
    runtimeJavascriptSha256: JS_SHA,
    memoryBytes: MEMORY,
    mapping,
    jitConfigOverrides: [],
    artifacts: [{
      moduleHash,
      bytes: artifact.length,
      sha256: artifactHash,
      moduleGuard: {
        sourceHash: moduleHash,
        machine: 0x14c,
        pe32Plus: false,
        preferredBase: ROOT,
        loadBase: ROOT,
        imageSize: 0x1000,
        cpuMode: 'protected32-flat',
        paging: 'enabled',
        mapping,
      },
    }],
  }));
}

const artifact = packageOf(unit());
const artifactHash = await digest(artifact);
const staticManifest = new TextEncoder().encode(JSON.stringify({
  format: 'gamebox-v86-aot-1',
  abi: WASM_SHA,
  file: 'aot.bin',
  bytes: artifact.length,
  sha256: artifactHash,
}));

// Profile-mapped AOT units must not use the identity-addressed fastmem paths.
for (const [index, label] of [[9, 'reads'], [19, 'writes']]) {
  const config = [...CONFIG];
  config[index] = 1;
  const profileArtifact = packageOf(unit());
  const result = await preflightPreparedAot({
    cpu: cpu(config),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: archive(new Map([
      ['optimized/manifest.json', profileManifest(profileArtifact, await digest(profileArtifact))],
      ['optimized/' + 'a'.repeat(64) + '.aot', profileArtifact],
    ])),
    installed: profileInstalled(config),
  });
  assert.equal(result.status, 'skipped', `profile fastmem ${label} must fail closed`);
  assert.equal(result.reason, 'runtime-profile-fastmem-mismatch');
}

// Check every unit as well: a later unit cannot smuggle an identity fastmem
// configuration into an otherwise valid profile-mapped package.
for (const index of [9, 19]) {
  const config = [...CONFIG];
  config[index] = 1;
  const profileArtifact = packageOf(unit(), unit({ config }));
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: archive(new Map([
      ['optimized/manifest.json', profileManifest(profileArtifact, await digest(profileArtifact))],
      ['optimized/' + 'a'.repeat(64) + '.aot', profileArtifact],
    ])),
    installed: profileInstalled(),
  });
  assert.equal(result.status, 'skipped', `profile unit fastmem index ${index} must fail closed`);
  assert.equal(result.reason, 'artifact-profile-fastmem-mismatch');
}

{
  const profileArtifact = packageOf(unit(), unit());
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: archive(new Map([
      ['optimized/manifest.json', profileManifest(profileArtifact, await digest(profileArtifact))],
      ['optimized/' + 'a'.repeat(64) + '.aot', profileArtifact],
    ])),
    installed: profileInstalled(),
  });
  assert.equal(result.status, 'validated', 'profile fastmem reads/writes disabled must remain valid');
  assert.equal(result.units, 2);
}

{
  const config = [...CONFIG];
  config[9] = 1;
  config[19] = 1;
  const identityArtifact = packageOf(unit({ config }), unit({ config }));
  const result = await preflightPreparedAot({
    cpu: cpu(config),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: archive(new Map([
      ['optimized/manifest.json', profileManifest(identityArtifact, await digest(identityArtifact), 'identity')],
      ['optimized/' + 'a'.repeat(64) + '.aot', identityArtifact],
    ])),
    installed: profileInstalled(config, 'identity'),
  });
  assert.equal(result.status, 'validated', 'identity mapping must retain fastmem behavior');
  assert.equal(result.units, 2);
}

{
  const mappedArtifact = packageOf(unit({ virtualAddress: 0xf0001000 }));
  const mappedManifest = new TextEncoder().encode(JSON.stringify({
    format: 'gamebox-v86-aot-1',
    abi: WASM_SHA,
    file: 'aot.bin',
    bytes: mappedArtifact.length,
    sha256: await digest(mappedArtifact),
  }));
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'static',
      manifestPath: 'aot.json',
      context: { runtimeJavascriptSha256: JS_SHA, memoryBytes: MEMORY, jitConfigOverrides: [] },
    },
    archive: archive(new Map([['aot.json', mappedManifest], ['aot.bin', mappedArtifact]])),
    installed,
  });
  assert.equal(result.status, 'validated');
}

{
  const aliasedArtifact = packageOf(
    unit({ virtualAddress: 0xf0001000, aliases: [0xf0002000] }),
  );
  const aliasedManifest = new TextEncoder().encode(JSON.stringify({
    format: 'gamebox-v86-aot-1',
    abi: WASM_SHA,
    file: 'aot.bin',
    bytes: aliasedArtifact.length,
    sha256: await digest(aliasedArtifact),
  }));
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'static',
      manifestPath: 'aot.json',
      context: { runtimeJavascriptSha256: JS_SHA, memoryBytes: MEMORY, jitConfigOverrides: [] },
    },
    archive: archive(new Map([['aot.json', aliasedManifest], ['aot.bin', aliasedArtifact]])),
    installed,
  });
  assert.equal(result.status, 'validated');
}

{
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'static',
      manifestPath: 'aot.json',
      context: { runtimeJavascriptSha256: JS_SHA, memoryBytes: MEMORY, jitConfigOverrides: [] },
    },
    archive: archive(new Map([['aot.json', staticManifest], ['aot.bin', artifact]])),
    installed,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.units, 1);
  assert.equal(result.artifactBytes, artifact.length);
}

{
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'pgo',
      manifestPath: 'optimized/manifest.json',
      artifactRoot: 'optimized',
    },
    archive: archive(new Map([
      ['optimized/manifest.json', new TextEncoder().encode(JSON.stringify({
        version: 1,
        runtimeWasmSha256: WASM_SHA,
        runtimeJavascriptSha256: JS_SHA,
        memoryBytes: MEMORY,
        jitConfigOverrides: [],
        artifacts: [
          { moduleHash: 'a'.repeat(64), bytes: artifact.length, sha256: artifactHash },
          { moduleHash: 'b'.repeat(64), bytes: artifact.length, sha256: artifactHash },
        ],
      }))],
      ['optimized/' + 'a'.repeat(64) + '.aot', artifact],
      ['optimized/' + 'b'.repeat(64) + '.aot', artifact],
    ])),
    installed,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.units, 2);
  assert.equal(new DataView(result.bytes.buffer).getUint32(4, true), 2);
}

// The current GameBox optimizer emits version-2 manifests with source/profile
// identities, runtime fields, and explicit JIT overrides. They use the same
// bounded artifact descriptors as version 1 and must reach the existing
// structural/context guards instead of falling back as an unknown manifest.
{
  const versionTwoManifest = new TextEncoder().encode(JSON.stringify({
    version: 2,
    recipe: 'v86-profile-regions-test',
    sourceBundleHash: 'd'.repeat(64),
    profileSha256: 'e'.repeat(64),
    hotTracesSha256: 'f'.repeat(64),
    runtimeWasmSha256: WASM_SHA,
    runtimeJavascriptSha256: JS_SHA,
    memoryBytes: MEMORY,
    jitConfig: CONFIG,
    jitConfigOverrides: [],
    artifacts: [{ moduleHash: 'a'.repeat(64), bytes: artifact.length, sha256: artifactHash }],
  }));
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: archive(new Map([
      ['optimized/manifest.json', versionTwoManifest],
      ['optimized/' + 'a'.repeat(64) + '.aot', artifact],
    ])),
    installed,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.units, 1);
}

{
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json' },
    archive: archive(new Map([['optimized/manifest.json', new TextEncoder().encode(JSON.stringify({
      version: 3,
      artifacts: [],
    }))]])),
    installed,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'invalid-pgo-manifest');
}

{
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'pgo',
      manifestPath: 'optimized/manifest.json',
    },
    archive: archive(new Map([['optimized/manifest.json', new TextEncoder().encode(JSON.stringify({
      version: 1,
      runtimeWasmSha256: WASM_SHA,
      runtimeJavascriptSha256: JS_SHA,
      memoryBytes: 16 * 1024 * 1024,
      jitConfigOverrides: [],
      artifacts: [],
    }))]])),
    installed,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'runtime-memory-mismatch');
}

{
  const badArtifact = packageOf(unit({ config: [1, ...CONFIG.slice(1)] }));
  const badManifest = new TextEncoder().encode(JSON.stringify({
    format: 'gamebox-v86-aot-1',
    abi: WASM_SHA,
    file: 'aot.bin',
    bytes: badArtifact.length,
    sha256: await digest(badArtifact),
  }));
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: {
      kind: 'static',
      manifestPath: 'aot.json',
      context: { runtimeJavascriptSha256: JS_SHA, memoryBytes: MEMORY, jitConfigOverrides: [] },
    },
    archive: archive(new Map([['aot.json', badManifest], ['aot.bin', badArtifact]])),
    installed,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'artifact-config-mismatch');
}

// A translation index can otherwise pass the generic Wasm/JS/RAM checks while
// carrying a flat compiler guard into BottleShip's paging runtime.  The module
// guard is part of the installation contract, not just diagnostic metadata.
{
  const sourceHash = 'c'.repeat(64);
  const guardedIndex = {
    version: 1,
    runtime: {
      wasmSha256: WASM_SHA,
      javascriptSha256: JS_SHA,
      memoryBytes: MEMORY,
    },
    modules: [{
      sourceHash,
      compilation: {
        summary: { units: 1 },
        moduleGuard: {
          sourceHash,
          machine: 0x14c,
          pe32Plus: false,
          preferredBase: ROOT,
          loadBase: ROOT,
          imageSize: 0x1000,
          cpuMode: 'protected32-flat',
          paging: 'disabled',
          mapping: 'identity',
        },
      },
    }],
  };
  const result = await preflightPreparedAot({
    cpu: cpu(),
    index: { kind: 'translation-index', manifestPath: 'translations/index.json', artifacts: [{ moduleHash: sourceHash }] },
    archive: archive(new Map([
      ['translations/index.json', new TextEncoder().encode(JSON.stringify(guardedIndex))],
      [`translations/${sourceHash}.aot`, artifact],
    ])),
    installed: { ...installed, cpuMode: 'protected32-flat', paging: 'enabled', mapping: 'identity' },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'runtime-paging-mismatch');
}

// Regression coverage against the checked-in phase4 translation index.  This
// index has no artifact checksum/size fields; the package and every unit still
// receive the structural, runtime, and Wasm validation above.
{
  const index = JSON.parse(await readFile(new URL('static-index.json', fixtureRoot), 'utf8'));
  const artifact = new Uint8Array(await readFile(new URL('static.aot', fixtureRoot)));
  const jitConfig = Array.from({ length: 22 }, (_, index) => new DataView(artifact.buffer, artifact.byteOffset, artifact.byteLength).getUint32(12 + (8 + index) * 4, true));
  const actualInstalled = {
    wasmSha256: index.runtime.wasmSha256,
    javascriptSha256: index.runtime.javascriptSha256,
    memoryBytes: index.runtime.memoryBytes,
    recipe: index.runtime.recipe,
    jitConfig,
  };
  const result = await preflightPreparedAot({
    cpu: fixtureCpu(jitConfig, index.runtime.memoryBytes),
    index: {
      kind: 'translation-index',
      manifestPath: 'translations/index.json',
      artifactRoot: 'translations',
      artifacts: [{
        moduleHash: index.modules[0].sourceHash,
        bytes: artifact.byteLength,
        sha256: await digest(artifact),
      }],
    },
    archive: {
      async read(path, maxBytes) {
        const name = path.endsWith('/index.json') ? 'static-index.json' : 'static.aot';
        const bytes = new Uint8Array(await readFile(new URL(name, fixtureRoot)));
        assert.ok(bytes.byteLength <= maxBytes);
        return bytes;
      },
    },
    installed: actualInstalled,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.units, 1);
  assert.equal(result.artifactBytes, artifact.byteLength);
}

// Regression coverage against the checked-in phase6 optimized package.
{
  const manifest = JSON.parse(await readFile(new URL('pgo-manifest.json', fixtureRoot), 'utf8'));
  const artifact = new Uint8Array(await readFile(new URL('pgo.aot', fixtureRoot)));
  const jitConfig = Array.from({ length: 22 }, (_, index) => new DataView(artifact.buffer, artifact.byteOffset, artifact.byteLength).getUint32(12 + (8 + index) * 4, true));
  const actualInstalled = {
    wasmSha256: manifest.runtimeWasmSha256,
    javascriptSha256: manifest.runtimeJavascriptSha256,
    memoryBytes: manifest.memoryBytes,
    jitConfig,
  };
  const result = await preflightPreparedAot({
    cpu: fixtureCpu(jitConfig, manifest.memoryBytes),
    index: { kind: 'pgo', manifestPath: 'optimized/manifest.json', artifactRoot: 'optimized' },
    archive: {
      async read(path, maxBytes) {
        const name = path.endsWith('/manifest.json') ? 'pgo-manifest.json' : 'pgo.aot';
        const bytes = new Uint8Array(await readFile(new URL(name, fixtureRoot)));
        assert.ok(bytes.byteLength <= maxBytes);
        return bytes;
      },
    },
    installed: actualInstalled,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.units, 1);
  assert.equal(result.artifactBytes, artifact.byteLength);
}

console.log('gamebox-prepared-aot: ok');
