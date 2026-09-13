/** Bundled into the pinned upstream host; only GameBox's reviewed adapter calls this API. */
export function installGameBoxBridge(worker, closeAudio) {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const bridgeInstalledAt = now();
  let processCreationMs = null;
  let ready = false;
  let launched = false;
  let stopped = false;
  let exited = false;
  let error;
  let fault;
  let closing;
  const pendingProfileRequests = new Set();
  let status = 'Starting BottleShip…';
  const publish = (message) => {
    status = message;
    window.dispatchEvent(new Event('gamebox:bottleship-status'));
  };
  const aotRequest = (mode, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        worker.removeEventListener('message', receive);
        reject(new Error('Translation cache operation timed out'));
      }, 60000);
      const receive = ({ data }) => {
        if (data.type !== 'gamebox_aot_result' || data.id !== id) return;
        clearTimeout(timer);
        worker.removeEventListener('message', receive);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.addEventListener('message', receive);
      worker.postMessage({ type: 'gamebox_aot', id, mode, ...extra });
    });
  const profileRequest = (mode, payload = {}) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let cancel;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        pendingProfileRequests.delete(cancel);
        clearTimeout(timer);
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', workerError);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(result);
      };
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () => finish(new Error('GameBox profile operation timed out')),
        60000,
      );
      const receive = ({ data }) => {
        if (data.type !== 'gamebox_profile_result' || data.id !== id) return;
        if (data.error) finish(new Error(data.error));
        else finish(undefined, data.result);
      };
      const workerError = (event) =>
        finish(new Error(event?.message || 'BottleShip worker failed during profiling'));
      cancel = (reason) => finish(new Error(reason));
      pendingProfileRequests.add(cancel);
      worker.addEventListener('message', receive);
      worker.addEventListener('error', workerError);
      try {
        // The worker API keeps start options under `options`; accept direct
        // options here as the public bridge payload and preserve the explicit
        // { options, graphics } form for callers that already use it.
        const { options, graphics, ...directOptions } = payload ?? {};
        const request =
          mode === 'start'
            ? {
                type: 'gamebox_profile',
                id,
                mode,
                options: options ?? directOptions,
                ...(graphics === undefined ? {} : { graphics }),
              }
            : { type: 'gamebox_profile', id, mode, ...payload };
        worker.postMessage(request);
      } catch (error) {
        finish(error);
      }
    });
  worker.addEventListener('message', ({ data }) => {
    if (
      data.type === 'gamebox_milestone' &&
      data.milestone === 'process_created' &&
      processCreationMs === null
    )
      processCreationMs = now() - bridgeInstalledAt;
    if (data.type === 'ready') {
      ready = true;
      publish('BottleShip ready');
    }
    if (data.type === 'loading_progress') {
      if (exited || error) return;
      publish(data.phase === 'done' ? 'Starting game…' : `Loading game: ${data.phase}`);
    }
    if (data.type === 'first_present' && !exited && !error) publish('Playing');
    if (data.type === 'error') {
      error = String(data.message);
      publish(error);
    }
    if (data.type === 'process_exit') {
      exited = true;
      fault = data.fault;
      if (data.crashed) error = String(data.fault?.reason || 'Game stopped with an error');
      publish(data.crashed ? error : 'Game exited');
    }
  });
  worker.addEventListener('error', (event) => {
    error = event.message || 'BottleShip worker failed';
    publish(error);
  });
  window.GameBoxBottleShip = {
    get startupMilestones() {
      return { processCreationMs };
    },
    get ready() {
      return ready;
    },
    get error() {
      return error;
    },
    get exited() {
      return exited;
    },
    get fault() {
      return fault;
    },
    get status() {
      return status;
    },
    async start({
      gameUrl,
      saveNamespace,
      aotUrl,
      lowestGraphics = false,
      translationCache = 'enabled',
      preparedTrustStore,
      jitConfigOverrides,
    }) {
      if (!ready || launched || stopped)
        throw new Error('BottleShip cannot start another game in this player');
      const url = new URL(gameUrl, location.href);
      if (
        url.origin !== location.origin ||
        !url.pathname.startsWith('/assets/') ||
        !url.pathname.toLowerCase().endsWith('.wgb') ||
        url.search ||
        url.hash
      )
        throw new Error('BottleShip requires a same-origin GameBox bundle');
      // SHA256 keeps case and separators significant, unlike upstream's lossy slug mapping.
      const hash = async (text) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
      const gameId = `app:gamebox-${await hash(saveNamespace)}`;
      const cacheKey = `gamebox-${await hash(url.pathname)}.wgb`;
      worker.postMessage({
        type: 'gamebox_configure',
        gameId,
        cacheKey,
        lowestGraphics: lowestGraphics === true,
        ...(jitConfigOverrides === undefined ? {} : { jitConfigOverrides }),
        ...(preparedTrustStore === undefined ? {} : { preparedTrustStore }),
      });
      launched = true;
      await window.loadApp(url.href);
      // Embedded ?game=dev transfers the canvas before this call and defers v86
      // construction until load_bundle has read manifest.json. Queue AOT/cache
      // work after loadApp so the worker can service it once the manifest-sized
      // emulator exists; the worker drains these requests before PE load. On the
      // ordinary eager path the process already exists, so ordering is unchanged
      // from the caller's perspective.
      if (aotUrl) {
        await aotRequest('load', { url: aotUrl });
      } else if (translationCache !== 'disabled') {
        // Persistence is opportunistic. Unsupported storage, quota pressure, or
        // corrupt data must leave the existing live translator fully usable.
        try {
          if (translationCache === 'reset') await aotRequest('persistent-clear');
          await aotRequest('persistent-start');
        } catch (cacheError) {
          console.warn('Persistent translation cache unavailable:', cacheError);
        }
      }
    },
    async translationCache(mode, payload = {}) {
      const allowed = new Set([
        'stats',
        'report',
        'clear',
        'clear-game',
        'clear-module',
        'clear-all',
        'export',
        'import',
      ]);
      if (!allowed.has(mode)) throw new Error('Unknown translation cache developer operation');
      return aotRequest(`persistent-${mode}`, payload);
    },
    async profile(mode, payload = {}) {
      if (!['start', 'finish', 'cancel'].includes(mode))
        throw new Error('Unknown GameBox profile operation');
      return profileRequest(mode, payload);
    },
    async stop() {
      if (stopped) return;
      if (closing) return closing;
      for (const cancel of pendingProfileRequests) cancel('BottleShip stopped during profiling');
      closing = new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const finish = (failure) => {
          clearTimeout(timeout);
          worker.removeEventListener('message', receive);
          if (failure) {
            reject(new Error(failure));
            return;
          }
          closeAudio().then(() => {
            worker.terminate();
            stopped = true;
            resolve();
          }, reject);
        };
        const receive = ({ data }) => {
          if (data.type === 'gamebox_stopped' && data.id === id) finish(data.error);
        };
        const timeout = setTimeout(
          () => finish('BottleShip did not confirm its saves. Retry Library or use Force close.'),
          30000,
        );
        worker.addEventListener('message', receive);
        worker.postMessage({ type: 'gamebox_stop', id });
      });
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    },
  };
}
