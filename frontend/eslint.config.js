// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default defineConfig([
  {
    // Base TypeScript rules for the Angular app (src/**). Angular-specific rules live
    // in the src-only block below; the plain-JS Node scripts have their own block.
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    rules: {
      // Style-guide enforcement (mapped from the former frontend/.claude/CLAUDE.md).
      '@typescript-eslint/no-explicit-any': 'error', // ban `any`, use `unknown`
      // Allow the underscore-prefix convention for deliberately-unused args/vars.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty private constructors are the idiomatic "force the static factory" guard.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['private-constructors'] }],
    },
  },
  {
    // Angular-specific rules + the inline-template processor apply to the app only.
    files: ['src/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'wl',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'wl',
          style: 'kebab-case',
        },
      ],
      '@angular-eslint/prefer-standalone': 'error', // standalone is the default; no standalone:true
      '@angular-eslint/prefer-host-metadata-property': 'error', // no @HostBinding/@HostListener; use `host`
      '@angular-eslint/prefer-inject': 'error', // inject() over constructor injection
    },
  },
  {
    // Plain-JS Node scripts (the ingest file server + headless harness). console is
    // their user-facing logging, so it stays allowed; plain JS keeps core `no-undef`,
    // so the Node globals they use are declared here.
    files: ['scripts/**/*.{js,mjs}'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error', // native @if/@for/@switch over *ngIf/*ngFor
      // Keep strict equality, but allow the deliberate `x != null` / `x == null`
      // idiom (matches both null and undefined) the templates use for optional fields.
      '@angular-eslint/template/eqeqeq': ['error', { allowNullOrUndefined: true }],
    },
  },
]);
