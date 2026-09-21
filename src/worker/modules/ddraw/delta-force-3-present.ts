import type { DDrawContext } from './context';
import {
    DDSCAPS_BACKBUFFER,
    DDSCAPS_FLIP,
    DDSCAPS_PRIMARYSURFACE,
} from './constants';
import {
    DirectDrawSurfaceObject,
    isRenderSurface,
    type DirectDrawSurfaceState,
} from './com-objects';
import { DELTA_FORCE_3_SOURCE_SHA256 } from '../../core/game-fixes/delta-force-3';
import { Logger, LogCategory } from '../../core/logger';

type DeltaForce3BackBuffer = {
    address: number;
    object: DirectDrawSurfaceObject;
    state: DirectDrawSurfaceState;
};

let repairLogCount = 0;
let probeFailureLogCount = 0;
let profileMissLogCount = 0;
let repairAttemptLogCount = 0;
let staleAliasLogCount = 0;
let noCandidateLogCount = 0;
let lastProbeKey = '';
let lastProbeResult: DeltaForce3BackBuffer | null = null;
let lastProbeSummary = '';

/** Keep this compatibility path tied to the reviewed Land Warrior executable. */
export function isDeltaForce3PresentProfile(context: DDrawContext): boolean {
    const executable = context.process.moduleRegistry.getExecutableModule();
    const executableName = executable?.name.toLowerCase().replace(/\.(?:exe|dll)$/, '');
    return executable?.isExecutable === true
        && executable.baseAddress === 0x400000
        && executableName === 'dflw'
        && executable.sourceHash?.toLowerCase() === DELTA_FORCE_3_SOURCE_SHA256;
}

function surfaceAt(context: DDrawContext, address: number): DirectDrawSurfaceObject | null {
    if (!address) return null;
    return context.resourceProvider.getComObjectByAddress(address) as DirectDrawSurfaceObject | null;
}

function isMatchingBackBuffer(
    object: DirectDrawSurfaceObject | null,
    primaryAddress: number,
    primaryState: DirectDrawSurfaceState,
): object is DirectDrawSurfaceObject {
    if (!object || primaryAddress === 0) return false;
    const state = object.getState();
    if ((state.caps & DDSCAPS_BACKBUFFER) === 0 || (state.caps & DDSCAPS_FLIP) === 0) return false;
    if (state.width !== primaryState.width || state.height !== primaryState.height) return false;
    if (state.surfacePtr === primaryState.surfacePtr) return false;
    return !!state.gpuTexture && !!state.gpuTextureView;
}

function addressForObject(context: DDrawContext, object: DirectDrawSurfaceObject): number {
    return context.resourceProvider.getAddressForHandle(object.handle) ?? 0;
}

function candidateScore(candidate: DirectDrawSurfaceState, preferredAddress: number, address: number): number {
    let score = address === preferredAddress ? 1000 : 0;
    // Prefer a target that the D3D executor has actually written when several
    // old same-sized chains are still live.
    if (isRenderSurface(candidate)) {
        if (candidate.gpuWrittenVersion !== undefined && candidate.gpuWrittenVersion === candidate.version) score += 100;
        if (!candidate.gpuDirty) score += 10;
    }
    return score;
}

/** Resolve a live DF3 backbuffer when the guest's chain pointer is stale. */
export function resolveDeltaForce3BackBuffer(
    context: DDrawContext,
    primaryAddress: number,
    primaryState: DirectDrawSurfaceState,
): DeltaForce3BackBuffer | null {
    if (!isDeltaForce3PresentProfile(context)) return null;
    if ((primaryState.caps & DDSCAPS_PRIMARYSURFACE) === 0 || (primaryState.caps & DDSCAPS_FLIP) === 0) return null;

    const probeKey = [
        primaryAddress,
        primaryState.surfacePtr,
        primaryState.width,
        primaryState.height,
        primaryState.attachedSurfaceAddr,
        context.surfaces.backBuffer,
    ].join(':');
    if (probeKey === lastProbeKey) return lastProbeResult;

    const preferredAddresses = [primaryState.attachedSurfaceAddr, context.surfaces.backBuffer];
    const seen = new Set<number>();
    let best: DeltaForce3BackBuffer | null = null;
    let bestScore = -1;

    const consider = (address: number): void => {
        if (!address || seen.has(address)) return;
        seen.add(address);
        const object = surfaceAt(context, address);
        if (!isMatchingBackBuffer(object, primaryAddress, primaryState)) return;
        const state = object.getState();
        const score = candidateScore(state, context.surfaces.backBuffer, address);
        if (!best || score >= bestScore) {
            best = { address, object, state };
            bestScore = score;
        }
    };

    for (const address of preferredAddresses) consider(address);

    // Normal operation should stop here. The full lookup is only for the
    // stale-alias case and is cached by the chain key above.
    if (best) {
        lastProbeKey = probeKey;
        lastProbeResult = best;
        lastProbeSummary = 'preferred';
        return best;
    }

    // Search only live surfaces owned by the same DirectDraw object. This is a
    // bounded fallback for a stale address alias, not a generic same-size pick.
    const owner = primaryState.ownerDirectDrawHandle;
    let surfaceCount = 0;
    let ownerCount = 0;
    let shapeCount = 0;
    let gpuCount = 0;
    for (const object of context.resourceProvider.getAllComObjects()) {
        if (!(object instanceof DirectDrawSurfaceObject)) continue;
        surfaceCount++;
        const state = object.getState();
        if (owner !== undefined && state.ownerDirectDrawHandle !== owner) continue;
        ownerCount++;
        if ((state.caps & DDSCAPS_BACKBUFFER) === 0 || (state.caps & DDSCAPS_FLIP) === 0
            || state.width !== primaryState.width || state.height !== primaryState.height
            || state.surfacePtr === primaryState.surfacePtr) continue;
        shapeCount++;
        if (!state.gpuTexture || !state.gpuTextureView) continue;
        gpuCount++;
        consider(addressForObject(context, object));
    }

    lastProbeKey = probeKey;
    lastProbeResult = best;
    lastProbeSummary = `surfaces=${surfaceCount} owner=${ownerCount} shape=${shapeCount} gpu=${gpuCount}`;
    return best;
}

