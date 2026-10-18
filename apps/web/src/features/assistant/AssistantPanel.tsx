import { useEffect, useRef, useState } from 'react';
import { useLocation, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantCard, AssistantSession, AssistantQuestion } from '@emaki/shared';
import { MessageCircle, Plus, Send, Square, X, Maximize2, Minimize2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, IconButton } from '@/components/ui';
import { Thumb } from '@/components/media/Thumb';
import { api } from '@/lib/api';
import { useLightbox, useSelection } from '@/lib/stores';
import { undo } from '@/lib/queries';
import { assistantApi, useAssistantSettings } from './client';
import { assistantInput } from './AssistantSettingsSection';

export function AssistantPanel() {
  const settings = useAssistantSettings().data, [open, setOpen] = useState(false);
  if (!settings?.enabled) return null;
  return <>{!open ? <button type="button" aria-label="打开 AI 助手" className="fixed bottom-6 right-6 z-40 flex size-12 items-center justify-center rounded-full bg-ink text-fg-inverse shadow-lg hover:scale-105" onClick={() => setOpen(true)}><MessageCircle size={22} /></button>
    : <Conversation key={settings.backend ?? ''} backend={settings.backend} close={() => setOpen(false)} />}</>;
}

function Conversation({ backend, close }: { backend: string | null; close: () => void }) {
  const client = useQueryClient(), location = useLocation();
  const [expanded, setExpanded] = useState(false), [sessionId, setSessionId] = useState(() => sessionStorage.getItem(`emaki.assistant.${backend}`) ?? '');
  const [session, setSession] = useState<AssistantSession | null>(null), [text, setText] = useState(''), [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [connected, setConnected] = useState(true);
  const selected = useSelection(s => s.ids), scope = useSelection(s => s.scope), lightbox = useLightbox();
  const submission = useRef<{ signature: string; requestId: string } | null>(null);
  const end = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
  const sessions = useQuery({ queryKey: ['assistant-sessions'], queryFn: assistantApi.sessions });
  const models = useQuery({ queryKey: ['assistant-models', sessionId], queryFn: () => assistantApi.models(sessionId), enabled: Boolean(sessionId), staleTime: 60000, retry: false });
  const currentModel = models.data?.find(m => m.id === model);
  const running = session?.status === 'running' || session?.status === 'waiting';
  const chooseSession = (id: string) => { setSession(null); setSessionId(id); setModel(''); setEffort(''); setError(''); sessionStorage.setItem(`emaki.assistant.${backend}`, id); };
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const events = new EventSource(`/api/assistant/sessions/${sessionId}/events`);
    events.onmessage = e => { const snapshot: AssistantSession = JSON.parse(e.data); setSession(snapshot); setConnected(true); };
    events.onerror = () => setConnected(false);
    events.addEventListener('disabled', () => { events.close(); void client.invalidateQueries({ queryKey: ['assistant-settings'] }); });
    void assistantApi.session(sessionId).then(s => { if (!disposed) setSession(previous => previous ?? s); }).catch(e => { if (!disposed) { setError(e.message); events.close(); } });
    return () => { disposed = true; events.close(); };
  }, [sessionId, client]);
  useEffect(() => {
    if (model || !session || !models.data?.length) return;
    const chosen = models.data.find(m => m.id === session?.model) ?? models.data[0]!;
    setModel(chosen.id); setEffort(chosen.efforts.includes(session?.effort ?? '') ? session!.effort : chosen.defaultEffort ?? '');
  }, [models.data, session?.model, session?.effort, model]);
  useEffect(() => { if (follow.current) end.current?.scrollIntoView({ behavior: 'auto' }); }, [session]);
  const perform = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const send = async (override?: { text: string; ids: string[] }) => {
    const value = override?.text ?? text; if (!value.trim() || !sessionId || !model) return;
    const imageIds = override?.ids ?? (lightbox.open && lightbox.ids[lightbox.index] ? [lightbox.ids[lightbox.index]!] : [...selected]);
    const context = { page: location.pathname + location.search, imageIds, selectionScope: scope };
    // Preserve the id after a lost response, including a manual retry of the same submission.
    const signature = JSON.stringify({ sessionId, text: value, model, effort, context });
    if (submission.current?.signature !== signature) submission.current = { signature, requestId: crypto.randomUUID() };
    await assistantApi.send(sessionId, { requestId: submission.current.requestId, text: value, model, effort, context });
    submission.current = null;
    setText(''); follow.current = true; void sessions.refetch();
  };
  return <aside role="dialog" aria-label="Emaki AI 助手" className={`fixed bottom-4 right-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-line-strong bg-sheet shadow-2xl ${expanded ? 'h-[88vh] w-[min(880px,calc(100vw-32px))]' : 'h-[min(700px,85vh)] w-[min(440px,calc(100vw-32px))]'}`}>
    <header className="flex items-center gap-2 border-b border-line px-4 py-3"><MessageCircle className="size-4 text-shu" /><strong className="flex-1 text-sm">Emaki 助手 <span className="ml-1 text-xs font-normal text-fg-muted">实验</span></strong>
      <IconButton label="新建对话" disabled={!backend || busy} onClick={() => void perform(async () => { const s = await assistantApi.create(); chooseSession(s.id); await sessions.refetch(); })}><Plus /></IconButton>
      <IconButton label={expanded ? '缩小面板' : '展开面板'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 /> : <Maximize2 />}</IconButton>
      <IconButton label="收起助手" onClick={close}><X /></IconButton>
    </header>
    <div className="border-b border-line px-4 py-2"><select aria-label="Emaki 对话历史" className={`${assistantInput} !py-1.5`} value={sessionId} onChange={e => chooseSession(e.target.value)}>
      <option value="">选择对话或点击右上角新建</option>{sessions.data?.filter(s => s.backend === backend).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
    </select></div>
    <div ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 scrollbar-thin">
      {!sessionId && <div className="py-8 text-sm leading-7 text-fg-muted"><p className="font-medium text-fg">围绕当前图库，一起处理问题。</p><p>选中图片后，可以询问角色、对照来源，或让助手查询和整理。图片按需读取。</p>{backend ? <Button className="mt-4" disabled={busy} onClick={() => void perform(async () => { const s = await assistantApi.create(); chooseSession(s.id); await sessions.refetch(); })}>开始新对话</Button> : <Link className="text-shu underline" to="/settings#assistant">先在设置中选择后端</Link>}</div>}
      {session?.messages.map(message => <div key={message.id} className={message.role === 'user' ? 'ml-5 rounded-xl bg-sunken p-3 text-sm' : 'text-sm leading-relaxed'}>
        <div className="mb-1 text-[11px] text-fg-subtle">{message.role === 'user' ? '你' : message.role === 'assistant' ? message.model ?? '助手' : message.role === 'tool' ? '操作' : '状态'}</div>
        {message.role === 'assistant' ? <div className="space-y-2 break-words [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-sunken [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-shu [&_a]:underline"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span>{alt ?? '图片'}</span> }}>{message.text}</Markdown></div> : <p className="whitespace-pre-wrap break-words">{message.text}</p>}
        {message.context && <p className="mt-2 text-[11px] text-fg-muted">{message.context.page} · {message.context.imageIds.length} 张图片</p>}
        {message.cards?.map(card => <ResultCard key={card.id} card={card} disabled={Boolean(running || busy)} feedback={ids => void perform(() => send({ text: `针对结果「${card.title}」，我选择了这 ${ids.length} 张图片，请围绕这个选择继续。`, ids }))} />)}
        {message.undoToken && <Button className="mt-2" size="sm" onClick={() => void undo(message.undoToken!, client)}>撤销这次修改</Button>}
      </div>)}
      {session?.questions.map(q => <Question key={q.id} question={q} answer={value => void perform(() => assistantApi.answer(sessionId, q.id, value))} disabled={busy} />)}
      {running && <p role="status" className="animate-pulse text-xs text-fg-muted">{session?.status === 'waiting' ? '等待你的回应' : '助手正在处理…'}</p>}
      {!connected && <p role="status" className="text-xs text-fg-muted">连接已断开，正在恢复；不会重新发送消息。</p>}
      {(error || models.error) && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg bg-danger-soft p-3 text-xs text-danger">{error || models.error?.message}</p>}
      <div ref={end} />
    </div>
    <form className="border-t border-line p-3" onSubmit={e => { e.preventDefault(); void perform(() => send()); }}>
      <p className="mb-2 truncate text-[11px] text-fg-muted" title={location.pathname + location.search}>上下文：{lightbox.open ? '当前查看的图片' : `选中 ${selected.size} 张`} · {location.pathname}</p>
      <textarea aria-label="给助手的消息" placeholder="询问当前图片，或描述你想完成的事情…" className={`${assistantInput} min-h-20 resize-none`} value={text} onChange={e => setText(e.target.value)} disabled={!sessionId} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!running && !busy) void perform(() => send()); } }} />
      <div className="mt-2 flex items-center gap-2">
        <select aria-label="助手模型" className="min-w-0 flex-1 rounded bg-sunken p-1.5 text-xs" value={model} disabled={Boolean(running || busy)} onChange={e => { setModel(e.target.value); setEffort(models.data?.find(m => m.id === e.target.value)?.defaultEffort ?? ''); }}><option value="">{models.isFetching ? '加载模型…' : '选择模型'}</option>{models.data?.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        {!!currentModel?.efforts.length && <select aria-label="思考强度" className="max-w-24 rounded bg-sunken p-1.5 text-xs" disabled={Boolean(running || busy)} value={effort} onChange={e => setEffort(e.target.value)}><option value="">默认</option>{currentModel.efforts.map(e => <option key={e} value={e}>{({ low: '低', medium: '中', high: '高', xhigh: '很高', off: '关闭' } as Record<string, string>)[e] ?? e}</option>)}</select>}
        {running ? <IconButton label="停止助手" onClick={() => void perform(() => assistantApi.stop(sessionId))}><Square /></IconButton> : <IconButton label="发送消息" type="submit" disabled={!text.trim() || !model || busy}><Send /></IconButton>}
      </div>
      {currentModel && !currentModel.vision && <p className="mt-1 text-[11px] text-fg-muted">当前模型不支持图片输入，可以查询元数据。</p>}
    </form>
  </aside>;
}
function Question({ question, answer, disabled }: { question: AssistantQuestion; answer: (value: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  return <div className="space-y-3 rounded-xl border border-line-strong p-3"><p className="whitespace-pre-wrap text-sm">{question.title}</p>
    {question.kind === 'approval' ? <div className="flex gap-2"><Button disabled={disabled} onClick={() => answer('approve')}>允许这次操作</Button><Button disabled={disabled} variant="ghost" onClick={() => answer('deny')}>拒绝</Button></div> : <>
      {question.options?.map(option => <Button key={option} className="mr-2 mb-2" disabled={disabled} size="sm" onClick={() => answer(option)}>{option}</Button>)}
      <input aria-label="回应助手" className={assistantInput} value={text} onChange={e => setText(e.target.value)} /><Button disabled={disabled || !text.trim()} size="sm" onClick={() => answer(text)}>回复</Button>
    </>}
  </div>;
}
function ResultCard({ card, feedback, disabled }: { card: AssistantCard; feedback: (ids: string[]) => void; disabled: boolean }) {
  const [selected, setSelected] = useState(new Set(card.imageIds));
  return <div className="mt-3 space-y-2 rounded-xl border border-line p-3"><strong>{card.title}</strong>
    {card.imageIds.length > 0 && <><div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">{card.imageIds.map(id => <div key={id} className="relative"><ResultImage id={id} ids={card.imageIds} /><input type="checkbox" aria-label={`选择图片 ${id}`} className="absolute left-1 top-1" checked={selected.has(id)} onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(id) : next.delete(id); return next; })} /></div>)}</div><Button size="sm" disabled={disabled || !selected.size} onClick={() => feedback([...selected])}>围绕选中的 {selected.size} 张继续</Button></>}
    {card.columns && <div className="max-h-72 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{card.columns.map((c, i) => <th key={i} className="border-b border-line p-2">{c}</th>)}</tr></thead><tbody>{card.rows?.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="border-b border-line p-2">{String(v ?? '')}</td>)}</tr>)}</tbody></table></div>}
  </div>;
}
function ResultImage({ id, ids }: { id: string; ids: string[] }) {
  const image = useQuery({ queryKey: ['image', id], queryFn: () => api.image(id), staleTime: 60000 });
  return <button type="button" className="block h-24 w-full overflow-hidden rounded bg-sunken" aria-label={`查看图片 ${id}`} onClick={() => useLightbox.getState().show(ids, ids.indexOf(id))}>{image.data ? <Thumb image={image.data} width={240} className="h-full w-full" /> : <span className="text-xs">{id}</span>}</button>;
}
