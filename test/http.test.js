'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WF, base, makeApp } = require('./helpers');

async function withServer(fn) {
  const app = makeApp();
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try { await fn(url, app); } finally { await new Promise((r) => app.server.close(r)); }
}
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('HTTP: create -> 201, replay -> 200 with Idempotent-Replayed header, explain works', async () => {
  await withServer(async (url) => {
    const a = await post(`${url}/requests`, { workflowId: WF, payload: base }, { 'Idempotency-Key': 'http-1' });
    const created = await a.json();
    assert.equal(a.status, 201);
    assert.equal(created.state, 'APPROVED');

    const b = await post(`${url}/requests`, { workflowId: WF, payload: base }, { 'Idempotency-Key': 'http-1' });
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal((await b.json()).requestId, created.requestId);

    const ex = await (await fetch(`${url}${created.links.explain}`)).json();
    assert.equal(ex.state, 'APPROVED');
    assert.ok(ex.decisionPath.length > 0);
  });
});

test('HTTP: error mapping (422 invalid, 404 unknown, 400 bad JSON, 409 key reuse)', async () => {
  await withServer(async (url) => {
    const bad = await post(`${url}/requests`, { workflowId: WF, payload: { ...base, email: 'x' } });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.details.errors[0].field, 'email');

    assert.equal((await fetch(`${url}/requests/does-not-exist`)).status, 404);

    const raw = await fetch(`${url}/requests`, { method: 'POST', body: '{nope' });
    assert.equal(raw.status, 400);

    await post(`${url}/requests`, { workflowId: WF, payload: base }, { 'Idempotency-Key': 'k' });
    const clash = await post(`${url}/requests`, { workflowId: WF, payload: { ...base, fullName: 'Other Person' } }, { 'Idempotency-Key': 'k' });
    assert.equal(clash.status, 409);
  });
});

test('HTTP: dependency failure -> RETRY_PENDING -> retry endpoint -> APPROVED; review endpoint', async () => {
  await withServer(async (url) => {
    await post(`${url}/admin/faults`, { service: 'documentVerification', failTimes: 3 });
    const r = await (await post(`${url}/requests`, { workflowId: WF, payload: base })).json();
    assert.equal(r.state, 'RETRY_PENDING');
    const retried = await (await post(`${url}/requests/${r.requestId}/retry`, {})).json();
    assert.equal(retried.state, 'APPROVED');
    assert.equal((await post(`${url}/requests/${r.requestId}/retry`, {})).status, 409);

    const m = await (await post(`${url}/requests`, { workflowId: WF, payload: { ...base, role: 'senior-engineer', yearsExperience: 3, idDocument: 'M-1' } })).json();
    assert.equal(m.state, 'MANUAL_REVIEW');
    const done = await (await post(`${url}/requests/${m.requestId}/review`, { decision: 'REJECT', reviewer: 'sam' })).json();
    assert.equal(done.state, 'REJECTED');
  });
});

test('HTTP: new config version registered at runtime via admin endpoint', async () => {
  await withServer(async (url) => {
    const v1 = await (await fetch(`${url}/workflows/${WF}`)).json();
    const v2 = { ...v1, version: 2 };
    assert.equal((await post(`${url}/admin/workflows`, v2)).status, 201);
    assert.equal((await post(`${url}/admin/workflows`, v2)).status, 409);
    const r = await (await post(`${url}/requests`, { workflowId: WF, payload: base })).json();
    assert.equal(r.configVersion, 2);
  });
});
