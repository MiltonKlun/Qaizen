// A Jira issue as story.md (scripts/lib/jira-story.js, fetch-jira-story.js):
// converted, never interpreted, and the same issue always gives the same file.
// The CLI test runs against a local fake Jira with every credential set
// explicitly, so no real .env value is ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { adfToMarkdown, storyMarkdown } from '../scripts/lib/jira-story.js';

const REPO = process.cwd();
const FETCH = join(REPO, 'scripts', 'fetch-jira-story.js');

const t = (text, marks) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content) => ({ type: 'paragraph', content });
const item = (...content) => ({ type: 'listItem', content });

/** An issue description using every node a Jira editor produces. */
const DESCRIPTION = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [t('Acceptance criteria')],
    },
    {
      type: 'orderedList',
      attrs: { order: 1 },
      content: [
        item(
          p(
            t(
              'Given a cart with two items, the Item total equals the sum of the prices.'
            )
          )
        ),
        item(
          p(
            t('The order log records '),
            t('expired_card_client_reject', [{ type: 'code' }]),
            t('.')
          ),
          {
            type: 'bulletList',
            content: [item(p(t('reason first'))), item(p(t('then the time')))],
          }
        ),
      ],
    },
    p(
      t('Ask '),
      { type: 'mention', attrs: { id: 'a1', text: '@Ada Reviewer' } },
      t(' — see '),
      t('the spec', [
        { type: 'link', attrs: { href: 'https://example.com/spec' } },
      ]),
      t(', '),
      { type: 'inlineCard', attrs: { url: 'https://example.com/card' } },
      t(' and '),
      { type: 'status', attrs: { text: 'IN REVIEW', color: 'blue' } },
      t(' by '),
      { type: 'date', attrs: { timestamp: '1791590400000' } },
      t(' '),
      { type: 'emoji', attrs: { shortName: ':warning:', text: '⚠️' } },
      { type: 'hardBreak' },
      t('Second line, '),
      t('bold', [{ type: 'strong' }]),
      t('.')
    ),
    {
      type: 'codeBlock',
      attrs: { language: 'json' },
      content: [t('{"total": 39.98}')],
    },
    { type: 'blockquote', content: [p(t('Quoted note.'))] },
    {
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [p(t('Prices include tax.'))],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('Item'))] },
            { type: 'tableHeader', content: [p(t('Price'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('Backpack'))] },
            { type: 'tableCell', content: [p(t('29.99 | USD'))] },
          ],
        },
      ],
    },
    {
      type: 'mediaSingle',
      content: [{ type: 'media', attrs: { id: 'img-1', alt: 'mockup.png' } }],
    },
    { type: 'rule' },
    {
      type: 'expand',
      attrs: { title: 'Edge cases' },
      content: [p(t('Empty cart.'))],
    },
  ],
};

const EXPECTED = `## Acceptance criteria

1. Given a cart with two items, the Item total equals the sum of the prices.
2. The order log records \`expired_card_client_reject\`.
   - reason first
   - then the time

Ask @Ada Reviewer — see [the spec](https://example.com/spec), <https://example.com/card> and [IN REVIEW] by 2026-10-10 ⚠️
Second line, **bold**.

\`\`\`json
{"total": 39.98}
\`\`\`

> Quoted note.

**warning:**

> Prices include tax.

| Item | Price |
| --- | --- |
| Backpack | 29.99 \\| USD |

(attachment mockup.png, not included)

---

**Edge cases**

Empty cart.`;

test('every node of a Jira description is converted, and nothing is lost', () => {
  assert.equal(adfToMarkdown(DESCRIPTION), EXPECTED);
});

test('plain text and empty fields pass through', () => {
  assert.equal(
    adfToMarkdown('  Plain text from Jira Server.\n'),
    'Plain text from Jira Server.'
  );
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown(undefined), '');
});

test('numbered criteria keep their numbers, counting from where Jira starts them', () => {
  const md = adfToMarkdown(DESCRIPTION);
  assert.match(md, /^1\. Given a cart/m);
  assert.match(md, /^2\. The order log/m);
  const fromThree = adfToMarkdown({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [item(p(t('third'))), item(p(t('fourth')))],
      },
    ],
  });
  assert.equal(fromThree, '3. third\n4. fourth');
});

const ISSUE = {
  key: 'SK-12',
  fields: {
    summary: 'Order summary totals',
    description: DESCRIPTION,
    issuetype: { name: 'Story' },
    status: { name: 'Ready for QA' },
    priority: { name: 'High' },
    labels: ['checkout'],
    components: [{ name: 'Web' }],
    parent: { key: 'SK-1', fields: { summary: 'Checkout epic' } },
    updated: '2026-10-09T15:00:00.000+0000',
    customfield_10045: {
      type: 'doc',
      content: [p(t('Total = Item total + Tax.'))],
    },
    comment: {
      comments: [
        {
          author: { displayName: 'Ada Reviewer' },
          created: '2026-10-08T10:00:00.000+0000',
          body: { type: 'doc', content: [p(t('Tax is 8%.'))] },
        },
      ],
    },
  },
};

