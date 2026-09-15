/**
 * Opt-in, bounded observations of the guest virtual filesystem.
 *
 * This collector deliberately lives beside the CPU/call profiles rather than
 * in the debug I/O ring. The ring is a recent-event diagnostic and loses the
 * aggregate byte/range information needed by offline workload preparation.
 */

export const GAMEBOX_FILESYSTEM_PROFILE_VERSION = 1 as const;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES = 512;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES = 4096;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_COMMON_RANGES = 64;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_ACCESS_ORDER = 8192;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_PATH_BYTES = 64 * 1024;
export const GAMEBOX_FILESYSTEM_PROFILE_MAX_PATH_BYTES_PER_FILE = 1024;

const U64_MAX = (1n << 64n) - 1n;
const encoder = new TextEncoder();

type Source = 'rom' | 'overlay' | 'unknown';
type AccessOperation = 'open' | 'read' | 'seek' | 'stat' | 'enumerate';

interface RangeState {
  offset: number;
  length: number;
  count: bigint;
}

interface FileState {
  path: string;
  source: Source;
  opens: { success: bigint; failed: bigint };
  reads: { calls: bigint; requested: bigint; returned: bigint; failed: bigint };
  seeks: { calls: bigint; bytes: bigint };
  stats: { calls: bigint; hits: bigint; misses: bigint };
  enumerations: { calls: bigint; entries: bigint; failed: bigint };
  ranges: RangeState[];
  commonRanges: Map<string, RangeState>;
}

export interface GameBoxFilesystemProfileSnapshot {
  version: typeof GAMEBOX_FILESYSTEM_PROFILE_VERSION;
  running: boolean;
  coverage: 'virtual-filesystem-chokepoints';
  gameContentHash: string | null;
  files: Array<{
    path: string;
    source: Source;
    opens: { success: string; failed: string };
    reads: { calls: string; requestedBytes: string; returnedBytes: string; failed: string };
    seeks: { calls: string; bytes: string };
    stats: { calls: string; hits: string; misses: string };
    enumerations: { calls: string; entries: string; failed: string };
    /** Merged, sorted byte intervals observed by guest reads. */
    ranges: Array<{ offset: string; length: string; reads: string }>;
    /** Most frequently requested exact offset/length pairs. */
    commonRanges: Array<{ offset: string; length: string; reads: string }>;
  }>;
  /** Bounded first-observed order, retained separately from sorted aggregate rows. */
  accessOrder: Array<{
    sequence: string;
    operation: AccessOperation;
    path: string;
    success: boolean;
    offset?: string;
    requestedBytes?: string;
    returnedBytes?: string;
    entries?: string;
  }>;
  counters: {
    opens: string;
    failedOpens: string;
    reads: string;
    requestedBytes: string;
    returnedBytes: string;
    failedReads: string;
    seeks: string;
    stats: string;
    enumerations: string;
    enumeratedEntries: string;
  };
  maxFiles: number;
  maxRanges: number;
  maxPathBytes: number;
  maxAccessOrder: number;
  retainedFiles: number;
  droppedFiles: string;
  droppedRanges: string;
  droppedCommonRanges: string;
  droppedPathBytes: string;
  droppedAccessOrder: string;
  counterOverflow: string;
}

function add(a: bigint, b = 1n): bigint {
  const next = a + b;
  return next > U64_MAX ? U64_MAX : next;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function pathKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
}

function rangeKey(offset: number, length: number): string {
  return `${offset}:${length}`;
}

function decimal(value: bigint): string {
  return value.toString(10);
}

