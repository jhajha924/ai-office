import type { OfficeConfig, RosterTitles } from './config.ts';

/**
 * Staff roster: the job title a sub-agent, a Skill or an MCP server is shown
 * with. Lookup order: the floor's override → the roster → the fallback.
 */

function lookup(
  kind: keyof RosterTitles,
  key: string,
  floor: string | undefined,
  config: OfficeConfig,
): string | undefined {
  const override = floor === undefined ? undefined : config.floorOverrides[floor]?.[kind];
  return override?.[key] ?? config.roster[kind][key];
}

/** Title for an Agent/Task sub-agent of the given subagent_type. */
export function subagentTitle(
  subagentType: string | undefined,
  floor: string | undefined,
  config: OfficeConfig,
): string {
  return (
    (subagentType === undefined ? undefined : lookup('subagents', subagentType, floor, config)) ??
    config.roster.fallbackSubagent
  );
}

/** Title for the synthetic employee a Skill invocation brings in. */
export function skillTitle(skill: string, floor: string | undefined, config: OfficeConfig): string {
  return lookup('skills', skill, floor, config) ?? config.roster.fallbackSkill.replace('{name}', skill);
}

/** The server segment of an MCP tool name (mcp__<server>__<tool>), or undefined. */
export function mcpServerName(toolName: string): string | undefined {
  const match = /^mcp__(.+?)__.+$/.exec(toolName);
  return match ? match[1] : undefined;
}

/** "<server> 外包窗口" (per mcpTemplate) for an MCP tool name, or undefined. */
export function mcpWindowName(toolName: string, config: OfficeConfig): string | undefined {
  const server = mcpServerName(toolName);
  return server === undefined ? undefined : config.roster.mcpTemplate.replace('{name}', server);
}
