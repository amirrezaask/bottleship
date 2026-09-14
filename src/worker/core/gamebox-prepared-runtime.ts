import type { ZipArchive } from '@bottleship/formats/zip';
import {
  GameboxCatalog,
  readGameboxJson,
  readGameboxJsonBytes,
  type GameboxTrustStore,
} from '../runtime/filesystem/gamebox-catalog';
import { preflightPreparedAot, type PreparedAotIndex } from './gamebox-prepared-aot.mjs';
import { installPreparedTranslationPackage } from './gamebox-aot';

declare const __GAMEBOX_PREPARED_RUNTIME__: {
  wasmSha256: string;
  javascriptSha256: string;
  cpuMode?: string;
  paging?: string;
  mapping?: string;
  graphicsRecipe?: string;
  graphicsAbiVersion?: number;
};
declare const __GAMEBOX_TRUST_PREPARED_AOT__: boolean;
declare const __GAMEBOX_TRUST_STORE__: GameboxTrustStore;

const GRAPHICS_PROFILE_MAX_BYTES = 16 * 1024 * 1024;
const GRAPHICS_PROFILE_MAX_STRING_BYTES = 256;
const GRAPHICS_PROFILE_MAX_KEY_BYTES = 4096;
const GRAPHICS_PROFILE_MAX_SHADER_BYTES = 1024 * 1024;
const GRAPHICS_PROFILE_MAX_WGSL_BYTES = 8 * 1024 * 1024;
const GRAPHICS_PROFILE_MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const GRAPHICS_PROFILE_MAX_SHADERS = 8192;
const GRAPHICS_PROFILE_MAX_PIPELINES = 16_384;
const GRAPHICS_PROFILE_MAX_FEATURES = 64;
const GRAPHICS_PROFILE_MAX_LIMITS = 64;
const GRAPHICS_PROFILE_MAX_CAVEATS = 64;
const GRAPHICS_PROFILE_MAX_CAVEAT_BYTES = 4096;
const HASH = /^[0-9a-f]{64}$/;
const CPU_PROFILE_MAX_PAGES = 64;
const CPU_PROFILE_PAGE_BYTES = 4096;

export interface PreparedRuntimeIdentity {
  wasmSha256: string;
  javascriptSha256: string;
  /** Address-space identity is required for prepared CPU artifacts. */
  cpuMode?: string;
  paging?: string;
  mapping?: string;
  graphicsRecipe?: string;
  graphicsAbiVersion?: number;
}
export interface PreparedRuntimeOptions {
  runtime?: PreparedRuntimeIdentity;
  trustPreparedAot?: boolean;
  /** Optional local trust store; signed catalogs are required before AOT reads. */
  trustStore?: GameboxTrustStore;
  install?: (bytes: Uint8Array) => void;
}

type Status = { status: string; reason?: string; [key: string]: unknown };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid prepared metadata');
  return value as Record<string, any>;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, any> {
  const result = object(value);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index]))
    throw new Error(`${label} is not canonical`);
  return result;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value || utf8Bytes(value) > limit)
    throw new Error(`Invalid graphics profile ${label}`);
  return value;
}

function identityHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value))
    throw new Error(`Invalid graphics profile ${label}`);
  return value;
}

function boundedNumber(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`Invalid graphics profile ${label}`);
  return value;
}

function decimalU64(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    throw new Error(`Invalid graphics profile ${label}`);
  try {
    if (BigInt(value) > 0xffffffffffffffffn) throw new Error('out of range');
  } catch {
    throw new Error(`Invalid graphics profile ${label}`);
  }
  return value;
}

