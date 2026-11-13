'use strict';
// Composition root: wires dependencies. Tests build their own instances here.
const path = require('node:path');
const { Registry } = require('./registry');
const { Store } = require('./store');
const { Services } = require('./services');
const { Engine } = require('./engine');
const { createServer } = require('./server');

function buildApp({ configDir = path.join(__dirname, '..', 'config'), dataFile, sleep, clock } = {}) {
  const registry = new Registry();
  registry.loadDir(configDir);
  const store = new Store({ file: dataFile });
  const services = new Services();
  const engine = new Engine({ registry, store, services, sleep, clock });
  const server = createServer({ engine, registry, services, store });
  return { registry, store, services, engine, server };
}

module.exports = { buildApp };
