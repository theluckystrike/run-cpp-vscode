'use strict';
// Builds one file, or every .c/.cpp file of a folder, with gcc or clang. Arguments always go in an array to spawn;
// paths with spaces, '&', quotes or non-ASCII characters need no quoting. Source files are listed one by one
// (never a *.cpp wildcard).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const F = require('./flags');

const MAX_OUTPUT = 4 * 1024 * 1024; // compiler output kept, per build

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const safeName = (s) => String(s).normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 60) || 'program';

/** Every .c/.cpp source in a folder (not recursive), sorted. */
function folderSources(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter((n) => F.languageOf(n) && !n.startsWith('.')).sort().map((n) => path.join(dir, n));
}

/** Newest modification time of the sources and the headers next to them. */
function newestInput(sources) {
  let t = 0;
  const dirs = new Set(sources.map((s) => path.dirname(s)));
  for (const s of sources) { try { t = Math.max(t, fs.statSync(s).mtimeMs); } catch (e) { return Infinity; } }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) if (F.isHeader(n)) { try { t = Math.max(t, fs.statSync(path.join(d, n)).mtimeMs); } catch (e) { /* gone */ } }
  }
  return t;
}

/**
 * Plans a build. opts:
 *   main: the file the user ran (absolute); folder: true to build every source in its folder
 *   text: the main file's text (for the run:/args: lines); compilers: { c: path, cpp: path }
 *   flags: { c: [], cpp: [], link: [] } from settings; outDir: where the program goes; platform
 * Returns { lang, sources, binary, steps: [{ exe, args, cwd, label }], args (program arguments), directives, mapFile }.
 */
function plan(opts) {
  const platform = opts.platform || process.platform;
  const main = opts.main;
  const cwd = path.dirname(main);
  const d = F.readDirectives(opts.text || '');
  const extra = F.splitSources(d.flags);
  let sources = opts.folder ? folderSources(cwd) : [main];
  if (!sources.includes(main)) sources.unshift(main);
  for (const s of extra.sources) {
    const abs = path.resolve(cwd, s);
    if (!sources.includes(abs)) sources.push(abs);
  }
  const srcOnly = sources.filter((s) => F.languageOf(s));
  const objs = sources.filter((s) => !F.languageOf(s));
  const langs = new Set(srcOnly.map(F.languageOf));
  const lang = langs.has('cpp') ? 'cpp' : 'c';
  const exe = platform === 'win32' ? '.exe' : '';
  const base = opts.folder ? safeName(path.basename(cwd)) + '-folder' : safeName(path.basename(main).replace(/\.[^.]+$/, ''));
  const binary = path.join(opts.outDir, `${base}-${hash(opts.folder ? cwd : main)}${exe}`);
  const settingsFlags = (opts.flags && opts.flags[lang]) || F.DEFAULT_FLAGS[lang];
  const link = (opts.flags && opts.flags.link) || [];
  const always = ['-fdiagnostics-color=never', '-fmessage-length=0'];
  const mathLib = langs.has('c') && opts.linkMath !== false && !link.includes('-lm') && !extra.flags.includes('-lm') ? ['-lm'] : [];
  // A file next to the main file goes in by name; a name that starts with '-' gets './' so the compiler never reads it as an option.
  const rel = (s) => {
    if (path.dirname(s) !== cwd) return s;
    const b = path.basename(s);
    return b.startsWith('-') ? '.' + path.sep + b : b;
  };
  const steps = [];
  if (langs.size > 1) {
    // mixed C and C++: compile each file to an object with its own compiler, then link with the C++ compiler
    const objDir = binary + '.obj';
    const outObjs = [];
    for (const s of srcOnly) {
      const l = F.languageOf(s);
      const o = path.join(objDir, safeName(path.basename(s)) + '-' + hash(s) + '.o');
      outObjs.push(o);
      steps.push({ exe: opts.compilers[l], args: [...((opts.flags && opts.flags[l]) || F.DEFAULT_FLAGS[l]), ...always, ...extra.flags.filter((f) => !/^-l|^-L|^-Wl,/.test(f)), '-c', rel(s), '-o', o], cwd, label: path.basename(s), mkdir: objDir });
    }
    steps.push({ exe: opts.compilers.cpp, args: [...outObjs, ...objs, ...extra.flags, ...link, ...mathLib, '-o', binary], cwd, label: 'link' });
  } else {
    steps.push({ exe: opts.compilers[lang], args: [...settingsFlags, ...always, ...srcOnly.map(rel), ...objs, ...extra.flags, ...link, ...mathLib, '-o', binary], cwd, label: srcOnly.length > 1 ? `${srcOnly.length} files` : path.basename(main) });
  }
  return { lang, sources: srcOnly, binary, steps, args: d.args, directives: d, mapFile: F.linkerMapFile(extra.flags) ? path.resolve(cwd, F.linkerMapFile(extra.flags)) : '', cwd };
}

