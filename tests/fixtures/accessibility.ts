// Accessibility checks for Playwright tests, with axe (@axe-core/playwright).
//
// A test case whose acceptance criteria or risks concern accessibility is
// designed as a [Checklist] case (skills/designing-cases): the checklist is
// WCAG 2.1 at levels A and AA. Its generated test opens the page in the state
// the case describes and calls expectAccessible; a violation fails the test
// with the rule, its impact, the elements and the help link.
//
// Narrowing the check is allowed, never hiding a failure: `include` scopes it
// to the part of the page the story changed, `exclude` leaves out something
// the story does not own (a third-party widget). `disableRules` turns a rule
// off and is reviewed at Gate 4 like a skipped test: say why in a comment.

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.1, levels A and AA: the usual legal and contractual bar. */
export const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface AccessibilityOptions {
  /** A selector: check only this part of the page. */
  include?: string;
  /** Selectors to leave out (content the story does not own). */
  exclude?: string[];
  /** Rule ids to turn off; reviewed at Gate 4, with the reason in a comment. */
  disableRules?: string[];
  /** Axe tags to check against; WCAG 2.1 A and AA by default. */
  tags?: string[];
}

type Violation = Awaited<
  ReturnType<AxeBuilder['analyze']>
>['violations'][number];

/** The violations axe finds on the page as it is now. */
export async function accessibilityViolations(
  page: Page,
  options: AccessibilityOptions = {}
): Promise<Violation[]> {
  let builder = new AxeBuilder({ page }).withTags(options.tags ?? WCAG_AA);
  if (options.include) builder = builder.include(options.include);
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }
  if (options.disableRules?.length) {
    builder = builder.disableRules(options.disableRules);
  }
  return (await builder.analyze()).violations;
}

/** One line per violation: rule, impact, what it means, where, and help. */
export function describeViolations(violations: Violation[]): string {
  return violations
    .map((v) => {
      const where = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join('; ');
      const more = v.nodes.length > 3 ? ` (+${v.nodes.length - 3} more)` : '';
      return `${v.id} (${v.impact ?? 'unknown impact'}): ${v.help}. ${v.nodes.length} element(s): ${where}${more}. ${v.helpUrl}`;
    })
    .join('\n');
}

/** Fail the test when the page breaks WCAG 2.1 A or AA, listing every rule. */
export async function expectAccessible(
  page: Page,
  options: AccessibilityOptions = {}
): Promise<void> {
  const violations = await accessibilityViolations(page, options);
  expect(
    violations,
    `Accessibility violations (WCAG 2.1 A/AA):\n${describeViolations(violations)}`
  ).toEqual([]);
}
