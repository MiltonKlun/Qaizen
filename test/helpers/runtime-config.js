// The config files the scripts read at load time, for tests that copy
// scripts/ into a throwaway project. Only these are copied: other config
// files (gate-checks.json, ...) change behavior, and a test that wants one
// writes it itself.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOADED_AT_IMPORT = ['red-domains.json'];

/**
 * @param {string} dir the throwaway project
 * @param {string} [repo] the repository to copy from
 */
export function copyRuntimeConfig(dir, repo = process.cwd()) {
  mkdirSync(join(dir, 'config'), { recursive: true });
  for (const f of LOADED_AT_IMPORT)
    copyFileSync(join(repo, 'config', f), join(dir, 'config', f));
}
