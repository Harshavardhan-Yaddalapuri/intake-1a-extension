/**
 * Side panel entry (S1 stub).
 *
 * The human gate UI (three tabs: Pre-Flight, Ambiguity Queue, End-of-Run
 * Report) lands in S4. For S1 this is a minimal shell that can trigger an
 * observation of the active tab and render the resulting candidate list, so
 * the perception pipeline is exercisable end-to-end from the extension.
 */
import type { Observation } from './perceive/core';

function renderObservation(obs: Observation): void {
  const out = document.getElementById('output');
  if (!out) return;
  const lines = obs.elements.map((e) => {
    const name = e.name || '(unnamed)';
    const uncertain = e.labelUncertain ? ' [label-uncertain]' : '';
    const opts = e.options.length ? ` options=${JSON.stringify(e.options)}` : '';
    return `${e.index}\t${e.handle}\t${e.role}\t${name}${uncertain}${opts}`;
  });
  out.textContent = `snapshot ${obs.snapshotId}\n${obs.url}\n${obs.title}\n\n${lines.join('\n')}`;
}

document.getElementById('observe')?.addEventListener('click', async () => {
  const out = document.getElementById('output');
  if (out) out.textContent = 'observing...';
  const response = await chrome.runtime.sendMessage({ type: 'OBSERVE_ACTIVE_TAB' });
  if (response?.ok && response.observation) {
    renderObservation(response.observation as Observation);
  } else {
    if (out) out.textContent = `error: ${response?.error ?? 'unknown'}`;
  }
});
