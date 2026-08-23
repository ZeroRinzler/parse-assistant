// @ts-check

// The article's pass-list: these folder names describe what code is, not what it does.
const GENERIC_FOLDERS = new Set(['services', 'helpers', 'managers', 'handlers', 'controllers', 'misc', 'common']);

// Dotted type suffixes; the hyphenated form of the class name replaces them (x-service.ts, not x.service.ts).
const BANNED_SEGMENTS = new Set(['service', 'component', 'directive', 'interceptor', 'pipe', 'guard', 'module']);

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'enforce responsibility-named kebab-case paths: no generic folder names, no dotted type suffixes' },
    schema: [],
    messages: {
      genericFolder: "Folder '{{name}}' names what the code is, not what it does. Name it by responsibility.",
      bannedSuffix: "Dotted type suffix '.{{name}}.' is the old convention. Use the kebab of the class name instead.",
      notKebab: "Path segment '{{name}}' is not kebab-case.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const appIndex = context.filename.replace(/\\/g, '/').indexOf('/src/app/');
        if (appIndex === -1) return;
        const rel = context.filename.replace(/\\/g, '/').slice(appIndex + '/src/app/'.length);
        const parts = rel.split('/');
        const file = parts.pop() ?? '';
        // A dot in a "folder" marks the inline-template processor's virtual paths (x.ts/0_inline-template...).
        if (parts.some((folder) => folder.includes('.'))) return;
        for (const folder of parts) {
          if (GENERIC_FOLDERS.has(folder)) context.report({ node, messageId: 'genericFolder', data: { name: folder } });
          else if (!KEBAB.test(folder)) context.report({ node, messageId: 'notKebab', data: { name: folder } });
        }
        const segments = file.split('.');
        segments.pop();
        for (const segment of segments) {
          if (BANNED_SEGMENTS.has(segment)) context.report({ node, messageId: 'bannedSuffix', data: { name: segment } });
          else if (!KEBAB.test(segment)) context.report({ node, messageId: 'notKebab', data: { name: segment } });
        }
      },
    };
  },
};
