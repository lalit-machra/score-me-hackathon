'use strict';
// Declarative condition language shared by rules, stage guards and
// dependency-outcome matching. Pure functions only: no I/O, no state.

const get = (obj, path) =>
  String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

const OPS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => isNum(a) && a > b,
  gte: (a, b) => isNum(a) && a >= b,
  lt: (a, b) => isNum(a) && a < b,
  lte: (a, b) => isNum(a) && a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  nin: (a, b) => Array.isArray(b) && !b.includes(a),
  exists: (a, b) => (a !== undefined && a !== null && a !== '') === (b !== false),
  matches: (a, b) => typeof a === 'string' && new RegExp(b).test(a),
};

// Evaluates a condition tree. Every leaf comparison is pushed to `trace`
// (no short-circuiting) so explanations always show the full picture.
function evaluate(cond, data, trace) {
  if (cond.all) return cond.all.map((c) => evaluate(c, data, trace)).every(Boolean);
  if (cond.any) return cond.any.map((c) => evaluate(c, data, trace)).some(Boolean);
  if (cond.not) return !evaluate(cond.not, data, trace);
  const fn = OPS[cond.op];
  if (!fn) throw new Error(`Unknown operator '${cond.op}'`);
  const actual = get(data, cond.field);
  const result = Boolean(fn(actual, cond.value));
  trace.push({ field: cond.field, op: cond.op, expected: cond.value, actual, result });
  return result;
}

function check(cond, data) {
  const trace = [];
  const result = evaluate(cond, data, trace);
  return { result, trace };
}

// Config-time validation so bad rules fail on load, not at 3am in production.
function validateCondition(c, where = 'condition') {
  const p = [];
  if (!c || typeof c !== 'object') return [`${where}: must be an object`];
  const group = c.all ? 'all' : c.any ? 'any' : null;
  if (group) {
    if (!Array.isArray(c[group]) || !c[group].length) p.push(`${where}.${group}: must be a non-empty array`);
    else c[group].forEach((x, i) => p.push(...validateCondition(x, `${where}.${group}[${i}]`)));
    return p;
  }
  if (c.not) return validateCondition(c.not, `${where}.not`);
  if (typeof c.field !== 'string') p.push(`${where}.field: required string`);
  if (!OPS[c.op]) p.push(`${where}.op: unknown operator '${c.op}'`);
  return p;
}

module.exports = { get, check, validateCondition, OPS };
