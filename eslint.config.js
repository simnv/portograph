import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Browser globals that must never appear in the headless core (ADR-0004).
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'self',
  'localStorage',
  'sessionStorage',
  'XMLHttpRequest',
  'DOMParser',
  'SVGElement',
  'HTMLElement',
  'Element',
  'Node',
  'requestAnimationFrame',
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.claude/', 'prototype/', 'ref/', '.scratch/', '.superpowers/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', ...DOM_GLOBALS],
    },
  },
  {
    files: ['bin/**/*.mjs', 'runtime/**/*.cjs', 'scripts/**/*.cjs', 'scripts/**/*.mjs', 'test/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
