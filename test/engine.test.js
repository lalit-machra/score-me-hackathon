'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WF, base, makeApp, submit } = require('./helpers');

// ---------- 1. Happy path ----------
test('happy path: valid request is APPROVED with full state history and audit', async () => {
  const app = makeApp();
  const { instance, duplicate } = await submit(app, base);
  assert.equal(duplicate, false);
  assert.equal(instance.state, 'APPROVED');
  assert.deepEqual(instance.history.map((h) => h.to), ['RECEIVED', 'VALIDATED', 'IN_PROGRESS', 'APPROVED']);
  assert.ok(instance.audit.some((a) => a.type === 'RULE' && a.ruleId === 'restricted-region' && a.outcome === 'PASS'));
  assert.ok(instance.audit.some((a) => a.type === 'DEPENDENCY_CALL' && a.outcome === 'SUCCESS'));
  // background check is conditional: engineer role skips it
  assert.ok(instance.audit.some((a) => a.type === 'STAGE_SKIPPED' && a.stage === 'background-check'));
});

test('conditional branching: senior engineer triggers the background check stage', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, role: 'senior-engineer', yearsExperience: 6 });
  assert.equal(instance.state, 'APPROVED');
  assert.ok(instance.audit.some((a) => a.type === 'DEPENDENCY_CALL' && a.service === 'backgroundCheck'));
});

// ---------- rule outcomes ----------
test('threshold rules: below hard floor REJECTS, between floor and target goes to MANUAL_REVIEW', async () => {
  const app = makeApp();
  const low = (await submit(app, { ...base, role: 'senior-engineer', yearsExperience: 1, idDocument: 'D1X' })).instance;
  const mid = (await submit(app, { ...base, role: 'senior-engineer', yearsExperience: 3, idDocument: 'D2X' })).instance;
  assert.equal(low.state, 'REJECTED'); // REJECT takes precedence over MANUAL_REVIEW
  assert.equal(mid.state, 'MANUAL_REVIEW');
});

test('multi-step evaluation: document mismatch rejects, background flag escalates', async () => {
  const app = makeApp();
  assert.equal((await submit(app, { ...base, idDocument: 'BAD-001' })).instance.state, 'REJECTED');
  const flagged = (await submit(app, { ...base, role: 'finance-analyst', idDocument: 'FLAG-001' })).instance;
  assert.equal(flagged.state, 'MANUAL_REVIEW');
});

test('foreign hire without work permit is rejected with the rule referenced in the audit', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, country: 'US' });
  assert.equal(instance.state, 'REJECTED');
  const failed = instance.audit.find((a) => a.type === 'RULE' && a.outcome === 'FAIL');
  assert.equal(failed.ruleId, 'work-permit-required');
  assert.equal(failed.trace[0].field, 'hasWorkPermit'); // data reference
});

// ---------- 2. Invalid input ----------
test('invalid input: schema errors are returned, nothing is persisted, intake is logged', async () => {
  const app = makeApp();
  await assert.rejects(
    submit(app, { ...base, email: 'nope', yearsExperience: -5, role: 'wizard', extra: 1 }),
    (e) => {
      assert.equal(e.status, 422);
      const fields = e.details.errors.map((x) => x.field).sort();
      assert.deepEqual(fields, ['email', 'extra', 'role', 'yearsExperience']);
      return true;
    },
  );
  assert.equal(app.store.list().length, 0);
  assert.equal(app.store.events.filter((e) => e.type === 'INTAKE_REJECTED').length, 1);
});

test('invalid input: missing fields and wrong types', async () => {
  const app = makeApp();
  await assert.rejects(submit(app, {}), (e) => e.status === 422 && e.details.errors.length >= 6);
  await assert.rejects(submit(app, [1, 2]), (e) => e.status === 422);
  await assert.rejects(submit(app, { ...base, yearsExperience: '3' }), (e) => e.status === 422);
});

test('unknown workflow returns 404', async () => {
  const app = makeApp();
  await assert.rejects(app.engine.submit({ workflowId: 'nope', payload: base }), (e) => e.status === 404);
});

// ---------- 3. Duplicates / idempotency ----------
test('duplicate request returns the original decision and creates no second instance', async () => {
  const app = makeApp();
  const first = await submit(app, base);
  const second = await submit(app, base);
  assert.equal(second.duplicate, true);
  assert.equal(second.instance.id, first.instance.id);
  assert.equal(app.store.list().length, 1);
  assert.equal(app.store.events.filter((e) => e.type === 'DUPLICATE_REQUEST').length, 1);
  assert.equal(app.engine.explain(first.instance.id).systemEvents.length, 1); // duplicates show up in the audit view
});

test('duplicate detection ignores key order in the payload', async () => {
  const app = makeApp();
  const a = await submit(app, base);
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  const b = await submit(app, reordered);
  assert.equal(b.instance.id, a.instance.id);
});

