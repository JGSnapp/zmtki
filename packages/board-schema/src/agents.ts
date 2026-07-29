import { z } from 'zod';

export const ApprovalPolicySchema = z.enum(['never', 'onRequest', 'untrusted']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const SandboxPolicySchema = z.enum([
  /** Reads anywhere, writes nowhere. */
  'readOnly',
  /** Reads anywhere, writes confined to the board folder. */
  'boardWrite',
  /** No confinement. Requires an explicit opt-in per agent. */
  'fullAccess'
]);
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export const AgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'running',
  'waitingApproval',
  'waitingInput',
  'paused',
  'error'
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const ModelRefSchema = z.object({
  /** Id of an endpoint in the app-level provider registry. */
  endpointId: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(8192),
  /** Tried in order when the primary endpoint fails before producing output. */
  fallbacks: z.array(z.object({ endpointId: z.string(), model: z.string() })).default([])
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const AgentSchema = z.object({
  /** Globally unique across all boards, so rooms can span projects. */
  id: z.string(),
  name: z.string(),
  /** Short handle used for @mentions. */
  handle: z.string(),
  avatarColor: z.string().default('#6ea8fe'),
  /** Board this agent is resident on. Only it may write to that board. */
  homeBoardId: z.string(),
  /** Frame node that embodies the agent on its home board. */
  frameNodeId: z.string().nullable().default(null),
  persona: z.string().default(''),
  model: ModelRefSchema,
  toolsets: z.array(z.string()).default(['core', 'board', 'files', 'shell', 'web', 'rooms']),
  approvalPolicy: ApprovalPolicySchema.default('onRequest'),
  sandboxPolicy: SandboxPolicySchema.default('boardWrite'),
  status: AgentStatusSchema.default('idle'),
  /** Board spatial / lifecycle events that wake this agent. */
  subscriptions: z
    .array(
      z.object({
        event: z.string(),
        filter: z.record(z.unknown()).optional()
      })
    )
    .default([]),
  /** Maximum sampling round-trips within a single turn. */
  maxRounds: z.number().int().positive().default(24),
  createdAt: z.number().int().default(0)
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentsFileSchema = z.object({
  version: z.literal(1).default(1),
  agents: z.array(AgentSchema).default([])
});
export type AgentsFile = z.infer<typeof AgentsFileSchema>;

export function agentHandleFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}
