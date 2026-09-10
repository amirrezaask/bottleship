/**
 * Shared GPU sampler builder/cache for the DirectX backends (DDraw/D3D7, D3D8, D3D9).
 *
 * Why this exists: every DX version expresses the same sampler intent (min/mag/mip filtering,
 * address modes, anisotropy, LOD clamping) but through DIFFERENT raw enum numbering — e.g. the
 * D3D7 mip-filter enum is D3DTFP_NONE=1/POINT=2/LINEAR=3 while D3D9's D3DTEXF_* is
 * NONE=0/POINT=1/LINEAR=2. So the *decode* of raw enums stays version-specific in each backend,
 * but the *descriptor construction* — quality overrides, the WebGPU anisotropy invariant, correct
 * LOD clamping for MIPFILTER=NONE / MAXMIPLEVEL, and sampler caching — is byte-for-byte identical.
 * Centralising it here keeps DX7/D3D8/D3D9 from drifting (a fix in one used to silently miss the others).
 *
 * Semantics notes vs real DirectX (Wine wined3d sampler.c / DXVK d3d9_device.cpp):
 *  - MIPFILTER == NONE means "sample the base level only". Real runtimes pin maxLod to 0; a WebGPU
 *    sampler that merely sets mipmapFilter="nearest" is STILL a mipmapping sampler, so we must set
 *    lodMaxClamp = 0 to actually pin the base level. (Done unless a quality override opts into mips.)
 *  - MAXMIPLEVEL is the index of the LARGEST (most detailed) mip the sampler may use → lodMinClamp.
 *  - MIPMAPLODBIAS is NOT representable on a WebGPU GPUSampler (no lodBias field; it was removed from
 *    the spec). It can only be honored via textureSampleBias() in a shader; documented here, not applied.
 */

import { EmulatorConfig } from "../../../core/emulator-config-manager";

/** Decoded, version-agnostic sampler intent. Filters are already mapped to WebGPU strings; the
 *  semantic flags the builder needs that the strings can't carry are passed alongside. */
export interface SamplerSpec {
    /** WebGPU min filter (anisotropic decodes to "linear"). */
    min: GPUFilterMode;
    /** WebGPU mag filter. */
    mag: GPUFilterMode;
    /** WebGPU mip filter (only consulted when a mip chain exists / a quality override applies). */
    mip: GPUMipmapFilterMode;
    /** True when the game requested NO mip filtering (D3D mip filter == NONE / unset). Pins base level. */
    mipNone: boolean;
    addressU: GPUAddressMode;
    addressV: GPUAddressMode;
    addressW?: GPUAddressMode;
    /** Game-requested max anisotropy: >1 only when the game actually selected anisotropic filtering. */
    gameAnisotropy?: number;
    /** D3D MAXMIPLEVEL: index of the most-detailed usable mip → lodMinClamp. 0/undefined = no clamp. */
    maxMipLevel?: number;
}

const clampAniso = (n: number): number => Math.max(1, Math.min(16, Math.floor(Number.isNaN(n) ? 1 : n)));

/**
 * Cache + factory for DirectX GPU samplers. One instance per backend executor (bound to its GPUDevice).
 * Keyed on the EFFECTIVE descriptor (post quality-override) so two draws that resolve identically share
 * a sampler, and a config change that alters the effective result lands on a fresh key automatically.
 */
export class DxSamplerCache {
    private device: GPUDevice;
    private cache = new Map<number, Map<number, GPUSampler>>();
    private readonly scratch: GPUSamplerDescriptor = {};

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** Resolve a SamplerSpec to an effective GPUSamplerDescriptor, applying quality overrides,
     *  the WebGPU anisotropy invariant, and LOD clamping. Exposed for unit testing;
     *  `quality` is injectable (defaults to the live EmulatorConfig). */
    static resolveDescriptor(
        spec: SamplerSpec,
        quality?: { anisotropy: number; forceTrilinear: boolean },
    ): GPUSamplerDescriptor {
        const desc: GPUSamplerDescriptor = {};
        DxSamplerCache.fillDescriptor(spec, quality ?? EmulatorConfig.getInstance().quality, desc);
        return desc;
    }

