import { describe, expect, it } from 'bun:test';
import {
  GRAPHICS_PROFILE_MAX_ROWS,
  GraphicsProfileCollector,
} from '../../src/worker/core/graphics-profile';

const identity = {
  gameContentHash: 'a'.repeat(64),
  runtime: {
    wasmSha256: 'b'.repeat(64),
    javascriptSha256: 'c'.repeat(64),
    graphicsRecipe: 'graphics-recipe-v1',
    abiVersion: 1,
  },
  scenario: 'synthetic-ddraw-ffp',
};

describe('bounded graphics profile collector', () => {
  it('emits the Rust-compatible schema and hashes source at finish', async () => {
    const collector = new GraphicsProfileCollector();
    collector.start(identity);
    const source = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(); }';
    const descriptor = { mode: 'ffp', sampleCount: 1, keyConfig: { vertexType: 7 } };
    collector.recordShader('shader-a', source, 1.23456);
    collector.recordShader('shader-a', source, 2.5, true);
    collector.recordPipeline('pipeline-a', descriptor, 'shader-a', 3.4567);
    collector.recordPipeline('pipeline-a', descriptor, 'shader-a', 1, 2, true);

    const profile = await collector.finish();
    expect(profile.version).toBe(1);
    expect(profile.gameContentHash).toBe(identity.gameContentHash);
    expect(profile.runtime).toEqual(identity.runtime);
    expect(profile.completeness.complete).toBe(true);
    expect(profile.shaders).toHaveLength(1);
    expect(profile.shaders[0]?.uses).toBe('2');
    expect(profile.shaders[0]?.generationUs).toBe('3735');
    expect(profile.shaders[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(profile.pipelines[0]?.shaderHash).toBe(profile.shaders[0]?.hash);
    expect(profile.pipelines[0]?.uses).toBe('2');
    expect(profile.pipelines[0]?.draws).toBe('3');
    expect(typeof profile.pipelines[0]?.descriptor).toBe('string');
    expect(profile.counters.droppedRecords).toBe('0');
    expect(JSON.parse(collector.toJSON())).toEqual(profile);
  });

  it('marks incomplete when rows are dropped or a pipeline has no shader', async () => {
    const collector = new GraphicsProfileCollector();
    collector.start(identity);
    for (let i = 0; i < GRAPHICS_PROFILE_MAX_ROWS + 1; i++)
      collector.recordShader(`shader-${i}`, 'x', 0);
    collector.recordPipeline('orphan', { mode: 'ffp' }, 'missing-shader', 0);
    const profile = await collector.finish();
    expect(profile.completeness.complete).toBe(false);
    expect(Number(profile.counters.droppedRecords)).toBeGreaterThanOrEqual(2);
    expect(profile.pipelines.some((row) => row.key === 'orphan')).toBe(false);
  });

  it('requires identity and rejects inactive finish', async () => {
    const collector = new GraphicsProfileCollector();
    expect(() => collector.start({} as never)).toThrow(
      'Complete trusted graphics profile identity',
    );
    expect(() => collector.start({ ...identity, gpu: { sampleCount: 3 } })).toThrow(
      'Invalid GPU sample count',
    );
    expect(() => collector.finish()).toThrow('No active graphics profile');
    collector.start(identity);
    collector.setGpu({ features: Array.from({ length: 65 }, (_, index) => `feature-${index}`) });
    expect((await collector.finish()).completeness.unsupported).toBe(true);
    collector.start(identity);
    collector.cancel();
    expect(() => collector.finish()).toThrow('No active graphics profile');
  });

  it('fails closed when a stable key resolves to different preparation data', async () => {
    const collector = new GraphicsProfileCollector();
    collector.start(identity);
    collector.recordShader('shader-a', 'source-a', 0);
    collector.recordShader('shader-a', 'source-b', 0);
    collector.recordPipeline('pipeline-a', { z: 1, a: 2 }, 'shader-a', 0);
    collector.recordPipeline('pipeline-a', { a: 2, z: 2 }, 'shader-a', 0);
    const profile = await collector.finish();
    expect(profile.completeness.complete).toBe(false);
    expect(profile.completeness.unsupported).toBe(true);
    expect(profile.counters.droppedRecords).toBe('2');
    expect(profile.pipelines[0]?.descriptor).toBe('{"a":2,"z":1}');
  });

  it('omits rows when JSON escaping would exceed the import ceiling', async () => {
    const collector = new GraphicsProfileCollector();
    collector.start(identity);
    const escapedSource = '\0'.repeat(1024 * 1024);
    collector.recordShader('shader-a', escapedSource, 0);
    collector.recordShader('shader-b', escapedSource, 0);
    collector.recordShader('shader-c', escapedSource, 0);
    const profile = await collector.finish();
    expect(profile.shaders).toHaveLength(0);
    expect(profile.counters.droppedRecords).toBe('3');
    expect(profile.completeness.complete).toBe(false);
    expect(profile.caveats).toContain('serialized graphics profile budget exceeded');
  });
});
