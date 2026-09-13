/** Opt-in, bounded observations of portable DDraw FFP shader/pipeline work. */

export const GRAPHICS_PROFILE_SCHEMA = 'gamebox-graphics-profile-1' as const;
export const GRAPHICS_PROFILE_MAX_ROWS = 2048;
// Leave room inside the 16 MiB GBXG import ceiling for JSON framing, keys,
// descriptors and metadata. Generated WGSL is the dominant payload.
export const GRAPHICS_PROFILE_MAX_WGSL_BYTES = 8 * 1024 * 1024;
export const GRAPHICS_PROFILE_MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
export const GRAPHICS_PROFILE_MAX_KEY_BYTES = 256;
export const GRAPHICS_PROFILE_MAX_SHADER_BYTES = 1024 * 1024;
export const GRAPHICS_PROFILE_MAX_DESCRIPTOR_ENTRY_BYTES = 1024 * 1024;
export const GRAPHICS_PROFILE_MAX_JSON_BYTES = 16 * 1024 * 1024;

export interface GraphicsRuntimeIdentity {
  wasmSha256: string;
  javascriptSha256: string;
  graphicsRecipe: string;
  abiVersion: number;
}
export interface GraphicsGpuRecord {
  backend?: string;
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  colorFormat?: string;
  depthFormat?: string;
  sampleCount?: number;
  features?: string[];
  limits?: Array<{ name: string; value: number }>;
}
export interface GraphicsProfileStartOptions {
  gameContentHash: string;
  runtime: GraphicsRuntimeIdentity;
  scenario: string;
  gpu?: GraphicsGpuRecord;
}
interface ShaderRow {
  key: string;
  source: string;
  uses: number;
  generationMs: number;
}
interface PipelineRow {
  key: string;
  shaderConfigKey: string;
  descriptor: string;
  uses: number;
  prepareMs: number;
  draws: number;
}
interface MutableProfile {
  droppedRecords: number;
  shaderRecords: number;
  pipelineRecords: number;
  wgslBytes: number;
  descriptorBytes: number;
  drawCalls: number;
  shaderCacheHits: number;
  shaderCacheMisses: number;
  pipelineCacheHits: number;
  pipelineCacheMisses: number;
  counterOverflow: boolean;
  unsupported: boolean;
  caveats: string[];
}
export interface GraphicsProfile {
  version: 1;
  gameContentHash: string;
  runtime: GraphicsRuntimeIdentity;
  scenario: string;
  durationMs: string;
  gpu: {
    backend: string;
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    colorFormat: string;
    depthFormat: string;
    sampleCount: number;
    features: string[];
    limits: Array<{ name: string; value: number }>;
  };
  shaders: Array<{
    renderer: string;
    kind: string;
    key: string;
    source: string;
    hash: string;
    uses: string;
    generationUs: string;
  }>;
  pipelines: Array<{
    renderer: string;
    key: string;
    shaderHash: string;
    descriptor: string;
    uses: string;
    prepareUs: string;
    draws: string;
  }>;
  counters: {
    frames: string;
    drawCalls: string;
    shaderCacheHits: string;
    shaderCacheMisses: string;
    pipelineCacheHits: string;
    pipelineCacheMisses: string;
    shaderRecords: string;
    pipelineRecords: string;
    droppedRecords: string;
  };
  completeness: {
    complete: boolean;
    counterOverflow: boolean;
    deviceLost: boolean;
    unsupported: boolean;
  };
  caveats: string[];
}
function emptyProfile(): MutableProfile {
  return {
    droppedRecords: 0,
    shaderRecords: 0,
    pipelineRecords: 0,
    wgslBytes: 0,
    descriptorBytes: 0,
    drawCalls: 0,
    shaderCacheHits: 0,
    shaderCacheMisses: 0,
    pipelineCacheHits: 0,
    pipelineCacheMisses: 0,
    counterOverflow: false,
    unsupported: false,
    caveats: ['Initial DDraw slice does not sample frame counters'],
  };
}
function add(value: number, increment: number, profile: MutableProfile): number {
  const next = value + Math.max(0, increment);
  if (!Number.isSafeInteger(next) || next > Number.MAX_SAFE_INTEGER) profile.counterOverflow = true;
  return Math.min(Number.MAX_SAFE_INTEGER, next);
}
function duration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
function addDuration(value: number, increment: number, profile: MutableProfile): number {
  const next = value + duration(increment);
  if (!Number.isFinite(next) || next * 1000 > Number.MAX_SAFE_INTEGER)
    profile.counterOverflow = true;
  return Math.min(Number.MAX_SAFE_INTEGER / 1000, next);
}
function micros(value: number): string {
  return Math.round(duration(value) * 1000).toString(10);
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function sha256Identity(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
function defaultGpu() {
  return {
    backend: 'webgpu',
    vendor: 'unknown',
    architecture: 'unknown',
    device: 'unknown',
    description: 'unknown',
    colorFormat: 'unknown',
    depthFormat: 'unknown',
    sampleCount: 1,
    features: [] as string[],
    limits: [] as Array<{ name: string; value: number }>,
  };
}
function boundedGpuString(value: string | undefined, fallback: string, field: string): string {
  const result = value ?? fallback;
  if (!result || bytes(result) > 256) throw new Error(`Invalid ${field}`);
  return result;
}
function normalizeGpu(update: GraphicsGpuRecord, base = defaultGpu()) {
  const sampleCount = update.sampleCount ?? base.sampleCount;
  if (![1, 2, 4, 8].includes(sampleCount)) throw new Error('Invalid GPU sample count');
  const features = [...new Set(update.features ?? base.features)].sort();
  if (features.length > 64 || features.some((value) => !value || bytes(value) > 256))
    throw new Error('Invalid GPU features');
  const limits = [...(update.limits ?? base.limits)];
  if (
    limits.length > 64 ||
    limits.some(
      (row) =>
        !row.name || bytes(row.name) > 256 || !Number.isSafeInteger(row.value) || row.value < 0,
    ) ||
    new Set(limits.map((row) => row.name)).size !== limits.length
  )
    throw new Error('Invalid GPU limits');
  limits.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    backend: boundedGpuString(update.backend, base.backend, 'GPU backend'),
    vendor: boundedGpuString(update.vendor, base.vendor, 'GPU vendor'),
    architecture: boundedGpuString(update.architecture, base.architecture, 'GPU architecture'),
    device: boundedGpuString(update.device, base.device, 'GPU device'),
    description: boundedGpuString(update.description, base.description, 'GPU description'),
    colorFormat: boundedGpuString(update.colorFormat, base.colorFormat, 'GPU color format'),
    depthFormat: boundedGpuString(update.depthFormat, base.depthFormat, 'GPU depth format'),
    sampleCount,
    features,
    limits,
  };
}
function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite descriptor number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object') throw new Error('Unsupported descriptor value');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
  }
  return result;
}
function cloneJson(value: Record<string, unknown>): { source: string; bytes: number } | null {
  try {
    const source = JSON.stringify(canonicalJsonValue(value));
    return source === undefined ? null : { source, bytes: bytes(source) };
  } catch {
    return null;
  }
}
async function sha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export class GraphicsProfileCollector {
  private active = false;
  private startedAt = 0;
  private identity: GraphicsProfileStartOptions | null = null;
  private gpu = defaultGpu();
  private state = emptyProfile();
  private shaders = new Map<string, ShaderRow>();
  private pipelines = new Map<string, PipelineRow>();
  private finishedProfile: GraphicsProfile | null = null;
  isActive(): boolean {
    return this.active;
  }
  start(options: GraphicsProfileStartOptions): void {
    if (
      !options?.gameContentHash ||
      !sha256Identity(options.gameContentHash) ||
      !sha256Identity(options.runtime?.wasmSha256 ?? '') ||
      !sha256Identity(options.runtime?.javascriptSha256 ?? '') ||
      !options.runtime?.graphicsRecipe ||
      bytes(options.runtime.graphicsRecipe) > 256 ||
      !Number.isSafeInteger(options.runtime.abiVersion) ||
      options.runtime.abiVersion <= 0 ||
      !options.scenario ||
      bytes(options.scenario) > 256
    )
      throw new Error('Complete trusted graphics profile identity is required');
    const gpu = normalizeGpu(options.gpu ?? {});
    this.reset();
    this.identity = { ...options, runtime: { ...options.runtime } };
    this.gpu = gpu;
    this.startedAt = performance.now();
    this.active = true;
  }
  reset(): void {
    this.active = false;
    this.startedAt = 0;
    this.identity = null;
    this.gpu = defaultGpu();
    this.state = emptyProfile();
    this.shaders.clear();
    this.pipelines.clear();
    this.finishedProfile = null;
  }
  cancel(): void {
    this.reset();
  }
  setGpu(update: GraphicsGpuRecord): void {
    if (!this.active) return;
    try {
      this.gpu = normalizeGpu(update, this.gpu);
    } catch {
      this.state.unsupported = true;
      this.drop('invalid GPU identity metadata');
    }
  }
  recordShader(key: string, source: string, generationMs: number, cacheHit = false): void {
    if (!this.active) return;
    const existing = this.shaders.get(key);
    if (existing) {
      if (existing.source !== source) {
        this.state.unsupported = true;
        this.drop('shader key resolved to different WGSL');
        return;
      }
      existing.uses = add(existing.uses, 1, this.state);
      existing.generationMs = addDuration(existing.generationMs, generationMs, this.state);
      if (cacheHit) this.state.shaderCacheHits = add(this.state.shaderCacheHits, 1, this.state);
      else this.state.shaderCacheMisses = add(this.state.shaderCacheMisses, 1, this.state);
      return;
    }
    const sourceBytes = bytes(source);
    if (
      bytes(key) > GRAPHICS_PROFILE_MAX_KEY_BYTES ||
      sourceBytes > GRAPHICS_PROFILE_MAX_SHADER_BYTES ||
      this.shaders.size + this.pipelines.size >= GRAPHICS_PROFILE_MAX_ROWS ||
      this.state.wgslBytes + sourceBytes > GRAPHICS_PROFILE_MAX_WGSL_BYTES
    ) {
      this.drop('shader record budget exceeded');
      return;
    }
    this.shaders.set(key, { key, source, uses: 1, generationMs: duration(generationMs) });
    this.state.shaderRecords = add(this.state.shaderRecords, 1, this.state);
    this.state.wgslBytes = add(this.state.wgslBytes, sourceBytes, this.state);
    if (cacheHit) this.state.shaderCacheHits = add(this.state.shaderCacheHits, 1, this.state);
    else this.state.shaderCacheMisses = add(this.state.shaderCacheMisses, 1, this.state);
  }
  recordPipeline(
    key: string,
    descriptor: Record<string, unknown>,
    shaderConfigKey: string,
    prepareMs: number,
    draws = 1,
    cacheHit = false,
  ): void {
    if (!this.active) return;
    const existing = this.pipelines.get(key);
    const snapshot = cloneJson(descriptor);
    if (existing) {
      if (
        !snapshot ||
        existing.shaderConfigKey !== shaderConfigKey ||
        existing.descriptor !== snapshot.source
      ) {
        this.state.unsupported = true;
        this.drop('pipeline key resolved to different preparation data');
        return;
      }
      existing.uses = add(existing.uses, 1, this.state);
      existing.draws = add(existing.draws, draws, this.state);
      existing.prepareMs = addDuration(existing.prepareMs, prepareMs, this.state);
      if (cacheHit) this.state.pipelineCacheHits = add(this.state.pipelineCacheHits, 1, this.state);
      else this.state.pipelineCacheMisses = add(this.state.pipelineCacheMisses, 1, this.state);
      this.state.drawCalls = add(this.state.drawCalls, draws, this.state);
      return;
    }
    if (
      !snapshot ||
      bytes(key) > GRAPHICS_PROFILE_MAX_KEY_BYTES ||
      bytes(shaderConfigKey) > GRAPHICS_PROFILE_MAX_KEY_BYTES ||
      snapshot.bytes > GRAPHICS_PROFILE_MAX_DESCRIPTOR_ENTRY_BYTES ||
      this.shaders.size + this.pipelines.size >= GRAPHICS_PROFILE_MAX_ROWS ||
      this.state.descriptorBytes + snapshot.bytes > GRAPHICS_PROFILE_MAX_DESCRIPTOR_BYTES
    ) {
      this.drop('pipeline descriptor budget exceeded');
      return;
    }
    this.pipelines.set(key, {
      key,
      shaderConfigKey,
      descriptor: snapshot.source,
      uses: 1,
      prepareMs: duration(prepareMs),
      draws: Math.max(0, draws),
    });
    this.state.pipelineRecords = add(this.state.pipelineRecords, 1, this.state);
    this.state.descriptorBytes = add(this.state.descriptorBytes, snapshot.bytes, this.state);
    this.state.drawCalls = add(this.state.drawCalls, draws, this.state);
    if (cacheHit) this.state.pipelineCacheHits = add(this.state.pipelineCacheHits, 1, this.state);
    else this.state.pipelineCacheMisses = add(this.state.pipelineCacheMisses, 1, this.state);
  }
  private drop(caveat: string): void {
    this.state.droppedRecords = add(this.state.droppedRecords, 1, this.state);
    if (this.state.caveats.length < 64 && !this.state.caveats.includes(caveat))
      this.state.caveats.push(caveat);
  }
  async finish(): Promise<GraphicsProfile> {
    if (!this.active || !this.identity)
      throw new Error('No active graphics profile is available to finish');
    const hashes = new Map<string, string>();
    for (const row of this.shaders.values()) {
      try {
        hashes.set(row.key, await sha256(row.source));
      } catch {
        this.state.unsupported = true;
        this.drop('WebCrypto SHA-256 unavailable; shader rows omitted');
      }
    }
    const shaders = [...this.shaders.values()]
      .filter((row) => hashes.has(row.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => ({
        renderer: 'ddraw',
        kind: 'ffp',
        key: row.key,
        source: row.source,
        hash: hashes.get(row.key)!,
        uses: Math.trunc(row.uses).toString(10),
        generationUs: micros(row.generationMs),
      }));
    const pipelines = [...this.pipelines.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .flatMap((row) => {
        const shaderHash = hashes.get(row.shaderConfigKey);
        if (!shaderHash) {
          this.drop('pipeline has no captured shader observation');
          return [];
        }
        return [
          {
            renderer: 'ddraw',
            key: row.key,
            shaderHash,
            descriptor: row.descriptor,
            uses: Math.trunc(row.uses).toString(10),
            prepareUs: micros(row.prepareMs),
            draws: Math.trunc(row.draws).toString(10),
          },
        ];
      });
    const state = this.state;
    const result: GraphicsProfile = {
      version: 1,
      gameContentHash: this.identity.gameContentHash,
      runtime: { ...this.identity.runtime },
      scenario: this.identity.scenario,
      durationMs: Math.round(duration(performance.now() - this.startedAt)).toString(10),
      gpu: { ...this.gpu, features: [...this.gpu.features], limits: [...this.gpu.limits] },
      shaders,
      pipelines,
      counters: {
        frames: '0',
        drawCalls: Math.trunc(state.drawCalls).toString(10),
        shaderCacheHits: Math.trunc(state.shaderCacheHits).toString(10),
        shaderCacheMisses: Math.trunc(state.shaderCacheMisses).toString(10),
        pipelineCacheHits: Math.trunc(state.pipelineCacheHits).toString(10),
        pipelineCacheMisses: Math.trunc(state.pipelineCacheMisses).toString(10),
        shaderRecords: shaders.length.toString(10),
        pipelineRecords: pipelines.length.toString(10),
        droppedRecords: Math.trunc(state.droppedRecords).toString(10),
      },
      completeness: {
        complete: state.droppedRecords === 0 && !state.counterOverflow && !state.unsupported,
        counterOverflow: state.counterOverflow,
        deviceLost: false,
        unsupported: state.unsupported,
      },
      caveats: [...state.caveats].sort(),
    };
    if (bytes(JSON.stringify(result)) > GRAPHICS_PROFILE_MAX_JSON_BYTES) {
      state.droppedRecords = add(
        state.droppedRecords,
        result.shaders.length + result.pipelines.length,
        state,
      );
      result.shaders = [];
      result.pipelines = [];
      result.counters.shaderRecords = '0';
      result.counters.pipelineRecords = '0';
      result.counters.droppedRecords = Math.trunc(state.droppedRecords).toString(10);
      result.completeness.complete = false;
      if (!state.caveats.includes('serialized graphics profile budget exceeded'))
        state.caveats.push('serialized graphics profile budget exceeded');
      result.caveats = [...state.caveats].sort();
    }
    this.active = false;
    this.finishedProfile = result;
    return result;
  }
  toJSON(): string {
    return JSON.stringify(this.finishedProfile ?? { ...this.state });
  }
}
export const graphicsProfile = new GraphicsProfileCollector();
