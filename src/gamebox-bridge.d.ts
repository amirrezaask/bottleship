export interface GameBoxProfileStartPayload extends Record<string, unknown> {
  /** Optional explicit wrapper; direct profile options are accepted as well. */
  options?: Record<string, unknown>;
  graphics?: Record<string, unknown>;
}

export type GameBoxJitConfigOverride = readonly [index: number, value: number];

export interface GameBoxStartOptions {
  /** The embedded ?game=dev path preflights manifest.json before constructing v86. */
  gameUrl: string;
  saveNamespace: string;
  aotUrl?: string;
  lowestGraphics?: boolean;
  translationCache?: 'enabled' | 'disabled' | 'reset';
  preparedTrustStore?: Record<string, string>;
  /** Applied before bundle preflight; raw and prepared candidates must share it. */
  jitConfigOverrides?: readonly GameBoxJitConfigOverride[];
}

export interface GameBoxProfileBridge {
  readonly startupMilestones: { readonly processCreationMs: number | null };
  profile(mode: 'start', payload?: GameBoxProfileStartPayload): Promise<unknown>;
  profile(mode: 'finish' | 'cancel', payload?: Record<string, unknown>): Promise<unknown>;
}

export function installGameBoxBridge(worker: Worker, closeAudio: () => Promise<void>): void;
