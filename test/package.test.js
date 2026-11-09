'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('engine floor for Cursor and Windsurf', () => {
  assert.equal(pk.engines.vscode, '^1.90.0');
  assert.equal(pk.devDependencies['@types/vscode'], '~1.90.0');
});

test('name keeps the main phrases together', () => {
  assert.match(pk.displayName, /^Run C\+\+ and C Code/);
  assert.match(pk.displayName, /CPP Runner/);
  assert.doesNotMatch(pk.displayName, /C\/C\+\+ Runner|Compile and Run|C\/C\+\+ Compile Run/i);
  assert.ok(pk.keywords.includes('compile and run') && pk.keywords.includes('run c++'));
});

test('keybinding does not use the keys of VS Code defaults or the two most installed runners', () => {
  const taken = ['f5', 'f6', 'f7', 'f8', 'ctrl+6', 'cmd+6', 'ctrl+alt+r', 'ctrl+alt+b', 'ctrl+alt+d', 'ctrl+alt+a', 'ctrl+k b', 'ctrl+alt+n', 'ctrl+f5', 'ctrl+shift+b'];
  for (const k of pk.contributes.keybindings) {
    assert.ok(!taken.includes(k.key) && !taken.includes(k.mac), k.key);
    assert.match(k.when, /resourceExtname/);
  }
});

test('every contributed command is registered, and every registered command is contributed', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src', 'support.js'), 'utf8');
  const contributed = pk.contributes.commands.map((c) => c.command);
  const pro = ['zovoRun.unlockWithSponsors', 'zovoRun.getPro', 'zovoRun.enterLicenseKey', 'zovoRun.removeLicense'];
  for (const c of contributed) if (!pro.includes(c)) assert.ok(src.includes(`'${c}'`) || /supportDeveloper|moreViewers/.test(c), c);
  for (const m of src.matchAll(/reg\('([\w.]+)'/g)) assert.ok(contributed.includes(m[1]), m[1]);
});

test('Pro is switched off and no network module is used outside the license rail', () => {
  assert.match(fs.readFileSync(path.join(root, 'src', 'pro.js'), 'utf8'), /const PRO_ENABLED = false;/);
  for (const f of ['extension.js', 'launch.js', 'html.js', 'core/build.js', 'core/run.js', 'core/compilers.js', 'core/proc.js', 'core/testcases.js', 'core/flags.js', 'core/diagnostics.js']) {
    const s = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.doesNotMatch(s, /require\(['"](https?|net|dgram|tls|undici)['"]\)|fetch\(/, f);
  }
});

test('no shell: child processes get argument arrays', () => {
  for (const f of ['extension.js', 'launch.js', 'core/build.js', 'core/run.js', 'core/compilers.js', 'core/proc.js']) {
    const s = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.doesNotMatch(s, /(?<![.\w])exec\(|child_process'\)\.exec\b|shell:\s*true|execSync\(/, f);
  }
});

test('README first screen says free, no sign-in, works offline and shows a real screenshot', () => {
  const r = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n').slice(0, 14).join('\n');
  assert.match(r, /free, no sign-in, works offline/i);
  assert.match(r, /!\[[^\]]+\]\(images\/[\w-]+\.png\)/);
});

test('rating ask: a failed build and a crashed run count as failures (no ask in that session or for 24 h)', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
  const build = src.slice(src.indexOf('async function build('), src.indexOf('// ---------- run in the terminal'));
  assert.match(build, /if \(!res\.ok\) \{[\s\S]*rating\.failure\(\);[\s\S]*return \{ ok: false/);
  const term = src.slice(src.indexOf('async function runInTerminal('), src.indexOf('// ---------- commands'));
  assert.match(term, /else if \(st && st\.signal && !st\.stopped\) rating\.failure\(\)/);
  assert.match(src, /else if \(r\.signal && !r\.stopped && !r\.timedOut\) rating\.failure\(\)/);
});
