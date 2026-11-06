import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Documentation is part of the contract: every source file says what it is for,
    // and every exported function, class, type and constant is described.
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-file-overview': [
        'error',
        { tags: { file: { initialCommentsOnly: true, mustExist: true, preventDuplicates: true } } },
      ],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
        },
      ],
      'jsdoc/no-blank-blocks': 'error',
    },
  },
  {
    // Standalone ES module scripts (tooling), run directly by Node.
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The domain package is pure: no framework, ORM or payment-provider imports.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*'], message: 'Domain must not depend on NestJS.' },
            { group: ['@prisma/*', 'prisma'], message: 'Domain must not depend on Prisma.' },
            { group: ['stripe'], message: 'Domain must not depend on Stripe.' },
          ],
        },
      ],
    },
  },
);