function validateCpuMemoryObservation(value: unknown): {
  pagingEnabled: boolean;
  pages: number;
} {
  const observation = object(value);
  if (
    typeof observation.memoryBytes !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(observation.memoryBytes) ||
    typeof observation.pagingEnabled !== 'boolean' ||
    typeof observation.generationOverflow !== 'boolean' ||
    !Array.isArray(observation.pages) ||
    observation.pages.length === 0 ||
    observation.pages.length > CPU_PROFILE_MAX_PAGES
  )
    throw new Error('CPU profile memory observation is invalid');
  let memoryBytes: bigint;
  try {
    memoryBytes = BigInt(observation.memoryBytes);
  } catch {
    throw new Error('CPU profile memory observation memory size is invalid');
  }
  if (memoryBytes < BigInt(CPU_PROFILE_PAGE_BYTES) || memoryBytes > 0xffffffffn)
    throw new Error('CPU profile memory observation memory size is invalid');
  const virtualPages = new Set<number>();
  const physicalPages = new Set<number>();
  for (const page of observation.pages) {
    const row = object(page);
    if (
      !Number.isSafeInteger(row.virtualAddress) ||
      row.virtualAddress < 0 ||
      row.virtualAddress > 0xfffff000 ||
      row.virtualAddress % CPU_PROFILE_PAGE_BYTES !== 0 ||
      !Number.isSafeInteger(row.physicalAddress) ||
      row.physicalAddress < 0 ||
      row.physicalAddress + CPU_PROFILE_PAGE_BYTES > Number(memoryBytes) ||
      row.physicalAddress % CPU_PROFILE_PAGE_BYTES !== 0 ||
      virtualPages.has(row.virtualAddress) ||
      physicalPages.has(row.physicalAddress) ||
      !HASH.test(row.sha256) ||
      !Array.isArray(row.bytes) ||
      row.bytes.length !== CPU_PROFILE_PAGE_BYTES ||
      row.bytes.some(
        (byte: unknown) =>
          !Number.isSafeInteger(byte) || (byte as number) < 0 || (byte as number) > 255,
      )
    )
      throw new Error('CPU profile memory observation page is invalid');
    decimalU64(row.generation, 'CPU profile memory observation generation');
    virtualPages.add(row.virtualAddress);
    physicalPages.add(row.physicalAddress);
  }
  return { pagingEnabled: observation.pagingEnabled, pages: observation.pages.length };
}

