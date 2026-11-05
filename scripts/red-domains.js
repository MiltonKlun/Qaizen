// @ts-check
// Red-taxonomy domains as data.
//
// The Healer's Red severity (docs/healer-guardrails.md §4) names the kinds of
// behavior that are too consequential to ever auto-fix: business-logic
// assertions, permission/role, security, pricing, payment, compliance, data
// integrity. Three checks ask whether a text touches one of them: the failure
// classifier (scripts/lib/classify-failure.js: never Green), the lite-track
// floor (scripts/track-floor.js: never lite) and the downgrade confirmation
// (scripts/lib/analysis-overrides.js: a person confirms).
//
// The keywords live in config/red-domains.json, per locale (English and
// Spanish today). docs/healer-guardrails.md §4 remains the canonical
// narrative; the config is its machine-readable mirror.
//
// Text is split into words before matching, so identifiers count:
// `submitPayment`, `pay-now` and `order_total` read as "submit payment",
// "pay now" and "order total". Accents are removed and case is folded.

import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../config/red-domains.json', import.meta.url);

/**
 * @typedef {{ words: string[], prefix: boolean, text: string }} Keyword
 * @typedef {{ id: string, label: string, keywords: Keyword[] }} RedDomain
 */

/**
 * Lowercase, accent-free words of a text. camelCase, PascalCase, kebab-case,
 * snake_case and punctuation all separate words; letters and digits that
 * touch stay together ("2fa").
 * @param {unknown} text
 * @returns {string[]}
 */
export function words(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Read and check the keyword config. A broken config is an error at load, never
 * a silently empty taxonomy.
 * @returns {RedDomain[]}
 */
function loadDomains() {
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  } catch (e) {
    throw new Error(
      `config/red-domains.json could not be read: ${/** @type {Error} */ (e).message}`
    );
  }
  if (!Array.isArray(raw?.domains) || raw.domains.length === 0)
    throw new Error(
      'config/red-domains.json: "domains" must be a non-empty list'
    );
  return raw.domains.map((/** @type {any} */ d, /** @type {number} */ i) => {
    const where = `config/red-domains.json domains[${i}]`;
    if (typeof d?.id !== 'string' || typeof d.label !== 'string')
      throw new Error(`${where}: "id" and "label" must be strings`);
    if (!d.keywords || typeof d.keywords !== 'object')
      throw new Error(`${where}: "keywords" must map locales to lists`);
    /** @type {Keyword[]} */
    const keywords = [];
    for (const [locale, list] of Object.entries(d.keywords)) {
      if (!Array.isArray(list) || list.length === 0)
        throw new Error(`${where}.keywords.${locale} must be a non-empty list`);
      for (const k of list) {
        const prefix = typeof k === 'string' && k.endsWith('*');
        const w = words(prefix ? k.slice(0, -1) : k);
        if (typeof k !== 'string' || w.length === 0)
          throw new Error(
            `${where}.keywords.${locale}: ${JSON.stringify(k)} is not a keyword`
          );
        keywords.push({ words: w, prefix, text: k });
      }
    }
    return { id: d.id, label: d.label, keywords };
  });
}

/** The Red domains and their keywords, from config/red-domains.json. */
export const RED_DOMAINS = loadDomains();

/**
 * Does the keyword occur in the words, as consecutive words?
 * @param {Keyword} k
 * @param {string[]} w
 */
function occurs(k, w) {
  const n = k.words.length;
  for (let i = 0; i + n <= w.length; i++) {
    let hit = true;
    for (let j = 0; j < n && hit; j++) {
      const last = j === n - 1;
      hit =
        last && k.prefix
          ? w[i + j].startsWith(k.words[j])
          : w[i + j] === k.words[j];
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Scan free text against the Red taxonomy.
 * @param {string} text  Any free text (story, AC, risk description, a test
 *   title or a locator).
 * @returns {string[]}   The ids of every Red domain with a keyword in it.
 */
export function redDomainsInText(text) {
  if (!text || typeof text !== 'string') return [];
  const w = words(text);
  if (w.length === 0) return [];
  return RED_DOMAINS.filter((d) => d.keywords.some((k) => occurs(k, w))).map(
    (d) => d.id
  );
}

/**
 * Human label for a domain id (for reasons/messages).
 * @param {string} id
 */
export function redDomainLabel(id) {
  return RED_DOMAINS.find((d) => d.id === id)?.label || id;
}
