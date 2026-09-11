import { afterEach, describe, expect, it } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import type { WgbManifest } from "../../src/worker/runtime/filesystem/wgb-loader";

describe("lowest graphics launch policy", () => {
    const config = EmulatorConfig.getInstance();

    afterEach(() => {
        config.setLowestGraphics(false);
        config.quality = {
            anisotropy: 1,
            forceTrilinear: false,
            brightness: 1,
            contrast: 1,
            saturation: 1,
            postAA: "off",
            tonemap: "off",
            vignette: 0,
            integerScale: false,
            aspectMode: "stretch",
            scanlines: false,
            crt: false,
            msaa: 1,
            internalScale: 1,
            autoMipmap: false,
            hdr: false,
        };
    });

    it("resets enhancements and ignores later quality increases", () => {
        config.applyQuality({ anisotropy: 16, postAA: "fxaa", msaa: 4, hdr: true });
        config.setLowestGraphics(true);

        expect(config.quality).toMatchObject({
            anisotropy: 1,
            postAA: "off",
            msaa: 1,
            internalScale: 1,
            autoMipmap: false,
            hdr: false,
        });

        config.applyQuality({ anisotropy: 16, postAA: "fxaa", msaa: 4, hdr: true });
        expect(config.quality).toMatchObject({
            anisotropy: 1,
            postAA: "off",
            msaa: 1,
            hdr: false,
        });

        config.applyFromManifest({
            formatVersion: 2,
            name: "quality override",
            entrypoint: "rom/game.exe",
            emulator: { quality: { anisotropy: 16, postAA: "fxaa", msaa: 4, hdr: true } },
        } as WgbManifest);
        expect(config.quality).toMatchObject({ anisotropy: 1, postAA: "off", msaa: 1, hdr: false });
    });
});
