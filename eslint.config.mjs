import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MODULES = ['catalog', 'inventory', 'orders', 'iam', 'reporting', 'finance'];
const FORBIDDEN_LAYERS = ['db', 'domain', 'events', 'routes'];

function createModuleBoundaryRules() {
  return MODULES.map((box) => {
    const otherModules = MODULES.filter((other) => other !== box);
    const forbiddenPatterns = otherModules.flatMap((other) =>
      FORBIDDEN_LAYERS.flatMap((layer) => [`**/${other}/${layer}`, `**/${other}/${layer}/**`]),
    );

    return {
      files: [`apps/api/src/modules/${box}/**/*.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: forbiddenPatterns,
                message: `Module "${box}" cannot import internal layers (${FORBIDDEN_LAYERS.join(', ')}) from another module. Import from "../<module>/public" or "../../shared/*" instead.`,
              },
            ],
          },
        ],
      },
    };
  });
}

export default tseslint.config(
  {
    ignores: [
      '.agents/**',
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...createModuleBoundaryRules(),
);
