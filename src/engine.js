'use strict';
// Workflow engine: orchestrates intake -> idempotency -> stages -> decision.
// Business logic lives in config; this file only knows HOW to run stages.
const crypto = require('node:crypto');
const { validate } = require('./validator');
const { check, get } = require('./conditions');
const { AppError } = require('./errors');

const TRANSITIONS = {
  RECEIVED: ['VALIDATED'],
  VALIDATED: ['IN_PROGRESS'],
  IN_PROGRESS: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW', 'RETRY_PENDING'],
  RETRY_PENDING: ['IN_PROGRESS', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
};
const TERMINAL = new Set(['APPROVED', 'REJECTED']);
const ACTION_STATE = { REJECT: 'REJECTED', MANUAL_REVIEW: 'MANUAL_REVIEW', RETRY_PENDING: 'RETRY_PENDING', APPROVE: 'APPROVED' };
const PERSIST_ATTEMPTS = 3;

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
      : v;
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(sortKeys(v))).digest('hex');

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const resolveRefs = (obj, payload) =>
  Object.fromEntries(Object.entries(obj || {}).map(([k, v]) =>
    [k, typeof v === 'string' && v.startsWith('$.') ? get(payload, v.slice(2)) : v]));

class Engine {
  constructor({ registry, store, services, sleep, clock } = {}) {
    this.registry = registry;
    this.store = store;
    this.services = services;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = clock || (() => new Date().toISOString());
  }

  // ---------- public API ----------

  async submit({ workflowId, payload, idempotencyKey }) {
    const cfg = this.registry.get(workflowId); // 404 if unknown; latest version for NEW requests
    const payloadHash = sha({ workflowId, payload });
    const key = idempotencyKey || payloadHash;

    // 1. Idempotency check runs BEFORE validation: a replay must return the
    //    original decision even if the schema has since changed.
    const existing = this.store.getByKey(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different payload');
      }
      this.store.logEvent({ type: 'DUPLICATE_REQUEST', requestId: existing.id, idempotencyKey: key });
      return { instance: existing, duplicate: true };
    }

    // 2. Schema validation
    const errors = validate(cfg.schema, payload);
    if (errors.length) {
      this.store.logEvent({ type: 'INTAKE_REJECTED', workflowId, idempotencyKey: key, errors });
      throw new AppError(422, 'INVALID_INPUT', 'Payload failed schema validation', { errors });
    }

    // 3. Create + persist before any async work (also makes check-then-create
    //    race-free on a single Node event loop: no await between lookup and save).
    const now = this.clock();
    const inst = {
      id: crypto.randomUUID(), workflowId, configVersion: cfg.version,
      idempotencyKey: key, payloadHash, payload: structuredClone(payload),
      state: null, cursor: 0, resumes: 0, outcome: null,
      history: [], audit: [], createdAt: now, updatedAt: now,
    };
    this._transition(inst, 'RECEIVED', 'Request received');
    this._transition(inst, 'VALIDATED', `Schema validation passed (${cfg.id} v${cfg.version})`);
    this._persist(inst);
    this._transition(inst, 'IN_PROGRESS', 'Workflow execution started');
    this._persist(inst);

