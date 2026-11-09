'use strict';
// Webview HTML for the Input & Tests panel and the compiler setup page. Kept free of the vscode module so tests can
// check the CSP. No connect-src: the webviews never make a request.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} blob: data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, nonce?, showSupportLinks? } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = footerHtml('zovoRun', p.showSupportLinks !== false);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>Input &amp; Tests</title>
</head>
<body>
<div id="app"><p class="muted">Open a .c or .cpp file to run it with input.</p></div>
${footer}
<script nonce="${n}" src="${esc(p.scriptUri)}"></script>
</body>
</html>`;
}

const OFFICIAL = {
  darwin: {
    title: 'Install a C and C++ compiler on macOS',
    steps: [
      ['Install Apple\'s Command Line Tools (clang, clang++, and gcc/g++ as names for clang). Run this in Terminal and click Install:', 'xcode-select --install'],
      ['Optional, for the GNU compiler: install Homebrew, then:', 'brew install gcc'],
    ],
    links: [['Apple: Command Line Tools', 'https://developer.apple.com/xcode/resources/'], ['Homebrew gcc', 'https://formulae.brew.sh/formula/gcc']],
  },
  win32: {
    title: 'Install a C and C++ compiler on Windows',
    steps: [
      ['Install MSYS2 from msys2.org. Then, in the "MSYS2 UCRT64" terminal:', 'pacman -S --needed mingw-w64-ucrt-x86_64-gcc'],
      ['Or use WinLibs (no installer, unzip it). With winget:', 'winget install BrechtSanders.WinLibs.POSIX.UCRT'],
      ['Or LLVM clang with winget (needs the Visual Studio Build Tools or MinGW headers):', 'winget install LLVM.LLVM'],
      ['This extension also looks in C:\\msys64\\ucrt64\\bin, C:\\msys64\\mingw64\\bin, C:\\MinGW\\bin, C:\\mingw64\\bin, the WinLibs winget folder, TDM-GCC and C:\\Program Files\\LLVM\\bin, so adding the folder to PATH is optional.', ''],
    ],
    links: [['MSYS2', 'https://www.msys2.org/'], ['WinLibs', 'https://winlibs.com/'], ['LLVM releases', 'https://github.com/llvm/llvm-project/releases']],
  },
  linux: {
    title: 'Install a C and C++ compiler on Linux',
    steps: [
      ['Debian, Ubuntu, Mint:', 'sudo apt install build-essential'],
      ['Fedora, RHEL:', 'sudo dnf install gcc gcc-c++'],
      ['Arch, Manjaro:', 'sudo pacman -S base-devel'],
      ['openSUSE:', 'sudo zypper install gcc gcc-c++'],
      ['Or clang:', 'sudo apt install clang'],
    ],
    links: [['GCC', 'https://gcc.gnu.org/install/binaries.html'], ['Clang', 'https://clang.llvm.org/get_started.html']],
  },
};

/** p: { cspSource, styleUri, platform, reason, tried: [{path, error}], nonce? } */
function setupHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const os = OFFICIAL[p.platform] || OFFICIAL.linux;
  const tried = (p.tried || []).slice(0, 8).map((t) => `<li><code>${esc(t.path)}</code>: ${esc(t.error || 'did not run')}</li>`).join('');
  const steps = os.steps.map(([text, cmd]) => `<li><p>${esc(text)}</p>${cmd ? `<pre><code>${esc(cmd)}</code></pre>` : ''}</li>`).join('');
  const links = os.links.map(([t, u]) => `<a href="${esc(u)}">${esc(t)}</a>`).join(' · ');
  const script = `const vscode = acquireVsCodeApi(); document.getElementById('again').addEventListener('click', () => vscode.postMessage({ type: 'recheck' }));
document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(p.styleUri)}">
<title>Compiler setup</title>
</head>
<body class="setup">
<div id="app">
<h1>${esc(os.title)}</h1>
<p class="reason">${esc(p.reason || 'No compiler was found.')}</p>
<p>This extension uses the compiler on your computer. It never downloads one. Install one from the official source below, then click <b>Check again</b>. You do not need to restart VS Code.</p>
<ol class="steps">${steps}</ol>
<p>Official pages: ${links}</p>
<p><button id="again">Check again</button> <button id="settings" class="secondary">Set a compiler path in Settings</button></p>
${tried ? `<details><summary>Where this extension looked</summary><ul>${tried}</ul></details>` : ''}
</div>
<script nonce="${n}">${script}</script>
</body>
</html>`;
}

module.exports = { panelHtml, setupHtml, esc, OFFICIAL };
