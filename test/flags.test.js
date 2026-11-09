'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/core/flags');

test('language by extension', () => {
  assert.equal(F.languageOf('a.c'), 'c');
  for (const f of ['a.cpp', 'a.cc', 'a.cxx', 'a.c++', 'A.CPP', 'x.C']) assert.equal(F.languageOf(f), 'cpp', f);
  for (const f of ['a.h', 'a.hpp', 'a.txt', 'Makefile']) assert.equal(F.languageOf(f), '');
  assert.ok(F.isHeader('x.hpp'));
});

test('splitArgs keeps quoted spaces together and runs no shell expansion', () => {
  assert.deepEqual(F.splitArgs('"Hello World" 2'), ['Hello World', '2']);
  assert.deepEqual(F.splitArgs("'a b' \"c\\\"d\" e\\ f"), ['a b', 'c"d', 'e f']);
  assert.deepEqual(F.splitArgs('$HOME `ls` *.cpp ; rm -rf x'), ['$HOME', '`ls`', '*.cpp', ';', 'rm', '-rf', 'x']);
  assert.deepEqual(F.splitArgs('C:\\Users\\me\\x.txt ""'), ['C:\\Users\\me\\x.txt', '']);
  assert.deepEqual(F.splitArgs('   '), []);
});

test('run: and args: comment lines', () => {
  const d = F.readDirectives('// run: -O2 -lm\n/* args: "Hello World" 3 */\n#include <stdio.h>\n// run: -DX=1\n');
  assert.deepEqual(d.flags, ['-O2', '-lm', '-DX=1']);
  assert.deepEqual(d.args, ['Hello World', '3']);
  assert.equal(d.lines.run, 0);
  // only the first 40 lines are read
  const late = '\n'.repeat(45) + '// run: -O3\n';
  assert.deepEqual(F.readDirectives(late).flags, []);
  // prose that merely mentions "run" is not a directive
  assert.deepEqual(F.readDirectives('// we run: fast\n// Run this file\n').flags, []);
});

test('extra sources in run: and the linker map file', () => {
  assert.deepEqual(F.splitSources(['-O2', 'util.c', 'lib/x.cpp', '-lm', 'foo.o']), { flags: ['-O2', '-lm'], sources: ['util.c', 'lib/x.cpp', 'foo.o'] });
  assert.equal(F.linkerMapFile(['-O2', '-Wl,-Map=app.map']), 'app.map');
  assert.equal(F.linkerMapFile(['-Wl,-Map,out/app.map,--cref']), 'out/app.map');
  assert.equal(F.linkerMapFile(['-Wl,-map,app.map']), 'app.map');
  assert.equal(F.linkerMapFile(['-O2']), '');
});

test('standard fallback for old compilers', () => {
  assert.ok(F.stdUnsupported("g++: error: unrecognized command-line option '-std=c++20'; did you mean '-std=c++2a'?"));
  assert.ok(F.stdUnsupported("error: invalid value 'c++23' in '-std=c++23'"));
  assert.ok(!F.stdUnsupported('a.cpp:1:1: error: expected'));
  assert.deepEqual(F.lowerStd(['-Wall', '-std=c++20', '-g']), { flags: ['-Wall', '-std=c++2a', '-g'], from: 'c++20', to: 'c++2a' });
  assert.equal(F.lowerStd(['-std=c++11']), null);
  assert.equal(F.lowerStd(['-O2']), null);
});

test('display quoting', () => {
  assert.equal(F.quoteForDisplay('a.cpp'), 'a.cpp');
  assert.equal(F.quoteForDisplay('my code/ü.cpp'), '"my code/ü.cpp"');
});
