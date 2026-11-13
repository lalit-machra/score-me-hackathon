'use strict';
// Schema validation for incoming payloads, driven by the workflow config.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(schema, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return [{ field: '$', message: 'payload must be a JSON object' }];
  }
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  for (const [name, rule] of Object.entries(schema.fields)) {
    const v = payload[name];
    if (v === undefined || v === null) {
      if (rule.required) add(name, 'is required');
      continue;
    }
    if (typeof v !== rule.type || (rule.type === 'number' && !Number.isFinite(v))) {
      add(name, `must be of type ${rule.type}`);
      continue;
    }
    if (rule.enum && !rule.enum.includes(v)) add(name, `must be one of: ${rule.enum.join(', ')}`);
    if (rule.type === 'string') {
      if (rule.minLength != null && v.length < rule.minLength) add(name, `must be at least ${rule.minLength} characters`);
      if (rule.maxLength != null && v.length > rule.maxLength) add(name, `must be at most ${rule.maxLength} characters`);
      if (rule.pattern && !new RegExp(rule.pattern).test(v)) add(name, 'has an invalid format');
      if (rule.format === 'date' && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) add(name, 'must be a valid date (YYYY-MM-DD)');
    }
    if (rule.type === 'number') {
      if (rule.min != null && v < rule.min) add(name, `must be >= ${rule.min}`);
      if (rule.max != null && v > rule.max) add(name, `must be <= ${rule.max}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(payload)) if (!(k in schema.fields)) add(k, 'is not an allowed field');
  }
  return errors;
}

module.exports = { validate };
