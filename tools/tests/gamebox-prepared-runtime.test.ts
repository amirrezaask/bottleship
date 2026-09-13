import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import type { GameboxCatalog } from '../../src/worker/runtime/filesystem/gamebox-catalog';
import { prepareGameboxRuntime } from '../../src/worker/core/gamebox-prepared-runtime';
import { PipelineFactory } from '../../src/worker/backends/webgpu/ddraw/pipeline-factory';

const fixtureRoot = new URL('./fixtures/gamebox-prepared/', import.meta.url);
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const prettyText = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

function archive(files: Map<string, Uint8Array>): any {
  return {
    getEntry(name: string) {
      const bytes = files.get(name);
      return bytes
        ? {
            name,
            isDirectory: false,
            compression: 0,
            uncompressedSize: bytes.length,
            compressedSize: bytes.length,
          }
        : undefined;
    },
    async readEntry(entry: { name: string }) {
      return files.get(entry.name)!;
    },
  };
}

function configOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: 22 }, (_, index) => view.getUint32(12 + (8 + index) * 4, true));
}

function cpu(config: number[], memoryBytes: number): any {
  return {
    memory_size: new Uint32Array([memoryBytes]),
    wm: { exports: { get_jit_config: (index: number) => config[index] } },
  };
}

function catalog(overrides: Record<string, unknown>): GameboxCatalog {
  return {
    bundleHash: '3975d4f9ea1838632ec33ce130c8adedd83ccf71330e52fc74524b28cce4de1b',
    gameId: 'fixture',
    entrypoint: 'GAME.EXE',
    gameContentHash: '6779ea045547a3afde9cef5b2ccd6c897dacbb4d643c386baeff9deef4fbaf47',
    optimized: undefined,
    cpuProfile: undefined,
    files: new Map(),
    features: { graphicsCache: false },
    staticArtifacts: [],
    ...overrides,
  } as unknown as GameboxCatalog;
}

async function pgoFixture() {
  const manifest = JSON.parse(await readFile(new URL('pgo-manifest.json', fixtureRoot), 'utf8'));
  const capture = JSON.parse(await readFile(new URL('profile.json', fixtureRoot), 'utf8'));
  const hash = manifest.artifacts[0].moduleHash as string;
  const artifact = new Uint8Array(await readFile(new URL('pgo.aot', fixtureRoot)));
  const files = new Map<string, Uint8Array>([
    ['gamebox/optimized/manifest.json', text(manifest)],
    [`gamebox/optimized/${hash}.aot`, artifact],
    ['gamebox/profiles/cpu.json', text(capture)],
  ]);
  const sources = new Map([
    [capture.modules[0].sourceSha256, { sourceHash: capture.modules[0].sourceSha256 }],
  ]);
  return { manifest, capture, artifact, files, sources };
}

async function graphicsFixture(options: { compact?: boolean } = {}) {
  const gameContentHash = '6779ea045547a3afde9cef5b2ccd6c897dacbb4d643c386baeff9deef4fbaf47';
  const wasmSha256 = 'a'.repeat(64);
  const javascriptSha256 = 'b'.repeat(64);
  const source = '@vertex fn main() {}';
  const shaderHash = await sha256(new TextEncoder().encode(source));
  const profile = {
    version: 1,
    gameContentHash,
    runtime: {
      wasmSha256,
      javascriptSha256,
      graphicsRecipe: 'graphics-recipe-v1',
      abiVersion: 1,
    },
    scenario: 'fixture',
    durationMs: '1',
    gpu: {
      backend: 'webgpu',
      vendor: 'test',
      architecture: 'test',
      device: 'test',
      description: 'test',
      colorFormat: 'rgba8unorm',
      depthFormat: 'depth24plus',
      sampleCount: 1,
      features: [],
      limits: [],
    },
    shaders: [
      {
        renderer: 'ddraw',
        kind: 'ffp',
        key: 'shader-key',
        source,
        hash: shaderHash,
        uses: '1',
        generationUs: '1',
      },
    ],
    pipelines: [
      {
        renderer: 'ddraw',
        key: 'pipeline-key',
        shaderHash,
        descriptor:
          '{"depthFormat":"depth24plus-stencil8","keyConfig":{},"mode":"ffp","sampleCount":1,"targetFormat":"rgba8unorm"}',
        uses: '1',
        prepareUs: '1',
        draws: '1',
      },
    ],
    counters: {
      frames: '0',
      drawCalls: '1',
      shaderCacheHits: '0',
      shaderCacheMisses: '1',
      pipelineCacheHits: '0',
      pipelineCacheMisses: '1',
      shaderRecords: '1',
      pipelineRecords: '1',
      droppedRecords: '0',
    },
    completeness: { complete: true, counterOverflow: false, deviceLost: false, unsupported: false },
    caveats: [],
  };
  const bytes = options.compact ? text(profile) : prettyText(profile);
  return {
    profile,
    bytes,
    files: new Map([['gamebox/profiles/gpu.json', bytes]]),
    pointer: {
      path: 'gamebox/profiles/gpu.json',
      sha256: await sha256(bytes),
      shaderCount: 1,
      pipelineCount: 1,
    },
    runtime: {
      wasmSha256,
      javascriptSha256,
      graphicsRecipe: 'graphics-recipe-v1',
      graphicsAbiVersion: 1,
    },
  };
}

