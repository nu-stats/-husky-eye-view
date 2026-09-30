// Lock the research datasets (GVA 2015 gun deaths, MKDB mass killings) for
// the repository: encrypt the plaintext layer files kept in the git-ignored
// data/restricted/ folder into data/research/*.enc, which is committed.
//
// The key is never stored in the app: the map asks for it once per browser
// session (POWER UP -> RESEARCH DATASETS). This script reads it from the
// HEV_RESEARCH_DATA_KEY shell variable, or from a private key file outside the
// repository (--key-file, default ~/Documents/HuskyEyeView-backups/
// research-data-key.txt). With --generate and no key yet, a random key is
// created in that file. The key is never printed: share it privately.
//
// Usage: node scripts/lock-research-data.mjs [--key-file <path>] [--generate]
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESEARCH_DATASETS,
  decryptResearchBuffer,
  encryptResearchText,
} from '../server/providers/research.js';

const flag = process.argv.indexOf('--key-file');
const KEY_FILE =
  flag > 0 && process.argv[flag + 1]
    ? path.resolve(process.argv[flag + 1])
    : path.join(
        os.homedir(),
        'Documents',
        'HuskyEyeView-backups',
        'research-data-key.txt',
      );
/** Dataset id -> plaintext layer file under data/restricted/. */
const PLAINTEXT = Object.freeze({
  'gva-2015': 'data/restricted/gva_2015/incidents.geojsonl',
  mkdb: 'data/restricted/mkdb/incidents.geojsonl',
});

/** The key is the first non-comment line of the key file. */
function readKeyFile() {
  if (!existsSync(KEY_FILE)) return '';
  return (
    readFileSync(KEY_FILE, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) || ''
  );
}

let key = String(process.env.HEV_RESEARCH_DATA_KEY || readKeyFile()).trim();
if (!key) {
  if (!process.argv.includes('--generate')) {
    console.error(
      `No research key: set HEV_RESEARCH_DATA_KEY, put it in ${KEY_FILE}, or rerun with --generate.`,
    );
    process.exit(1);
  }
  key = `hev_rk_${randomBytes(24).toString('base64url')}`;
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(
    KEY_FILE,
    `# Husky Eye View research datasets key (GVA 2015, MKDB). Keep private.\n${key}\n`,
    { mode: 0o600 },
  );
  console.log(`Generated a research key in ${KEY_FILE}.`);
}

mkdirSync('data/research', { recursive: true });
for (const [id, file] of Object.entries(RESEARCH_DATASETS)) {
  const source = PLAINTEXT[id];
  if (!existsSync(source)) {
    console.error(`${id}: plaintext ${source} is missing; skipped.`);
    continue;
  }
  const text = readFileSync(source, 'utf8');
  const locked = encryptResearchText(text, key);
  if (decryptResearchBuffer(locked, key) !== text)
    throw new Error(`${id}: round trip failed`);
  const out = path.join('data', 'research', file);
  writeFileSync(out, locked);
  const lines = text.split('\n').filter((line) => line.trim()).length;
  console.log(`${out}: ${lines} features, ${locked.length} bytes`);
}
