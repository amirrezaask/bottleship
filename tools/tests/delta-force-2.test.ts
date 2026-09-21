import { describe, expect, test } from 'bun:test';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';
import {
    DELTA_FORCE_2_SOURCE_SHA256,
    normalizeDeltaForce2DisplayMode,
} from '../../src/worker/core/game-fixes/delta-force-2';

const module = (sourceHash: string, isExecutable = true): LoadedPEModule => ({
    name: 'df2',
    path: 'C:\\Df2.exe',
    baseAddress: 0x400000,
    size: 0x1000,
    sourceHash,
    entryPoint: 0,
    exports: new Map(),
    ordinalExports: new Map(),
    isRealDll: false,
    isExecutable,
    initialized: true,
});

describe('Delta Force 2 display-mode guard', () => {
    test('normalizes the reviewed executable to its configured target', () => {
        expect(
            normalizeDeltaForce2DisplayMode(
                module(DELTA_FORCE_2_SOURCE_SHA256),
                { width: 1024, height: 768 },
                { width: 640, height: 480 },
            ),
        ).toEqual({ width: 640, height: 480 });
    });

    test('fails closed for another executable and matching modes', () => {
        const configured = { width: 640, height: 480 };
        expect(normalizeDeltaForce2DisplayMode(module('0'.repeat(64)), { width: 1024, height: 768 }, configured))
            .toEqual({ width: 1024, height: 768 });
        expect(normalizeDeltaForce2DisplayMode(module(DELTA_FORCE_2_SOURCE_SHA256), configured, configured))
            .toEqual(configured);
        expect(normalizeDeltaForce2DisplayMode(module(DELTA_FORCE_2_SOURCE_SHA256, false), { width: 1024, height: 768 }, configured))
            .toEqual({ width: 1024, height: 768 });
    });
});
