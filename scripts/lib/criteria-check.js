// @ts-check
// Gate 1: is each acceptance criterion the story's own text?
//
// The Analyst copies criteria verbatim (agents/analyst.md). This compares each
// one with story.md token by token. Only formatting may differ: whitespace and
// line wrapping, case, quote marks (a curly apostrophe is a straight one),
// code and emphasis marks, list markers and labels such as "AC1:", table
// pipes, dashes between words, the ellipsis, and the punctuation
// . , : ; ! ? and brackets. Everything else counts, including comparison
// signs (> < =), numbers with their sign and decimal point, currency signs
// and words. Where it is found matters too: a criterion found only under an
// "Out of scope" heading or label, or only in a comment (an HTML comment or a
// "Comments" section), is not a criterion of the story.
//
// A criterion found in the story must be whole: it starts at the start of a
// sentence, clause or list item, and ends at its end (. ! ? or the end of the
// item). It may end at ; or : only when the next clause is another
// criterion, as when a story lists its criteria in one sentence. Otherwise
// it is reported as cut short, or as starting mid-sentence. One that runs
// across two list items or paragraphs is reported too.
//
// For a criterion it cannot find, the closest passage of the story is named
// and the difference classified: a comparison, number or negation added,
// dropped or changed, other rewording, or absent.
//
// Pure: no I/O. It informs the reviewer and never decides Gate 1.

/**
 * @typedef {{ text: string, sig: boolean, stop: 'hard' | 'soft' | null,
 *   kind: SectionKind, block: number }} Token
 * @typedef {'story' | 'out_of_scope' | 'comment'} SectionKind
 * @typedef {{ n: number, status: 'verbatim' | 'formatting' | 'issue',
 *   issues: string[] }} CriterionReport
 */

// Characters that are formatting, not wording. A dash before a number is a
// minus sign, read as part of the number (see TOKEN).
const FORMATTING = new Set([...'\'"`‘’“”«»´*_~\\.,:;!?()[]{}|-‐‑–—−…']);
// Punctuation that ends a sentence, and the kind that ends a clause.
const HARD_STOPS = new Set([...'.!?']);
const SOFT_STOPS = new Set([...';:']);

const COMPARISON_WORDS = new Set([
  'more',
  'less',
  'fewer',
  'greater',
  'least',
  'most',
  'above',
  'below',
  'over',
  'under',
  'exceed',
  'exceeds',
  'minimum',
  'maximum',
  'min',
  'max',
  'higher',
  'lower',
  'más',
  'menos',
  'mayor',
  'menor',
  'mínimo',
  'máximo',
  'superior',
  'inferior',
]);
const COMPARISON_SIGNS = new Set([...'<>=≤≥≠']);
const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  'none',
  'nothing',
  'nobody',
  'neither',
  'nor',
  'without',
  'unless',
  'cannot',
  'nunca',
  'jamás',
  'sin',
  'ninguno',
  'ninguna',
  'nada',
  'tampoco',
]);

const OUT_OF_SCOPE_WORDS =
  'out[- ]of[- ]scope|not in scope|not included|non[- ]goals?|fuera de(?:l)? alcance';
// A heading that names an out-of-scope section anywhere in it.
const OUT_OF_SCOPE_HEADING = new RegExp(`\\b(?:${OUT_OF_SCOPE_WORDS})\\b`, 'i');
// A line that starts with an out-of-scope label, such as "**Out of scope:**".
const OUT_OF_SCOPE_LABEL = new RegExp(
  `^(?:\\*\\*|__)?(?:${OUT_OF_SCOPE_WORDS})(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?\\s*`,
  'i'
);
// A heading that is a comments section, not a feature about comments:
// "Comments", "Discussion", optionally with a note in brackets.
const COMMENTS_HEADING =
  /^(?:comments?|comentarios?|discussion|discusión)\s*(?:\(.*\))?\s*:?\s*$/i;
