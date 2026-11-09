'use strict';
// Run C++ and C Code: build and run the current file with gcc, g++, clang or clang++.
// No network and no telemetry: the compiler on this computer does the work. Arguments always go to spawn as an
// array, so no shell ever parses a path or a flag.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./core/flags');
const B = require('./core/build');
const D = require('./core/diagnostics');
const C = require('./core/compilers');
const R = require('./core/run');
const T = require('./core/testcases');
const P = require('./core/proc');
const { panelHtml, setupHtml } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createPro } = require('./pro');

const EXT_ID = 'zovo.zovo-run-cpp';
const HEX_ID = 'zovo.zovo-hex-viewer';
const MAP_ID = 'zovo.zovo-linker-map-viewer';
const PREVIEW_LINES = 2000;
const PREVIEW_BYTES = 256 * 1024;

let ctx;
let out;
let diags;
let status;
let rating = { success() {}, failure() {} };
let pro = { allow: async () => true, label: () => '', enabled: false };
let panel = null; // InputPanel
let setupPanel = null;
const compilerCache = new Map(); // lang -> result of C.find
const lastBuild = new Map(); // source path -> plan of the last good build
const gate = { terminalRuns: [], builds: [] };

let running = null; // { kind: 'terminal' | 'pipe' | 'stress', stop(), file }
let terminal = null;
let terminalStatus = '';

const cfg = () => vscode.workspace.getConfiguration('zovoRun');

function setRunning(r) {
  running = r;
  vscode.commands.executeCommand('setContext', 'zovoRun.running', !!r);
  updateStatusBar();
  if (panel) panel.push();
}

// ---------- files and folders ----------

function sourceDoc(uri) {
  if (uri && uri.fsPath) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    return open || vscode.workspace.openTextDocument(uri);
  }
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file' && (F.languageOf(ed.document.fileName) || F.isHeader(ed.document.fileName))) return ed.document;
  if (panel && panel.file) return vscode.workspace.openTextDocument(vscode.Uri.file(panel.file));
  return null;
}

function rootOf(file) {
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  return wf ? wf.uri.fsPath : '';
}

function outDirFor(file) {
  const root = rootOf(file);
  if (cfg().get('outputFolder', 'workspace') === 'temp' || !root) return path.join(os.tmpdir(), 'zovo-run', B.hash(path.dirname(file)));
  return path.join(root, '.zovo-run', 'bin');
}

function ensureGitignore(dir) {
  if (!dir.includes(`${path.sep}.zovo-run${path.sep}`)) return;
  const f = path.join(dir, '.gitignore');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# Built programs from "Run C++ and C Code". Safe to delete: "Run C++: Delete Built Programs".\n*\n');
  } catch (e) { /* read-only folder */ }
}

function testsRoot(file) {
  return rootOf(file) || path.join(ctx.globalStorageUri.fsPath, 'tests', B.hash(path.dirname(file)));
}

// ---------- compilers ----------

async function compilerFor(lang, force = false) {
  if (!force && compilerCache.has(lang)) return compilerCache.get(lang);
  const c = cfg();
  const configured = (lang === 'c' ? c.get('cCompiler', '') : c.get('cppCompiler', '')).trim();
  const r = await C.find(lang, { configured, prefer: c.get('preferredCompiler', 'auto') });
  compilerCache.set(lang, r);
  return r;
}

async function compilersFor(langs) {
  const res = {};
  for (const l of langs) {
    const r = await compilerFor(l);
    if (!r.ok) {
      rating.failure();
      showSetup(r);
      return null;
    }
    res[l] = r.path;
  }
  return res;
}

function compilerLabel(lang) {
  const r = compilerCache.get(lang);
  return r && r.ok ? `${r.name} · ${r.label}` : '';
}

// ---------- build ----------

