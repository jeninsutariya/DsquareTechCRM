const crypto = require('node:crypto');

// In-memory background jobs so long batches don't block an HTTP request.
const jobs = new Map();
const MAX_JOBS = 20;

/**
 * Run `worker(item, job, workerIndex)` over `items` with limited concurrency. Each item's
 * outcome is recorded; one failure does not stop the batch. A worker error with
 * `stopJob` set stops the batch: that item and the rest go to `job.notProcessed`.
 */
function startJob(type, items, worker, { concurrency = 3, onDone } = {}) {
  const job = {
    id: crypto.randomUUID(),
    type,
    status: 'running',
    total: items.length,
    done: 0,
    results: [],
    errors: [],
    notProcessed: [],
    stopped: null,
    current: null,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);

  let next = 0;
  const run = async (workerIndex) => {
    while (next < items.length && !job.stopped) {
      const item = items[next++];
      try {
        job.results.push(await worker(item, job, workerIndex));
      } catch (err) {
        if (err.stopJob) {
          job.stopped = err.message;
          job.notProcessed.push(item);
          continue;
        }
        job.errors.push({ item, error: err.message });
      }
      job.done++;
    }
  };
  Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, i) => run(i))).then(() => {
    if (job.stopped) job.notProcessed.push(...items.slice(next));
    job.current = null;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    onDone?.(job);
  });
  return job;
}

const getJob = (id) => jobs.get(id);

module.exports = { startJob, getJob };
