#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');

const copies = [
  ['scripts/stay-alive', 'scripts/stay-alive'],
  ['docs/stay-alive', 'docs/stay-alive'],
  ['skills/stay-alive', 'skills/stay-alive']
];

for (const [sourceRel, targetRel] of copies) {
  const source = path.join(workspaceRoot, sourceRel);
  const target = path.join(packageRoot, targetRel);
  if (!existsSync(source)) {
    throw new Error(`Missing source path: ${source}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (item) => !item.includes(`${path.sep}.clawhub${path.sep}`)
  });
}

const clawhubRoot = path.join(packageRoot, 'clawhub', 'stay-alive');
rmSync(clawhubRoot, { recursive: true, force: true });
mkdirSync(clawhubRoot, { recursive: true });
cpSync(path.join(workspaceRoot, 'skills', 'stay-alive'), clawhubRoot, { recursive: true });
cpSync(path.join(workspaceRoot, 'docs', 'stay-alive'), path.join(clawhubRoot, 'references', 'docs'), { recursive: true });
cpSync(path.join(workspaceRoot, 'scripts', 'stay-alive', 'README.md'), path.join(clawhubRoot, 'references', 'scripts-README.md'));
cpSync(path.join(workspaceRoot, 'docs', 'stay-alive', 'CODEMAP.md'), path.join(clawhubRoot, 'references', 'CODEMAP.md'));
cpSync(path.join(workspaceRoot, 'docs', 'stay-alive', 'DEPLOYMENT.md'), path.join(clawhubRoot, 'references', 'DEPLOYMENT.md'));

console.log(`Prepared Stay-Alive package at ${packageRoot}`);
