/**
 * Opt-in accounting for crossings that never enter the JS thunk dispatcher.
 * Native hypercalls expose an exact saturating u64 in the shared page. Tier-0
 * write-buffer entries are counted at their JS drain boundary; enqueue-to-drain
 * latency is deliberately not timed because it is not a call duration.
 */
import { hypercallDataManager } from '../cpu/hypercall-data';
import { System } from '../system';

const U64_MAX = (1n << 64n) - 1n;
type WbufStats = {
  hits: number;
  outTrapHits: number;
  coalescedSkips: number;
  barrierEntries: number;
};

export type NativeWriteBufferCounter = keyof WbufStats;

export interface NativeCrossingProfile {
  nativeHypercallObserved: boolean;
  nativeHypercallAttributionObserved: boolean;
  nativeHypercallHandlers: Array<{
    handlerId: number;
    calls: string;
    counterOverflow: boolean;
  }>;
  nativeWriteBufferObserved: boolean;
  hypercallCalls: string;
  writeBufferEntries: string;
  writeBufferOutTrapCalls: string;
  writeBufferCoalescedSkips: string;
  writeBufferBarrierEntries: string;
  timingObserved: false;
  counterOverflow: boolean;
}

let running = false;
let baseline: WbufStats | null = null;

function dispatcher(): { getWbufStats?: () => WbufStats } | null {
  return (System.getInstance().process?.dispatcher as { getWbufStats?: () => WbufStats } | undefined) ?? null;
}

function safeCounter(value: number): { value: bigint; overflow: boolean } {
  if (!Number.isSafeInteger(value) || value < 0) return { value: U64_MAX, overflow: true };
  return { value: BigInt(value), overflow: false };
}

/**
 * Subtract two bounded JS snapshots without silently turning an unsafe integer
 * or a reset into a plausible count. The dispatcher currently stores these
 * counters as Numbers, so this guard is the boundary that keeps GBXP exact.
 */
export function nativeCounterDelta(
  after: number,
  before: number,
): { value: bigint; overflow: boolean } {
  const a = safeCounter(after);
  const b = safeCounter(before);
  if (a.overflow || b.overflow || after < before) return { value: a.value, overflow: true };
  return { value: a.value - b.value, overflow: false };
}

/**
 * Classify each bounded dispatcher counter independently. Keeping the field
 * name with the delta makes a reset or an unsafe snapshot diagnosable without
 * widening the capture schema or treating the aggregate flag as a count.
 */
export function nativeCounterDeltas(
  after: WbufStats,
  before: WbufStats,
): Record<NativeWriteBufferCounter, { value: bigint; overflow: boolean }> {
  return {
    hits: nativeCounterDelta(after.hits, before.hits),
    outTrapHits: nativeCounterDelta(after.outTrapHits, before.outTrapHits),
    coalescedSkips: nativeCounterDelta(after.coalescedSkips, before.coalescedSkips),
    barrierEntries: nativeCounterDelta(after.barrierEntries, before.barrierEntries),
  };
}

/** Return only write-buffer fields whose bounded delta cannot be trusted. */
export function nativeCounterOverflowFields(
  after: WbufStats,
  before: WbufStats,
): NativeWriteBufferCounter[] {
  return (Object.entries(nativeCounterDeltas(after, before)) as Array<[
    NativeWriteBufferCounter,
    { value: bigint; overflow: boolean },
  ]>)
    .filter(([, delta]) => delta.overflow)
    .map(([field]) => field);
}

function empty(): NativeCrossingProfile {
  return {
    nativeHypercallObserved: false,
    nativeHypercallAttributionObserved: false,
    nativeHypercallHandlers: [],
    nativeWriteBufferObserved: false,
    hypercallCalls: '0',
    writeBufferEntries: '0',
    writeBufferOutTrapCalls: '0',
    writeBufferCoalescedSkips: '0',
    writeBufferBarrierEntries: '0',
    timingObserved: false,
    counterOverflow: false,
  };
}

/** Arm both native counters at the same paused profile boundary. */
export function startNativeCrossingProfile(): boolean {
  const d = dispatcher();
  baseline = d?.getWbufStats?.() ?? null;
  running = hypercallDataManager.startNativeProfile();
  return running;
}

/** Stop accounting before any profile result is serialized. */
export function finishNativeCrossingProfile(): NativeCrossingProfile {
  if (!running) return empty();
  const hypercall = hypercallDataManager.stopNativeProfile();
  const after = dispatcher()?.getWbufStats?.() ?? null;
  const before = baseline;
  running = false;
  baseline = null;
  if (!after || !before) {
    return {
      ...empty(),
      nativeHypercallObserved: hypercall.observed,
      nativeHypercallAttributionObserved: hypercall.handlerAttributionObserved,
      nativeHypercallHandlers: hypercall.handlers,
      hypercallCalls: hypercall.calls,
      counterOverflow: hypercall.counterOverflow,
    };
  }
  const deltas = nativeCounterDeltas(after, before);
  const entries = deltas.hits;
  const outTrap = deltas.outTrapHits;
  const coalesced = deltas.coalescedSkips;
  const barriers = deltas.barrierEntries;
  const writeBufferCounterOverflow = Object.values(deltas).some(
    (delta) => delta.overflow,
  );
  return {
    nativeHypercallObserved: hypercall.observed,
    nativeHypercallAttributionObserved: hypercall.handlerAttributionObserved,
    nativeHypercallHandlers: hypercall.handlers,
    nativeWriteBufferObserved: true,
    hypercallCalls: hypercall.calls,
    writeBufferEntries: entries.value.toString(10),
    writeBufferOutTrapCalls: outTrap.value.toString(10),
    writeBufferCoalescedSkips: coalesced.value.toString(10),
    writeBufferBarrierEntries: barriers.value.toString(10),
    timingObserved: false,
    counterOverflow:
      hypercall.counterOverflow || writeBufferCounterOverflow,
  };
}

/** Abort accounting on failed/canceled profile ownership transitions. */
export function cancelNativeCrossingProfile(): void {
  if (running) {
    hypercallDataManager.stopNativeProfile();
  }
  running = false;
  baseline = null;
}
