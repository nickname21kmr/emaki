import type { AssistantContext, AssistantDetection, AssistantModel, AssistantSession, AssistantSettings } from '@emaki/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '@/lib/api';

export const assistantApi = {
  settings: () => request<AssistantSettings>('GET', '/assistant/settings'),
  saveSettings: (body: unknown) => request<AssistantSettings>('PATCH', '/assistant/settings', body),
  detect: () => request<AssistantDetection[]>('POST', '/assistant/detect', {}),
  apiModels: (body: { baseUrl: string; api: AssistantSettings['pi']['api']; apiKey?: string }) => request<{ id: string; name: string }[]>('POST', '/assistant/api-models', body),
  mcpConfig: () => request<{ url: string; token: string }>('GET', '/assistant/mcp-config'),
  sessions: () => request<Pick<AssistantSession, 'id' | 'title' | 'backend' | 'updatedAt'>[]>('GET', '/assistant/sessions'),
  create: () => request<AssistantSession>('POST', '/assistant/sessions', {}),
  session: (id: string) => request<AssistantSession>('GET', `/assistant/sessions/${id}`),
  models: (id: string) => request<AssistantModel[]>('GET', `/assistant/sessions/${id}/models`),
  send: (id: string, body: { requestId: string; text: string; model: string; effort: string; context: AssistantContext }) => request<AssistantSession>('POST', `/assistant/sessions/${id}/messages`, body),
  stop: (id: string) => request('POST', `/assistant/sessions/${id}/stop`, {}),
  resume: (id: string, body: { requestId: string; messageId: string; model: string; effort: string }) => request<AssistantSession>('POST', `/assistant/sessions/${id}/resume`, body),
  answer: (id: string, requestId: string, value: string) => request('POST', `/assistant/sessions/${id}/answer`, { requestId, value }),
};
// 只在开启时每 30 秒同步一次；关闭时不轮询，省得空闲页面一直发请求
export function useAssistantSettings() { return useQuery({ queryKey: ['assistant-settings'], queryFn: assistantApi.settings, staleTime: 30000, refetchInterval: query => (query.state.data?.enabled ? 30000 : false) }); }
export function useAssistantSave() {
  const client = useQueryClient();
  return async (body: unknown) => { const settings = await assistantApi.saveSettings(body); client.setQueryData(['assistant-settings'], settings); await client.invalidateQueries({ queryKey: ['assistant-models'] }); return settings; };
}
