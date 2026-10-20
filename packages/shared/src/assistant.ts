/** Provider-neutral UI contract. Native agent history stays with its harness. */
export type AssistantBackend = 'codex' | 'pi' | 'dsh';
export interface AssistantSettings {
  enabled: boolean;
  accessMode: 'ask' | 'full';
  backend: AssistantBackend | null;
  codexPath: string;
  dshPath?: string;
  pi: { provider: string; baseUrl: string; model: string; api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; apiKeyConfigured: boolean; vision: boolean; reasoning: boolean };
}
export interface AssistantModel {
  id: string;
  name: string;
  provider?: string;
  efforts: string[];
  defaultEffort?: string;
  vision: boolean;
}
export interface AssistantContext { page: string; imageIds: string[]; selectionScope?: string }
export interface AssistantCard {
  id: string;
  title: string;
  imageIds: string[];
  columns?: string[];
  rows?: unknown[][];
}
export interface AssistantQuestion {
  id: string;
  title: string;
  kind: 'approval' | 'input';
  options?: string[];
  /** App-owned follow-up, answered as a new turn rather than a pending harness RPC. */
  source?: 'emaki';
  context?: AssistantContext;
}
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  model?: string;
  createdAt?: number;
  context?: AssistantContext;
  cards?: AssistantCard[];
  undoToken?: string;
  details?: string;
  tool?: {
    status: 'running' | 'succeeded' | 'failed' | 'interrupted';
    input?: string;
    output?: string;
    progress?: string;
    exitCode?: number;
    startedAt: number;
    finishedAt?: number;
  };
  reasoning?: { text: string; status: 'running' | 'completed' | 'interrupted'; startedAt: number; finishedAt?: number };
  /** Original user request when continuing interrupted work. */
  resumeOf?: string;
}
export interface AssistantSession {
  id: string;
  title: string;
  backend: AssistantBackend;
  model: string;
  effort: string;
  status: 'idle' | 'running' | 'waiting' | 'error';
  messages: AssistantMessage[];
  questions: AssistantQuestion[];
  updatedAt: string;
  interruption?: { messageId: string; reason: 'restart' | 'error' | 'stopped' };
}
export interface AssistantDetection { backend: AssistantBackend; available: boolean; path?: string; detail: string; models: AssistantModel[] }
