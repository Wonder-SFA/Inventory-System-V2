import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

describe('ESLint module boundary enforcement', () => {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.mjs'),
  });

  it('rejects cross-module internal imports (e.g. orders importing inventory/db/schema)', async () => {
    const filePath = path.join(repoRoot, 'apps/api/src/modules/orders/domain/foo.ts');
    const results = await eslint.lintText(
      `import { stockBalances } from '../../inventory/db/schema.js';\nexport const x = stockBalances;\n`,
      { filePath },
    );

    const messages = results[0]?.messages ?? [];
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2)).toBe(
      true,
    );
  });

  it('rejects cross-module imports from domain, events, or routes layers', async () => {
    const filePath = path.join(repoRoot, 'apps/api/src/modules/catalog/domain/bar.ts');
    const results = await eslint.lintText(
      `import { helper } from '../../orders/domain/helper.js';\nexport const y = helper;\n`,
      { filePath },
    );

    const messages = results[0]?.messages ?? [];
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2)).toBe(
      true,
    );
  });

  it('allows cross-module imports from ../<other>/public and ../../shared/*', async () => {
    const filePath = path.join(repoRoot, 'apps/api/src/modules/orders/domain/valid.ts');
    const results = await eslint.lintText(
      `import { INVENTORY_MODULE } from '../../inventory/public/index.js';\nimport type { CommandContext } from '../../../shared/index.js';\nexport const ok: { mod: string; ctx?: CommandContext } = { mod: INVENTORY_MODULE };\n`,
      { filePath },
    );

    const errors = (results[0]?.messages ?? []).filter((m) => m.severity === 2);
    expect(errors).toEqual([]);
  });

  it('allows a module to import its own internal layers', async () => {
    const filePath = path.join(repoRoot, 'apps/api/src/modules/orders/domain/internal.ts');
    const results = await eslint.lintText(
      `import * as db from '../db/index.js';\nexport const ref = db;\n`,
      { filePath },
    );

    const errors = (results[0]?.messages ?? []).filter((m) => m.severity === 2);
    expect(errors).toEqual([]);
  });
});
