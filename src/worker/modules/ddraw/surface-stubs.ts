/**
 * IDirectDrawSurface7 stub methods and delegate lists.
 * Real implementations (IsLost, Restore, etc.) live in surface.ts.
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { allocateComObject, DD_OK, DDSCAPS_TEXTURE, DDGAMMARAMP_SIZE, E_FAIL, E_POINTER } from "./constants";
import { DirectDrawObject, DirectDrawSurfaceObject } from "./com-objects";
import { isValidAddress } from "../../core/memory/address-guard";
import { gammaService } from "../../core/gamma-service";
import type { DDrawContext } from "./context";
import { Mem } from "../../core/memory/mem-accessor";

export function createSurfaceStubsExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubMethods = [
        "AddOverlayDirtyRect",
        "BltBatch",
        "DeleteAttachedSurface",
        "EnumOverlayZOrders",
        "GetOverlayPosition",
        "GetPalette",
        "Initialize",
        "SetOverlayPosition",
        "UpdateOverlay",
        "UpdateOverlayDisplay",
        "UpdateOverlayZOrder",
        "PageLock",
        "PageUnlock",
        "SetPrivateData",
        "GetPrivateData",
        "FreePrivateData",
        "GetUniquenessValue",
        "ChangeUniquenessValue",
        "SetPriority",
        "GetPriority",
        "SetLOD",
        "GetLOD",
    ];

    for (const method of stubMethods) {
        if (method === "BltBatch") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                Logger.log(LogCategory.SYSTEM, `IDirectDrawSurface7_BltBatch: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        } else if (method === "GetPalette" || method === "SetLOD" || method === "GetLOD") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const thisPtr = args[0];
                const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
                const isTexture = obj ? (obj.getState().caps & DDSCAPS_TEXTURE) !== 0 : false;
                const msg = `IDirectDrawSurface7_${method}: this=0x${thisPtr.toString(16)}${isTexture ? " [TEXTURE]" : ""}`;
                Logger.log(LogCategory.SYSTEM, msg);
                if (isTexture) {
                    Logger.log(LogCategory.DDRAW, msg);
                }
                return DD_OK;
            };
        } else {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
                Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface7_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return DD_OK;
            };
        }
    }

    // GetDDInterface returns the DirectDraw object which created the surface.
    // Returning DD_OK without initializing the output pointer is not a harmless
    // stub: Delta Force: Land Warrior immediately calls CreateSurface through
    // that pointer while entering a mission and otherwise dereferences NULL.
    exports["IDirectDrawSurface7_GetDDInterface"] = (_ctx, mem, args) => {
        const lplpDD = args[1] >>> 0;
        if (!lplpDD || !isValidAddress(mem, lplpDD, 4)) return E_POINTER;

        const surface = context.resourceProvider.getComObjectByAddress(args[0]) as DirectDrawSurfaceObject | null;
        const ownerHandle = surface?.getState().ownerDirectDrawHandle;
        let ddrawObj = ownerHandle !== undefined
            ? context.resourceProvider.getComObject(ownerHandle)
            : null;
        let ddrawAddr = ddrawObj
            ? (context.resourceProvider.getAddressForHandle(ddrawObj.handle) ?? 0) >>> 0
            : context.ddraw7ObjectAddr >>> 0;
        ddrawObj = ddrawObj ?? (ddrawAddr
            ? context.resourceProvider.getComObjectByAddress(ddrawAddr)
            : null);

        // Enumeration-heavy titles can release and recreate DirectDraw objects.
        // Fall back to the newest live instance if the tracked address is stale.
        if (!ddrawObj || ddrawObj.constructor.name !== "DirectDrawObject") {
            ddrawObj = null;
            let newestHandle = -1;
            for (const candidate of context.resourceProvider.getAllComObjects()) {
                if (candidate.constructor.name !== "DirectDrawObject" || candidate.handle <= newestHandle) {
                    continue;
                }
                const candidateAddr = context.resourceProvider.getAddressForHandle(candidate.handle);
                if (!candidateAddr) continue;
                newestHandle = candidate.handle;
                ddrawObj = candidate;
                ddrawAddr = candidateAddr >>> 0;
            }
        }

        // Some DX7 engines release the factory after creating their device and
        // later recover it through a render target. If legacy object lifetime
        // bookkeeping already retired every wrapper, recreate the lightweight
        // DirectDraw interface over the same shared context. This mirrors the
        // still-live native parent represented by the surface/device graph.
        let createdForReturn = false;
        if (!ddrawObj || !ddrawAddr) {
            const vtable = context.vtables["IDirectDraw7"];
            if (vtable) {
                const replacement = new DirectDrawObject(vtable.address);
                const replacementAddr = allocateComObject(context.process.memory, mem, vtable.address);
                context.resourceProvider.mapAddressToHandle(replacementAddr, replacement.handle);
                context.ddraw7ObjectAddr = replacementAddr;
                // Hold one context-owned reference for the remainder of the
                // session. The guest owns the constructor's initial reference
                // returned below and may release it immediately.
                replacement.addRef();
                ddrawObj = replacement;
                ddrawAddr = replacementAddr;
                createdForReturn = true;
                Logger.log(
                    LogCategory.DDRAW,
                    `IDirectDrawSurface7_GetDDInterface: restored owning DirectDraw wrapper at 0x${ddrawAddr.toString(16)}`,
                );
            }
        }

        if (!ddrawObj || !ddrawAddr) {
            Mem.writeUint32(lplpDD, 0);
            Logger.warn(
                LogCategory.DDRAW,
                `IDirectDrawSurface7_GetDDInterface: no live DirectDraw object ` +
                `(surface=${surface ? "live" : "missing"}, ownerHandle=${ownerHandle === undefined ? "none" : `0x${ownerHandle.toString(16)}`}, ` +
                `trackedAddr=0x${context.ddraw7ObjectAddr.toString(16)})`,
            );
            return E_FAIL;
        }

        if (!createdForReturn) ddrawObj.addRef();
        Mem.writeUint32(lplpDD, ddrawAddr);
        Logger.verbose(
            LogCategory.DDRAW,
            `IDirectDrawSurface7_GetDDInterface: surface=0x${(args[0] >>> 0).toString(16)} -> 0x${ddrawAddr.toString(16)}`,
        );
        return DD_OK;
    };

    // =========================================================================
    // IDirectDrawGammaControl stubs
    // =========================================================================

    exports["IDirectDrawGammaControl_QueryInterface"] = (ctx, mem, args) => {
        Logger.log(LogCategory.COM, `IDirectDrawGammaControl_QueryInterface: this=0x${args[0].toString(16)} (stub)`);
        return 0x80004002; // E_NOINTERFACE
    };

    exports["IDirectDrawGammaControl_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawGammaControl_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // GetGammaRamp(dwFlags, lpRampData) — write the current ramp (or linear identity) back to the guest.
    exports["IDirectDrawGammaControl_GetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.writeToGuest(mem, lpRampData);
        return DD_OK;
    };

    // SetGammaRamp(dwFlags, lpRampData) — read the ramp from guest memory and apply via the shared sink.
    exports["IDirectDrawGammaControl_SetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.applyFromGuest(mem, lpRampData);
        Logger.verbose(LogCategory.DDRAW, "IDirectDrawGammaControl_SetGammaRamp: applied");
        return DD_OK;
    };

    return exports;
}
