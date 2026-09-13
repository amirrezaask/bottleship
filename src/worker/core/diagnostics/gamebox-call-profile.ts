/**
 * Opt-in Win32 thunk call profile for offline diagnostics.
 *
 * The collector is deliberately separate from apiCensus: it is bounded, uses
 * exact counters, and records at the dispatcher boundary before either the
 * fast or slow implementation is selected. Native hypercalls and tier-0
 * write-buffer trampolines do not cross that boundary, so the snapshot labels
 * its coverage accordingly instead of presenting a partial count as a full
 * Win32 profile.
 */

export const GAMEBOX_CALL_PROFILE_VERSION = 1 as const;
export const GAMEBOX_CALL_PROFILE_MAX_NAMES = 8192;
export const GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES = 256;
const U64_MAX = (1n << 64n) - 1n;
const MAX_SAFE_DROPPED_NAMES = Number.MAX_SAFE_INTEGER;
const UTF8_ENCODER = new TextEncoder();

export interface GameBoxCallProfileEntry {
  /** Symbolic thunk identity, normally "module:Export". */
  name: string;
  /** Exact count encoded as decimal to remain safe for u64 consumers. */
  count: string;
  totalUs: string;
  maxUs: string;
  syncCompletions: string;
  asyncCompletions: string;
  errorCompletions: string;
}

export interface GameBoxCallProfileSnapshot {
  version: typeof GAMEBOX_CALL_PROFILE_VERSION;
  running: boolean;
  /** Calls observed at the JS thunk dispatcher entry boundary. */
  coverage: 'dispatcher-only';
  /** Native hypercall and write-buffer paths are not instrumented here. */
  nativeBypassObserved: false;
  nativeBypassCoverage: 'not-observed';
  totalCalls: string;
  /** Portable profile-schema alias used by the CPU profile collector. */
  rows: GameBoxCallProfileEntry[];
  calls: GameBoxCallProfileEntry[];
  maxNames: number;
  retainedNames: number;
  droppedNames: number;
  droppedCalls: string;
  /** Portable profile-schema alias for droppedCalls. */
  dropped: string;
  /** Calls that would exceed the exact unsigned-64-bit counter range. */
  counterOverflow: string;
}

interface CallTiming {
  totalUs: bigint;
  maxUs: bigint;
  syncCompletions: bigint;
  asyncCompletions: bigint;
  errorCompletions: bigint;
}

/**
 * Bounded call collector shared by all BottleShip workers.
 *
 * BigInt state makes the decimal result exact even for long-running sessions.
 * The hot repeat path performs one Map lookup and one increment; when disabled
 * it is a single boolean check in the dispatcher hook.
 */
export class GameBoxCallProfile {
  private runningState = false;
  private counts = new Map<string, bigint>();
  private timings = new Map<string, CallTiming>();
  private totalCallsState = 0n;
  private droppedNamesState = 0;
  private droppedCallsState = 0n;
  private counterOverflowState = 0n;

  private incrementCounterOverflow(): void {
    if (this.counterOverflowState < U64_MAX) this.counterOverflowState++;
  }

  private incrementDroppedName(): void {
    if (this.droppedNamesState < MAX_SAFE_DROPPED_NAMES) this.droppedNamesState++;
  }

  private incrementDroppedCall(): void {
    if (this.droppedCallsState < U64_MAX) this.droppedCallsState++;
    else this.incrementCounterOverflow();
  }

  /** Start collection. A new capture starts empty by default. */
  start(reset = true): void {
    if (reset) this.reset();
    this.runningState = true;
  }

  /** Stop collection while retaining the completed capture for snapshot(). */
  stop(): void {
    this.runningState = false;
  }

  /** Clear counts and dropped-call accounting without changing running state. */
  reset(): void {
    this.counts.clear();
    this.timings.clear();
    this.totalCallsState = 0n;
    this.droppedNamesState = 0;
    this.droppedCallsState = 0n;
    this.counterOverflowState = 0n;
  }