/** One capture is intentionally reusable and never allocates while disabled. */
export class GameBoxFilesystemProfile {
  private runningState = false;
  private files = new Map<string, FileState>();
  private droppedFileKeys = new Set<string>();
  private pathBytesState = 0;
  private rangeCountState = 0;
  private droppedFilesState = 0n;
  private droppedRangesState = 0n;
  private droppedCommonRangesState = 0n;
  private droppedPathBytesState = 0n;
  private droppedAccessOrderState = 0n;
  private accessOrderState: Array<{
    operation: AccessOperation;
    path: string;
    success: boolean;
    offset?: number;
    requestedBytes?: number;
    returnedBytes?: number;
    entries?: number;
  }> = [];
  private gameContentHashState: string | null = null;
  private counterOverflowState = 0n;
  private countersState = {
    opens: 0n,
    failedOpens: 0n,
    reads: 0n,
    requestedBytes: 0n,
    returnedBytes: 0n,
    failedReads: 0n,
    seeks: 0n,
    stats: 0n,
    enumerations: 0n,
    enumeratedEntries: 0n,
  };

  start(gameContentHash?: string, reset = true): void {
    if (reset) this.reset();
    this.gameContentHashState = gameContentHash ?? null;
    this.runningState = true;
  }

  stop(): void {
    this.runningState = false;
  }

  cancel(): void {
    this.runningState = false;
    this.reset();
  }

  reset(): void {
    this.files.clear();
    this.droppedFileKeys.clear();
    this.pathBytesState = 0;
    this.rangeCountState = 0;
    this.droppedFilesState = 0n;
    this.droppedRangesState = 0n;
    this.droppedCommonRangesState = 0n;
    this.droppedPathBytesState = 0n;
    this.droppedAccessOrderState = 0n;
    this.accessOrderState = [];
    this.gameContentHashState = null;
    this.counterOverflowState = 0n;
    for (const key of Object.keys(this.countersState) as Array<keyof typeof this.countersState>)
      this.countersState[key] = 0n;
  }

  isRunning(): boolean {
    return this.runningState;
  }

  private increment(field: keyof typeof this.countersState, value = 1n): void {
    const current = this.countersState[field];
    const next = current + value;
    if (next > U64_MAX) {
      this.countersState[field] = U64_MAX;
      this.counterOverflowState = add(this.counterOverflowState);
    } else {
      this.countersState[field] = next;
    }
  }

  private addDropped(
    field:
      | 'droppedFilesState'
      | 'droppedRangesState'
      | 'droppedCommonRangesState'
      | 'droppedPathBytesState'
      | 'droppedAccessOrderState',
    value = 1n,
  ): void {
    const current = this[field];
    const next = current + value;
    if (next > U64_MAX) {
      this[field] = U64_MAX;
      this.counterOverflowState = add(this.counterOverflowState);
    } else this[field] = next;
  }

  private file(path: string, source: Source): FileState | null {
    const key = pathKey(path);
    const existing = this.files.get(key);
    if (existing) {
      if (existing.source === 'unknown' && source !== 'unknown') existing.source = source;
      return existing;
    }
    const bytes = encoder.encode(path).byteLength;
    if (
      bytes > GAMEBOX_FILESYSTEM_PROFILE_MAX_PATH_BYTES_PER_FILE ||
      this.pathBytesState + bytes > GAMEBOX_FILESYSTEM_PROFILE_MAX_PATH_BYTES
    ) {
      this.addDropped('droppedPathBytesState', BigInt(bytes));
      return null;
    }
    if (this.files.size >= GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES) {
      if (
        !this.droppedFileKeys.has(key) &&
        this.droppedFileKeys.size < GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES
      ) {
        this.droppedFileKeys.add(key);
        this.addDropped('droppedFilesState');
      }
      return null;
    }
    const state: FileState = {
      path,
      source,
      opens: { success: 0n, failed: 0n },
      reads: { calls: 0n, requested: 0n, returned: 0n, failed: 0n },
      seeks: { calls: 0n, bytes: 0n },
      stats: { calls: 0n, hits: 0n, misses: 0n },
      enumerations: { calls: 0n, entries: 0n, failed: 0n },
      ranges: [],
      commonRanges: new Map(),
    };
    this.pathBytesState += bytes;
    this.files.set(key, state);
    return state;
  }

  private recordAccess(
    state: FileState | null,
    operation: AccessOperation,
    success: boolean,
    details: {
      offset?: number;
      requestedBytes?: number;
      returnedBytes?: number;
      entries?: number;
    } = {},
  ): void {
    if (!state) return;
    if (this.accessOrderState.length >= GAMEBOX_FILESYSTEM_PROFILE_MAX_ACCESS_ORDER) {
      this.addDropped('droppedAccessOrderState');
      return;
    }
    this.accessOrderState.push({ operation, path: state.path, success, ...details });
  }

