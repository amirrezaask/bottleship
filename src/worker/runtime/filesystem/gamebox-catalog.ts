import {
  SyncHttpRangeSource,
  type ZipArchive,
  type ZipEntry,
  type ZipEntryPrefetchRange,
  type ZipPrefetchResult,
} from '@bottleship/formats/zip';
import type { PeImageSource, PreparedPeDescriptor } from '../../core/pe-loader';

export const GAMEBOX_CHUNK_BYTES = 256 * 1024;
/** Canonical optional sidecar emitted by the GameBox runtime exporter. */
export const GAMEBOX_FILESYSTEM_PRIORITY_PATH = 'gamebox/filesystem/priority.json';
export const GAMEBOX_FILESYSTEM_PROFILE_PATH = 'gamebox/profiles/filesystem.json';
/** Canonical optional graphics advisory emitted by the GameBox runtime exporter. */
export const GAMEBOX_GRAPHICS_PROFILE_PATH = 'gamebox/profiles/gpu.json';
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024 * 1024;
const MAX_PRIORITY_ENTRIES = 65_530;
const MAX_FILESYSTEM_PROFILE_OBSERVATIONS = 4096;
const MAX_FILESYSTEM_PROFILE_RANGES = 32_768;
export const GAMEBOX_FILESYSTEM_PREWARM_BYTES = 32 * 1024 * 1024;
const MAX_GRAPHICS_SHADERS = 8192;
const MAX_GRAPHICS_PIPELINES = 16_384;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_KEY_ID_BYTES = 128;
const MAX_TRUSTED_KEYS = 64;
const SIGNATURE_DOMAIN = new TextEncoder().encode('GameBox directory bundle signature\0v1');
const RUNTIME_SIGNATURE_DOMAIN = new TextEncoder().encode('GameBox runtime catalog signature\0v1');

/**
 * Explicit, local-only trust configuration for prepared runtime artifacts.
 * Values are lowercase-hex Ed25519 public keys; callers must provide the
 * complete bounded map. No network lookup or key discovery is performed.
 */
export type GameboxTrustStore = Readonly<Record<string, string>>;

export type GameboxPreparedTrust =
  | { status: 'unsigned' }
  | { status: 'trusted'; keyId: string }
  | { status: 'untrusted'; reason: string; keyId?: string };

function printableKeyId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_ID_BYTES)
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function hexBytes(value: string, expectedBytes: number, label: string): Uint8Array {
  const expectedLength = expectedBytes * 2;
  if (
    value.length !== expectedLength ||
    !new RegExp(`^[0-9a-f]{${expectedLength}}$`, 'u').test(value)
  )
    throw new Error(`Invalid GameBox ${label}`);
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index++)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function trustStoreKey(store: GameboxTrustStore | undefined, keyId: string): string | undefined {
  if (!store) return undefined;
  if (typeof store !== 'object' || Array.isArray(store))
    throw new Error('Invalid GameBox trust store');
  const ids = Object.keys(store);
  if (ids.length > MAX_TRUSTED_KEYS) throw new Error('GameBox trust store exceeds its key budget');
  for (const id of ids) {
    if (!printableKeyId(id)) throw new Error('Invalid GameBox trust-store key ID');
    const key = store[id];
    if (typeof key !== 'string') throw new Error('Invalid GameBox trust-store public key');
    hexBytes(key, 32, 'trust-store public key');
  }
  return store[keyId];
}

/** Verify the exact domain-separated directory-bundle signature emitted by Rust. */
export async function verifyGameboxSignature(
  bundleHash: string,
  sourceFormatVersion: number,
  signature: string,
  keyId: string,
  trustStore?: GameboxTrustStore,
): Promise<GameboxPreparedTrust> {
  if (
    !HASH.test(bundleHash) ||
    !Number.isSafeInteger(sourceFormatVersion) ||
    sourceFormatVersion < 1 ||
    sourceFormatVersion > 0xffffffff
  ) {
    return { status: 'untrusted', reason: 'invalid-signed-bundle-root' };
  }
  if (!printableKeyId(keyId)) return { status: 'untrusted', reason: 'invalid-key-id', keyId };
  if (!SIGNATURE.test(signature))
    return { status: 'untrusted', reason: 'invalid-signature', keyId };
  let publicKeyHex: string | undefined;
  try {
    publicKeyHex = trustStoreKey(trustStore, keyId);
  } catch (error) {
    return {
      status: 'untrusted',
      reason: error instanceof Error ? error.message : String(error),
      keyId,
    };
  }
  if (!publicKeyHex) return { status: 'untrusted', reason: 'trusted-key-not-found', keyId };
  try {
    const message = new Uint8Array(SIGNATURE_DOMAIN.length + 4 + 32);
    message.set(SIGNATURE_DOMAIN);
    new DataView(message.buffer).setUint32(SIGNATURE_DOMAIN.length, sourceFormatVersion, true);
    message.set(hexBytes(bundleHash, 32, 'bundle hash'), SIGNATURE_DOMAIN.length + 4);
    const key = await crypto.subtle.importKey(
      'raw',
      hexBytes(publicKeyHex, 32, 'public key') as BufferSource,
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      key,
      hexBytes(signature, 64, 'signature') as BufferSource,
      message as BufferSource,
    );
    return valid
      ? { status: 'trusted', keyId }
      : { status: 'untrusted', reason: 'signature-verification-failed', keyId };
  } catch (error) {
    // Older browsers may not expose WebCrypto Ed25519. Prepared code must not
    // be installed in that case; the ordinary raw ROM path remains usable.
    return { status: 'untrusted', reason: 'signature-verification-unavailable', keyId };
  }
}

