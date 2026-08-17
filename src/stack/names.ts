import { CliError } from "../errors/cli-error.ts";

const INVALID = /[\s~^:?*\[\\]|@{|\.\.|\/\/|^\.|\/$|\.lock$/;

export function applyBranchPrefix(name: string, prefix: string): string {
  if (!prefix) {
    return name;
  }
  if (name.startsWith(prefix)) {
    return name;
  }
  return `${prefix}${name}`;
}

export function validateBranchName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new CliError("Branch name is empty.");
  }
  if (name === "HEAD") {
    throw new CliError("HEAD is not a valid stack branch name.");
  }
  if (name.startsWith("-") || name.endsWith(".lock") || INVALID.test(name) || name.includes("\t")) {
    throw new CliError(
      `Invalid branch name \`${name}\`.\n\nUse a name Git accepts, without spaces or special ref characters.`,
    );
  }
}

export function looksLikePrNumber(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

export function parsePrNumber(value: string): number {
  if (!looksLikePrNumber(value)) {
    throw new CliError(`\`${value}\` is not a pull request number.`);
  }
  return Number(value);
}

export function displayName(branch: string, prefix: string): string {
  if (prefix && branch.startsWith(prefix)) {
    return branch.slice(prefix.length) || branch;
  }
  return branch;
}

export function resolveBranchArg(
  value: string,
  options: { prefix: string; known: string[] },
): string {
  if (options.known.includes(value)) {
    return value;
  }
  const prefixed = applyBranchPrefix(value, options.prefix);
  if (options.known.includes(prefixed)) {
    return prefixed;
  }
  return prefixed;
}
