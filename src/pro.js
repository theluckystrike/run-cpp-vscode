'use strict';
// Zovo Pro switch for this extension. PRO_ENABLED is false: every feature is free and no Pro prompt is ever shown.
// When the owner turns it on, these features need Zovo Pro (one price, every Zovo extension):
//   - stress:    stress test against a slow reference solution with a generator program (find the failing input)
//   - benchmark: run the same input many times and show min, median and max time and memory
// Run, Build, Debug, the Input panel, saved test cases with diffs, Problems, Stop and folder builds stay free for
// good. Unlock is offline (a signed key) or one GitHub call after the user clicks "Unlock with GitHub Sponsors"
// (factory/sprint/license, unchanged copies in src/license).
const { createLicense } = require('./license');

const PRO_ENABLED = false;
const SKU = 'run-cpp-pro';

const FEATURES = {
  stress: ['Stress test', 'Run your solution against a slow reference solution on hundreds of generated inputs and stop at the first input where they differ.'],
  benchmark: ['Benchmark', 'Run the same input many times and see the minimum, median and maximum time and memory.'],
};

function createPro({ vscode, context, enabled = PRO_ENABLED }) {
  // The unlock commands exist only while the switch is on, so with Pro off nothing can ever call GitHub.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Run C++ and C Code', commandPrefix: enabled ? 'zovoRun' : undefined });
  try { vscode.commands.executeCommand('setContext', 'zovoRun.proEnabled', !!enabled); } catch (e) { /* ignore */ }
  /** True when the feature may run. Shows the one Pro explanation only when the switch is on and Pro is missing. */
  async function allow(feature) {
    if (!enabled) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh(); return true; }
    const [name, detail] = FEATURES[feature] || [feature, ''];
    return !!(await license.requirePro(name, detail));
  }
  /** A quiet "Pro" label next to a paid button, only while the switch is on and Pro is missing. */
  function label() { return enabled && !license.isPro(SKU) ? 'Pro' : ''; }
  return { license, allow, label, enabled: !!enabled, SKU };
}

module.exports = { createPro, PRO_ENABLED, SKU, FEATURES };
