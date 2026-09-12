// Unify duplicated @deepseek-ai/dsh-* packages so the dsh app boot tree
// (node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai) and the plugin tree
// (node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai) share the same
// module instances.
//
// Why: dsh-agent-loop is loaded from the profile as a plugin and its realpath
// lives in the dsh-base tree. It imports symbols (e.g. TOOL_RUNTIME_SCHEDULER
// from dsh-tools) that the boot code obtained from the dsh tree. Two physical
// copies of the same version create two distinct Symbol objects, so
// `ctx.tools[TOOL_RUNTIME_SCHEDULER]` is undefined and MCP tool execution
// crashes with "Cannot read properties of undefined (reading 'prepare')".
//
// The fix replaces every same-version duplicate in the dsh-base tree with a
// symlink into the dsh tree, so Node resolves both to one realpath and both
// sides share a single module instance. Idempotent; safe to re-run after
// `npm install` recreates the duplicates.

import { readdirSync, realpathSync, existsSync, rmSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scoped = join(root, 'node_modules', '@deepseek-ai');
const dshTree = join(scoped, 'dsh', 'node_modules', '@deepseek-ai');
const baseTree = join(scoped, 'dsh-base', 'node_modules', '@deepseek-ai');

if (!existsSync(dshTree) || !existsSync(baseTree)) {
  console.log('[fix-dsh-dupes] dsh or dsh-base nested tree missing; nothing to do.');
  process.exit(0);
}

const versionOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};
import { readFileSync } from 'node:fs';

let linked = 0;
let skipped = 0;
for (const name of readdirSync(baseTree)) {
  if (!name.startsWith('dsh-')) continue;
  const baseCopy = join(baseTree, name);
  const dshCopy = join(dshTree, name);
  if (!existsSync(dshCopy)) continue; // only unify packages present in both trees
  const vBase = versionOf(baseCopy);
  const vDsh = versionOf(dshCopy);
  if (vBase !== vDsh) {
    console.log(`[fix-dsh-dupes] skip ${name}: version differs (base=${vBase} dsh=${vDsh})`);
    skipped += 1;
    continue;
  }
  // If already a symlink pointing at the dsh copy, leave it.
  const st = lstatSync(baseCopy);
  if (st.isSymbolicLink()) {
    try {
      if (realpathSync(baseCopy) === realpathSync(dshCopy)) continue;
    } catch {
      /* fall through and re-link */
    }
  }
  rmSync(baseCopy, { recursive: true, force: true });
  symlinkSync(dshCopy, baseCopy, 'dir');
  linked += 1;
  console.log(`[fix-dsh-dupes] linked ${name} (${vBase}) -> dsh tree`);
}

console.log(`[fix-dsh-dupes] done: ${linked} linked, ${skipped} skipped.`);
