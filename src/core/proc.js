'use strict';
// Process helpers: kill a program and all its child processes, sample peak memory, and explain exit codes.
// Everything uses execFile/spawn with argument arrays. No shell string is ever built.
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

/** Child processes of pid, recursively (POSIX: one "ps" call). */
function descendants(pid) {
  if (process.platform === 'win32') return [];
  let text = '';
  try { text = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }); } catch (e) { return []; }
  const kids = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const p = Number(m[1]); const pp = Number(m[2]);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const out = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    for (const k of kids.get(p) || []) { out.push(k); stack.push(k); }
  }
  return out;
}

/** Kills pid and every process it started. group: also signal the process group -pid (spawned with detached). */
function killTree(pid, { group = false } = {}) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (e) { /* gone */ }
    return;
  }
  const all = descendants(pid);
  if (group) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* not a group */ } }
  for (const p of [pid, ...all]) { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } }
}

/** Resident memory of one process in KB, or 0. Linux: VmHWM (true peak). macOS: ps rss. Windows: tasklist. */
function sampleKB(pid, cb) {
  if (process.platform === 'linux') {
    fs.readFile(`/proc/${pid}/status`, 'utf8', (err, t) => {
      if (err) return cb(0);
      const m = /VmHWM:\s+(\d+)\s*kB/.exec(t) || /VmRSS:\s+(\d+)\s*kB/.exec(t);
      cb(m ? Number(m[1]) : 0);
    });
    return;
  }
  if (process.platform === 'win32') {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 2000 }, (err, out) => {
      const m = /"([\d.,\s ]+) K"/.exec(String(out || ''));
      cb(m ? Number(m[1].replace(/[^\d]/g, '')) : 0);
    });
    return;
  }
  execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, out) => cb(Number(String(out || '').trim()) || 0));
}

// A started C or C++ program uses more than this; smaller values come from the moment before exec.
const MIN_REAL_KB = 200;

/** Samples memory of pid every intervalMs until stop() is called. stop() returns the peak in KB (0 if none). */
function memorySampler(pid, intervalMs = 50) {
  let peak = 0;
  let busy = false;
  let stopped = false;
  const tick = () => {
    if (busy || stopped) return;
    busy = true;
    sampleKB(pid, (kb) => { busy = false; if (kb >= MIN_REAL_KB && kb > peak) peak = kb; });
  };
  // The first sample waits 10 ms: right after spawn the process may not have started the program yet.
  const first = setTimeout(tick, 10);
  const t = setInterval(tick, process.platform === 'win32' ? Math.max(intervalMs, 250) : intervalMs);
  if (t.unref) t.unref();
  if (first.unref) first.unref();
  return { stop() { stopped = true; clearTimeout(first); clearInterval(t); return peak; }, get peak() { return peak; } };
}

const SIGNALS = {
  SIGSEGV: 'Segmentation fault: the program read or wrote memory it does not own (a bad pointer, an array index out of range, or a stack overflow).',
  SIGBUS: 'Bus error: a bad memory access (often a bad pointer).',
  SIGABRT: 'Aborted: abort() was called, often by a failed assert() or an uncaught C++ exception.',
  SIGFPE: 'Arithmetic error: often an integer division by zero.',
  SIGILL: 'Illegal instruction: often undefined behaviour, or a function that does not return a value.',
  SIGKILL: 'Stopped (killed).',
  SIGTERM: 'Stopped (terminated).',
  SIGINT: 'Interrupted (Ctrl+C).',
  SIGPIPE: 'Broken pipe: the program wrote to a closed output.',
  SIGTRAP: 'Trace trap: often __builtin_trap() or a sanitizer stop.',
};
const NUM = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM', 2: 'SIGINT' };
const WIN = {
  3221225477: ['STATUS_ACCESS_VIOLATION', SIGNALS.SIGSEGV],
  3221225725: ['STATUS_STACK_OVERFLOW', 'Stack overflow: often a recursion that never ends.'],
  3221225620: ['STATUS_INTEGER_DIVIDE_BY_ZERO', SIGNALS.SIGFPE],
  3221225501: ['STATUS_ILLEGAL_INSTRUCTION', SIGNALS.SIGILL],
  3221226505: ['STATUS_STACK_BUFFER_OVERRUN', 'Stack buffer overrun: the program wrote past the end of an array on the stack.'],
  3221225781: ['STATUS_DLL_NOT_FOUND', 'A DLL was not found. Add the compiler\'s bin folder to PATH, or link with -static.'],
  3221225785: ['STATUS_ENTRYPOINT_NOT_FOUND', 'A DLL does not match the program. Often an old libstdc++ DLL earlier in PATH; link with -static.'],
};

/** { short, detail } for an exit. code is a number or null, signal a name or null. */
function describeExit(code, signal, { stopped = false, timedOut = false } = {}) {
  if (timedOut) return { short: 'time limit', detail: 'Stopped: the time limit was reached. Change it in Settings: Run C++ › Time Limit Seconds.', ok: false };
  if (stopped) return { short: 'stopped', detail: 'Stopped by you.', ok: false };
  if (signal) {
    const name = typeof signal === 'number' ? NUM[signal] || `signal ${signal}` : signal;
    const num = Object.keys(NUM).find((k) => NUM[k] === name);
    return { short: `${name}${num ? ` (signal ${num})` : ''}`, detail: SIGNALS[name] || `The program was ended by ${name}.`, ok: false, signal: name };
  }
  if (code === 0) return { short: 'exit code 0', detail: '', ok: true };
  const u = code >>> 0;
  if (WIN[u]) return { short: `exit code 0x${u.toString(16).toUpperCase()} (${WIN[u][0]})`, detail: WIN[u][1], ok: false };
  if (code > 128 && code < 160 && NUM[code - 128]) {
    const name = NUM[code - 128];
    return { short: `exit code ${code} (${name})`, detail: SIGNALS[name], ok: false, signal: name };
  }
  return { short: `exit code ${code}`, detail: '', ok: false };
}

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
function formatKB(kb) {
  if (!kb) return '';
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

module.exports = { killTree, descendants, memorySampler, describeExit, formatMs, formatKB, sampleKB };