function canonicalValue(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Graphics profile descriptor is too deeply nested');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Graphics profile descriptor has non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalValue(item, depth + 1)).join(',')}]`;
  if (!value || typeof value !== 'object')
    throw new Error('Graphics profile descriptor contains an unsupported value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], depth + 1)}`)
    .join(',')}}`;
}

function compareStrings(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const result = compareStrings(left[key], right[key]);
    if (result !== 0) return result;
  }
  return 0;
}

function canonicalDescriptor(value: unknown): string {
  const descriptor = boundedString(
    value,
    GRAPHICS_PROFILE_MAX_DESCRIPTOR_BYTES,
    'pipeline descriptor',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptor);
  } catch {
    throw new Error('Invalid graphics profile pipeline descriptor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Graphics profile pipeline descriptor must be an object');
  const canonical = canonicalValue(parsed);
  if (canonical !== descriptor)
    throw new Error('Graphics profile pipeline descriptor is not canonical');
  return descriptor;
}

interface PreparedGraphicsPipeline {
  descriptor: string;
  keyConfig: string;
  targetFormat: string;
  depthFormat: string;
  sampleCount: number;
}

function preparedGraphicsPipeline(value: unknown): PreparedGraphicsPipeline | undefined {
  try {
    if (typeof value !== 'string') return undefined;
    const descriptor = object(JSON.parse(value));
    if (
      descriptor.mode !== 'ffp' ||
      typeof descriptor.targetFormat !== 'string' ||
      descriptor.targetFormat.length === 0 ||
      descriptor.targetFormat.length > 256 ||
      descriptor.depthFormat !== 'depth24plus-stencil8' ||
      (descriptor.sampleCount !== 1 &&
        descriptor.sampleCount !== 2 &&
        descriptor.sampleCount !== 4 &&
        descriptor.sampleCount !== 8) ||
      !descriptor.keyConfig ||
      typeof descriptor.keyConfig !== 'object' ||
      Array.isArray(descriptor.keyConfig)
    )
      return undefined;
    return {
      descriptor: canonicalDescriptor(value),
      keyConfig: canonicalValue(descriptor.keyConfig),
      targetFormat: descriptor.targetFormat,
      depthFormat: descriptor.depthFormat,
      sampleCount: descriptor.sampleCount,
    };
  } catch {
    return undefined;
  }
}

async function loadGraphicsProfile(
  archive: ZipArchive,
  catalog: GameboxCatalog,
  runtime: PreparedRuntimeIdentity,
): Promise<Status> {
  delete (globalThis as any).__gameboxGraphicsProfile;
  delete (globalThis as any).__gameboxGraphicsPreparedStats;
  if (!catalog.graphicsProfile) {
    return catalog.graphicsProfileSkipped
      ? { status: 'skipped', reason: catalog.graphicsProfileSkipped, hydrated: false }
      : { status: 'absent', hydrated: false };
  }
  try {
    const pointer = catalog.graphicsProfile;
    const bytes = await readGameboxJsonBytes(archive, pointer.path, GRAPHICS_PROFILE_MAX_BYTES);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    );
    const actualHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actualHash !== pointer.sha256) throw new Error('graphics profile content hash mismatch');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const profile = exactObject(
      JSON.parse(text),
      [
        'version',
        'gameContentHash',
        'runtime',
        'scenario',
        'durationMs',
        'gpu',
        'shaders',
        'pipelines',
        'counters',
        'completeness',
        'caveats',
      ],
      'Graphics profile',
    );
    if (profile.version !== 1) throw new Error('unsupported graphics profile version');
    if (identityHash(profile.gameContentHash, 'game content hash') !== catalog.gameContentHash)
      throw new Error('graphics profile game identity mismatch');
    const profileRuntime = exactObject(
      profile.runtime,
      ['wasmSha256', 'javascriptSha256', 'graphicsRecipe', 'abiVersion'],
      'Graphics profile runtime identity',
    );
    const profileAbiVersion = boundedNumber(profileRuntime.abiVersion, 'ABI version', 0xffffffff);
    if (
      identityHash(profileRuntime.wasmSha256, 'Wasm hash') !== runtime.wasmSha256 ||
      identityHash(profileRuntime.javascriptSha256, 'JavaScript hash') !==
        runtime.javascriptSha256 ||
      boundedString(profileRuntime.graphicsRecipe, GRAPHICS_PROFILE_MAX_STRING_BYTES, 'recipe') !==
        (runtime.graphicsRecipe ?? 'graphics-recipe-v1') ||
      profileAbiVersion === 0 ||
      profileAbiVersion !== (runtime.graphicsAbiVersion ?? 1)
    )
      throw new Error('graphics profile runtime identity mismatch');
    const scenario = boundedString(profile.scenario, GRAPHICS_PROFILE_MAX_STRING_BYTES, 'scenario');
    decimalU64(profile.durationMs, 'duration');

    const gpu = exactObject(
      profile.gpu,
      [
        'backend',
        'vendor',
        'architecture',
        'device',
        'description',
        'colorFormat',
        'depthFormat',
        'sampleCount',
        'features',
        'limits',
      ],
      'Graphics profile GPU record',
    );
    for (const field of [
      'backend',
      'vendor',
      'architecture',
      'device',
      'description',
      'colorFormat',
      'depthFormat',
    ])
      boundedString(gpu[field], GRAPHICS_PROFILE_MAX_STRING_BYTES, `GPU ${field}`);
    if (![1, 2, 4, 8].includes(boundedNumber(gpu.sampleCount, 'sample count')))
      throw new Error('Invalid graphics profile sample count');
    if (!Array.isArray(gpu.features) || gpu.features.length > GRAPHICS_PROFILE_MAX_FEATURES)
      throw new Error('Graphics profile feature count exceeds its budget');
    const features = gpu.features.map((feature: unknown) =>
      boundedString(feature, GRAPHICS_PROFILE_MAX_STRING_BYTES, 'GPU feature'),
    );
    if (features.some((feature, index) => (index > 0 && feature <= features[index - 1]) || false))
      throw new Error('Graphics profile GPU features are not canonical');
    if (!Array.isArray(gpu.limits) || gpu.limits.length > GRAPHICS_PROFILE_MAX_LIMITS)
      throw new Error('Graphics profile GPU limit count exceeds its budget');
    const limits = gpu.limits.map((value: unknown) => {
      const limit = exactObject(value, ['name', 'value'], 'Graphics profile GPU limit');
      return {
        name: boundedString(limit.name, GRAPHICS_PROFILE_MAX_STRING_BYTES, 'GPU limit name'),
        value: boundedNumber(limit.value, 'GPU limit value'),
      };
    });
    if (
      limits.some(
        (limit, index) =>
          (index > 0 && limit.name <= limits[index - 1].name) ||
          limits.slice(0, index).some((previous) => previous.name === limit.name),
      )
    )
      throw new Error('Graphics profile GPU limits are not canonical');

    if (!Array.isArray(profile.shaders) || profile.shaders.length > GRAPHICS_PROFILE_MAX_SHADERS)
      throw new Error('Graphics profile shader count exceeds its budget');
    const shaderHashes = new Set<string>();
    const shaderKeys = new Set<string>();
    let shaderSourceBytes = 0;
    const shaders = profile.shaders.map((value: unknown) => {
      const shader = exactObject(
        value,
        ['renderer', 'kind', 'key', 'source', 'hash', 'uses', 'generationUs'],
        'Graphics profile shader',
      );
      const result = {
        renderer: boundedString(
          shader.renderer,
          GRAPHICS_PROFILE_MAX_STRING_BYTES,
          'shader renderer',
        ),
        kind: boundedString(shader.kind, GRAPHICS_PROFILE_MAX_STRING_BYTES, 'shader kind'),
        key: boundedString(shader.key, GRAPHICS_PROFILE_MAX_KEY_BYTES, 'shader key'),
        source: boundedString(shader.source, GRAPHICS_PROFILE_MAX_SHADER_BYTES, 'shader source'),
        hash: identityHash(shader.hash, 'shader hash'),
      };
      shaderSourceBytes += utf8Bytes(result.source);
      if (shaderSourceBytes > GRAPHICS_PROFILE_MAX_WGSL_BYTES)
        throw new Error('Graphics profile WGSL source exceeds its budget');
      const shaderKey = `${result.renderer}\u0000${result.kind}\u0000${result.key}`;
      if (shaderKeys.has(shaderKey)) throw new Error('duplicate graphics profile shader key');
      shaderKeys.add(shaderKey);
      decimalU64(shader.uses, 'shader uses');
      decimalU64(shader.generationUs, 'shader generation time');
      return result;
    });
    for (const shader of shaders) {
      if (shaderHashes.has(shader.hash)) throw new Error('duplicate graphics profile shader hash');
      shaderHashes.add(shader.hash);
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shader.source)),
      );
      const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== shader.hash) throw new Error('graphics profile shader hash mismatch');
    }
    if (
      shaders.some((shader, index) => {
        return (
          index > 0 &&
          compareRows(shader, shaders[index - 1]!, ['renderer', 'kind', 'key', 'hash']) < 0
        );
      })
    )
      throw new Error('Graphics profile shaders are not canonical');

    if (
      !Array.isArray(profile.pipelines) ||
      profile.pipelines.length > GRAPHICS_PROFILE_MAX_PIPELINES
    )
      throw new Error('Graphics profile pipeline count exceeds its budget');
    const pipelineKeys = new Set<string>();
    const pipelines = profile.pipelines.map((value: unknown) => {
      const pipeline = exactObject(
        value,
        ['renderer', 'key', 'shaderHash', 'descriptor', 'uses', 'prepareUs', 'draws'],
        'Graphics profile pipeline',
      );
      const shaderHash = identityHash(pipeline.shaderHash, 'pipeline shader hash');
      if (!shaderHashes.has(shaderHash))
        throw new Error('graphics profile references unknown shader');
      const result = {
        renderer: boundedString(
          pipeline.renderer,
          GRAPHICS_PROFILE_MAX_STRING_BYTES,
          'pipeline renderer',
        ),
        key: boundedString(pipeline.key, GRAPHICS_PROFILE_MAX_KEY_BYTES, 'pipeline key'),
        shaderHash,
        descriptor: canonicalDescriptor(pipeline.descriptor),
      };
      const pipelineKey = `${result.renderer}\u0000${result.key}`;
      if (pipelineKeys.has(pipelineKey)) throw new Error('duplicate graphics profile pipeline key');
      pipelineKeys.add(pipelineKey);
      decimalU64(pipeline.uses, 'pipeline uses');
      decimalU64(pipeline.prepareUs, 'pipeline preparation time');
      decimalU64(pipeline.draws, 'pipeline draws');
      return result;
    });
    if (
      pipelines.some((pipeline, index) => {
        return (
          index > 0 &&
          compareRows(pipeline, pipelines[index - 1]!, [
            'renderer',
            'key',
            'shaderHash',
            'descriptor',
          ]) < 0
        );
      })
    )
      throw new Error('Graphics profile pipelines are not canonical');

    const counters = exactObject(
      profile.counters,
      [
        'frames',
        'drawCalls',
        'shaderCacheHits',
        'shaderCacheMisses',
        'pipelineCacheHits',
        'pipelineCacheMisses',
        'shaderRecords',
        'pipelineRecords',
        'droppedRecords',
      ],
      'Graphics profile counters',
    );
    for (const key of Object.keys(counters)) decimalU64(counters[key], `counter ${key}`);
    if (
      counters.shaderRecords !== String(shaders.length) ||
      counters.pipelineRecords !== String(pipelines.length)
    )
      throw new Error('Graphics profile record counters do not match rows');
    const completeness = exactObject(
      profile.completeness,
      ['complete', 'counterOverflow', 'deviceLost', 'unsupported'],
      'Graphics profile completeness',
    );
    if (Object.values(completeness).some((value) => typeof value !== 'boolean'))
      throw new Error('Invalid graphics profile completeness');
    if (
      completeness.complete &&
      (completeness.counterOverflow ||
        completeness.deviceLost ||
        completeness.unsupported ||
        counters.droppedRecords !== '0')
    )
      throw new Error('Complete graphics profile reports incomplete data');
    if (!Array.isArray(profile.caveats) || profile.caveats.length > GRAPHICS_PROFILE_MAX_CAVEATS)
      throw new Error('Graphics profile caveat count exceeds its budget');
    const caveats = profile.caveats.map((value: unknown) =>
      boundedString(value, GRAPHICS_PROFILE_MAX_CAVEAT_BYTES, 'caveat'),
    );
    if (caveats.some((value, index) => index > 0 && value <= caveats[index - 1]))
      throw new Error('Graphics profile caveats are not canonical');
    if (text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`)
      throw new Error('Graphics profile JSON is not canonical');
    if (pointer.shaderCount !== shaders.length || pointer.pipelineCount !== pipelines.length)
      throw new Error('graphics profile pointer counts do not match JSON');
    const shaderSources = new Map<string, string>();
    for (const shader of shaders) {
      if (shader.renderer === 'ddraw' && shader.kind === 'ffp')
        shaderSources.set(shader.key, shader.source);
    }
    // A profile pipeline descriptor is only a candidate. The DDraw pipeline
    // factory rechecks its state key, target/depth format, and MSAA count
    // before using it; malformed or mismatched rows stay on ordinary
    // BottleShip descriptor generation.
    const pipelineDescriptors = new Map<string, PreparedGraphicsPipeline>();
    for (const pipeline of pipelines) {
      if (pipeline.renderer !== 'ddraw' || pipeline.key.length > GRAPHICS_PROFILE_MAX_KEY_BYTES)
        continue;
      const prepared = preparedGraphicsPipeline(pipeline.descriptor);
      if (!prepared || pipelineDescriptors.size >= GRAPHICS_PROFILE_MAX_PIPELINES) continue;
      pipelineDescriptors.set(pipeline.key, prepared);
    }
    (globalThis as any).__gameboxGraphicsProfile = {
      prepared: true,
      status: 'loaded',
      gameContentHash: catalog.gameContentHash,
      runtime: {
        wasmSha256: runtime.wasmSha256,
        javascriptSha256: runtime.javascriptSha256,
        graphicsRecipe: runtime.graphicsRecipe ?? 'graphics-recipe-v1',
        abiVersion: runtime.graphicsAbiVersion ?? 1,
      },
      shaderSources,
      pipelineDescriptors,
    };
    return {
      status: 'loaded',
      path: pointer.path,
      sha256: pointer.sha256,
      scenario,
      shaderCount: shaders.length,
      pipelineCount: pipelines.length,
      complete: completeness.complete,
      runtimeMatches: true,
      hydrated: false,
      hydratedShaderSources: shaderSources.size,
      hydratedPipelineDescriptors: pipelineDescriptors.size,
    };
  } catch (error) {
    return {
      status: 'skipped',
      reason: `graphics profile skipped: ${String(error)}`,
      hydrated: false,
    };
  }
}