    private static fillDescriptor(
        spec: SamplerSpec,
        quality: { anisotropy: number; forceTrilinear: boolean },
        desc: GPUSamplerDescriptor,
    ): void {
        let min = spec.min;
        let mag = spec.mag;
        let mip = spec.mip;
        let aniso = clampAniso(spec.gameAnisotropy ?? 1);

        // Default: MIPFILTER=NONE samples the base level only.
        let baseLevelOnly = spec.mipNone;

        // Quality overrides. NEVER smooth intentionally point-sampled
        // textures (pixel-art / crisp UI) — only upgrade ones the game already filters bilinearly.
        const q = quality;
        const gameUsesPoint = min === "nearest" || mag === "nearest";
        if (q.anisotropy > 1 && !gameUsesPoint) {
            aniso = Math.max(aniso, clampAniso(q.anisotropy));
        }
        if (q.forceTrilinear && !gameUsesPoint) {
            mip = "linear";
            baseLevelOnly = false; // the override explicitly opts into mip sampling
        }

        // WebGPU invariant: maxAnisotropy > 1 requires min/mag/mip all "linear". (Also retroactively
        // fixes a latent spec violation when a game paired anisotropic with a non-linear mip filter.)
        if (aniso > 1) {
            min = "linear";
            mag = "linear";
            mip = "linear";
            baseLevelOnly = false;
        }

        desc.minFilter = min;
        desc.magFilter = mag;
        desc.mipmapFilter = mip;
        desc.addressModeU = spec.addressU;
        desc.addressModeV = spec.addressV;
        desc.addressModeW = spec.addressW ?? "clamp-to-edge";
        desc.maxAnisotropy = aniso;

        // LOD clamping. lodMinClamp from MAXMIPLEVEL (most-detailed usable level);
        // lodMaxClamp=0 pins the base level when no mip filtering was requested.
        const lodMin = spec.maxMipLevel && spec.maxMipLevel > 0 ? spec.maxMipLevel : 0;
        // Reset both fields: the descriptor is reused when sampler intent changes.
        desc.lodMinClamp = lodMin > 0 ? lodMin : undefined;
        desc.lodMaxClamp = baseLevelOnly ? lodMin : undefined;
    }

    /** The 14-bit key is an encoding, not a hash. LOD is kept separate and never truncated. */
    private static keyOf(d: GPUSamplerDescriptor): number {
        return Number(d.minFilter === "linear") |
            (Number(d.magFilter === "linear") << 1) |
            (Number(d.mipmapFilter === "linear") << 2) |
            (addressBits(d.addressModeU) << 3) |
            (addressBits(d.addressModeV) << 5) |
            (addressBits(d.addressModeW) << 7) |
            (((d.maxAnisotropy ?? 1) - 1) << 9) |
            (Number(d.lodMaxClamp !== undefined) << 13);
    }

    /** Cache hits construct neither descriptor objects nor string keys. */
    acquire(spec: SamplerSpec): GPUSampler {
        const desc = this.scratch;
        DxSamplerCache.fillDescriptor(spec, EmulatorConfig.getInstance().quality, desc);
        const key = DxSamplerCache.keyOf(desc);
        const lod = desc.lodMinClamp ?? 0;
        let levels = this.cache.get(key);
        const cached = levels?.get(lod);
        if (cached) return cached;
        const sampler = this.device.createSampler({ ...desc });
        if (!levels) this.cache.set(key, levels = new Map());
        levels.set(lod, sampler);
        return sampler;
    }

    /** Drop cached samplers (e.g. on device loss / executor reset). */
    clear(): void {
        this.cache.clear();
    }
}

function addressBits(mode: GPUAddressMode | undefined): number {
    return mode === "repeat" ? 1 : mode === "mirror-repeat" ? 2 : mode === "clamp-to-edge" ? 0 : 3;
}
