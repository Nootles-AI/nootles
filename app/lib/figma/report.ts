import type {
  ExtractionCoverage,
  ExtractionDiagnostic,
  JsonObject,
  JsonValue,
  ReferenceRender,
} from "./types";

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const objectSize = (value: JsonValue | undefined): number =>
  isObject(value) ? Object.keys(value).length : 0;

const pointerToken = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

type Inventory = {
  documentNodes: number;
  malformedNodes: number;
  interactions: number;
  imageFillReferences: Set<string>;
  vectorGeometryEntries: number;
  boundVariableReferences: Set<string>;
};

function countVariableAliases(value: JsonValue, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) countVariableAliases(child, into);
    return;
  }
  if (!isObject(value)) return;
  if (value.type === "VARIABLE_ALIAS" && typeof value.id === "string") into.add(value.id);
  for (const child of Object.values(value)) countVariableAliases(child, into);
}

function inventoryNode(
  value: JsonValue,
  pointer: string,
  inventory: Inventory,
  diagnostics: ExtractionDiagnostic[],
): void {
  if (!isObject(value)) {
    inventory.malformedNodes += 1;
    diagnostics.push({
      severity: "warning",
      code: "malformed_node",
      message: "A document-tree entry was not an object; the raw value was preserved.",
      pointer,
    });
    return;
  }

  const id = typeof value.id === "string" ? value.id : undefined;
  const validIdentity = id && typeof value.name === "string" && typeof value.type === "string";
  if (!validIdentity) {
    inventory.malformedNodes += 1;
    diagnostics.push({
      severity: "warning",
      code: "malformed_node",
      message: "A document-tree node lacked a string id, name, or type; the raw node was preserved.",
      ...(id ? { nodeId: id } : {}),
      pointer,
    });
  } else {
    inventory.documentNodes += 1;
  }

  if (Array.isArray(value.interactions)) inventory.interactions += value.interactions.length;
  else if (value.interactions !== undefined) {
    diagnostics.push({
      severity: "warning",
      code: "malformed_interactions",
      message: "A node's interactions field was not an array; the raw field was preserved.",
      ...(id ? { nodeId: id } : {}),
      pointer: `${pointer}/interactions`,
    });
  }

  for (const key of ["fillGeometry", "strokeGeometry", "vectorPaths"] as const) {
    const geometry = value[key];
    if (Array.isArray(geometry)) inventory.vectorGeometryEntries += geometry.length;
    else if (geometry !== undefined) {
      diagnostics.push({
        severity: "warning",
        code: "malformed_vector_geometry",
        message: `A node's ${key} field was not an array; the raw field was preserved.`,
        ...(id ? { nodeId: id } : {}),
        pointer: `${pointer}/${key}`,
      });
    }
  }

  for (const key of ["fills", "strokes"] as const) {
    const paints = value[key];
    if (!Array.isArray(paints)) continue;
    for (const paint of paints) {
      if (isObject(paint) && paint.type === "IMAGE" && typeof paint.imageRef === "string") {
        inventory.imageFillReferences.add(paint.imageRef);
      }
    }
  }

  const bindings = value.boundVariables;
  if (bindings !== undefined) countVariableAliases(bindings, inventory.boundVariableReferences);

  const children = value.children;
  if (children === undefined) return;
  if (!Array.isArray(children)) {
    inventory.malformedNodes += 1;
    diagnostics.push({
      severity: "warning",
      code: "malformed_children",
      message: "A node's children field was not an array; the raw field was preserved.",
      ...(id ? { nodeId: id } : {}),
      pointer: `${pointer}/children`,
    });
    return;
  }
  children.forEach((child, index) => inventoryNode(child, `${pointer}/children/${index}`, inventory, diagnostics));
}