/** Repair DF3's primary/backbuffer bookkeeping once a trustworthy target exists. */
export function repairDeltaForce3FlipChain(
    context: DDrawContext,
    primaryAddress: number,
    primaryObject: DirectDrawSurfaceObject,
): DeltaForce3BackBuffer | null {
    const profileActive = isDeltaForce3PresentProfile(context);
    const currentState = primaryObject.getState();
    // The menu can flip hundreds of times before Land Warrior switches to its
    // 800x600 mission chain. Keep the diagnostic budget for that late chain so
    // startup telemetry cannot hide the stale-address transition.
    const lateMissionChain = currentState.width >= 800 && currentState.height >= 600;
    if (
        lateMissionChain
        && !surfaceAt(context, currentState.attachedSurfaceAddr)
        && staleAliasLogCount < 4
    ) {
        staleAliasLogCount++;
        Logger.log(
            LogCategory.DDRAW,
            `[Delta Force 3] Stale flip alias: primary=0x${primaryAddress.toString(16)} `
            + `attached=0x${currentState.attachedSurfaceAddr.toString(16)} `
            + `contextBack=0x${context.surfaces.backBuffer.toString(16)}`,
        );
    }
    if (lateMissionChain && repairAttemptLogCount < 8) {
        repairAttemptLogCount++;
        const executable = context.process.moduleRegistry.getExecutableModule();
        Logger.log(
            LogCategory.DDRAW,
            `[Delta Force 3] Flip probe: profile=${profileActive} module=${executable?.name ?? '?'} `
            + `sha=${executable?.sourceHash ?? '?'} primary=0x${primaryAddress.toString(16)} `
            + `ptr=0x${currentState.surfacePtr.toString(16)} caps=0x${currentState.caps.toString(16)} `
            + `attached=0x${currentState.attachedSurfaceAddr.toString(16)} `
            + `contextPrimary=0x${context.surfaces.primary.toString(16)} `
            + `contextBack=0x${context.surfaces.backBuffer.toString(16)}`,
        );
    }
    if (!profileActive) {
        if (profileMissLogCount < 2) {
            profileMissLogCount++;
            const executable = context.process.moduleRegistry.getExecutableModule();
            Logger.warn(
                LogCategory.DDRAW,
                `[Delta Force 3] Present guard inactive: module=${executable?.name ?? '?'} `
                + `base=0x${(executable?.baseAddress ?? 0).toString(16)} `
                + `sha=${executable?.sourceHash ?? '?'}`,
            );
        }
        return null;
    }
    const primaryState = currentState;
    const resolved = resolveDeltaForce3BackBuffer(context, primaryAddress, primaryState);
    if (!resolved) {
        if (lateMissionChain && noCandidateLogCount < 4) {
            noCandidateLogCount++;
            Logger.log(
                LogCategory.DDRAW,
                `[Delta Force 3] Flip probe found no candidate: primary=0x${primaryAddress.toString(16)} `
                + `attached=0x${primaryState.attachedSurfaceAddr.toString(16)} `
                + `contextBack=0x${context.surfaces.backBuffer.toString(16)} ${lastProbeSummary}`,
            );
        }
        if (probeFailureLogCount < 2) {
            probeFailureLogCount++;
            Logger.warn(
                LogCategory.DDRAW,
                `[Delta Force 3] No eligible backbuffer for stale flip alias: `
                + `primary=0x${primaryAddress.toString(16)} `
                + `attached=0x${primaryState.attachedSurfaceAddr.toString(16)} `
                + `contextBackBuffer=0x${context.surfaces.backBuffer.toString(16)} `
                + `${lastProbeSummary}`,
            );
        }
        return null;
    }

    const changed = context.surfaces.backBuffer !== resolved.address
        || primaryState.attachedSurfaceAddr !== resolved.address;
    if (context.surfaces.backBuffer !== resolved.address) context.surfaces.backBuffer = resolved.address;
    if (primaryState.attachedSurfaceAddr !== resolved.address) primaryObject.setAttachedSurface(resolved.address);
    if (changed && repairLogCount < 8) {
        repairLogCount++;
        Logger.log(
            LogCategory.DDRAW,
            `[Delta Force 3] Repaired flip-chain alias: primary=0x${primaryAddress.toString(16)} `
            + `attached=0x${primaryState.attachedSurfaceAddr.toString(16)} `
            + `backBuffer=0x${resolved.address.toString(16)} `
            + `surfacePtr=0x${resolved.state.surfacePtr.toString(16)} `
            + `caps=0x${resolved.state.caps.toString(16)}`,
        );
    }
    return resolved;
}
