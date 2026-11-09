'use strict';
// Runs a built program with input from the Input panel or a saved test case. stdout and stderr are captured up to a
// limit (default 32 MB for stdout, 4 MB for stderr). Past the limit only bytes and lines are counted, so a program that prints
// 1,000,000 lines cannot fill the memory of the editor. Stop and the time limit kill the program and its children.
const { spawn } = require('child_process');
const proc = require('./proc');

class Capture {
  constructor(limit) { this.limit = limit; this.parts = []; this.kept = 0; this.bytes = 0; this.lines = 0; this.lastByte = 10; }
  push(b) {
    this.bytes += b.length;
    for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) this.lines++;
    this.lastByte = b[b.length - 1];
    if (this.kept < this.limit) {
      const part = this.kept + b.length > this.limit ? b.subarray(0, this.limit - this.kept) : b;
      this.parts.push(part);
      this.kept += part.length;
    }
  }
  get truncated() { return this.bytes > this.kept; }
  get lineCount() { return this.lines + (this.bytes && this.lastByte !== 10 ? 1 : 0); }
  text() { return Buffer.concat(this.parts).toString('utf8'); }
}

/**
 * runProgram(binary, { args, cwd, input, timeLimitMs, captureBytes, env }) -> { promise, stop(), pid }
 * promise resolves { code, signal, ms, peakKB, stdout, stderr, stdoutBytes, stdoutLines, stderrBytes, truncated,
 *                    stopped, timedOut, exit: describeExit(...), spawnError }
 */
function runProgram(binary, opts = {}) {
  const { args = [], cwd, input = '', timeLimitMs = 0, captureBytes = 32 * 1024 * 1024, env } = opts;
  const out = new Capture(captureBytes);
  const err = new Capture(Math.min(captureBytes, 4 * 1024 * 1024));
  let child;
  let stopped = false;
  let timedOut = false;
  const t0 = process.hrtime.bigint();
  const promise = new Promise((resolve) => {
    try {
      child = spawn(binary, args, { cwd, env: env || process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, signal: null, ms: 0, peakKB: 0, stdout: '', stderr: String(e.message || e), spawnError: true, exit: { short: 'did not start', detail: String(e.message || e), ok: false } });
      return;
    }
    const mem = child.pid ? proc.memorySampler(child.pid) : { stop: () => 0 };
    let timer = null;
    if (timeLimitMs > 0) timer = setTimeout(() => { timedOut = true; proc.killTree(child.pid, { group: true }); }, timeLimitMs);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.stdin.on('error', () => { /* the program exited before reading all input */ });
    let spawnErr = null;
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const peakKB = mem.stop();
      if (spawnErr && code === null && !signal) {
        resolve({ code: null, signal: null, ms, peakKB: 0, stdout: '', stderr: String(spawnErr.message), spawnError: true, exit: { short: 'did not start', detail: String(spawnErr.message), ok: false } });
        return;
      }
      resolve({
        code, signal, ms, peakKB, stopped, timedOut,
        stdout: out.text(), stderr: err.text(), stdoutBytes: out.bytes, stdoutLines: out.lineCount, stderrBytes: err.bytes,
        truncated: out.truncated || err.truncated,
        exit: proc.describeExit(code, signal, { stopped, timedOut }),
      });
    });
    if (child.stdin) {
      if (input) child.stdin.write(input);
      child.stdin.end();
    }
  });
  return {
    promise,
    get pid() { return child && child.pid; },
    stop() { if (child && child.exitCode === null && !child.signalCode) { stopped = true; proc.killTree(child.pid, { group: true }); } },
  };
}

module.exports = { runProgram, Capture };