function selectedNodeStats(
  nodesResponse: JsonObject | null,
  requestedIds: readonly string[],
  diagnostics: ExtractionDiagnostic[],
) {
  const nodes = nodesResponse?.nodes;
  if (!isObject(nodes)) {
    if (requestedIds.length) {
      diagnostics.push({
        severity: "warning",
        code: "malformed_selected_nodes_map",
        message: "The selected-node response lacked its nodes map; the raw response was preserved.",
        pointer: "/nodes",
      });
    }
    return { captured: 0, missing: requestedIds.length, dependencies: 0 };
  }
  let captured = 0;
  let missing = 0;
  let dependencies = 0;
  for (const id of requestedIds) {
    const entry = nodes[id];
    if (!isObject(entry) || !isObject(entry.document)) {
      missing += 1;
      if (isObject(entry)) {
        diagnostics.push({
          severity: "warning",
          code: "malformed_selected_node",
          message: "A selected-node entry lacked its document object; the raw entry was preserved.",
          nodeId: id,
          pointer: `/nodes/${pointerToken(id)}/document`,
        });
      }
      continue;
    }
    captured += 1;
    dependencies += objectSize(entry.components) + objectSize(entry.componentSets);
  }
  return { captured, missing, dependencies };
}

export function inspectExtraction(
  fileResponse: JsonObject,
  nodesResponse: JsonObject | null,
  selectedNodeIds: readonly string[],
  renders: Readonly<Record<string, ReferenceRender>>,
): { coverage: ExtractionCoverage; diagnostics: ExtractionDiagnostic[] } {
  const diagnostics: ExtractionDiagnostic[] = [];
  const inventory: Inventory = {
    documentNodes: 0,
    malformedNodes: 0,
    interactions: 0,
    imageFillReferences: new Set(),
    vectorGeometryEntries: 0,
    boundVariableReferences: new Set(),
  };

  if (fileResponse.document !== undefined) {
    inventoryNode(fileResponse.document, "/document", inventory, diagnostics);
  }

  for (const field of ["components", "componentSets", "styles"] as const) {
    if (!isObject(fileResponse[field])) {
      diagnostics.push({
        severity: "warning",
        code: `malformed_${field}`,
        message: `The Figma file response lacked its ${field} map; the raw response was preserved.`,
        pointer: `/${field}`,
      });
    }
  }

  const selected = selectedNodeStats(nodesResponse, selectedNodeIds, diagnostics);
  for (const id of selectedNodeIds) {
    const entries = nodesResponse?.nodes;
    if (!isObject(entries) || entries[id] === null || entries[id] === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "selected_node_missing",
        message: "Figma returned null or no entry for a requested node; the missing ID remains in the report.",
        nodeId: id,
        pointer: `/nodes/${pointerToken(id)}`,
      });
    }
  }

  if (inventory.boundVariableReferences.size) {
    diagnostics.push({
      severity: "info",
      code: "bound_variable_references_only",
      message:
        "Bound variable IDs were preserved. Figma's variable-definition endpoint cannot be pinned to a file version, so this versioned extractor does not call it.",
    });
  }

  const renderValues = Object.values(renders);
  const capturedRenders = renderValues.filter((render) => render.status === "captured").length;
  const coverage: ExtractionCoverage = {
    documentNodes: inventory.documentNodes,
    malformedNodes: inventory.malformedNodes,
    components: objectSize(fileResponse.components),
    componentSets: objectSize(fileResponse.componentSets),
    styles: objectSize(fileResponse.styles),
    interactions: inventory.interactions,
    imageFillReferences: inventory.imageFillReferences.size,
    vectorGeometryEntries: inventory.vectorGeometryEntries,
    boundVariableReferences: inventory.boundVariableReferences.size,
    selectedNodesRequested: selectedNodeIds.length,
    selectedNodesCaptured: selected.captured,
    selectedNodesMissing: selected.missing,
    selectedComponentDependencies: selected.dependencies,
    referenceRendersRequested: renderValues.length,
    referenceRendersCaptured: capturedRenders,
    referenceRendersMissing: renderValues.length - capturedRenders,
    unknownResponseFields: "preserved",
    variables: inventory.boundVariableReferences.size ? "bound-references-only" : "none-observed",
  };
  return { coverage, diagnostics };
}

export function sortDiagnostics(diagnostics: readonly ExtractionDiagnostic[]): ExtractionDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const a = [left.severity, left.code, left.nodeId ?? "", left.pointer ?? "", left.message].join("\0");
    const b = [right.severity, right.code, right.nodeId ?? "", right.pointer ?? "", right.message].join("\0");
    return a.localeCompare(b);
  });
}
