/**
 * Texture / VRAM reading + frame capture.
 *
 * - textures(): a backend-agnostic gallery — DDraw/D3D7/D3D8 surfaces + D3D9
 *   TextureStore slots.
 * - dumpSurface(sel)/dumpTexture(sel): full-RGBA readback -> PNG (logs/debug/),
 *   preferring the authoritative rgbaScratch (zero GPU) for bitmap textures.
 * - expectSurfaceNonBlack(sel): cheap liveness assertion over a subsampled
 *   readback (reuses the existing dbgReadSurfacePixels nonBlackPct).
 * - captureFrame(): the RenderDoc-style per-draw capture. Works for the FFP
 *   backends (DDraw/D3D7, and D3D8 which loads the ddraw module's executor) via
 *   the existing frame-capture. D3D9 per-draw producers remain unimplemented.
 */

import type { HarnessService, HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { getModule, serializeSurfaces } from "../serialize";
import { bytesToBase64 } from "./screen";
import { devices as d3d9Devices } from "../../modules/d3d9/shared-state";
import { devices as d3d8Devices } from "../../modules/d3d8/shared-state";
import { startCapture as frameCaptureStart } from "../../modules/ddraw/frame-capture";
import { asArrayBufferView } from "../../../dom-buffer";

function ddraw(): any {
    return getModule("ddraw");
}

/** Resolve a surface selector to a pixel pointer (hex/number, or "primary"/"backbuffer"). */
function resolvePtr(sel: unknown): number {
    const dd = ddraw();
    if (sel === "primary") return (dd?.context?.surfaces?.primary ?? 0) >>> 0;
    if (sel === "backbuffer" || sel === "backBuffer") return (dd?.context?.surfaces?.backBuffer ?? 0) >>> 0;
    if (typeof sel === "number") return sel >>> 0;
    if (typeof sel === "string") return (sel.startsWith("0x") ? parseInt(sel.slice(2), 16) : parseInt(sel, 16)) >>> 0;
    throw new HarnessError(`bad surface selector ${JSON.stringify(sel)}`, HarnessErrorCode.BAD_ARGS);
}

export async function encodePngBase64(rgba: Uint8Array, w: number, h: number): Promise<string> {
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d");
    if (!ctx) throw new HarnessError("OffscreenCanvas 2d unavailable", HarnessErrorCode.UNSUPPORTED);
    ctx.putImageData(new ImageData(asArrayBufferView(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4)), w, h), 0, 0);
    const blob = await cv.convertToBlob({ type: "image/png" });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function registerTextureCommands(svc: HarnessService): void {
    /** textures() — gallery across backends. */
    svc.register("textures", () => {
        const ddrawSurfaces = (serializeSurfaces() as any[]).map((s) => ({ ...s, backend: "ddraw" }));
        const d3d9: unknown[] = [];
        for (const [ptr, dev] of d3d9Devices) {
            const info = (dev as any).getTexturesDebugInfo?.() ?? [];
            for (const t of info) d3d9.push({ ...t, backend: "d3d9", device: ptr >>> 0 });
        }
        const d3d8: unknown[] = [];
        for (const [ptr, device] of d3d8Devices) {
            for (const [texturePtr, surfaceValue] of device.texSurfaces) {
                const surface: any = surfaceValue;
                const rgba = surface.rgbaScratch as Uint8Array | undefined;
                d3d8.push({
                    backend: "d3d8-all",
                    device: ptr >>> 0,
                    stage: null,
                    ptr: texturePtr >>> 0,
                    surfacePtr: surface.surfacePtr >>> 0,
                    width: surface.width,
                    height: surface.height,
                    d3dFormat: surface.d3dFormat ?? null,
                    rgbaScratchPresent: !!rgba,
                });
            }
            for (let stage = 0; stage < device.textures.length; stage++) {
                const surface: any = device.textures[stage];
                if (!surface) continue;
                const rgba = surface.rgbaScratch as Uint8Array | undefined;
                let bright = 0;
                let max = 0;
                if (rgba) {
                    for (let i = 0; i < rgba.length; i += 4) {
                        const luma = Math.max(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
                        if (luma > 80) bright++;
                        if (luma > max) max = luma;
                    }
                }
                let ascii: string[] | null = null;
                if (rgba && surface.width === 256 && surface.height === 64) {
                    ascii = [];
                    for (let gy = 0; gy < 16; gy++) {
                        let row = "";
                        for (let gx = 0; gx < 64; gx++) {
                            let count = 0;
                            for (let y = gy * 4; y < (gy + 1) * 4; y++) {
                                for (let x = gx * 4; x < (gx + 1) * 4; x++) {
                                    const off = (y * surface.width + x) * 4;
                                    if (Math.max(rgba[off] ?? 0, rgba[off + 1] ?? 0, rgba[off + 2] ?? 0) > 90) count++;
                                }
                            }
                            row += count >= 4 ? "#" : count > 0 ? "." : " ";
                        }
                        ascii.push(row);
                    }
                }
                d3d8.push({
                    backend: "d3d8",
                    device: ptr >>> 0,
                    stage,
                    ptr: surface.surfacePtr >>> 0,
                    width: surface.width,
                    height: surface.height,
                    d3dFormat: surface.d3dFormat ?? null,
                    rgbaScratchPresent: !!rgba,
                    brightPct: rgba ? (bright / Math.max(1, rgba.length / 4)) * 100 : null,
                    maxLuma: max,
                    sample: rgba ? Array.from(rgba.subarray(0, Math.min(64, rgba.length))) : null,
                    ascii,
                });
            }
        }
        return { ddraw: ddrawSurfaces, d3d8, d3d9 };
    });

    svc.register("d3d8TexturePng", async (args) => {
        const stage = typeof args[0] === "number" ? args[0] : 0;
        for (const device of d3d8Devices.values()) {
            const surface: any = device.textures[stage];
            if (surface?.rgbaScratch && surface.width && surface.height) {
                return {
                    stage,
                    width: surface.width,
                    height: surface.height,
                    base64: await encodePngBase64(surface.rgbaScratch, surface.width, surface.height),
                };
            }
        }
        throw new HarnessError("no bound D3D8 texture", HarnessErrorCode.NOT_FOUND);
    });

    /** dumpSurface(sel, {save?}) — DDraw surface -> PNG. */
    const dump = async (args: unknown[]) => {
        const ptr = resolvePtr(args[0]);
        if (!ptr) throw new HarnessError("surface pointer is 0 (no such surface / not initialized)", HarnessErrorCode.NOT_FOUND);
        const dd = ddraw();
        if (!dd?.readSurfaceRGBA) throw new HarnessError("ddraw module not loaded (D3D9-only games not yet supported for surface dump)", HarnessErrorCode.UNSUPPORTED);
        const r = await dd.readSurfaceRGBA(ptr);
        if ("err" in r) throw new HarnessError(`readSurfaceRGBA: ${r.err}`, HarnessErrorCode.INTERNAL);
        const opts = (args[1] ?? {}) as { save?: string };
        const name = (opts.save ?? `surf_${ptr.toString(16)}_${r.w}x${r.h}`).replace(/\.png$/i, "");
        const base64 = await encodePngBase64(r.rgba, r.w, r.h);
        (self as unknown as Worker).postMessage({ type: "debug_png_dump", name, base64 });
        return { saved: `logs/debug/${name}.png`, ptr: "0x" + ptr.toString(16), w: r.w, h: r.h, source: r.source };
    };
    svc.register("dumpSurface", dump);
    svc.register("dumpTexture", dump);

    /** expectSurfaceNonBlack(sel?, minPct?) — assertion (throws if black). */
    svc.register("expectSurfaceNonBlack", async (args) => {
        const sel = args[0] ?? "primary";
        const minPct = typeof args[1] === "number" ? (args[1] as number) : 1;
        const ptr = resolvePtr(sel);
        const dd = ddraw();
        if (!dd?.dbgReadSurfacePixels) throw new HarnessError("ddraw module not loaded", HarnessErrorCode.UNSUPPORTED);
        const r = await dd.dbgReadSurfacePixels(ptr);
        if (r?.err) throw new HarnessError(`readback failed: ${r.err}`, HarnessErrorCode.INTERNAL);
        if (!(r.nonBlackPct >= minPct)) {
            throw new HarnessError(`surface ${typeof sel === "string" ? sel : "0x" + ptr.toString(16)} is black: nonBlackPct=${r.nonBlackPct}% < ${minPct}% (avg=${r.avg})`, HarnessErrorCode.NOT_FOUND);
        }
        return { ok: true, ptr: "0x" + ptr.toString(16), nonBlackPct: r.nonBlackPct, avg: r.avg, w: r.w, h: r.h };
    });

    /** surfacePixels(sel) — the existing luminance/grid stats (no PNG). */
    svc.register("surfacePixels", async (args) => {
        const ptr = resolvePtr(args[0] ?? "primary");
        const dd = ddraw();
        if (!dd?.dbgReadSurfacePixels) throw new HarnessError("ddraw module not loaded", HarnessErrorCode.UNSUPPORTED);
        return dd.dbgReadSurfacePixels(ptr);
    });

    /** captureFrame(opts) — arm the per-draw CaptureBus for the next frame. Backend-
     *  agnostic now: DDraw/D3D7 (full FFP), D3D8 (full FFP via the shared executor),
     *  D3D9 (backend-tagged minimal draws). Resolves at the next present (onFrameEnd). */
    svc.register("captureFrame", async (args, ctx: HarnessCtx) => {
        const opts = (args[0] ?? {}) as { timeoutMs?: number };
        const timeoutMs = opts.timeoutMs ?? 5000;
        const frame = await Promise.race([
            frameCaptureStart(),
            new Promise((_res, rej) => {
                const t = setTimeout(() => rej(new HarnessError(`no frame presented within ${timeoutMs}ms`, HarnessErrorCode.TIMEOUT)), timeoutMs);
                ctx.signal.addEventListener("abort", () => { clearTimeout(t); rej(ctx.signal.reason ?? new HarnessError("aborted", HarnessErrorCode.CANCELLED)); }, { once: true });
            }),
        ]);
        return frame;
    });
}
