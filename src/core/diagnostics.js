'use strict';
// Parses gcc and clang output into problems with file, line and column. Pure, unit tested in test/diagnostics.test.js.
//
// Paths: the compiler prints the path it was given. On Windows, MinGW prints non-ASCII paths in the ANSI code page,
// which then shows as garbled text when read as UTF-8. resolvePath() maps such a path back to the file we compiled
// by its ASCII skeleton, so a problem in "大学/test.cpp" still lands on the right file and line.
const path = require('path');

const LINE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|remark|Error|Warning)\s*:\s*(.*)$/;
const LINKER = /(undefined reference to|Undefined symbols for architecture|multiple definition of|duplicate symbol|ld returned \d+ exit status|linker command failed|cannot find -l|library not found for -l|ld: )/;

/** Turns compiler text into raw problems: { file, line, col, severity: 'error'|'warning'|'info', message, notes: [] } */
function parse(text) {
  const out = [];
  let last = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const m = LINE.exec(line);
    if (!m) continue;
    const [, file, ln, col, kind, msg] = m;
    if (/^In (file included|function|member function|instantiation)/.test(file)) continue;
    const k = kind.toLowerCase();
    const item = { file: file.trim(), line: Number(ln), col: col ? Number(col) : 1, message: msg.trim(), notes: [] };
    if (k === 'note' || k === 'remark') {
      if (last) last.notes.push(item);
      continue;
    }
    item.severity = k === 'warning' ? 'warning' : 'error';
    out.push(item);
    last = item;
  }
  return out;
}

/** Linker errors have no line. Returns the meaningful lines (at most 6) or []. */
function linkerErrors(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => LINKER.test(l) || /^"_?[\w:~<>]+.*", referenced from:$/.test(l) || /^_?\w+ in .+\.o$/.test(l));
  return hits.slice(0, 6);
}

/** A friendly hint for common linker errors. */
function linkerHint(lines) {
  const t = lines.join('\n');
  if (/undefined reference to [`'‘](sqrt|pow|sin|cos|tan|log|exp|floor|ceil|fabs|round)\b/.test(t)) return 'Math functions need -lm. Add the line "// run: -lm" at the top of the file.';
  if (/undefined reference to [`'‘]main'|_main", referenced from|symbol\(s\) not found.*\n?.*_main/.test(t)) return 'There is no main() function in this file. To build several files together, use "Build and Run All Files in This Folder".';
  if (/undefined reference|Undefined symbols/.test(t)) return 'A function is declared but its code is in another file. Use "Build and Run All Files in This Folder", or list the other file in a "// run: other.c" line.';
  if (/multiple definition|duplicate symbol/.test(t)) return 'The same function is defined in two files. In folder mode every .c/.cpp file in the folder is built.';
  return '';
}

const skeleton = (p) => String(p).replace(/\\/g, '/').replace(/[^\x20-\x7e]+/g, '\u0000').replace(/\u0000+/g, '\u0000');

/**
 * Maps a path printed by the compiler to a real file. cwd is where the compiler ran, sources the files we passed.
 * exists(p) is injected so the function stays pure. Returns an absolute path, or null when the file is unknown.
 */
function resolvePath(printed, cwd, sources, exists) {
  const p = String(printed).trim();
  const abs = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : path.join(cwd, p);
  if (!/[�]/.test(p) && exists(abs)) return abs;
  // garbled or not found: match a compiled file by name, then by the ASCII skeleton of the path
  const norm = (x) => x.replace(/\\/g, '/');
  const pn = norm(p);
  for (const s of sources) if (norm(s).endsWith('/' + pn) || norm(s) === pn) return s;
  const sk = skeleton(pn);
  // exact: the garbled runs sit where the real path has non-ASCII runs
  const exact = sources.filter((s) => skeleton(norm(s)).endsWith(sk.startsWith('\u0000') || sk.startsWith('/') ? sk : '/' + sk) || skeleton(norm(s)) === sk);
  if (exact.length === 1) return exact[0];
  const hits = sources.filter((s) => {
    const ss = skeleton(norm(s));
    if (!/\u0000/.test(sk)) return ss.endsWith(sk);
    // the garbled runs become one "unknown" mark; compare the ASCII parts in order, from the end
    const parts = sk.split('\u0000');
    let pos = ss.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const at = ss.lastIndexOf(parts[i], pos - (i === parts.length - 1 ? 0 : 1));
      if (at < 0) return false;
      if (i === parts.length - 1 && at + parts[i].length !== ss.length) return false;
      pos = at;
    }
    return true;
  });
  if (hits.length === 1) return hits[0];
  if (/[�]/.test(p) && sources.length === 1) return sources[0];
  return exists(abs) ? abs : null;
}

module.exports = { parse, linkerErrors, linkerHint, resolvePath };
