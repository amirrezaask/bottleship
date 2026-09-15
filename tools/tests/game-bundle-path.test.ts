import { describe, expect, test } from 'bun:test';
import { isGameBundlePath } from '../../src/game-bundle-path';

describe('game bundle paths', () => {
  test.each([
    '/apps/example.wgb',
    '/assets/max-payne-2/v2/game.gaf',
    'https://gamebox.test/assets/max-payne/v2/game.GAF?ignored=1',
  ])('recognizes %s', (path) => {
    expect(isGameBundlePath(path)).toBe(true);
  });

  test.each(['/apps/setup.exe', '/assets/game.zip', '/assets/not-gaf'])('rejects %s', (path) => {
    expect(isGameBundlePath(path)).toBe(false);
  });
});