test('explicit idempotency key: same key + same payload replays, same key + different payload conflicts', async () => {
  const app = makeApp();
  const a = await submit(app, base, 'key-1');
  const b = await submit(app, base, 'key-1');
  assert.equal(b.duplicate, true);
  assert.equal(b.instance.id, a.instance.id);
  await assert.rejects(submit(app, { ...base, fullName: 'Someone Else' }, 'key-1'), (e) => e.status === 409);
});

test('concurrent identical submissions produce exactly one instance', async () => {
  const app = makeApp();
  const [a, b] = await Promise.all([submit(app, base), submit(app, base)]);
  assert.equal(a.instance.id, b.instance.id);
  assert.equal([a, b].filter((r) => !r.duplicate).length, 1);
  assert.equal(app.store.list().length, 1);
});

// ---------- 4. Dependency failure ----------
test('dependency down: retries with attempts logged, then parks in RETRY_PENDING', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, idDocument: 'DOWN-1' });
  assert.equal(instance.state, 'RETRY_PENDING');
  const calls = instance.audit.filter((a) => a.type === 'DEPENDENCY_CALL');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.outcome === 'ERROR'));
  assert.equal(instance.cursor, 1); // checkpointed at the failing stage; eligibility is not re-run
});

test('transient dependency failure is absorbed by in-stage retries', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, idDocument: 'FLAKY-1' }); // fails twice, third call works
  assert.equal(instance.state, 'APPROVED');
  const calls = instance.audit.filter((a) => a.type === 'DEPENDENCY_CALL');
  assert.deepEqual(calls.map((c) => c.outcome), ['ERROR', 'ERROR', 'SUCCESS']);
});

test('dependency timeout is treated as a failure', async () => {
  const app = makeApp();
  app.services.inject('documentVerification', { latencyMs: 700 }); // stage timeout is 500ms
  const { instance } = await submit(app, base);
  assert.equal(instance.state, 'RETRY_PENDING');
  assert.match(instance.audit.find((a) => a.outcome === 'ERROR').error, /timeout/);
});

// ---------- 5. Retry flow ----------
test('retry flow: RETRY_PENDING resumes at the failed stage and completes once the dependency recovers', async () => {
  const app = makeApp();
  app.services.inject('documentVerification', { failTimes: 3 });
  const { instance } = await submit(app, base);
  assert.equal(instance.state, 'RETRY_PENDING');
  const done = await app.engine.retry(instance.id);
  assert.equal(done.state, 'APPROVED');
  assert.equal(done.resumes, 1);
  assert.equal(done.audit.filter((a) => a.ruleId === 'restricted-region').length, 1); // earlier stage not repeated
  assert.deepEqual(done.history.slice(-3).map((h) => h.to), ['RETRY_PENDING', 'IN_PROGRESS', 'APPROVED']);
});

test('retry budget: repeated failures escalate to MANUAL_REVIEW instead of looping forever', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, idDocument: 'DOWN-2' });
  assert.equal((await app.engine.retry(instance.id)).state, 'RETRY_PENDING');
  const last = await app.engine.retry(instance.id);
  assert.equal(last.state, 'MANUAL_REVIEW');
  assert.match(last.history.at(-1).reason, /retry budget/);
});

test('retry is only allowed from RETRY_PENDING', async () => {
  const app = makeApp();
  const { instance } = await submit(app, base);
  await assert.rejects(app.engine.retry(instance.id), (e) => e.status === 409);
});

test('concurrent retries: only one wins', async () => {
  const app = makeApp();
  app.services.inject('documentVerification', { failTimes: 3 });
  const { instance } = await submit(app, base);
  const results = await Promise.allSettled([app.engine.retry(instance.id), app.engine.retry(instance.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
});

// ---------- manual review ----------
test('manual review: reviewer decision is recorded in history and audit', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, role: 'senior-engineer', yearsExperience: 3 });
  assert.equal(instance.state, 'MANUAL_REVIEW');
  assert.throws(() => app.engine.resolveReview(instance.id, { decision: 'APPROVE' }), (e) => e.status === 422); // reviewer required
  const done = app.engine.resolveReview(instance.id, { decision: 'APPROVE', reviewer: 'priya', note: 'strong portfolio' });
  assert.equal(done.state, 'APPROVED');
  assert.equal(done.history.at(-1).actor, 'priya');
  assert.ok(done.audit.some((a) => a.type === 'MANUAL_DECISION' && a.reviewer === 'priya'));
  assert.throws(() => app.engine.resolveReview(instance.id, { decision: 'REJECT', reviewer: 'x' }), (e) => e.status === 409); // terminal
});

