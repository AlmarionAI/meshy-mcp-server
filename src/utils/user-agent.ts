/**
 * User-Agent for Meshy API calls.
 *
 * The leading product token is always "meshy-mcp-server/<version>" (the API
 * attributes traffic by it). The app running this server goes in a trailing
 * comment: "meshy-mcp-server/0.6.5 (hermes-agent/0.22.2)".
 */

import { USER_AGENT } from "../version.js";

/** The app this server runs under, from MESHY_CLIENT or the MCP handshake's clientInfo. */
export interface HostInfo {
  name?: unknown;
  version?: unknown;
}

const NAME_MAX = 64;
const VERSION_MAX = 32;

// Keeps CR/LF, parentheses, semicolons and spaces out of the header.
function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, max) : "";
}

/** Parse "name[/version]", e.g. MESHY_CLIENT="hermes-meshy-plugin/0.4.0". */
export function parseHost(value: string | undefined): HostInfo | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  return slash < 0 ? { name: trimmed } : { name: trimmed.slice(0, slash), version: trimmed.slice(slash + 1) };
}

/** User-Agent naming the first host whose name survives sanitizing; none leaves the plain product token. */
export function userAgent(...hosts: (HostInfo | undefined)[]): string {
  for (const host of hosts) {
    const name = clean(host?.name, NAME_MAX);
    if (!name) continue;
    const version = clean(host?.version, VERSION_MAX);
    return `${USER_AGENT} (${version ? `${name}/${version}` : name})`;
  }
  return USER_AGENT;
}
