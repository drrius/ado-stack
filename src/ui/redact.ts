const AUTHORIZATION = /^(authorization)$/i;
const TOKEN_QUERY = /([?&](?:access_token|token|pat|password|secret)=)([^&]+)/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._\-]+/gi;
const BASIC = /Basic\s+[A-Za-z0-9+/=]+/gi;
const PAT_LIKE = /\b[a-z]{2}[0-9a-z]{50,}\b/gi;
const ENV_ASSIGN =
  /\b(?:AZURE_DEVOPS_EXT_PAT|ADO_STACK_PAT|SYSTEM_ACCESSTOKEN|ADO_TEST_PAT)=([^\s]+)/gi;

export function redactText(value: string): string {
  return value
    .replace(TOKEN_QUERY, "$1[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(BASIC, "Basic [redacted]")
    .replace(ENV_ASSIGN, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(PAT_LIKE, "[redacted]");
}

export function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) {
    result[key] = AUTHORIZATION.test(key) ? "[redacted]" : redactText(String(value));
  }
  return result;
}