async function prepare(docOrPromise, { folder = false } = {}) {
  const doc = await docOrPromise;
  if (!doc) { vscode.window.showInformationMessage('Open a .c or .cpp file first.'); return null; }
  if (!F.languageOf(doc.fileName)) {
    vscode.window.showInformationMessage(F.isHeader(doc.fileName) ? 'This is a header file. Open the .c or .cpp file that has main() and run that one.' : 'Run C++ works on .c, .cpp, .cc and .cxx files.');
    return null;
  }
  if (doc.isUntitled) { vscode.window.showInformationMessage('Save the file first (it needs a name ending in .c or .cpp).'); return null; }
  if (doc.isDirty && cfg().get('saveBeforeRun', true)) await doc.save();
  if (folder && cfg().get('saveBeforeRun', true)) await vscode.workspace.saveAll(false);
  const file = doc.fileName;
  const outDir = outDirFor(file);
  ensureGitignore(outDir);
  const c = cfg();
  const flags = { c: c.get('cFlags', F.DEFAULT_FLAGS.c), cpp: c.get('cppFlags', F.DEFAULT_FLAGS.cpp), link: c.get('linkFlags', []) };
  // which compilers: plan once with placeholders to learn the languages, then find them
  const probe = B.plan({ main: file, folder, text: doc.getText(), compilers: { c: 'cc', cpp: 'c++' }, flags, outDir, linkMath: c.get('linkMath', true) });
  const langs = new Set(probe.sources.map(F.languageOf));
  if (langs.size > 1) langs.add('cpp');
  const compilers = await compilersFor([...langs]);
  if (!compilers) return null;
  const plan = B.plan({ main: file, folder, text: doc.getText(), compilers, flags, outDir, linkMath: c.get('linkMath', true) });
  plan.doc = doc;
  plan.file = file;
  plan.folder = folder;
  return plan;
}

const clearDiagnostics = (plan) => { for (const s of plan.sources) diags.delete(vscode.Uri.file(s)); };

function publishDiagnostics(plan, text) {
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  const byFile = new Map();
  const add = (file, d) => { if (!byFile.has(file)) byFile.set(file, []); byFile.get(file).push(d); };
  let count = 0;
  for (const p of D.parse(text)) {
    const file = D.resolvePath(p.file, plan.cwd, plan.sources, exists) || plan.file;
    const line = Math.max(0, p.line - 1);
    const col = Math.max(0, p.col - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), p.message, p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    d.source = path.basename(compilerCache.get(plan.lang) ? compilerCache.get(plan.lang).name : 'compiler');
    if (p.notes.length) {
      d.relatedInformation = p.notes.slice(0, 5).map((n) => {
        const nf = D.resolvePath(n.file, plan.cwd, plan.sources, exists);
        return nf ? new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(nf), new vscode.Position(Math.max(0, n.line - 1), Math.max(0, n.col - 1))), n.message) : null;
      }).filter(Boolean);
    }
    add(file, d);
    count++;
  }
  const link = D.linkerErrors(text);
  if (!count && link.length) {
    const hint = D.linkerHint(link);
    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `Link error: ${link.slice(0, 3).join(' ')}${hint ? `\n${hint}` : ''}`, vscode.DiagnosticSeverity.Error);
    d.source = 'linker';
    add(plan.file, d);
    count++;
  }
  for (const [file, list] of byFile) diags.set(vscode.Uri.file(file), list);
  return { count, errors: [...byFile.values()].flat().filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length, linker: link };
}

