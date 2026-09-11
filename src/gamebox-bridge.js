/** Bundled into the pinned upstream host; only GameBox's reviewed adapter calls this API. */
export function installGameBoxBridge(worker, closeAudio) {
  let ready = false;
  let launched = false;
  let stopped = false;
  let exited = false;
  let error;
  let fault;
  let closing;
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
  worker.addEventListener('message', ({ data }) => {
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
      });
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
      launched = true;
      await window.loadApp(url.href);
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
    async stop() {
      if (stopped) return;
      if (closing) return closing;
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