/** The profile is advisory. It cannot change guest state, API bindings, or CPU options. */
async function loadProfile(
  archive: ZipArchive,
  catalog: GameboxCatalog,
  runtime: PreparedRuntimeIdentity,
): Promise<Status> {
  if (!catalog.cpuProfile) return { status: 'absent' };
  try {
    const profile = object(await readGameboxJson(archive, catalog.cpuProfile));
    if (
      (profile.version !== 1 && profile.version !== 4) ||
      profile.gameContentHash !== catalog.gameContentHash ||
      typeof profile.scenario !== 'string' ||
      profile.scenario.length > 256 ||
      !Array.isArray(profile.jitConfig) ||
      profile.jitConfig.length !== 22 ||
      profile.jitConfig.some(
        (v: unknown) => !Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff,
      )
    ) {
      throw new Error('CPU profile identity or configuration mismatch');
    }
    const memoryObservation =
      profile.version === 4 ? validateCpuMemoryObservation(profile.memoryObservation) : null;
    const limits: Record<string, number> = {
      modules: 4096,
      watchedPages: 64,
      blocks: 8192,
      edges: 16384,
      indirects: 8192,
      win32: 8192,
      translations: 8192,
      caveats: 64,
    };
    for (const [key, limit] of Object.entries(limits)) {
      if (!Array.isArray(profile[key]) || profile[key].length > limit)
        throw new Error(`CPU profile ${key} exceeds its budget`);
    }
    const sources = new Set(Array.from(catalog.files.values(), (file) => file.sourceHash));
    for (const module of profile.modules) {
      if (
        !sources.has(module.sourceSha256) ||
        !Number.isInteger(module.base) ||
        module.base < 0 ||
        !Number.isInteger(module.size) ||
        module.size <= 0 ||
        module.base + module.size > 0x100000000
      )
        throw new Error('CPU profile module is outside the game');
    }
    // Retain a compact diagnostic summary; all trace selection happened in the offline optimizer.
    return {
      status: 'loaded',
      scenario: profile.scenario,
      modules: profile.modules.length,
      blocks: profile.blocks.length,
      edges: profile.edges.length,
      indirects: profile.indirects.length,
      runtimeMatches:
        profile.runtimeWasmSha256 === runtime.wasmSha256 &&
        profile.runtimeJavascriptSha256 === runtime.javascriptSha256,
      ...(memoryObservation
        ? {
            memoryObservation,
          }
        : {}),
    };
  } catch (error) {
    return { status: 'skipped', reason: String(error) };
  }
}