  isRunning(): boolean {
    return this.runningState;
  }

  /** Record one dispatcher entry using its already-resolved symbolic name. */
  record(name: string): void {
    if (!this.runningState) return;

    if (this.totalCallsState < U64_MAX) this.totalCallsState++;
    else this.incrementCounterOverflow();

    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      UTF8_ENCODER.encode(name).byteLength > GAMEBOX_CALL_PROFILE_MAX_NAME_BYTES
    ) {
      this.incrementDroppedName();
      this.incrementDroppedCall();
      return;
    }

    const existing = this.counts.get(name);
    if (existing !== undefined) {
      if (existing < U64_MAX) this.counts.set(name, existing + 1n);
      else this.incrementCounterOverflow();
      return;
    }

    if (this.counts.size >= GAMEBOX_CALL_PROFILE_MAX_NAMES) {
      this.incrementDroppedName();
      this.incrementDroppedCall();
      return;
    }
    this.counts.set(name, 1n);
    this.timings.set(name, {
      totalUs: 0n,
      maxUs: 0n,
      syncCompletions: 0n,
      asyncCompletions: 0n,
      errorCompletions: 0n,
    });
  }

  /** Record a completed JS-dispatched thunk. Native hypercalls and trampolines never call this. */
  recordCompletion(name: string, elapsedMs: number, kind: 'sync' | 'async', error = false): void {
    if (!this.runningState) return;
    const timing = this.timings.get(name);
    if (!timing) return;
    const micros = this.elapsedMicroseconds(elapsedMs);
    if (timing.totalUs > U64_MAX - micros) {
      timing.totalUs = U64_MAX;
      this.incrementCounterOverflow();
    } else {
      timing.totalUs += micros;
    }
    if (micros > timing.maxUs) timing.maxUs = micros;
    if (kind === 'sync') this.incrementTimingCounter(timing, 'syncCompletions');
    else this.incrementTimingCounter(timing, 'asyncCompletions');
    if (error) this.incrementTimingCounter(timing, 'errorCompletions');
  }

  private elapsedMicroseconds(elapsedMs: number): bigint {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0n;
    const micros = elapsedMs * 1000;
    if (!Number.isFinite(micros) || micros > Number.MAX_SAFE_INTEGER)
      return U64_MAX;
    return BigInt(Math.max(0, Math.round(micros)));
  }

  private incrementTimingCounter(timing: CallTiming, field: 'syncCompletions' | 'asyncCompletions' | 'errorCompletions'): void {
    if (timing[field] < U64_MAX) timing[field]++;
    else this.incrementCounterOverflow();
  }

  snapshot(): GameBoxCallProfileSnapshot {
    const calls = [...this.counts.entries()]
      .map(([name, count]) => {
        const timing = this.timings.get(name)!;
        return {
          name,
          count: count.toString(10),
          totalUs: timing.totalUs.toString(10),
          maxUs: timing.maxUs.toString(10),
          syncCompletions: timing.syncCompletions.toString(10),
          asyncCompletions: timing.asyncCompletions.toString(10),
          errorCompletions: timing.errorCompletions.toString(10),
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      version: GAMEBOX_CALL_PROFILE_VERSION,
      running: this.runningState,
      coverage: 'dispatcher-only',
      nativeBypassObserved: false,
      nativeBypassCoverage: 'not-observed',
      totalCalls: this.totalCallsState.toString(10),
      rows: calls,
      calls,
      maxNames: GAMEBOX_CALL_PROFILE_MAX_NAMES,
      retainedNames: calls.length,
      droppedNames: this.droppedNamesState,
      droppedCalls: this.droppedCallsState.toString(10),
      dropped: this.droppedCallsState.toString(10),
      counterOverflow: this.counterOverflowState.toString(10),
    };
  }
}

/** Worker-wide collector. It is disabled until an explicit start() call. */
export const gameBoxCallProfile = new GameBoxCallProfile();
