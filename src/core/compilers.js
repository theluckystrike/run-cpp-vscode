'use strict';
// Finds gcc, g++, clang and clang++ on PATH, and on Windows also in the usual MSYS2, WinLibs, MinGW, TDM and LLVM
// folders. It never downloads anything. The version comes from "<compiler> --version" (execFile, no shell).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NAMES = { c: ['gcc', 'clang', 'cc'], cpp: ['g++', 'clang++', 'c++'] };

function windowsDirs(env) {
  const drive = (env.SystemDrive || 'C:') + '\\';
  const pf = env.ProgramFiles || drive + 'Program Files';
  const pfx = env['ProgramFiles(x86)'] || drive + 'Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const dirs = [
    'msys64\\ucrt64\\bin', 'msys64\\mingw64\\bin', 'msys64\\clang64\\bin', 'msys64\\mingw32\\bin',
    'msys2\\ucrt64\\bin', 'msys2\\mingw64\\bin', 'mingw64\\bin', 'MinGW\\bin', 'mingw32\\bin', 'winlibs\\mingw64\\bin',
    'TDM-GCC-64\\bin', 'TDM-GCC-32\\bin', 'ProgramData\\chocolatey\\lib\\mingw\\tools\\install\\mingw64\\bin', 'ProgramData\\mingw64\\mingw64\\bin',
  ].map((d) => drive + d);
  dirs.push(pf + '\\LLVM\\bin', pfx + '\\LLVM\\bin', pf + '\\mingw-w64\\x86_64-8.1.0-posix-seh-rt_v6-rev0\\mingw64\\bin');
  if (local) {
    // WinLibs from winget: %LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.*\mingw64\bin
    const wg = path.win32.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(wg)) if (/^BrechtSanders\.WinLibs/i.test(d)) dirs.push(path.win32.join(wg, d, 'mingw64', 'bin'));
    } catch (e) { /* not there */ }
  }
  if (env.USERPROFILE) dirs.push(path.win32.join(env.USERPROFILE, 'scoop', 'apps', 'gcc', 'current', 'bin'), path.win32.join(env.USERPROFILE, 'scoop', 'apps', 'llvm', 'current', 'bin'));
  return dirs;
}

/** All folders to search, PATH first. */
function searchDirs(platform = process.platform, env = process.env) {
  const sep = platform === 'win32' ? ';' : ':';
  const pathVar = env.PATH || env.Path || env.path || '';
  const dirs = pathVar.split(sep).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (platform === 'win32') dirs.push(...windowsDirs(env));
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  if (platform === 'linux') dirs.push('/usr/bin', '/usr/local/bin');
  return [...new Set(dirs)];
}

/**
 * Compiler candidates for a language, best first, as { name, path, source: 'PATH' | 'folder' }.
 * isFile(p) is injected for tests. Versioned Homebrew/Linux names (g++-14, clang++-18) are found too.
 */
