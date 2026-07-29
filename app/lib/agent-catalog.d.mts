export type AgentProject = {
  id: string;
  index: string;
  title: string;
  shortTitle: string;
  responsibility: string;
  input: string;
  output: string;
  icon: string;
  accent: string;
  complianceRequired: boolean;
};

export const AGENT_PROJECTS: readonly AgentProject[];
export const AGENT_IDS: readonly string[];
export function getAgentById(agentId: string): AgentProject | null;
