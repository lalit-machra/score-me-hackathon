'use strict';
// Persistence boundary. In-memory Map with optional atomic JSON-file
// snapshotting. Swap this class for Postgres/Redis without touching the engine.
const fs = require('node:fs');

class Store {
  constructor({ file } = {}) {
    this.file = file;
    this.items = new Map(); // id -> instance
    this.keys = new Map(); // idempotency key -> id
    this.events = []; // append-only system log (duplicates, rejected intake...)
    this.failNextSaves = 0; // fault injection for tests
    if (file && fs.existsSync(file)) this._load();
  }

  save(inst) {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error('simulated storage failure');
    }
    this.items.set(inst.id, structuredClone(inst));
    this.keys.set(inst.idempotencyKey, inst.id);
    this._flush();
  }

  get(id) {
    const v = this.items.get(id);
    return v ? structuredClone(v) : null;
  }

  getByKey(key) {
    const id = this.keys.get(key);
    return id ? this.get(id) : null;
  }

  list() {
    return [...this.items.values()].map((i) => ({
      id: i.id, workflowId: i.workflowId, configVersion: i.configVersion, state: i.state, updatedAt: i.updatedAt,
    }));
  }

  logEvent(event) {
    this.events.push({ at: new Date().toISOString(), ...event });
    this._flush();
  }

  eventsFor(requestId) {
    return this.events.filter((e) => e.requestId === requestId);
  }

  _flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ instances: [...this.items.values()], events: this.events }));
    fs.renameSync(tmp, this.file); // atomic replace: no half-written snapshots
  }

  _load() {
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const i of data.instances || []) {
      this.items.set(i.id, i);
      this.keys.set(i.idempotencyKey, i.id);
    }
    this.events = data.events || [];
  }
}

module.exports = { Store };
