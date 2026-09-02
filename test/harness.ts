/**
 * PERCEIVE dev harness page script.
 *
 * Loads the standalone PERCEIVE bundle into a target tab via chrome.scripting
 * and prints the resulting Observation. This is the S2-S6 unit-testing surface:
 * point it at any URL and read the candidate list.
 */

interface ObserveResult {
  ok: boolean;
  observation?: unknown;
  error?: string;
}

function head(observation: unknown, n: number): string {
  const obs = observation as { snapshotId: string; url: string; title: string; elements: unknown[] };
  const lines = obs.elements.slice(0, n).map((e) => {
    const el = e as { index: number; handle: string; role: string; name: string; labelUncertain: boolean; options: string[] };
    const name = el.name || '(unnamed)';
    const uncertain = el.labelUncertain ? ' [label-uncertain]' : '';
    const opts = el.options.length ? ` options=${JSON.stringify(el.options)}` : '';
    return `${el.index}\t${el.handle}\t${el.role}\t${name}${uncertain}${opts}`;
  });
  return `snapshot ${obs.snapshotId}\n${obs.url}\n${obs.title}\n${obs.elements.length} interactive elements\n\n${lines.join('\n')}`;
}

async function observeUrl(url: string): Promise<ObserveResult> {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id!;
  try {
    await new Promise<void>((resolve) => {
      const listener = (id: number, info: { status?: string }) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });
    const src = await fetch(chrome.runtime.getURL('perceive-standalone.js')).then((r) => r.text());
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (code: string) => {
        // eslint-disable-next-line no-eval
        (0, eval)(code);
        const core = (globalThis as unknown as { __PERCEIVE__: { observe: (d: Document) => unknown } }).__PERCEIVE__;
        return core.observe(document);
      },
      args: [src],
    });
    return { ok: true, observation: results[0]?.result };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await chrome.tabs.remove(tabId);
  }
}

document.getElementById('observe')?.addEventListener('click', async () => {
  const urlInput = document.getElementById('target-url') as HTMLInputElement;
  const output = document.getElementById('output') as HTMLPreElement;
  const url = urlInput.value.trim();
  if (!url) {
    output.textContent = 'Enter a URL first.';
    return;
  }
  output.textContent = 'observing...';
  const result = await observeUrl(url);
  if (result.ok && result.observation) {
    output.textContent = head(result.observation, 20);
  } else {
    output.textContent = `error: ${result.error ?? 'unknown'}`;
  }
});
