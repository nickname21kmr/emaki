import { useState } from 'react';
import type { AssistantDetection, AssistantSettings } from '@emaki/shared';
import { toast } from 'sonner';
import { Button, Field, Switch } from '@/components/ui';
import { SettingsSection, SettingsCard, BlockRow } from '@/features/settings/components/SettingsSection';
import { assistantApi, useAssistantSave, useAssistantSettings } from './client';

export const assistantInput = 'w-full rounded-md border border-line-strong bg-sheet px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-shu/30';
export function AssistantSettingsSection() {
  const query = useAssistantSettings(), save = useAssistantSave();
  const [busy, setBusy] = useState(false), [results, setResults] = useState<AssistantDetection[]>([]);
  const [external, setExternal] = useState('');
  const settings = query.data;
  const perform = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const detect = async () => { setResults(await assistantApi.detect()); await query.refetch(); };
  return <SettingsSection id="assistant" description="实验功能。连接已有 agent，或用 Pi 接入模型 API；默认关闭。对话和助手按需读取的图片会发送给所选模型服务。">
    <SettingsCard>
      <Field label="AI 助手" hint="关闭后停止助手运行，保留配置和 Emaki 对话；独立后台任务仍在任务列表管理。">
        <Switch label="开启 AI 助手" checked={settings?.enabled ?? false} disabled={busy || !settings}
          onCheckedChange={enabled => void perform(async () => { await save({ enabled }); if (enabled) await detect(); })} />
      </Field>
      {query.isError && <p role="alert" className="py-3 text-danger">{query.error.message}</p>}
      {settings?.enabled && <>
        <BlockRow label="运行后端" hint="只创建和恢复 Emaki 自己的对话。重新检测不会改变已选后端。">
          <div className="flex items-center gap-3">
            <select aria-label="助手后端" className={assistantInput} value={settings.backend ?? ''} disabled={busy} onChange={e => void perform(() => save({ backend: e.target.value || null }))}>
              <option value="">选择后端</option><option value="codex">Codex · 已有安装</option><option value="pi">Pi · 内置</option>
            </select><Button onClick={() => void perform(detect)} loading={busy}>重新检测</Button>
          </div>
          {results.map(result => <p key={result.backend} className="mt-2 break-words text-xs text-fg-muted">{result.backend === 'pi' ? 'Pi' : 'Codex'} · {result.available ? '可用' : '需配置'} · {result.detail}</p>)}
        </BlockRow>
        <Configuration key={JSON.stringify([settings.backend, settings.codexPath, settings.pi])} settings={settings} save={body => perform(() => save(body))} busy={busy} />
        <BlockRow label="供外部 Agent 使用的 MCP" hint="连接后可查询和修改图库。凭证仅用于这个 Emaki 实例，请妥善保存。">
          <Button size="sm" onClick={() => void perform(async () => { const c = await assistantApi.mcpConfig(); setExternal(JSON.stringify({ mcpServers: { emaki: { url: c.url, headers: { Authorization: `Bearer ${c.token}` } } } }, null, 2)); })}>显示连接配置</Button>
          {external && <textarea aria-label="MCP 连接配置" readOnly className={`${assistantInput} mt-3 h-44 font-mono text-xs`} value={external} />}
        </BlockRow>
      </>}
    </SettingsCard>
  </SettingsSection>;
}
function Configuration({ settings, save, busy }: { settings: AssistantSettings; save: (body: unknown) => Promise<unknown>; busy: boolean }) {
  const [binary, setBinary] = useState(settings.codexPath), [pi, setPi] = useState(settings.pi), [key, setKey] = useState('');
  if (settings.backend === 'codex') return <BlockRow label="Codex 路径" hint="留空时自动检测 PATH 和常见安装目录；登录沿用本机 Codex 配置。">
    <input aria-label="Codex 可执行文件路径" className={assistantInput} value={binary} onChange={e => setBinary(e.target.value)} placeholder="自动检测" />
    <Button className="mt-3" disabled={busy} onClick={() => void save({ codexPath: binary })}>保存路径</Button>
  </BlockRow>;
  if (settings.backend !== 'pi') return null;
  return <BlockRow label="Pi 模型 API" hint="留空时复用本机 Pi 的模型与 API Key 配置（暂不复用 OAuth 登录）。自定义 API 支持填写多个模型 ID，以逗号分隔。">
    <div className="space-y-3">
      <label className="block text-xs text-fg-muted">API 协议<select className={`${assistantInput} mt-1`} value={pi.api} onChange={e => setPi({ ...pi, api: e.target.value as typeof pi.api })}>
        <option value="openai-completions">OpenAI Chat Completions 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
      </select></label>
      <label className="block text-xs text-fg-muted">API 地址<input className={`${assistantInput} mt-1`} placeholder="https://…/v1" value={pi.baseUrl} onChange={e => setPi({ ...pi, baseUrl: e.target.value })} /></label>
      <label className="block text-xs text-fg-muted">模型 ID<input className={`${assistantInput} mt-1`} value={pi.model} onChange={e => setPi({ ...pi, model: e.target.value })} /></label>
      <label className="block text-xs text-fg-muted">API Key<input type="password" autoComplete="new-password" className={`${assistantInput} mt-1`} value={key} placeholder={pi.apiKeyConfigured ? '已保存；留空保持不变' : '填写密钥；本地无鉴权服务可以留空'} onChange={e => setKey(e.target.value)} /></label>
      <div className="flex flex-wrap gap-4 text-xs"><label><input type="checkbox" checked={pi.vision} onChange={e => setPi({ ...pi, vision: e.target.checked })} /> 模型支持看图</label><label><input type="checkbox" checked={pi.reasoning} onChange={e => setPi({ ...pi, reasoning: e.target.checked })} /> 模型支持思考强度</label></div>
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void save({ pi: { provider: pi.provider, baseUrl: pi.baseUrl, model: pi.model, api: pi.api, vision: pi.vision, reasoning: pi.reasoning }, ...(key ? { apiKey: key } : {}) })}>保存 API 配置</Button>
        {pi.apiKeyConfigured && <Button variant="ghost" disabled={busy} onClick={() => void save({ apiKey: '' })}>清除密钥</Button>}</div>
    </div>
  </BlockRow>;
}
