// Input & Tests panel. All text goes in through textContent or value, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let S = null; // last state from the extension
  const open = new Set((vscode.getState() || {}).open || []);
  let inputDraft = null;

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const post = (type, data) => vscode.postMessage({ type, ...(data || {}) });
  const fmtMs = (ms) => (ms === undefined || ms === null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
  const fmtKB = (kb) => (!kb ? '' : kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`);
  const remember = () => vscode.setState({ open: [...open] });

  function stats(r) {
    if (!r) return null;
    const bits = [];
    bits.push(h('span', { class: 'pill ' + (r.exit && r.exit.ok ? 'ok' : 'bad'), 'data-k': 'exit' }, r.exit ? r.exit.short : ''));
    if (r.ms !== undefined) bits.push(h('span', { class: 'stat', 'data-k': 'time' }, fmtMs(r.ms)));
    if (r.peakKB) bits.push(h('span', { class: 'stat', 'data-k': 'mem' }, 'peak ' + fmtKB(r.peakKB)));
    if (r.stdoutLines !== undefined) bits.push(h('span', { class: 'stat muted' }, `${r.stdoutLines.toLocaleString('en-US')} ${r.stdoutLines === 1 ? 'line' : 'lines'}`));
    return h('div', { class: 'stats' }, bits);
  }

  function outputBlock(r) {
    if (!r) return h('pre', { class: 'out empty' }, 'Output appears here.');
    if (r.compileError) {
      return h('div', {}, h('div', { class: 'stats' }, h('span', { class: 'pill bad' }, 'compile error')),
        h('pre', { class: 'out err', 'data-k': 'compile' }, r.compileError),
        h('p', { class: 'muted' }, 'The errors are also in the Problems panel, at their lines.'));
    }
    const kids = [stats(r)];
    if (r.exit && r.exit.detail) kids.push(h('p', { class: 'detail', 'data-k': 'detail' }, r.exit.detail));
    kids.push(h('pre', { class: 'out', 'data-k': 'stdout' }, r.stdout || ''));
    if (r.previewNote) kids.push(h('p', { class: 'muted note' }, r.previewNote, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); post('openFullOutput'); } }, 'Open full output')));
    if (r.stderr) kids.push(h('div', { class: 'label' }, 'stderr'), h('pre', { class: 'out err', 'data-k': 'stderr' }, r.stderr));
    return h('div', {}, kids);
  }

  function diffTable(d) {
    if (!d || !d.rows || !d.rows.length) return null;
    const unit = d.unit === 'token' ? 'Token' : 'Line';
    const t = h('table', { class: 'diff' }, h('tr', {}, h('th', {}, unit), h('th', {}, 'Expected'), h('th', {}, 'Your output')));
    for (const r of d.rows) {
      t.append(h('tr', { class: r.same ? '' : 'neq' }, h('td', { class: 'n' }, String(r.n)),
        h('td', {}, r.expected === null ? h('i', { class: 'muted' }, '(no line)') : r.expected),
        h('td', {}, r.actual === null ? h('i', { class: 'muted' }, '(no line)') : r.actual)));
    }
    const u = unit.toLowerCase();
    const count = (n) => `${n} ${u}${n === 1 ? '' : 's'}`;
    return h('div', {}, h('p', { class: 'muted' }, `First difference at ${u} ${d.firstDiff + 1}. Expected ${count(d.expectedLines)}, got ${count(d.actualLines)}.`), t);
  }

  function testCard(t, i) {
    const st = t.status || 'new';
    const isOpen = open.has(t.id) || st === 'fail' || st === 'error';
    const head = h('div', { class: 'thead' },
      h('button', { class: 'link', title: isOpen ? 'Hide' : 'Show', onclick: () => { isOpen ? open.delete(t.id) : open.add(t.id); remember(); render(); } }, isOpen ? '▾' : '▸'),
      h('b', {}, t.name || `Test ${i + 1}`),
      h('span', { class: 'pill ' + (st === 'pass' ? 'ok' : st === 'fail' || st === 'error' ? 'bad' : 'idle'), 'data-k': 'status' }, st === 'new' ? 'not run' : st),
      t.ms !== undefined ? h('span', { class: 'stat' }, fmtMs(t.ms)) : null,
      t.peakKB ? h('span', { class: 'stat' }, fmtKB(t.peakKB)) : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'secondary small', disabled: S.running, onclick: () => post('runTest', { id: t.id }) }, 'Run'),
      h('button', { class: 'secondary small', title: 'Delete this test case', onclick: () => post('deleteTest', { id: t.id }) }, 'Delete'));
    const card = h('div', { class: 'test ' + st, 'data-id': t.id }, head);
    if (!isOpen) return card;
    const inp = h('textarea', { rows: 4, spellcheck: 'false', 'aria-label': 'Input', value: t.input });
    const exp = h('textarea', { rows: 4, spellcheck: 'false', 'aria-label': 'Expected output', value: t.expected });
    const save = () => post('updateTest', { id: t.id, input: inp.value, expected: exp.value });
    inp.addEventListener('change', save); exp.addEventListener('change', save);
    card.append(h('div', { class: 'cols' }, h('div', {}, h('div', { class: 'label' }, 'Input'), inp), h('div', {}, h('div', { class: 'label' }, 'Expected output'), exp)));
    if (t.exit && !t.exit.ok) card.append(h('p', { class: 'detail' }, t.exit.short + (t.exit.detail ? ': ' + t.exit.detail : '')));
    if (t.diff) card.append(diffTable(t.diff));
    if (t.actual !== undefined && st !== 'pass') {
      card.append(h('div', { class: 'row' }, h('button', { class: 'secondary small', onclick: () => post('acceptOutput', { id: t.id }) }, 'Use this output as expected')));
    }
    return card;
  }

  function render() {
    if (!S) return;
    const active = document.activeElement;
    const keepFocus = active && active.id === 'input' ? [active.selectionStart, active.selectionEnd] : null;
    app.textContent = '';
    if (!S.file) {
      app.append(h('p', { class: 'muted' }, 'Open a .c or .cpp file, then type its input here and press Run. Saved test cases show pass or fail with a diff.'));
      return;
    }
    const pass = S.tests.filter((t) => t.status === 'pass').length;
    const ran = S.tests.filter((t) => t.status && t.status !== 'new').length;
    app.append(h('div', { class: 'bar' },
      h('span', { class: 'file', title: S.file.path }, S.file.name),
      S.compiler ? h('span', { class: 'muted' }, S.compiler) : null,
      h('span', { class: 'grow' }),
      S.running
        ? h('button', { id: 'stop', class: 'danger', onclick: () => post('stop') }, '■ Stop')
        : h('button', { id: 'run', title: 'Build and run with this input (Ctrl+Enter in the input box)', onclick: () => post('run', { input: document.getElementById('input').value }) }, '▶ Run with input'),
      h('button', { id: 'runAll', class: 'secondary', disabled: S.running || !S.tests.length, onclick: () => post('runAll') }, `Run all tests${S.tests.length ? ` (${S.tests.length})` : ''}`)));

    const input = h('textarea', { id: 'input', rows: 8, spellcheck: 'false', placeholder: 'Input for the program (stdin)', value: inputDraft !== null ? inputDraft : S.input || '' });
    input.addEventListener('input', () => { inputDraft = input.value; post('inputChanged', { input: input.value }); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!S.running) post('run', { input: input.value }); } });
    const left = h('div', { class: 'pane' }, h('div', { class: 'label' }, 'Input'), input,
      h('div', { class: 'row' },
        h('button', { class: 'secondary small', disabled: !S.last || !!S.last.compileError || S.running, title: 'Save this input and the output on the right as a test case', onclick: () => post('saveTest', { input: input.value }) }, 'Save as test case'),
        h('button', { class: 'secondary small', onclick: () => post('addTest', { input: input.value }) }, 'New empty test case')));
    const right = h('div', { class: 'pane' }, h('div', { class: 'label' }, S.running ? 'Running…' : 'Output'), outputBlock(S.last));
    app.append(h('div', { class: 'cols main' }, left, right));

    app.append(h('div', { class: 'section' },
      h('h3', {}, 'Test cases', S.tests.length ? h('span', { class: 'muted', 'data-k': 'summary' }, ran ? ` ${pass} of ${ran} passed` : ` ${S.tests.length} saved`) : null),
      S.tests.length ? null : h('p', { class: 'muted' }, 'No test cases for this file yet. Type an input, run it, then "Save as test case". Expected output can be edited.'),
      ...S.tests.map(testCard)));

    // Stress test and benchmark (Zovo Pro when the owner turns Pro on; free now)
    const tools = h('details', { class: 'section tools', open: S.toolsOpen || undefined, ontoggle: (e) => post('toolsOpen', { open: e.target.open }) },
      h('summary', {}, 'Stress test and benchmark', S.proLabel ? h('span', { class: 'pro' }, S.proLabel) : null));
    const gen = h('select', { id: 'gen', 'aria-label': 'Generator' }, h('option', { value: '' }, 'Generator file…'), ...S.folderFiles.map((f) => h('option', { value: f, selected: S.stress && S.stress.gen === f }, f)));
    const ref = h('select', { id: 'ref', 'aria-label': 'Reference solution' }, h('option', { value: '' }, 'Reference (slow, correct) file…'), ...S.folderFiles.map((f) => h('option', { value: f, selected: S.stress && S.stress.ref === f }, f)));
    const count = h('input', { id: 'count', type: 'number', min: '1', max: '10000', value: String((S.stress && S.stress.count) || 200) });
    tools.append(h('p', { class: 'muted' }, 'The generator gets a seed as its first argument and prints one input. Both programs read it; the first input where the outputs differ is shown and can be saved as a test case.'),
      h('div', { class: 'row' }, gen, ref, count, h('button', { class: 'secondary small', disabled: S.running, onclick: () => post('stress', { gen: gen.value, ref: ref.value, count: Number(count.value) }) }, 'Start stress test')),
      h('div', { class: 'row' }, h('button', { class: 'secondary small', disabled: S.running, onclick: () => post('benchmark', { input: input.value, runs: 10 }) }, 'Benchmark this input (10 runs)')));
    if (S.toolResult) tools.append(h('pre', { class: 'out', 'data-k': 'tool' }, S.toolResult));
    app.append(tools);

    if (keepFocus) { const el = document.getElementById('input'); el.focus(); el.setSelectionRange(keepFocus[0], keepFocus[1]); }
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') {
      if (!S || !m.state.file || !S.file || S.file.path !== m.state.file.path || m.resetInput) inputDraft = null;
      S = m.state;
      render();
    }
  });
  post('ready');
}());
