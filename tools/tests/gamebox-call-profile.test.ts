import { describe, expect, it } from 'bun:test';
import {
  GameBoxCallProfile,
  GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES,
  GAMEBOX_CALL_PROFILE_MAX_NAMES,
} from '../../src/worker/core/diagnostics/gamebox-call-profile';

describe('GameBoxCallProfile', () => {
  it('is disabled by default and retains a stopped capture', () => {
    const profile = new GameBoxCallProfile();
    profile.record('kernel32:Sleep');
    expect(profile.snapshot().totalCalls).toBe('0');

    profile.start();
    profile.record('kernel32:Sleep');
    profile.record('kernel32:Sleep');
    profile.stop();

    expect(profile.snapshot()).toMatchObject({
      running: false,
      coverage: 'dispatcher-only',
      nativeBypassObserved: false,
      nativeBypassCoverage: 'not-observed',
      totalCalls: '2',
      calls: [{ name: 'kernel32:Sleep', count: '2' }],
    });
  });

  it('sorts symbolic names deterministically and emits exact decimal counts', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    for (let i = 0; i < 3; i++) profile.record('user32:MessageBoxA');
    for (let i = 0; i < 2; i++) profile.record('kernel32:Sleep');
    profile.record('advapi32:RegOpenKeyA');

    expect(profile.snapshot().calls).toEqual([
      {
        name: 'advapi32:RegOpenKeyA', count: '1', totalUs: '0', maxUs: '0',
        syncCompletions: '0', asyncCompletions: '0', errorCompletions: '0',
      },
      {
        name: 'kernel32:Sleep', count: '2', totalUs: '0', maxUs: '0',
        syncCompletions: '0', asyncCompletions: '0', errorCompletions: '0',
      },
      {
        name: 'user32:MessageBoxA', count: '3', totalUs: '0', maxUs: '0',
        syncCompletions: '0', asyncCompletions: '0', errorCompletions: '0',
      },
    ]);
  });

  it('records bounded microsecond timing and sync/async/error completions', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    profile.record('kernel32:Sleep');
    profile.recordCompletion('kernel32:Sleep', 1.234, 'sync');
    profile.recordCompletion('kernel32:Sleep', 2.001, 'async', true);

    expect(profile.snapshot().calls).toEqual([{
      name: 'kernel32:Sleep', count: '1', totalUs: '3235', maxUs: '2001',
      syncCompletions: '1', asyncCompletions: '1', errorCompletions: '1',
    }]);

    profile.stop();
    profile.recordCompletion('kernel32:Sleep', 99, 'sync', true);
    expect(profile.snapshot().calls[0]).toMatchObject({
      totalUs: '3235', syncCompletions: '1', errorCompletions: '1',
    });
  });

  it('bounds retained names and accounts for calls beyond the name budget', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    for (let i = 0; i < GAMEBOX_CALL_PROFILE_MAX_NAMES + 2; i++) {
      profile.record(`module:${i}`);
    }
    profile.record('module:8193');

    expect(profile.snapshot()).toMatchObject({
      retainedNames: GAMEBOX_CALL_PROFILE_MAX_NAMES,
      droppedNames: 3,
      totalCalls: String(GAMEBOX_CALL_PROFILE_MAX_NAMES + 3),
      droppedCalls: '3',
    });
  });

  it('drops empty and oversized UTF-8 identities before retaining them', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    profile.record('');
    profile.record('a'.repeat(GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES + 1));
    profile.record('é'.repeat(GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES / 2));
    profile.record('é'.repeat(GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES / 2 + 1));

    expect(profile.snapshot()).toMatchObject({
      retainedNames: 1,
      droppedNames: 3,
      totalCalls: '4',
      droppedCalls: '3',
      rows: [{ name: 'é'.repeat(GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES / 2), count: '1' }],
    });
  });

  it('saturates dropped counters at their declared bounds', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    const state = profile as any;
    const u64Max = (1n << 64n) - 1n;
    state.droppedCallsState = u64Max;
    state.droppedNamesState = Number.MAX_SAFE_INTEGER;
    profile.record('');

    expect(profile.snapshot()).toMatchObject({
      droppedNames: Number.MAX_SAFE_INTEGER,
      droppedCalls: u64Max.toString(),
      counterOverflow: '1',
    });
  });

  it('saturates timing counters and reports timing overflow', () => {
    const profile = new GameBoxCallProfile();
    profile.start();
    profile.record('kernel32:Sleep');
    const state = profile as any;
    const u64Max = (1n << 64n) - 1n;
    const timing = state.timings.get('kernel32:Sleep');
    timing.totalUs = u64Max;
    timing.maxUs = u64Max;
    timing.syncCompletions = u64Max;

    profile.recordCompletion('kernel32:Sleep', 1, 'sync', true);

    expect(profile.snapshot().calls[0]).toEqual({
      name: 'kernel32:Sleep', count: '1', totalUs: u64Max.toString(), maxUs: u64Max.toString(),
      syncCompletions: u64Max.toString(), asyncCompletions: '0', errorCompletions: '1',
    });
    expect(profile.snapshot().counterOverflow).toBe('2');
  });
});