test('story.md lays out the issue, the same way every time', () => {
  const md = storyMarkdown(ISSUE, {
    browseUrl: 'https://jira.example/browse/SK-12',
  });
  assert.equal(
    md,
    storyMarkdown(ISSUE, { browseUrl: 'https://jira.example/browse/SK-12' })
  );
  assert.match(md, /^# SK-12 — Order summary totals\n/);
  assert.match(
    md,
    /> Issue: https:\/\/jira\.example\/browse\/SK-12\n> Issue last updated in Jira: 2026-10-09T15:00:00\.000\+0000/
  );
  assert.match(
    md,
    /\*\*Issue type:\*\* Story {2}· {2}\*\*Status:\*\* Ready for QA {2}· {2}\*\*Priority:\*\* High {2}· {2}\*\*Component:\*\* Web {2}· {2}\*\*Labels:\*\* checkout {2}· {2}\*\*Parent:\*\* SK-1 — Checkout epic/
  );
  assert.ok(
    md.includes(
      `## Description / Acceptance criteria (verbatim from Jira)\n\n${EXPECTED}\n`
    )
  );
  // Not asked for: no comments, no custom field.
  assert.doesNotMatch(
    md,
    /## Comments|Tax is 8%|## Acceptance criteria \(Jira field/
  );
});

test('the criteria field and the comments appear only when configured, each in its own section', () => {
  const md = storyMarkdown(ISSUE, {
    acField: 'customfield_10045',
    comments: true,
  });
  assert.match(
    md,
    /## Acceptance criteria \(Jira field customfield_10045\)\n\nTotal = Item total \+ Tax\.\n/
  );
  assert.match(
    md,
    /## Comments \(context only, never acceptance criteria\)\n\n\*\*Ada Reviewer\*\*, 2026-10-08T10:00:00\.000\+0000:\n\n> Tax is 8%\.\n/
  );
  assert.match(
    md,
    /A rule that appears only in a comment is an\n {2}ambiguity to confirm at Gate 1/
  );
  const empty = storyMarkdown(
    { key: 'SK-2', fields: { summary: 'x' } },
    { acField: 'customfield_1', comments: true }
  );
  assert.match(empty, /\(no description in the issue\)/);
  assert.match(empty, /\(the field is empty in the issue\)/);
  assert.match(empty, /\(no comments\)/);
});

/** Run the CLI against a local fake Jira; every credential is explicit. */
async function fetchWith(env, respond) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    const { status, body } = respond(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(execPath, [FETCH, 'SK-12', '--print'], {
        cwd: REPO,
        env: {
          ...process.env,
          JIRA_URL: `http://127.0.0.1:${server.address().port}`,
          JIRA_USERNAME: 'qa@example.com',
          JIRA_API_TOKEN: 'fake-token-for-tests',
          JIRA_AC_FIELD: '',
          JIRA_STORY_COMMENTS: '',
          ...env,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    return { ...out, requests };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test('the CLI reads one issue, read-only, and prints exactly what the module renders', async () => {
  const r = await fetchWith({}, () => ({ status: 200, body: ISSUE }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.requests.length, 1);
  const [req] = r.requests;
  assert.equal(req.method, 'GET');
  assert.equal(
    req.url,
    '/rest/api/3/issue/SK-12?fields=summary,description,issuetype,status,priority,labels,components,parent,updated'
  );
  assert.equal(
    req.auth,
    'Basic ' +
      Buffer.from('qa@example.com:fake-token-for-tests').toString('base64')
  );
  const browse = `${r.stdout.match(/> Issue: (\S+)/)[1]}`;
  assert.equal(r.stdout, storyMarkdown(ISSUE, { browseUrl: browse }));
});

test('the CLI asks for the criteria field and comments only when configured', async () => {
  const r = await fetchWith(
    { JIRA_AC_FIELD: 'customfield_10045', JIRA_STORY_COMMENTS: 'true' },
    () => ({ status: 200, body: ISSUE })
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.requests[0].url,
    /fields=.*,updated,comment,customfield_10045$/
  );
  assert.match(
    r.stdout,
    /## Acceptance criteria \(Jira field customfield_10045\)/
  );
  assert.match(r.stdout, /## Comments \(context only/);
});

test('a bad criteria field id is a usage error; a failed fetch writes nothing', async () => {
  const bad = await fetchWith({ JIRA_AC_FIELD: 'Acceptance Criteria' }, () => ({
    status: 200,
    body: ISSUE,
  }));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /must be a custom field id/);
  assert.equal(bad.requests.length, 0);

  const missing = await fetchWith({}, () => ({
    status: 404,
    body: { errorMessages: ['Issue does not exist'] },
  }));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Fetch SK-12 failed \(HTTP 404\)/);
  assert.equal(missing.stdout, '');
});
