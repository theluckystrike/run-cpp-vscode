'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core/compilers');

test('parseVersion', () => {
  assert.deepEqual(C.parseVersion('Apple clang version 17.0.0 (clang-1700.0.13.5)\nTarget: arm64'), { family: 'clang', label: 'Apple clang 17.0.0', version: '17.0.0' });
  assert.equal(C.parseVersion('g++ (Ubuntu 13.2.0-23ubuntu4) 13.2.0').label, 'gcc 13.2.0');
  assert.equal(C.parseVersion('gcc.exe (Rev2, Built by MSYS2 project) 14.2.0').label, 'gcc 14.2.0');
  assert.equal(C.parseVersion('Ubuntu clang version 18.1.3 (1ubuntu1)').label, 'clang 18.1.3');
  assert.equal(C.parseVersion('clang version 19.1.0\nTarget: x86_64-w64-windows-gnu').family, 'clang');
});

test('Windows: finds MSYS2 and WinLibs folders when PATH has no compiler', () => {
  const files = new Set(['C:\\msys64\\ucrt64\\bin\\g++.exe', 'C:\\msys64\\ucrt64\\bin\\gcc.exe', 'C:\\Program Files\\LLVM\\bin\\clang++.exe']);
  const c = C.candidates('cpp', { platform: 'win32', env: { PATH: 'C:\\Windows\\system32', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files' }, isFile: (p) => files.has(p), listDir: () => [] });
  assert.deepEqual(c.map((x) => x.path), ['C:\\msys64\\ucrt64\\bin\\g++.exe', 'C:\\Program Files\\LLVM\\bin\\clang++.exe']);
  assert.equal(c[0].source, 'folder');
});

test('PATH first, prefer clang, versioned names', () => {
  const files = new Set(['/usr/bin/g++', '/usr/bin/clang++', '/opt/homebrew/bin/g++-14', '/opt/homebrew/bin/g++-13']);
  const env = { PATH: '/opt/homebrew/bin:/usr/bin' };
  const list = (d) => (d === '/opt/homebrew/bin' ? ['g++-14', 'g++-13', 'gcc-14'] : []);
  const a = C.candidates('cpp', { platform: 'darwin', env, isFile: (p) => files.has(p), listDir: list });
  assert.deepEqual(a.map((x) => x.name), ['g++', 'clang++', 'g++-14', 'g++-13']);
  const b = C.candidates('cpp', { platform: 'darwin', env, isFile: (p) => files.has(p), listDir: list, prefer: 'clang' });
  assert.equal(b[0].name, 'clang++');
});

test('find: none found gives a reason and the list of tries; a broken setting is reported', async () => {
  const r = await C.find('c', { platform: 'linux', env: { PATH: '/nope' }, isFile: () => false, listDir: () => [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /No C compiler/);
  const s = await C.find('cpp', { configured: '/x/g++', probeFn: async () => ({ ok: false, error: 'not found' }) });
  assert.equal(s.ok, false);
  assert.match(s.reason, /settings/);
});

test('find: macOS without Command Line Tools skips the /usr/bin shims', async () => {
  const files = new Set(['/usr/bin/gcc', '/usr/bin/clang']);
  let probed = [];
  const r = await C.find('c', { platform: 'darwin', env: { PATH: '/usr/bin' }, isFile: (p) => files.has(p), listDir: () => [], probeFn: async (p) => { probed.push(p); return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.needsXcode, true);
  assert.deepEqual(probed, []);
});

test('find: real compilers on this machine (skipped when none)', async (t) => {
  const r = await C.find('cpp');
  if (!r.ok) return t.skip('no C++ compiler here');
  assert.ok(r.path && r.label);
});
