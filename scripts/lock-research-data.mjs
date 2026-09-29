// Lock the research datasets (GVA 2015 gun deaths, MKDB mass killings) for
// the repository: encrypt the plaintext layer files kept in the git-ignored
// data/restricted/ folder into data/research/*.enc, which is committed.
//
// The key is HEV_RESEARCH_DATA_KEY from pinokio/ENVIRONMENT (or the shell).
// With --generate and no key yet, a random key is created and saved into
// pinokio/ENVIRONMENT (owner-only file, git-ignored). The key is never printed:
// share it with collaborators privately; they paste it into POWER UP.
//
// Usage: node scripts/lock-research-data.mjs [--generate]
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  RESEARCH_DATASETS,
  decryptResearchBuffer,
  encryptResearchText,
} from '../server/providers/research.js';
import { readPinokioEnvironment } from './pinokio-environment.mjs';

const ENVIRONMENT_FILE = path.join('pinokio', 'ENVIRONMENT');
/** Dataset id -> plaintext layer file under data/restricted/. */
const PLAINTEXT = Object.freeze({
  'gva-2015': 'data/restricted/gva_2015/incidents.geojsonl',
  mkdb: 'data/restricted/mkdb/incidents.geojsonl',
});

let key = String(
  readPinokioEnvironment(ENVIRONMENT_FILE).HEV_RESEARCH_DATA_KEY ||
    process.env.HEV_RESEARCH_DATA_KEY ||
    '',
).trim();
if (!key) {
  if (!process.argv.includes('--generate')) {
    console.error(
      'No HEV_RESEARCH_DATA_KEY configured. Set one in POWER UP, or rerun with --generate.',
    );
    process.exit(1);
  }
  key = `hev_rk_${randomBytes(24).toString('base64url')}`;
  const existing = existsSync(ENVIRONMENT_FILE)
    ? readFileSync(ENVIRONMENT_FILE, 'utf8')
    : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(
    ENVIRONMENT_FILE,
    `${separator}# Research datasets key (locks GVA 2015 and MKDB). Share privately.\nHEV_RESEARCH_DATA_KEY=${key}\n`,
    { mode: 0o600 },
  );
  console.log(`Generated a research key and saved it in ${ENVIRONMENT_FILE}.`);
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
