import type { AssistantContext, AssistantDetection, AssistantModel, AssistantSession, AssistantSettings } from '@emaki/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '@/lib/api';

export const assistantApi = {
  settings: () => request<AssistantSettings>('GET', '/assistant/settings'),
  saveSettings: (body: unknown) => request<AssistantSettings>('PATCH', '/assistant/settings', body),
  detect: () => request<AssistantDetection[]>('POST', '/assistant/detect', {}),
  mcpConfig: () => request<{ url: string; token: string }>('GET', '/assistant/mcp-config'),
  sessions: () => request<Pick<AssistantSession, 'id' | 'title' | 'backend' | 'updatedAt'>[]>('GET', '/assistant/sessions'),
  create: () => request<AssistantSession>('POST', '/assistant/sessions', {}),
  session: (id: string) => request<AssistantSession>('GET', `/assistant/sessions/${id}`),
  models: (id: string) => request<AssistantModel[]>('GET', `/assistant/sessions/${id}/models`),
  send: (id: string, body: { requestId: string; text: string; model: string; effort: string; context: AssistantContext }) => request<AssistantSession>('POST', `/assistant/sessions/${id}/messages`, body),
  stop: (id: string) => request('POST', `/assistant/sessions/${id}/stop`, {}),
  answer: (id: string, requestId: string, value: string) => request('POST', `/assistant/sessions/${id}/answer`, { requestId, value }),
};
export function useAssistantSettings() { return useQuery({ queryKey: ['assistant-settings'], queryFn: assistantApi.settings, staleTime: 30000, refetchInterval: 30000 }); }
export function useAssistantSave() {
  const client = useQueryClient();
  return async (body: unknown) => { const settings = await assistantApi.saveSettings(body); client.setQueryData(['assistant-settings'], settings); await client.invalidateQueries({ queryKey: ['assistant-models'] }); return settings; };
}
