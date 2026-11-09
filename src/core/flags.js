'use strict';
// Language detection, default flags and the per-file comment lines:
//   // run: -O2 -lm utils.c      extra compiler flags (and extra source files) for this file only
//   // args: "Hello World" 42    program arguments, split like a shell would, but no shell ever runs
// Pure functions, unit tested in test/flags.test.js.

const C_EXT = new Set(['.c']);
const CPP_EXT = new Set(['.cpp', '.cc', '.cxx', '.c++', '.cp']);
const HEADER_EXT = new Set(['.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ipp']);

function extOf(file) {
  const m = /(\.[^./\\]+)$/.exec(String(file));
  return m ? m[1] : '';
}

/** 'c', 'cpp' or '' for a source file name. ".C" (capital) is C++, as gcc treats it. */
function languageOf(file) {
  const e = extOf(file);
  if (e === '.C') return 'cpp';
  const l = e.toLowerCase();
  if (C_EXT.has(l)) return 'c';
  if (CPP_EXT.has(l)) return 'cpp';
  return '';
}

const isHeader = (file) => HEADER_EXT.has(extOf(file).toLowerCase());

/**
 * Splits a command line into arguments: spaces separate, "double" and 'single' quotes group, a backslash escapes
 * a quote, a space or a backslash (any other backslash stays, so C:\path\file works). Nothing is expanded.
 */
function splitArgs(s) {
  const out = [];
  let cur = '';
  let has = false;
  let q = '';
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) {
      if (ch === q) { q = ''; continue; }
      if (ch === '\\' && q === '"' && (str[i + 1] === '"' || str[i + 1] === '\\')) { cur += str[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (ch === '\\' && /["' \\]/.test(str[i + 1] || '')) { cur += str[++i]; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = ''; has = false;
      continue;
    }
    cur += ch; has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Quotes one argument for display in the output channel (never executed). */
function quoteForDisplay(a) {
  const s = String(a);
  if (s && /^[\w@%+=:,./-]+$/.test(s)) return s;
  return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
}

const DIRECTIVE = /^\s*(?:\/\/+|\/\*+|\*)\s*(run|args)\s*:(.*?)(?:\*\/\s*)?$/i;
const MAX_DIRECTIVE_LINES = 40;

/**
 * Reads the comment lines "run:" and "args:" from the first 40 lines of a source file.
 * Several lines of one kind add up. Returns { flags: [], args: [], lines: {run: n, args: n} } (lines are 0-based).
 */
function readDirectives(text) {
  const res = { flags: [], args: [], lines: {} };
  const lines = String(text || '').split(/\r?\n/, MAX_DIRECTIVE_LINES);
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const parts = splitArgs(m[2].trim());
    if (kind === 'run') res.flags.push(...parts);
    else res.args.push(...parts);
    if (res.lines[kind] === undefined) res.lines[kind] = i;
  }
  return res;
}

const DEFAULT_FLAGS = {
  c: ['-std=c17', '-Wall', '-Wextra', '-g', '-O0'],
  cpp: ['-std=c++20', '-Wall', '-Wextra', '-g', '-O0'],
};

// Older compilers do not know the newest standards. Each failure moves one step down this list.
const STD_FALLBACK = {
  'c++23': 'c++20', 'c++2b': 'c++20', 'c++20': 'c++2a', 'c++2a': 'c++17', 'c++17': 'c++14',
  'gnu++20': 'gnu++17', 'c2x': 'c17', 'c23': 'c17', 'c17': 'c11', 'c18': 'c11', 'gnu17': 'gnu11',
};

/** True when compiler output says the -std value is unknown (gcc and clang wording). */
function stdUnsupported(output) {
  return /unrecognized command[- ]line option ['"‘]?-std=|invalid value ['"‘][^'"’]+['"’] in ['"‘]-std=|unrecognized option ['"‘]-std=/i.test(String(output || ''));
}

/** Replaces the last -std=X in flags with the next lower standard, or returns null. */
function lowerStd(flags) {
  for (let i = flags.length - 1; i >= 0; i--) {
    const m = /^-std=(.+)$/.exec(flags[i]);
    if (!m) continue;
    const next = STD_FALLBACK[m[1]];
    if (!next) return null;
    const out = flags.slice();
    out[i] = '-std=' + next;
    return { flags: out, from: m[1], to: next };
  }
  return null;
}

/** Splits extra items from "run:" into compiler flags and extra source files (relative to the file's folder). */
function splitSources(items) {
  const flags = [];
  const sources = [];
  for (const it of items) {
    if (!it.startsWith('-') && (languageOf(it) || /\.(o|obj|a|lib)$/i.test(it))) sources.push(it);
    else flags.push(it);
  }
  return { flags, sources };
}

/** The linker map file named by -Wl,-Map=FILE / -Wl,-Map,FILE / -Wl,-map,FILE in flags, or ''. */
function linkerMapFile(flags) {
  for (const f of flags) {
    const m = /^-Wl,(?:--?Map[=,]|-map,)(.+)$/i.exec(f);
    if (m) return m[1].split(',')[0];
  }
  return '';
}

module.exports = {
  languageOf, isHeader, extOf, splitArgs, quoteForDisplay, readDirectives, DEFAULT_FLAGS, lowerStd, stdUnsupported,
  splitSources, linkerMapFile, MAX_DIRECTIVE_LINES,
};
