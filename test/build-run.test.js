'use strict';
// Real builds and runs with the compilers on this machine (skipped when there are none).
// Fixtures go to ~/run-cpp-work/unit (not the temp folder) and are deleted at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const B = require('../src/core/build');
const R = require('../src/core/run');
const D = require('../src/core/diagnostics');
const C = require('../src/core/compilers');

const WORK = process.env.RUN_CPP_TEST_WORK || path.join(os.homedir(), 'run-cpp-work', 'unit');
let cc;
const put = (rel, text) => { const f = path.join(WORK, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

test.before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const a = await C.find('c'); const b = await C.find('cpp');
  if (a.ok && b.ok) cc = { c: a.path, cpp: b.path };
});
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

async function buildRun(file, { folder = false, input = '', ...o } = {}) {
  const p = B.plan({ main: file, folder, text: fs.readFileSync(file, 'utf8'), compilers: cc, outDir: path.join(WORK, 'out dir', 'bin'), ...o });
  const b = await B.compile(p);
  if (!b.ok) return { plan: p, build: b };
  const r = await R.runProgram(p.binary, { args: p.args, cwd: p.cwd, input, timeLimitMs: 20000 }).promise;
  return { plan: p, build: b, run: r };
}

test('hello in C and C++', async (t) => {
  if (!cc) return t.skip('no compiler');
  const c = await buildRun(put('hello.c', '#include <stdio.h>\nint main(void){ puts("hello c"); return 0; }\n'));
  assert.equal(c.run.stdout, 'hello c\n');
  assert.ok(c.run.exit.ok);
  const x = await buildRun(put('hello.cpp', '#include <iostream>\nint main(){ std::cout << "hello c++" << std::endl; }\n'));
  assert.equal(x.run.stdout, 'hello c++\n');
  // second build is skipped (up to date)
  const again = await B.compile(x.plan);
  assert.equal(again.skipped, true);
});

test('reads 3 lines of input; C++20 compiles with the default flags', async (t) => {
  if (!cc) return t.skip('no compiler');
  const r = await buildRun(put('read3.cpp', '#include <iostream>\n#include <string>\n#include <ranges>\n#include <vector>\nint main(){ std::vector<std::string> v(3); for (auto& s : v) std::getline(std::cin, s); for (auto& s : v | std::views::reverse) std::cout << s << "\\n"; }\n'), { input: 'a\nb\nc\n' });
  assert.equal(r.run.stdout, 'c\nb\na\n');
});

test('a file name that starts with "-" is a file, not a compiler option (single and folder builds; Problems path maps back)', async (t) => {
  if (!cc) return t.skip('no compiler');
  const src = '#include <stdio.h>\nint main(void){ puts("dash ok"); return 0; }\n';
  for (const name of ['-DX.c', '--version.c', '-o.c']) {
    const r = await buildRun(put(path.join('dash', name), src));
    assert.ok(r.build.ok, name + ': ' + r.build.output);
    assert.equal(r.run.stdout, 'dash ok\n', name);
    assert.ok(r.plan.steps[0].args.includes('.' + path.sep + name), r.plan.steps[0].args.join(' '));
    assert.ok(!r.plan.steps[0].args.includes(name));
  }
  const bad = put(path.join('dash2', '-bad.c'), 'int main(void){ return nope; }\n');
  const b = await buildRun(bad);
  assert.equal(b.build.ok, false);
  const d = D.parse(b.build.output).filter((x) => x.severity === 'error');
  assert.ok(d.length > 0, b.build.output);
  assert.equal(D.resolvePath(d[0].file, b.plan.cwd, b.plan.sources, fs.existsSync), bad);
  const helper = put(path.join('dash3', '-helper.c'), 'int helper(void){ return 41; }\n');
  const main = put(path.join('dash3', 'main.c'), '#include <stdio.h>\nint helper(void);\nint main(void){ printf("%d\\n", helper() + 1); return 0; }\n');
  const f = await buildRun(main, { folder: true });
  assert.ok(f.build.ok, f.build.output);
  assert.equal(f.run.stdout, '42\n');
  assert.ok(fs.existsSync(helper));
});

test('per-file flags and arguments with spaces (// run: and // args:)', async (t) => {
  if (!cc) return t.skip('no compiler');
  const r = await buildRun(put('flags.cpp', '// run: -O2 -DFOO=7\n// args: "Hello World" 2\n#include <cstdio>\nint main(int argc, char** argv){ std::printf("%d|%s|%s|%d\\n", argc, argv[1], argv[2], FOO); }\n'));
  assert.equal(r.run.stdout, '3|Hello World|2|7\n');
  assert.ok(r.plan.steps[0].args.includes('-O2'));
  assert.ok(r.plan.steps[0].args.indexOf('-O2') > r.plan.steps[0].args.indexOf('-O0'), 'file flags come last');
});

test('-lm program and a 3-file C project with a header (folder mode lists files, no wildcard)', async (t) => {
  if (!cc) return t.skip('no compiler');
  const m = await buildRun(put('math.c', '#include <math.h>\n#include <stdio.h>\nint main(void){ volatile double x = 2.0; printf("%.3f\\n", sqrt(x)); return 0; }\n'));
  assert.equal(m.run.stdout, '1.414\n');
  put('proj/util.h', 'int add(int a, int b);\nint twice(int a);\n');
  put('proj/util.c', '#include "util.h"\nint add(int a, int b){ return a + b; }\n');
  put('proj/twice.c', '#include "util.h"\nint twice(int a){ return add(a, a); }\n');
  const main = put('proj/main.c', '#include <stdio.h>\n#include "util.h"\nint main(void){ printf("%d\\n", twice(21)); return 0; }\n');
  const single = await buildRun(main);
  assert.equal(single.build.ok, false, 'one file alone does not link');
  assert.ok(D.linkerErrors(single.build.output).length > 0);
  const f = await buildRun(main, { folder: true });
  assert.equal(f.run.stdout, '42\n');
  assert.ok(!f.plan.steps[0].args.some((a) => a.includes('*')));
  assert.deepEqual(f.plan.sources.map((s) => path.basename(s)), ['main.c', 'twice.c', 'util.c']);
});

