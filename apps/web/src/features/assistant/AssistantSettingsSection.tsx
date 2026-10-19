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
  return <SettingsSection id="assistant" description="让助手帮你查找图片、核对角色和整理图库。对话和助手查看的图片会发送给所选模型服务。">
    <SettingsCard>
      <Field label="AI 助手（实验）" hint="关闭时停止助手，保留设置和对话。扫描、识别等后台任务在任务列表中管理。">
        <Switch label="开启 AI 助手" checked={settings?.enabled ?? false} disabled={busy || !settings}
          onCheckedChange={enabled => void perform(async () => { await save({ enabled }); if (enabled) await detect(); })} />
      </Field>
      {query.isError && <p role="alert" className="py-3 text-danger">{query.error.message}</p>}
      {settings?.enabled && <>
        <BlockRow label="操作权限" hint="完全访问允许助手读写本机文件、运行命令和联网，无需逐次审批。切换时暂停当前任务，可在对话中继续处理。">
          <select aria-label="助手操作权限" className={assistantInput} value={settings.accessMode} disabled={busy} onChange={e => void perform(() => save({ accessMode: e.target.value }))}>
            <option value="ask">按需审批</option><option value="full">完全访问</option>
          </select>
        </BlockRow>
        <BlockRow label="Agent 应用" hint="选择帮你调用模型、使用工具的应用。Codex、DSH 使用本机安装；Pi 内置，通过 API 连接模型。模型和思考强度在对话中选择。">
          <div className="flex items-center gap-3">
            <select aria-label="Agent 应用" className={assistantInput} value={settings.backend ?? ''} disabled={busy} onChange={e => void perform(() => save({ backend: e.target.value || null }))}>
              <option value="">选择 Agent 应用</option><option value="codex">Codex · 已有安装</option><option value="pi">Pi · 内置</option><option value="dsh">DSH · 已有安装</option>
            </select><Button onClick={() => void perform(detect)} loading={busy}>重新检测</Button>
          </div>
          {results.map(result => <p key={result.backend} className="mt-2 break-words text-xs text-fg-muted">{({ pi: 'Pi', codex: 'Codex', dsh: 'DSH' })[result.backend]} · {result.available ? `可用 · ${result.models.length} 个模型` : `需配置 · ${result.detail}`}</p>)}
        </BlockRow>
        <Configuration key={JSON.stringify([settings.backend, settings.codexPath, settings.dshPath, settings.pi])} settings={settings} save={body => perform(() => save(body))} busy={busy} />
        <BlockRow label="连接其他 Agent 应用（MCP）" hint="将配置复制到其他 Agent 应用，即可查询和修改此图库。配置中包含图库访问凭证。">
          <Button size="sm" onClick={() => void perform(async () => { const c = await assistantApi.mcpConfig(); setExternal(JSON.stringify({ mcpServers: { emaki: { url: c.url, headers: { Authorization: `Bearer ${c.token}` } } } }, null, 2)); })}>显示连接配置</Button>
          {external && <textarea aria-label="MCP 连接配置" readOnly className={`${assistantInput} mt-3 h-44 font-mono text-xs`} value={external} />}
        </BlockRow>
      </>}
    </SettingsCard>
  </SettingsSection>;
}
function Configuration({ settings, save, busy }: { settings: AssistantSettings; save: (body: unknown) => Promise<unknown>; busy: boolean }) {
  const [binary, setBinary] = useState(settings.backend === 'dsh' ? settings.dshPath ?? '' : settings.codexPath), [pi, setPi] = useState(settings.pi), [key, setKey] = useState('');
  const [available, setAvailable] = useState<{ id: string; name: string }[] | null>(null);
  const [fetching, setFetching] = useState(false), [modelError, setModelError] = useState(''), [search, setSearch] = useState('');
  const selected = new Set(pi.model.split(',').map(id => id.trim()).filter(Boolean));
  const readModels = async () => {
    setFetching(true); setModelError('');
    try {
      const models = await assistantApi.apiModels({ baseUrl: pi.baseUrl.trim(), api: pi.api, ...(key ? { apiKey: key } : {}) });
      setAvailable(models);
      setPi(current => ({ ...current, model: [...new Set([...current.model.split(',').map(id => id.trim()).filter(Boolean), ...models.map(m => m.id)])].join(', ') }));
    }
    catch (e) { setModelError((e as Error).message); }
    finally { setFetching(false); }
  };
  const resetModels = () => { setAvailable(null); setModelError(''); setSearch(''); };
  if (settings.backend === 'dsh') return <BlockRow label="DSH 路径" hint="留空自动查找本机 DSH，沿用其登录和模型配置。">
    <input aria-label="DSH 可执行文件路径" className={assistantInput} value={binary} onChange={e => setBinary(e.target.value)} placeholder="自动检测" />
    <Button className="mt-3" disabled={busy} onClick={() => void save({ dshPath: binary })}>保存路径</Button>
  </BlockRow>;
  if (settings.backend === 'codex') return <BlockRow label="Codex 路径" hint="留空自动查找本机 Codex，沿用其登录配置。">
    <input aria-label="Codex 可执行文件路径" className={assistantInput} value={binary} onChange={e => setBinary(e.target.value)} placeholder="自动检测" />
    <Button className="mt-3" disabled={busy} onClick={() => void save({ codexPath: binary })}>保存路径</Button>
  </BlockRow>;
  if (settings.backend !== 'pi') return null;
  return <BlockRow label="Pi 模型 API" hint="填写 API 地址和密钥，读取并保存模型列表，即可在对话中选用。也可留空以复用本机 Pi 的 API Key 配置。">
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-fg-muted">推荐选择支持图片输入（识图）的模型，让助手能直接查看图片、核对角色和来源。模型是否支持识图，以所用 API 服务的说明为准。</p>
      <label className="block text-xs text-fg-muted">API 协议<select className={`${assistantInput} mt-1`} disabled={fetching} value={pi.api} onChange={e => { setPi({ ...pi, api: e.target.value as typeof pi.api }); resetModels(); }}>
        <option value="openai-completions">OpenAI Chat Completions 兼容</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
      </select></label>
      <label className="block text-xs text-fg-muted">API 基础地址<input className={`${assistantInput} mt-1`} disabled={fetching} placeholder={pi.api === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://…/v1'} value={pi.baseUrl} onChange={e => { setPi({ ...pi, baseUrl: e.target.value }); resetModels(); }} /></label>
      <label className="block text-xs text-fg-muted">API Key<input type="password" autoComplete="new-password" className={`${assistantInput} mt-1`} disabled={fetching} value={key} placeholder={pi.apiKeyConfigured ? '已保存；留空保持不变' : '填写密钥；本地无鉴权服务可以留空'} onChange={e => { setKey(e.target.value); resetModels(); }} /></label>
      <div className="space-y-2">
        <Button size="sm" loading={fetching} disabled={busy || fetching || !pi.baseUrl.trim()} onClick={() => void readModels()}>读取模型列表</Button>
        {modelError && <p role="alert" className="text-xs text-danger">{modelError}</p>}
        {available && <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-xs text-fg-muted">服务提供 {available.length} 个模型 · 已选 {selected.size} 个</p>
          {available.length > 0 ? <>
            <input aria-label="筛选可用模型" className={assistantInput} placeholder="搜索模型名称或 ID" value={search} onChange={e => setSearch(e.target.value)} />
            <div className="max-h-56 overflow-y-auto space-y-1">
              {available.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase())).map(m => <label key={m.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-hover">
                <input type="checkbox" className="mt-0.5" checked={selected.has(m.id)} onChange={e => {
                  const ids = new Set(selected); if (e.target.checked) ids.add(m.id); else ids.delete(m.id);
                  setPi({ ...pi, model: [...ids].join(', ') });
                }} />
                <span className="min-w-0 break-all">{m.name}{m.name !== m.id && <span className="block text-fg-muted">{m.id}</span>}</span>
              </label>)}
            </div>
          </> : <p className="text-xs text-fg-muted">服务返回了空列表，可以手动填写模型 ID。</p>}
        </div>}
        <label className="block text-xs text-fg-muted">已选模型 ID（也可手填，英文逗号分隔）<input className={`${assistantInput} mt-1`} value={pi.model} onChange={e => setPi({ ...pi, model: e.target.value })} /></label>
      </div>
      <div className="flex flex-wrap gap-4 text-xs"><label><input type="checkbox" checked={pi.vision} onChange={e => setPi({ ...pi, vision: e.target.checked })} /> 模型支持看图</label><label><input type="checkbox" checked={pi.reasoning} onChange={e => setPi({ ...pi, reasoning: e.target.checked })} /> 模型支持思考强度</label></div>
      <p className="text-xs leading-relaxed text-fg-muted">以上能力设置适用于此 API 配置下的所有已选模型，请按模型实际支持的能力勾选。</p>
      <div className="flex gap-2"><Button disabled={busy || fetching} onClick={() => void save({ pi: { provider: pi.provider, baseUrl: pi.baseUrl.trim(), model: pi.model, api: pi.api, vision: pi.vision, reasoning: pi.reasoning }, ...(key ? { apiKey: key } : {}) })}>保存 API 配置</Button>
        {pi.apiKeyConfigured && <Button variant="ghost" disabled={busy || fetching} onClick={() => void save({ apiKey: '' })}>清除密钥</Button>}</div>
    </div>
  </BlockRow>;
}
