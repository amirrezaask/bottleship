import { describe, expect, it } from 'bun:test';
import {
  nativeCounterDelta,
  nativeCounterDeltas,
  nativeCounterOverflowFields,
} from '../../src/worker/core/diagnostics/native-crossing-profile';

describe('native crossing counter snapshots', () => {
  it('keeps exact safe deltas as decimal-ready bigint values', () => {
    expect(nativeCounterDelta(17, 5)).toEqual({ value: 12n, overflow: false });
    expect(nativeCounterDelta(Number.MAX_SAFE_INTEGER, 0)).toEqual({
      value: BigInt(Number.MAX_SAFE_INTEGER),
      overflow: false,
    });
  });

  it('marks resets and unsafe snapshots instead of wrapping', () => {
    expect(nativeCounterDelta(4, 9)).toEqual({ value: 4n, overflow: true });
    expect(nativeCounterDelta(Number.MAX_SAFE_INTEGER + 1, 0)).toEqual({
      value: (1n << 64n) - 1n,
      overflow: true,
    });
  });

  it('identifies the individual dispatcher fields behind an invalid delta', () => {
    const before = { hits: 10, outTrapHits: 20, coalescedSkips: 30, barrierEntries: 40 };
    const after = { hits: 9, outTrapHits: 20, coalescedSkips: Number.MAX_SAFE_INTEGER + 1, barrierEntries: 39 };
    const deltas = nativeCounterDeltas(after, before);
    expect(deltas.hits).toEqual({ value: 9n, overflow: true });
    expect(deltas.outTrapHits).toEqual({ value: 0n, overflow: false });
    expect(deltas.coalescedSkips).toEqual({ value: (1n << 64n) - 1n, overflow: true });
    expect(deltas.barrierEntries).toEqual({ value: 39n, overflow: true });
    expect(nativeCounterOverflowFields(after, before)).toEqual([
      'hits',
      'coalescedSkips',
      'barrierEntries',
    ]);
  });

});