  recordOpen(path: string, source: Source, success: boolean): void {
    if (!this.runningState) return;
    this.increment('opens');
    if (!success) this.increment('failedOpens');
    // Failed loose-file probes are useful aggregate evidence, but they are not
    // launch assets. Do not let thousands of misses evict the successful ROM
    // working set from the bounded compiler profile.
    const state = success ? this.file(path, source) : (this.files.get(pathKey(path)) ?? null);
    if (!state) return;
    if (success) state.opens.success = add(state.opens.success);
    else state.opens.failed = add(state.opens.failed);
    this.recordAccess(state, 'open', success);
  }

  recordRead(
    path: string,
    source: Source,
    offset: number,
    requested: number,
    returned: number,
    success = true,
  ): void {
    if (!this.runningState) return;
    const req = BigInt(safeNumber(requested));
    const got = BigInt(safeNumber(returned));
    this.increment('reads');
    this.increment('requestedBytes', req);
    this.increment('returnedBytes', got);
    if (!success) this.increment('failedReads');
    const state = success ? this.file(path, source) : (this.files.get(pathKey(path)) ?? null);
    if (!state) return;
    state.reads.calls = add(state.reads.calls);
    state.reads.requested = add(state.reads.requested, req);
    state.reads.returned = add(state.reads.returned, got);
    if (!success) state.reads.failed = add(state.reads.failed);
    this.recordAccess(state, 'read', success, {
      offset: safeNumber(offset),
      requestedBytes: safeNumber(requested),
      returnedBytes: safeNumber(returned),
    });
    const start = safeNumber(offset);
    const length = safeNumber(returned);
    if (length <= 0) return;
    if (this.rangeCountState >= GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES) {
      this.addDropped('droppedRangesState');
      return;
    }
    this.rangeCountState++;
    state.ranges.push({ offset: start, length, count: 1n });
    const key = rangeKey(start, safeNumber(requested));
    const common = state.commonRanges.get(key);
    if (common) common.count = add(common.count);
    else if (state.commonRanges.size < GAMEBOX_FILESYSTEM_PROFILE_MAX_COMMON_RANGES)
      state.commonRanges.set(key, { offset: start, length: safeNumber(requested), count: 1n });
    else this.addDropped('droppedCommonRangesState');
  }

  recordSeek(path: string, source: Source, oldOffset: number, newOffset: number): void {
    if (!this.runningState) return;
    this.increment('seeks');
    const state = this.file(path, source);
    if (!state) return;
    state.seeks.calls = add(state.seeks.calls);
    state.seeks.bytes = add(state.seeks.bytes, BigInt(safeNumber(Math.abs(newOffset - oldOffset))));
    this.recordAccess(state, 'seek', true, { offset: safeNumber(newOffset) });
  }

  recordStat(path: string, source: Source, hit: boolean): void {
    if (!this.runningState) return;
    this.increment('stats');
    const state = hit ? this.file(path, source) : (this.files.get(pathKey(path)) ?? null);
    if (!state) return;
    state.stats.calls = add(state.stats.calls);
    if (hit) state.stats.hits = add(state.stats.hits);
    else state.stats.misses = add(state.stats.misses);
    this.recordAccess(state, 'stat', hit);
  }

  recordEnumeration(path: string, source: Source, entries: number, success = true): void {
    if (!this.runningState) return;
    this.increment('enumerations');
    this.increment('enumeratedEntries', BigInt(safeNumber(entries)));
    const state = success ? this.file(path, source) : (this.files.get(pathKey(path)) ?? null);
    if (!state) return;
    state.enumerations.calls = add(state.enumerations.calls);
    state.enumerations.entries = add(state.enumerations.entries, BigInt(safeNumber(entries)));
    if (!success) state.enumerations.failed = add(state.enumerations.failed);
    this.recordAccess(state, 'enumerate', success, { entries: safeNumber(entries) });
  }

