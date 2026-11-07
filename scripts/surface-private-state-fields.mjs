import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default ?? traverseModule;

function member(path, property) {
  return (
    path?.isMemberExpression() &&
    !path.node.computed &&
    path.get("property").isIdentifier({ name: property })
  );
}

function imported(path, symbol, source) {
  if (!path?.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  return (
    binding?.constant &&
    binding.path.isImportSpecifier() &&
    binding.path.node.imported.name === symbol &&
    binding.path.parent.source.value === source
  );
}

function typeAlias(path, name) {
  for (let parent = path; parent; parent = parent.parentPath) {
    if (parent.node.typeParameters?.params.some((p) => p.name === name))
      return undefined;
    if (!parent.isProgram() && !parent.isBlockStatement()) continue;
    for (let statement of parent.get("body")) {
      if (statement.isExportNamedDeclaration())
        statement = statement.get("declaration");
      if (statement?.node?.id?.name !== name) continue;
      return statement.isTSTypeAliasDeclaration() ? statement : undefined;
    }
  }
}

// CantripOS guest admission snapshots are server-owned control metadata. They
// share a field name with endpoint-private remote desktop targets, but neither
// a filename nor that spelling grants an exemption. Resolve the schema import
// or the persisted table row type at the exact reference instead.
function guestAdmissionRow(path) {
  if (!path?.isIdentifier()) return false;
  const parameter = path.scope.getBinding(path.node.name);
  if (parameter?.kind !== "param" || !parameter.constant) return false;
  const annotation = parameter.path.node.typeAnnotation?.typeAnnotation;
  if (annotation?.type !== "TSTypeReference") return false;
  if (annotation.typeName.type !== "Identifier") return false;
  const alias = typeAlias(path, annotation.typeName.name);
  const query = alias?.node.typeAnnotation;
  if (
    query?.type !== "TSTypeQuery" ||
    query.exprName.type !== "TSQualifiedName" ||
    query.exprName.right.name !== "$inferSelect" ||
    query.exprName.left.type !== "Identifier"
  )
    return false;
  const table = alias.scope.getBinding(query.exprName.left.name);
  if (!table?.constant || !table.path.isVariableDeclarator()) return false;
  const initializer = table.path.get("init");
  if (!member(initializer, "cantripOsDesktopOperations")) return false;
  const namespace = initializer.get("object");
  if (!namespace.isIdentifier()) return false;
  const schema = namespace.scope.getBinding(namespace.node.name);
  return (
    schema?.constant &&
    schema.path.isImportNamespaceSpecifier() &&
    schema.path.parent.source.value === "../schema.js"
  );
}

export function guestDesktopAdmissionFieldRanges(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const ranges = [];
  traverse(ast, {
    ObjectProperty(path) {
      if (
        path.node.computed ||
        !path.get("key").isIdentifier({ name: "desktopTarget" }) ||
        !path.parentPath.isObjectExpression()
      )
        return;
      const object = path.parentPath;
      const call = object.parentPath;
      if (
        !call.isCallExpression() ||
        call.get("arguments")[0] !== object ||
        !member(call.get("callee"), "parse") ||
        !imported(
          call.get("callee.object"),
          "cantripOsDesktopWorkerCommandSchema",
          "@cantrip/protocol",
        ) ||
        !object
          .get("properties")
          .some(
            (property) =>
              property.isObjectProperty() &&
              !property.node.computed &&
              property.get("key").isIdentifier({ name: "type" }) &&
              property
                .get("value")
                .isStringLiteral({ value: "cantrip-os.desktop.operation" }),
          )
      )
        return;
      ranges.push([path.node.key.start, path.node.key.end]);
    },
    MemberExpression(path) {
      if (!member(path, "desktopTarget")) return;
      const command = path.get("object");
      if (!member(command, "command")) return;
      if (guestAdmissionRow(command.get("object")))
        ranges.push([path.node.property.start, path.node.property.end]);
    },
  });
  return ranges;
}
