// @ts-check
// A Jira issue as the story the Analyst reads (scripts/fetch-jira-story.js).
//
// Deterministic: the same issue always renders to the same story.md, with no
// fetch time in it, so its digest (which Gate 1 binds) changes only when the
// issue does. Nothing is summarized or reworded; this module converts Jira's
// document format (ADF) to Markdown and lays the fields out.
//
// What used to be lost, and is now kept: numbered lists (acceptance criteria
// are often numbered), nested lists, mentions, links, inline cards, status
// lozenges, dates, emoji, code blocks, quotes, panels, expands and tables. An
// attachment is named, never fetched. Comments and an acceptance-criteria
// custom field are included only when configured, in their own sections:
// comments are context for the Analyst, never criteria.

/** @typedef {{ type?: string, text?: string, attrs?: Record<string, any>,
 *   marks?: { type: string, attrs?: Record<string, any> }[],
 *   content?: AdfNode[] }} AdfNode */

/**
 * Inline text with its marks: code, bold, italic, strike, link.
 * @param {AdfNode} node
 * @returns {string}
 */
function markText(node) {
  let t = node.text ?? '';
  for (const m of node.marks ?? []) {
    if (m.type === 'code') t = `\`${t}\``;
    else if (m.type === 'strong') t = `**${t}**`;
    else if (m.type === 'em') t = `_${t}_`;
    else if (m.type === 'strike') t = `~~${t}~~`;
  }
  const link = (node.marks ?? []).find((m) => m.type === 'link');
  return link?.attrs?.href ? `[${t}](${link.attrs.href})` : t;
}

/**
 * The inline content of a block, on one line (hard breaks kept).
 * @param {AdfNode} node
 * @returns {string}
 */
function inline(node) {
  return (node.content ?? []).map((c) => block(c, 0)).join('');
}

/** @param {string} s */
const cell = (s) => s.replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();

/**
 * One list, numbered or not, nested lists indented under their item.
 * @param {AdfNode} node
 * @param {number} depth
 * @returns {string}
 */
function list(node, depth) {
  const ordered = node.type === 'orderedList';
  let n = Number(node.attrs?.order ?? 1);
  const pad = '   '.repeat(depth);
  return (node.content ?? [])
    .map((item) => {
      const marker = ordered ? `${n++}.` : '-';
      const parts = (item.content ?? []).map((c) =>
        c.type === 'bulletList' || c.type === 'orderedList'
          ? list(c, depth + 1)
          : block(c, depth + 1).trim()
      );
      const [first = '', ...rest] = parts;
      return [`${pad}${marker} ${first}`, ...rest].join('\n');
    })
    .join('\n')
    .concat(depth === 0 ? '\n\n' : '');
}

/**
 * A table as a Markdown table; the first row is its header.
 * @param {AdfNode} node
 * @returns {string}
 */
function table(node) {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((c) =>
      cell((c.content ?? []).map((p) => block(p, 0)).join(' '))
    )
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (/** @type {string[]} */ r) =>
    `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  return [
    line(rows[0]),
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...rows.slice(1).map(line),
  ]
    .join('\n')
    .concat('\n\n');
}

/**
 * @param {AdfNode} node
 * @param {number} depth list nesting, for nested lists
 * @returns {string}
 */
function block(node, depth) {
  if (!node) return '';
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'text':
      return markText(node);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(a.text ?? '@someone');
    case 'emoji':
      return String(a.text ?? a.shortName ?? '');
    case 'status':
      return `[${a.text ?? ''}]`;
    case 'date':
      return a.timestamp
        ? new Date(Number(a.timestamp)).toISOString().slice(0, 10)
        : '';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return a.url ? `<${a.url}>` : '';
    case 'paragraph':
      return `${inline(node)}\n\n`;
    case 'heading':
      return `${'#'.repeat(Number(a.level) || 2)} ${inline(node).trim()}\n\n`;
    case 'bulletList':
    case 'orderedList':
      return list(node, depth);
    case 'codeBlock':
      return `\`\`\`${a.language ?? ''}\n${(node.content ?? [])
        .map((c) => c.text ?? '')
        .join('')}\n\`\`\`\n\n`;
    case 'blockquote':
      return (
        (node.content ?? [])
          .map((c) => block(c, depth).trim())
          .join('\n\n')
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n') + '\n\n'
      );
    case 'panel': {
      const body = (node.content ?? []).map((c) => block(c, depth)).join('');
      return (
        `**${String(a.panelType ?? 'info')}:**\n\n` +
        body
          .trim()
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n') +
        '\n\n'
      );
    }
    case 'expand':
    case 'nestedExpand':
      return `**${a.title ?? 'Details'}**\n\n${(node.content ?? [])
        .map((c) => block(c, depth))
        .join('')}`;
    case 'rule':
      return '---\n\n';
    case 'table':
      return table(node);
    case 'media':
      return a.alt || a.id
        ? `(attachment ${a.alt || a.id}, not included)`
        : '(attachment, not included)';
    case 'mediaSingle':
    case 'mediaGroup':
      return `${(node.content ?? []).map((c) => block(c, depth)).join(' ')}\n\n`;
    default:
      return (node.content ?? []).map((c) => block(c, depth)).join('');
  }
}