/** Builds with progress in the status bar. Returns { ok, compileError?: text } and publishes problems. */
async function build(plan, { force = false, quiet = false } = {}) {
  clearDiagnostics(plan);
  const t0 = Date.now();
  out.appendLine('');
  out.appendLine(`[${new Date().toLocaleTimeString()}] Build ${plan.folder ? 'folder ' + plan.cwd : plan.file}`);
  for (const s of plan.steps) out.appendLine('$ ' + B.displayCommand(s));
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Building ${path.basename(plan.file)}` },
    () => B.compile(plan, { force, onOutput: (s) => out.append(s) }));
  gate.builds.push({ file: plan.file, ok: res.ok, skipped: !!res.skipped, ms: Date.now() - t0, steps: plan.steps.map((s) => [s.exe, ...s.args]) });
  if (res.skipped) { out.appendLine('Up to date, not built again.'); }
  const pd = publishDiagnostics(plan, res.output || '');
  if (res.stdNote) out.appendLine(res.stdNote);
  if (!res.ok) {
    out.appendLine(`Build failed (${pd.errors || 'see the output above'}${pd.errors ? ' errors' : ''}).`);
    if (res.spawnError) {
      compilerCache.clear();
      vscode.window.showErrorMessage(`The compiler did not start: ${String(res.output).trim().slice(0, 200)}`, 'Compiler setup').then((b) => b && showSetup());
    } else if (!quiet && cfg().get('revealProblems', true)) {
      if (pd.count) vscode.commands.executeCommand('workbench.actions.view.problems', { preserveFocus: true });
      else out.show(true);
    }
    rating.failure(); // no rating ask in a session where a build failed, nor for 24 hours after it
    return { ok: false, compileError: (res.output || '').trim() || 'The build failed.' };
  }
  out.appendLine(`Built in ${P.formatMs(res.ms)}${pd.count ? `, ${pd.count} warning${pd.count === 1 ? '' : 's'} (see Problems)` : ''}: ${plan.binary}`);
  lastBuild.set(plan.file, plan);
  return { ok: true };
}

// ---------- run in the terminal ----------

function launcherPath() { return path.join(ctx.extensionPath, 'dist', 'launch.js'); }

function readStatus(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

async function runInTerminal(plan) {
  if (terminal) { try { terminal.dispose(); } catch (e) { /* closed */ } terminal = null; }
  const dir = path.join(ctx.globalStorageUri.fsPath, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* in use */ } }
  const statusFile = path.join(dir, `run-${Date.now()}.json`);
  terminalStatus = statusFile;
  const args = plan.args || [];
  terminal = vscode.window.createTerminal({
    name: `Run: ${path.basename(plan.folder ? plan.cwd : plan.file)}`,
    shellPath: process.execPath,
    shellArgs: [launcherPath(), statusFile, plan.binary, ...args],
    cwd: plan.cwd,
    env: { ELECTRON_RUN_AS_NODE: '1', ZOVO_RUN_LABEL: plan.folder ? `${path.basename(plan.cwd)}/ (${plan.sources.length} files)` : path.basename(plan.file) },
    iconPath: new vscode.ThemeIcon('play'),
    isTransient: true,
  });
  terminal.show(!cfg().get('focusTerminal', true));
  const started = Date.now();
  const rec = { file: plan.file, binary: plan.binary, args, statusFile, started };
  gate.terminalRuns.push(rec);
  const stop = () => {
    const st = readStatus(statusFile);
    try { fs.writeFileSync(statusFile + '.stop', '1'); } catch (e) { /* gone */ }
    if (st && st.pid && st.state === 'running') P.killTree(st.pid);
  };
  setRunning({ kind: 'terminal', stop, file: plan.file });
  const term = terminal;
  await new Promise((resolve) => {
    const t = setInterval(() => {
      const st = readStatus(statusFile);
      const closed = term.exitStatus !== undefined || !vscode.window.terminals.includes(term);
      if ((st && st.state === 'done') || closed || (!st && Date.now() - started > 20000)) {
        clearInterval(t);
        rec.result = st || { state: closed ? 'closed' : 'no-start' };
        if (st && st.state === 'running' && closed) P.killTree(st.pid);
        resolve();
      }
    }, 150);
  });
  setRunning(null);
  const st = rec.result;
  if (st && st.exit && st.exit.ok) rating.success(vscode.Uri.file(plan.file));
  else if (st && st.signal && !st.stopped) rating.failure(); // crashed (not stopped by the user): no ask
  return st;
}

// ---------- commands ----------

async function cmdRun(uri, { folder = false } = {}) {
  if (running) { vscode.window.showInformationMessage('A program is still running. Stop it first.', 'Stop').then((b) => b && cmdStop()); return; }
  const plan = await prepare(sourceDoc(uri), { folder });
  if (!plan) return;
  const b = await build(plan);
  if (panel) panel.afterBuild(plan, b);
  if (!b.ok) return;
  return runInTerminal(plan);
}

async function cmdBuild(uri) {
  const plan = await prepare(sourceDoc(uri));
  if (!plan) return;
  const b = await build(plan, { force: true });
  if (b.ok) vscode.window.setStatusBarMessage(`$(check) Built ${path.basename(plan.binary)}`, 4000);
  return b;
}

async function cmdRunOnly(uri) {
  if (running) return;
  const doc = await sourceDoc(uri);
  if (!doc) return;
  const plan = lastBuild.get(doc.fileName);
  if (!plan || !fs.existsSync(plan.binary)) return cmdRun(uri);
  plan.args = F.readDirectives(doc.getText()).args;
  return runInTerminal(plan);
}

function cmdStop() {
  if (running) running.stop();
}

async function cmdDebug(uri) {
  const plan = await prepare(sourceDoc(uri));
  if (!plan) return;
  const b = await build(plan);
  if (!b.ok) return;
  const has = (id) => !!vscode.extensions.getExtension(id);
  let config;
  const name = `Debug ${path.basename(plan.file)} (Run C++)`;
  if (has('vadimcs.vscode-lldb')) {
    config = { type: 'lldb', request: 'launch', name, program: plan.binary, args: plan.args, cwd: plan.cwd };
  } else if (has('ms-vscode.cpptools') || has('anysphere.cpptools')) {
    config = { type: 'cppdbg', request: 'launch', name, program: plan.binary, args: plan.args, cwd: plan.cwd, MIMode: process.platform === 'darwin' ? 'lldb' : 'gdb', externalConsole: false, stopAtEntry: false };
  } else {
    const pick = await vscode.window.showInformationMessage('Debugging needs a debugger extension: CodeLLDB (macOS, Linux, Windows) or the C/C++ extension (gdb). This extension does not install anything.', 'Find CodeLLDB', 'Find C/C++');
    if (pick) vscode.commands.executeCommand('workbench.extensions.search', pick === 'Find CodeLLDB' ? 'vadimcs.vscode-lldb' : '@category:debuggers c++');
    return;
  }
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(plan.file));
  if (wf && cfg().get('writeLaunchJson', true)) {
    const launch = vscode.workspace.getConfiguration('launch', wf.uri);
    const list = (launch.get('configurations') || []).filter((c) => c && c.name !== name);
    await launch.update('configurations', [...list, config], vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await vscode.debug.startDebugging(wf, config);
}

async function cmdClean() {
  const dirs = new Set();
  for (const wf of vscode.workspace.workspaceFolders || []) dirs.add(path.join(wf.uri.fsPath, '.zovo-run', 'bin'));
  dirs.add(path.join(os.tmpdir(), 'zovo-run'));
  const existing = [...dirs].filter((d) => fs.existsSync(d));
  if (!existing.length) { vscode.window.showInformationMessage('There are no built programs to delete.'); return; }
  const ok = await vscode.window.showWarningMessage(`Delete the built programs in ${existing.join(', ')}? Source files and saved test cases stay.`, { modal: true }, 'Delete');
  if (ok !== 'Delete') return;
  for (const d of existing) fs.rmSync(d, { recursive: true, force: true });
  lastBuild.clear();
  vscode.window.setStatusBarMessage('$(trash) Built programs deleted', 4000);
}

async function cmdSelectCompiler() {
  const items = [];
  for (const lang of ['cpp', 'c']) {
    items.push({ label: lang === 'cpp' ? 'C++' : 'C', kind: vscode.QuickPickItemKind.Separator });
    const found = C.candidates(lang);
    for (const f of found.slice(0, 12)) {
      const v = await C.probe(f.path);
      items.push({ label: f.name, description: v.ok ? v.label : v.error, detail: f.path, lang, path: f.path });
    }
    items.push({ label: `$(gear) Automatic (${lang === 'cpp' ? 'g++, then clang++' : 'gcc, then clang'})`, lang, path: '' });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick the compiler for C++ or C files' });
  if (!pick || pick.lang === undefined) return;
  await cfg().update(pick.lang === 'c' ? 'cCompiler' : 'cppCompiler', pick.path, vscode.ConfigurationTarget.Global);
  compilerCache.clear();
}

async function openWithIfInstalled(file, extId, viewType, what) {
  if (vscode.extensions.getExtension(extId)) {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), viewType);
    return true;
  }
  const b = await vscode.window.showInformationMessage(`${what} is a free Zovo extension. Open its page? Nothing is installed without your click there.`, 'Open page', 'Open as text');
  if (b === 'Open page') vscode.commands.executeCommand('extension.open', extId);
  if (b === 'Open as text') vscode.window.showTextDocument(vscode.Uri.file(file));
  return false;
}

async function cmdOpenBinaryInHex() {
  const doc = await sourceDoc();
  const plan = doc && lastBuild.get(doc.fileName);
  if (!plan || !fs.existsSync(plan.binary)) { vscode.window.showInformationMessage('Build the file first (Run or Build), then open its program in the Hex Viewer.'); return; }
  return openWithIfInstalled(plan.binary, HEX_ID, 'hexViewer.editor', 'Hex Viewer');
}

async function cmdOpenLinkerMap() {
  const doc = await sourceDoc();
  const plan = doc && lastBuild.get(doc.fileName);
  if (!plan || !plan.mapFile) {
    vscode.window.showInformationMessage('Add a linker map to the build with a line like "// run: -Wl,-Map=app.map" (GNU ld) at the top of the file, then build.');
    return;
  }
  if (!fs.existsSync(plan.mapFile)) { vscode.window.showInformationMessage(`No map file at ${plan.mapFile}. Build first.`); return; }
  return openWithIfInstalled(plan.mapFile, MAP_ID, 'linkerMap.viewer', 'Linker Map Viewer');
}

// ---------- setup page ----------

function showSetup(r) {
  const reason = r ? r.reason : 'Compiler setup';
  const tried = r ? r.tried : [];
  if (!setupPanel) {
    setupPanel = vscode.window.createWebviewPanel('zovoRun.setup', 'Compiler setup', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] });
    setupPanel.onDidDispose(() => { setupPanel = null; });
    setupPanel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'zovoRun.cppCompiler');
      if (m.type === 'recheck') {
        compilerCache.clear();
        const a = await compilerFor('cpp', true);
        const b = await compilerFor('c', true);
        if (a.ok || b.ok) {
          vscode.window.showInformationMessage(`Found: ${[a, b].filter((x) => x.ok).map((x) => `${x.name} (${x.label})`).join(', ')}. Press Run again.`);
          if (setupPanel) setupPanel.dispose();
        } else render(a);
      }
    });
  }
  const render = (x) => {
    setupPanel.webview.html = setupHtml({ cspSource: setupPanel.webview.cspSource, styleUri: setupPanel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.css')).toString(), platform: process.platform, reason: x ? x.reason : reason, tried: x ? x.tried : tried });
  };
  render(r);
  setupPanel.reveal();
}

// ---------- Input & Tests panel ----------

class InputPanel {
  constructor() {
    this.view = null;
    this.file = '';
    this.per = new Map(); // file -> { input, last, results: Map(id -> result), toolResult }
    this.toolsOpen = false;
    this.stress = null;
  }
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, enableCommandUris: commandUris('zovoRun'), localResourceRoots: [media] };
    view.webview.html = panelHtml({ cspSource: view.webview.cspSource, scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(), styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(), showSupportLinks: showLinks(vscode, 'zovoRun') });
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => { out.appendLine('Panel error: ' + (e && e.stack || e)); rating.failure(); }));
    view.onDidChangeVisibility(() => { if (view.visible) this.follow(vscode.window.activeTextEditor); });
    this.follow(vscode.window.activeTextEditor);
  }
  follow(ed) {
    if (ed && ed.document.uri.scheme === 'file' && F.languageOf(ed.document.fileName) && ed.document.fileName !== this.file) {
      this.file = ed.document.fileName;
      this.push(true);
    }
  }
  st(file = this.file) {
    if (!this.per.has(file)) this.per.set(file, { input: ctx.workspaceState.get('zovoRun.input:' + file, ''), last: null, results: new Map(), toolResult: '' });
    return this.per.get(file);
  }
  tests() { return this.file ? T.load(testsRoot(this.file), this.file) : []; }
  saveTests(list) { T.save(testsRoot(this.file), this.file, list); }
  push(resetInput = false) {
    if (!this.view) return;
    const s = this.file ? this.st() : null;
    const lang = this.file ? F.languageOf(this.file) : '';
    let folderFiles = [];
    if (this.file) folderFiles = B.folderSources(path.dirname(this.file)).filter((f) => f !== this.file).map((f) => path.basename(f));
    const state = !this.file ? { file: null } : {
      file: { name: path.basename(this.file), path: this.file, lang },
      compiler: compilerLabel(lang),
      running: !!running,
      input: s.input,
      last: s.last,
      tests: this.tests().map((t) => ({ ...t, ...(s.results.get(t.id) || {}) })),
      folderFiles,
      stress: this.stress,
      toolResult: s.toolResult,
      toolsOpen: this.toolsOpen,
      proLabel: pro.label(),
    };
    this.view.webview.postMessage({ type: 'state', state, resetInput });
  }
  afterBuild(plan, b) {
    if (plan.file !== this.file) return;
    if (!b.ok) { this.st().last = { compileError: b.compileError }; this.push(); }
  }
  async ensureFile() {
    if (!this.file) { const d = await sourceDoc(); if (d && F.languageOf(d.fileName)) this.file = d.fileName; }
    return this.file;
  }
  async buildCurrent(force = false) {
    const plan = await prepare(sourceDoc(vscode.Uri.file(this.file)));
    if (!plan) return null;
    const b = await build(plan, { force, quiet: true });
    if (!b.ok) { this.st().last = { compileError: b.compileError }; this.push(); return null; }
    this.push();
    return plan;
  }
  runOpts(plan, input) {
    const c = cfg();
    return { args: plan.args, cwd: plan.cwd, input, timeLimitMs: Math.max(0, c.get('timeLimitSeconds', 10)) * 1000, captureBytes: Math.max(1, c.get('maxCapturedOutputMB', 32)) * 1024 * 1024 };
  }
  async runOnce(plan, input) {
    const h = R.runProgram(plan.binary, this.runOpts(plan, input));
    setRunning({ kind: 'pipe', stop: () => h.stop(), file: plan.file });
    try { return await h.promise; } finally { setRunning(null); }
  }
  preview(r) {
    let text = r.stdout || '';
    let note = '';
    let cut = text.length > PREVIEW_BYTES;
    if (cut) text = text.slice(0, PREVIEW_BYTES);
    const lines = text.split('\n');
    if (lines.length > PREVIEW_LINES) { text = lines.slice(0, PREVIEW_LINES).join('\n'); cut = true; }
    if (cut || r.truncated) {
      const shown = text.split('\n').length;
      note = `Showing the first ${shown.toLocaleString('en-US')} of ${r.stdoutLines.toLocaleString('en-US')} lines (${(r.stdoutBytes / 1048576).toFixed(1)} MB).${r.truncated ? ` Output past ${cfg().get('maxCapturedOutputMB', 32)} MB was counted, not kept.` : ''}`;
    }
    return { stdout: text, previewNote: note };
  }
  summary(r) {
    const p = this.preview(r);
    return { exit: r.exit, ms: r.ms, peakKB: r.peakKB, stdoutLines: r.stdoutLines, stdoutBytes: r.stdoutBytes, stdout: p.stdout, previewNote: p.previewNote, stderr: (r.stderr || '').slice(0, 64 * 1024), truncated: r.truncated };
  }
  async runWithInput(input) {
    if (running || !(await this.ensureFile())) return null;
    const s = this.st();
    s.input = input;
    ctx.workspaceState.update('zovoRun.input:' + this.file, input.length < 512 * 1024 ? input : '');
    const plan = await this.buildCurrent();
    if (!plan) return null;
    const r = await this.runOnce(plan, input);
    s.full = r.stdout;
    s.last = this.summary(r);
    this.push();
    if (r.exit.ok) rating.success(vscode.Uri.file(this.file));
    else if (r.signal && !r.stopped && !r.timedOut) rating.failure(); // crashed: no ask
    return r;
  }
  async runTests(ids) {
    if (running || !(await this.ensureFile())) return null;
    const plan = await this.buildCurrent();
    if (!plan) return null;
    const s = this.st();
    const list = this.tests().filter((t) => !ids || ids.includes(t.id));
    const mode = cfg().get('compareMode', 'trim');
    let cancelled = false;
    setRunning({ kind: 'tests', stop: () => { cancelled = true; if (this.cur) this.cur.stop(); }, file: plan.file });
    try {
      for (const t of list) {
        if (cancelled) break;
        s.results.set(t.id, { status: 'running' });
        this.push();
        this.cur = R.runProgram(plan.binary, this.runOpts(plan, t.input));
        const r = await this.cur.promise;
        const cmp = r.exit.ok ? T.compare(t.expected, r.stdout, mode) : null;
        s.results.set(t.id, { status: !r.exit.ok ? 'error' : cmp.pass ? 'pass' : 'fail', ms: r.ms, peakKB: r.peakKB, exit: r.exit, diff: cmp && !cmp.pass ? cmp : null, actual: r.stdout.length <= T.MAX_TEST_BYTES ? r.stdout : undefined });
      }
    } finally { this.cur = null; setRunning(null); }
    this.push();
    const res = list.map((t) => ({ id: t.id, ...s.results.get(t.id) }));
    if (res.length && res.every((x) => x.status === 'pass' || x.status === 'fail')) rating.success(vscode.Uri.file(this.file));
    return res;
  }
  async stressTest({ gen, ref, count }) {
    if (running || !(await this.ensureFile())) return null;
    const s = this.st();
    this.stress = { gen, ref, count };
    if (!gen || !ref) { s.toolResult = 'Pick a generator file and a reference file from this folder first.'; this.push(); return null; }
    if (!(await pro.allow('stress'))) return null;
    const dir = path.dirname(this.file);
    const plans = [];
    for (const f of [this.file, path.join(dir, gen), path.join(dir, ref)]) {
      const p = await prepare(sourceDoc(vscode.Uri.file(f)));
      if (!p) return null;
      const b = await build(p, { quiet: true });
      if (!b.ok) { s.toolResult = `${path.basename(f)} does not build. See Problems.`; this.push(); return null; }
      plans.push(p);
    }
    const [main, g, rf] = plans;
    let cancelled = false;
    let cur = null;
    setRunning({ kind: 'stress', stop: () => { cancelled = true; if (cur) cur.stop(); }, file: this.file });
    const t0 = Date.now();
    let result = '';
    const n = Math.max(1, Math.min(10000, Number(count) || 200));
    try {
      for (let i = 1; i <= n; i++) {
        if (cancelled) { result = `Stopped after ${i - 1} inputs. No difference found so far.`; break; }
        cur = R.runProgram(g.binary, { ...this.runOpts(g, ''), args: [String(i)] });
        const gi = await cur.promise;
        if (!gi.exit.ok) { result = `The generator failed on seed ${i}: ${gi.exit.short}.`; break; }
        cur = R.runProgram(main.binary, this.runOpts(main, gi.stdout));
        const a = await cur.promise;
        cur = R.runProgram(rf.binary, this.runOpts(rf, gi.stdout));
        const b = await cur.promise;
        if (!b.exit.ok) { result = `The reference failed on seed ${i}: ${b.exit.short}.`; break; }
        const cmp = a.exit.ok ? T.compare(b.stdout, a.stdout, cfg().get('compareMode', 'trim')) : { pass: false };
        if (!a.exit.ok || !cmp.pass) {
          const list = this.tests();
          list.push({ id: T.newId(), name: `Stress seed ${i}`, input: gi.stdout, expected: b.stdout });
          this.saveTests(list);
          result = `Different on seed ${i} (${a.exit.ok ? `first difference at line ${cmp.firstDiff + 1}` : a.exit.short}). Saved as test case "Stress seed ${i}".\n\nInput:\n${gi.stdout.slice(0, 4000)}`;
          break;
        }
        if (i === n) result = `All ${n} generated inputs gave the same output as the reference (${P.formatMs(Date.now() - t0)}).`;
        if (i % 10 === 0) { s.toolResult = `Running… ${i} of ${n} inputs`; this.push(); }
      }
    } finally { setRunning(null); }
    s.toolResult = result;
    this.push();
    return result;
  }
  async benchmark(input, runs = 10) {
    if (running || !(await this.ensureFile())) return null;
    if (!(await pro.allow('benchmark'))) return null;
    const plan = await this.buildCurrent();
    if (!plan) return null;
    const s = this.st();
    const times = [];
    const mems = [];
    let fail = null;
    let cancelled = false;
    let cur = null;
    setRunning({ kind: 'bench', stop: () => { cancelled = true; if (cur) cur.stop(); }, file: plan.file });
    try {
      for (let i = 0; i < runs && !cancelled; i++) {
        cur = R.runProgram(plan.binary, this.runOpts(plan, input));
        const r = await cur.promise;
        if (!r.exit.ok) { fail = r.exit.short; break; }
        times.push(r.ms); if (r.peakKB) mems.push(r.peakKB);
      }
    } finally { setRunning(null); }
    const srt = (a) => a.slice().sort((x, y) => x - y);
    const t = srt(times); const m = srt(mems);
    const med = (a) => (a.length ? a[Math.floor((a.length - 1) / 2)] : 0);
    s.toolResult = fail ? `Run ${times.length + 1} failed: ${fail}.` : `${t.length} runs. Time: min ${P.formatMs(t[0])}, median ${P.formatMs(med(t))}, max ${P.formatMs(t[t.length - 1])}.` + (m.length ? ` Peak memory: min ${P.formatKB(m[0])}, median ${P.formatKB(med(m))}, max ${P.formatKB(m[m.length - 1])}.` : '');
    this.push();
    return s.toolResult;
  }
  async onMessage(m) {
    const s = this.file ? this.st() : null;
    switch (m.type) {
      case 'ready': this.follow(vscode.window.activeTextEditor); this.push(); break;
      case 'inputChanged': if (s) { s.input = m.input; } break;
      case 'run': await this.runWithInput(String(m.input || '')); break;
      case 'runAll': await this.runTests(null); break;
      case 'runTest': await this.runTests([m.id]); break;
      case 'stop': cmdStop(); break;
      case 'saveTest': {
        if (!s || !s.last || s.last.compileError) break;
        const list = this.tests();
        list.push({ id: T.newId(), name: '', input: String(m.input || ''), expected: s.full !== undefined ? s.full : s.last.stdout || '' });
        this.saveTests(list); this.push(); break;
      }
      case 'addTest': { const list = this.tests(); list.push({ id: T.newId(), name: '', input: String(m.input || ''), expected: '' }); this.saveTests(list); this.push(); break; }
      case 'updateTest': {
        const list = this.tests(); const t = list.find((x) => x.id === m.id);
        if (t) { t.input = String(m.input); t.expected = String(m.expected); this.saveTests(list); s.results.delete(m.id); this.push(); }
        break;
      }
      case 'deleteTest': { this.saveTests(this.tests().filter((x) => x.id !== m.id)); if (s) s.results.delete(m.id); this.push(); break; }
      case 'acceptOutput': {
        const list = this.tests(); const t = list.find((x) => x.id === m.id); const r = s && s.results.get(m.id);
        if (t && r && r.actual !== undefined) { t.expected = r.actual; this.saveTests(list); s.results.set(m.id, { ...r, status: 'pass', diff: null }); this.push(); }
        break;
      }
      case 'openFullOutput': {
        if (!s || s.full === undefined) break;
        const f = path.join(path.dirname(outDirFor(this.file)), 'output', B.safeName(path.basename(this.file)) + '-stdout.txt');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, s.full);
        await vscode.window.showTextDocument(vscode.Uri.file(f), { preview: true });
        break;
      }
      case 'toolsOpen': this.toolsOpen = !!m.open; break;
      case 'stress': await this.stressTest(m); break;
      case 'benchmark': await this.benchmark(String(m.input || ''), m.runs || 10); break;
      default: break;
    }
  }
}

// ---------- status bar ----------

function updateStatusBar() {
  if (!status) return;
  const ed = vscode.window.activeTextEditor;
  const show = cfg().get('showStatusBar', true) && ed && F.languageOf(ed.document.fileName);
  if (running) {
    status.text = '$(debug-stop) Stop';
    status.tooltip = 'Stop the running program and its child processes';
    status.command = 'zovoRun.stop';
    status.show();
  } else if (show) {
    status.text = '$(play) Run';
    status.tooltip = `Build and run ${path.basename(ed.document.fileName)} (${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Alt+Enter)`;
    status.command = 'zovoRun.run';
    status.show();
  } else status.hide();
}

// ---------- activate ----------

function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Run C++ and C');
  diags = vscode.languages.createDiagnosticCollection('zovoRun');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  context.subscriptions.push(out, diags, status);
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'zovoRun', name: 'Run C++ and C Code' });
  registerSupport({ vscode, context, prefix: 'zovoRun', selfId: EXT_ID });
  pro = createPro({ vscode, context });
  panel = new InputPanel();
  vscode.commands.executeCommand('setContext', 'zovoRun.running', false);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('zovoRun.run', (uri) => cmdRun(uri));
  reg('zovoRun.runFolder', (uri) => cmdRun(uri, { folder: true }));
  reg('zovoRun.build', (uri) => cmdBuild(uri));
  reg('zovoRun.runOnly', (uri) => cmdRunOnly(uri));
  reg('zovoRun.stop', () => cmdStop());
  reg('zovoRun.debug', (uri) => cmdDebug(uri));
  reg('zovoRun.clean', () => cmdClean());
  reg('zovoRun.selectCompiler', () => cmdSelectCompiler());
  reg('zovoRun.showSetup', async () => { const r = await compilerFor('cpp', true); showSetup(r.ok ? { reason: `Found ${r.name} (${r.label}) at ${r.path}. The steps below are for another compiler.`, tried: r.tried || [] } : r); });
  reg('zovoRun.openInputPanel', async () => { await vscode.commands.executeCommand('zovoRun.inputPanel.focus'); });
  reg('zovoRun.runTests', async () => { await vscode.commands.executeCommand('zovoRun.inputPanel.focus'); await panel.ensureFile(); return panel.runTests(null); });
  reg('zovoRun.stressTest', async () => { await vscode.commands.executeCommand('zovoRun.inputPanel.focus'); panel.toolsOpen = true; panel.push(); });
  reg('zovoRun.benchmark', async () => { await vscode.commands.executeCommand('zovoRun.inputPanel.focus'); await panel.ensureFile(); return panel.benchmark(panel.file ? panel.st().input : '', 10); });
  reg('zovoRun.openBinaryInHex', () => cmdOpenBinaryInHex());
  reg('zovoRun.openLinkerMap', () => cmdOpenLinkerMap());
  reg('zovoRun.showOutput', () => out.show());
  reg('zovoRun.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#zovoRun.start`, false));
  reg('zovoRun.openSample', async () => {
    const f = path.join(context.extensionPath, 'samples', 'read-input.cpp');
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('zovoRun.inputPanel', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { updateStatusBar(); if (panel) panel.follow(ed); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('zovoRun.cCompiler') || e.affectsConfiguration('zovoRun.cppCompiler') || e.affectsConfiguration('zovoRun.preferredCompiler')) compilerCache.clear();
      if (e.affectsConfiguration('zovoRun.showStatusBar')) updateStatusBar();
    }),
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) terminal = null; }),
    { dispose: () => { if (running) running.stop(); } },
  );
  updateStatusBar();
  if (process.env.ZOVO_RUN_GATE === '1') {
    return { gate, panel: () => panel, diags: () => diags, compilerFor, lastBuild, running: () => running, cmdRun, cmdBuild, terminalStatus: () => terminalStatus };
  }
  return undefined;
}

function deactivate() {
  if (running) running.stop();
}

module.exports = { activate, deactivate };
