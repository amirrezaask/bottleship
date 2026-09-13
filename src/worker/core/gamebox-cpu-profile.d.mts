export interface ProfileOptions {
  gameContentHash: string;
  runtimeWasmSha256: string;
  runtimeJavascriptSha256: string;
  scenario: string;
  modules: { sourceSha256: string; base: number; size: number }[];
  pages: number[];
  isPaused(): boolean;
  calls?: {
    isRunning?(): boolean;
    start(): void;
    stop(): void;
    snapshot(): {
      rows: { name: string; count: string }[];
      dropped: string;
      counterOverflow?: string;
    };
  };
}
export interface ProfileSession {
  isActive(): boolean;
  cancel(): void;
  finish(): Promise<Record<string, unknown>>;
}
export function startCpuProfile(cpu: unknown, options: ProfileOptions): Promise<ProfileSession>;
