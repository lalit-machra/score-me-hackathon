'use strict';
const { buildApp } = require('../src/app');

const WF = 'employee-onboarding';
const base = {
  fullName: 'Asha Rao', email: 'asha@example.com', role: 'engineer', country: 'IN',
  startDate: '2026-12-01', yearsExperience: 3, idDocument: 'DOC123',
};

// No real sleeping in tests: backoff is instant.
const makeApp = (opts = {}) => buildApp({ sleep: async () => {}, ...opts });
const submit = (app, payload, idempotencyKey) => app.engine.submit({ workflowId: WF, payload, idempotencyKey });

module.exports = { WF, base, makeApp, submit };
