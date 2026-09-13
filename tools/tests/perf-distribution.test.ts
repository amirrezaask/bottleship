import { describe, expect, test } from 'bun:test';
import { summarizeFrameDistribution } from '../../src/worker/harness/cmds/perf';

describe('bounded frame distribution', () => {
  test('uses deterministic nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarizeFrameDistribution(values)).toEqual({
      samples: 100,
      averageFrameMs: 50.5,
      averageFps: 19.802,
      p50FrameMs: 50,
      p95FrameMs: 95,
      p99FrameMs: 99,
      p999FrameMs: null,
      pointOnePercentLowFps: null,
      pointOnePercentLowAvailable: false,
    });
  });

  test('reports a defined p99.9 reciprocal only with enough samples', () => {
    const values = Array.from({ length: 1_000 }, (_, index) => index + 1);
    expect(summarizeFrameDistribution(values)).toMatchObject({
      samples: 1_000,
      p999FrameMs: 999,
      pointOnePercentLowFps: 1.001,
      pointOnePercentLowAvailable: true,
    });
  });

  test('drops invalid samples and reports an explicit empty result', () => {
    expect(summarizeFrameDistribution([Number.NaN, -1, 0, Number.POSITIVE_INFINITY])).toEqual({
      samples: 0,
      averageFrameMs: null,
      averageFps: null,
      p50FrameMs: null,
      p95FrameMs: null,
      p99FrameMs: null,
      p999FrameMs: null,
      pointOnePercentLowFps: null,
      pointOnePercentLowAvailable: false,
    });
  });
});
