// @ts-check

const BANNED = [
  { char: '—', label: 'em dash (U+2014)' },
  { char: '–', label: 'en dash (U+2013)' },
  { char: '−', label: 'minus sign (U+2212)' },
  { char: '·', label: 'middle dot (U+00B7)' },
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'disallow em dash, en dash, minus sign, and middle dot characters anywhere in the file' },
    schema: [],
    messages: {
      banned: 'Found a {{label}}. CLAUDE.md bans these everywhere - use a plain ASCII character or rephrase.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Program() {
        const text = sourceCode.getText();
        for (const { char, label } of BANNED) {
          let index = text.indexOf(char);
          while (index !== -1) {
            context.report({ loc: sourceCode.getLocFromIndex(index), messageId: 'banned', data: { label } });
            index = text.indexOf(char, index + 1);
          }
        }
      },
    };
  },
};