/**
 * Atlassian Document Format to Markdown. A plain string (Jira Server, or a
 * plain-text custom field) is returned as it is.
 * @param {AdfNode | string | null | undefined} doc
 * @returns {string}
 */
export function adfToMarkdown(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc.trim();
  return block(doc, 0)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * story.md for an issue.
 * @param {any} issue the REST response for /rest/api/3/issue/<key>
 * @param {{ browseUrl?: string, acField?: string | null,
 *   comments?: boolean }} [opts]
 * @returns {string}
 */
export function storyMarkdown(issue, opts = {}) {
  const f = issue?.fields ?? {};
  const key = issue?.key ?? '?';
  const desc = adfToMarkdown(f.description) || '(no description in the issue)';
  const names = (/** @type {{ name: string }[] | undefined} */ xs) =>
    (xs ?? []).map((x) => x.name).join(', ') || '(none)';
  const facts = [
    `**Issue type:** ${f.issuetype?.name ?? '?'}`,
    `**Status:** ${f.status?.name ?? '?'}`,
    `**Priority:** ${f.priority?.name ?? '(none)'}`,
    `**Component:** ${names(f.components)}`,
    `**Labels:** ${(f.labels ?? []).join(', ') || '(none)'}`,
  ];
  if (f.parent?.key) {
    facts.push(
      `**Parent:** ${f.parent.key}${f.parent.fields?.summary ? ` — ${f.parent.fields.summary}` : ''}`
    );
  }
  const lines = [
    `# ${key} — ${f.summary ?? '(no summary)'}`,
    '',
    `> Jira-mode story fetched READ-ONLY by scripts/fetch-jira-story.js. The`,
    `> Analyst treats this as source: "jira", story.id = "${key}",`,
    `> story.jira_issue_key = "${key}".`,
    ...(opts.browseUrl ? [`> Issue: ${opts.browseUrl}`] : []),
    ...(f.updated ? [`> Issue last updated in Jira: ${f.updated}`] : []),
    '',
    facts.join('  ·  '),
    '',
    '## Description / Acceptance criteria (verbatim from Jira)',
    '',
    desc,
    '',
  ];
  if (opts.acField) {
    const ac = adfToMarkdown(f[opts.acField]);
    lines.push(
      `## Acceptance criteria (Jira field ${opts.acField})`,
      '',
      ac || '(the field is empty in the issue)',
      ''
    );
  }
  if (opts.comments) {
    /** @type {{ author?: { displayName?: string }, created?: string, body?: any }[]} */
    const comments = f.comment?.comments ?? [];
    lines.push(
      '## Comments (context only, never acceptance criteria)',
      '',
      ...(comments.length
        ? comments.flatMap((c) => [
            `**${c.author?.displayName ?? '(unknown)'}**, ${c.created ?? '?'}:`,
            '',
            adfToMarkdown(c.body)
              .split('\n')
              .map((l) => `> ${l}`.trimEnd())
              .join('\n'),
            '',
          ])
        : ['(no comments)', ''])
    );
  }
  lines.push(
    '## Notes for the QA pipeline',
    '',
    '- The Analyst must extract the acceptance criteria VERBATIM from the',
    '  text above and list any ambiguities — do not invent ACs.',
    '- If the issue text is thin, that is itself a Gate-1 ambiguity to flag.'
  );
  if (opts.comments) {
    lines.push(
      '- Comments are context. A rule that appears only in a comment is an',
      '  ambiguity to confirm at Gate 1, not an acceptance criterion.'
    );
  }
  return lines.join('\n') + '\n';
}
