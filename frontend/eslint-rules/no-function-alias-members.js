// @ts-check

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'a class member never aliases a function; the behavior is a method with its body in the class' },
    schema: [],
    messages: {
      alias: "'{{name}}' aliases a function. Implement it as a method with the body here.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};
    const checker = services.program.getTypeChecker();
    return {
      PropertyDefinition(node) {
        if (!node.value || node.value.type !== 'Identifier') return;
        const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node.value));
        if (type.getCallSignatures().length > 0) {
          context.report({ node, messageId: 'alias', data: { name: node.value.name } });
        }
      },
    };
  },
};
