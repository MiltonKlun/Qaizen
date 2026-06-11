// Red-taxonomy domains as data (IMPROVEMENT-PLAN Phase 4, IP-4.1).
//
// The Healer's Red severity (docs/healer-guardrails.md §4) names the kinds of
// behavior that are too consequential to ever auto-fix: business-logic
// assertions, permission/role, security, pricing, payment, compliance, data
// integrity. The lite-track floor (scripts/track-floor.js) reuses the SAME
// taxonomy for a different question — "may this story run with reduced
// ceremony?" — so a story touching any of these domains can never be `lite`.
//
// This module is a NEW CONSUMER of the taxonomy, not a refactor of the Healer.
// docs/healer-guardrails.md §4 remains the canonical narrative; this file is
// the machine-readable mirror of it. If the Healer's Red list changes, update
// both (and the doc is the source of truth).
//
// Pure data + one pure helper. No I/O, no side effects.

/**
 * Each domain: a stable `id`, a human `label`, and `patterns` — lowercase
 * keyword regexes matched against free text (story title/description, ACs,
 * risk descriptions). Patterns are deliberately conservative: a match raises
 * the track floor to `standard`, which only ADDS ceremony, so a false positive
 * is safe (the story still runs, just not in lite). A false negative is the
 * risk to avoid, so the keywords lean inclusive within each domain.
 */
export const RED_DOMAINS = [
  {
    id: 'business_logic',
    label: 'Business-logic assertion (a computed business outcome)',
    patterns: [
      /\bcalculat/,
      /\btotal\b/,
      /\bbalance\b/,
      /\bdiscount/,
      /\btax(es|able|ation)?\b/,
      /\binterest\b/,
      /\bquota\b/,
      /\beligib/,
    ],
  },
  {
    id: 'permission_role',
    label: 'Permission / role behavior (who may do what)',
    patterns: [
      /\bpermission/,
      /\brole(s|-based)?\b/,
      /\baccess control\b/,
      /\bauthoriz/,
      /\brbac\b/,
      /\bprivilege/,
      /\badmin(istrator)?\b/,
      /\bforbidden\b/,
      /\bunauthor/,
    ],
  },
  {
    id: 'security',
    label: 'Security validation (input safety, tokens, auth)',
    patterns: [
      /\bsecurity\b/,
      /\bxss\b/,
      /\bcsrf\b/,
      /\bsql injection\b/,
      /\bsanitiz/,
      /\bauthentic/,
      /\bcredential/,
      /\bpassword\b/,
      /\bsession\b/,
      /\btoken\b/,
      /\bencrypt/,
    ],
  },
  {
    id: 'pricing',
    label: 'Pricing calculation (anything on a customer invoice)',
    patterns: [
      /\bpric(e|ing)\b/,
      /\binvoice/,
      /\bcheckout\b/,
      /\bbilling\b/,
      /\bsubscription\b/,
      /\bcurrency\b/,
      /\brefund/,
    ],
  },
  {
    id: 'payment',
    label: 'Payment flow (anywhere money moves)',
    patterns: [
      /\bpayment/,
      /\bpay\b/,
      /\bcard\b/,
      /\bcredit card\b/,
      /\bcharge(d|s)?\b/,
      /\bpayout/,
      /\btransaction/,
      /\bwallet\b/,
    ],
  },
  {
    id: 'compliance',
    label: 'Compliance behavior (audit, retention, consent)',
    patterns: [
      /\bcompliance\b/,
      /\baudit\b/,
      /\bretention\b/,
      /\bconsent\b/,
      /\bgdpr\b/,
      /\bhipaa\b/,
      /\bpci\b/,
      /\bregulat/,
    ],
  },
  {
    id: 'data_integrity',
    label: 'Data integrity (records written correctly / not lost)',
    patterns: [
      /\bdata integrity\b/,
      /\bpersist/,
      /\bcorrupt/,
      /\bidempoten/,
      /\bdata loss\b/,
      /\boverwrit/,
      /\bmigration\b/,
    ],
  },
];

/**
 * Scan free text against the Red taxonomy.
 * @param {string} text  Any free text (story, AC, risk description).
 * @returns {string[]}   The ids of every Red domain whose patterns matched.
 */
export function redDomainsInText(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const d of RED_DOMAINS) {
    if (d.patterns.some((re) => re.test(lower))) hits.push(d.id);
  }
  return hits;
}

/** Human label for a domain id (for reasons/messages). */
export function redDomainLabel(id) {
  return RED_DOMAINS.find((d) => d.id === id)?.label || id;
}
