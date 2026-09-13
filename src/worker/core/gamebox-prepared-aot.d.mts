export interface PreparedAotArchive {
  read(path: string, maxBytes: number): Promise<Uint8Array | ArrayBuffer>;
}

export interface PreparedAotRuntime {
  wasmSha256: string;
  javascriptSha256: string;
  memoryBytes: number;
  jitConfig: readonly number[];
  recipe?: string;
}

export interface PreparedAotContextDescriptor {
  runtimeWasmSha256?: string;
  runtimeJavascriptSha256?: string;
  memoryBytes?: number;
  recipe?: string;
  jitConfigOverrides?: readonly (readonly [number, number])[];
}

export interface PreparedAotArtifactDescriptor {
  path?: string;
  moduleHash?: string;
  bytes?: number;
  sha256?: string;
}

export interface PreparedAotIndex {
  kind: 'static' | 'pgo' | 'translation-index';
  manifestPath: string;
  artifactPath?: string;
  artifactRoot?: string;
  artifacts?: readonly PreparedAotArtifactDescriptor[];
  context?: PreparedAotContextDescriptor;
}

export interface PreparedAotPreflightRequest {
  cpu: unknown;
  index: PreparedAotIndex;
  archive: PreparedAotArchive;
  installed: PreparedAotRuntime;
  sourceBundleHash?: string;
}

export type PreparedAotSkipReason =
  | 'runtime-context-unavailable'
  | 'runtime-identity-unavailable'
  | 'runtime-config-unavailable'
  | 'runtime-config-mismatch'
  | 'runtime-memory-mismatch'
  | 'runtime-wasm-mismatch'
  | 'runtime-javascript-mismatch'
  | 'runtime-recipe-mismatch'
  | 'runtime-profile-fastmem-mismatch'
  | 'artifact-context-unavailable'
  | 'source-bundle-mismatch'
  | 'invalid-index'
  | 'invalid-static-manifest'
  | 'invalid-pgo-manifest'
  | 'no-artifacts'
  | 'invalid-artifact-index'
  | 'artifact-size-mismatch'
  | 'artifact-checksum-mismatch'
  | 'artifact-memory-mismatch'
  | 'artifact-config-mismatch'
  | 'artifact-profile-fastmem-mismatch'
  | 'artifact-budget-exceeded'
  | 'invalid-artifact';

export interface PreparedAotValidated {
  status: 'validated';
  kind: PreparedAotIndex['kind'];
  bytes: Uint8Array;
  units: number;
  artifactBytes: number;
  sourceBundleHash?: string;
}

export interface PreparedAotSkipped {
  status: 'skipped';
  reason: PreparedAotSkipReason | string;
  detail?: string;
}

export type PreparedAotPreflightResult = PreparedAotValidated | PreparedAotSkipped;

export function preflightPreparedAot(
  request: PreparedAotPreflightRequest,
): Promise<PreparedAotPreflightResult>;

export const PREPARED_AOT_LIMITS: Readonly<{
  maxArtifactBytes: number;
  maxManifestBytes: number;
  maxUnits: number;
  maxUnitBytes: number;
}>;
