/**
 * The repo's local ESLint rules (retro 2026-11, ticket 02): the mechanical half of R6 (CODING_STANDARDS.md).
 *
 * `local/caught-refusal-cause`: inside a `catch` clause or a `.catch(` callback, a `new X(...)` of a placement refusal class must pass the
 * caught value as its cause. A refusal built in a catch is built from the caught value; without the cause, a later reader
 * (`qualifyingRefusal`) takes a worker bug or a reader exception for a measured refusal. The value counts only in a value position of the
 * arguments (an argument, an object property, an array element), not as text in the message (`${String(error)}`).
 *
 * `local/caught-finding-cause`: inside a catch, a caught value made text (a template literal, `String(e)`, `message(e)`) must also be kept
 * as a value (an object property, an array element, a call argument that is no text conversion, a `throw`, a `return`). It is on only where
 * a finding becomes a refusal (`src/layout/postconditions.ts`): elsewhere a catch that makes text of its error is a decision (a decline
 * note), and the same shape is no defect there.
 */

/**
 * `PlacementRefusal` and every class that extends it in `src/`. One named list: `test/lint/caught-refusal-cause.test.ts` checks that it
 * equals the class hierarchy.
 */
export const REFUSAL_CLASSES = [
  'PlacementRefusal', 'SideHintRefusal', 'TrunkBlocked', 'SolidBlockRefusal', 'PostconditionRefusal', 'SkeletonError', 'SpanRefusal',
  'SpanReservationRefusal', 'BundleFeasibilityError', 'PlacementBudgetExceeded', 'CourseRefusal',
];
const REFUSALS = new Set(REFUSAL_CLASSES);
/** The calls that make text of a value. */
const TEXT_CALLS = new Set(['String', 'message', 'errorMessage', 'stringify']);

/** The binding of the innermost catch that holds `node`: `{ name }` (`name` undefined for `catch {}`), or undefined outside a catch or inside the block of a nested `try`. */
function caughtBinding(node) {
  for (let at = node.parent, child = node; at; child = at, at = at.parent) {
    // A refusal in the block of a nested `try` is built from that block's own reading, not from the outer caught value.
    if (at.type === 'TryStatement' && child === at.block) return undefined;
    if (at.type === 'CatchClause' && child === at.body) return { name: at.param?.type === 'Identifier' ? at.param.name : undefined };
    if ((at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression') && at.parent?.type === 'CallExpression' && at.parent.arguments[0] === at
      && at.parent.callee.type === 'MemberExpression' && !at.parent.callee.computed && at.parent.callee.property.name === 'catch') {
      const param = at.params[0];
      return { name: param?.type === 'Identifier' ? param.name : undefined };
    }
  }
  return undefined;
}

/** Whether `node` holds the identifier `name` in a value position: itself, or an element, property value or branch of a literal that holds it. */
function carries(node, name) {
  if (!node) return false;
  switch (node.type) {
    case 'Identifier': return node.name === name;
    case 'ObjectExpression': return node.properties.some(item => (item.type === 'SpreadElement' ? carries(item.argument, name) : carries(item.value, name)));
    case 'ArrayExpression': return node.elements.some(item => carries(item, name));
    case 'SpreadElement': return carries(node.argument, name);
    case 'ConditionalExpression': return carries(node.consequent, name) || carries(node.alternate, name);
    case 'LogicalExpression': return carries(node.left, name) || carries(node.right, name);
    case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': return carries(node.expression, name);
    default: return false;
  }
}

const calleeName = callee => (callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : undefined);

/** Every reference to the variable `name` seen from `node`. */
function references(context, node, name) {
  for (let at = context.sourceCode.getScope(node); at; at = at.upper) { const variable = at.set.get(name); if (variable) return variable.references.map(item => item.identifier); }
  return [];
}

/** Whether the identifier stands as text: inside a template literal, or as the argument of a text call. */
function asText(identifier) {
  const parent = identifier.parent;
  if (parent.type === 'TemplateLiteral') return true;
  if (parent.type === 'CallExpression' && parent.arguments.includes(identifier) && TEXT_CALLS.has(calleeName(parent.callee))) return true;
  if (parent.type === 'MemberExpression' && parent.object === identifier && !parent.computed && ['message', 'stack', 'name'].includes(parent.property.name)) return true;
  return false;
}
/** Whether the identifier stands as a value that keeps the caught object. */
function asValue(identifier) {
  const parent = identifier.parent;
  switch (parent.type) {
    case 'Property': return parent.value === identifier;
    case 'ArrayExpression': case 'ThrowStatement': case 'ReturnStatement': case 'SpreadElement': return true;
    case 'AssignmentExpression': return parent.right === identifier;
    case 'VariableDeclarator': return parent.init === identifier;
    case 'NewExpression': return parent.arguments.includes(identifier);
    case 'CallExpression': return parent.arguments.includes(identifier) && !TEXT_CALLS.has(calleeName(parent.callee));
    default: return false;
  }
}

const caughtRefusalCause = {
  meta: {
    type: 'problem',
    docs: { description: 'A placement refusal built in a catch passes the caught value as its cause (R6).' },
    messages: {
      noCause: '`new {{name}}(...)` in a catch builds a refusal from the caught value `{{binding}}` but does not pass it as its cause (R6): pass `{{binding}}` (or `{ cause: {{binding}} }`).',
      noBinding: '`new {{name}}(...)` in a catch with no binding: bind the caught value and pass it as the cause (R6).',
    },
    schema: [],
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || !REFUSALS.has(node.callee.name)) return;
        const caught = caughtBinding(node);
        if (caught === undefined) return;
        if (caught.name === undefined) { context.report({ node, messageId: 'noBinding', data: { name: node.callee.name } }); return; }
        if (!node.arguments.some(argument => carries(argument, caught.name))) context.report({ node, messageId: 'noCause', data: { name: node.callee.name, binding: caught.name } });
      },
    };
  },
};

const caughtFindingCause = {
  meta: {
    type: 'problem',
    docs: { description: 'A finding made from a caught value keeps the value, so the refusal built from the finding can carry it as its cause (R6).' },
    messages: { textOnly: 'The catch makes text of `{{binding}}` but keeps no value of it (R6): record `{{binding}}` with the finding, so the refusal built from it carries the cause.' },
    schema: [],
  },
  create(context) {
    const check = (param, body) => {
      if (param?.type !== 'Identifier') return;
      const uses = references(context, body, param.name);
      if (uses.some(asText) && !uses.some(asValue)) context.report({ node: param, messageId: 'textOnly', data: { binding: param.name } });
    };
    return {
      CatchClause(node) { check(node.param, node.body); },
      CallExpression(node) {
        const callback = node.arguments[0];
        if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'catch'
          && (callback?.type === 'FunctionExpression' || callback?.type === 'ArrowFunctionExpression')) check(callback.params[0], callback.body);
      },
    };
  },
};

export default { meta: { name: 'portograph-local' }, rules: { 'caught-refusal-cause': caughtRefusalCause, 'caught-finding-cause': caughtFindingCause } };
