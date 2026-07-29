import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/node_modules/**',
      '**/out-types/**',
      'scripts/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module'
      }
    },
    rules: {
      // Unused function arguments are often part of an interface the function
      // has to satisfy, so only flag ones not marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart']
    }
  },

  {
    // Declaration files exist to describe shapes that already exist elsewhere.
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-namespace': 'off' }
  },

  {
    // Conditional hook calls silently corrupted node components until a node
    // type mismatched and React lost its hook state, which nothing else caught.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
);
