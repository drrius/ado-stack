import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;
export const PACKAGE_NAME = packageJson.name;

export const GITHUB_OWNER = "drrius";
export const GITHUB_REPO = "ado-stack";
export const GITHUB_REPOSITORY = `${GITHUB_OWNER}/${GITHUB_REPO}`;