/** Verify a runtime-export signature over the exact raw catalog.json bytes. */
export async function verifyRuntimeCatalogSignature(
  catalogBytes: Uint8Array,
  signature: string,
  keyId: string,
  trustStore?: GameboxTrustStore,
): Promise<GameboxPreparedTrust> {
  if (!SIGNATURE.test(signature))
    return { status: 'untrusted', reason: 'invalid-signature', keyId };
  if (!printableKeyId(keyId)) return { status: 'untrusted', reason: 'invalid-key-id', keyId };
  let publicKeyHex: string | undefined;
  try {
    publicKeyHex = trustStoreKey(trustStore, keyId);
  } catch (error) {
    return {
      status: 'untrusted',
      reason: error instanceof Error ? error.message : String(error),
      keyId,
    };
  }
  if (!publicKeyHex) return { status: 'untrusted', reason: 'trusted-key-not-found', keyId };
  try {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', catalogBytes as BufferSource),
    );
    const message = new Uint8Array(RUNTIME_SIGNATURE_DOMAIN.length + 4 + digest.length);
    message.set(RUNTIME_SIGNATURE_DOMAIN);
    new DataView(message.buffer).setUint32(RUNTIME_SIGNATURE_DOMAIN.length, 1, true);
    message.set(digest, RUNTIME_SIGNATURE_DOMAIN.length + 4);
    const key = await crypto.subtle.importKey(
      'raw',
      hexBytes(publicKeyHex, 32, 'public key') as BufferSource,
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      key,
      hexBytes(signature, 64, 'signature') as BufferSource,
      message as BufferSource,
    );
    return valid
      ? { status: 'trusted', keyId }
      : { status: 'untrusted', reason: 'signature-verification-failed', keyId };
  } catch {
    return { status: 'untrusted', reason: 'signature-verification-unavailable', keyId };
  }
}

export interface GameboxMarker {
  formatVersion: 1;
  bundleHash: string;
  catalog: 'gamebox/catalog.json';
  /** Signature over the exact raw catalog bytes, emitted by runtime export. */
  signature?: string;
  keyId?: string;
}
export interface GameboxFile {
  path: string;
  sourceHash: string;
  sourceBytes: number;
  chunkSize: number;
  chunkHashes: string[];
  /** Same-origin immutable content-addressed source for a thin title layer. */
  blob?: string;
  prepared?: PreparedPeDescriptor;
  fallbackReason?: string;
}
export interface GameboxImage {
  source: PeImageSource;
  descriptor?: PreparedPeDescriptor;
  fallbackReason?: string;
}
export interface GameboxPriorityEntry {
  path: string;
  priority: number;
  /** Explicit rank wins over first-access order when both are present. */
  rank: number;
  firstAccessOrder?: number;
}
interface GameboxFilesystemProfilePointer {
  path: typeof GAMEBOX_FILESYSTEM_PROFILE_PATH;
  sha256: string;
  observationCount: number;
  rangeCount: number;
}
interface GameboxFilesystemWarmRange extends ZipEntryPrefetchRange {
  firstAccessOrder: number;
  reads: number;
}
export interface GameboxGraphicsProfilePointer {
  path: typeof GAMEBOX_GRAPHICS_PROFILE_PATH;
  sha256: string;
  shaderCount: number;
  pipelineCount: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid GameBox metadata object');
  return value as Record<string, unknown>;
}
function relativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Invalid GameBox file path');
  // Keep control characters out of paths without relying on a control-character
  // regexp (which is rejected by the repository's lint policy).
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || value[index] === '\\' || value[index] === ':')
      throw new Error('Invalid GameBox file path');
  }
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value))
    throw new Error('Invalid GameBox content hash');
  return value;
}
function sharedBlob(value: unknown, sourceHash: string): string | undefined {
  if (value === undefined) return undefined;
  if (value !== `/shared/blobs/${sourceHash}`)
    throw new Error('Invalid GameBox shared blob identity');
  return value;
}
/** Route verified CAS identities through the hosting game's authorization endpoint.
 * Only the transport path changes; hash/signature/chunk checks and bounded reads remain. */
export function gameboxBlobTransport(blob: string, base?: string): string {
  if (!/^\/shared\/blobs\/[0-9a-f]{64}$/.test(blob))
    throw new Error('Invalid GameBox shared blob identity');
  if (base === undefined) return blob;
  if (typeof base !== 'string' || !/^\/shared\/games\/[a-z0-9][a-z0-9-]{0,63}\/blobs\/$/.test(base))
    throw new Error('Invalid GameBox shared blob transport');
  return base + blob.slice('/shared/blobs/'.length);
}
function registerExternalArtifacts(
  archive: ZipArchive,
  value: unknown,
  formatVersion: unknown,
  sharedBlobBase?: string,
): void {
  if (value === undefined) return;
  if (formatVersion !== 2 || !Array.isArray(value) || value.length > 4096)
    throw new Error('Invalid external artifact count');
  for (const raw of value) {
    const artifact = record(raw);
    const path = relativePath(artifact.path);
    const sourceHash = hash(artifact.sourceHash);
    const sourceBytes = size(artifact.sourceBytes);
    const blob = artifact.blob;
    if (
      (!path.startsWith('gamebox/optimized/') &&
        !/^gamebox\/translations\/[0-9a-f]{64}\.aot$/u.test(path)) ||
      blob !== `/shared/blobs/${sourceHash}` ||
      archive.getEntry(path)
    )
      throw new Error('Invalid external artifact binding');
    archive.registerExternalStoredEntry(
      path,
      SyncHttpRangeSource.fromKnownSize(gameboxBlobTransport(blob, sharedBlobBase), sourceBytes),
    );
  }
}
function size(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new Error('Invalid GameBox file size');
  }
  return value;
}

function uint32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error(`Invalid GameBox PE ${label}`);
  return value;
}

