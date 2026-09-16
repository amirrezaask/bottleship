import { describe, expect, test } from 'bun:test';
import { buildZip } from '@bottleship/formats/wgb/zip-build';
import { BufferSource, ZipArchive } from '@bottleship/formats/zip';
import {
  GAMEBOX_CHUNK_BYTES as CHUNK,
  GAMEBOX_GRAPHICS_PROFILE_PATH,
  GAMEBOX_FILESYSTEM_PREWARM_BYTES,
  GAMEBOX_FILESYSTEM_PROFILE_PATH,
  GAMEBOX_FILESYSTEM_PRIORITY_PATH,
  GameboxCatalog,
  gameboxBlobTransport,
  verifyGameboxSignature,
  verifyRuntimeCatalogSignature,
} from '../../src/worker/runtime/filesystem/gamebox-catalog';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { WgbLoader, buildRomIndex } from '../../src/worker/runtime/filesystem/wgb-loader';
import { WgbCache } from '../../src/worker/runtime/filesystem/wgb-cache';
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
async function signRoot(root: string, formatVersion: number): Promise<string> {
  const seed = new Uint8Array(32).fill(7);
  const pkcs8 = new Uint8Array(16 + seed.length);
  pkcs8.set(
    Uint8Array.from([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
    ]),
  );
  pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'Ed25519' } as AlgorithmIdentifier,
    false,
    ['sign'],
  );
  const domain = new TextEncoder().encode('GameBox directory bundle signature\0v1');
  const message = new Uint8Array(domain.length + 4 + 32);
  message.set(domain);
  new DataView(message.buffer).setUint32(domain.length, formatVersion, true);
  message.set(
    Uint8Array.from(root.match(/../gu)!, (pair) => Number.parseInt(pair, 16)),
    domain.length + 4,
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' } as AlgorithmIdentifier,
        key,
        message as BufferSource,
      ),
    ),
  );
}
async function signCatalog(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const domain = new TextEncoder().encode('GameBox runtime catalog signature\0v1');
  const message = new Uint8Array(domain.length + 4 + digest.length);
  message.set(domain);
  new DataView(message.buffer).setUint32(domain.length, 1, true);
  message.set(digest, domain.length + 4);
  const seed = new Uint8Array(32).fill(7);
  const pkcs8 = new Uint8Array(16 + seed.length);
  pkcs8.set(
    Uint8Array.from([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
    ]),
  );
  pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'Ed25519' } as AlgorithmIdentifier,
    false,
    ['sign'],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' } as AlgorithmIdentifier,
        key,
        message as BufferSource,
      ),
    ),
  );
}
function checksumTable(records: Array<{ sourceHash: string; sourceBytes: number }>): Uint8Array {
  const paths = records.map(({ sourceHash }) => new TextEncoder().encode(`objects/${sourceHash}`));
  const payloadBytes = paths.reduce((total, path) => total + 4 + path.length + 8 + 32 + 2, 0);
  const result = new Uint8Array(4 + 4 + 4 + 4 + payloadBytes);
  const view = new DataView(result.buffer);
  result.set(new TextEncoder().encode('GBXC'));
  view.setUint32(4, 1, true);
  view.setUint32(8, 0, true);
  view.setUint32(12, records.length, true);
  let offset = 16;
  records.forEach(({ sourceHash, sourceBytes }, index) => {
    const path = paths[index]!;
    view.setUint32(offset, path.length, true);
    offset += 4;
    result.set(path, offset);
    offset += path.length;
    view.setBigUint64(offset, BigInt(sourceBytes), true);
    offset += 8;
    result.set(
      Uint8Array.from(sourceHash.match(/../gu)!, (pair) => Number.parseInt(pair, 16)),
      offset,
    );
    offset += 32;
    result[offset++] = 0;
    result[offset++] = 0;
  });
  return result;
}
async function fixture(
  change?: (
    catalog: any,
    bytes: Uint8Array,
    entries: Map<string, Uint8Array>,
    marker: { formatVersion: 1; bundleHash: string; catalog: 'gamebox/catalog.json' },
  ) => void | Promise<void>,
) {
  const bytes = Uint8Array.from({ length: CHUNK * 3 + 13 }, (_, i) => i % 251);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK)
    chunks.push(await hash(bytes.subarray(i, i + CHUNK)));
  const marker = { formatVersion: 1, bundleHash: 'a'.repeat(64), catalog: 'gamebox/catalog.json' };
  const catalog = {
    formatVersion: 1,
    bundleHash: marker.bundleHash,
    gameId: 'fixture',
    gameContentHash: 'b'.repeat(64),
    entrypoint: 'GAME.EXE',
    features: { preparedModules: false, graphicsCache: false, filesystemIndex: false },
    files: [
      {
        path: 'GAME.EXE',
        sourceHash: await hash(bytes),
        sourceBytes: bytes.length,
        chunkSize: CHUNK,
        chunkHashes: chunks,
        fallbackReason: 'fixture raw fallback',
      },
    ],
  };
  const entries = new Map<string, Uint8Array>();
  await change?.(catalog, bytes, entries, marker);
  const catalogBytes = json(catalog);
  if (marker.keyId !== undefined) marker.signature = await signCatalog(catalogBytes);
  entries.set(
    'manifest.json',
    json({
      formatVersion: 2,
      name: 'fixture',
      rom: 'assets',
      entrypoint: 'assets/GAME.EXE',
      gamebox: marker,
    }),
  );
  entries.set(marker.catalog, catalogBytes);
  if (!catalog.files[0].blob) entries.set('assets/GAME.EXE', bytes);
  const packed = buildZip(entries);
  const reads: number[] = [];
  const base = new BufferSource(packed);
  const source = {
    size: packed.length,
    readRange: async (start: number, end: number) => {
      reads.push(end - start);
      return base.readRange(start, end);
    },
  };
  const archive = new ZipArchive(source);
  await archive.init();
  return { archive, marker, bytes, source, reads };
}

