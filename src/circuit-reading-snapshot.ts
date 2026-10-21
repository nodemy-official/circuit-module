import { exactExpressionsAreImmutable, type ExactExpressionNode } from "./exact-expression.js";

export function appendExactComponentSnapshot(snapshot: unknown[], value: unknown) {
  snapshot.push(value);
  if (typeof value === "object" && value !== null) {
    snapshot.push("numerator" in value ? value.numerator : undefined,
      "denominator" in value ? value.denominator : undefined,
      "expression" in value ? value.expression : undefined,
      "sign" in value ? value.sign : undefined);
  }
}

function appendProjectionSnapshot(snapshot: unknown[], projection: unknown) {
  snapshot.push(projection);
  if (typeof projection === "object" && projection !== null) {
    snapshot.push("real" in projection ? projection.real : undefined,
      "magnitude" in projection ? projection.magnitude : undefined,
      "phaseDegrees" in projection ? projection.phaseDegrees : undefined);
  }
}

function appendNormalizedTermsSnapshot(snapshot: unknown[], terms: unknown) {
  snapshot.push(terms);
  if (!Array.isArray(terms)) { return; }
  snapshot.push(terms.length);
  // Exact reading restoration uses indexed terms, not a custom iterator.
  for (const term of Array.from({ length: terms.length }, (_, index): unknown => terms[index])) {
    snapshot.push(term);
    if (typeof term !== "object" || term === null) { continue; }
    appendExactComponentSnapshot(snapshot, "real" in term ? term.real : undefined);
    appendExactComponentSnapshot(snapshot, "imaginary" in term ? term.imaginary : undefined);
    appendExactComponentSnapshot(snapshot, "magnitudeNormalizationSquared" in term ? term.magnitudeNormalizationSquared : undefined);
  }
}

function appendNormalizedFractionSnapshot(snapshot: unknown[], value: unknown) {
  snapshot.push(value);
  if (typeof value !== "object" || value === null) { return; }
  appendNormalizedTermsSnapshot(snapshot, "numerator" in value ? value.numerator : undefined);
  appendNormalizedTermsSnapshot(snapshot, "denominator" in value ? value.denominator : undefined);
}

export function appendExpressionTableSnapshot(snapshot: unknown[], expressions: readonly ExactExpressionNode[] | undefined) {
  snapshot.push(expressions);
  // Solver-owned histories are frozen recursively. Reuse their identity rather
  // than scanning thousands of expressions for every displayed wire or terminal.
  if (exactExpressionsAreImmutable(expressions)) { return; }
  try {
    if (!Array.isArray(expressions)) { return; }
    snapshot.push(expressions.length);
    for (const node of Array.from({ length: expressions.length }, (_, index) => expressions[index])) {
      snapshot.push(node, node?.operation);
      if (!node) { continue; }
      if (node.operation === "literal") {
        snapshot.push(node.numerator, node.denominator);
        continue;
      }
      snapshot.push(node.arguments);
      if (!Array.isArray(node.arguments)) { continue; }
      snapshot.push(node.arguments.length);
      for (const argument of Array.from({ length: node.arguments.length }, (_, index) => node.arguments[index])) {
        snapshot.push(argument);
      }
    }
  } catch {
    // Unreadable optional metadata must use the scalar fallback, never a
    // path cached from a previous usable table. A new token prevents reuse.
    snapshot.push({});
  }
}

export function appendExactComplexSnapshot(snapshot: unknown[], value: unknown) {
  snapshot.push(value);
  if (typeof value === "object" && value !== null) {
    try {
      appendExactComponentSnapshot(snapshot, "real" in value ? value.real : undefined);
      appendExactComponentSnapshot(snapshot, "imaginary" in value ? value.imaginary : undefined);
      appendExactComponentSnapshot(snapshot, "magnitudeNormalizationSquared" in value ? value.magnitudeNormalizationSquared : undefined);
      appendNormalizedFractionSnapshot(snapshot, "normalizedFraction" in value ? value.normalizedFraction : undefined);
      appendProjectionSnapshot(snapshot, "projection" in value ? value.projection : undefined);
    } catch {
      snapshot.push({});
    }
  }
}
