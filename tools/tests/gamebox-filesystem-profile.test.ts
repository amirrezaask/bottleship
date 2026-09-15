import { describe, expect, it } from 'bun:test';
import {
  GameBoxFilesystemProfile,
  GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES,
  GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES,
} from '../../src/worker/core/diagnostics/gamebox-filesystem-profile';

describe('GameBoxFilesystemProfile', () => {
  it('is disabled without changing the empty snapshot', () => {
    const profile = new GameBoxFilesystemProfile();
    profile.recordOpen('C:\\unused.dat', 'rom', true);
    profile.recordRead('C:\\unused.dat', 'rom', 0, 4, 4);
    expect(profile.snapshot()).toMatchObject({
      running: false,
      files: [],
      counters: { opens: '0', reads: '0' },
    });
  });

  it('resets the capture, identity, and ordering on cancel', () => {
    const profile = new GameBoxFilesystemProfile();
    profile.start('a'.repeat(64));
    profile.recordOpen('C:\\a.dat', 'rom', true);
    expect(profile.snapshot().gameContentHash).toBe('a'.repeat(64));
    profile.cancel();
    expect(profile.snapshot()).toMatchObject({
      running: false,
      gameContentHash: null,
      accessOrder: [],
      counters: { opens: '0' },
    });
  });

  it('aggregates opens, reads, seeks, stats, and enumerations with exact decimal values', () => {
    const profile = new GameBoxFilesystemProfile();
    profile.start();
    profile.recordOpen('C:\\DATA\\A.DAT', 'rom', true);
    profile.recordOpen('C:\\DATA\\missing.dat', 'unknown', false);
    profile.recordRead('C:\\DATA\\A.DAT', 'rom', 0, 4, 4);
    profile.recordRead('C:\\DATA\\A.DAT', 'rom', 4, 8, 3);
    profile.recordSeek('C:\\DATA\\A.DAT', 'rom', 7, 99);
    profile.recordStat('C:\\DATA\\A.DAT', 'rom', true);
    profile.recordEnumeration('C:\\DATA', 'rom', 2);
    profile.stop();

    const snapshot = profile.snapshot();
    expect(snapshot.counters).toMatchObject({
      opens: '2',
      failedOpens: '1',
      reads: '2',
      requestedBytes: '12',
      returnedBytes: '7',
      seeks: '1',
      stats: '1',
      enumerations: '1',
      enumeratedEntries: '2',
    });
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.find((row) => row.path === 'C:\\DATA\\A.DAT')).toMatchObject({
      opens: { success: '1', failed: '0' },
      reads: { calls: '2', requestedBytes: '12', returnedBytes: '7' },
      ranges: [{ offset: '0', length: '7', reads: '2' }],
      commonRanges: [
        { offset: '0', length: '4', reads: '1' },
        { offset: '4', length: '8', reads: '1' },
      ],
    });
    expect(snapshot.accessOrder.map((row) => row.operation)).toEqual([
      'open',
      'read',
      'read',
      'seek',
      'stat',
      'enumerate',
    ]);
  });

  it('bounds files and ranges while retaining aggregate counters', () => {
    const profile = new GameBoxFilesystemProfile();
    profile.start();
    for (let i = 0; i < GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES + 10; i++)
      profile.recordStat(`C:\\${i}.dat`, 'rom', true);
    for (let i = 0; i < GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES + 10; i++)
      profile.recordRead('C:\\0.dat', 'rom', i, 1, 1);
    const snapshot = profile.snapshot();
    expect(snapshot.retainedFiles).toBe(GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES);
    expect(snapshot.droppedFiles).toBe('10');
    expect(snapshot.counters.reads).toBe(String(GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES + 10));
    expect(BigInt(snapshot.droppedRanges)).toBeGreaterThan(0n);
    expect(snapshot.files.every((row) => row.reads.calls === '0' || row.ranges.length > 0)).toBe(
      true,
    );
  });

  it('keeps failed loose-file probes out of the bounded launch working set', () => {
    const profile = new GameBoxFilesystemProfile();
    profile.start();
    for (let i = 0; i < GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES * 2; i++)
      profile.recordOpen(`C:\\missing\\${i}.dat`, 'unknown', false);
    profile.recordOpen('C:\\ROM\\DATA.RAS', 'rom', true);
    profile.recordRead('C:\\ROM\\DATA.RAS', 'rom', 0, 4096, 4096);

    expect(profile.snapshot()).toMatchObject({
      retainedFiles: 1,
      droppedFiles: '0',
      files: [{ path: 'C:\\ROM\\DATA.RAS', source: 'rom' }],
      counters: { opens: String(GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES * 2 + 1) },
    });
  });
});
