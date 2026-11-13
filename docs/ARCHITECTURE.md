# Architecture

## 1. Problem and boundaries

Build a platform that turns a structured request into an explainable decision, driven by
configuration, tolerant of dependency failures, duplicates and changing requirements.

**In scope:** intake + validation, rules, staged execution, state lifecycle, audit, idempotency,
retries, configurable workflows, a simulated external dependency, REST API.
**Out of scope:** authentication/authorization, multi-tenancy, a UI, real queue infrastructure,
a real database. Each is called out under *Scaling* with a concrete path.

## 2. Components

```
            HTTP client
                |
        +-------v--------+
        |  server.js     |  parse, route, map AppError -> status. No business logic.
        +-------+--------+
                |
        +-------v--------+      +-------------+
        |  engine.js     +----->| registry.js |  versioned workflow configs (validated on load)
        |  (orchestrator)|      +-------------+
        |                |      +-------------+
        |                +----->| validator.js|  payload vs config schema
        |                |      +-------------+
        |                |      +-------------+
        |                +----->| conditions.js| pure rule language + evaluation trace
        |                |      +-------------+
        |                |      +-------------+
        |                +----->| services.js |  simulated external dependencies (+ fault injection)
        |                |      +-------------+
        |                |      +-------------+
        |                +----->| store.js    |  persistence boundary (Map + atomic JSON snapshot)
        +----------------+      +-------------+
```

| Component | Responsibility | Knows about |
|---|---|---|
| `server` | Transport only | engine, errors |
| `engine` | Lifecycle, idempotency, stage execution, retries, audit, explain | registry, store, services, conditions, validator |
| `registry` | Stores and validates workflow versions | conditions (for config validation) |
| `conditions` | Pure condition evaluation with trace | nothing |
| `validator` | Schema validation | nothing |
| `store` | Persist/load instances and system events | nothing |
| `services` | External calls | nothing |

Dependencies point inward and each module is replaceable: swapping `store` for Postgres or
`services` for real HTTP clients does not touch the engine. `app.js` is the only place that
wires concrete classes together (composition root), which also makes tests cheap.

## 3. Data flow

1. `POST /requests` -> registry resolves the **latest** config version for the workflow (404 if unknown).
2. **Idempotency check:** key = client `Idempotency-Key` or SHA-256 of the canonicalised payload.
   Found -> return the original instance (409 if the same key came with a different payload).
3. **Validation** against the config schema (422 + field errors, logged as an intake event, nothing persisted).
4. Instance created, pinned to `configVersion`, persisted as `RECEIVED -> VALIDATED -> IN_PROGRESS`.
5. **Stages** run in order from `instance.cursor`:
   - `rules` stage: all rules evaluated (full trace); precedence `REJECT > MANUAL_REVIEW > continue`.
   - `dependency` stage: call service with timeout; retry with exponential backoff; response matched
     against configured `outcomes`; on exhaustion -> `RETRY_PENDING`.
   - Optional `when` guard on stages and rules gives conditional branching.
   - Cursor is persisted after each stage (checkpoint).
6. Terminal/parked state persisted: `APPROVED`, `REJECTED`, `MANUAL_REVIEW`, or `RETRY_PENDING`.

### State machine

```
RECEIVED -> VALIDATED -> IN_PROGRESS -> APPROVED
                              |  \-----> REJECTED
                              |  \-----> MANUAL_REVIEW -> APPROVED | REJECTED  (human decision)
                              \--------> RETRY_PENDING -> IN_PROGRESS (retry) | MANUAL_REVIEW (budget exhausted)
```

Transitions are validated against a table; illegal ones throw. Every transition appends to an
immutable history with timestamp, reason and actor.

## 4. Configuration model

A workflow is JSON: `id`, `version`, `schema`, `stages[]`, `maxResumes`. See
`config/employee-onboarding.v1.json` and the README for the grammar. The engine contains no
domain terms: a vendor-approval workflow is added in a test using config alone.

Config is validated at registration (unknown operators, duplicate stage ids, invalid actions),
so mistakes fail at publish time instead of mid-request.

## 5. Engineering robustness

