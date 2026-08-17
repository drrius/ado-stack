export type AzureDevOpsRemote = {
  organization: string;
  organizationUrl: string;
  project: string;
  repository: string;
  originalUrl: string;
};

function stripDotGit(value: string): string {
  return value.replace(/\.git$/i, "");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanPath(value: string): string {
  return stripDotGit(decode(value)).replace(/\/+$/, "");
}

function organizationUrl(organization: string): string {
  return `https://dev.azure.com/${organization}`;
}

function fromHttpsDevAzure(url: URL): AzureDevOpsRemote | undefined {
  const host = url.hostname.toLowerCase();
  if (host !== "dev.azure.com") {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  if (gitIndex < 2 || gitIndex + 1 >= parts.length) {
    return undefined;
  }
  const organization = decode(parts[0] ?? "");
  const project = decode(parts.slice(1, gitIndex).join("/"));
  const repository = cleanPath(parts.slice(gitIndex + 1).join("/"));
  if (!organization || !project || !repository) {
    return undefined;
  }
  return {
    organization,
    organizationUrl: organizationUrl(organization),
    project,
    repository,
    originalUrl: url.toString(),
  };
}

function fromVisualStudio(url: URL): AzureDevOpsRemote | undefined {
  const match = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
  if (!match) {
    return undefined;
  }
  const organization = decode(match[1] ?? "");
  const parts = url.pathname.split("/").filter(Boolean);
  const withoutCollection =
    parts[0]?.toLowerCase() === "defaultcollection" ? parts.slice(1) : parts;
  const gitIndex = withoutCollection.findIndex((part) => part.toLowerCase() === "_git");
  if (gitIndex < 1 || gitIndex + 1 >= withoutCollection.length) {
    return undefined;
  }
  const project = decode(withoutCollection.slice(0, gitIndex).join("/"));
  const repository = cleanPath(withoutCollection.slice(gitIndex + 1).join("/"));
  if (!organization || !project || !repository) {
    return undefined;
  }
  return {
    organization,
    organizationUrl: organizationUrl(organization),
    project,
    repository,
    originalUrl: url.toString(),
  };
}

function parseSshDevAzure(raw: string): AzureDevOpsRemote | undefined {
  const sshLike = raw.replace(/^ssh:\/\//i, "");
  const match = sshLike.match(
    /^(?:git@)?ssh\.dev\.azure\.com(?::\d+)?(?::|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i,
  );
  if (!match) {
    return undefined;
  }
  const organization = decode(match[1] ?? "");
  const project = decode(match[2] ?? "");
  const repository = cleanPath(match[3] ?? "");
  if (!organization || !project || !repository) {
    return undefined;
  }
  return {
    organization,
    organizationUrl: organizationUrl(organization),
    project,
    repository,
    originalUrl: raw,
  };
}

function parseSshVisualStudio(raw: string): AzureDevOpsRemote | undefined {
  const sshLike = raw.replace(/^ssh:\/\//i, "");
  const match = sshLike.match(
    /^(?:git@)?vs-ssh\.visualstudio\.com(?::\d+)?(?::|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i,
  );
  if (!match) {
    return undefined;
  }
  const organization = decode(match[1] ?? "");
  const project = decode(match[2] ?? "");
  const repository = cleanPath(match[3] ?? "");
  if (!organization || !project || !repository) {
    return undefined;
  }
  return {
    organization,
    organizationUrl: organizationUrl(organization),
    project,
    repository,
    originalUrl: raw,
  };
}

function tryUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function parseAzureDevOpsRemote(raw: string): AzureDevOpsRemote | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshDev = parseSshDevAzure(trimmed);
  if (sshDev) {
    return sshDev;
  }
  const sshVs = parseSshVisualStudio(trimmed);
  if (sshVs) {
    return sshVs;
  }

  const url = tryUrl(trimmed);
  if (!url) {
    return undefined;
  }
  return fromHttpsDevAzure(url) ?? fromVisualStudio(url);
}
