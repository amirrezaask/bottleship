import { describe, expect, test } from 'bun:test';
import { summarizeAotExecution } from '../../src/worker/core/gamebox-aot';

describe('AOT execution summary', () => {
  test('counts only cache-backed rows as replayed execution', () => {
    expect(
      summarizeAotExecution(
        [
          { executions: 120, cacheHits: 0 },
          { executions: 40, cacheHits: 1 },
          { executions: 0, cacheHits: 2 },
          { executions: 8, cacheHits: 3 },
        ],
        false,
      ),
    ).toEqual({
      trace2Enabled: false,
      profileRows: 4,
      profileExecutions: 168,
      replayedProfileRows: 3,
      replayedProfileExecutions: 48,
      executedRegions: 3,
    });
  });

  test('does not mistake ordinary JIT execution for prepared replay', () => {
    expect(summarizeAotExecution([{ executions: 99_000, cacheHits: 0 }], false)).toMatchObject({
      profileExecutions: 99_000,
      replayedProfileRows: 0,
      replayedProfileExecutions: 0,
    });
  });
});
