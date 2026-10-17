// Per-host request pacing.
//
// Two guarantees, both scoped to a single host (different domains never wait on
// each other, so wide fan-out across many sites stays fast):
//   1. At most `perHost` requests in flight against the same host.
//   2. Consecutive requests to the same host are spaced by at least `minGapMs`
//      plus a random jitter, so a burst never looks like a scraper.
//
// The limiter is deliberately transport-agnostic: `run(host, fn)` simply
// resolves with whatever `fn` returns (or rejects with its error).

export function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return "";
  }
}

export function createHostLimiter({ perHost = 2, minGapMs = 1500, jitterMs = 1500 } = {}) {
  const limit = Math.max(1, Math.floor(perHost) || 1);
  const gap = Math.max(0, Number(minGapMs) || 0);
  const jitter = Math.max(0, Number(jitterMs) || 0);
  const hosts = new Map();

  function stateFor(host) {
    let s = hosts.get(host);
    if (!s) {
      s = { active: 0, queued: 0, started: 0, nextSlotAt: 0, queue: [] };
      hosts.set(host, s);
    }
    return s;
  }

  function pump(s) {
    while (s.queue.length && s.active < limit) {
      const job = s.queue.shift();
      s.queued--;
      s.active++;
      const now = Date.now();
      // Reserve this slot now so the *next* slot computed below is already
      // spaced from it, even while the timer is still pending.
      const at = Math.max(now, s.nextSlotAt);
      s.nextSlotAt = at + gap + (jitter ? Math.random() * jitter : 0);
      const wait = at - now;
      s.started++;

      const start = () => {
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => {
            s.active--;
            pump(s);
          });
      };
      if (wait > 4) setTimeout(start, wait);
      else start();
    }
  }

  return {
    // Schedules `fn` behind the per-host concurrency/gap rules.
    run(host, fn) {
      const s = stateFor(host || "");
      return new Promise((resolve, reject) => {
        s.queue.push({ fn, resolve, reject });
        s.queued++;
        pump(s);
      });
    },
    stats(host) {
      const s = hosts.get(host || "");
      return s
        ? { active: s.active, queued: s.queued, started: s.started }
        : { active: 0, queued: 0, started: 0 };
    },
    reset() {
      hosts.clear();
    },
    get hostCount() {
      return hosts.size;
    },
  };
}
