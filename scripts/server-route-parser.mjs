import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default ?? traverseModule;
const methods = new Set(["delete", "get", "head", "patch", "post", "put"]);

// Resolve literals without executing application code. Unsupported or mutable
// bindings remain errors rather than becoming guessed inventory entries.
function unwrapType(path) {
  while (
    path?.isTSAsExpression() ||
    path?.isTSSatisfiesExpression() ||
    path?.isTSNonNullExpression()
  )
    path = path.get("expression");
  return path;
}

function literalStrings(path, seen = new Set()) {
  path = unwrapType(path);
  if (path?.isStringLiteral()) return [path.node.value];
  if (path?.isTemplateLiteral()) {
    const expressions = path.get("expressions");
    const quasis = path.node.quasis.map((part) => part.value.cooked);
    if (quasis.some((part) => part === null)) return null;
    if (expressions.length === 0) return [quasis[0]];
    // Multiple varying bindings can be correlated; do not invent a Cartesian
    // product of routes that the application never registers.
    if (expressions.length !== 1) return null;
    const values = literalStrings(expressions[0], seen);
    return values?.map((value) => `${quasis[0]}${value}${quasis[1]}`) ?? null;
  }
  if (!path?.isIdentifier()) return null;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || seen.has(binding)) return null;
  const nextSeen = new Set([...seen, binding]);
  if (binding.path.isVariableDeclarator()) {
    const declaration = binding.path.parentPath;
    const loop = declaration.parentPath;
    if (loop?.isForOfStatement() && loop.get("left") === declaration) {
      const values = unwrapType(loop.get("right"));
      if (!values.isArrayExpression()) return null;
      const resolved = values
        .get("elements")
        .map((value) => literalStrings(value, nextSeen));
      return resolved.every((value) => value !== null) ? resolved.flat() : null;
    }
    return literalStrings(binding.path.get("init"), nextSeen);
  }
  if (binding.kind !== "param") return null;
  const fn = binding.path.getFunctionParent();
  if (
    !fn?.isFunctionDeclaration() ||
    !fn.node.id ||
    fn.parentPath.isExportNamedDeclaration() ||
    fn.parentPath.isExportDefaultDeclaration()
  )
    return null;
  const parameterIndex = fn.node.params.indexOf(binding.path.node);
  const callerBinding = fn.parentPath.scope.getBinding(fn.node.id.name);
  if (
    parameterIndex < 0 ||
    !callerBinding?.constant ||
    !callerBinding.referencePaths.length
  )
    return null;
  const result = [];
  for (const reference of callerBinding.referencePaths) {
    const call = reference.parentPath;
    if (!call.isCallExpression() || call.get("callee") !== reference)
      return null;
    const values = literalStrings(
      call.get("arguments")[parameterIndex],
      nextSeen,
    );
    if (!values) return null;
    result.push(...values);
  }
  return result;
}

/** Inventory actual app route registrations, including finite literal factories. */
export function readStaticServerRoutes(source, file) {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const routes = [];
  traverse(ast, {
    CallExpression(call) {
      const callee = call.get("callee");
      if (
        !callee.isMemberExpression() ||
        callee.node.computed ||
        !callee.get("object").isIdentifier({ name: "app" }) ||
        !callee.get("property").isIdentifier() ||
        !methods.has(callee.node.property.name)
      )
        return;
      const paths = literalStrings(call.get("arguments")[0]);
      if (!paths?.length) {
        throw new Error(
          `Server route at ${file}:${call.node.loc.start.line} does not use a statically resolvable path.`,
        );
      }
      for (const path of paths) {
        routes.push({
          file,
          line: call.node.loc.start.line,
          method: callee.node.property.name.toUpperCase(),
          path,
          source: source.slice(call.node.start, call.node.end),
        });
      }
    },
  });
  return routes;
}
