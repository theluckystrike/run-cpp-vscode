'use strict';
// Saved test cases (input + expected output) per source file, and the compare with a line diff.
// Stored as JSON in <workspace>/.zovo-run/tests/<relative path>.json, so they can be committed with the code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEST_BYTES = 8 * 1024 * 1024;

function storeFile(root, source) {
  const rel = path.relative(root, source) || path.basename(source);
  const flat = rel.split(/[\\/]+/).filter((p) => p && p !== '..').join('__').normalize('NFC');
  const name = flat.length > 120 ? flat.slice(-100) + '-' + crypto.createHash('sha256').update(rel).digest('hex').slice(0, 8) : flat;
  return path.join(root, '.zovo-run', 'tests', name + '.json');
}

function load(root, source) {
  try {
    const d = JSON.parse(fs.readFileSync(storeFile(root, source), 'utf8'));
    return Array.isArray(d.tests) ? d.tests.filter((t) => t && typeof t.input === 'string' && typeof t.expected === 'string') : [];
  } catch (e) { return []; }
}

function save(root, source, tests) {
  const f = storeFile(root, source);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rel = path.relative(root, source).split(path.sep).join('/');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ file: rel, tests: tests.map(({ id, name, input, expected }) => ({ id, name, input, expected })) }, null, 1) + '\n');
  fs.renameSync(tmp, f);
  return f;
}

function newId() { return crypto.randomBytes(4).toString('hex'); }

/** Lines for comparing. mode: 'trim' (default: trailing spaces and trailing empty lines ignored), 'exact', 'tokens'. */
function normalize(text, mode) {
  const s = String(text).replace(/\r\n/g, '\n');
  if (mode === 'exact') return s.split('\n');
  if (mode === 'tokens') { const t = s.split(/\s+/).filter(Boolean); return t; }
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Compares actual output to expected. Returns { pass, firstDiff (0-based line or -1), rows } where rows is a short
 * side-by-side view around the first difference: [{ n, expected, actual, same }].
 */
function compare(expected, actual, mode = 'trim', context = 3, maxRows = 60) {
  const e = normalize(expected, mode);
  const a = normalize(actual, mode);
  let first = -1;
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) if (e[i] !== a[i]) { first = i; break; }
  if (first === -1) return { pass: true, firstDiff: -1, rows: [], expectedLines: e.length, actualLines: a.length };
  const from = Math.max(0, first - context);
  const to = Math.min(n, from + maxRows);
  const rows = [];
  for (let i = from; i < to; i++) rows.push({ n: i + 1, expected: e[i] === undefined ? null : e[i], actual: a[i] === undefined ? null : a[i], same: e[i] === a[i] });
  return { pass: false, firstDiff: first, rows, expectedLines: e.length, actualLines: a.length, unit: mode === 'tokens' ? 'token' : 'line' };
}

module.exports = { storeFile, load, save, newId, compare, normalize, MAX_TEST_BYTES };
