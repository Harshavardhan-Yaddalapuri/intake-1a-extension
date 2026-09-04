import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, 'test'), { recursive: true });

const common = {
  bundle: true,
  target: ['es2022'],
  logLevel: 'info',
};

async function main() {
  // Content script (auto-injected; observes the page and messages the background).
  await build({
    ...common,
    entryPoints: [join(root, 'src/perceive/content.ts')],
    outfile: join(dist, 'content.js'),
    format: 'iife',
  });

  // Background service worker (stores latest observation + diff).
  await build({
    ...common,
    entryPoints: [join(root, 'src/background.ts')],
    outfile: join(dist, 'background.js'),
    format: 'iife',
  });

  // Side panel (human gate UI).
  await build({
    ...common,
    entryPoints: [join(root, 'src/sidepanel/app.ts')],
    outfile: join(dist, 'sidepanel.js'),
    format: 'iife',
  });

  // Standalone PERCEIVE bundle for the dev harness (exposes globalThis.__PERCEIVE__).
  await build({
    ...common,
    entryPoints: [join(root, 'src/perceive/standalone.ts')],
    outfile: join(dist, 'perceive-standalone.js'),
    format: 'iife',
  });

  // Dev harness page script.
  await build({
    ...common,
    entryPoints: [join(root, 'test/harness.ts')],
    outfile: join(dist, 'test/harness.js'),
    format: 'iife',
  });

  // Pure PERCEIVE core as ESM for Node unit tests.
  await build({
    ...common,
    entryPoints: [join(root, 'src/perceive/core.ts')],
    outfile: join(dist, 'perceive-core.mjs'),
    format: 'esm',
    platform: 'node',
  });

  // S2 deterministic core as ESM for Node unit tests + the null-ACT dry run.
  const nodeModules = [
    ['src/shared/contract.ts', 'contract.mjs'],
    ['src/plan/ir.ts', 'plan-ir.mjs'],
    ['src/plan/compiler.ts', 'plan-compiler.mjs'],
    ['src/verify/verify.ts', 'verify.mjs'],
    ['src/engine/state-machine.ts', 'state-machine.mjs'],
    // S3 modules.
    ['src/act/primitives.ts', 'act-primitives.mjs'],
    ['src/bind/cache.ts', 'bind-cache.mjs'],
    ['src/bind/rung0.ts', 'bind-rung0.mjs'],
    ['src/bind/rung1.ts', 'bind-rung1.mjs'],
    ['src/bind/ranking.ts', 'bind-ranking.mjs'],
    ['src/engine/reconcile.ts', 'reconcile.mjs'],
    ['src/engine/journal.ts', 'journal.mjs'],
    // S4 modules.
    ['src/shared/messages.ts', 'messages.mjs'],
    ['src/engine/tab-driver.ts', 'tab-driver.mjs'],
    ['src/engine/probe-runner.ts', 'probe-runner.mjs'],
    ['src/engine/orchestrator.ts', 'orchestrator.mjs'],
  ];
  for (const [entry, out] of nodeModules) {
    await build({
      ...common,
      entryPoints: [join(root, entry)],
      outfile: join(dist, out),
      format: 'esm',
      platform: 'node',
    });
  }

  // Null-ACT dry-run script (compiles the real IR, prints the linear plan).
  await build({
    ...common,
    entryPoints: [join(root, 'test/dry-run.ts')],
    outfile: join(dist, 'test/dry-run.mjs'),
    format: 'esm',
    platform: 'node',
  });

  // Static assets into dist.
  cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  cpSync(join(root, 'sidepanel.html'), join(dist, 'sidepanel.html'));
  cpSync(join(root, 'test/harness.html'), join(dist, 'test/harness.html'));

  // Also copy extension bundles to root so loading either root or dist/
  // in chrome://extensions works out of the box.
  cpSync(join(dist, 'content.js'), join(root, 'content.js'));
  cpSync(join(dist, 'background.js'), join(root, 'background.js'));
  cpSync(join(dist, 'sidepanel.js'), join(root, 'sidepanel.js'));

  console.log('Build complete ->', dist, 'and root extension bundles updated');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
