// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import singleLineComment from './eslint-rules/single-line-comment.js';
import bannedCharacters from './eslint-rules/banned-characters.js';

const local = {
  rules: { 'single-line-comment': singleLineComment, 'banned-characters': bannedCharacters },
};

export default defineConfig([
  {
    // Base TypeScript rules for all TS (src/**, e2e/**, playwright.config.ts). Angular-specific
    // rules live in the src-only block below; the plain-JS Node scripts have their own block.
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    plugins: { local },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow the underscore-prefix convention for deliberately-unused args/vars.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty private constructors are the idiomatic "force the static factory" guard.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['private-constructors'] }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // tsconfig sets noPropertyAccessFromIndexSignature, which mandates the bracket access this rule would flag.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // Without noUncheckedIndexedAccess, indexing types out the undefined, so guards like
      // `const next = xs[i + 1]; if (!next) return;` are load-bearing yet read as "always falsy".
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // A decorator-only class (the root App component) is the Angular idiom, not a namespace stand-in.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // HttpClient rejects with HttpErrorResponse, which does not extend Error; fakes must throw it too.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', name: 'HttpErrorResponse', package: '@angular/common' }] },
      ],
      'local/single-line-comment': 'error',
      'local/banned-characters': 'error',
    },
  },
  {
    // Root config file reachable only via solution references; CI's tsserver fails to match it
    // to the e2e project and reports every node type as unresolvable, so it lints type-unaware.
    files: ['playwright.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Test-only relaxations: fakes implement promise-returning interfaces with await-less
    // `async () =>` bodies, and `!` on a value the fixture just built is the intended assertion.
    files: ['src/**/*.spec.ts', 'src/testing/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Specs read protected component state via the TS bracket-access loophole (see component-harness.ts).
      '@typescript-eslint/dot-notation': [
        'error',
        { allowIndexSignaturePropertyAccess: true, allowProtectedClassPropertyAccess: true },
      ],
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
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/prefer-signals': 'error',
      '@angular-eslint/prefer-output-readonly': 'error',
      '@angular-eslint/prefer-output-emitter-ref': 'error', // output() over @Output/EventEmitter
      '@angular-eslint/no-uncalled-signals': 'error',
      '@angular-eslint/computed-must-return': 'error',
      '@angular-eslint/use-component-view-encapsulation': 'error',
      '@angular-eslint/component-max-inline-declarations': ['error', { template: 10 }], // beyond that, templateUrl
    },
  },
  {
    // Plain-JS Node scripts (the ingest file server + headless harness). console is
    // their user-facing logging, so it stays allowed; plain JS keeps core `no-undef`,
    // so the Node globals they use are declared here.
    files: ['scripts/**/*.{js,mjs}'],
    extends: [eslint.configs.recommended],
    plugins: { local },
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
      'local/single-line-comment': 'error',
      'local/banned-characters': 'error',
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    plugins: { local },
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error', // native @if/@for/@switch over *ngIf/*ngFor
      // Keep strict equality, but allow the deliberate `x != null` / `x == null`
      // idiom (matches both null and undefined) the templates use for optional fields.
      '@angular-eslint/template/eqeqeq': ['error', { allowNullOrUndefined: true }],
      '@angular-eslint/template/prefer-class-binding': 'error', // class bindings over ngClass
      // [style.x] bindings stay allowed: computed bar geometry needs them; ngStyle and static style= do not.
      '@angular-eslint/template/no-inline-styles': ['error', { allowBindToStyle: true }],
      '@angular-eslint/template/prefer-ngsrc': 'error', // NgOptimizedImage for all static images
      '@angular-eslint/template/prefer-at-else': 'error',
      '@angular-eslint/template/prefer-at-empty': 'error',
      '@angular-eslint/template/no-empty-control-flow': 'error',
      '@angular-eslint/template/prefer-built-in-pipes': 'error',
      '@angular-eslint/template/prefer-contextual-for-variables': 'error',
      'local/single-line-comment': 'error',
      'local/banned-characters': 'error',
    },
  },
]);
