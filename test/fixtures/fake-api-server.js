#!/usr/bin/env node
// A stand-in for the reqres.in endpoints the gold API collection calls
// (examples/expected/api-create-user.expected-collection.json), so the
// pipeline's API branch can run real Newman offline in tests. A separate
// process, because the runner blocks its event loop while Newman runs.
// Prints `PORT <n>` on its first line.

import { createServer } from 'node:http';

const server = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && req.url === '/users') {
    return json(201, { id: '7', createdAt: new Date().toISOString() });
  }
  if (req.method === 'POST' && req.url === '/register') {
    return json(400, { error: 'Missing password' });
  }
  json(404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`);
});
