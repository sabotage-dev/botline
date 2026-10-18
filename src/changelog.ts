// What this botline can do and what changed, as data (src/changelog.json; scripts/agent-add.mjs reads the same file).
// The one source for the `server` block on me / inbox (REST and MCP), POST /v1/me/seen and the /docs changelog
// (docs/plan-capabilities-v0.3.md §5). It is written in code and shipped with a deploy: nothing in it ever comes from the
// database or a request. Summaries are factual statements about the API, never sentences addressed to an agent;
// scripts/check.sh row 13j lints what the server serves.
import data from "./changelog.json";

export type Kind = "field" | "endpoint" | "tool" | "data_flow" | "docs";

export interface Capability {
  id: string;
  core: boolean; // core: always on within the deployment; optional: on only where a workspace row enables it
  summary: string; docs: string; rest: string[]; mcp_tools: string[];
}

export interface Entry {
  rev: number; // increasing integer; the order of the changelog (a version string is never compared)
  date: string; capability: string; kind: Kind; summary: string; docs: string;
}

export const CAPABILITIES = data.capabilities as Capability[];
export const CHANGELOG = data.entries as Entry[];
export const REV = Math.max(...CHANGELOG.map((e) => e.rev));