    await this._run(inst, cfg);
    return { instance: inst, duplicate: false };
  }

  async retry(id) {
    const inst = this._load(id);
    if (inst.state !== 'RETRY_PENDING') {
      throw new AppError(409, 'NOT_RETRYABLE', `Request is ${inst.state}; only RETRY_PENDING can be retried`);
    }
    const cfg = this.registry.get(inst.workflowId, inst.configVersion);
    inst.resumes += 1;
    this._transition(inst, 'IN_PROGRESS', `Retry #${inst.resumes}: resuming at stage '${cfg.stages[inst.cursor].id}'`);
    this._persist(inst); // state flips synchronously, so a concurrent retry sees IN_PROGRESS -> 409
    await this._run(inst, cfg);
    return inst;
  }

  resolveReview(id, { decision, reviewer, note }) {
    const inst = this._load(id);
    if (inst.state !== 'MANUAL_REVIEW') {
      throw new AppError(409, 'NOT_IN_REVIEW', `Request is ${inst.state}; only MANUAL_REVIEW can be resolved`);
    }
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new AppError(422, 'INVALID_DECISION', "decision must be 'APPROVE' or 'REJECT'");
    if (!reviewer) throw new AppError(422, 'REVIEWER_REQUIRED', 'reviewer is required');
    const to = ACTION_STATE[decision];
    this._audit(inst, { type: 'MANUAL_DECISION', reviewer, decision, note: note || null });
    this._transition(inst, to, `Manual review by ${reviewer}: ${decision}${note ? ` (${note})` : ''}`, reviewer);
    inst.outcome = to;
    this._persist(inst);
    return inst;
  }

  get(id) {
    return this._load(id);
  }

  explain(id) {
    const inst = this._load(id);
    const last = inst.history[inst.history.length - 1];
    const fmt = (t) => `${t.field}=${JSON.stringify(t.actual)} ${t.op} ${JSON.stringify(t.expected)} -> ${t.result}`;
    const decisionPath = inst.audit.map((a) => {
      if (a.type === 'RULE') {
        return `[${a.stage}] rule '${a.ruleId}': ${a.outcome}${a.trace?.length ? ` (${a.trace.map(fmt).join('; ')})` : ''}${a.outcome === 'FAIL' ? ` => ${a.onFail}: ${a.message || ''}` : ''}`;
      }
      if (a.type === 'DEPENDENCY_CALL') {
        return `[${a.stage}] ${a.service} attempt ${a.attempt}: ${a.outcome}${a.error ? ` (${a.error})` : ` -> ${JSON.stringify(a.response)}`}`;
      }
      if (a.type === 'OUTCOME_MATCH') return `[${a.stage}] response matched outcome (${a.trace.map(fmt).join('; ')}) => ${a.action}`;
      if (a.type === 'STAGE_SKIPPED') return `[${a.stage}] skipped (${a.trace.map(fmt).join('; ')})`;
      if (a.type === 'MANUAL_DECISION') return `[manual-review] ${a.reviewer} -> ${a.decision}${a.note ? ` (${a.note})` : ''}`;
      return `[${a.stage || '-'}] ${a.type}`;
    });
    return {
      requestId: inst.id, workflowId: inst.workflowId, configVersion: inst.configVersion,
      state: inst.state, reason: last.reason, input: inst.payload,
      rulesTriggered: inst.audit.filter((a) => a.type === 'RULE' && a.outcome === 'FAIL')
        .map((a) => ({ stage: a.stage, ruleId: a.ruleId, onFail: a.onFail, message: a.message, trace: a.trace })),
      decisionPath, stateHistory: inst.history,
      systemEvents: this.store.eventsFor(inst.id),
    };
  }

  // ---------- execution ----------

  async _run(inst, cfg) {
    while (inst.cursor < cfg.stages.length) {
      const stage = cfg.stages[inst.cursor];
      let res;
      if (stage.when) {
        const w = check(stage.when, inst.payload);
        if (!w.result) {
          this._audit(inst, { type: 'STAGE_SKIPPED', stage: stage.id, trace: w.trace });
          res = { action: 'CONTINUE' };
        }
      }
      if (!res) res = stage.type === 'rules' ? this._rulesStage(inst, stage) : await this._dependencyStage(inst, stage);

      if (res.action === 'CONTINUE') {
        inst.cursor += 1;
        this._persist(inst); // checkpoint: a crash resumes from the next stage
        continue;
      }
      return this._finish(inst, cfg, res.action, res.reason);
    }
    return this._finish(inst, cfg, 'APPROVE', 'All stages passed');
  }

  // Evaluates ALL rules in the stage (full trace), then applies precedence: REJECT > MANUAL_REVIEW.
  _rulesStage(inst, stage) {
    const failed = [];
    for (const rule of stage.rules) {
      if (rule.when) {
        const w = check(rule.when, inst.payload);
        if (!w.result) {
          this._audit(inst, { type: 'RULE', stage: stage.id, ruleId: rule.id, outcome: 'SKIPPED', trace: w.trace });
          continue;
        }
      }
      const c = check(rule.check, inst.payload);
      const onFail = rule.onFail || 'REJECT';
      this._audit(inst, {
        type: 'RULE', stage: stage.id, ruleId: rule.id, description: rule.description,
        outcome: c.result ? 'PASS' : 'FAIL', onFail: c.result ? undefined : onFail,
        message: c.result ? undefined : rule.message, trace: c.trace,
      });
      if (!c.result) failed.push({ ...rule, onFail });
    }
    const pick = (a) => failed.filter((r) => r.onFail === a);
    const reason = (rs) => rs.map((r) => r.message || r.id).join('; ');
    if (pick('REJECT').length) return { action: 'REJECT', reason: reason(pick('REJECT')) };
    if (pick('MANUAL_REVIEW').length) return { action: 'MANUAL_REVIEW', reason: reason(pick('MANUAL_REVIEW')) };
    return { action: 'CONTINUE' };
  }

  async _dependencyStage(inst, stage) {
    const request = resolveRefs(stage.request, inst.payload);
    const max = stage.retry?.maxAttempts ?? 1;
    const backoff = stage.retry?.backoffMs ?? 0;
    const timeoutMs = stage.timeoutMs ?? 2000;
    let lastError;

    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const response = await withTimeout(this.services.call(stage.service, request), timeoutMs);
        this._audit(inst, { type: 'DEPENDENCY_CALL', stage: stage.id, service: stage.service, attempt, outcome: 'SUCCESS', request, response });
        for (const o of stage.outcomes) {
          const m = check(o.when, response);
          if (m.result) {
            this._audit(inst, { type: 'OUTCOME_MATCH', stage: stage.id, action: o.action, trace: m.trace });
            return { action: o.action, reason: o.reason || `${stage.service} returned ${JSON.stringify(response)}` };
          }
        }
        return { action: stage.defaultAction || 'MANUAL_REVIEW', reason: `Unrecognised response from ${stage.service}` };
      } catch (e) {
        lastError = e;
        this._audit(inst, { type: 'DEPENDENCY_CALL', stage: stage.id, service: stage.service, attempt, outcome: 'ERROR', request, error: e.message });
        if (attempt < max) await this.sleep(backoff * 2 ** (attempt - 1)); // exponential backoff
      }
    }
    return {
      action: stage.onExhausted || 'RETRY_PENDING',
      reason: `${stage.service} unavailable after ${max} attempts: ${lastError.message}`,
    };
  }

  _finish(inst, cfg, action, reason) {
    let to = ACTION_STATE[action] || action;
    if (to === 'RETRY_PENDING' && inst.resumes >= (cfg.maxResumes ?? 2)) {
      to = 'MANUAL_REVIEW';
      reason += ` (retry budget of ${cfg.maxResumes ?? 2} exhausted, escalated)`;
    }
    this._transition(inst, to, reason);
    if (TERMINAL.has(to)) inst.outcome = to;
    this._persist(inst);
    return inst;
  }

  // ---------- helpers ----------

  _transition(inst, to, reason, actor = 'system') {
    const allowed = inst.state === null ? ['RECEIVED'] : TRANSITIONS[inst.state];
    if (!allowed.includes(to)) throw new AppError(409, 'ILLEGAL_TRANSITION', `${inst.state} -> ${to} is not allowed`);
    const at = this.clock();
    inst.history.push({ seq: inst.history.length + 1, at, from: inst.state, to, reason, actor });
    inst.state = to;
    inst.updatedAt = at;
  }

  _audit(inst, entry) {
    inst.audit.push({ seq: inst.audit.length + 1, at: this.clock(), ...entry });
  }

  // Retries transient storage failures; surfaces a 503 if it stays down.
  _persist(inst) {
    let last;
    for (let i = 0; i < PERSIST_ATTEMPTS; i++) {
      try { return this.store.save(inst); } catch (e) { last = e; }
    }
    throw new AppError(503, 'STORAGE_UNAVAILABLE', `Could not persist state: ${last.message}`);
  }

  _load(id) {
    const inst = this.store.get(id);
    if (!inst) throw new AppError(404, 'NOT_FOUND', `No request '${id}'`);
    return inst;
  }
}

module.exports = { Engine, TRANSITIONS };
