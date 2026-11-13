'use strict';
// Workflow definition registry. Keeps every version so in-flight requests
// stay pinned to the config they started with.
const fs = require('node:fs');
const path = require('node:path');
const { validateCondition } = require('./conditions');
const { AppError } = require('./errors');

const RULE_ACTIONS = ['REJECT', 'MANUAL_REVIEW'];
const STAGE_ACTIONS = ['CONTINUE', 'REJECT', 'MANUAL_REVIEW', 'RETRY_PENDING'];

function validateConfig(c) {
  const p = [];
  if (!c || typeof c.id !== 'string' || !c.id) p.push('id: required string');
  if (!Number.isInteger(c?.version) || c.version < 1) p.push('version: must be a positive integer');
  if (!c?.schema || typeof c.schema.fields !== 'object') p.push('schema.fields: required');
  if (!Array.isArray(c?.stages) || !c.stages.length) {
    p.push('stages: must be a non-empty array');
  } else {
    const seen = new Set();
    c.stages.forEach((s, i) => {
      const w = `stages[${i}]`;
      if (!s.id || seen.has(s.id)) p.push(`${w}.id: required and unique`);
      seen.add(s.id);
      if (s.when) p.push(...validateCondition(s.when, `${w}.when`));
      if (s.type === 'rules') {
        if (!Array.isArray(s.rules) || !s.rules.length) p.push(`${w}.rules: must be a non-empty array`);
        (s.rules || []).forEach((r, j) => {
          if (!r.id) p.push(`${w}.rules[${j}].id: required`);
          p.push(...validateCondition(r.check, `${w}.rules[${j}].check`));
          if (r.when) p.push(...validateCondition(r.when, `${w}.rules[${j}].when`));
          if (r.onFail && !RULE_ACTIONS.includes(r.onFail)) p.push(`${w}.rules[${j}].onFail: must be one of ${RULE_ACTIONS}`);
        });
      } else if (s.type === 'dependency') {
        if (!s.service) p.push(`${w}.service: required`);
        if (!Array.isArray(s.outcomes)) p.push(`${w}.outcomes: must be an array`);
        (s.outcomes || []).forEach((o, j) => {
          p.push(...validateCondition(o.when, `${w}.outcomes[${j}].when`));
          if (!STAGE_ACTIONS.includes(o.action)) p.push(`${w}.outcomes[${j}].action: must be one of ${STAGE_ACTIONS}`);
        });
        if (s.retry && !(s.retry.maxAttempts >= 1)) p.push(`${w}.retry.maxAttempts: must be >= 1`);
      } else {
        p.push(`${w}.type: must be 'rules' or 'dependency'`);
      }
    });
  }
  if (p.length) throw new AppError(400, 'INVALID_CONFIG', 'Workflow config is invalid', { problems: p });
}

class Registry {
  constructor() {
    this.workflows = new Map(); // id -> Map(version -> config)
  }

  loadDir(dir) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      this.register(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
  }

  register(config) {
    validateConfig(config);
    const versions = this.workflows.get(config.id) || new Map();
    if (versions.has(config.version)) {
      throw new AppError(409, 'VERSION_EXISTS', `${config.id} v${config.version} already exists; bump the version`);
    }
    versions.set(config.version, structuredClone(config));
    this.workflows.set(config.id, versions);
    return { id: config.id, version: config.version };
  }

  get(id, version) {
    const versions = this.workflows.get(id);
    if (!versions) throw new AppError(404, 'UNKNOWN_WORKFLOW', `No workflow '${id}'`);
    const v = version === undefined ? Math.max(...versions.keys()) : version;
    const cfg = versions.get(v);
    if (!cfg) throw new AppError(404, 'UNKNOWN_VERSION', `No version ${version} of '${id}'`);
    return cfg;
  }

  list() {
    return [...this.workflows].map(([id, v]) => ({ id, versions: [...v.keys()], latest: Math.max(...v.keys()) }));
  }
}

module.exports = { Registry, validateConfig };
