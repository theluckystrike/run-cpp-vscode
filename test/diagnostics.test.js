'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const D = require('../src/core/diagnostics');

const GCC = `hello.cpp: In function 'int main()':
hello.cpp:5:3: error: 'x' was not declared in this scope
    5 |   x = 1;
      |   ^
hello.cpp:7:10: warning: unused variable 'y' [-Wunused-variable]
util.h:3:6: note: declared here
hello.cpp:9: error: missing terminating " character
In file included from hello.cpp:1:
lib/util.h:12:1: fatal error: foo.h: No such file or directory`;

test('gcc output: errors, warnings, notes, no column, fatal', () => {
  const p = D.parse(GCC);
  assert.equal(p.length, 4);
  assert.deepEqual(p.map((x) => [x.file, x.line, x.col, x.severity]), [
    ['hello.cpp', 5, 3, 'error'], ['hello.cpp', 7, 10, 'warning'], ['hello.cpp', 9, 1, 'error'], ['lib/util.h', 12, 1, 'error']]);
  assert.equal(p[1].notes.length, 1);
  assert.equal(p[1].notes[0].file, 'util.h');
});

test('clang output and Windows drive letters', () => {
  const p = D.parse("C:\\Users\\Ana Lee\\my code\\a.cpp:6:8: error: expected ';' at end of declaration\n/tmp/x y/b.c:2:1: warning: type specifier missing [-Wimplicit-int]");
  assert.deepEqual(p.map((x) => [x.file, x.line, x.col]), [['C:\\Users\\Ana Lee\\my code\\a.cpp', 6, 8], ['/tmp/x y/b.c', 2, 1]]);
});

test('colors are stripped', () => {
  const p = D.parse('\x1b[01m\x1b[Ka.c:1:2:\x1b[m \x1b[01;31merror:\x1b[m bad');
  assert.equal(p.length, 1);
  assert.equal(p[0].message, 'bad');
});

test('linker errors and hints', () => {
  const t = "/usr/bin/ld: /tmp/cc1.o: in function `main':\nm.c:(.text+0x1c): undefined reference to `sqrt'\ncollect2: error: ld returned 1 exit status";
  const l = D.linkerErrors(t);
  assert.ok(l.length >= 2);
  assert.match(D.linkerHint(l), /-lm/);
  const mac = 'Undefined symbols for architecture arm64:\n  "_helper", referenced from:\n      _main in main-1.o\nld: symbol(s) not found for architecture arm64\nclang: error: linker command failed with exit code 1';
  assert.match(D.linkerHint(D.linkerErrors(mac)), /another file/);
});

test('resolvePath: real file, relative file, garbled non-ASCII path', () => {
  const cwd = '/w/大学/proj';
  const src = ['/w/大学/proj/你好.cpp', '/w/大学/proj/util.cpp'];
  const exists = (p) => src.includes(p);
  assert.equal(D.resolvePath('你好.cpp', cwd, src, exists), src[0]);
  assert.equal(D.resolvePath('/w/大学/proj/util.cpp', cwd, src, exists), src[1]);
  // the ANSI bytes of the path read as UTF-8: replacement characters, but the ASCII parts still match one file
  assert.equal(D.resolvePath('/w/\ufffd\ufffd/proj/util.cpp', cwd, src, exists), src[1]);
  assert.equal(D.resolvePath('\ufffd\ufffd.cpp', cwd, src, exists), src[0]);
  // one source: any garbled path is that file
  assert.equal(D.resolvePath('/x/\ufffd.cpp', cwd, [src[0]], () => false), src[0]);
  // a header that is not in the list but exists
  assert.equal(D.resolvePath('lib.h', cwd, src, (p) => p === path.join(cwd, 'lib.h')), path.join(cwd, 'lib.h'));
  assert.equal(D.resolvePath('nowhere.h', cwd, src, exists), null);
});