// "AC1:", "**AC 2** -", "Criterion 3." at the start of a line.
const AC_LABEL =
  /^(?:\*\*|__)?(?:ac|criteri(?:on|a|o))[\s#-]*\d+(?:\*\*|__)?\s*[:.)\-–—]?(?:\*\*|__)?\s+/i;
// List markers: "-", "*", "+", "1.", "1)", "a)", "a.", with an optional
// task box; and blockquote markers before them.
const LIST_MARKER =
  /^\s*(?:>\s?)*(?:([-*+]|\d+[.)]|[a-z][.)])\s+(?:\[[ xX]\]\s+)?)?/;
const CRITERIA_HEADING = /acceptance criteria|criterios de aceptaci[oó]n/i;
const FENCE = /^\s*(```|~~~)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}/;

const TOKEN =
  /(?<![\p{L}\p{N}])[-‐‑–−]\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_]|['’](?=[\p{L}\p{N}])|[.,](?=\p{N}))*|\S/gu;

/** @param {string} t */
const isNumber = (t) => /^-?\p{N}+(?:[.,]\p{N}+)*$/u.test(t);
/** @param {string} t */
const isNegation = (t) => NEGATIONS.has(t) || /n't$/.test(t);
/** @param {string} t */
const isComparison = (t) => COMPARISON_WORDS.has(t) || COMPARISON_SIGNS.has(t);

/**
 * Tokens of one piece of text.
 * @param {string} text
 * @param {SectionKind} kind
 * @param {number} block
 * @returns {Token[]}
 */
function tokensOf(text, kind, block) {
  return [...text.matchAll(TOKEN)].map(([raw]) => ({
    text: raw
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/^[‐‑–−]/, '-'),
    sig: !FORMATTING.has(raw),
    stop: HARD_STOPS.has(raw) ? 'hard' : SOFT_STOPS.has(raw) ? 'soft' : null,
    kind,
    block,
  }));
}

/**
 * The story as tokens, each with the kind of section it is in and its block
 * (a paragraph, list item, table cell, labelled line or heading).
 * @param {string} story
 * @returns {Token[]}
 */
export function storyTokens(story) {
  /** @type {Token[]} */
  const out = [];
  /** @type {{ level: number, kind: SectionKind, criteria: boolean }[]} */
  const sections = [];
  let block = 0;
  /** @type {SectionKind | null} a kind for the current block only */
  let blockKind = null;
  let inComment = false;
  let inFence = false;
  const next = () => {
    block += 1;
    blockKind = null;
  };
  const kindNow = () =>
    blockKind ?? /** @type {SectionKind} */ (sections.at(-1)?.kind ?? 'story');
  for (const rawLine of story.split(/\r?\n/)) {
    if (!inComment && FENCE.test(rawLine)) {
      inFence = !inFence;
      next();
      continue;
    }
    const heading =
      inComment || inFence ? null : /^ {0,3}(#{1,6})\s+(.*)$/.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      while (sections.length && sections[sections.length - 1].level >= level)
        sections.pop();
      const parent = /** @type {SectionKind} */ (
        sections.at(-1)?.kind ?? 'story'
      );
      const title = heading[2].trim();
      // Inside an acceptance-criteria section, a "Comments" heading names a
      // feature's criteria, not a comments section.
      const underCriteria = sections.some((x) => x.criteria);
      /** @type {SectionKind} */
      const kind = OUT_OF_SCOPE_HEADING.test(title)
        ? 'out_of_scope'
        : COMMENTS_HEADING.test(title) && !underCriteria
          ? 'comment'
          : parent;
      next();
      out.push(...tokensOf(title, parent, block));
      sections.push({ level, kind, criteria: CRITERIA_HEADING.test(title) });
      next();
      continue;
    }
    if (!inComment && rawLine.trim() === '') {
      next();
      continue;
    }
    let line = rawLine;
    if (!inComment && !inFence) {
      // A list item starts a block; its marker and a blockquote are formatting.
      const marker = LIST_MARKER.exec(line);
      if (marker?.[1]) next();
      line = line.slice(marker?.[0].length ?? 0);
      // So does a labelled line ("AC1:"), whose label is formatting.
      const label = AC_LABEL.exec(line);
      if (label) {
        next();
        line = line.slice(label[0].length);
      }
      // An "Out of scope:" label puts its paragraph out of scope.
      const oos = OUT_OF_SCOPE_LABEL.exec(line);
      if (oos) {
        next();
        blockKind = 'out_of_scope';
        line = line.slice(oos[0].length);
      }
      // Each table cell is its own block; the separator row is formatting.
      if (/^\s*\|/.test(line)) {
        if (TABLE_SEPARATOR.test(line)) continue;
        for (const cell of line.split('|')) {
          next();
          out.push(...tokensOf(cell, kindNow(), block));
        }
        next();
        continue;
      }
    }
    // HTML comments, possibly spanning lines.
    let rest = line;
    while (rest.length) {
      if (inComment) {
        const end = rest.indexOf('-->');
        const part = end === -1 ? rest : rest.slice(0, end);
        out.push(...tokensOf(part, 'comment', block));
        if (end === -1) break;
        inComment = false;
        next();
        rest = rest.slice(end + 3);
      } else {
        const start = inFence ? -1 : rest.indexOf('<!--');
        const part = start === -1 ? rest : rest.slice(0, start);
        out.push(...tokensOf(part, kindNow(), block));
        if (start === -1) break;
        inComment = true;
        next();
        rest = rest.slice(start + 4);
      }
    }
  }
  return out;
}

/**
 * Where the significant tokens of `needle` occur, in order and contiguous,
 * among the significant tokens of the story.
 * @param {Token[]} sig story's significant tokens
 * @param {string[]} needle
 * @returns {number[]} start indexes into `sig`
 */
function occurrences(sig, needle) {
  /** @type {number[]} */
  const found = [];
  if (!needle.length) return found;
  for (let i = 0; i + needle.length <= sig.length; i++) {
    let j = 0;
    while (j < needle.length && sig[i + j].text === needle[j]) j++;
    if (j === needle.length) found.push(i);
  }
  return found;
}

/**
 * How an occurrence starts and ends. It starts well at the edge of its block
 * or after any stop. It ends well at the edge of its block or before a hard
 * stop (. ! ?); before a soft stop (; :) it ends `soft`, which is whole only
 * when another criterion starts at `next`.
 * @param {Token[]} all every story token
 * @param {number} first index into `all` of the first matched token
 * @param {number} last index into `all` of the last matched token
 * @returns {{ start: boolean, end: true | false | 'soft', next: number }}
 */
function edges(all, first, last) {
  const block = all[first].block;
  let start = true;
  for (let i = first - 1; i >= 0 && all[i].block === block; i--) {
    if (all[i].stop) break;
    if (all[i].sig) {
      start = false;
      break;
    }
  }
  /** @type {true | false | 'soft'} */
  let end = true;
  let next = -1;
  for (let i = last + 1; i < all.length && all[i].block === block; i++) {
    if (all[i].stop === 'hard') break;
    if (all[i].stop === 'soft') {
      end = 'soft';
      for (let j = i + 1; j < all.length && all[j].block === block; j++)
        if (all[j].sig) {
          next = j;
          break;
        }
      if (next === -1) end = true;
      break;
    }
    if (all[i].sig) {
      end = false;
      next = i;
      break;
    }
  }
  return { start, end, next };
}

/**
 * The words that follow (or precede) a cut-short criterion in the story.
 * @param {Token[]} all
 * @param {number} from
 * @param {1 | -1} step
 */
function context(all, from, step) {
  /** @type {string[]} */
  const words = [];
  const block = all[from].block;
  for (
    let i = from + step;
    i >= 0 && i < all.length && all[i].block === block && words.length < 8;
    i += step
  ) {
    if (all[i].stop === 'hard' || (step === -1 && all[i].stop)) break;
    if (all[i].sig) words.push(all[i].text);
  }
  return step === 1 ? words.join(' ') : words.reverse().join(' ');
}

/**
 * Longest common subsequence of two token lists, as matched index pairs.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[number, number][]}
 */
function lcs(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  /** @type {[number, number][]} */
  const pairs = [];
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * What differs between two token lists in one class of token.
 * @param {string[]} mine
 * @param {string[]} theirs
 * @param {(t: string) => boolean} pick
 */
function classDiff(mine, theirs, pick) {
  const count = (/** @type {string[]} */ ts) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const t of ts.filter(pick)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const a = count(mine);
  const b = count(theirs);
  const only = (
    /** @type {Map<string, number>} */ x,
    /** @type {Map<string, number>} */ y
  ) =>
    [...x].flatMap(([t, k]) => Array(Math.max(0, k - (y.get(t) ?? 0))).fill(t));
  return { added: only(a, b), dropped: only(b, a) };
}

/** @param {string[]} ts */
const quote = (ts) => ts.map((t) => `"${t}"`).join(', ');

/**
 * One class of difference, as the brief says it.
 * @param {string} what "comparison", "number" or "negation"
 * @param {{ added: string[], dropped: string[] }} d
 * @returns {string | null}
 */
function differs(what, d) {
  if (d.added.length && d.dropped.length)
    return `changes a ${what} (story: ${quote(d.dropped)}; criterion: ${quote(d.added)})`;
  if (d.added.length) return `adds a ${what} (${quote(d.added)})`;
  if (d.dropped.length) return `drops a ${what} (${quote(d.dropped)})`;
  return null;
}

const WHERE = {
  story: 'the story',
  out_of_scope: 'an "Out of scope" section',
  comment: 'a comment',
};

/**
 * Why a criterion that is not in the story differs from its closest passage.
 * @param {string[]} words the criterion's significant tokens
 * @param {Token[]} sig the story's significant tokens
 * @returns {string[]}
 */
function diagnose(words, sig) {
  /** @type {Map<number, { kind: SectionKind, tokens: string[] }>} */
  const blocks = new Map();
  for (const t of sig) {
    const b = blocks.get(t.block) ?? { kind: t.kind, tokens: [] };
    b.tokens.push(t.text);
    blocks.set(t.block, b);
  }
  let best = {
    score: 0,
    kind: /** @type {SectionKind} */ ('story'),
    region: /** @type {string[]} */ ([]),
  };
  for (const { kind, tokens } of blocks.values()) {
    const pairs = lcs(words, tokens);
    if (!pairs.length) continue;
    const score = pairs.length / words.length;
    // A passage of the story itself wins a tie.
    if (score > best.score || (score === best.score && kind === 'story')) {
      // The matched stretch, widened by the criterion's unmatched words at
      // either end, so a changed first or last word is compared too.
      const lead = pairs[0][0];
      const trail = words.length - 1 - pairs[pairs.length - 1][0];
      const region = tokens.slice(
        Math.max(0, pairs[0][1] - lead),
        pairs[pairs.length - 1][1] + 1 + trail
      );
      best = { score, kind, region };
    }
  }
  if (best.score < 0.5) return ['is not in the story'];
  const issues = /** @type {string[]} */ (
    [
      differs('comparison', classDiff(words, best.region, isComparison)),
      differs('number', classDiff(words, best.region, isNumber)),
      differs('negation', classDiff(words, best.region, isNegation)),
    ].filter(Boolean)
  );
  if (!issues.length) {
    const near = best.region.slice(0, 12).join(' ');
    issues.push(
      `is reworded (closest in ${WHERE[best.kind]}: "${near}${best.region.length > 12 ? ' …' : ''}")`
    );
  } else if (best.kind !== 'story') {
    issues.push(`its closest passage is in ${WHERE[best.kind]}`);
  }
  return issues;
}

/**
 * Compare each acceptance criterion with the story.
 * @param {string[]} criteria
 * @param {string} story
 * @returns {CriterionReport[]} one per criterion, numbered from 1
 */
export function compareCriteria(criteria, story) {
  const all = storyTokens(story);
  /** @type {Token[]} */
  const sig = [];
  /** @type {number[]} */
  const sigAt = [];
  all.forEach((t, i) => {
    if (t.sig) {
      sig.push(t);
      sigAt.push(i);
    }
  });
  const flat = story.replace(/\s+/g, ' ');
  const found = criteria.map((criterion) => {
    // A label the Analyst kept ("AC1: ...") is formatting, as in the story.
    const words = tokensOf(criterion.trim().replace(AC_LABEL, ''), 'story', 0)
      .filter((t) => t.sig)
      .map((t) => t.text);
    return { criterion, words, starts: occurrences(sig, words) };
  });
  // Where some criterion starts in the story, so one that ends at ; or : is
  // whole when the next clause is another criterion.
  const criterionStarts = new Set(
    found.flatMap((f) => f.starts.map((s) => sigAt[s]))
  );

  return found.map(({ criterion, words, starts }, i) => {
    const n = i + 1;
    if (!words.length) return { n, status: 'issue', issues: ['is empty'] };
    if (!starts.length)
      return { n, status: 'issue', issues: diagnose(words, sig) };
    const span = (/** @type {number} */ s) => sig.slice(s, s + words.length);
    const inStory = starts.filter((s) =>
      span(s).every((t) => t.kind === 'story')
    );
    if (!inStory.length) {
      const kinds = new Set(starts.flatMap((s) => span(s).map((t) => t.kind)));
      return {
        n,
        status: 'issue',
        issues: [
          kinds.has('out_of_scope')
            ? 'is only in an "Out of scope" section'
            : 'is only in a comment (an HTML comment or a "Comments" section), which is context, not a criterion',
        ],
      };
    }
    const oneBlock = inStory.filter((s) =>
      span(s).every((t) => t.block === sig[s].block)
    );
    if (!oneBlock.length)
      return {
        n,
        status: 'issue',
        issues: [
          'runs across two list items or paragraphs of the story; each is its own criterion',
        ],
      };
    // Found in the story: whole sentences, or cut short?
    const reading = oneBlock.map((s) => {
      const first = sigAt[s];
      const last = sigAt[s + words.length - 1];
      const e = edges(all, first, last);
      const end = e.end === 'soft' ? criterionStarts.has(e.next) : e.end;
      return { first, last, start: e.start, end };
    });
    if (!reading.some((r) => r.start && r.end)) {
      const r = reading[0];
      /** @type {string[]} */
      const issues = [];
      if (!r.end)
        issues.push(
          `is cut short (the story continues: "${context(all, r.last, 1)} …")`
        );
      if (!r.start)
        issues.push(
          `starts mid-sentence (the story has before it: "… ${context(all, r.first, -1)}")`
        );
      return { n, status: 'issue', issues };
    }
    const verbatim = flat.includes(criterion.replace(/\s+/g, ' ').trim());
    return { n, status: verbatim ? 'verbatim' : 'formatting', issues: [] };
  });
}

/**
 * The Gate 1 brief lines for the comparison.
 * @param {CriterionReport[]} reports
 * @param {string} storyPath
 * @returns {string[]}
 */
export function criteriaLines(reports, storyPath) {
  const flagged = reports.filter((r) => r.status === 'issue');
  if (flagged.length)
    return flagged.map(
      (r) => `ATTENTION: AC ${r.n} ${r.issues.join('; ')} (${storyPath})`
    );
  const formatting = reports
    .filter((r) => r.status === 'formatting')
    .map((r) => `AC ${r.n}`);
  return [
    `every acceptance criterion appears word for word in ${storyPath}` +
      (formatting.length
        ? ` (${formatting.join(', ')} ${formatting.length === 1 ? 'differs' : 'differ'} only in formatting: case, quotes, code or bold marks, labels, dashes, punctuation)`
        : ''),
  ];
}