describe('prepared transport catalog', () => {
  test('game-scoped transport rejects cross-origin and ambiguous paths', () => {
    const blob = '/shared/blobs/' + 'a'.repeat(64);
    expect(gameboxBlobTransport(blob)).toBe(blob);
    expect(gameboxBlobTransport(blob, '/shared/games/gta-sa/blobs/'))
      .toBe('/shared/games/gta-sa/blobs/' + 'a'.repeat(64));
    for (const base of ['https://other.test/', '//other.test/', '/shared/games/../blobs/',
      '/shared/games/a%2fb/blobs/', '/shared/games/a/blobs/?x=', '/shared/blobs/'])
      expect(() => gameboxBlobTransport(blob, base)).toThrow('transport');
    expect(() => gameboxBlobTransport('/shared/blobs/../secret')).toThrow('identity');
  });

  test('thin source and external artifacts use scoped bounded reads without changing identities', async () => {
    const value = await fixture(async (catalog, bytes) => {
      const sourceHash = await hash(bytes);
      catalog.formatVersion = 2;
      catalog.files[0].blob = `/shared/blobs/${sourceHash}`;
      catalog.externalArtifacts = [{path: 'gamebox/optimized/module.wasm', sourceHash,
        sourceBytes: bytes.length, blob: `/shared/blobs/${sourceHash}`}];
    });
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    const requests: string[] = [];
    globalThis.XMLHttpRequest = class {
      status = 206;
      responseType = '';
      response: ArrayBuffer = new ArrayBuffer(0);
      private start = 0;
      private end = 0;
      open(_method: string, url: string, async: boolean) { expect(async).toBe(false); requests.push(url); }
      setRequestHeader(name: string, value: string) {
        expect(name.toLowerCase()).toBe('range');
        const match = /^bytes=(\d+)-(\d+)$/.exec(value)!;
        this.start = Number(match[1]); this.end = Number(match[2]);
      }
      send() { this.response = value.bytes.slice(this.start, this.end + 1).buffer; }
      getResponseHeader(name: string) {
        if (name.toLowerCase() === 'content-range') return `bytes ${this.start}-${this.end}/${value.bytes.length}`;
        if (name.toLowerCase() === 'content-length') return String(this.end - this.start + 1);
        return null;
      }
    } as unknown as typeof XMLHttpRequest;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
      if (!range) throw new Error('Expected bounded range');
      const start = Number(range[1]), end = Number(range[2]);
      return new Response(value.bytes.slice(start, end + 1), {status: 206, headers: {
        'content-range': `bytes ${start}-${end}/${value.bytes.length}`,
        'content-length': String(end - start + 1),
      }});
    }) as typeof fetch;
    try {
      const catalog = await GameboxCatalog.open(value.archive, value.marker, 'assets', undefined,
        '/shared/games/gta-sa/blobs/');
      expect(await catalog.image('GAME.EXE')!.source.readRange(0, 16)).toEqual(value.bytes.slice(0, 16));
      expect(await value.archive.readEntry(value.archive.getEntry('gamebox/optimized/module.wasm')!))
        .toEqual(value.bytes);
      expect(requests.length).toBeGreaterThan(0);
      for (const url of requests) expect(new URL(url).pathname)
        .toBe('/shared/games/gta-sa/blobs/' + await hash(value.bytes));
    } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; value.archive.close(); }
  });
  test('mounts a thin title catalog over an immutable shared blob', async () => {
    const value = await fixture(async (catalog, bytes) => {
      const sourceHash = await hash(bytes);
      catalog.formatVersion = 2;
      catalog.files[0].blob = `/shared/blobs/${sourceHash}`;
      catalog.externalArtifacts = [
        {
          path: 'gamebox/optimized/module.wasm',
          sourceHash,
          sourceBytes: bytes.length,
          blob: `/shared/blobs/${sourceHash}`,
        },
      ];
    });
    const catalog = await GameboxCatalog.open(value.archive, value.marker, 'assets');
    const entry = catalog.buildRomIndex().get('GAME.EXE');
    expect(entry?.uncompressedSize).toBe(value.bytes.length);
    expect(catalog.image('GAME.EXE')?.source.size).toBe(value.bytes.length);
    expect(value.archive.getEntry('gamebox/optimized/module.wasm')?.uncompressedSize).toBe(
      value.bytes.length,
    );
  });

  test('verifies the Rust domain-separated Ed25519 fixture before prepared metadata is trusted', async () => {
    const keyId = 'release-key';
    const publicKey = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
    const signature =
      '60fc7eb4529ec974bc18f180e3655534486ab017bf029a5e811eeb78de340ee2ff03b3c7c2d2ab535c0ec56cf8a64a317d66ad3f743949a04fb9101053036a0e';
    const fixtureResult = await fixture(async (catalog, bytes, entries, marker) => {
      marker.keyId = keyId;
      const sourceHash = await hash(bytes);
      const checksums = checksumTable([{ sourceHash, sourceBytes: bytes.length }]);
      const root = await hash(checksums);
      catalog.sourceFormatVersion = 5;
      catalog.signature = await signRoot(root, 5);
      catalog.keyId = keyId;
      catalog.bundleHash = root;
      marker.bundleHash = root;
      entries.set('gamebox/checksums.bin', checksums);
      entries.set(
        'gamebox/manifest.json',
        json({
          formatVersion: 5,
          game: {
            id: 'fixture',
            contentHash: 'b'.repeat(64),
            entrypoint: 'GAME.EXE',
          },
          features: catalog.features,
        }),
      );
      entries.set(
        'gamebox/inventory.json',
        json({ files: [{ path: 'GAME.EXE', sha256: sourceHash, size: bytes.length }] }),
      );
      entries.set(
        'gamebox/integrity.json',
        json({ formatVersion: 5, bundleHash: root, signature: catalog.signature, keyId }),
      );
    });
    const catalog = await GameboxCatalog.open(
      fixtureResult.archive,
      fixtureResult.marker,
      'assets',
      {
      [keyId]: publicKey,
      },
    );
    expect(catalog.sourceFormatVersion).toBe(5);
    expect(catalog.preparedTrust).toEqual({ status: 'trusted', keyId });
    await expect(
      verifyGameboxSignature('a'.repeat(64), 5, signature, keyId, {
        [keyId]: '0'.repeat(64),
      }),
    ).resolves.toEqual({ status: 'untrusted', reason: 'signature-verification-failed', keyId });
  });

  test('keeps unsigned catalogs on raw fallback and never authorizes them with a trust store', async () => {
    const f = await fixture();
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets', {
      'release-key': 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
    });
    expect(catalog.preparedTrust).toEqual({ status: 'unsigned' });
  });

  test('rejects catalog/hash tampering against the preserved signed checksum root', async () => {
    const tampered = await fixture(async (catalog, bytes, entries, marker) => {
      marker.keyId = 'release-key';
      const sourceHash = await hash(bytes);
      const checksums = checksumTable([{ sourceHash, sourceBytes: bytes.length }]);
      const root = await hash(checksums);
      const signature = await signRoot(root, 5);
      catalog.sourceFormatVersion = 5;
      catalog.bundleHash = root;
      catalog.signature = signature;
      catalog.keyId = 'release-key';
      marker.bundleHash = root;
      // The signed checksum table still names the original object, while the
      // catalog is forged to point at another object hash.
      catalog.files[0].sourceHash = 'b'.repeat(64);
      entries.set('gamebox/checksums.bin', checksums);
      entries.set(
        'gamebox/manifest.json',
        json({
          formatVersion: 5,
          game: { id: 'fixture', contentHash: 'b'.repeat(64), entrypoint: 'GAME.EXE' },
          features: catalog.features,
        }),
      );
      entries.set(
        'gamebox/inventory.json',
        json({ files: [{ path: 'GAME.EXE', sha256: sourceHash, size: bytes.length }] }),
      );
      entries.set(
        'gamebox/integrity.json',
        json({ formatVersion: 5, bundleHash: root, signature, keyId: 'release-key' }),
      );
    });
    const catalog = await GameboxCatalog.open(tampered.archive, tampered.marker, 'assets', {
      'release-key': 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
    });
    expect(catalog.preparedTrust.status).toBe('untrusted');
    expect(catalog.preparedTrust.reason).toMatch(/exported-root-/);
  });

  test('raw runtime signature rejects any catalog semantic edit', async () => {
    const original = json({
      formatVersion: 1,
      bundleHash: 'a'.repeat(64),
      entrypoint: 'GAME.EXE',
      features: { preparedModules: true },
      files: [{ path: 'A.DAT', sourceHash: 'b'.repeat(64), sourceBytes: 4 }],
    });
    const signature = await signCatalog(original);
    const store = {
      'release-key': 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
    };
    await expect(
      verifyRuntimeCatalogSignature(original, signature, 'release-key', store),
    ).resolves.toEqual({
      status: 'trusted',
      keyId: 'release-key',
    });
    for (const value of [
      { ...JSON.parse(new TextDecoder().decode(original)), entrypoint: 'SECOND.DAT' },
      { ...JSON.parse(new TextDecoder().decode(original)), features: { preparedModules: false } },
      {
        ...JSON.parse(new TextDecoder().decode(original)),
        files: [{ path: 'A.DAT', sourceHash: 'c'.repeat(64), sourceBytes: 4 }],
      },
      {
        ...JSON.parse(new TextDecoder().decode(original)),
        files: [
          {
            ...JSON.parse(new TextDecoder().decode(original)).files[0],
            prepared: { imageSize: 1 },
          },
        ],
      },
    ]) {
      await expect(
        verifyRuntimeCatalogSignature(json(value), signature, 'release-key', store),
      ).resolves.toEqual({
        status: 'untrusted',
        reason: 'signature-verification-failed',
        keyId: 'release-key',
      });
    }
  });

  test('bounds browser trust stores and fails closed for malformed signed metadata', async () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key-${index}`, '0'.repeat(64)]),
    );
    await expect(
      verifyGameboxSignature('a'.repeat(64), 5, '0'.repeat(128), 'key-0', tooManyKeys),
    ).resolves.toEqual({
      status: 'untrusted',
      reason: 'GameBox trust store exceeds its key budget',
      keyId: 'key-0',
    });
    const malformed = await fixture((catalog, _bytes, _entries, marker) => {
      catalog.sourceFormatVersion = 5;
      catalog.signature = '0'.repeat(128);
      catalog.keyId = 'release-key';
      marker.keyId = 'release-key';
    });
    const untrusted = await GameboxCatalog.open(malformed.archive, malformed.marker, 'assets');
    expect(untrusted.preparedTrust.status).toBe('untrusted');
    expect(untrusted.preparedTrust.reason).toBe('trusted-key-not-found');
  });

  test('cached URL fallback keeps large WGBs Blob-backed', async () => {
    const packed = buildZip(
      new Map([
        [
          'manifest.json',
          json({ formatVersion: 2, name: 'fixture', rom: 'rom', entrypoint: 'rom/GAME.EXE' }),
        ],
        ['rom/GAME.EXE', new Uint8Array([0x4d, 0x5a, 1, 2, 3])],
      ]),
    );
    class RangeOnlyBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('whole-file arrayBuffer must not be called');
      }
    }
    const cache = WgbCache as any;
    const originalOpen = cache.openSyncSourceForUrl;
    const originalGetBlob = cache.getBlob;
    const originalGet = cache.get;
    cache.openSyncSourceForUrl = async () => null;
    cache.getBlob = async () => new RangeOnlyBlob([packed], { type: 'application/zip' });
    cache.get = async () => {
      throw new Error('legacy whole-file cache path used');
    };
    try {
      const bundle = await WgbLoader.fromUrl('/cached/large.wgb');
      expect(bundle.entrypointBytes).toEqual(new Uint8Array([0x4d, 0x5a, 1, 2, 3]));
    } finally {
      cache.openSyncSourceForUrl = originalOpen;
      cache.getBlob = originalGetBlob;
      cache.get = originalGet;
    }
  });

  test('deferred startup reads only the bounded manifest from a Blob', async () => {
    const packed = buildZip(
      new Map([
        [
          'manifest.json',
          json({
            formatVersion: 2,
            name: 'fixture',
            rom: 'rom',
            entrypoint: 'rom/GAME.EXE',
            emulator: { memory: { ram: 256 * 1024 * 1024 } },
          }),
        ],
        ['rom/GAME.EXE', new Uint8Array([0x4d, 0x5a, 1, 2, 3])],
      ]),
    );
    class ManifestOnlyBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('whole-file arrayBuffer must not be called');
      }
    }
    const manifest = await WgbLoader.readManifestFromBlob(new ManifestOnlyBlob([packed]));
    expect(manifest.emulator?.memory?.ram).toBe(256 * 1024 * 1024);
    expect(manifest.entrypoint).toBe('rom/GAME.EXE');
  });

  test('bounds the central directory before reading it', async () => {
    const bytes = new Uint8Array(22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, 1, true);
    view.setUint32(12, 64 * 1024 * 1024 + 1, true);
    const reads: number[] = [];
    const source = {
      size: bytes.length,
      readRange: async (start: number, end: number) => {
        if (start < 0 || end > bytes.length) throw new Error('unexpected central-directory read');
        reads.push(end - start);
        return bytes.slice(start, end);
      },
    };
    await expect(WgbLoader.fromSource(source)).rejects.toThrow(
      'central directory exceeds configured byte limit',
    );
    expect(reads).toEqual([22]);
  });

  test('rejects exact duplicate ZIP names during WGB indexing', async () => {
    const packed = buildZip(
      new Map([
        ['a', new Uint8Array([1])],
        ['b', new Uint8Array([2])],
      ]),
    );
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    const central: number[] = [];
    for (let offset = 0; offset + 4 <= packed.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) central.push(offset);
    }
    expect(central).toHaveLength(2);
    packed[central[1]! + 46] = packed[central[0]! + 46]!;
    await expect(WgbLoader.fromSource(new BufferSource(packed))).rejects.toThrow(
      'Duplicate ZIP entry',
    );
  });

  test('WGB detection leaves executable on the range source', async () => {
    const f = await fixture();
    const bundle = await WgbLoader.fromSource(f.source);
    expect(bundle.entrypointBytes).toBeUndefined();
    expect(bundle.gamebox?.files.size).toBe(1);
    expect(Math.max(...f.reads)).toBeLessThan(f.bytes.length);
  });
  test('preserves empty directories and writable overlay precedence', async () => {
    const f = await fixture((_, __, entries) => entries.set('assets/empty/', new Uint8Array()));
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    const vfs = new VirtualFileSystem();
    vfs.mountRom(f.archive, 'assets', catalog.buildRomIndex());
    expect(vfs.directoryExists('C:\\empty')).toBe(true);
    expect(vfs.resolveStoredFile('C:\\GAME.EXE')?.source).toBe('rom');
    (vfs as any).overlay = { hasFile: () => true, resolveExistingPath: () => 'C:\\GAME.EXE' };
    expect(vfs.resolveStoredFile('C:\\game.exe')?.source).toBe('overlay');
  });
  test('catalog index is equivalent to the legacy index and does not expose its map', async () => {
    const f = await fixture((_, __, entries) =>
      entries.set('assets/data/empty/', new Uint8Array()),
    );
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    const expected = buildRomIndex(f.archive, 'assets', true);
    const actual = catalog.buildRomIndex();
    expect(Array.from(actual.entries())).toEqual(Array.from(expected.entries()));
    actual.clear();
    expect(catalog.buildRomIndex().size).toBe(expected.size);
  });
  test('orders the existing phase-1 set by a verified priority sidecar', async () => {
    const f = await fixture(async (catalog, __, entries) => {
      const extra = Uint8Array.from([7, 8, 9]);
      catalog.files.push({
        path: 'A.DAT',
        sourceHash: await hash(extra),
        sourceBytes: extra.length,
        chunkSize: CHUNK,
        chunkHashes: [await hash(extra)],
      });
      entries.set('assets/A.DAT', extra);
      const background = Uint8Array.from([10, 11]);
      catalog.files.push({
        path: 'BACKGROUND.DAT',
        sourceHash: await hash(background),
        sourceBytes: background.length,
        chunkSize: CHUNK,
        chunkHashes: [await hash(background)],
      });
      entries.set('assets/BACKGROUND.DAT', background);
      const priority = {
        version: 1,
        gameContentHash: 'b'.repeat(64),
        recipe: 'filesystem-priority-v1-scenario-tier-first-access',
        entries: [
          // Rust's serde JSON representation emits u64 values as decimal strings.
          { path: 'GAME.EXE', priority: 2, firstAccessOrder: '20' },
          { path: 'A.DAT', priority: 0, firstAccessOrder: '1' },
          { path: 'BACKGROUND.DAT', priority: 3, firstAccessOrder: null },
        ],
      };
      const priorityBytes = json(priority);
      catalog.filesystemPriority = {
        path: GAMEBOX_FILESYSTEM_PRIORITY_PATH,
        sha256: await hash(priorityBytes),
        entryCount: 3,
      };
      entries.set(GAMEBOX_FILESYSTEM_PRIORITY_PATH, priorityBytes);
    });
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    expect(catalog.filesystemPriority.size).toBe(3);
    expect(catalog.orderPrefetchCandidates(['GAME.EXE', 'A.DAT', 'BACKGROUND.DAT'])).toEqual([
      'A.DAT',
      'GAME.EXE',
      'BACKGROUND.DAT',
    ]);
  });
  test('warms compiler-observed ranges through the bounded archive source cache', async () => {
    const f = await fixture(async (catalog, __, entries) => {
      const profile = json({
        version: 1,
        gameContentHash: 'b'.repeat(64),
        observations: [
          {
            path: 'GAME.EXE',
            firstAccessOrder: '7',
            ranges: [
              { offset: '4096', length: '8192', reads: '3' },
              { offset: '0', length: '64', reads: '1' },
            ],
          },
        ],
        counters: { droppedEvents: '0', counterOverflow: false },
      });
      const priority = json({
        version: 1,
        gameContentHash: 'b'.repeat(64),
        recipe: 'filesystem-priority-v1-scenario-tier-first-access',
        entries: [{ path: 'GAME.EXE', priority: 0, firstAccessOrder: '7' }],
      });
      catalog.filesystemProfile = {
        path: GAMEBOX_FILESYSTEM_PROFILE_PATH,
        sha256: await hash(profile),
        observationCount: 1,
        rangeCount: 2,
      };
      catalog.filesystemPriority = {
        path: GAMEBOX_FILESYSTEM_PRIORITY_PATH,
        sha256: await hash(priority),
        entryCount: 1,
      };
      entries.set(GAMEBOX_FILESYSTEM_PROFILE_PATH, profile);
      entries.set(GAMEBOX_FILESYSTEM_PRIORITY_PATH, priority);
    });
    let request: { ranges: Array<{ start: number; end: number }>; maxBytes: number } | null = null;
    (f.source as any).prefetchRanges = async (
      ranges: Array<{ start: number; end: number }>,
      maxBytes: number,
    ) => {
      request = { ranges, maxBytes };
      return { ranges: ranges.length, chunks: 1, bytes: 16 * 1024 };
    };
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    await expect(catalog.prewarmFilesystem()).resolves.toEqual({
      ranges: 2,
      chunks: 1,
      bytes: 16 * 1024,
    });
    expect(request?.maxBytes).toBe(GAMEBOX_FILESYSTEM_PREWARM_BYTES);
    expect(request?.ranges.map(({ start, end }) => end - start)).toEqual([8192, 64]);
  });
  test('skips malformed priority metadata without changing the namespace', async () => {
    const f = await fixture(async (catalog, __, entries) => {
      const priority = json({
        version: 1,
        gameContentHash: 'b'.repeat(64),
        recipe: 'filesystem-priority-v1-scenario-tier-first-access',
        entries: [
          { path: 'GAME.EXE', priority: 0 },
          { path: 'game.exe', priority: 1 },
        ],
      });
      catalog.filesystemPriority = {
        path: GAMEBOX_FILESYSTEM_PRIORITY_PATH,
        sha256: await hash(priority),
        entryCount: 2,
      };
      entries.set(GAMEBOX_FILESYSTEM_PRIORITY_PATH, priority);
    });
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    expect(catalog.filesystemPriority.size).toBe(0);
    expect(catalog.filesystemPrioritySkipped).toMatch(/colliding|entry count/i);
    expect(catalog.orderPrefetchCandidates(['GAME.EXE'])).toEqual(['GAME.EXE']);
  });
  test('keeps graphics profile pointers optional and validates their bounds', async () => {
    const profile = json({ version: 1, shaders: [], pipelines: [] });
    const valid = await fixture(async (catalog, __, entries) => {
      catalog.graphicsProfile = {
        path: GAMEBOX_GRAPHICS_PROFILE_PATH,
        sha256: await hash(profile),
        shaderCount: 0,
        pipelineCount: 0,
      };
      entries.set(GAMEBOX_GRAPHICS_PROFILE_PATH, profile);
    });
    const catalog = await GameboxCatalog.open(valid.archive, valid.marker, 'assets');
    expect(catalog.graphicsProfile).toEqual({
      path: GAMEBOX_GRAPHICS_PROFILE_PATH,
      sha256: await hash(profile),
      shaderCount: 0,
      pipelineCount: 0,
    });

    const malformed = await fixture((catalog) => {
      catalog.graphicsProfile = {
        path: 'gamebox/profiles/other.json',
        sha256: '0'.repeat(64),
        shaderCount: 1,
        pipelineCount: 1,
      };
    });
    const skipped = await GameboxCatalog.open(malformed.archive, malformed.marker, 'assets');
    expect(skipped.graphicsProfile).toBeUndefined();
    expect(skipped.graphicsProfileSkipped).toMatch(/expected .*gpu\.json/);
  });
  test('rejects case-insensitive file/directory collisions', async () => {
    const bad = await fixture((_, __, entries) =>
      entries.set('assets/game.exe/', new Uint8Array()),
    );
    await expect(GameboxCatalog.open(bad.archive, bad.marker, 'assets')).rejects.toThrow(
      /Colliding|Invalid GameBox file path/,
    );
  });
  test('rejects paths outside the bounded catalog namespace', async () => {
    const bad = await fixture((catalog) => {
      catalog.files[0].path = 'x'.repeat(4097);
    });
    await expect(GameboxCatalog.open(bad.archive, bad.marker, 'assets')).rejects.toThrow(
      'Invalid GameBox file path',
    );
  });
  test('hashes bounded chunks across boundaries and preserves EOF', async () => {
    const f = await fixture();
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    const image = catalog.image('C:\\game.exe')!;
    f.reads.length = 0;
    const start = CHUNK - 17;
    expect(await image.source.readRange(start, CHUNK)).toEqual(f.bytes.slice(start, start + CHUNK));
    expect(Math.max(...f.reads)).toBeLessThanOrEqual(CHUNK);
    expect(await image.source.readRange(f.bytes.length, 0)).toEqual(new Uint8Array());
    await expect(image.source.readRange(0, CHUNK + 1)).rejects.toThrow('budget');
    await expect(image.source.readRange(f.bytes.length, 1)).rejects.toThrow('budget');
    catalog.dispose();
    await expect(image.source.readRange(0, 1)).rejects.toThrow('closed');
  });
  test('corrupt source fails before returning bytes', async () => {
    const f = await fixture((_, bytes) => {
      bytes[CHUNK + 5] ^= 1;
    });
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    await expect(catalog.image('GAME.EXE')!.source.readRange(CHUNK, 10)).rejects.toThrow(
      'integrity',
    );
  });
  test('rejects forged binding, namespace, and missing hashes', async () => {
    for (const mutate of [
      (c: any) => {
        c.bundleHash = 'b'.repeat(64);
      },
      (c: any) => {
        c.files[0].path = '../GAME.EXE';
      },
      (c: any) => {
        c.files[0].chunkHashes.pop();
      },
      (c: any) => {
        c.files.push({ ...c.files[0] });
      },
      (c: any) => {
        c.files[0].prepared = {
          sourceHash: 'b'.repeat(64),
          sourceBytes: c.files[0].sourceBytes,
          sections: [],
          dataDirectories: [],
        };
      },
      (c: any) => {
        c.files[0].prepared = {
          sourceHash: c.files[0].sourceHash,
          sourceBytes: c.files[0].sourceBytes,
          preferredBase: 0,
          entrypointRva: 1,
          imageSize: '2',
          headerSize: 1,
          sections: [],
          dataDirectories: [],
        };
      },
    ]) {
      const f = await fixture(mutate);
      await expect(GameboxCatalog.open(f.archive, f.marker, 'assets')).rejects.toThrow();
    }
  });
  test('rejects unindexed files and parallel staging', async () => {
    const bad = await fixture((_, __, entries) =>
      entries.set('assets/extra.dat', new Uint8Array([1])),
    );
    await expect(GameboxCatalog.open(bad.archive, bad.marker, 'assets')).rejects.toThrow(
      'Unindexed',
    );
    const f = await fixture();
    const catalog = await GameboxCatalog.open(f.archive, f.marker, 'assets');
    const image = catalog.image('GAME.EXE')!;
    const first = image.source.readRange(0, 100);
    await expect(image.source.readRange(100, 100)).rejects.toThrow('Concurrent');
    await first;
    catalog.dispose();
    expect(() => catalog.buildRomIndex()).toThrow('closed');
  });
});
