import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "..");

const allowedLowLevelFiles = new Set([
  "src/exact-linear-algebra.ts",
  "src/exact-numeric-state.ts",
]);

const mutatingMethods = new Set(["set", "fill", "copyWithin", "reverse", "sort"]);
const sidecarLosingMethods = new Set([
  "slice", "map", "filter", "subarray", "toReversed", "toSorted", "with",
]);

function normalizedRelativePath(rootDirectory, fileName) {
  return path.relative(rootDirectory, fileName).split(path.sep).join("/");
}

function isLibrarySymbol(symbol, name) {
  if (symbol?.getName() !== name) { return false; }
  return symbol.declarations?.some((declaration) => {
    const fileName = path.basename(declaration.getSourceFile().fileName);
    return fileName.startsWith("lib.") && fileName.endsWith(".d.ts") &&
      ts.isIdentifier(declaration.name) && declaration.name.text === name;
  }) ?? false;
}

function typeIsFloat64Array(checker, type, visited = new Set()) {
  if (visited.has(type)) { return false; }
  visited.add(type);
  if ([ts.TypeFlags.Null, ts.TypeFlags.Undefined, ts.TypeFlags.Never].includes(type.flags)) {
    return false;
  }
  if ((type.isUnion?.() || type.isIntersection?.()) &&
      type.types.some((part) => typeIsFloat64Array(checker, part, visited))) {
    return true;
  }
  const symbols = [type.aliasSymbol, type.getSymbol?.(), type.target?.getSymbol?.()];
  if (symbols.some((symbol) => isLibrarySymbol(symbol, "Float64Array"))) { return true; }
  if (type.isTypeParameter?.()) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && typeIsFloat64Array(checker, constraint, visited);
  }
  return false;
}

function isFloat64ArrayType(checker, node) {
  return typeIsFloat64Array(checker, checker.getTypeAtLocation(node));
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) { return node.name.text; }
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression;
    if (argument && (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return argument.text;
    }
  }
}

function isBuiltinConstructorType(checker, expression, name) {
  const type = checker.getTypeAtLocation(expression);
  const symbols = [type.aliasSymbol, type.getSymbol?.(), type.target?.getSymbol?.()];
  return symbols.some((symbol) => isLibrarySymbol(symbol, `${name}Constructor`));
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function diagnostic(sourceFile, node, code, message) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    fileName: sourceFile.fileName,
    line: line + 1,
    column: character + 1,
    code,
    message,
  };
}

function checkIndexedMutation(node, sourceFile, checker, violations) {
  const isAssignment = ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) &&
    ts.isElementAccessExpression(node.left);
  const isIncrement = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
    ts.isElementAccessExpression(node.operand);
  const target = isAssignment ? node.left.expression : isIncrement ? node.operand.expression : null;
  if (!target || !isFloat64ArrayType(checker, target)) { return; }
  violations.push(diagnostic(
    sourceFile,
    node,
    "NPOL001",
    "Float64Array の要素を直接変更すると厳密値 sidecar が古くなる可能性があります。setRealStateValue/addRealStateValue を使ってください。",
  ));
}

function checkArrayMethod(node, sourceFile, checker, violations) {
  if (!ts.isCallExpression(node) ||
      (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression))) {
    return;
  }
  const receiver = node.expression.expression;
  const method = propertyName(node.expression);
  if (method === undefined) { return; }
  if (!isFloat64ArrayType(checker, receiver)) { return; }
  if (mutatingMethods.has(method)) {
    violations.push(diagnostic(
      sourceFile,
      node,
      "NPOL002",
      `Float64Array の .${method}() は厳密値 sidecar と同期しません。exact-numeric-state の更新関数を使ってください。`,
    ));
  }
  if (sidecarLosingMethods.has(method)) {
    violations.push(diagnostic(
      sourceFile,
      node,
      "NPOL003",
      `Float64Array の .${method}() は厳密値 sidecar を引き継ぎません。cloneRealState または exactRealStateInput を使ってください。`,
    ));
  }
}

function checkTypedArrayConstructorCopy(node, sourceFile, checker, violations) {
  if (!ts.isNewExpression(node) || !isBuiltinConstructorType(checker, node.expression, "Float64Array") ||
      !node.arguments?.[0] || !isFloat64ArrayType(checker, node.arguments[0])) { return; }
  violations.push(diagnostic(
    sourceFile,
    node,
    "NPOL003",
    "new Float64Array(existing) は厳密値 sidecar を引き継ぎません。cloneRealState を使ってください。",
  ));
}

