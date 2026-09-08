import { MSSContext } from './context';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Marshaler } from '../../core/memory/marshaler';
import { fpuPush } from '../../core/fpu-helper';
import { decodeStreamFile } from './audio-decode';
import { updateSamplePlayback, updateStreamPlayback, updateEmulatorState } from './playback-engine';

/** Miles 6 floating-point volume API and application-owned archive streams. */
export function registerMilesCompatibility(
  ctx: MSSContext,
  exports: Record<string, ThunkImplementation>,
) {
  // Completion can enqueue several sounds in one heartbeat. Run one guest callback
  // per serve, with its own saved frame, so nested archive reads restore the caller.
  exports['_AIL_serve@0'] = (ctxThunk, mem, args) => {
    updateEmulatorState(ctx);
    const timer = ctx.pendingTimerCallbacks.shift();
    const ended = timer ? undefined : ctx.pendingEOSCallbacks.shift();
    if (!timer && !ended) return 0;
    const cm = ctx.process.dispatcher!.callbackManager;
    const frame = cm.saveSuspendedThunkContext(ctxThunk, 0, 'Miles serve');
    const proc = timer ? timer.callback : ended!.callback;
    const callbackArgs = timer ? [timer.user] : ended!.args ?? [ended!.handle, ended!.user];
    const { callbackId } = cm.invokeCallback(proc, callbackArgs, 0, () => 0, false, 'Miles serve', frame);
    return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: 0 };
  };
  const float = (bits: number) => new Float32Array(new Uint32Array([bits]).buffer)[0];
  const clamp = (level: number) => (Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0);
  const master = (level: number) => {
    ctx.digitalMasterVolume = clamp(level);
    for (const sample of ctx.samples.values())
      if (sample.isPlaying) updateSamplePlayback(ctx, sample);
    for (const stream of ctx.streams.values())
      if (stream.isPlaying) updateStreamPlayback(ctx, stream);
    return 0;
  };
  exports['_AIL_set_digital_master_volume_level@8'] = (_c, _m, args) => master(float(args[1]));
  exports['_AIL_digital_master_volume_level@4'] = () => {
    fpuPush(ctx.process.v86, ctx.digitalMasterVolume);
    return 0;
  };
  exports['_AIL_set_digital_master_volume@8'] = (_c, _m, args) => master(args[1] / 127);
  exports['_AIL_digital_master_volume@4'] = () => Math.round(ctx.digitalMasterVolume * 127);
  // Mixing runs in the browser audio worklet, outside the emulated CPU.
  exports['_AIL_digital_CPU_percent@4'] = () => 0;
  for (const kind of ['sample', 'stream'] as const) {
    exports[`_AIL_set_${kind}_volume_levels@12`] = (_c, _m, args) => {
      const sound = kind === 'sample' ? ctx.samples.get(args[0]) : ctx.streams.get(args[0]);
      if (!sound) return 0;
      const left = clamp(float(args[1])),
        right = clamp(float(args[2]));
      sound.volume = Math.max(left, right) * 127;
      sound.pan = left + right ? (right / (left + right)) * 127 : 64;
      if (kind === 'sample') updateSamplePlayback(ctx, sound as any);
      else updateStreamPlayback(ctx, sound as any);
      return 0;
    };
  }
  exports['_AIL_register_stream_callback@8'] = (_c, _m, args) => {
    const stream = ctx.streams.get(args[0]);
    if (!stream) return 0;
    const old = stream.endCallback ?? 0;
    stream.endCallback = args[1];
    return old;
  };
  // Browser audio has no native DirectSound HWND; retain the association for callers.
  exports['_AIL_set_DirectSound_HWND@8'] = (_c, _m, args) => {
    ctx.driverHwnd = args[1];
    return 0;
  };
  let callbacks: number[] | undefined;
  exports['_AIL_set_file_callbacks@16'] = (_c, _m, args) => {
    callbacks = args.slice(0, 4).every(Boolean) ? args.slice(0, 4) : undefined;
    return 0;
  };
  const archiveRead = (
    thunk: Parameters<ThunkImplementation>[0],
    filename: number,
    cleanup: number,
    sizeOnly: boolean,
    done: (data: Uint8Array, size: number) => number,
  ) => {
    const cm = ctx.process.dispatcher!.callbackManager;
    const [open, close, seek, read] = callbacks!;
    const frame = cm.saveSuspendedThunkContext(thunk, cleanup, 'Miles archive read');
    const scratch = ctx.process.memory.alloc(65536);
    let file = 0,
      size = 0,
      offset = 0,
      data = new Uint8Array(0);
    const invoke = (proc: number, values: number[], done: (result: number) => number | null) =>
      cm.invokeCallback(proc, values, 0, done, false, 'Miles archive read', frame);
    const finish = (ok: boolean): number => {
      ctx.process.memory.free(scratch);
      if (!ok) return 0;
      return done(data, size);
    };
    const shut = (ok: boolean) => {
      invoke(close, [file], () => finish(ok));
      return null;
    };
    const next = (): void => {
      const count = Math.min(65536, size - offset);
      invoke(read, [file, scratch, count], (result) => {
        if (result <= 0 || result > count) return shut(false);
        data.set(ctx.process.getCurrentMemory().subarray(scratch, scratch + result), offset);
        offset += result;
        if (offset === size) return shut(true);
        next();
        return null;
      });
    };
    const { callbackId } = invoke(open, [filename, scratch], (result) => {
      if (!result) return finish(false);
      const memory = ctx.process.getCurrentMemory();
      file = new DataView(memory.buffer, memory.byteOffset, memory.byteLength).getUint32(
        scratch,
        true,
      );
      invoke(seek, [file, 0, 2], (end) => {
        if (end <= 0 || end > 64 * 1024 * 1024) return shut(false);
        size = end;
        if (sizeOnly) return shut(true);
        data = new Uint8Array(size);
        invoke(seek, [file, 0, 0], (start) => {
          if (start !== 0) return shut(false);
          next();
          return null;
        });
        return null;
      });
      return null;
    });
    return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: cleanup };
  };
  const openStream = exports['_AIL_open_stream@12'];
  exports['_AIL_open_stream@12'] = (ctxThunk, mem, args) => {
    const savedArgs = args.slice(0, 3); // Dispatcher reuses its argument array during callbacks.
    if (!callbacks) return openStream(ctxThunk, mem, savedArgs);
    return archiveRead(ctxThunk, savedArgs[1], 12, false, (data) => {
      const memory = ctx.process.getCurrentMemory();
      const handle = openStream(ctxThunk, memory, [savedArgs[0], 0, savedArgs[2]]) as number;
      const stream = ctx.streams.get(handle)!;
      stream.filename = Marshaler.readString(memory, savedArgs[1]);
      stream.fileData = data;
      decodeStreamFile(ctx, stream);
      return handle;
    });
  };
  const pauseStream = exports['_AIL_pause_stream@8'];
  exports['_AIL_pause_stream@8'] = (ctxThunk, mem, args) => {
    const stream = ctx.streams.get(args[0]);
    if (!args[1] && stream && !stream.isPlaying && !stream.isPaused)
      return exports['_AIL_start_stream@4'](ctxThunk, mem, [args[0]]);
    return pauseStream(ctxThunk, mem, args);
  };
  const fileSize = exports['_AIL_file_size@4'];
  exports['_AIL_file_size@4'] = (ctxThunk, mem, args) =>
    !callbacks
      ? fileSize(ctxThunk, mem, args)
      : archiveRead(ctxThunk, args[0], 4, true, (_data, size) => size);
  for (const count of [2, 3]) {
    const name = `_AIL_file_read@${count * 4}`;
    const original = exports[name];
    exports[name] = (ctxThunk, mem, callArgs) => {
      const args = callArgs.slice(0, count);
      return !callbacks
        ? original(ctxThunk, mem, args)
        : archiveRead(ctxThunk, args[0], count * 4, false, (data) => {
            const withSize = args[1] >>> 0 === 0xffffffff;
            const length =
              count === 3 && args[1] && !withSize && args[2] > 0
                ? Math.min(data.length, args[2])
                : data.length;
            const allocate = !args[1] || withSize;
            const destination = allocate
              ? ctx.process.memory.alloc(length + (withSize ? 4 : 0))
              : args[1];
            const memory = ctx.process.getCurrentMemory();
            if (destination < 0 || destination + length + (withSize ? 4 : 0) > memory.length) {
              if (allocate) ctx.process.memory.free(destination);
              return 0;
            }
            if (allocate) ctx.memAllocatedByMss.add(destination);
            if (withSize)
              new DataView(memory.buffer, memory.byteOffset, memory.byteLength).setUint32(
                destination,
                length,
                true,
              );
            memory.set(data.subarray(0, length), destination + (withSize ? 4 : 0));
            return destination;
          });
    };
  }
}
