# Configurable Workflow Decision Platform

A generic workflow engine: it accepts structured requests, validates them, runs configurable
stages (rules + external dependency calls), tracks state with full history, records an
explainable audit trail, and handles duplicates, failures and retries.

The business use case (**employee onboarding**) is pure configuration in
`config/employee-onboarding.v1.json`. The engine has no onboarding-specific code.

- Zero runtime dependencies. Node 18+.
- Docs: [Architecture](docs/ARCHITECTURE.md) | [Decision examples](docs/DECISION_EXAMPLES.md)

## Quick start

```bash
npm test          # 32 tests
npm start         # REST API on http://localhost:3000  (PORT=... to change)
DATA_FILE=./data.json npm start   # persist state to a JSON file across restarts
npm run examples  # regenerate docs/DECISION_EXAMPLES.md from real engine output
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/requests` | Submit `{ "workflowId", "payload" }`. Optional `Idempotency-Key` header. 201 new, 200 replay |
| GET | `/requests/:id` | Full record: state, history, audit trail |
| GET | `/requests/:id/explain` | Human-readable decision explanation |
| POST | `/requests/:id/retry` | Resume a `RETRY_PENDING` request at the failed stage |
| POST | `/requests/:id/review` | Resolve `MANUAL_REVIEW`: `{ "decision": "APPROVE"/"REJECT", "reviewer", "note" }` |
| GET | `/requests` | List requests |
| GET | `/workflows`, `/workflows/:id` | List / read workflow configs |
| POST | `/admin/workflows` | Register a new config version at runtime |
| POST | `/admin/faults` | Demo: make a simulated service fail `{ "service", "failTimes", "latencyMs" }` |

Errors use `{ "error": { "code", "message", "details" } }`: 400 bad JSON/config, 404 unknown,
409 conflict (key reuse, illegal state), 422 invalid input, 503 storage unavailable.

## Try it

```bash
# Happy path
curl -s localhost:3000/requests -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' -d '{
  "workflowId": "employee-onboarding",
  "payload": { "fullName": "Asha Rao", "email": "asha@example.com", "role": "engineer",
               "country": "IN", "startDate": "2026-12-01", "yearsExperience": 3, "idDocument": "DOC123" }
}'

# Same call again -> 200 + Idempotent-Replayed: true, same requestId, nothing re-executed

# Explain a decision (use requestId from above)
curl -s localhost:3000/requests/<requestId>/explain

# Dependency failure -> RETRY_PENDING, then retry
curl -s -XPOST localhost:3000/admin/faults -H 'content-type: application/json' \
  -d '{"service":"documentVerification","failTimes":3}'

curl -s localhost:3000/requests -H 'content-type: application/json' -d '{
  "workflowId": "employee-onboarding",
  "payload": { "fullName": "Ravi Kumar", "email": "ravi@example.com", "role": "engineer",
               "country": "IN", "startDate": "2026-12-01", "yearsExperience": 4, "idDocument": "DOC999" }
}'
# -> state RETRY_PENDING (3 failed attempts logged)

curl -s -XPOST localhost:3000/requests/<requestId>/retry
# -> state APPROVED (resumes at document-verification; eligibility is not re-run)

# Manual review: senior with 3 years -> MANUAL_REVIEW, then resolve it
curl -s -XPOST localhost:3000/requests/<requestId>/review -H 'content-type: application/json' \
  -d '{"decision":"APPROVE","reviewer":"priya","note":"strong portfolio"}'
```

### Magic values in the simulated services

| `idDocument` | Behaviour |
|---|---|
| starts with `BAD` | document verification returns MISMATCH -> REJECTED |
| starts with `DOWN` | verification always fails -> RETRY_PENDING |
| starts with `FLAKY` | fails twice, then succeeds (absorbed by in-stage retries) |
| contains `FLAG` | background check FLAGGED -> MANUAL_REVIEW |

## Changing rules without changing code

Edit or add a JSON file in `config/` (or `POST /admin/workflows`). Config is validated on load
(unknown operators, duplicate stage ids, bad actions fail fast). Versions are immutable: to
change a rule, publish `version: 2`. New requests use the latest; in-flight requests finish on
the version they started with.

Rule: `{ id, when?, check, onFail: "REJECT" | "MANUAL_REVIEW", message }`
Condition: `{ field, op, value }`, or `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }`
Operators: `eq neq gt gte lt lte in nin exists matches`
Dependency stage: `{ service, request, timeoutMs, retry: { maxAttempts, backoffMs }, outcomes: [{ when, action }], defaultAction, onExhausted }`

## Layout

```
config/    workflow definitions (the business logic)
src/       conditions, validator, registry, engine, store, services, server, app
test/      32 tests (engine + HTTP)
docs/      architecture + generated decision examples
scripts/   example generator
```