/** Validate the shape and bounds of prepared PE metadata before retaining it. */
function preparedDescriptor(
  value: unknown,
  sourceHash: string,
  sourceBytes: number,
  path: string,
): PreparedPeDescriptor {
  const descriptor = record(value);
  if (descriptor.sourceHash !== sourceHash || descriptor.sourceBytes !== sourceBytes)
    throw new Error(`Invalid GameBox PE binding: ${path}`);
  const preferredBase = uint32(descriptor.preferredBase, 'preferred base');
  const entrypointRva = uint32(descriptor.entrypointRva, 'entrypoint RVA');
  const imageSize = uint32(descriptor.imageSize, 'image size');
  const headerSize = uint32(descriptor.headerSize, 'header size');
  if (!imageSize || !headerSize || headerSize > imageSize || entrypointRva >= imageSize)
    throw new Error(`Invalid GameBox PE image bounds: ${path}`);
  if (!Array.isArray(descriptor.sections) || descriptor.sections.length > 96)
    throw new Error(`Invalid GameBox PE sections: ${path}`);
  const sections = descriptor.sections.map((value) => {
    const section = record(value);
    const name = section.name;
    if (typeof name !== 'string' || name.length > 8)
      throw new Error(`Invalid GameBox PE section name: ${path}`);
    const virtualAddress = uint32(section.virtualAddress, 'section RVA');
    const virtualSize = uint32(section.virtualSize, 'section virtual size');
    const rawOffset = uint32(section.rawOffset, 'section file offset');
    const rawSize = uint32(section.rawSize, 'section raw size');
    const characteristics = uint32(section.characteristics, 'section characteristics');
    const mappedSize = Math.max(virtualSize, rawSize);
    if (
      rawSize > sourceBytes - Math.min(rawOffset, sourceBytes) ||
      mappedSize > imageSize - Math.min(virtualAddress, imageSize) ||
      (mappedSize > 0 && virtualAddress < headerSize)
    )
      throw new Error(`Invalid GameBox PE section bounds: ${path}`);
    return { name, virtualAddress, virtualSize, rawOffset, rawSize, characteristics };
  });
  const ranges = sections
    .filter((section) => Math.max(section.virtualSize, section.rawSize) > 0)
    .map((section) => ({
      start: section.virtualAddress,
      end: section.virtualAddress + Math.max(section.virtualSize, section.rawSize),
    }))
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    const current = ranges[index];
    const previous = ranges[index - 1];
    if (!current || !previous) throw new Error(`Invalid GameBox PE section ranges: ${path}`);
    if (current.start < previous.end)
      throw new Error(`Invalid GameBox PE section overlap: ${path}`);
  }
  if (!Array.isArray(descriptor.dataDirectories) || descriptor.dataDirectories.length > 16)
    throw new Error(`Invalid GameBox PE directories: ${path}`);
  const dataDirectories = descriptor.dataDirectories.map((value) => {
    const directory = record(value);
    const virtualAddress = uint32(directory.virtualAddress, 'directory RVA');
    const directorySize = uint32(directory.size, 'directory size');
    if (virtualAddress > imageSize || directorySize > imageSize - virtualAddress)
      throw new Error(`Invalid GameBox PE directory bounds: ${path}`);
    return { virtualAddress, size: directorySize };
  });
  return {
    sourceHash,
    sourceBytes,
    preferredBase,
    entrypointRva,
    imageSize,
    headerSize,
    sections,
    dataDirectories,
  };
}

function boundedInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid GameBox filesystem priority ${label}`);
    }
    return value;
  }
  // Rust's human-readable serde representation uses decimal strings for u64
  // fields. Accept only canonical unsigned decimals so JSON cannot smuggle a
  // sign, exponent, leading zero, or an imprecise value across the boundary.
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Invalid GameBox filesystem priority ${label}`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('out of range');
    }
    return Number(parsed);
  } catch {
    throw new Error(`Invalid GameBox filesystem priority ${label}`);
  }
}

function optionalHash(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !HASH.test(value))
    throw new Error(`Invalid GameBox filesystem priority ${label}`);
  return value;
}

function optionalPriorityPointer(
  value: unknown,
): { path: string; sha256: string; entryCount: number } | undefined {
  if (value === undefined) return undefined;
  const pointer = record(value);
  if (typeof pointer.path !== 'string') throw new Error('Invalid GameBox filesystem priority path');
  const sha256 = optionalHash(pointer.sha256 ?? pointer.contentHash, 'content hash');
  if (sha256 === undefined) throw new Error('Missing GameBox filesystem priority content hash');
  if (pointer.entryCount === undefined)
    throw new Error('Missing GameBox filesystem priority entry count');
  const entryCount = boundedInteger(pointer.entryCount, 'entry count');
  return { path: pointer.path, sha256, entryCount };
}

function optionalFilesystemProfilePointer(
  value: unknown,
): GameboxFilesystemProfilePointer | undefined {
  if (value === undefined) return undefined;
  const pointer = record(value);
  if (pointer.path !== GAMEBOX_FILESYSTEM_PROFILE_PATH)
    throw new Error(`expected ${GAMEBOX_FILESYSTEM_PROFILE_PATH}`);
  const observationCount = boundedInteger(pointer.observationCount, 'profile observation count');
  const rangeCount = boundedInteger(pointer.rangeCount, 'profile range count');
  if (
    observationCount > MAX_FILESYSTEM_PROFILE_OBSERVATIONS ||
    rangeCount > MAX_FILESYSTEM_PROFILE_RANGES
  )
    throw new Error('filesystem profile exceeds the runtime warm-set bound');
  return {
    path: GAMEBOX_FILESYSTEM_PROFILE_PATH,
    sha256: hash(pointer.sha256),
    observationCount,
    rangeCount,
  };
}

