export const STACK_PROPERTY_NAMESPACE = "ado-stack";

export const STACK_PROPERTIES = {
  version: "ado-stack.version",
  stackId: "ado-stack.stack-id",
  parent: "ado-stack.parent",
  branch: "ado-stack.branch",
  lastRestackBase: "ado-stack.last-restack-base",
} as const;

export type StackPrMetadata = {
  version: string;
  stackId: string;
  parent: string;
  branch: string;
  lastRestackBase: string;
};

export function encodeStackProperties(metadata: StackPrMetadata): Record<string, string> {
  return {
    [STACK_PROPERTIES.version]: metadata.version,
    [STACK_PROPERTIES.stackId]: metadata.stackId,
    [STACK_PROPERTIES.parent]: metadata.parent,
    [STACK_PROPERTIES.branch]: metadata.branch,
    [STACK_PROPERTIES.lastRestackBase]: metadata.lastRestackBase,
  };
}

export function decodeStackProperties(
  properties: Record<string, string>,
): StackPrMetadata | undefined {
  const version = properties[STACK_PROPERTIES.version];
  const stackId = properties[STACK_PROPERTIES.stackId];
  const parent = properties[STACK_PROPERTIES.parent];
  const branch = properties[STACK_PROPERTIES.branch];
  const lastRestackBase = properties[STACK_PROPERTIES.lastRestackBase];
  if (!version || !stackId || !parent || !branch || !lastRestackBase) {
    return undefined;
  }
  return { version, stackId, parent, branch, lastRestackBase };
}

export type JsonPatchOp = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: string;
};

export function propertyPatches(
  next: Record<string, string>,
  previous: Record<string, string> = {},
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (const [key, value] of Object.entries(next)) {
    ops.push({
      op: key in previous ? "replace" : "add",
      path: `/${key}`,
      value,
    });
  }
  return ops;
}