/** Validate optimized artifact source bindings before handing the index to the AOT preflight. */
async function validateOptimizedBinding(
  archive: ZipArchive,
  catalog: GameboxCatalog,
  runtime: PreparedRuntimeIdentity,
): Promise<{
  error?: string;
  baseJitConfig?: number[];
  effectiveJitConfig?: number[];
}> {
  if (!catalog.optimized) return {};
  try {
    const manifest = object(await readGameboxJson(archive, catalog.optimized));
    if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.artifacts))
      return { error: 'optimized-index-invalid' };
    if (
      manifest.version === 2 &&
      (manifest.sourceBundleHash !== catalog.bundleHash ||
        manifest.runtimeWasmSha256 !== runtime.wasmSha256 ||
        manifest.runtimeJavascriptSha256 !== runtime.javascriptSha256 ||
        !HASH.test(manifest.profileSha256) ||
        !HASH.test(manifest.hotTracesSha256) ||
        typeof manifest.recipe !== 'string' ||
        !Number.isSafeInteger(manifest.memoryBytes) ||
        manifest.memoryBytes <= 0)
    )
      return { error: 'optimized-runtime-or-source-mismatch' };
    let baseJitConfig: number[] | undefined;
    let effectiveJitConfig: number[] | undefined;
    if (manifest.version === 2) {
      if (
        !Array.isArray(manifest.jitConfig) ||
        manifest.jitConfig.length !== 22 ||
        manifest.jitConfig.some(
          (value: unknown) =>
            !Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff,
        ) ||
        !Array.isArray(manifest.jitConfigOverrides) ||
        manifest.jitConfigOverrides.length > 22
      )
        return { error: 'optimized-index-invalid' };
      baseJitConfig = manifest.jitConfig.map((value: number) => value >>> 0);
      effectiveJitConfig = [...baseJitConfig];
      const configured = new Set<number>();
      for (const pair of manifest.jitConfigOverrides) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !Number.isSafeInteger(pair[0]) ||
          pair[0] < 0 ||
          pair[0] >= 22 ||
          configured.has(pair[0]) ||
          !Number.isSafeInteger(pair[1]) ||
          pair[1] < 0 ||
          pair[1] > 0xffffffff
        )
          return { error: 'optimized-index-invalid' };
        configured.add(pair[0]);
        effectiveJitConfig[pair[0]] = pair[1] >>> 0;
      }
      // Prepared region artifacts intentionally disable speculative stores;
      // enabling them requires a separately built and generation-tracked map.
      if (effectiveJitConfig[19] !== 0) return { error: 'optimized-index-invalid' };
      // Flag-local mode also needs the runtime's guarded setup path. The
      // prepared loader may retain an already active mode but must not toggle
      // it through the raw Wasm setter.
      if (effectiveJitConfig[21] !== baseJitConfig[21]) return { error: 'optimized-index-invalid' };
    }
    const sources = new Set(Array.from(catalog.files.values(), (file) => file.sourceHash));
    const seen = new Set<string>();
    for (const value of manifest.artifacts) {
      const artifact = object(value);
      if (
        typeof artifact.moduleHash !== 'string' ||
        !sources.has(artifact.moduleHash) ||
        seen.has(artifact.moduleHash)
      )
        return { error: 'optimized-module-not-in-catalog' };
      seen.add(artifact.moduleHash);
    }
    return { baseJitConfig, effectiveJitConfig };
  } catch {
    return { error: 'optimized-index-invalid' };
  }
}

