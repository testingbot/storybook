import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'spike/**', '**/storybook-static/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // CommonJS half: preset and the server handlers, which run in Node.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    // These files are CommonJS on purpose: Storybook loads presets through
    // require, and this mirrors the layout @percy/storybook uses.
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Browser half: the manager bundle.
  {
    files: ['src/manager.tsx', 'src/components/**/*.tsx', 'src/nonce.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Node half.
  {
    files: ['src/node/**/*.ts', 'src/index.ts', 'test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
]
