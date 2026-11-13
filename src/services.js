'use strict';
// Simulated external dependencies with deterministic behaviour + fault injection.
//   documentVerification: id starting 'BAD' -> MISMATCH, 'DOWN' -> always fails,
//                         'FLAKY' -> fails its first 2 calls, else VERIFIED
//   backgroundCheck:      id containing 'FLAG' -> FLAGGED, else CLEAR

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Services {
  constructor() {
    this.faults = new Map(); // service -> { failTimes, latencyMs }
    this.counters = new Map();
    this.handlers = {
      documentVerification: async ({ documentId }) => {
        if (documentId.startsWith('DOWN')) throw new Error('503 document service unavailable');
        if (documentId.startsWith('FLAKY') && this._count(`doc:${documentId}`) <= 2) {
          throw new Error('502 bad gateway (flaky)');
        }
        if (documentId.startsWith('BAD')) return { status: 'MISMATCH', reason: 'Name does not match document' };
        return { status: 'VERIFIED', confidence: 0.97 };
      },
      backgroundCheck: async ({ documentId }) =>
        documentId.includes('FLAG') ? { status: 'FLAGGED', reason: 'Adverse record found' } : { status: 'CLEAR' },
    };
  }

  _count(key) {
    const n = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  inject(service, { failTimes = 0, latencyMs = 0 } = {}) {
    this.faults.set(service, { failTimes, latencyMs });
  }

  clearFaults() {
    this.faults.clear();
    this.counters.clear();
  }

  async call(name, request) {
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Unknown service '${name}'`);
    const f = this.faults.get(name);
    if (f) {
      if (f.latencyMs) await sleep(f.latencyMs);
      if (f.failTimes > 0) {
        f.failTimes--;
        throw new Error(`${name}: 503 service unavailable (injected)`);
      }
    }
    return handler(request);
  }
}

module.exports = { Services };
