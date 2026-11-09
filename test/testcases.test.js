'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../src/core/testcases');

test('compare: trim mode ignores line-end spaces and final empty lines', () => {
  assert.ok(T.compare('1 2\n3\n', '1 2  \n3\n\n\n').pass);
  assert.ok(T.compare('a\r\nb', 'a\nb\n').pass);
  const d = T.compare('1\n2\n3\n', '1\n5\n3\n');
  assert.equal(d.pass, false);
  assert.equal(d.firstDiff, 1);
  assert.deepEqual(d.rows.find((r) => !r.same), { n: 2, expected: '2', actual: '5', same: false });
});

test('compare: exact and tokens modes, missing lines', () => {
  assert.equal(T.compare('a \n', 'a\n', 'exact').pass, false);
  assert.ok(T.compare('1 2\n3', '1\n2 3', 'tokens').pass);
  const d = T.compare('a\nb\nc', 'a\nb');
  assert.equal(d.firstDiff, 2);
  assert.equal(d.rows.find((r) => !r.same).actual, null);
});

test('save and load per file, with paths that have spaces and ü', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-run-tc-'));
  try {
    const src = path.join(root, 'my code', 'ü', 'a.cpp');
    const list = [{ id: 'x1', name: '', input: '1 2\n', expected: '3\n' }, { id: 'x2', name: 'big', input: 'z', expected: 'q' }];
    const f = T.save(root, src, list);
    assert.ok(f.startsWith(path.join(root, '.zovo-run', 'tests')));
    assert.deepEqual(T.load(root, src), list);
    assert.deepEqual(T.load(root, path.join(root, 'other.cpp')), []);
    fs.writeFileSync(f, '{broken');
    assert.deepEqual(T.load(root, src), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