function checkStaticCopy(node, sourceFile, checker, violations) {
  if (!ts.isCallExpression(node) ||
      (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression))) {
    return;
  }
  const owner = node.expression.expression;
  const method = propertyName(node.expression);
  const source = node.arguments[0];
  if (!source || !isFloat64ArrayType(checker, source) || method !== "from") {
    return;
  }
  if (isFloat64ArrayType(checker, node) && isBuiltinConstructorType(checker, owner, "Float64Array")) {
    violations.push(diagnostic(
      sourceFile,
      node,
      "NPOL003",
      "Float64Array.from(existing) は厳密値 sidecar を引き継ぎません。cloneRealState を使ってください。",
    ));
  }
  if (isBuiltinConstructorType(checker, owner, "Array")) {
    violations.push(diagnostic(
      sourceFile,
      node,
      "NPOL003",
      "Array.from(existingFloat64Array) は厳密値 sidecar を失います。exactRealStateInput を使ってください。",
    ));
  }
}

function checkSpreadCopy(node, sourceFile, checker, violations) {
  if (!ts.isSpreadElement(node) || !isFloat64ArrayType(checker, node.expression)) { return; }
  violations.push(diagnostic(
    sourceFile,
    node,
    "NPOL003",
    "Float64Array の spread は厳密値 sidecar を失います。exactRealStateInput を使ってください。",
  ));
}

/** Finds operations that mutate or copy Float64Array values without their WeakMap sidecars. */
export function findNumericPolicyViolations(program, rootDirectory = repositoryRoot) {
  const checker = program.getTypeChecker();
  const violations = [];

  for (const sourceFile of program.getSourceFiles()) {
    const relativePath = normalizedRelativePath(rootDirectory, sourceFile.fileName);
    if (!relativePath.startsWith("src/") || relativePath.includes("/__tests__/")) { continue; }
    if (allowedLowLevelFiles.has(relativePath)) { continue; }
    if (!/\.tsx?$/.test(relativePath)) { continue; }

    const visit = (node) => {
      checkIndexedMutation(node, sourceFile, checker, violations);
      checkArrayMethod(node, sourceFile, checker, violations);
      checkTypedArrayConstructorCopy(node, sourceFile, checker, violations);
      checkStaticCopy(node, sourceFile, checker, violations);
      checkSpreadCopy(node, sourceFile, checker, violations);
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations.sort((left, right) =>
    left.fileName.localeCompare(right.fileName) || left.line - right.line || left.column - right.column,
  );
}

/** Builds a TypeScript program from an in-memory source fixture. */
export function findVirtualSourceViolations(sourceText, fileName = path.join(repositoryRoot, "src", "__numeric-policy-fixture.ts")) {
  const absoluteFileName = path.resolve(fileName);
  const canonicalFileName = path.normalize(absoluteFileName);
  const compilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: [],
    noEmit: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const isFixture = (candidate) => path.normalize(path.resolve(candidate)) === canonicalFileName;
  host.fileExists = (candidate) => isFixture(candidate) || originalFileExists(candidate);
  host.readFile = (candidate) => isFixture(candidate) ? sourceText : originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    isFixture(candidate)
      ? ts.createSourceFile(canonicalFileName, sourceText, languageVersion, true)
      : originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);

  const program = ts.createProgram([canonicalFileName], compilerOptions, host);
  return findNumericPolicyViolations(program, repositoryRoot);
}

function loadProjectProgram(rootDirectory) {
  const configFileName = ts.findConfigFile(rootDirectory, ts.sys.fileExists, "tsconfig.json");
  if (!configFileName) { throw new Error(`tsconfig.json が見つかりません: ${rootDirectory}`); }
  const config = ts.readConfigFile(configFileName, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFileName), undefined, configFileName);
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.slice(0, 5).map((item) =>
      ts.flattenDiagnosticMessageText(item.messageText, " "),
    );
    throw new Error(`tsconfig.json の設定を読み取れません:\n${messages.join("\n")}`);
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const typeErrors = ts.getPreEmitDiagnostics(program);
  if (typeErrors.length > 0) {
    const first = typeErrors.slice(0, 5).map((item) => {
      const file = item.file ? `${normalizedRelativePath(rootDirectory, item.file.fileName)}:${
        item.file.getLineAndCharacterOfPosition(item.start ?? 0).line + 1
      } ` : "";
      return `${file}${ts.flattenDiagnosticMessageText(item.messageText, " ")}`;
    });
    throw new Error(`TypeScript の型情報が不完全なため numeric policy を実行できません:\n${first.join("\n")}`);
  }
  return program;
}

export function runNumericPolicy(rootDirectory = repositoryRoot) {
  const root = path.resolve(rootDirectory);
  const violations = findNumericPolicyViolations(loadProjectProgram(root), root);
  for (const violation of violations) {
    const relativePath = normalizedRelativePath(root, violation.fileName);
    process.stderr.write(`${relativePath}:${violation.line}:${violation.column}: ${violation.code} ${violation.message}\n`);
  }
  if (violations.length === 0) {
    process.stdout.write("numeric-policy: Float64Array sidecar 操作を確認しました。\n");
    return 0;
  }
  process.stderr.write(`numeric-policy: ${violations.length} 件の違反があります。\n`);
  return 1;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  try {
    process.exitCode = runNumericPolicy();
  } catch (error) {
    process.stderr.write(`numeric-policy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
