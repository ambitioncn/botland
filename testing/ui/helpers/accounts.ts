import fs from 'fs';
import path from 'path';

export function loadAccounts() {
  const file = path.resolve(process.cwd(), '../accounts.local.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
