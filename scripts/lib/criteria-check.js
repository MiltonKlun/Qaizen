// @ts-check
// Gate 1: is each acceptance criterion the story's own text?
//
// The Analyst copies criteria verbatim (agents/analyst.md). This compares each
// one with story.md token by token. Only formatting may differ: whitespace and
// line wrapping, case, quote marks, code and emphasis marks, list markers and
// sentence punctuation (. , : ; ! ? and brackets). Everything else counts,
// including comparison signs (> < =), numbers with their decimal point, and
// words. Where it is found matters too: a criterion found only under an "Out
// of scope" heading, or only in a comment (an HTML comment or a "Comments"
// section), is not a criterion of the story.
//
// For a criterion it cannot find, the closest passage of the story is named
// and the difference classified: a changed comparison, a changed number, an
// added or dropped negation, other rewording, or absent. A criterion that is
// found but starts or stops mid-sentence is reported as cut short.
//
// Pure: no I/O. It informs the reviewer and never decides Gate 1.

/**
 * @typedef {{ text: string, sig: boolean, stop: boolean,
 *   kind: SectionKind, block: number }} Token
 * @typedef {'story' | 'out_of_scope' | 'comment'} SectionKind
 * @typedef {{ n: number, status: 'verbatim' | 'formatting' | 'issue',
 *   issues: string[] }} CriterionReport
 */

// Characters that are formatting, not wording.
const FORMATTING = new Set([...`'"\`‘’“”«»´*_~\\.,:;!?()[]{}—–…`]);
// Punctuation that ends a sentence or a clause a criterion may end at.
const STOPS = new Set([...'.;:!?']);

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

const OUT_OF_SCOPE =
  /\b(out[- ]of[- ]scope|not in scope|non[- ]goals?|fuera de(l)? alcance)\b/i;
const COMMENTS = /\b(comments?|comentarios?|discussion)\b/i;

