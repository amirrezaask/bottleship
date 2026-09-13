/**
 * perf — read the worker's own frame profiler (the same data behind the in-app
 * "System Profiler / Worst Frames" panel) directly over the harness RPC, so an
 * agent can capture and attribute stalls WITHOUT grepping the megabyte log
 * firehose or depending on which browser tab streams to the log server.
 *
 *  - perfProfile({enable?, reset?})  arm/disarm + clear the frame profiler.
 *  - perfSpikes({top?, minMs?})      worst frames (frameMs desc) with their
 *                                    category breakdown + hottest thunks — the
 *                                    POJO equivalent of the Worst-Frames UI.
 *  - perfStats()                     latest + average frame sample + spike count.
 *  - perfDistribution()              bounded p50/p95/p99 frame evidence.
 *
 * Self-improvement: replaces ad-hoc PRESENT-DIAG/READBACK-DIAG log probes for
 * "what is the 185ms Flip/Blt spending its time on".
 */

import type { HarnessService } from '../service';
import { frameProfiler, type BadFrameCapture, type FrameSample } from '../../core/frame-profiler';
import { profiler } from '../../core/profiler';

/** Compact a category record to ms (drop zero buckets) for terse output. */
function categoriesMs(categories: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(categories)) {
    if (v && v > 0.05) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

/** Worst-frame capture → terse POJO with the hottest thunks first. */
function summarizeBadFrame(bf: BadFrameCapture, topThunks: number) {
  const thunks = Object.entries(bf.thunkAggregates)
    .map(([name, agg]) => ({
      name,
      count: agg.count,
      totalMs: Math.round(agg.totalMs * 100) / 100,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topThunks);
  return {
    id: bf.id,
    frameMs: Math.round(bf.frameMs * 100) / 100,
    reason: bf.reason,
    categories: categoriesMs(bf.categories),
    topThunks: thunks,
  };
}

function summarizeSample(s: FrameSample | undefined) {
  if (!s) return null;
  return {
    frameMs: Math.round(s.frameMs * 100) / 100,
    fps: Math.round(s.fps * 10) / 10,
    categories: categoriesMs(s.categories),
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export const MIN_POINT_ONE_PERCENT_LOW_SAMPLES = 1_000;

/** Pure helper so percentile semantics are deterministic and independently testable. */
export function summarizeFrameDistribution(frameTimes: number[]) {
  const sorted = frameTimes
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return {
      samples: 0,
      averageFrameMs: null,
      averageFps: null,
      p50FrameMs: null,
      p95FrameMs: null,
      p99FrameMs: null,
      p999FrameMs: null,
      pointOnePercentLowFps: null,
      pointOnePercentLowAvailable: false,
    };
  }
  const averageFrameMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const rounded = (value: number | null) =>
    value === null ? null : Math.round(value * 1000) / 1000;
  const p999FrameMs = percentile(sorted, 0.999);
  const pointOnePercentLowAvailable = sorted.length >= MIN_POINT_ONE_PERCENT_LOW_SAMPLES;
  return {
    samples: sorted.length,
    averageFrameMs: rounded(averageFrameMs),
    averageFps: rounded(1000 / averageFrameMs),
    p50FrameMs: rounded(percentile(sorted, 0.5)),
    p95FrameMs: rounded(percentile(sorted, 0.95)),
    p99FrameMs: rounded(percentile(sorted, 0.99)),
    p999FrameMs: pointOnePercentLowAvailable ? rounded(p999FrameMs) : null,
    pointOnePercentLowFps:
      pointOnePercentLowAvailable && p999FrameMs !== null ? rounded(1000 / p999FrameMs) : null,
    pointOnePercentLowAvailable,
  };
}

export function registerPerfCommands(svc: HarnessService): void {
  /** perfProfile({enable?=true, reset?=false}) — arm/disarm + clear BOTH the frame
   *  profiler (worst-frames/thunk-level) and the named-bucket profiler (sub-phase
   *  timings like "Blt:mixedGpuPath:upload"), so perfSpikes + profilerStats line up. */
  svc.register('perfProfile', (args) => {
    const opts = (args[0] ?? {}) as { enable?: boolean; reset?: boolean };
    const enable = opts.enable ?? true;
    frameProfiler.setEnabled(enable); // setEnabled(true) resets internally
    if (opts.reset) frameProfiler.reset();
    profiler.setEnabled(enable); // setEnabled(false) resets internally
    if (enable && opts.reset) profiler.reset();
    return { enabled: enable };
  });

  /** perfTiming({enable?, reset?}) — retain only bounded frame intervals.
   * This is suitable for performance samples because it does not arm the
   * detailed category/thunk profiler (or the v86 trace recorder). */
  svc.register('perfTiming', (args) => {
    const opts = (args[0] ?? {}) as { enable?: boolean; reset?: boolean };
    const enable = opts.enable ?? true;
    frameProfiler.setTimingEnabled(enable);
    if (opts.reset) frameProfiler.reset();
    return { enabled: frameProfiler.isTimingEnabled() };
  });

  /** profilerStats({filter?, top?=20, sort?='max'}) — named-bucket timings (avg/total/max/count).
   *  maxTime captures the WORST single call → e.g. profilerStats({filter:'Blt'}) names the
   *  exact sub-phase eating a ~175ms Blt spike. */
  svc.register('profilerStats', (args) => {
    const opts = (args[0] ?? {}) as {
      filter?: string;
      top?: number;
      sort?: 'max' | 'total' | 'avg';
    };
    const top = opts.top ?? 20;
    const sortKey = opts.sort ?? 'max';
    const raw = profiler.getStats() as Record<
      string,
      { avgTime: number; totalTime: number; count: number; maxTime: number }
    >;
    const rows = Object.entries(raw)
      .filter(([id]) => !opts.filter || id.toLowerCase().includes(opts.filter.toLowerCase()))
      .map(([id, s]) => ({
        id,
        maxMs: Math.round(s.maxTime * 100) / 100,
        avgMs: Math.round(s.avgTime * 100) / 100,
        totalMs: Math.round(s.totalTime * 100) / 100,
        count: s.count,
      }))
      .sort((a, b) =>
        sortKey === 'total'
          ? b.totalMs - a.totalMs
          : sortKey === 'avg'
            ? b.avgMs - a.avgMs
            : b.maxMs - a.maxMs,
      )
      .slice(0, top);
    return { enabled: profiler.isEnabled(), bucketCount: Object.keys(raw).length, rows };
  });

  /** perfSpikes({top?=8, minMs?=0}) — worst frames with category + hot-thunk breakdown. */
  svc.register('perfSpikes', (args) => {
    const opts = (args[0] ?? {}) as { top?: number; minMs?: number };
    const topThunks = opts.top ?? 8;
    const minMs = opts.minMs ?? 0;
    const snap = frameProfiler.getSnapshot();
    const spikes = (snap.badFrames ?? [])
      .filter((bf) => bf.frameMs >= minMs)
      .sort((a, b) => b.frameMs - a.frameMs)
      .map((bf) => summarizeBadFrame(bf, topThunks));
    return {
      enabled: snap.enabled,
      source: snap.source,
      sampleCount: snap.sampleCount,
      average: summarizeSample(snap.average),
      spikeCount: spikes.length,
      spikes,
    };
  });

  /** perfStats() — latest + average frame sample (no per-frame thunk detail). */
  svc.register('perfStats', () => {
    const snap = frameProfiler.getSnapshot();
    return {
      enabled: snap.enabled,
      source: snap.source,
      sampleCount: snap.sampleCount,
      latest: summarizeSample(snap.latest),
      average: summarizeSample(snap.average),
      spikeCount: (snap.badFrames ?? []).length,
    };
  });

  /** Bounded retained-window distribution. Completeness fields make it
   * explicit when older frames were overwritten before collection. */
  svc.register('perfDistribution', () => {
    const snap = frameProfiler.getTimingSnapshot();
    return {
      enabled: snap.enabled,
      source: snap.source,
      windowSize: snap.windowSize,
      totalSampleCount: snap.totalSampleCount,
      retainedSampleCount: snap.retainedSampleCount,
      droppedSamples: snap.droppedSamples,
      counterOverflow: snap.counterOverflow,
      ...summarizeFrameDistribution(snap.frameTimesMs),
    };
  });
}