test('mixed C and C++ folder links with the C++ compiler', async (t) => {
  if (!cc) return t.skip('no compiler');
  put('mixed/c_part.c', 'int c_value(void){ return 5; }\n');
  const main = put('mixed/main.cpp', '#include <iostream>\nextern "C" int c_value();\nint main(){ std::cout << c_value() * 2 << "\\n"; }\n');
  const r = await buildRun(main, { folder: true });
  assert.equal(r.plan.steps.length, 3);
  assert.equal(r.run.stdout, '10\n');
});

test('path with spaces and ü, compile error maps to the right file and line', async (t) => {
  if (!cc) return t.skip('no compiler');
  const ok = await buildRun(put('my code/ü/grüße.cpp', '#include <iostream>\nint main(){ std::cout << "ü ok" << std::endl; }\n'));
  assert.equal(ok.run.stdout, 'ü ok\n');
  const bad = put('my code/ü/你好.cpp', '#include <iostream>\nint main() {\n  int x = 1\n  return x;\n}\n');
  const r = await buildRun(bad);
  assert.equal(r.build.ok, false);
  const p = D.parse(r.build.output);
  assert.ok(p.length >= 1);
  assert.equal(D.resolvePath(p[0].file, r.plan.cwd, r.plan.sources, fs.existsSync), bad);
  assert.ok(p[0].line === 3 || p[0].line === 4, 'line ' + p[0].line);
});

test('segfault shows the signal; Stop kills the program and its child; time limit', async (t) => {
  if (!cc) return t.skip('no compiler');
  const seg = await buildRun(put('seg.c', '#include <stdio.h>\nint main(void){ int *volatile p = 0; puts("before"); fflush(stdout); *p = 1; return 0; }\n'));
  assert.equal(seg.run.stdout, 'before\n');
  assert.equal(seg.run.exit.ok, false);
  assert.match(seg.run.exit.short, /SIGSEGV|SIGBUS/);
  const loopFile = put('loop.c', '#include <unistd.h>\n#include <stdio.h>\nint main(void){ pid_t k = fork(); printf("%d\\n", (int)k); fflush(stdout); for(;;){} }\n');
  const p = B.plan({ main: loopFile, text: fs.readFileSync(loopFile, 'utf8'), compilers: cc, outDir: path.join(WORK, 'out dir', 'bin') });
  assert.ok((await B.compile(p)).ok);
  const h = R.runProgram(p.binary, { cwd: p.cwd });
  await new Promise((r) => setTimeout(r, 400));
  h.stop();
  const r = await h.promise;
  assert.equal(r.exit.short, 'stopped');
  const kid = Number(r.stdout.split('\n').find((l) => Number(l) > 0));
  await new Promise((res) => setTimeout(res, 200));
  let alive = true;
  try { process.kill(kid, 0); } catch (e) { alive = false; }
  assert.equal(alive, false, 'the forked child is gone too');
  const tl = await R.runProgram(p.binary, { cwd: p.cwd, timeLimitMs: 500 }).promise;
  assert.equal(tl.exit.short, 'time limit');
});

test('1,000,000 lines: counted in full, capture capped, no freeze', async (t) => {
  if (!cc) return t.skip('no compiler');
  const f = put('big.cpp', '#include <cstdio>\nint main(){ for (int i = 0; i < 1000000; i++) std::printf("line %d\\n", i); }\n');
  const p = B.plan({ main: f, text: fs.readFileSync(f, 'utf8'), compilers: cc, outDir: path.join(WORK, 'out dir', 'bin') });
  assert.ok((await B.compile(p)).ok);
  const t0 = Date.now();
  let ticks = 0;
  const iv = setInterval(() => ticks++, 20);
  const r = await R.runProgram(p.binary, { cwd: p.cwd, captureBytes: 2 * 1024 * 1024 }).promise;
  clearInterval(iv);
  assert.equal(r.stdoutLines, 1000000);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
  assert.ok(r.truncated);
  assert.ok(ticks >= Math.floor((Date.now() - t0) / 20 / 3), 'event loop kept running');
});

test('the terminal launcher writes the pid and the result, and prints the footer', async (t) => {
  if (!cc) return t.skip('no compiler');
  const launch = path.join(__dirname, '..', 'dist', 'launch.js');
  if (!fs.existsSync(launch)) return t.skip('run the build first');
  const f = put('exit3.c', '#include <stdio.h>\nint main(int c, char** v){ printf("%s\\n", v[1]); return 3; }\n');
  const p = B.plan({ main: f, text: '', compilers: cc, outDir: path.join(WORK, 'out dir', 'bin') });
  assert.ok((await B.compile(p)).ok);
  const status = path.join(WORK, 'status.json');
  const child = spawn(process.execPath, [launch, status, p.binary, 'two words'], { cwd: p.cwd, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NO_COLOR: '1' } });
  let text = '';
  child.stdout.on('data', (b) => { text += b; });
  await new Promise((r) => child.on('exit', r));
  const st = JSON.parse(fs.readFileSync(status, 'utf8'));
  assert.equal(st.state, 'done');
  assert.equal(st.code, 3);
  assert.match(text, /two words/);
  assert.match(text, /── exit code 3 · \d+ ms/);
});
