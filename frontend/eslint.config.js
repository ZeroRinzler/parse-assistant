// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import boundaries from 'eslint-plugin-boundaries';
import singleLineComment from './eslint-rules/single-line-comment.js';
import bannedCharacters from './eslint-rules/banned-characters.js';

const local = {
  rules: { 'single-line-comment': singleLineComment, 'banned-characters': bannedCharacters },
};

const architectureLayers = [
  { type: 'testing', pattern: 'src/testing', partialMatch: false },
  { type: 'environments', pattern: 'src/environments', partialMatch: false },
  { type: 'ingest', pattern: 'src/app/ingest', partialMatch: false },
  { type: 'core', pattern: 'src/app/core', partialMatch: false },
  { type: 'shared', pattern: 'src/app/shared', partialMatch: false },
  { type: 'slice', pattern: 'src/app/pages/post-raid/*', partialMatch: false, capture: ['sliceName'] },
  { type: 'page', pattern: 'src/app/pages/*', partialMatch: false },
  { type: 'app-root', pattern: 'src/app', partialMatch: false },
  { type: 'bootstrap', pattern: 'src', partialMatch: false },
];

const to = (...types) => types.map((type) => ({ to: { element: { type } } }));

// Last match wins: moving the Pull Overview exception above the general slice policy disables it.
const layerPolicies = [
  { from: [{ element: { type: 'core' } }], allow: to('environments', 'testing') },
  { from: [{ element: { type: 'shared' } }], allow: to('core', 'testing') },
  { from: [{ element: { type: 'slice' } }], allow: to('core', 'shared', 'testing') },
  { from: [{ element: { type: 'page' } }], allow: to('core', 'shared', 'slice', 'testing') },
  { from: [{ element: { type: 'ingest' } }], allow: to('core', 'shared', 'slice', 'testing') },
  { from: [{ element: { type: 'app-root' } }], allow: to('core', 'shared', 'page', 'environments') },
  { from: [{ element: { type: 'environments' } }], allow: to('core', 'slice', 'ingest') },
  { from: [{ element: { type: 'bootstrap' } }], allow: to('core', 'app-root') },
  { from: [{ element: { type: 'testing' } }], allow: to('core') },
  {
    from: [{ element: { type: 'slice', captured: { sliceName: 'pull-overview' } } }],
    allow: [{ to: { element: { type: 'slice', captured: { sliceName: 'map' } } } }],
    message: 'Pull Overview reads the Map slice anchor type its own cards emit.',
  },
];

// Exactly 3 or 6 hex digits: the trailing guard keeps `#8041`-style id labels out.
const HEX_COLOR = String.raw`#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])`;
const COLOR_FUNCTION = String.raw`\brgba?\(`;
const COLOR_LITERAL = `${HEX_COLOR}|${COLOR_FUNCTION}`;

// Anchored at a token start so module specifiers like './class-icon-pipe' are not class names.
const DESIGN_SYSTEM_CLASS = String.raw`(?:^|\s)(?:badge|icon|chip)-`;

const styleFileMessage =
  'Zero per-component style files: styling is Angular Material + Tailwind utilities over the tokens in src/styles.scss.';
const colorMessage =
  'No hardcoded colors: use a src/styles.scss token through a Tailwind arbitrary value or a badge-* class.';
const classProductionMessage =
  'Component TS never produces CSS classes: expose semantic state and let the template pick the class.';

const restrictUiSyntax = [
  { selector: 'Property[key.name=/^styleUrls?$/]', message: styleFileMessage },
  { selector: `Literal[value=/${COLOR_LITERAL}/]`, message: colorMessage },
  { selector: `TemplateElement[value.raw=/${COLOR_LITERAL}/]`, message: colorMessage },
  { selector: `Literal[value=/${DESIGN_SYSTEM_CLASS}/]`, message: classProductionMessage },
  { selector: `TemplateElement[value.raw=/${DESIGN_SYSTEM_CLASS}/]`, message: classProductionMessage },
];

const httpClientImports = [
  'HttpClient',
  'HttpBackend',
  'HttpHandler',
  'HttpXhrBackend',
  'httpResource',
  'provideHttpClient',
  'withFetch',
  'withInterceptors',
  'withInterceptorsFromDi',
];

const restrictHttpImports = {
  paths: [
    {
      name: '@angular/common/http',
      importNames: httpClientImports,
      message:
        'Only the transports behind WclApiService and DataFileApiService issue HTTP requests. Go through those two API services instead.',
    },
  ],
};

const restrictAngularImports = {
  patterns: [
    {
      group: ['@angular/*', '@angular/*/*'],
      message: 'This is functional-core code: keep it pure and framework-free, and inject nothing.',
    },
  ],
};

const functionalCoreFiles = [
  'src/app/core/*.ts',
  'src/app/core/models/**/*.ts',
  'src/app/shared/*.ts',
  'src/app/shared/analysis/**/*.ts',
  'src/app/shared/gear/**/*.ts',
  'src/app/ingest/*.ts',
  'src/app/ingest/models/**/*.ts',
  // A slice's own folder holds its Angular components and services; only its subfolders are pure math.
  'src/app/pages/post-raid/*/*/**/*.ts',
  'src/app/**/*.utils.ts',
  'src/app/**/*-queries.ts',
];

export default defineConfig([
  { ignores: ['src/**/*.generated.ts'] },
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
    // Test-only relaxations: fakes implement promise-returning interfaces with await-less `async () =>` bodies.
    // `!` stays banned here too - specs assert presence via `defined()` (src/testing/defined.ts) instead.
    files: ['src/**/*.spec.ts', 'src/testing/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
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
      '@angular-eslint/component-max-inline-declarations': ['error', { template: 10, styles: 0 }], // beyond that, templateUrl
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': architectureLayers,
      // Imports are extensionless; without .ts the resolver misses every target and every rule below silently passes.
      'import/resolver': { node: { extensions: ['.ts', '.js', '.json'] } },
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: layerPolicies }],
      'boundaries/no-unknown-dependencies': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Only the transports behind WclApiService and DataFileApiService issue HTTP requests.',
        },
        {
          name: 'XMLHttpRequest',
          message: 'Only the transports behind WclApiService and DataFileApiService issue HTTP requests.',
        },
        { name: 'WebSocket', message: 'Live sync polls through WclApiService; the app opens no sockets.' },
      ],
      'no-restricted-syntax': ['error', ...restrictUiSyntax],
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      complexity: ['error', { max: 10 }],
      'max-depth': ['error', { max: 3 }],
    },
  },
  {
    // Every transport/ folder is a chokepoint, so narrowing this to one of them re-bans the other's HttpClient.
    files: ['src/**/*.ts'],
    ignores: ['src/app/**/transport/**'],
    rules: { 'no-restricted-imports': ['error', restrictHttpImports] },
  },
  {
    files: functionalCoreFiles,
    rules: { 'no-restricted-imports': ['error', restrictAngularImports] },
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
        URLSearchParams: 'readonly',
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
      'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
      'local/single-line-comment': 'error',
      'local/banned-characters': 'error',
    },
  },
]);
