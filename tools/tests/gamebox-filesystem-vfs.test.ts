import { describe, expect, it } from 'bun:test';
import type { ZipArchive, ZipEntry } from '@bottleship/formats/zip';
import { gameBoxFilesystemProfile } from '../../src/worker/core/diagnostics/gamebox-filesystem-profile';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';

const entry: ZipEntry = {
  name: 'asset.dat',
  uncompressedSize: 32,
  compressedSize: 32,
  compression: 0,
  localHeaderOffset: 0,
  isDirectory: false,
};

describe('GameBox filesystem profile VFS hooks', () => {
  it('records sync, async, read-into, seek, stat, and enumeration once each', async () => {
    const archive = {
      readEntryRangeSync(_entry: ZipEntry, offset: number, length: number) {
        return new Uint8Array(Math.max(0, Math.min(length, 32 - offset)));
      },
    } as unknown as ZipArchive;
    const vfs = new VirtualFileSystem();
    vfs.mountRom(archive, '', new Map([['asset.dat', entry]]));
    gameBoxFilesystemProfile.start('b'.repeat(64));
    const handle = vfs.openSync('asset.dat', 0x80000000, 3);
    expect(handle).not.toBeNull();
    const first = vfs.readSync(handle!, 4);
    expect(first?.length).toBe(4);
    const second = await vfs.read(handle!, 4);
    expect(second.length).toBe(4);
    const target = new Uint8Array(4);
    expect(await vfs.readInto(handle!, target, 0, 4)).toBe(4);
    vfs.setPosition(handle!, 0, 0);
    expect(vfs.statEntry('C:\\asset.dat')?.kind).toBe('file');
    expect(vfs.listDirectory('C:\\')).toHaveLength(1);
    gameBoxFilesystemProfile.stop();

    const snapshot = gameBoxFilesystemProfile.snapshot();
    expect(snapshot.gameContentHash).toBe('b'.repeat(64));
    expect(snapshot.counters).toMatchObject({
      opens: '1',
      reads: '3',
      seeks: '1',
      stats: '1',
      enumerations: '1',
    });
    expect(snapshot.files.filter((row) => row.path.toLowerCase() === 'c:\\asset.dat')).toHaveLength(
      1,
    );
    expect(snapshot.accessOrder.map((row) => row.operation)).toEqual([
      'open',
      'read',
      'read',
      'read',
      'seek',
      'stat',
      'enumerate',
    ]);
  });
});
