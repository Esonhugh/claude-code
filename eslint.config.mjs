import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const noopRule = { create: () => ({}) }

const customRulesPlugin = {
  rules: {
    'bootstrap-isolation': noopRule,
    'no-cross-platform-process-issues': noopRule,
    'no-direct-json-operations': noopRule,
    'no-direct-ps-commands': noopRule,
    'no-lookbehind-regex': noopRule,
    'no-process-cwd': noopRule,
    'no-process-env-top-level': noopRule,
    'no-process-exit': noopRule,
    'no-sync-fs': noopRule,
    'no-top-level-dynamic-import': noopRule,
    'no-top-level-side-effects': noopRule,
    'prefer-use-keybindings': noopRule,
    'prefer-use-terminal-size': noopRule,
    'prompt-spacing': noopRule,
    'require-bun-typeof-guard': noopRule,
    'require-tool-match-name': noopRule,
    'safe-env-boolean-check': noopRule,
  },
}

const nodePluginCompat = {
  rules: {
    'no-sync': noopRule,
    'no-unsupported-features/node-builtins': noopRule,
  },
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.claude/**',
      'coverage/**',
      '*.config.js',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'types/**/*.d.ts', 'scripts/**/*.mjs'],
    plugins: {
      'custom-rules': customRulesPlugin,
      'eslint-plugin-n': nodePluginCompat,
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        document: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-hooks/config': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/gating': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/use-memo': 'off',
      'react/jsx-no-undef': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-async-promise-executor': 'warn',
      'no-constant-binary-expression': 'off',
      'no-constant-condition': 'off',
      'no-fallthrough': 'off',
      'no-useless-escape': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['types/**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
)
