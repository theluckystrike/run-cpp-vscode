// Release gate in a real VS Code (or Cursor): installs the .vsix into a private profile, writes 17 real C and C++
// files (1 large, 6 hostile) into a workspace, runs scripts/gate/runner.js inside the editor and prints a summary.
//
//   node scripts/gate-vscode.mjs --vsix dist/x.vsix --work ~/run-cpp-work/gate [--code ".../Code"] [--only a,b] [--keep]
//
// Files are written under --work (not the temp folder) and deleted at the end unless --keep.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const CODE = arg('code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code');
const isCursor = /Cursor/.test(CODE);
const CLI = isCursor ? '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' : path.join(path.dirname(path.dirname(CODE)), 'Resources/app/bin/code');
const keep = process.argv.includes('--keep');
const only = arg('only', '');

fs.rmSync(work, { recursive: true, force: true });
const folder = path.join(work, 'files');
fs.mkdirSync(folder, { recursive: true });
const write = (rel, text) => { const p = path.join(folder, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const OUT_C = (fmt, ...a) => `{ FILE *o = fopen(__FILE__ ".out", "w"); fprintf(o, ${fmt}${a.length ? ', ' + a.join(', ') : ''}); fclose(o); }`;

const F = {
  helloC: write('hello.c', `#include <stdio.h>\nint main(void) {\n  puts("hello from C");\n  ${OUT_C('"hello c\\n"')}\n  return 0;\n}\n`),
  helloCpp: write('hello.cpp', `#include <iostream>\n#include <fstream>\nint main() {\n  std::cout << "hello from C++" << std::endl;\n  std::ofstream(__FILE__ ".out") << "hello c++\\n";\n}\n`),
  read3: write('read3.cpp', `#include <iostream>\n#include <fstream>\n#include <string>\nint main() {\n  std::string a, b, c;\n  std::cout << "Line 1: " << std::flush; std::getline(std::cin, a);\n  std::cout << "Line 2: " << std::flush; std::getline(std::cin, b);\n  std::cout << "Line 3: " << std::flush; std::getline(std::cin, c);\n  std::cout << c << " / " << b << " / " << a << std::endl;\n  std::ofstream(__FILE__ ".out") << c << '|' << b << '|' << a << '\\n';\n}\n`),
  cpp20: write('cpp20.cpp', `#include <fstream>\n#include <iostream>\n#include <ranges>\n#include <string>\n#include <vector>\n#if __has_include(<format>)\n#include <format>\n#endif\nint main() {\n  std::vector<int> v{1, 2, 3};\n  std::string s;\n  for (int x : v | std::views::transform([](int x) { return x * 2; }) | std::views::reverse) s += std::to_string(x) + " ";\n#if __has_include(<format>) && defined(__cpp_lib_format)\n  s += std::format("{}", "format");\n#endif\n  std::cout << s << std::endl;\n  std::ofstream(__FILE__ ".out") << s << '\\n';\n}\n`),
  args: write('args.cpp', `// run: -O2 -DFOO=7\n// args: "Hello World" 2\n#include <cstdio>\nint main(int argc, char** argv) {\n  FILE* o = std::fopen(__FILE__ ".out", "w");\n  std::fprintf(o, "argc=%d|argv1=%s|argv2=%s|FOO=%d\\n", argc, argv[1], argv[2], FOO);\n  std::fclose(o);\n  std::printf("argc=%d argv[1]=%s\\n", argc, argv[1]);\n}\n`),
  math: write('math.c', `#include <math.h>\n#include <stdio.h>\nint main(void) {\n  volatile double x = 2.0;\n  printf("sqrt(2) = %.3f\\n", sqrt(x));\n  ${OUT_C('"%.3f\\n"', 'sqrt(x)')}\n  return 0;\n}\n`),
  projH: write('proj/util.h', 'int add(int a, int b);\nint twice(int a);\n'),
  projUtil: write('proj/util.c', '#include "util.h"\nint add(int a, int b) { return a + b; }\n'),
  projTwice: write('proj/twice.c', '#include "util.h"\nint twice(int a) { return add(a, a); }\n'),
  projMain: write('proj/main.c', `#include <stdio.h>\n#include "util.h"\nint main(void) {\n  printf("%d\\n", twice(21));\n  ${OUT_C('"%d\\n"', 'twice(21)')}\n  return 0;\n}\n`),
  compileError: write('hostile-compile-error.cpp', '#include <iostream>\n\nint main() {\n  int z = 0; if (z = 3) { std::cout << z; }\n  std::cout << "x" << std::endl;\n  int y = undefined_name + 1;\n  return y;\n}\n'),
  unicodeBad: write('my code/ü/你好.cpp', '#include <iostream>\nint main() {\n  return undeclared_thing;\n}\n'),
  unicodeOk: write('my code/ü/grüße.cpp', `#include <fstream>\n#include <iostream>\nint main() {\n  std::cout << "grüße ok" << std::endl;\n  std::ofstream(__FILE__ ".out") << "grüße ok\\n";\n}\n`),
  segfault: write('hostile-segfault.c', '#include <stdio.h>\nint main(void) {\n  int *volatile p = 0;\n  puts("about to crash");\n  fflush(stdout);\n  *p = 42;\n  return 0;\n}\n'),
  infinite: write('hostile-infinite-loop.c', `#include <stdio.h>\n#include <unistd.h>\nint main(void) {\n  pid_t kid = fork();\n  if (kid == 0) { for (;;) {} }\n  ${OUT_C('"%d %d\\n"', '(int)getpid()', '(int)kid')}\n  for (;;) {}\n}\n`),
  big: write('large-1m-lines.cpp', '#include <cstdio>\nint main() {\n  for (int i = 0; i < 1000000; i++) std::printf("line %d of 1000000\\n", i);\n  return 0;\n}\n'),
  sum: write('sum.cpp', '#include <iostream>\nint main() {\n  long long a, b;\n  std::cin >> a >> b;\n  std::cout << a + b << std::endl;\n}\n'),
};
F.header = F.projH;
const workspaceSettings = write('.vscode/settings.json', '{\n  // the user\'s own settings; the gate checks that they stay byte for byte the same\n  "editor.tabSize": 2,\n  "files.trimTrailingWhitespace": true\n}\n');
write('.zovo-run/tests/sum.cpp.json', JSON.stringify({ file: 'sum.cpp', tests: [
  { id: 't1', name: 'small', input: '1 2\n', expected: '3\n' },
  { id: 't2', name: 'answer', input: '20 22\n', expected: '42\n' },
  { id: 't3', name: 'wrong on purpose', input: '3 4\n', expected: '100\n' },
] }, null, 1));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const hashes = Object.fromEntries(Object.values(F).map((f) => [f, sha(f)]));
const manifest = { work, folder, files: F, workspaceSettings, hashes, compileErrorLine: 6, warningLine: 4, unicodeErrorLine: 3 };
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`gate files: ${new Set(Object.values(F)).size} (large: large-1m-lines.cpp; hostile: compile error, segfault, endless loop with a child, "my code/ü/你好.cpp", no compiler, header file)`);

// ---- install the vsix in a private profile ----
const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'git.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'zovoRun.askForRating': false, 'terminal.integrated.enablePersistentSessions': false,
}, null, 1));
let installed;
const inst = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 180000 });
console.log('install:', ((inst.stdout || '') + (inst.stderr || '')).trim().split('\n').pop());
installed = fs.existsSync(ext) && fs.readdirSync(ext).find((d) => d.startsWith('zovo.zovo-run-cpp-'));
if (!installed) { console.error('not installed'); process.exit(2); }

