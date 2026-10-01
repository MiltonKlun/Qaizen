// The part of Newman's API that scripts/run-newman.js uses. Newman ships no
// type declarations, and @types/newman would be a new dependency (CLAUDE.md
// section 4), so the surface the pipeline relies on is declared here for the
// JSDoc type check (tsconfig.scripts.json).
declare module 'newman' {
  export interface RunOptions {
    collection: string;
    environment?: string;
    envVar?: { key: string; value: string }[];
    reporters?: string[];
    reporter?: Record<string, unknown>;
  }

  /** The run summary; read defensively, its shape is Newman's. */
  export type RunSummary = any;

  export function run(
    options: RunOptions,
    callback: (err: Error | null, summary: RunSummary) => void
  ): unknown;

  const newman: { run: typeof run };
  export default newman;
}
