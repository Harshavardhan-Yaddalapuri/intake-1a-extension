# Live smoke test — read/bind path against a running mock

Validates PERCEIVE, ACT handle resolution, and the rung-0 binders against a
real platform in a real browser, without loading the extension. Catches
"nothing binds here" before a full scored run does.

## Setup

    # dist served with CORS so a page can import the built modules
    cd <repo> && python3 -c "
    import http.server, functools
    class H(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin','*'); super().end_headers()
        def guess_type(self, path):
            return 'text/javascript' if str(path).endswith('.mjs') else super().guess_type(path)
    http.server.HTTPServer(('127.0.0.1',4099), functools.partial(H, directory='dist')).serve_forever()"

Then open the target platform and run in its console:

```js
const P = await import('http://localhost:4099/perceive-core.mjs');
const A = await import('http://localhost:4099/act-primitives.mjs');
const R = await import('http://localhost:4099/bind-rung0.mjs');
const K = await import('http://localhost:4099/bind-ranking.mjs');

const o = P.observe(document);
console.table({
  observed:   o.elements.length,
  actionable: K.enumerateActionable(o).length,
  fields:     R.readObservedFields(o).length,
  commit:     R.bindCtxCommit(o)?.recipe[0]?.evidence_name ?? 'NULL',
  discard:    R.bindCtxDiscard(o)?.recipe[0]?.evidence_name ?? 'NULL',
});
```

**What to look for:** every binder returning a NAME rather than `NULL`. A NULL
means the candidate pool was empty, which is the failure this whole
architecture exists to prevent. WHICH name it picks is not the test — ranking
only sets a trial order and the probe adjudicates.

## Result on the supplied mock (Mock A, 2026-09-04)

Study-root screen — 5 buttons, no save control present anywhere:

| Op | Bound to |
|---|---|
| nav.to_study_root | Study Plan |
| visit.create | + Add Visit |
| ctx.commit | Patients *(no commit control on this screen; re-binds later)* |

After clicking "+ Add Visit" the dialog appears and the bindings sharpen:

| Op / field | Picked |
|---|---|
| ctx.commit | **Save Visit** |
| ctx.discard | **Cancel** |
| name field (`name_input`) | **Visit Name** |
| window start (`window_start`) | **Window Start (day)** |
| window end (`window_end`) | **Window End (day)** |

No binder returned NULL at any point. `resolveHandle` resolved every handle
without a stale-handle error.

### One finding worth keeping

`window_start` and `window_end` both score 1 against "Window Start (day)" and
"Window End (day)" — both names contain "window", so the two tie and DOM order
alone would select "Window Start" for BOTH bounds. What prevents that is the
distinct-handle guard in createVisit:

    const endBox = (endCands.find(c => c.el.handle !== startBox?.handle) ?? endCands[0])?.el;

Without it the visit window would be written twice into the same field and the
end day silently lost. Lexical hints being weak is the expected case, not the
exceptional one — the guards around them are what make that safe.