const stamp = (p) => p.binary + '.json';
const planKey = (p) => hash(JSON.stringify(p.steps.map((s) => [s.exe, s.args])));

/** True when the program exists, was built from the same command, and is newer than every source and header. */
function upToDate(p) {
  try {
    const st = JSON.parse(fs.readFileSync(stamp(p), 'utf8'));
    if (st.key !== planKey(p)) return false;
    return fs.statSync(p.binary).mtimeMs >= newestInput(p.sources);
  } catch (e) { return false; }
}

/** English compiler messages (the parser reads "error:" and "warning:"); paths and text stay as they are. */
function compilerEnv() {
  const env = { ...process.env, LANGUAGE: 'C' };
  if (process.platform !== 'win32') {
    if (env.LC_ALL) env.LC_ALL = 'C';
    env.LC_MESSAGES = 'C';
  }
  return env;
}

function runStep(step, onOutput, token) {
  return new Promise((resolve) => {
    if (step.mkdir) fs.mkdirSync(step.mkdir, { recursive: true });
    let out = '';
    let size = 0;
    const t0 = Date.now();
    let child;
    try {
      child = spawn(step.exe, step.args, { cwd: step.cwd, windowsHide: true, env: compilerEnv() });
    } catch (e) {
      resolve({ code: -1, output: String(e.message || e), ms: 0, spawnError: true });
      return;
    }
    const take = (b) => {
      size += b.length;
      if (out.length < MAX_OUTPUT) { const s = b.toString('utf8'); out += s; if (onOutput) onOutput(s); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const cancel = token && token.onCancellationRequested ? token.onCancellationRequested(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }) : null;
    child.on('error', (e) => { out += String(e.message || e); });
    child.on('close', (code, signal) => {
      if (cancel) cancel.dispose();
      resolve({ code: code === null ? -1 : code, signal, output: out, ms: Date.now() - t0, truncated: size > MAX_OUTPUT, spawnError: code === null && !signal && /ENOENT|EACCES/.test(out) });
    });
  });
}

/**
 * Runs the plan. Retries once per step with a lower -std when the compiler does not know the standard.
 * Resolves { ok, output, ms, skipped, stdNote }.
 */
async function compile(p, { onOutput, token, force = false } = {}) {
  if (!force && upToDate(p)) return { ok: true, output: '', ms: 0, skipped: true };
  fs.mkdirSync(path.dirname(p.binary), { recursive: true });
  try { fs.unlinkSync(p.binary); } catch (e) { /* first build */ }
  let all = '';
  let ms = 0;
  let stdNote = '';
  for (let i = 0; i < p.steps.length; i++) {
    let step = p.steps[i];
    let r = await runStep(step, onOutput, token);
    for (let tries = 0; r.code !== 0 && F.stdUnsupported(r.output) && tries < 3; tries++) {
      const lower = F.lowerStd(step.args);
      if (!lower) break;
      stdNote = `This compiler does not know -std=${lower.from}; built with -std=${lower.to}.`;
      if (onOutput) onOutput(`\n${stdNote}\n`);
      step = { ...step, args: lower.flags };
      p.steps[i] = step;
      r = await runStep(step, onOutput, token);
    }
    all += r.output;
    ms += r.ms;
    if (r.code !== 0) return { ok: false, output: all, ms, code: r.code, spawnError: r.spawnError, stdNote };
  }
  try { fs.writeFileSync(stamp(p), JSON.stringify({ key: planKey(p), sources: p.sources, at: Date.now() })); } catch (e) { /* read-only */ }
  return { ok: fs.existsSync(p.binary), output: all, ms, stdNote };
}

/** The text shown in the output channel for one step (display only; nothing runs through a shell). */
function displayCommand(step) {
  return [step.exe, ...step.args].map(F.quoteForDisplay).join(' ');
}

module.exports = { plan, compile, upToDate, folderSources, displayCommand, safeName, hash };