function candidates(lang, { platform = process.platform, env = process.env, isFile = defaultIsFile, listDir = defaultListDir, prefer = 'auto' } = {}) {
  const exe = platform === 'win32' ? '.exe' : '';
  const names = NAMES[lang].slice();
  if (prefer === 'clang') names.sort((a, b) => (b.startsWith('clang') ? 1 : 0) - (a.startsWith('clang') ? 1 : 0));
  const out = [];
  const seen = new Set();
  const pathDirs = new Set(((env.PATH || env.Path || '') + '').split(platform === 'win32' ? ';' : ':'));
  const dirs = searchDirs(platform, env);
  for (const name of names) {
    for (const d of dirs) {
      const p = (platform === 'win32' ? path.win32 : path.posix).join(d, name + exe);
      const key = platform === 'win32' ? p.toLowerCase() : p;
      if (seen.has(key) || !isFile(p)) continue;
      seen.add(key);
      out.push({ name, path: p, source: pathDirs.has(d) ? 'PATH' : 'folder' });
    }
  }
  // versioned names (gcc-14, g++-13, clang-18) in PATH folders, newest first, after the plain names
  const re = lang === 'c' ? /^(gcc|clang)-(\d+)(\.exe)?$/ : /^(g\+\+|clang\+\+)-(\d+)(\.exe)?$/;
  const versioned = [];
  for (const d of dirs) {
    for (const f of listDir(d)) {
      const m = re.exec(f);
      if (!m) continue;
      const p = (platform === 'win32' ? path.win32 : path.posix).join(d, f);
      if (seen.has(p) || !isFile(p)) continue;
      seen.add(p);
      versioned.push({ name: f.replace(/\.exe$/, ''), path: p, source: pathDirs.has(d) ? 'PATH' : 'folder', v: Number(m[2]) });
    }
  }
  versioned.sort((a, b) => b.v - a.v);
  out.push(...versioned.map(({ v, ...x }) => x));
  return out;
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function defaultListDir(d) {
  try { return fs.readdirSync(d); } catch (e) { return []; }
}

/** "gcc 14.2.0", "clang 18.1.8", "Apple clang 17.0.0" from --version output. */
function parseVersion(text) {
  const first = String(text || '').split(/\r?\n/)[0] || '';
  let m = /Apple (?:LLVM|clang) version (\d+(?:\.\d+)*)/.exec(first);
  if (m) return { family: 'clang', label: 'Apple clang ' + m[1], version: m[1] };
  m = /clang version (\d+(?:\.\d+)*)/.exec(first);
  if (m) return { family: 'clang', label: 'clang ' + m[1], version: m[1] };
  if (/^\S*(gcc|g\+\+|cc|c\+\+)(-\d+)?(\.exe)?\s/i.test(first) || /Free Software Foundation/.test(text)) {
    const all = first.match(/\d+\.\d+(?:\.\d+)?/g);
    if (all) return { family: 'gcc', label: 'gcc ' + all[all.length - 1], version: all[all.length - 1] };
  }
  m = /(\d+\.\d+(?:\.\d+)?)/.exec(first);
  return { family: /clang/i.test(first) ? 'clang' : 'gcc', label: first.slice(0, 60) || 'unknown', version: m ? m[1] : '' };
}

/** Runs "--version" with a 8 s limit. Resolves { ok, ...parseVersion } and never rejects. */
function probe(compilerPath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(compilerPath, ['--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = (stdout || '') + (stderr || '');
      if (err && !text) return resolve({ ok: false, error: err.code === 'ENOENT' ? 'not found' : String(err.message || err) });
      // macOS: /usr/bin/gcc without the Command Line Tools prints "xcrun: error: invalid active developer path"
      if (/xcrun: error|xcode-select: note|no developer tools were found/i.test(text)) return resolve({ ok: false, error: 'The Xcode Command Line Tools are not installed.', needsXcode: true });
      if (err && err.code !== 0 && !/version/i.test(text)) return resolve({ ok: false, error: text.trim().split('\n')[0] });
      resolve({ ok: true, ...parseVersion(text) });
    });
  });
}

/** macOS only: true when /usr/bin/gcc and clang are usable (Command Line Tools or Xcode selected). */
function macToolsInstalled(isFile = defaultIsFile) {
  return isFile('/Library/Developer/CommandLineTools/usr/bin/clang') || isFile('/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
}

/**
 * Picks the compiler for a language. configured: a path or name from settings ('' = automatic).
 * Returns { ok: true, path, name, label, family } or { ok: false, reason, tried: [] }.
 */
async function find(lang, { configured = '', prefer = 'auto', platform = process.platform, env = process.env, probeFn = probe, isFile = defaultIsFile, listDir } = {}) {
  const tried = [];
  if (configured) {
    let p = configured;
    if (!/[\\/]/.test(p)) {
      const hit = searchDirs(platform, env).map((d) => path.join(d, p + (platform === 'win32' && !/\.exe$/i.test(p) ? '.exe' : ''))).find(isFile);
      if (hit) p = hit;
    }
    const r = await probeFn(p);
    tried.push({ path: p, ok: r.ok, error: r.error });
    if (r.ok) return { ok: true, path: p, name: path.basename(p).replace(/\.exe$/i, ''), ...r, source: 'setting' };
    return { ok: false, reason: `The compiler in settings (${configured}) does not run: ${r.error}`, tried, setting: true };
  }
  if (platform === 'darwin' && !macToolsInstalled(isFile)) {
    // /usr/bin/gcc exists as a shim, but runs only after the Command Line Tools are installed. Homebrew gcc still works.
    const list = candidates(lang, { platform, env, isFile, listDir, prefer }).filter((c) => !c.path.startsWith('/usr/bin/'));
    for (const c of list) {
      const r = await probeFn(c.path);
      tried.push({ path: c.path, ok: r.ok, error: r.error });
      if (r.ok) return { ok: true, ...c, ...r };
    }
    return { ok: false, reason: 'The Xcode Command Line Tools are not installed.', needsXcode: true, tried };
  }
  for (const c of candidates(lang, { platform, env, isFile, listDir, prefer })) {
    const r = await probeFn(c.path);
    tried.push({ path: c.path, ok: r.ok, error: r.error });
    if (r.ok) return { ok: true, ...c, ...r };
    if (tried.length >= 8) break;
  }
  return { ok: false, reason: lang === 'c' ? 'No C compiler (gcc or clang) was found.' : 'No C++ compiler (g++ or clang++) was found.', tried };
}

module.exports = { candidates, searchDirs, parseVersion, probe, find, macToolsInstalled, NAMES };