function optionalGraphicsProfilePointer(value: unknown): GameboxGraphicsProfilePointer | undefined {
  if (value === undefined) return undefined;
  const pointer = record(value);
  if (pointer.path !== GAMEBOX_GRAPHICS_PROFILE_PATH)
    throw new Error(`expected ${GAMEBOX_GRAPHICS_PROFILE_PATH}`);
  const sha256 = hash(pointer.sha256);
  const count = (candidate: unknown, label: string): number => {
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      candidate > Number.MAX_SAFE_INTEGER
    )
      throw new Error(`Invalid GameBox graphics profile ${label}`);
    return candidate;
  };
  const shaderCount = count(pointer.shaderCount, 'shader count');
  const pipelineCount = count(pointer.pipelineCount, 'pipeline count');
  if (shaderCount > MAX_GRAPHICS_SHADERS || pipelineCount > MAX_GRAPHICS_PIPELINES)
    throw new Error('graphics profile count exceeds its budget');
  return { path: GAMEBOX_GRAPHICS_PROFILE_PATH, sha256, shaderCount, pipelineCount };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadFilesystemPriority(
  archive: ZipArchive,
  pointerValue: unknown,
  gameContentHash: string,
  files: ReadonlyMap<string, GameboxFile>,
): Promise<{ entries: ReadonlyMap<string, GameboxPriorityEntry>; skipped?: string }> {
  const empty = new Map<string, GameboxPriorityEntry>();
  if (pointerValue === undefined) return { entries: empty };
  try {
    const pointer = optionalPriorityPointer(pointerValue);
    if (!pointer || pointer.path !== GAMEBOX_FILESYSTEM_PRIORITY_PATH) {
      throw new Error(`expected ${GAMEBOX_FILESYSTEM_PRIORITY_PATH}`);
    }
    const bytes = await readGameboxJsonBytes(archive, pointer.path);
    if (pointer.sha256 !== (await sha256Hex(bytes))) {
      throw new Error('content hash mismatch');
    }
    const metadata = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (metadata.version !== 1 || metadata.gameContentHash !== gameContentHash) {
      throw new Error('identity mismatch');
    }
    if (metadata.recipe !== 'filesystem-priority-v1-scenario-tier-first-access') {
      throw new Error('unsupported recipe');
    }
    if (!Array.isArray(metadata.entries) || metadata.entries.length > MAX_PRIORITY_ENTRIES) {
      throw new Error('invalid entry count');
    }
    if (pointer.entryCount !== undefined && pointer.entryCount !== metadata.entries.length) {
      throw new Error('pointer entry count mismatch');
    }
    const entries = new Map<string, GameboxPriorityEntry>();
    const observedOrders = new Set<number>();
    for (const value of metadata.entries) {
      const item = record(value);
      const path = relativePath(item.path);
      const key = path.toLowerCase();
      if (entries.has(key) || !files.has(key))
        throw new Error(`invalid or colliding priority path: ${path}`);
      const priority = boundedInteger(item.priority, 'tier');
      if (priority > 3) throw new Error(`priority tier out of range: ${path}`);
      const firstAccessOrder =
        item.firstAccessOrder === undefined || item.firstAccessOrder === null
          ? undefined
          : boundedInteger(item.firstAccessOrder, 'first access order');
      if (firstAccessOrder !== undefined && !observedOrders.add(firstAccessOrder))
        throw new Error(`duplicate first access order: ${path}`);
      const explicitRank = item.rank === undefined ? undefined : boundedInteger(item.rank, 'rank');
      entries.set(key, {
        path,
        priority,
        rank: explicitRank ?? firstAccessOrder ?? Number.MAX_SAFE_INTEGER,
        ...(firstAccessOrder === undefined ? {} : { firstAccessOrder }),
      });
    }
    if (entries.size !== files.size)
      throw new Error('priority entry count does not match bundle files');
    return { entries };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: empty, skipped: `filesystem priority skipped: ${message}` };
  }
}

