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

  // Side panel (human gate UI lands in S4).
  await build({
    ...common,
    entryPoints: [join(root, 'src/sidepanel.ts')],
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

  // Static assets.
  cpSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  cpSync(join(root, 'sidepanel.html'), join(dist, 'sidepanel.html'));
  cpSync(join(root, 'test/harness.html'), join(dist, 'test/harness.html'));

  console.log('Build complete ->', dist);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
