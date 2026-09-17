import { describe, expect, test, beforeEach } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import type { WgbManifest } from "../../src/worker/runtime/filesystem/wgb-loader";

function minimalManifest(emulator: WgbManifest["emulator"]): WgbManifest {
    return {
        formatVersion: 2,
        name: "test",
        entrypoint: "rom/game.exe",
        emulator,
    };
}

describe("EmulatorConfig manifest display modes", () => {
    beforeEach(() => {
        EmulatorConfig.getInstance().reset();
    });

    test("screenResolution.bpp alone does not strip 16bpp from supportedResolutions", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                screenResolution: { width: 800, height: 600, bpp: 32 },
            }),
        );
        const bpps = new Set(cfg.supportedResolutions.map((m) => m.bpp));
        expect(bpps.has(16)).toBe(true);
        expect(bpps.has(32)).toBe(true);
        expect(cfg.supportedResolutions.some((m) => m.width === 640 && m.height === 480 && m.bpp === 16)).toBe(true);
    });

    test("explicit supportedResolutions keeps author-listed depths", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                screenResolution: { width: 800, height: 600, bpp: 32 },
                supportedResolutions: [
                    { width: 640, height: 480, bpp: 16 },
                    { width: 800, height: 600, bpp: 32 },
                ],
            }),
        );
        const bpps = new Set(cfg.supportedResolutions.map((m) => m.bpp));
        expect(bpps.has(16)).toBe(true);
        expect(bpps.has(32)).toBe(true);
    });

    test("accepts a bounded startup input sequence and clears it on reset", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                startupInput: {
                    virtualKey: 0x0d,
                    initialDelayMs: 12_000,
                    intervalMs: 2_000,
                    attempts: 16,
                    holdMs: 200,
                },
            }),
        );
        expect(cfg.startupInput).toEqual({
            virtualKey: 0x0d,
            initialDelayMs: 12_000,
            intervalMs: 2_000,
            attempts: 16,
            holdMs: 200,
        });
        cfg.reset();
        expect(cfg.startupInput).toBeNull();
    });

    test("rejects unbounded startup input sequences", () => {
        const cfg = EmulatorConfig.getInstance();
        cfg.applyFromManifest(
            minimalManifest({
                startupInput: {
                    virtualKey: 0x0d,
                    initialDelayMs: 0,
                    intervalMs: 1,
                    attempts: 10_000,
                },
            }),
        );
        expect(cfg.startupInput).toBeNull();
    });
});
