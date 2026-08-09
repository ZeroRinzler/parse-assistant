// @ts-check

const MESSAGE =
  'Comments must fit on a single line. Re-read the comment rule in CLAUDE.md (the mistake test) before adding this back.';

function isOwnLine(sourceCode, comment) {
  const linesBefore = sourceCode.lines[comment.loc.start.line - 1].slice(0, comment.loc.start.column);
  return linesBefore.trim() === '';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'disallow comments spanning more than one line' },
    schema: [],
    messages: { multiLine: MESSAGE },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Program() {
        const comments = sourceCode.getAllComments();
        let i = 0;
        while (i < comments.length) {
          const comment = comments[i];

          if (comment.type === 'Block') {
            if (comment.loc.end.line > comment.loc.start.line) {
              context.report({ loc: comment.loc, messageId: 'multiLine' });
            }
            i++;
            continue;
          }

          // Group a run of adjacent own-line `//` comments: that is one logical
          // multi-line comment even though each line is individually a Line token.
          if (!isOwnLine(sourceCode, comment)) {
            i++;
            continue;
          }
          let j = i;
          while (
            j + 1 < comments.length &&
            comments[j + 1].type === 'Line' &&
            comments[j + 1].loc.start.line === comments[j].loc.end.line + 1 &&
            isOwnLine(sourceCode, comments[j + 1])
          ) {
            j++;
          }
          if (j > i) {
            context.report({ loc: { start: comment.loc.start, end: comments[j].loc.end }, messageId: 'multiLine' });
          }
          i = j + 1;
        }
      },
    };
  },
};