async function loadFilesystemWarmSet(
  archive: ZipArchive,
  pointer: GameboxFilesystemProfilePointer,
  gameContentHash: string,
  files: ReadonlyMap<string, GameboxFile>,
  priorities: ReadonlyMap<string, GameboxPriorityEntry>,
): Promise<GameboxFilesystemWarmRange[]> {
  const bytes = await readGameboxJsonBytes(archive, pointer.path);
  if (pointer.sha256 !== (await sha256Hex(bytes))) throw new Error('content hash mismatch');
  const profile = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (profile.version !== 1 || profile.gameContentHash !== gameContentHash)
    throw new Error('identity mismatch');
  if (
    !Array.isArray(profile.observations) ||
    profile.observations.length !== pointer.observationCount
  )
    throw new Error('observation count mismatch');
  const counters = record(profile.counters);
  if (
    boundedInteger(counters.droppedEvents ?? 0, 'profile dropped event count') !== 0 ||
    counters.counterOverflow === true
  )
    throw new Error('profile has incomplete observations');

  const byFile: GameboxFilesystemWarmRange[][] = [];
  const observedPaths = new Set<string>();
  let rangeCount = 0;
  for (const value of profile.observations) {
    const observation = record(value);
    const path = relativePath(observation.path);
    const key = path.toLowerCase();
    const file = files.get(key);
    const priority = priorities.get(key);
    if (!file || !priority || observedPaths.has(key))
      throw new Error(`invalid or colliding profile path: ${path}`);
    observedPaths.add(key);
    const firstAccessOrder = boundedInteger(
      observation.firstAccessOrder,
      'profile first access order',
    );
    if (priority.firstAccessOrder !== firstAccessOrder)
      throw new Error(`profile priority order mismatch: ${path}`);
    if (!Array.isArray(observation.ranges)) throw new Error(`invalid profile ranges: ${path}`);
    rangeCount += observation.ranges.length;
    if (rangeCount > MAX_FILESYSTEM_PROFILE_RANGES)
      throw new Error('filesystem profile exceeds the runtime range bound');
    const entry = archive.getEntry(`assets/${file.path}`);
    if (!entry || entry.isDirectory || entry.compression !== 0)
      throw new Error(`profile entry is not a stored asset: ${path}`);
    const ranges = observation.ranges.map((rangeValue) => {
      const range = record(rangeValue);
      const offset = boundedInteger(range.offset, 'profile range offset');
      const length = boundedInteger(range.length, 'profile range length');
      const reads = boundedInteger(range.reads, 'profile range read count');
      if (length === 0 || reads === 0 || offset > file.sourceBytes - length)
        throw new Error(`profile range exceeds source: ${path}`);
      return { entry, offset, length, firstAccessOrder, reads };
    });
    ranges.sort((a, b) => b.reads - a.reads || a.offset - b.offset || a.length - b.length);
    if (ranges.length > 0) byFile.push(ranges);
  }
  if (rangeCount !== pointer.rangeCount) throw new Error('range count mismatch');
  byFile.sort((a, b) => a[0]!.firstAccessOrder - b[0]!.firstAccessOrder);

  // Give every observed file one early range before ranking the remainder by
  // reuse. This prevents one large container from consuming the entire source
  // cache budget while keeping repeated launch reads first.
  const warm = byFile.map((ranges) => ranges[0]!);
  const remaining = byFile.flatMap((ranges) => ranges.slice(1));
  remaining.sort(
    (a, b) =>
      b.reads - a.reads ||
      a.firstAccessOrder - b.firstAccessOrder ||
      a.entry.name.localeCompare(b.entry.name) ||
      a.offset - b.offset ||
      a.length - b.length,
  );
  return warm.concat(remaining);
}
export async function readGameboxJson(
  archive: ZipArchive,
  path: string,
  limit = MAX_CATALOG_BYTES,
): Promise<unknown> {
  const bytes = await readGameboxJsonBytes(archive, path, limit);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export async function readGameboxJsonBytes(
  archive: ZipArchive,
  path: string,
  limit = MAX_CATALOG_BYTES,
): Promise<Uint8Array> {
  const entry = archive.getEntry(path);
  if (
    !entry ||
    entry.isDirectory ||
    entry.compression !== 0 ||
    entry.uncompressedSize > limit ||
    entry.uncompressedSize !== entry.compressedSize
  )
    throw new Error(`Invalid or oversized GameBox metadata: ${path}`);
  const bytes = await archive.readEntry(entry);
  if (bytes.length !== entry.uncompressedSize)
    throw new Error(`Truncated GameBox metadata: ${path}`);
  return bytes;
}

interface ExportedChecksumRecord {
  path: string;
  size: number;
  sha256: string;
}

function exportedChecksumRecords(bytes: Uint8Array): ExportedChecksumRecord[] {
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'GBXC')
    throw new Error('Invalid exported GameBox checksum table');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  const u32 = () => {
    if (offset + 4 > bytes.length) throw new Error('Truncated exported checksum table');
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const string = () => {
    const length = u32();
    if (!length || length > 4096 || offset + length > bytes.length)
      throw new Error('Invalid exported checksum path');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset, offset + length),
    );
    offset += length;
    return value;
  };
  if (u32() !== 1) throw new Error('Unsupported exported checksum table version');
  const directories = u32();
  if (directories > 65_530) throw new Error('Exported checksum directory budget exceeded');
  for (let index = 0; index < directories; index++) string();
  const count = u32();
  if (count > 65_530) throw new Error('Exported checksum file budget exceeded');
  const records: ExportedChecksumRecord[] = [];
  for (let index = 0; index < count; index++) {
    const path = string();
    if (offset + 8 + 32 + 2 > bytes.length) throw new Error('Truncated exported checksum record');
    const sizeBig = view.getBigUint64(offset, true);
    offset += 8;
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Exported checksum size is unsafe');
    const sha256 = Array.from(bytes.subarray(offset, offset + 32), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    offset += 32;
    const kind = bytes[offset++];
    const hasPe = bytes[offset++];
    if (kind === undefined || hasPe === undefined || kind > 8 || hasPe > 1)
      throw new Error('Invalid exported checksum record');
    if (hasPe) {
      if (offset + 6 > bytes.length) throw new Error('Truncated exported PE checksum record');
      offset += 6;
    }
    records.push({ path, size: Number(sizeBig), sha256 });
  }
  if (offset !== bytes.length) throw new Error('Trailing exported checksum table data');
  return records;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function verifyExportedSourceRoot(
  archive: ZipArchive,
  bundleHash: string,
  sourceFormatVersion: number,
  signature: string | undefined,
  keyId: string | undefined,
  rawCatalog: Record<string, unknown>,
): Promise<void> {
  const checksumBytes = await readGameboxJsonBytes(
    archive,
    'gamebox/checksums.bin',
    MAX_CHECKSUM_BYTES,
  );
  if ((await sha256Hex(checksumBytes)) !== bundleHash)
    throw new Error('exported checksum root mismatch');
  const records = exportedChecksumRecords(checksumBytes);
  const objects = new Map<string, number>();
  for (const record of records) {
    if (record.path.startsWith('objects/')) {
      const objectHash = record.path.slice('objects/'.length);
      if (!HASH.test(objectHash) || objectHash !== record.sha256)
        throw new Error('exported object checksum identity mismatch');
      objects.set(objectHash, record.size);
      continue;
    }
    const entry = archive.getEntry(`gamebox/${record.path}`);
    if (
      !entry ||
      entry.isDirectory ||
      entry.compression !== 0 ||
      entry.uncompressedSize !== record.size
    )
      throw new Error(`missing exported source artifact: ${record.path}`);
    const bytes = await archive.readEntry(entry);
    if ((await sha256Hex(bytes)) !== record.sha256)
      throw new Error(`exported source artifact mismatch: ${record.path}`);
  }
  const sourceManifest = record(await readGameboxJson(archive, 'gamebox/manifest.json'));
  const sourceGame = record(sourceManifest.game);
  if (
    sourceManifest.formatVersion !== sourceFormatVersion ||
    sourceGame.contentHash !== hash(rawCatalog.gameContentHash) ||
    sourceGame.id !== rawCatalog.gameId ||
    sourceGame.entrypoint !== rawCatalog.entrypoint ||
    stableJson(sourceManifest.features) !== stableJson(rawCatalog.features)
  )
    throw new Error('exported catalog/manifest semantic mismatch');
  const sourceInventory = record(await readGameboxJson(archive, 'gamebox/inventory.json'));
  if (!Array.isArray(sourceInventory.files) || !Array.isArray(rawCatalog.files))
    throw new Error('missing exported catalog or inventory file list');
  const inventoryFiles = new Map<string, { path: string; hash: string; size: number }>();
  for (const value of sourceInventory.files) {
    const item = record(value);
    const path = relativePath(item.path);
    const itemHash = hash(item.sha256);
    const itemSize = boundedInteger(item.size, 'source size');
    const key = path.toLowerCase();
    if (inventoryFiles.has(key)) throw new Error('duplicate authenticated inventory path');
    inventoryFiles.set(key, { path, hash: itemHash, size: itemSize });
  }
  if (inventoryFiles.size !== rawCatalog.files.length)
    throw new Error('exported catalog/inventory file count mismatch');
  const catalogObjects = new Map<string, number>();
  for (const value of rawCatalog.files) {
    const item = record(value);
    const path = relativePath(item.path);
    const objectHash = hash(item.sourceHash);
    const objectSize = size(item.sourceBytes);
    const expected = inventoryFiles.get(path.toLowerCase());
    if (
      !expected ||
      expected.path !== path ||
      expected.hash !== objectHash ||
      expected.size !== objectSize
    )
      throw new Error(`exported catalog/inventory binding mismatch: ${path}`);
    catalogObjects.set(objectHash, objectSize);
  }
  if (catalogObjects.size !== objects.size) throw new Error('exported catalog object set mismatch');
  for (const [objectHash, objectSize] of objects) {
    if (catalogObjects.get(objectHash) !== objectSize)
      throw new Error('exported catalog object binding mismatch');
  }
  const expectedStatic = new Map<string, { bytes: number; sha256: string }>();
  for (const item of records) {
    const match = /^translations\/([0-9a-f]{64})\.aot$/u.exec(item.path);
    if (match) expectedStatic.set(match[1]!, { bytes: item.size, sha256: item.sha256 });
  }
  const actualStatic = new Map<string, { bytes: number; sha256: string }>();
  const staticArtifacts = rawCatalog.staticArtifacts;
  if (staticArtifacts !== undefined) {
    if (!Array.isArray(staticArtifacts)) throw new Error('invalid exported static artifact list');
    for (const value of staticArtifacts) {
      const item = record(value);
      const moduleHash = hash(item.moduleHash);
      const bytes = size(item.bytes);
      const sha256 = hash(item.sha256);
      if (actualStatic.has(moduleHash)) throw new Error('duplicate exported static artifact');
      actualStatic.set(moduleHash, { bytes, sha256 });
    }
  }
  if (actualStatic.size !== expectedStatic.size)
    throw new Error('exported static artifact set mismatch');
  for (const [moduleHash, expected] of expectedStatic) {
    const actual = actualStatic.get(moduleHash);
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error('exported static artifact binding mismatch');
  }
  const integrityValue = record(await readGameboxJson(archive, 'gamebox/integrity.json'));
  if (
    integrityValue.formatVersion !== sourceFormatVersion ||
    integrityValue.bundleHash !== bundleHash ||
    (integrityValue.signature ?? undefined) !== signature ||
    (integrityValue.keyId ?? undefined) !== keyId
  )
    throw new Error('exported integrity/catalog identity mismatch');
}

/** Source catalog for the existing stored-ZIP VFS. It owns no resident game-file cache. */
export class GameboxCatalog {
  private disposed = false;
  private reading = false;
  private constructor(
    private archive: ZipArchive,
    readonly bundleHash: string,
    readonly sourceFormatVersion: number | undefined,
    readonly signature: string | undefined,
    readonly keyId: string | undefined,
    readonly preparedTrust: GameboxPreparedTrust,
    readonly gameId: string,
    readonly entrypoint: string,
    readonly gameContentHash: string,
    readonly optimized: string | undefined,
    readonly optimizedSha256: string | undefined,
    readonly cpuProfile: string | undefined,
    readonly cpuProfileSha256: string | undefined,
    readonly files: ReadonlyMap<string, GameboxFile>,
    private readonly romEntries: ReadonlyMap<string, ZipEntry>,
    readonly features: Readonly<Record<string, unknown>>,
    readonly staticArtifacts: ReadonlyArray<{ moduleHash: string; bytes: number; sha256: string }>,
    readonly filesystemPriority: ReadonlyMap<string, GameboxPriorityEntry>,
    readonly filesystemPrioritySkipped?: string,
    private readonly filesystemWarmSet: ReadonlyArray<GameboxFilesystemWarmRange> = [],
    readonly filesystemWarmSetSkipped?: string,
    readonly graphicsProfile?: GameboxGraphicsProfilePointer,
    readonly graphicsProfileSkipped?: string,
  ) {}

  static async open(
    archive: ZipArchive,
    markerValue: unknown,
    romRoot: string,
    trustStore?: GameboxTrustStore,
    sharedBlobBase?: string,
  ): Promise<GameboxCatalog> {
    const marker = record(markerValue);
    if (
      marker.formatVersion !== 1 ||
      marker.catalog !== 'gamebox/catalog.json' ||
      romRoot !== 'assets'
    ) {
      throw new Error('Unsupported GameBox runtime transport');
    }
    const bundleHash = hash(marker.bundleHash);
    const catalogBytes = await readGameboxJsonBytes(archive, marker.catalog);
    const catalog = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)),
    );
    if (
      (catalog.formatVersion !== 1 && catalog.formatVersion !== 2) ||
      catalog.bundleHash !== bundleHash ||
      typeof catalog.gameId !== 'string' ||
      catalog.gameId.length > 256 ||
      !Array.isArray(catalog.files) ||
      catalog.files.length > 65530
    ) {
      throw new Error('Invalid GameBox catalog identity or file count');
    }
    registerExternalArtifacts(archive, catalog.externalArtifacts, catalog.formatVersion, sharedBlobBase);
    const sourceFormatVersion =
      catalog.sourceFormatVersion === undefined
        ? undefined
        : uint32(catalog.sourceFormatVersion, 'source format version');
    const signature = typeof catalog.signature === 'string' ? catalog.signature : undefined;
    const keyId = typeof catalog.keyId === 'string' ? catalog.keyId : undefined;
    let preparedTrust: GameboxPreparedTrust;
    if (marker.signature === undefined && marker.keyId === undefined) {
      preparedTrust = { status: 'unsigned' };
    } else if (typeof marker.signature !== 'string' || typeof marker.keyId !== 'string') {
      preparedTrust = { status: 'untrusted', reason: 'incomplete-runtime-signature' };
    } else {
      preparedTrust = await verifyRuntimeCatalogSignature(
        catalogBytes,
        marker.signature,
        marker.keyId,
        trustStore,
      );
    }
    if (preparedTrust.status === 'trusted') {
      // Runtime signatures authenticate transformed catalog semantics. Keep
      // the source-root check below as an additional provenance check, but do
      // not allow it to replace the raw-catalog signature.
      try {
        if (sourceFormatVersion === undefined || signature === undefined || keyId === undefined)
          throw new Error('runtime catalog is missing source-root metadata');
        await verifyExportedSourceRoot(
          archive,
          bundleHash,
          sourceFormatVersion,
          signature,
          keyId,
          catalog,
        );
      } catch (error) {
        preparedTrust = {
          status: 'untrusted',
          reason:
            error instanceof Error ? `exported-root-${error.message}` : 'exported-root-invalid',
          keyId,
        };
      }
    }
    const entrypoint = relativePath(catalog.entrypoint);
    const files = new Map<string, GameboxFile>();
    for (const value of catalog.files) {
      const item = record(value);
      const path = relativePath(item.path);
      const sourceHash = hash(item.sourceHash);
      const sourceBytes = size(item.sourceBytes);
      if (
        item.chunkSize !== GAMEBOX_CHUNK_BYTES ||
        !Array.isArray(item.chunkHashes) ||
        item.chunkHashes.length !== Math.ceil(sourceBytes / GAMEBOX_CHUNK_BYTES)
      )
        throw new Error(`Invalid GameBox chunks: ${path}`);
      const chunkHashes = item.chunkHashes.map(hash);
      const blob = sharedBlob(item.blob, sourceHash);
      if (blob && catalog.formatVersion !== 2)
        throw new Error(`Shared GameBox object requires catalog format 2: ${path}`);
      const key = path.toLowerCase();
      if (blob)
        archive.registerExternalStoredEntry(
          `assets/${path}`,
          SyncHttpRangeSource.fromKnownSize(gameboxBlobTransport(blob, sharedBlobBase), sourceBytes),
        );
      const entry = archive.getEntry(`assets/${path}`);
      if (
        files.has(key) ||
        !entry ||
        entry.isDirectory ||
        entry.compression !== 0 ||
        entry.uncompressedSize !== sourceBytes ||
        entry.compressedSize !== sourceBytes
      )
        throw new Error(`Invalid GameBox object: ${path}`);
      let prepared: PreparedPeDescriptor | undefined;
      if (item.prepared !== undefined) {
        // PELoader checks the source header again before mapping. Keep the
        // catalog-side validation strict too, so malformed metadata cannot be
        // retained and only discovered after the runtime has started loading.
        prepared = preparedDescriptor(item.prepared, sourceHash, sourceBytes, path);
      }
      if (
        item.fallbackReason !== undefined &&
        (typeof item.fallbackReason !== 'string' || item.fallbackReason.length > 4096)
      ) {
        throw new Error(`Invalid GameBox fallback reason: ${path}`);
      }
      files.set(key, {
        path,
        sourceHash,
        sourceBytes,
        chunkSize: GAMEBOX_CHUNK_BYTES,
        chunkHashes,
        blob,
        prepared,
        fallbackReason: item.fallbackReason as string | undefined,
      });
    }
    const assetNames = new Set<string>();
    const assetKinds = new Map<string, 'file' | 'directory'>();
    const romEntries = new Map<string, ZipEntry>();
    for (const entry of archive.listEntries()) {
      if (!entry.name.startsWith('assets/')) continue;
      const relative = entry.name.slice(7);
      if (entry.isDirectory) {
        const path = relativePath(relative.replace(/\/$/, ''));
        const key = path.toLowerCase();
        if (assetKinds.has(key)) throw new Error(`Colliding GameBox object: ${entry.name}`);
        assetKinds.set(key, 'directory');
        // Keep the trailing slash: buildRomIndex(..., includeDirectories=true)
        // exposes directory entries with the same relative spelling.
        romEntries.set(relative, entry);
        continue;
      }
      {
        const key = relative.toLowerCase();
        if (assetNames.has(key)) throw new Error(`Duplicate GameBox object: ${entry.name}`);
        assetNames.add(key);
        if (assetKinds.has(key)) throw new Error(`Colliding GameBox object: ${entry.name}`);
        assetKinds.set(key, 'file');
        if (!files.has(key)) throw new Error(`Unindexed GameBox object: ${entry.name}`);
        romEntries.set(relative, entry);
      }
    }
    if (!files.has(entrypoint.toLowerCase())) throw new Error('GameBox entrypoint is absent');
    if (
      catalog.staticArtifacts !== undefined &&
      (!Array.isArray(catalog.staticArtifacts) || catalog.staticArtifacts.length > 2048)
    )
      throw new Error('Invalid static artifact count');
    const moduleHashes = new Set(Array.from(files.values(), (file) => file.sourceHash));
    const staticArtifacts = ((catalog.staticArtifacts as unknown[] | undefined) ?? []).map(
      (value) => {
        const artifact = record(value);
        const moduleHash = hash(artifact.moduleHash);
        const bytes = size(artifact.bytes);
        if (!moduleHashes.has(moduleHash) || bytes < 8 || bytes > 96 * 1024 * 1024)
          throw new Error('Invalid static artifact binding');
        return { moduleHash, bytes, sha256: hash(artifact.sha256) };
      },
    );
    if (catalog.optimized !== undefined && catalog.optimized !== 'gamebox/optimized/manifest.json')
      throw new Error('Invalid GameBox optimized index');
    if (catalog.cpuProfile !== undefined && catalog.cpuProfile !== 'gamebox/profiles/cpu.json')
      throw new Error('Invalid GameBox CPU profile');
    const priority = await loadFilesystemPriority(
      archive,
      catalog.filesystemPriority ?? catalog.filesystem_priority,
      hash(catalog.gameContentHash),
      files,
    );
    let filesystemProfilePointer: GameboxFilesystemProfilePointer | undefined;
    let filesystemWarmSetSkipped: string | undefined;
    if (typeof catalog.filesystemProfile === 'string') {
      if (catalog.filesystemProfile !== GAMEBOX_FILESYSTEM_PROFILE_PATH)
        throw new Error('Invalid GameBox filesystem profile');
      filesystemWarmSetSkipped =
        'filesystem warm set skipped: legacy profile pointer has no content binding';
    } else {
      try {
        filesystemProfilePointer = optionalFilesystemProfilePointer(catalog.filesystemProfile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        filesystemWarmSetSkipped = `filesystem warm set skipped: ${message}`;
      }
    }
    let filesystemWarmSet: GameboxFilesystemWarmRange[] = [];
    if (filesystemProfilePointer && priority.entries.size > 0) {
      try {
        filesystemWarmSet = await loadFilesystemWarmSet(
          archive,
          filesystemProfilePointer,
          hash(catalog.gameContentHash),
          files,
          priority.entries,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        filesystemWarmSetSkipped = `filesystem warm set skipped: ${message}`;
      }
    } else if (filesystemProfilePointer && !filesystemWarmSetSkipped) {
      filesystemWarmSetSkipped =
        'filesystem warm set skipped: verified filesystem priority is unavailable';
    }
    let graphicsProfile: GameboxGraphicsProfilePointer | undefined;
    let graphicsProfileSkipped: string | undefined;
    try {
      graphicsProfile = optionalGraphicsProfilePointer(catalog.graphicsProfile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      graphicsProfileSkipped = `graphics profile skipped: ${message}`;
    }
    return new GameboxCatalog(
      archive,
      bundleHash,
      sourceFormatVersion,
      signature,
      keyId,
      preparedTrust,
      catalog.gameId,
      entrypoint,
      hash(catalog.gameContentHash),
      catalog.optimized as string | undefined,
      optionalHash(catalog.optimizedSha256, 'optimized index hash'),
      catalog.cpuProfile as string | undefined,
      optionalHash(catalog.cpuProfileSha256, 'CPU profile hash'),
      files,
      romEntries,
      record(catalog.features),
      staticArtifacts,
      priority.entries,
      priority.skipped,
      filesystemWarmSet,
      filesystemWarmSetSkipped,
      graphicsProfile,
      graphicsProfileSkipped,
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  /**
   * Return the VFS ROM index assembled while validating the catalog.
   *
   * GameBox catalogs have already validated every file's archive binding and
   * every explicit directory by the time this is called. Returning a copy
   * keeps callers from mutating the catalog's trusted snapshot and, unlike
   * buildRomIndex(), does not enumerate the ZIP central directory again.
   */
  buildRomIndex(): Map<string, ZipEntry> {
    if (this.disposed) throw new Error('GameBox catalog is closed');
    return new Map(this.romEntries);
  }

  /** Start bounded source-cache warming from compiler-observed read coverage.
   * The returned promise may run beside guest startup; it never retains a
   * whole asset or widens the source cache's fixed memory budget. */
  prewarmFilesystem(maxBytes = GAMEBOX_FILESYSTEM_PREWARM_BYTES): Promise<ZipPrefetchResult> {
    if (this.disposed) throw new Error('GameBox catalog is closed');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > GAMEBOX_FILESYSTEM_PREWARM_BYTES
    )
      throw new Error('Invalid GameBox filesystem prewarm budget');
    return this.archive.prefetchEntryRanges(this.filesystemWarmSet, maxBytes);
  }

  /**
   * Reorder an already-filtered phase-1 candidate list. The priority sidecar
   * can never add candidates, so malformed or missing advisory metadata keeps
   * the existing deterministic archive order.
   */
  orderPrefetchCandidates(paths: readonly string[]): string[] {
    if (this.disposed) throw new Error('GameBox catalog is closed');
    if (this.filesystemPriority.size === 0) return [...paths];
    return paths
      .map((path, index) => ({
        path,
        index,
        priority: this.filesystemPriority.get(path.toLowerCase()),
      }))
      .sort((a, b) => {
        const ap = a.priority;
        const bp = b.priority;
        const at = ap?.priority ?? 3;
        const bt = bp?.priority ?? 3;
        return (
          at - bt ||
          (ap?.rank ?? Number.MAX_SAFE_INTEGER) - (bp?.rank ?? Number.MAX_SAFE_INTEGER) ||
          a.path.toLowerCase().localeCompare(b.path.toLowerCase()) ||
          a.path.localeCompare(b.path) ||
          a.index - b.index
        );
      })
      .map((item) => item.path);
  }

  image(path: string): GameboxImage | null {
    if (this.disposed) throw new Error('GameBox catalog is closed');
    const file = this.files.get(
      path
        .replace(/\\/g, '/')
        .replace(/^[Cc]:\//, '')
        .toLowerCase(),
    );
    if (!file) return null;
    const entry = this.archive.getEntry(`assets/${file.path}`)!;
    return {
      source: {
        size: file.sourceBytes,
        readRange: (offset, length) => this.readVerified(file, entry, offset, length),
      },
      descriptor: file.prepared,
      fallbackReason:
        file.fallbackReason ??
        (file.prepared ? undefined : 'No prepared PE metadata; using the runtime parser'),
    };
  }

  private async readVerified(
    file: GameboxFile,
    entry: ZipEntry,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (this.disposed) throw new Error('GameBox catalog is closed');
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > GAMEBOX_CHUNK_BYTES ||
      offset + length > file.sourceBytes
    )
      throw new Error('GameBox range exceeds source or staging budget');
    // Loader reads are sequential, including recursive imports. Refuse accidental fan-out.
    if (this.reading) throw new Error('Concurrent GameBox PE reads exceed the staging budget');
    this.reading = true;
    try {
      const result = new Uint8Array(length);
      let cursor = offset;
      while (cursor < offset + length) {
        const chunkIndex = Math.floor(cursor / GAMEBOX_CHUNK_BYTES);
        const start = chunkIndex * GAMEBOX_CHUNK_BYTES;
        const chunkLength = Math.min(GAMEBOX_CHUNK_BYTES, file.sourceBytes - start);
        const bytes = await this.archive.readEntryRange(entry, start, chunkLength);
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
        );
        const actual = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
        if (this.disposed) throw new Error('GameBox catalog is closed');
        if (bytes.length !== chunkLength || actual !== file.chunkHashes[chunkIndex])
          throw new Error(`GameBox source chunk failed integrity: ${file.path}:${chunkIndex}`);
        const count = Math.min(start + chunkLength, offset + length) - cursor;
        result.set(bytes.subarray(cursor - start, cursor - start + count), cursor - offset);
        cursor += count;
      }
      return result;
    } finally {
      this.reading = false;
    }
  }
}
