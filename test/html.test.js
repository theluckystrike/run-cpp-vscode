'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { panelHtml, setupHtml } = require('../src/html');

test('panel CSP: default-src none, nonce scripts, no connect-src', () => {
  const h = panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'x/panel.js', styleUri: 'x/panel.css', nonce: 'abc' });
  assert.match(h, /default-src 'none'/);
  assert.match(h, /script-src 'nonce-abc'/);
  assert.doesNotMatch(h, /connect-src/);
  assert.match(h, /<script nonce="abc" src="x\/panel.js">/);
});

test('setup page: per OS, escapes the reason, official links only', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const h = setupHtml({ cspSource: 's', styleUri: 'c', platform, reason: '<img src=x onerror=alert(1)>', tried: [{ path: 'C:\\a<b>', error: 'x' }], nonce: 'n' });
    assert.doesNotMatch(h, /<img src=x/);
    assert.match(h, /&lt;img/);
    for (const u of h.match(/https:\/\/[^"<\s]+/g) || []) assert.match(u, /^https:\/\/(developer\.apple\.com|formulae\.brew\.sh|www\.msys2\.org|winlibs\.com|github\.com\/llvm|gcc\.gnu\.org|clang\.llvm\.org)/, u);
  }
  assert.match(setupHtml({ platform: 'darwin', nonce: 'n' }), /xcode-select --install/);
  assert.match(setupHtml({ platform: 'win32', nonce: 'n' }), /msys64/);
  assert.match(setupHtml({ platform: 'linux', nonce: 'n' }), /build-essential/);
});

test('panel script uses no innerHTML and no network', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|fetch\(|XMLHttpRequest|WebSocket/);
});
