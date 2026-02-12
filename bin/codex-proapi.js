#!/usr/bin/env node

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const isGlobal = pkgRoot.includes('node_modules');

if (isGlobal) {
  const dataDir = join(homedir(), '.codex-proapi');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  process.env.CODEX_ACCOUNTS_FILE = join(dataDir, 'accounts.json');
}

import('../src/index.js');
