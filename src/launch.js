'use strict';
// Runs inside the integrated terminal (a real TTY), so scanf/cin and prompts work as in any shell, with no shell
// in between: the program and its arguments come in as an argument array.
//   node launch.js <status.json> <program> [args...]
// It writes the program's pid to status.json (for Stop), and at the end prints the exit code, run time and peak
// memory, then waits for a key so the output stays on screen.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const proc = require('./core/proc');

const [statusFile, program, ...args] = process.argv.slice(2);
const color = !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const write = (o) => { try { fs.writeFileSync(statusFile + '.tmp', JSON.stringify(o)); fs.renameSync(statusFile + '.tmp', statusFile); } catch (e) { /* folder gone */ } };

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ZOVO_RUN_LAUNCHER;

process.on('SIGINT', () => { /* Ctrl+C goes to the program; this launcher stays to print the result */ });
const label = process.env.ZOVO_RUN_LABEL || path.basename(program);
delete env.ZOVO_RUN_LABEL;
process.stdout.write(c('2', `▶ ${label}${args.length ? ' ' + args.map((a) => (/\s/.test(a) || !a ? JSON.stringify(a) : a)).join(' ') : ''}`) + '\r\n');

const t0 = process.hrtime.bigint();
let child;
try {
  child = spawn(program, args, { stdio: 'inherit', env, cwd: process.cwd() });
} catch (e) {
  finish(null, null, String(e.message || e));
}
if (child) {
  write({ state: 'running', pid: child.pid, launcher: process.pid, start: Date.now() });
  const mem = child.pid ? proc.memorySampler(child.pid) : { stop: () => 0 };
  child.on('error', (e) => { mem.stop(); finish(null, null, String(e.message || e)); });
  child.on('exit', (code, signal) => finish(code, signal, '', mem.stop()));
}

let done = false;
function finish(code, signal, error, peakKB = 0) {
  if (done) return;
  done = true;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const stopped = fs.existsSync(statusFile + '.stop');
  const ex = error ? { short: 'did not start', detail: error, ok: false } : proc.describeExit(code, signal, { stopped });
  const parts = [ex.short, proc.formatMs(ms)];
  if (peakKB) parts.push('peak memory ' + proc.formatKB(peakKB));
  process.stdout.write('\r\n' + c(ex.ok ? '32' : '31', `── ${parts.join(' · ')} ──`) + '\r\n');
  if (ex.detail) process.stdout.write(c('33', ex.detail) + '\r\n');
  write({ state: 'done', code, signal, ms, peakKB, exit: ex, stopped });
  process.stdout.write(c('2', 'Press any key to close this terminal.') + '\r\n');
  const stdin = process.stdin;
  try {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', () => process.exit(0));
    stdin.once('end', () => process.exit(0));
  } catch (e) { process.exit(0); }
}