// ---- run the in-editor checks ----
const out = path.join(work, 'results.json');
const t0 = Date.now();
const childEnv = { ...process.env, ZOVO_RUN_GATE: '1', GATE_MANIFEST: path.join(work, 'manifest.json'), GATE_OUT: out, GATE_ONLY: only };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(CODE, ['--user-data-dir', ud, '--extensions-dir', ext, '--disable-workspace-trust', '--skip-welcome', '--new-window',
  `--extensionDevelopmentPath=${path.join(ext, installed)}`, `--extensionTestsPath=${path.join(root, 'scripts/gate/runner.js')}`, folder],
{ stdio: 'ignore', env: childEnv });
const timer = setTimeout(() => { console.error('gate timeout, killing the editor'); child.kill('SIGKILL'); }, 8 * 60 * 1000);
await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
spawnSync('pkill', ['-f', ud]);
const res = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { results: [{ name: 'runner wrote results', ok: false, detail: 'no results.json' }] };
let pass = 0, fail = 0;
for (const r of res.results) { if (r.ok) pass++; else fail++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`); }
console.log(`\n${res.app || '?'} ${res.version || '?'}: ${pass} pass, ${fail} fail, ${((Date.now() - t0) / 1000).toFixed(0)} s, vsix sha256 ${sha(vsix)}`);
const keepOut = arg('save', '');
if (keepOut) fs.writeFileSync(keepOut, JSON.stringify({ ...res, pass, fail, vsix: path.basename(vsix), sha256: sha(vsix) }, null, 1));
if (!keep) fs.rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