// ---------- 6. Rule change scenarios ----------
test('rule change: new version applies to new requests, in-flight requests stay pinned to theirs', async () => {
  const app = makeApp();
  const pending = (await submit(app, { ...base, idDocument: 'DOWN-3' })).instance; // in flight on v1
  const senior = { ...base, role: 'senior-engineer', yearsExperience: 6, idDocument: 'S-1' };
  assert.equal((await submit(app, senior)).instance.state, 'APPROVED'); // v1: 5y target passes

  const v2 = structuredClone(app.registry.get(WF, 1));
  v2.version = 2;
  v2.stages[0].rules.find((r) => r.id === 'senior-experience-target').check.value = 8; // config-only change
  app.registry.register(v2);

  const after = (await submit(app, { ...senior, idDocument: 'S-2' })).instance;
  assert.equal(after.configVersion, 2);
  assert.equal(after.state, 'MANUAL_REVIEW'); // v2: 8y target fails

  app.services.clearFaults();
  const resumed = await app.engine.retry(pending.id);
  assert.equal(resumed.configVersion, 1); // still evaluated under the rules it started with
});

test('rule change: replaying an old request after a schema change returns the original decision', async () => {
  const app = makeApp();
  const first = await submit(app, base, 'replay-1');
  const v2 = structuredClone(app.registry.get(WF, 1));
  v2.version = 2;
  v2.schema.fields.managerEmail = { type: 'string', required: true };
  app.registry.register(v2);
  const replay = await submit(app, base, 'replay-1');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.instance.id, first.instance.id);
  await assert.rejects(submit(app, base), (e) => e.status === 422); // genuinely new request now fails v2 schema
});

test('rule change: a brand-new workflow can be added purely via config', async () => {
  const app = makeApp();
  app.registry.register({
    id: 'vendor-approval', version: 1,
    schema: { fields: { vendor: { type: 'string', required: true }, annualSpend: { type: 'number', required: true } } },
    stages: [{ id: 'spend', type: 'rules', rules: [
      { id: 'spend-cap', check: { field: 'annualSpend', op: 'lte', value: 100000 }, onFail: 'MANUAL_REVIEW', message: 'Spend above cap' },
    ] }],
  });
  const ok = await app.engine.submit({ workflowId: 'vendor-approval', payload: { vendor: 'Acme', annualSpend: 5000 } });
  const big = await app.engine.submit({ workflowId: 'vendor-approval', payload: { vendor: 'Big', annualSpend: 500000 } });
  assert.equal(ok.instance.state, 'APPROVED');
  assert.equal(big.instance.state, 'MANUAL_REVIEW');
});

test('invalid configs are rejected at registration', async () => {
  const app = makeApp();
  const bad = structuredClone(app.registry.get(WF, 1));
  bad.version = 9;
  bad.stages[0].rules[0].check.op = 'approximately';
  assert.throws(() => app.registry.register(bad), (e) => e.code === 'INVALID_CONFIG' && /unknown operator/.test(e.details.problems.join()));
  assert.throws(() => app.registry.register(app.registry.get(WF, 1)), (e) => e.status === 409); // versions are immutable
});

// ---------- storage failures ----------
test('partial save failure: transient storage errors are retried transparently', async () => {
  const app = makeApp();
  app.store.failNextSaves = 2;
  const { instance } = await submit(app, base);
  assert.equal(instance.state, 'APPROVED');
});

test('storage outage: request fails with 503, nothing half-created, same key can be retried safely', async () => {
  const app = makeApp();
  app.store.failNextSaves = 3;
  await assert.rejects(submit(app, base, 'outage-1'), (e) => e.status === 503);
  assert.equal(app.store.list().length, 0);
  const ok = await submit(app, base, 'outage-1');
  assert.equal(ok.duplicate, false);
  assert.equal(ok.instance.state, 'APPROVED');
});

test('JSON file store survives a restart and still dedupes', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'data.json');
  const a = makeApp({ dataFile: file });
  const first = await submit(a, base);
  const b = makeApp({ dataFile: file }); // "restart"
  const again = await submit(b, base);
  assert.equal(again.duplicate, true);
  assert.equal(again.instance.id, first.instance.id);
  assert.equal(b.engine.explain(first.instance.id).stateHistory.length, 4);
});

// ---------- explainability ----------
test('explain: returns input, triggered rules, readable decision path and state history', async () => {
  const app = makeApp();
  const { instance } = await submit(app, { ...base, role: 'senior-engineer', yearsExperience: 3 });
  const ex = app.engine.explain(instance.id);
  assert.equal(ex.state, 'MANUAL_REVIEW');
  assert.equal(ex.input.yearsExperience, 3);
  assert.deepEqual(ex.rulesTriggered.map((r) => r.ruleId), ['senior-experience-target']);
  assert.ok(ex.decisionPath.some((l) => l.includes('yearsExperience=3 gte 5 -> false')));
  assert.equal(ex.configVersion, 1);
});
