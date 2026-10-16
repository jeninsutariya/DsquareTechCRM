const crypto = require('node:crypto');

// In-memory background jobs so long batches don't block an HTTP request.
const jobs = new Map();
const MAX_JOBS = 20;

/**
 * Run `worker(item)` over `items` with limited concurrency. Each item's
 * outcome is recorded; one failure does not stop the batch.
 */
function startJob(type, items, worker, { concurrency = 3 } = {}) {
  const job = {
    id: crypto.randomUUID(),
    type,
    status: 'running',
    total: items.length,
    done: 0,
    results: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);

  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        job.results.push(await worker(item));
      } catch (err) {
        job.errors.push({ item, error: err.message });
      }
      job.done++;
    }
  };
  Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run)).then(() => {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

const getJob = (id) => jobs.get(id);

module.exports = { startJob, getJob };
