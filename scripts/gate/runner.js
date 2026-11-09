'use strict';
// Runs inside a real VS Code (or Cursor) with the installed vsix: --extensionTestsPath=scripts/gate/runner.js.
// Reads GATE_MANIFEST (written by scripts/gate-vscode.mjs) and writes the checks to GATE_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 600) }); }
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return 'missing'; } };
async function waitFor(fn, ms = 20000, step = 100) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await sleep(step); } return null; }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

/** Measures the extension host's event loop lag while fn runs. */
async function withLag(fn) {
  let max = 0; let last = Date.now();
  const iv = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 50); last = now; }, 50);
  try { const v = await fn(); return { v, lag: max }; } finally { clearInterval(iv); }
}

async function run() {
  const m = JSON.parse(fs.readFileSync(process.env.GATE_MANIFEST, 'utf8'));
  const F = m.files;
  const only = process.env.GATE_ONLY ? process.env.GATE_ONLY.split(',') : null;
  const want = (k) => !only || only.includes(k);
  const settingsSha = sha(m.workspaceSettings);
  const ext = vscode.extensions.getExtension('zovo.zovo-run-cpp');
  check('extension installed', !!ext, ext && ext.packageJSON.version);
  const api = await ext.activate();
  check('gate API available (ZOVO_RUN_GATE=1)', !!api);
  const open = async (f) => { const d = await vscode.workspace.openTextDocument(vscode.Uri.file(f)); await vscode.window.showTextDocument(d); return d; };
  const lastRun = () => api.gate.terminalRuns[api.gate.terminalRuns.length - 1];
  const runTerminal = async (f, opts = {}) => { await open(f); const t0 = Date.now(); const r = await (opts.folder ? vscode.commands.executeCommand('zovoRun.runFolder') : vscode.commands.executeCommand('zovoRun.run')); return { r, ms: Date.now() - t0 }; };
  const outFile = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';

  const cpp = await api.compilerFor('cpp', true); const c = await api.compilerFor('c', true);
  check('compilers found (g++/clang++ and gcc/clang)', cpp.ok && c.ok, `${cpp.path} ${cpp.label} | ${c.path} ${c.label}`);

  if (want('hello')) {
    for (const k of ['helloC', 'helloCpp']) {
      const { r, ms } = await runTerminal(F[k]);
      check(`${path.basename(F[k])}: Run builds and runs in the terminal, exit 0`, r && r.exit && r.exit.ok && r.code === 0, JSON.stringify(r) + ` ${ms} ms`);
      check(`${path.basename(F[k])}: program output written`, /hello/.test(outFile(F[k] + '.out')), outFile(F[k] + '.out'));
    }
    const term = vscode.window.terminals.find((t) => t.name.startsWith('Run: '));
    check('terminal named "Run: <file>" exists', !!term, term && term.name);
  }

  if (want('stdin')) {
    await open(F.read3);
    const p = vscode.commands.executeCommand('zovoRun.run');
    const st = await waitFor(() => { const r = lastRun(); return r && r.file === F.read3 && readJson(r.statusFile) && readJson(r.statusFile).state === 'running' && r; }, 60000);
    await sleep(800);
    const term = vscode.window.terminals.find((t) => t.name === 'Run: ' + path.basename(F.read3));
    if (term) { term.sendText('first line', true); await sleep(200); term.sendText('second line', true); await sleep(200); term.sendText('third ü line', true); }
    const r = await Promise.race([p, sleep(20000).then(() => null)]);
    check('interactive stdin in the terminal: a cin program reads 3 typed lines', st && r && r.exit && r.exit.ok && outFile(F.read3 + '.out') === 'third ü line|second line|first line\n', JSON.stringify(r) + ' out=' + JSON.stringify(outFile(F.read3 + '.out')));
  }

  if (want('cpp20')) {
    const { r } = await runTerminal(F.cpp20);
    check('C++20 program (ranges, std::format) runs with the default -std=c++20', r && r.exit && r.exit.ok && /6 4 2/.test(outFile(F.cpp20 + '.out')), outFile(F.cpp20 + '.out'));
  }

  if (want('flags')) {
    const { r } = await runTerminal(F.args);
    const got = outFile(F.args + '.out');
    const b = api.gate.builds[api.gate.builds.length - 1];
    const argv = b ? b.steps[0] : [];
    check('// run: -O2 -DFOO=7 applies to this file, after the defaults (rival issue: per-file flags)', argv.indexOf('-O2') > argv.indexOf('-O0') && /FOO=7/.test(got), argv.join(' '));
    check('// args: "Hello World" 2 gives argc 3 and argv[1] "Hello World" (rival issue: args with spaces)', got === 'argc=3|argv1=Hello World|argv2=2|FOO=7\n', JSON.stringify(got) + ' ' + JSON.stringify(r));
  }

  if (want('math')) {
    const { r } = await runTerminal(F.math);
    check('C program with sqrt links (-lm) and runs', r && r.exit && r.exit.ok && /1\.414/.test(outFile(F.math + '.out')), outFile(F.math + '.out'));
  }

  if (want('folder')) {
    const { r } = await runTerminal(F.projMain);
    check('3-file project: single-file Run fails with a linker problem, not a crash', !r && vscode.languages.getDiagnostics(vscode.Uri.file(F.projMain)).some((d) => /Link error|undefined|Undefined/.test(d.message)), vscode.languages.getDiagnostics(vscode.Uri.file(F.projMain)).map((d) => d.message).join(' / '));
    const f = await runTerminal(F.projMain, { folder: true });
    const b = api.gate.builds[api.gate.builds.length - 1];
    check('3-file project: Build and Run All Files in This Folder works, files listed (no *.cpp wildcard)', f.r && f.r.exit && f.r.exit.ok && /42/.test(outFile(F.projMain + '.out')) && b.steps[0].filter((a) => /\.c$/.test(a)).length === 3 && !b.steps[0].some((a) => a.includes('*')), b.steps[0].join(' '));
  }

  if (want('problems')) {
    await runTerminal(F.compileError);
    const d = vscode.languages.getDiagnostics(vscode.Uri.file(F.compileError));
    const e = d.find((x) => x.severity === vscode.DiagnosticSeverity.Error);
    check('compile error in Problems at the right line', e && e.range.start.line === m.compileErrorLine - 1, d.map((x) => `${x.range.start.line + 1}:${x.range.start.character + 1} ${x.message}`).join(' / '));
    const w = d.find((x) => x.severity === vscode.DiagnosticSeverity.Warning);
    check('warning in Problems with its line', w && w.range.start.line === m.warningLine - 1, w ? `${w.range.start.line + 1} ${w.message}` : 'none');
    await runTerminal(F.unicodeBad);
    const du = vscode.languages.getDiagnostics(vscode.Uri.file(F.unicodeBad));
    const all = vscode.languages.getDiagnostics().filter(([u, l]) => l.length && /\.zovo|ü|你好/.test(u.fsPath));
    check('compile error in "my code/ü/你好.cpp" shows on that file at the right line (rival issue: garbled non-ASCII paths)', du.some((x) => x.range.start.line === m.unicodeErrorLine - 1), du.map((x) => `${x.range.start.line + 1} ${x.message}`).join(' / ') + ' | files: ' + all.map(([u]) => u.fsPath).join(', '));
    const { r } = await runTerminal(F.unicodeOk);
    check('program in "my code/ü/grüße.cpp" builds and runs', r && r.exit && r.exit.ok && /grüße ok/.test(outFile(F.unicodeOk + '.out')), JSON.stringify(r));
  }

  if (want('segv')) {
    const { r } = await runTerminal(F.segfault);
    check('segfault: exit shows SIGSEGV (signal 11) with an explanation', r && r.exit && /SIGSEGV|SIGBUS/.test(r.exit.short) && /memory/.test(r.exit.detail || ''), JSON.stringify(r && r.exit));
  }

  if (want('loop')) {
    await open(F.infinite);
    try { fs.unlinkSync(F.infinite + '.out'); } catch (e) { /* first run */ }
    const p = vscode.commands.executeCommand('zovoRun.run');
    await waitFor(() => fs.existsSync(F.infinite + '.out') && outFile(F.infinite + '.out').trim(), 60000);
    await sleep(1000);
    const t0 = Date.now();
    await vscode.commands.executeCommand('zovoRun.stop');
    const r = await Promise.race([p, sleep(10000).then(() => null)]);
    const pids = outFile(F.infinite + '.out').trim().split(/\s+/).map(Number).filter(Boolean);
    await sleep(300);
    const alive = pids.filter((x) => { try { process.kill(x, 0); return true; } catch (e) { return false; } });
    check('endless loop: Stop ends it and its forked child', r && r.exit && r.exit.short === 'stopped' && alive.length === 0 && pids.length === 2, `stop took ${Date.now() - t0} ms, pids ${pids}, alive ${alive}, ${JSON.stringify(r && r.exit)}`);
  }

  if (want('large')) {
    const { v, lag } = await withLag(() => runTerminal(F.big));
    check('large: 1,000,000 lines in the terminal finish, extension host stays responsive', v.r && v.r.exit && v.r.exit.ok && lag < 500, `${v.ms} ms, host lag max ${lag} ms`);
  }

  if (want('panel')) {
    await vscode.commands.executeCommand('zovoRun.inputPanel.focus');
    await open(F.sum);
    const panel = await waitFor(() => api.panel() && api.panel().view && api.panel().file === F.sum && api.panel(), 20000);
    check('Input & Tests panel opens and follows the active file', !!panel, panel && panel.file);
    if (panel) {
      const r = await panel.runWithInput('20 22\n');
      check('Input panel: run with pasted input shows stdout, exit code, time, memory', r && r.stdout === '42\n' && panel.st().last.exit.ok && panel.st().last.ms > 0, JSON.stringify(panel.st().last).slice(0, 300));
      const res = await panel.runTests(null);
      const pass = (res || []).filter((x) => x.status === 'pass').length; const fail = (res || []).filter((x) => x.status === 'fail');
      check('Input panel: 3 saved test cases, 2 pass and 1 fails with a diff', res && res.length === 3 && pass === 2 && fail.length === 1 && fail[0].diff && fail[0].diff.firstDiff === 0 && fail[0].diff.rows.some((x) => !x.same && x.expected === '100' && x.actual === '7'), JSON.stringify(res).slice(0, 500));
      await open(F.segfault);
      await waitFor(() => panel.file === F.segfault, 5000);
      const rs = await panel.runWithInput('');
      check('Input panel: segfault shows the signal', rs && /SIGSEGV|SIGBUS/.test(rs.exit.short), rs && rs.exit.short);
      await open(F.infinite);
      await waitFor(() => panel.file === F.infinite, 5000);
      vscode.workspace.getConfiguration('zovoRun').update('timeLimitSeconds', 2, vscode.ConfigurationTarget.Global);
      await sleep(300);
      const rl = await panel.runWithInput('');
      check('Input panel: endless loop stops at the time limit', rl && rl.exit.short === 'time limit', rl && `${rl.exit.short} ${Math.round(rl.ms)} ms`);
      await vscode.workspace.getConfiguration('zovoRun').update('timeLimitSeconds', undefined, vscode.ConfigurationTarget.Global);
      await open(F.big);
      await waitFor(() => panel.file === F.big, 5000);
      const { v, lag } = await withLag(() => panel.runWithInput(''));
      const last = panel.st().last;
      check('large: 1,000,000 lines in the Input panel: preview of 2,000 lines, all lines counted, host responsive', v && v.stdoutLines === 1000000 && /first 2,000 of 1,000,000 lines/.test(last.previewNote) && lag < 1000, `${last.previewNote} | ${Math.round(v && v.ms)} ms, host lag max ${lag} ms`);
      await panel.onMessage({ type: 'openFullOutput' });
      await sleep(1500);
      const ed = vscode.window.activeTextEditor;
      check('large: Open full output opens all 1,000,000 lines in an editor tab', ed && ed.document.lineCount >= 1000000, ed && `${ed.document.fileName} ${ed.document.lineCount}`);
    }
  }

  if (want('header')) {
    await open(F.header);
    const r = await vscode.commands.executeCommand('zovoRun.run');
    check('header file: Run explains instead of building', r === undefined && api.running() === null);
  }

  if (want('nocompiler')) {
    await vscode.workspace.getConfiguration('zovoRun').update('cppCompiler', path.join(m.work, 'no such dir', 'g++'), vscode.ConfigurationTarget.Global);
    await sleep(300);
    await open(F.helloCpp);
    await vscode.commands.executeCommand('zovoRun.run');
    const tab = await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Compiler setup'), 5000);
    check('no compiler: the setup page opens (official steps, no download)', !!tab, tab && tab.label);
    await vscode.workspace.getConfiguration('zovoRun').update('cppCompiler', undefined, vscode.ConfigurationTarget.Global);
  }

  check('workspace settings.json unchanged (rival issue: settings overwritten)', sha(m.workspaceSettings) === settingsSha, settingsSha.slice(0, 12));
  check('built programs go to .zovo-run/bin with a .gitignore', fs.existsSync(path.join(m.folder, '.zovo-run', 'bin', '.gitignore')));
  check('source files unchanged by runs', Object.entries(m.hashes).every(([f, h]) => sha(f) === h), Object.entries(m.hashes).filter(([f, h]) => sha(f) !== h).map(([f]) => f).join(', '));

  fs.writeFileSync(process.env.GATE_OUT, JSON.stringify({ app: vscode.env.appName, version: vscode.version, results }, null, 1));
  for (const t of vscode.window.terminals) t.dispose();
}

module.exports = { run };
