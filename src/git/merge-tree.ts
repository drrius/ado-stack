const CONTENT_CONFLICT = /^CONFLICT \(content\): (?:Merge conflict in )?(.+)$/;

export function parseContentConflictPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    const match = CONTENT_CONFLICT.exec(line);
    const path = match?.[1]?.trim();
    if (path) {
      paths.add(path);
    }
  }
  return [...paths];
}