| Concern | Mechanism |
|---|---|
| Duplicate requests | Idempotency key / payload hash looked up before any work; replay returns original decision; replays logged |
| Concurrent duplicates | Lookup and create happen with no `await` between them, so on Node's single event loop only one wins (tested) |
| Key misuse | Same key + different payload -> 409 |
| Dependency failure | Per-call timeout, exponential backoff, then `RETRY_PENDING` instead of failing the request |
| Retry storms | `maxResumes` budget; after that, escalate to `MANUAL_REVIEW` |
| Retry correctness | Checkpointed cursor: resume at the failed stage, earlier stages are not repeated |
| Concurrent retries | State flips to `IN_PROGRESS` synchronously; second caller gets 409 (tested) |
| Partial save failure | Persist retried up to 3 times; if still failing -> 503 and nothing half-created, so the same key can be resubmitted safely |
| Torn writes | JSON snapshot written to a temp file then atomically renamed |
| Requirement change | Immutable config versions; instances pinned to their version |

## 6. Auditability

Each instance holds an append-only `audit` list: one entry per rule evaluated (including
skipped ones), per dependency attempt (request, response or error), and per outcome match.
Rule entries carry a `trace` of `{ field, op, expected, actual, result }`, which is the data
reference for the decision. `GET /requests/:id/explain` renders input, rules triggered, a
readable decision path, state history, and system events (duplicates). Examples:
[DECISION_EXAMPLES.md](DECISION_EXAMPLES.md).

## 7. Trade-offs and justifications

| Decision | Alternative | Why |
|---|---|---|
| Declarative JSON rules | Embedded JS expressions / a rules library | Safe (no code execution from config), validatable, serialisable into the audit trail. Cost: less expressive; arithmetic across fields needs new operators |
| Pin instances to config version | Re-evaluate under latest | Decisions stay reproducible and explainable; a mid-flight rule change cannot flip a decision. Cost: old versions must be retained |
| Evaluate all rules in a stage | Fail-fast | Complete explanation and correct precedence. Cost: a few extra comparisons |
| Operator-triggered retry | Background scheduler | Deterministic and simple to test and demo. Cost: no automatic recovery (see scaling) |
| Idempotency check before validation | Validate first | Replays must return the original answer even after a schema change |
| In-memory + JSON file store | SQLite/Postgres | Zero setup under the 2h constraint; the `Store` interface isolates the swap |
| Synchronous request processing | Async accept + poll | Simpler API for a demo; the checkpointed design already supports moving execution to workers |
| Instance embeds its audit/history | Separate append-only tables | Atomic with the state in one write. Cost: grows per instance (fine at this scale) |

## 8. Assumptions

- Single process, single event loop; one writer per instance at a time.
- Dependencies are idempotent or safe to call more than once on retry.
- Payload size is small; callers send an `Idempotency-Key` when they need strict semantics
  (the payload hash is a fallback, so two intentionally identical requests would be deduplicated).
- "Latest version" is the highest version number registered.
- Reviewers are trusted; authentication is out of scope.

## 9. Scaling considerations

1. **Storage:** replace `Store` with Postgres. A unique index on `idempotency_key` makes duplicate
   handling safe across processes (insert-or-fetch); store history/audit in append-only tables
   partitioned by time; optimistic locking on a `version` column for state transitions.
2. **Execution:** move `_run` behind a queue (SQS/Kafka/BullMQ). The API returns `202 + id`;
   workers pick up instances and resume from `cursor`. `RETRY_PENDING` becomes a delayed message
   with backoff, replacing the manual retry endpoint.
3. **Dependency protection:** per-service circuit breaker, rate limiting and bulkheads so one
   slow vendor cannot exhaust workers; dead-letter queue after the retry budget.
4. **Multi-instance safety:** distributed lock or row-level lease on an instance while a worker
   runs it, with lease expiry to recover from crashed workers.
5. **Config:** load from a database or object store with a cache and a publish/approve workflow;
   keep immutability so pinning keeps working.
6. **Read path:** serve `explain`/audit from a read replica or search index; archive terminal instances.
7. **Observability:** metrics per stage (latency, failure rate), tracing by request id, alerts on
   `RETRY_PENDING` age and manual-review backlog.
8. **Throughput:** the engine is stateless between stages, so horizontal scaling is adding workers;
   partition queues by workflow id for fairness.