const TOKEN =
  /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_]|['’](?=[\p{L}\p{N}])|[.,](?=\p{N}))*|\S/gu;

/** @param {string} t */
const isNumber = (t) => /^\p{N}+(?:[.,]\p{N}+)*$/u.test(t);
/** @param {string} t */
const isNegation = (t) => NEGATIONS.has(t) || /n['’]t$/.test(t);
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
  return [...text.matchAll(TOKEN)].map(([raw]) => {
    const text = raw.toLowerCase();
    return {
      text,
      sig: !FORMATTING.has(raw),
      stop: STOPS.has(raw),
      kind,
      block,
    };
  });
}

/**
 * The story as tokens, each with the kind of section it is in and its block
 * (a paragraph, list item or heading).
 * @param {string} story
 * @returns {Token[]}
 */
export function storyTokens(story) {
  /** @type {Token[]} */
  const out = [];
  /** @type {{ level: number, kind: SectionKind }[]} */
  const sections = [];
  let block = 0;
  let inComment = false;
  const kindNow = () =>
    /** @type {SectionKind} */ (sections.at(-1)?.kind ?? 'story');
  for (const rawLine of story.split(/\r?\n/)) {
    const heading = inComment ? null : /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      while (sections.length && sections[sections.length - 1].level >= level)
        sections.pop();
      const parent = kindNow();
      /** @type {SectionKind} */
      const kind = OUT_OF_SCOPE.test(heading[2])
        ? 'out_of_scope'
        : COMMENTS.test(heading[2])
          ? 'comment'
          : parent;
      block += 1;
      out.push(...tokensOf(heading[2], parent, block));
      sections.push({ level, kind });
      block += 1;
      continue;
    }
    if (!inComment && rawLine.trim() === '') {
      block += 1;
      continue;
    }
    let line = rawLine;
    if (!inComment) {
      // A list item starts a block; its marker and a blockquote are formatting.
      const marker =
        /^\s*(?:>\s?)*(?:([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line);
      if (marker?.[1]) block += 1;
      line = line.slice(marker?.[0].length ?? 0);
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
        block += 1;
        rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        const part = start === -1 ? rest : rest.slice(0, start);
        out.push(...tokensOf(part, kindNow(), block));
        if (start === -1) break;
        inComment = true;
        block += 1;
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
 * Whether an occurrence starts and ends where a sentence or clause does: at
 * the edge of its block or next to a stop (. ; : ! ?).
 * @param {Token[]} all every story token
 * @param {number} first index into `all` of the first matched token
 * @param {number} last index into `all` of the last matched token
 * @returns {{ start: boolean, end: boolean }}
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
  let end = true;
  for (
    let i = last + 1;
    i < all.length && all[i].block === all[last].block;
    i++
  ) {
    if (all[i].stop) break;
    if (all[i].sig) {
      end = false;
      break;
    }
  }
  return { start, end };
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
    if (all[i].stop) break;
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
 * Why a criterion that is not in the story differs from its closest passage.
 * @param {string[]} words the criterion's significant tokens
 * @param {Token[]} sig the story's significant tokens
 * @returns {string[]}
 */
function diagnose(words, sig) {
  /** @type {Map<number, string[]>} */
  const blocks = new Map();
  for (const t of sig) {
    if (t.kind !== 'story') continue;
    const b = blocks.get(t.block) ?? [];
    b.push(t.text);
    blocks.set(t.block, b);
  }
  let best = { score: 0, region: /** @type {string[]} */ ([]) };
  for (const tokens of blocks.values()) {
    const pairs = lcs(words, tokens);
    if (!pairs.length) continue;
    const score = pairs.length / words.length;
    if (score > best.score) {
      // The matched stretch, widened by the criterion's unmatched words at
      // either end, so a changed first or last word is compared too.
      const lead = pairs[0][0];
      const trail = words.length - 1 - pairs[pairs.length - 1][0];
      const region = tokens.slice(
        Math.max(0, pairs[0][1] - lead),
        pairs[pairs.length - 1][1] + 1 + trail
      );
      best = { score, region };
    }
  }
  if (best.score < 0.5) return ['is not in the story'];
  /** @type {string[]} */
  const issues = [];
  const cmp = classDiff(words, best.region, isComparison);
  if (cmp.added.length || cmp.dropped.length)
    issues.push(
      `changes a comparison (story: ${quote(cmp.dropped) || 'none'}; criterion: ${quote(cmp.added) || 'none'})`
    );
  const num = classDiff(words, best.region, isNumber);
  if (num.added.length || num.dropped.length)
    issues.push(
      `changes a number (story: ${quote(num.dropped) || 'none'}; criterion: ${quote(num.added) || 'none'})`
    );
  const neg = classDiff(words, best.region, isNegation);
  if (neg.added.length) issues.push(`adds a negation (${quote(neg.added)})`);
  if (neg.dropped.length)
    issues.push(`drops a negation (${quote(neg.dropped)})`);
  if (!issues.length) {
    const near = best.region.slice(0, 12).join(' ');
    issues.push(
      `is reworded (closest in the story: "${near}${best.region.length > 12 ? ' …' : ''}")`
    );
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
  return criteria.map((criterion, i) => {
    const n = i + 1;
    const words = tokensOf(criterion, 'story', 0)
      .filter((t) => t.sig)
      .map((t) => t.text);
    if (!words.length) return { n, status: 'issue', issues: ['is empty'] };
    const starts = occurrences(sig, words);
    if (!starts.length)
      return { n, status: 'issue', issues: diagnose(words, sig) };
    const inStory = starts.filter((s) =>
      sig.slice(s, s + words.length).every((t) => t.kind === 'story')
    );
    if (!inStory.length) {
      const kinds = new Set(
        starts.flatMap((s) => sig.slice(s, s + words.length).map((t) => t.kind))
      );
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
    // Found in the story: whole sentences, or cut short?
    const whole = inStory.find((s) => {
      const e = edges(all, sigAt[s], sigAt[s + words.length - 1]);
      return e.start && e.end;
    });
    if (whole === undefined) {
      const s = inStory[0];
      const first = sigAt[s];
      const last = sigAt[s + words.length - 1];
      const e = edges(all, first, last);
      /** @type {string[]} */
      const issues = [];
      if (!e.end)
        issues.push(
          `is cut short (the story continues: "${context(all, last, 1)} …")`
        );
      if (!e.start)
        issues.push(
          `starts mid-sentence (the story has before it: "… ${context(all, first, -1)}")`
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
        ? ` (${formatting.join(', ')} ${formatting.length === 1 ? 'differs' : 'differ'} only in formatting: case, quotes, code or bold marks, punctuation)`
        : ''),
  ];
}
