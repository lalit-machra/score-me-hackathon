'use strict';
// Thin REST layer: parse -> call engine -> map errors to HTTP. No business logic.
const http = require('node:http');
const { AppError } = require('./errors');

const summary = (inst, duplicate) => ({
  requestId: inst.id, workflowId: inst.workflowId, configVersion: inst.configVersion,
  state: inst.state, reason: inst.history[inst.history.length - 1].reason, duplicate,
  links: { self: `/requests/${inst.id}`, explain: `/requests/${inst.id}/explain` },
});

function createServer({ engine, registry, services, store }) {
  const routes = [];
  const route = (method, pattern, handler) =>
    routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/health', async () => [200, { status: 'ok' }]);
  route('GET', '/workflows', async () => [200, registry.list()]);
  route('GET', '/workflows/:id', async ({ params }) => [200, registry.get(params.id)]);
  route('POST', '/admin/workflows', async ({ body }) => [201, registry.register(body)]);
  route('POST', '/admin/faults', async ({ body }) => {
    services.inject(body.service, body);
    return [200, { injected: body.service }];
  });

  route('POST', '/requests', async ({ body, headers }) => {
    const { workflowId, payload } = body || {};
    if (!workflowId) throw new AppError(400, 'BAD_REQUEST', 'workflowId is required');
    const { instance, duplicate } = await engine.submit({ workflowId, payload, idempotencyKey: headers['idempotency-key'] });
    return [duplicate ? 200 : 201, summary(instance, duplicate), duplicate ? { 'Idempotent-Replayed': 'true' } : {}];
  });
  route('GET', '/requests', async () => [200, store.list()]);
  route('GET', '/requests/:id', async ({ params }) => [200, engine.get(params.id)]);
  route('GET', '/requests/:id/explain', async ({ params }) => [200, engine.explain(params.id)]);
  route('POST', '/requests/:id/retry', async ({ params }) => [200, summary(await engine.retry(params.id), false)]);
  route('POST', '/requests/:id/review', async ({ params, body }) => [200, summary(engine.resolveReview(params.id, body || {}), false)]);

  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const path = new URL(req.url, 'http://x').pathname;
      const match = routes.map((r) => ({ r, m: req.method === r.method && r.re.exec(path) })).find((x) => x.m);
      if (!match) return send(404, { error: { code: 'NOT_FOUND', message: `${req.method} ${path}` } });

      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body;
      if (raw) {
        try { body = JSON.parse(raw); } catch { throw new AppError(400, 'BAD_JSON', 'Request body is not valid JSON'); }
      }
      const [status, out, headers] = await match.r.handler({ params: match.m.groups || {}, body, headers: req.headers });
      return send(status, out, headers);
    } catch (e) {
      if (e instanceof AppError) return send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      console.error(e);
      return send(500, { error: { code: 'INTERNAL', message: 'Unexpected error' } });
    }
  });
}

module.exports = { createServer };
