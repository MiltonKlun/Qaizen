// The relative-import closure the Healer copies and Gate 4 binds: it follows
// every relative import, survives cycles, and never takes a file from outside
// the repository or an environment file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { importClosure } from '../scripts/lib/import-closure.js';

function tree(t, files) {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-closure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('follows static, dynamic, re-export and require imports, through a cycle', (t) => {
  const dir = tree(t, {
    'tests/a.spec.ts':
      "import { b } from '../pages/b';\nconst c = await import('./c.js');\n",
    'pages/b.ts': "export * from './d';\nimport './b';\n",
    'pages/d.ts': "const e = require('../lib/e.cjs');\nimport '../pages/b';\n",
    'lib/e.cjs': 'module.exports = 1;\n',
    'tests/c.ts': 'export const c = 1;\n',
    'pages/unused.ts': 'export const u = 1;\n',
  });
  const { files, problems } = importClosure(dir, ['tests/a.spec.ts']);
  assert.deepEqual(problems, []);
  assert.deepEqual(files.sort(), [
    'lib/e.cjs',
    'pages/b.ts',
    'pages/d.ts',
    'tests/a.spec.ts',
    'tests/c.ts',
  ]);
});

test('reports what it will not take, in repository-relative POSIX paths', (t) => {
  const dir = tree(t, {
    'tests/a.spec.ts': [
      "import '../../outside';",
      "import './.env.local';",
      "import './missing';",
      "import 'some-package';",
      '',
    ].join('\n'),
    'tests/.env.local': 'SECRET=1\n',
  });
  const { files, problems } = importClosure(dir, [
    'tests/a.spec.ts',
    'tests/gone.spec.ts',
  ]);
  assert.deepEqual(files, ['tests/a.spec.ts']);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(
    problems.some((p) =>
      /tests\/a\.spec\.ts imports \.\.\/\.\.\/outside/.test(p)
    )
  );
  assert.ok(
    problems.some((p) =>
      /tests\/\.env\.local looks like an environment file/.test(p)
    )
  );
  assert.ok(
    problems.some((p) => /tests\/a\.spec\.ts imports \.\/missing/.test(p))
  );
  assert.ok(problems.includes('tests/gone.spec.ts does not exist'));
  assert.ok(!problems.some((p) => p.includes('\\')));
});
