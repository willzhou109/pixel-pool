/* Standalone commentary worker: `npm run worker`.
 *
 * Optional. The web process already runs an in-process worker, which is fine
 * at this scale. Run this instead (with WORKER_MODE=external on the web
 * process, so it only enqueues) when you want generation load fully off the
 * box serving the game — the usual reason to split a queue out at all.
 *
 * Requires REDIS_URL; without it there is no shared queue to drain and the
 * web process handles everything in-process anyway.
 */
'use strict';

require('./env'); // same .env as the web process

const commentary = require('./commentary');

if (!process.env.REDIS_URL) {
  console.error('[worker] REDIS_URL is not set — nothing to drain. ' +
    'The web process generates recaps in-process when Redis is absent.');
  process.exit(1);
}
if (!commentary.enabled()) {
  console.error('[worker] No Anthropic credentials — set ANTHROPIC_API_KEY.');
  process.exit(1);
}

const worker = commentary.startWorker();
console.log('[worker] ready');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[worker] ${sig} — finishing current job…`);
    if (worker) await worker.close();
    process.exit(0);
  });
}
