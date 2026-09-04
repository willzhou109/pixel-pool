/* Background generation of AI match recaps.
 *
 * Why a queue at all: recordEnd() in realtime.js runs on the hot path of a
 * live match — both players are sitting on the end screen waiting. An LLM call
 * takes seconds and can fail or rate-limit, so it must not run there. The
 * match is saved first; the recap catches up afterwards.
 *
 * Two backends, chosen by whether REDIS_URL is configured:
 *
 *   - BullMQ + Redis (production): survives a restart mid-job, retries with
 *     exponential backoff, and can be drained by a separate worker process
 *     (`npm run worker`) so API latency is untouched by generation load.
 *   - In-process (local dev): same work, same retry policy, just setTimeout
 *     and no Redis to install. Jobs are lost on restart, which is fine for a
 *     dev box and is why it isn't the production path.
 *
 * Either way the contract is identical: queueForMatch(id) returns immediately
 * and the recap lands in matches.commentary via history.setCommentary().
 */
'use strict';

const history = require('../history');
const { summarize } = require('./summarize');
const { generate } = require('./generate');

const REDIS_URL = process.env.REDIS_URL || null;
const QUEUE_NAME = 'match-commentary';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 5000;   // 5s, 10s, 20s — doubling, same idea as socket reconnects

// Generation is only possible with API credentials. Without them the feature
// stays cleanly off rather than filling the DB with 'failed' rows.
const ENABLED = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let queue = null;   // BullMQ Queue, when Redis is configured

/* ----------------------------- the actual work ---------------------------- */

// Idempotent by match id: a retried or duplicated job never regenerates a
// recap that already landed, so we can't double-spend on the API.
async function runJob(matchId) {
  const match = history.forCommentary(matchId);
  if (!match) return;                                  // match deleted
  if (match.commentaryStatus === 'ready') return;      // already generated
  if (!match.stats) {                                  // nothing to write about
    history.setCommentary(matchId, null, 'skipped');
    return;
  }
  const text = await generate(summarize(match));
  history.setCommentary(matchId, text, 'ready');
  console.log(`[commentary] match ${matchId}: generated (${text.length} chars)`);
}

/* --------------------------- in-process fallback -------------------------- */

async function runInline(matchId, attempt = 1) {
  try {
    await runJob(matchId);
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(`[commentary] match ${matchId} attempt ${attempt} failed (${e.message}); retrying in ${delay}ms`);
      setTimeout(() => runInline(matchId, attempt + 1), delay).unref();
      return;
    }
    console.error(`[commentary] match ${matchId} failed after ${MAX_ATTEMPTS} attempts:`, e.message);
    try { history.setCommentary(matchId, null, 'failed'); } catch { /* row may be gone */ }
  }
}

/* -------------------------------- BullMQ ---------------------------------- */

function connection() {
  // BullMQ needs Redis to not give up on a blocking read.
  return { url: REDIS_URL, maxRetriesPerRequest: null };
}

function getQueue() {
  if (queue) return queue;
  const { Queue } = require('bullmq');
  queue = new Queue(QUEUE_NAME, { connection: connection() });
  queue.on('error', e => console.error('[commentary] queue error:', e.message));
  return queue;
}

/** Start a worker in THIS process. Called by server.js unless a standalone
 * worker is running (WORKER_MODE=external), and by worker.js. */
function startWorker() {
  if (!REDIS_URL || !ENABLED) return null;
  const { Worker } = require('bullmq');
  const worker = new Worker(QUEUE_NAME, job => runJob(job.data.matchId), {
    connection: connection(),
    // One recap at a time: generation is not latency-critical and this keeps
    // a burst of finished matches from stacking up concurrent API calls.
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    const id = job && job.data && job.data.matchId;
    console.error(`[commentary] job for match ${id} failed:`, err.message);
    // Only mark the row failed once BullMQ has exhausted its retries.
    if (job && job.attemptsMade >= MAX_ATTEMPTS && id) {
      try { history.setCommentary(id, null, 'failed'); } catch { /* row may be gone */ }
    }
  });
  console.log(`[commentary] worker listening on "${QUEUE_NAME}"`);
  return worker;
}

/* --------------------------------- public --------------------------------- */

/** Queue a recap for a just-recorded match. Never throws, never blocks. */
function queueForMatch(matchId) {
  if (!matchId) return;
  if (!ENABLED) return;   // no API credentials — feature off, status stays null
  try {
    // Never re-queue a match that already has its recap: marking it 'pending'
    // would blank the stored text and pay for the same generation twice.
    const existing = history.forCommentary(matchId);
    if (!existing || existing.commentaryStatus === 'ready') return;
    history.setCommentary(matchId, null, 'pending');
  } catch (e) {
    return console.error('[commentary] could not mark pending:', e.message);
  }
  if (!REDIS_URL) return void runInline(matchId);

  getQueue().add('generate', { matchId }, {
    jobId: `match-${matchId}`,          // dedupe: one job per match, ever
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: BACKOFF_MS },
    removeOnComplete: 100,
    removeOnFail: 500,
  }).catch(e => {
    console.error('[commentary] enqueue failed, running inline:', e.message);
    runInline(matchId);
  });
}

module.exports = {
  queueForMatch,
  startWorker,
  enabled: () => ENABLED,
  usesRedis: () => !!REDIS_URL,
};
