// README and walkthrough screenshots from a real VS Code with the packaged extension installed. Real compiler, real
// programs, nothing outside this computer is contacted.
//   node scripts/shots.mjs --vsix dist/x.vsix --work ~/run-cpp-work/shots --port 9260 --mode hero|panel [--theme "Default Light Modern"]
import fs from 'node:fs';
import path from 'node:path';
import { installVsix, launch, sleep } from './vsc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const port = Number(arg('port', 9260));
const mode = arg('mode', 'hero');
const theme = arg('theme', mode === 'panel' ? 'Default Light Modern' : 'Default Dark Modern');
const outDir = path.resolve(arg('out', path.join(root, 'images')));

fs.rmSync(work, { recursive: true, force: true });
const demo = path.join(work, 'contest');
fs.mkdirSync(path.join(demo, '.zovo-run', 'tests'), { recursive: true });
const scores = path.join(demo, 'scores.cpp');
fs.writeFileSync(scores, `// run: -O2
#include <iostream>
#include <string>
#include <vector>
#include <numeric>

int main() {
    std::string name;
    std::cout << "Your name: " << std::flush;
    std::getline(std::cin, name);

    int n = 0;
    std::cout << "How many scores? " << std::flush;
    std::cin >> n;

    std::vector<double> scores(n);
    for (int i = 0; i < n; i++) {
        std::cout << "Score " << i + 1 << ": " << std::flush;
        std::cin >> scores[i];
    }

    double avg = std::accumulate(scores.begin(), scores.end(), 0.0) / n;
    std::cout << "Hi " << name << ", your average is " << avg << "\\n";
    return 0;
}
`);
const sum = path.join(demo, 'sum.cpp');
fs.writeFileSync(sum, `#include <iostream>

// Reads two numbers and prints their sum.
int main() {
    int a, b;
    std::cin >> a >> b;
    std::cout << a + b << "\\n";
    return 0;
}
`);
fs.writeFileSync(path.join(demo, '.zovo-run', 'tests', 'sum.cpp.json'), JSON.stringify({ file: 'sum.cpp', tests: [
  { id: 'a1', name: 'small', input: '2 3\n', expected: '5\n' },
  { id: 'a2', name: 'negative', input: '-7 10\n', expected: '3\n' },
  { id: 'a3', name: 'large', input: '2000000000 2000000000\n', expected: '4000000000\n' },
] }, null, 1));

const inst = installVsix(work, vsix);
if (inst.code !== 0) { console.error(inst.out); process.exit(2); }
const vs = await launch(work, port, demo, {
  'workbench.colorTheme': theme, 'editor.minimap.enabled': false, 'editor.fontSize': 14, 'terminal.integrated.fontSize': 13,
  'zovoRun.askForRating': false, 'workbench.layoutControl.enabled': false, 'editor.stickyScroll.enabled': false,
  'terminal.integrated.enablePersistentSessions': false, 'workbench.editor.enablePreview': false, 'breadcrumbs.enabled': false,
  'terminal.integrated.gpuAcceleration': 'off', 'extensions.ignoreRecommendations': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.tips.enabled': false, 'chat.commandCenter.enabled': false,
});
try {
  await sleep(4000);
  if (mode === 'hero') {
    vs.open(scores);
    await sleep(3000);
    await vs.command('Run C++: Run C/C++ File');
    await sleep(6000); // build, then the terminal opens with focus
    await vs.command('View: Increase Current View Size');
    await vs.command('Terminal: Focus Terminal');
    await sleep(500);
    for (const line of ['Ana', '3', '92', '78.5', '88']) { await vs.type(line); await vs.key('Enter', 'Enter'); await sleep(500); }
    await sleep(2500);
    await vs.shot(path.join(outDir, 'hero-dark.png'));
    fs.copyFileSync(path.join(outDir, 'hero-dark.png'), path.join(outDir, 'terminal-dark.png'));
  } else {
    vs.open(sum);
    await sleep(3000);
    await vs.command('Run C++: Run with Input & Test Cases');
    await sleep(2500);
    // make the bottom panel tall: drag the sash above it up to y = 300
    const top = await vs.wbEval(`(() => { const p = document.querySelector('.part.panel'); const b = p.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 3, y: b.y }); })()`);
    const { x, y } = JSON.parse(top);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y - 2 }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: y - 2, button: 'left', clickCount: 1 }, vs.wb);
    for (let yy = y - 2; yy > 300; yy -= 40) { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: yy, button: 'left', buttons: 1 }, vs.wb); await sleep(16); }
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 300, button: 'left', buttons: 1 }, vs.wb);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: 300, button: 'left', clickCount: 1 }, vs.wb);
    await sleep(800);
    let wv = null;
    for (let i = 0; i < 40 && !wv; i++) { wv = (await vs.webviews())[0] || null; if (!wv) await sleep(250); }
    if (!wv) throw new Error('panel webview not found');
    await vs.wvEval(wv, `(() => { const t = document.getElementById('input'); t.value = '2 3\\n'; t.dispatchEvent(new Event('input')); return 1; })()`);
    await vs.wvClick(wv, `document.getElementById('run')`);
    await sleep(4000);
    await vs.wvClick(wv, `document.getElementById('runAll')`);
    await sleep(3000);
    await vs.wvEval(wv, `(() => { const e = document.querySelector('.test.fail'); if (e) e.scrollIntoView({ block: 'end' }); return 1; })()`).catch(() => 0);
    await sleep(500);
    await vs.shot(path.join(outDir, 'panel-light.png'));
  }
  console.log('console errors:', JSON.stringify(vs.console.filter((c) => /zovo|run-cpp|panel\.js/i.test(c.where + c.text)).slice(0, 10)));
} finally {
  await vs.close();
  fs.rmSync(work, { recursive: true, force: true });
}
