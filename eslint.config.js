import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import local from './scripts/eslint-local.mjs';

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
    plugins: { local },
    rules: {
      'no-restricted-globals': ['error', ...DOM_GLOBALS],
      // R6, its mechanical half (retro 2026-11, ticket 02): a refusal built in a catch carries the caught value.
      'local/caught-refusal-cause': 'error',
    },
  },
  {
    // A finding of a postcondition becomes a refusal: a catch that makes text of its error keeps the value too (R6).
    files: ['src/layout/postconditions.ts'],
    rules: { 'local/caught-finding-cause': 'error' },
  },
  {
    files: ['bin/**/*.mjs', 'runtime/**/*.cjs', 'scripts/**/*.cjs', 'scripts/**/*.mjs', 'test/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