describe('prepared runtime integration', () => {
  test('accepts bounded schema-v4 paging observations with high virtual addresses', async () => {
    const fixture = await pgoFixture();
    const capture = {
      ...fixture.capture,
      version: 4,
      memoryObservation: {
        memoryBytes: String(fixture.manifest.memoryBytes),
        pagingEnabled: true,
        generationOverflow: false,
        pages: [
          {
            virtualAddress: 0xf0001000,
            physicalAddress: fixture.capture.watchedPages[0].address,
            generation: '9',
            sha256: fixture.capture.watchedPages[0].sha256,
            bytes: Array.from({ length: 4096 }, (_, index) => index & 0xff),
          },
        ],
      },
    };
    const files = new Map(fixture.files);
    files.set('gamebox/profiles/cpu.json', text(capture));
    const result = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
      }),
      {
        runtime: {
          wasmSha256: fixture.manifest.runtimeWasmSha256,
          javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
        },
      },
    );
    expect(result.cpuProfile).toMatchObject({
      status: 'loaded',
      memoryObservation: { pagingEnabled: true, pages: 1 },
    });
  });

  test('fails closed before reading prepared artifacts when the opt-in trust store rejects a catalog', async () => {
    const fixture = await pgoFixture();
    let reads = 0;
    const source = archive(fixture.files);
    const guardedArchive = {
      ...source,
      getEntry(name: string) {
        reads++;
        return source.getEntry(name);
      },
      async readEntry(entry: { name: string }) {
        reads++;
        return source.readEntry(entry);
      },
    };
    const result = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      guardedArchive,
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
        preparedTrust: { status: 'untrusted', reason: 'signature-verification-failed', keyId: 'k' },
      }),
      {
        runtime: {
          wasmSha256: fixture.manifest.runtimeWasmSha256,
          javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
        },
        trustStore: { k: '0'.repeat(64) },
        trustPreparedAot: true,
        install: () => {
          throw new Error('untrusted prepared code must not install');
        },
      },
    );
    expect(reads).toBe(0);
    expect(result.translationAttempts).toEqual([
      {
        kind: 'prepared-runtime',
        status: 'skipped',
        reason: 'catalog-signature-signature-verification-failed',
      },
    ]);
    expect(result.cpuProfile).toEqual({ status: 'skipped', reason: 'prepared-signature-untrusted' });
  });

  test('loads the real profile summary but skips matching AOT by default', async () => {
    const fixture = await pgoFixture();
    const installed = {
      wasmSha256: fixture.manifest.runtimeWasmSha256,
      javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
    };
    const result = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(fixture.files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
      }),
      { runtime: installed },
    );
    expect(result.cpuProfile).toMatchObject({
      status: 'loaded',
      modules: 1,
      blocks: 2,
      edges: 2,
      indirects: 1,
      runtimeMatches: true,
    });
    expect(result.translationAttempts).toEqual([
      { kind: 'pgo', status: 'skipped', reason: 'unsigned-local-artifacts-not-enabled' },
    ]);
    expect(result.translations).toBe('ordinary-jit-or-existing-cache');
  });

  test('installs a trusted real optimized artifact and reports the summary', async () => {
    const fixture = await pgoFixture();
    let installs = 0;
    const result = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(fixture.files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
      }),
      {
        runtime: {
          wasmSha256: fixture.manifest.runtimeWasmSha256,
          javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
        },
        trustPreparedAot: true,
        install: (bytes) => {
          installs++;
          expect(bytes).toEqual(fixture.artifact);
        },
      },
    );
    expect(installs).toBe(1);
    expect(result.translationAttempts).toEqual([
      {
        kind: 'pgo',
        status: 'installed',
        units: 1,
        bytes: fixture.artifact.length,
        sha256: await sha256(fixture.artifact),
        reuse: 'native code-page and context guards still apply',
      },
    ]);
    expect(result.translations).toBe('installed');
  });

  test('rejects a wrong runtime before the installer and enforces pinned PGO source identity', async () => {
    const fixture = await pgoFixture();
    let installs = 0;
    const wrongRuntime = {
      wasmSha256: '0'.repeat(64),
      javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
    };
    const mismatch = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(fixture.files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
      }),
      {
        runtime: wrongRuntime,
        trustPreparedAot: true,
        install: () => {
          installs++;
        },
      },
    );
    expect(mismatch.cpuProfile).toMatchObject({ status: 'loaded', runtimeMatches: false });
    expect(mismatch.translationAttempts).toEqual([
      { kind: 'pgo', status: 'skipped', reason: 'runtime-wasm-mismatch' },
    ]);
    expect(installs).toBe(0);

    const sourceMismatch = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(fixture.files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
        bundleHash: 'a'.repeat(64),
      }),
      {
        runtime: {
          wasmSha256: fixture.manifest.runtimeWasmSha256,
          javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
        },
        trustPreparedAot: true,
        install: () => {
          installs++;
        },
      },
    );
    expect(sourceMismatch.translationAttempts).toEqual([
      { kind: 'pgo', status: 'skipped', reason: 'source-bundle-mismatch' },
    ]);
    expect(installs).toBe(0);
  });

  test('rejects an optimized module that is absent from the catalog before AOT preflight', async () => {
    const fixture = await pgoFixture();
    const forgedManifest = {
      ...fixture.manifest,
      artifacts: [{ ...fixture.manifest.artifacts[0], moduleHash: 'f'.repeat(64) }],
    };
    const files = new Map(fixture.files);
    files.set('gamebox/optimized/manifest.json', text(forgedManifest));
    let installs = 0;
    const result = await prepareGameboxRuntime(
      cpu(configOf(fixture.artifact), fixture.manifest.memoryBytes),
      archive(files),
      catalog({
        optimized: 'gamebox/optimized/manifest.json',
        cpuProfile: 'gamebox/profiles/cpu.json',
        files: fixture.sources,
      }),
      {
        runtime: {
          wasmSha256: fixture.manifest.runtimeWasmSha256,
          javascriptSha256: fixture.manifest.runtimeJavascriptSha256,
        },
        trustPreparedAot: true,
        install: () => {
          installs++;
        },
      },
    );
    expect(result.translationAttempts).toEqual([
      { kind: 'pgo', status: 'skipped', reason: 'optimized-module-not-in-catalog' },
    ]);
    expect(installs).toBe(0);
  });

  test('uses the translation-index kind and catalog-provided static artifact binding', async () => {
    const index = JSON.parse(await readFile(new URL('static-index.json', fixtureRoot), 'utf8'));
    const sourceHash = index.modules[0].sourceHash as string;
    const artifact = new Uint8Array(await readFile(new URL('static.aot', fixtureRoot)));
    const files = new Map<string, Uint8Array>([
      ['gamebox/translations/index.json', text(index)],
      [`gamebox/translations/${sourceHash}.aot`, artifact],
    ]);
    let installs = 0;
    const result = await prepareGameboxRuntime(
      cpu(configOf(artifact), index.runtime.memoryBytes),
      archive(files),
      catalog({
        bundleHash: 'b'.repeat(64),
        files: new Map([[sourceHash, { sourceHash }]]),
        staticArtifacts: [
          { moduleHash: sourceHash, bytes: artifact.length, sha256: await sha256(artifact) },
        ],
      }),
      {
        runtime: {
          wasmSha256: index.runtime.wasmSha256,
          javascriptSha256: index.runtime.javascriptSha256,
        },
        trustPreparedAot: true,
        install: (bytes) => {
          installs++;
          expect(bytes).toEqual(artifact);
        },
      },
    );
    expect(installs).toBe(1);
    expect(result.translationAttempts).toEqual([
      {
        kind: 'translation-index',
        status: 'installed',
        units: 1,
        bytes: artifact.length,
        sha256: await sha256(artifact),
        reuse: 'native code-page and context guards still apply',
      },
    ]);
  });

  test('skips flat static translations when the installed runtime enables paging', async () => {
    const index = JSON.parse(await readFile(new URL('static-index.json', fixtureRoot), 'utf8'));
    const sourceHash = index.modules[0].sourceHash as string;
    const artifact = new Uint8Array(await readFile(new URL('static.aot', fixtureRoot)));
    const files = new Map<string, Uint8Array>([
      ['gamebox/translations/index.json', text(index)],
      [`gamebox/translations/${sourceHash}.aot`, artifact],
    ]);
    let installs = 0;
    const result = await prepareGameboxRuntime(
      cpu(configOf(artifact), index.runtime.memoryBytes),
      archive(files),
      catalog({
        bundleHash: 'b'.repeat(64),
        files: new Map([[sourceHash, { sourceHash }]]),
        staticArtifacts: [{ moduleHash: sourceHash, bytes: artifact.length, sha256: await sha256(artifact) }],
      }),
      {
        runtime: {
          wasmSha256: index.runtime.wasmSha256,
          javascriptSha256: index.runtime.javascriptSha256,
          cpuMode: 'protected32-flat',
          paging: 'enabled',
          mapping: 'identity',
        },
        trustPreparedAot: true,
        install: () => { installs++; },
      },
    );
    expect(installs).toBe(0);
    expect(result.translationAttempts).toEqual([
      { kind: 'translation-index', status: 'skipped', reason: 'artifact-module-guard-unavailable' },
    ]);
    expect(result.translations).toBe('ordinary-jit-or-existing-cache');
  });

  test('loads a canonical graphics profile with bounded native-creation candidates', async () => {
    const fixture = await graphicsFixture();
    const result = await prepareGameboxRuntime(
      cpu([], 16 * 1024 * 1024),
      archive(fixture.files),
      catalog({ graphicsProfile: fixture.pointer, features: { graphicsCache: true } }),
      { runtime: fixture.runtime },
    );
    expect(result.graphicsProfile).toEqual({
      status: 'loaded',
      path: fixture.pointer.path,
      sha256: fixture.pointer.sha256,
      scenario: 'fixture',
      shaderCount: 1,
      pipelineCount: 1,
      complete: true,
      runtimeMatches: true,
      hydrated: false,
      hydratedShaderSources: 1,
      hydratedPipelineDescriptors: 1,
    });
    expect(result.graphics).toBe('prepared-profile-candidates-with-native-fallback');
    expect((globalThis as any).__gameboxGraphicsProfile).toMatchObject({
      prepared: true,
      status: 'loaded',
      gameContentHash: fixture.profile.gameContentHash,
    });
    expect(Array.from((globalThis as any).__gameboxGraphicsProfile.shaderSources)).toEqual([
      [fixture.profile.shaders[0].key, fixture.profile.shaders[0].source],
    ]);
    expect((globalThis as any).__gameboxGraphicsProfile.pipelineDescriptors.size).toBe(1);
  });

  test('accepts exact prepared descriptor state and accounts for attachment mismatches', () => {
    (globalThis as any).__gameboxGraphicsProfile = {
      pipelineDescriptors: new Map([
        [
          '1|exact',
          {
            keyConfig: '{}',
            targetFormat: 'rgba8unorm',
            depthFormat: 'depth24plus-stencil8',
            sampleCount: 1,
          },
        ],
      ]),
    };
    delete (globalThis as any).__gameboxGraphicsPreparedStats;
    const factory = new PipelineFactory(
      {} as GPUDevice,
      {} as any,
      {} as any,
      {} as any,
      'rgba8unorm',
    );
    expect((factory as any).preparedDescriptorMatches('1|exact', {})).toBe(true);
    expect(factory.getPreparedDescriptorStats()).toMatchObject({ hits: 1, misses: 0, candidates: 1 });
    factory.setSampleCount(4);
    expect((factory as any).preparedDescriptorMatches('1|exact', {})).toBe(false);
    expect(factory.getPreparedDescriptorStats()).toMatchObject({ hits: 1, misses: 1, candidates: 1 });
    delete (globalThis as any).__gameboxGraphicsProfile;
    delete (globalThis as any).__gameboxGraphicsPreparedStats;
  });

  test('skips graphics metadata when pointer, identity, counts, or canonical JSON mismatch', async () => {
    const cases = [
      [
        'pointer hash',
        (fixture: Awaited<ReturnType<typeof graphicsFixture>>) => ({
          ...fixture.pointer,
          sha256: '0'.repeat(64),
        }),
      ],
      [
        'pointer counts',
        (fixture: Awaited<ReturnType<typeof graphicsFixture>>) => ({
          ...fixture.pointer,
          shaderCount: 2,
        }),
      ],
      [
        'runtime identity',
        (fixture: Awaited<ReturnType<typeof graphicsFixture>>) => fixture.pointer,
      ],
    ] as const;
    for (const [label, pointerForCase] of cases) {
      const fixture = await graphicsFixture();
      const runtime =
        label === 'runtime identity'
          ? { ...fixture.runtime, graphicsRecipe: 'other-recipe' }
          : fixture.runtime;
      const result = await prepareGameboxRuntime(
        cpu([], 16 * 1024 * 1024),
        archive(fixture.files),
        catalog({ graphicsProfile: pointerForCase(fixture) }),
        { runtime },
      );
      expect(result.graphicsProfile.status, label).toBe('skipped');
      expect(result.graphics, label).toBe('not-built');
    }
    const compact = await graphicsFixture({ compact: true });
    const compactResult = await prepareGameboxRuntime(
      cpu([], 16 * 1024 * 1024),
      archive(compact.files),
      catalog({ graphicsProfile: compact.pointer }),
      { runtime: compact.runtime },
    );
    expect(compactResult.graphicsProfile).toMatchObject({ status: 'skipped', hydrated: false });
    expect((globalThis as any).__gameboxGraphicsProfile).toBeUndefined();
  });
});
