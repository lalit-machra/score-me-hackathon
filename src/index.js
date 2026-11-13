'use strict';
const { buildApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const { server, registry } = buildApp({ dataFile: process.env.DATA_FILE });
server.listen(port, () => {
  console.log(`Workflow engine listening on :${port}`);
  console.log('Workflows:', JSON.stringify(registry.list()));
});
