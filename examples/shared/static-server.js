// The static-file server both offline example apps share (task group 9.2):
// examples/demo-run/serve.js and examples/benchmark-app/serve.js each carried
// a near-verbatim copy of this. Zero dependencies (node:http), localhost only,
// no network egress.
//
// It serves files under `root` only (a path that resolves outside it, or does
// not exist, is a 404), and prints `PORT <n>` as its first stdout line once
// listening: the contract the demo driver and the benchmark tooling parse.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/**
 * Serve `root` on 127.0.0.1.
 * @param {object} opts
 * @param {string} opts.root        directory to serve
 * @param {number} [opts.port]      0 = ephemeral
 * @param {(file: string, body: Buffer) => Buffer} [opts.transform]
 *        rewrite a file's bytes before sending (e.g. inject configuration)
 * @returns {Promise<number>} the port actually bound
 */
export function serveStatic({ root, port = 0, transform }) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = resolve(join(base, rel));
    if (
      !(file === base || file.startsWith(base + sep)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = readFileSync(file);
    if (transform) body = transform(file, body);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'text/plain',
      'content-length': body.length,
    });
    res.end(body);
  });
  return new Promise((ok) =>
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      // First stdout line is the contract the drivers parse.
      process.stdout.write(`PORT ${actual}\n`);
      ok(actual);
    })
  );
}
