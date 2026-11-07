// @ts-check
// Write a results file only when its results changed.
//
// An evaluation records when it ran. Rewriting a committed results file with
// nothing new but that date turns every re-run into a diff, so a file whose
// content is the same apart from the ignored fields is left as it is,
// recorded date included.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {any} doc
 * @param {string[]} ignore top-level fields left out of the comparison
 */
const comparable = (doc, ignore) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(doc ?? {}).filter(([k]) => !ignore.includes(k))
    )
  );

/**
 * The results already in `path`, when they equal `doc` apart from `ignore`.
 * @param {string} path
 * @param {any} doc
 * @param {string[]} ignore
 * @returns {any | null} the recorded document, or null when it differs or is absent
 */
export function sameRecorded(path, doc, ignore) {
  if (!existsSync(path)) return null;
  try {
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    return comparable(recorded, ignore) === comparable(doc, ignore)
      ? recorded
      : null;
  } catch {
    return null;
  }
}

/**
 * Write `doc` to `path` unless the file there already holds the same results.
 * @param {string} path
 * @param {any} doc
 * @param {{ ignore?: string[] }} [opts]
 * @returns {'written' | 'unchanged'}
 */
export function writeResultsIfChanged(
  path,
  doc,
  { ignore = ['generated_at'] } = {}
) {
  if (sameRecorded(path, doc, ignore)) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return 'written';
}