  private mergedRanges(
    ranges: RangeState[],
  ): Array<{ offset: string; length: string; reads: string }> {
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset || a.length - b.length);
    const merged: RangeState[] = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && range.offset <= previous.offset + previous.length) {
        const end = Math.max(previous.offset + previous.length, range.offset + range.length);
        previous.length = end - previous.offset;
        previous.count = add(previous.count, range.count);
      } else merged.push({ ...range });
    }
    return merged.map((range) => ({
      offset: decimal(BigInt(range.offset)),
      length: decimal(BigInt(range.length)),
      reads: decimal(range.count),
    }));
  }

  snapshot(): GameBoxFilesystemProfileSnapshot {
    const files = [...this.files.values()]
      .sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path)))
      .map((state) => ({
        path: state.path,
        source: state.source,
        opens: { success: decimal(state.opens.success), failed: decimal(state.opens.failed) },
        reads: {
          calls: decimal(state.reads.calls),
          requestedBytes: decimal(state.reads.requested),
          returnedBytes: decimal(state.reads.returned),
          failed: decimal(state.reads.failed),
        },
        seeks: { calls: decimal(state.seeks.calls), bytes: decimal(state.seeks.bytes) },
        stats: {
          calls: decimal(state.stats.calls),
          hits: decimal(state.stats.hits),
          misses: decimal(state.stats.misses),
        },
        enumerations: {
          calls: decimal(state.enumerations.calls),
          entries: decimal(state.enumerations.entries),
          failed: decimal(state.enumerations.failed),
        },
        ranges: this.mergedRanges(state.ranges),
        commonRanges: [...state.commonRanges.values()]
          .sort((a, b) => (b.count > a.count ? 1 : b.count < a.count ? -1 : a.offset - b.offset))
          .map((range) => ({
            offset: decimal(BigInt(range.offset)),
            length: decimal(BigInt(range.length)),
            reads: decimal(range.count),
          })),
      }));
    return {
      version: GAMEBOX_FILESYSTEM_PROFILE_VERSION,
      running: this.runningState,
      coverage: 'virtual-filesystem-chokepoints',
      gameContentHash: this.gameContentHashState,
      files,
      accessOrder: this.accessOrderState.map((access, index) => ({
        sequence: decimal(BigInt(index)),
        operation: access.operation,
        path: access.path,
        success: access.success,
        ...(access.offset === undefined ? {} : { offset: decimal(BigInt(access.offset)) }),
        ...(access.requestedBytes === undefined
          ? {}
          : { requestedBytes: decimal(BigInt(access.requestedBytes)) }),
        ...(access.returnedBytes === undefined
          ? {}
          : { returnedBytes: decimal(BigInt(access.returnedBytes)) }),
        ...(access.entries === undefined ? {} : { entries: decimal(BigInt(access.entries)) }),
      })),
      counters: Object.fromEntries(
        Object.entries(this.countersState).map(([key, value]) => [key, decimal(value)]),
      ) as GameBoxFilesystemProfileSnapshot['counters'],
      maxFiles: GAMEBOX_FILESYSTEM_PROFILE_MAX_FILES,
      maxRanges: GAMEBOX_FILESYSTEM_PROFILE_MAX_RANGES,
      maxPathBytes: GAMEBOX_FILESYSTEM_PROFILE_MAX_PATH_BYTES,
      maxAccessOrder: GAMEBOX_FILESYSTEM_PROFILE_MAX_ACCESS_ORDER,
      retainedFiles: files.length,
      droppedFiles: decimal(this.droppedFilesState),
      droppedRanges: decimal(this.droppedRangesState),
      droppedCommonRanges: decimal(this.droppedCommonRangesState),
      droppedPathBytes: decimal(this.droppedPathBytesState),
      droppedAccessOrder: decimal(this.droppedAccessOrderState),
      counterOverflow: decimal(this.counterOverflowState),
    };
  }
}

/** Worker-wide collector; all VFS hooks are disabled until a profile starts. */
export const gameBoxFilesystemProfile = new GameBoxFilesystemProfile();
