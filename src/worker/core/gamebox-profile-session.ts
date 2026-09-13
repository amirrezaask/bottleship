import {
  startCpuProfile,
  type ProfileOptions,
  type ProfileSession,
} from './gamebox-cpu-profile.mjs';
import { gameBoxCallProfile } from './diagnostics/gamebox-call-profile';
import { gameBoxFilesystemProfile } from './diagnostics/gamebox-filesystem-profile';
import {
  cancelNativeCrossingProfile,
  finishNativeCrossingProfile,
  startNativeCrossingProfile,
  type NativeCrossingProfile,
} from './diagnostics/native-crossing-profile';

let active: ProfileSession | null = null;
let pending = false;
let finishing = false;
let epoch = 0;
let nativeProfileActive = false;

export async function startGameBoxProfile(
  cpu: unknown,
  options: Omit<ProfileOptions, 'calls'>,
): Promise<void> {
  if (active || pending || finishing) throw new Error('A GameBox profile is already active');
  pending = true;
  const generation = ++epoch;
  gameBoxFilesystemProfile.start(options.gameContentHash);
  let session: ProfileSession | null = null;
  try {
    session = await startCpuProfile(cpu, {
      ...options,
      calls: gameBoxCallProfile,
      isPaused: () => generation === epoch && options.isPaused(),
    });
    if (generation !== epoch) {
      session.cancel();
      gameBoxFilesystemProfile.cancel();
      return;
    }
    nativeProfileActive = startNativeCrossingProfile();
    active = session;
  } catch (error) {
    session?.cancel();
    cancelNativeCrossingProfile();
    nativeProfileActive = false;
    gameBoxFilesystemProfile.cancel();
    throw error;
  } finally {
    pending = false;
  }
}

export async function finishGameBoxProfile(): Promise<Record<string, unknown>> {
  if (!active || finishing) throw new Error('No idle GameBox profile is available to finish');
  const session = active;
  finishing = true;
  try {
    const profile = await session.finish();
    const native: NativeCrossingProfile = nativeProfileActive
      ? finishNativeCrossingProfile()
      : {
          nativeHypercallObserved: false,
          nativeHypercallAttributionObserved: false,
          nativeHypercallHandlers: [],
          nativeWriteBufferObserved: false,
          hypercallCalls: '0',
          writeBufferEntries: '0',
          writeBufferOutTrapCalls: '0',
          writeBufferCoalescedSkips: '0',
          writeBufferBarrierEntries: '0',
          timingObserved: false,
          counterOverflow: false,
        };
    nativeProfileActive = false;
    gameBoxFilesystemProfile.stop();
    return {
      ...profile,
      filesystem: gameBoxFilesystemProfile.snapshot(),
      nativeCrossings: native,
    };
  } catch (error) {
    cancelNativeCrossingProfile();
    nativeProfileActive = false;
    gameBoxFilesystemProfile.stop();
    throw error;
  } finally {
    finishing = false;
    if (!session.isActive() && active === session) active = null;
  }
}

/** Called before the worker releases its CPU and cached translations. */
export function cancelGameBoxProfile(): void {
  epoch++;
  try {
    active?.cancel();
  } finally {
    active = null;
    cancelNativeCrossingProfile();
    nativeProfileActive = false;
    gameBoxCallProfile.stop();
    gameBoxFilesystemProfile.cancel();
  }
}