function readJitConfig(cpu: any): number[] | undefined {
  const get = cpu?.wm?.exports?.get_jit_config;
  if (typeof get !== 'function') return undefined;
  return Array.from({ length: 22 }, (_, index) => Number(get(index)) >>> 0);
}

function setJitConfig(cpu: any, values: readonly number[]): boolean {
  const set = cpu?.wm?.exports?.set_jit_config;
  if (typeof set !== 'function' || values.length !== 22) return false;
  for (const [index, value] of values.entries()) set(index, value);
  return JSON.stringify(readJitConfig(cpu)) === JSON.stringify(values);
}

/** Called after mounting the catalog and before any bootloader instruction executes. */
export async function prepareGameboxRuntime(
  cpu: any,
  archive: ZipArchive,
  catalog: GameboxCatalog,
  options: PreparedRuntimeOptions = {},
) {
  const runtime =
    options.runtime ??
    (typeof __GAMEBOX_PREPARED_RUNTIME__ === 'undefined'
      ? undefined
      : __GAMEBOX_PREPARED_RUNTIME__);
  if (!runtime) throw new Error('Prepared runtime identity is unavailable');
  const preparedTrust = catalog.preparedTrust ?? { status: 'unsigned' as const };
  const trustStore =
    options.trustStore ??
    (typeof __GAMEBOX_TRUST_STORE__ === 'undefined' ? undefined : __GAMEBOX_TRUST_STORE__);
  if (trustStore !== undefined && preparedTrust.status !== 'trusted') {
    const reason =
      preparedTrust.status === 'unsigned'
        ? 'unsigned-catalog-not-authorized'
        : `catalog-signature-${preparedTrust.reason}`;
    return {
      cpuProfile: { status: 'skipped', reason: 'prepared-signature-untrusted' },
      graphicsProfile: { status: 'skipped', reason: 'prepared-signature-untrusted' },
      translationAttempts: [{ kind: 'prepared-runtime', status: 'skipped', reason }],
      translations: 'ordinary-jit-or-existing-cache',
      graphics: catalog.features.graphicsCache
        ? 'unsupported-metadata-runtime-fallback'
        : 'not-built',
      filesystem: 'stored-zip-range-index',
    };
  }
  if (preparedTrust.status === 'trusted') {
    for (const [path, expected] of [
      [catalog.optimized, catalog.optimizedSha256],
      [catalog.cpuProfile, catalog.cpuProfileSha256],
    ] as const) {
      if (!path || !expected) {
        if (path) {
          return {
            cpuProfile: { status: 'skipped', reason: 'prepared-sidecar-hash-missing' },
            graphicsProfile: { status: 'skipped', reason: 'prepared-sidecar-hash-missing' },
            translationAttempts: [
              {
                kind: 'prepared-runtime',
                status: 'skipped',
                reason: 'prepared-sidecar-hash-missing',
              },
            ],
            translations: 'ordinary-jit-or-existing-cache',
            graphics: catalog.features.graphicsCache
              ? 'unsupported-metadata-runtime-fallback'
              : 'not-built',
            filesystem: 'stored-zip-range-index',
          };
        }
        continue;
      }
      const bytes = await readGameboxJsonBytes(archive, path);
      const actual = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      if (actual !== expected) {
        return {
          cpuProfile: { status: 'skipped', reason: 'prepared-sidecar-hash-mismatch' },
          graphicsProfile: { status: 'skipped', reason: 'prepared-sidecar-hash-mismatch' },
          translationAttempts: [
            {
              kind: 'prepared-runtime',
              status: 'skipped',
              reason: 'prepared-sidecar-hash-mismatch',
            },
          ],
          translations: 'ordinary-jit-or-existing-cache',
          graphics: catalog.features.graphicsCache
            ? 'unsupported-metadata-runtime-fallback'
            : 'not-built',
          filesystem: 'stored-zip-range-index',
        };
      }
    }
  }
  const graphicsRuntime = {
    wasmSha256: runtime.wasmSha256,
    javascriptSha256: runtime.javascriptSha256,
    graphicsRecipe: runtime.graphicsRecipe ?? 'graphics-recipe-v1',
    abiVersion: runtime.graphicsAbiVersion ?? 1,
  };
  (globalThis as any).__gameboxContentHash = catalog.gameContentHash;
  (globalThis as any).__gameboxGraphicsRuntime = graphicsRuntime;
  (globalThis as any).__gameboxGraphicsScenario = 'gamebox-live';
  const trust =
    options.trustPreparedAot ??
    (preparedTrust.status === 'trusted' ||
      (typeof __GAMEBOX_TRUST_PREPARED_AOT__ !== 'undefined' && __GAMEBOX_TRUST_PREPARED_AOT__));
  const install = options.install ?? installPreparedTranslationPackage;
  const cpuProfile = await loadProfile(archive, catalog, runtime);
  const graphicsProfile = await loadGraphicsProfile(archive, catalog, runtime);
  const translationAttempts: Status[] = [];
  const indexes: PreparedAotIndex[] = [];
  const optimizedBinding = await validateOptimizedBinding(archive, catalog, runtime);
  if (optimizedBinding.error)
    translationAttempts.push({ kind: 'pgo', status: 'skipped', reason: optimizedBinding.error });
  else if (catalog.optimized) indexes.push({ kind: 'pgo', manifestPath: catalog.optimized });
  if (archive.getEntry('gamebox/translations/index.json'))
    indexes.push({
      kind: 'translation-index',
      manifestPath: 'gamebox/translations/index.json',
      artifacts: catalog.staticArtifacts,
    });
  const installed = () => ({
    ...runtime,
    memoryBytes: Number(cpu?.memory_size?.[0] ?? cpu?.memory_size ?? 0),
    jitConfig: readJitConfig(cpu) ?? [],
  });
  for (const index of indexes) {
    const originalJitConfig = readJitConfig(cpu);
    let configuredForArtifact = false;
    if (index.kind === 'pgo' && optimizedBinding.effectiveJitConfig) {
      if (!trust) {
        translationAttempts.push({
          kind: index.kind,
          status: 'skipped',
          reason: 'unsigned-local-artifacts-not-enabled',
        });
        continue;
      }
      if (
        !originalJitConfig ||
        JSON.stringify(originalJitConfig) !== JSON.stringify(optimizedBinding.baseJitConfig) ||
        !setJitConfig(cpu, optimizedBinding.effectiveJitConfig)
      ) {
        if (originalJitConfig) setJitConfig(cpu, originalJitConfig);
        translationAttempts.push({
          kind: index.kind,
          status: 'skipped',
          reason: 'runtime-config-mismatch',
        });
        continue;
      }
      configuredForArtifact = true;
    }
    const restoreConfiguration = () => {
      if (configuredForArtifact && originalJitConfig) setJitConfig(cpu, originalJitConfig);
    };
    const result = await preflightPreparedAot({
      cpu,
      index,
      installed: installed(),
      sourceBundleHash: catalog.bundleHash,
      archive: {
        read: async (path, maxBytes) => {
          const entry = archive.getEntry(path);
          if (
            !entry ||
            entry.isDirectory ||
            entry.compression !== 0 ||
            entry.uncompressedSize > maxBytes ||
            entry.uncompressedSize !== entry.compressedSize
          )
            throw new Error('Prepared AOT archive entry exceeds its budget');
          return archive.readEntry(entry);
        },
      },
    });
    if (result.status === 'skipped') {
      restoreConfiguration();
      translationAttempts.push({ kind: index.kind, status: 'skipped', reason: result.reason });
      continue;
    }
    if (!trust) {
      restoreConfiguration();
      translationAttempts.push({
        kind: index.kind,
        status: 'skipped',
        reason: 'unsigned-local-artifacts-not-enabled',
      });
      continue;
    }
    try {
      install(result.bytes);
      const artifactSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', result.bytes as BufferSource)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      translationAttempts.push({
        kind: index.kind,
        status: 'installed',
        units: result.units,
        bytes: result.artifactBytes,
        sha256: artifactSha256,
        reuse: 'native code-page and context guards still apply',
      });
      break;
    } catch (error) {
      restoreConfiguration();
      translationAttempts.push({ kind: index.kind, status: 'skipped', reason: String(error) });
    }
  }
  return {
    cpuProfile,
    graphicsProfile,
    translationAttempts,
    translations: translationAttempts.some((attempt) => attempt.status === 'installed')
      ? 'installed'
      : 'ordinary-jit-or-existing-cache',
    graphics: catalog.features.graphicsCache
      ? 'prepared-profile-candidates-with-native-fallback'
      : 'not-built',
    filesystem: 'stored-zip-range-index',
  };
}
