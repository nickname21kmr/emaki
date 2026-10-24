import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Copy, RotateCw } from 'lucide-react';
import type { AssistantBackend, AssistantDetection, AssistantSettings } from '@emaki/shared';
import { toast } from 'sonner';
import { Badge, Button, Dialog, DialogFooter, Field, IconButton, Input, SearchInput, Segmented, Spinner, Switch, type SegmentedOption } from '@/components/ui';
import { cn } from '@/lib/cn';
import { modKeyLabel } from '@/lib/hotkeys';
import { SettingsSection, SettingsCard, BlockRow } from '@/features/settings/components/SettingsSection';
import { assistantApi, useAssistantSave, useAssistantSettings } from './client';
import { BACKEND_LABEL } from './presentation';

/**
 * 设置 → AI 助手（final-spec §13）。BackendList、PiModelPicker、AssistantDisclosure 是纯组件，
 * DevUiPage 也直接拿来展示各种状态。
 */

const DISCLOSURE = [
  { title: '会发给模型服务的内容', body: '你发给助手的话、发送时的页面和选中的图片、助手查到的图库信息（文件路径和文件夹名、角色、标签、分级等），以及它查看的图片，都会发给你选的模型服务，按该服务计费。' },
  { title: '查出处前先问你', body: '你同意后，才会把去掉元数据的图片副本（装了 Pillow 时还会缩小）上传到 Yandex、SauceNAO 等搜图网站。Agent 应用也可能自己联网搜索网页。' },
  { title: '它在本机能做什么', body: '通过本机的 Codex、Pi 或 DSH 运行。按需审批时，改对话目录以外的文件、运行超出沙盒的命令前会先问你；Pi 读对话目录以外的文件也会问，Codex、DSH 读本机文件通常不问。完全访问时都不再询问。上传前征求同意、不移动或删除图库文件，都靠助手遵守指令，程序不会另外拦截。' },
  { title: '开启后会检测本机', body: '启动 Codex、Pi、DSH 读取登录状态和模型列表，不发送图库内容。关闭开关会结束助手进程，保留设置和对话。' },
];

/** 开启前要用户看完的四点：哪些内容会离开这台电脑、助手在本机能做什么 */
export function AssistantDisclosure() {
  return (
    <ol className="-mt-1">
      {DISCLOSURE.map((it, i) => (
        <li key={it.title} className="flex gap-4 border-t border-line py-3 first:border-t-0">
          <span aria-hidden className="numeral w-5 shrink-0 pt-0.5 text-[20px] text-fg-subtle tabular">{i + 1}</span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">{it.title}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{it.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ Agent 应用

const BACKENDS: readonly AssistantBackend[] = ['codex', 'pi', 'dsh'];
const BACKEND_SUB: Record<AssistantBackend, string> = { codex: '本机安装，沿用它的登录', pi: '内置，通过下面的 API 连接模型', dsh: '本机安装，沿用它的登录' };

export interface BackendListProps {
  value: AssistantBackend | null;
  /** 检测结果；undefined 或缺某一项 = 没检测过 */
  detections: readonly AssistantDetection[] | undefined;
  detecting?: boolean;
  /** 正在保存的那一行 */
  busyBackend?: AssistantBackend | null;
  onChange: (backend: AssistantBackend) => void;
}

/**
 * Agent 应用单选：墨色圆点（不用朱），每行写检测结果。
 * ↑↓ 只移动焦点，空格 / Enter 或点击才保存：每换一次都会重启助手进程，不能按一下存一次
 */
export function BackendList({ value, detections, detecting, busyBackend, onChange }: BackendListProps) {
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const current = value ? BACKENDS.indexOf(value) : 0;
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    rows.current[(i + step + BACKENDS.length) % BACKENDS.length]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Agent 应用" aria-busy={detecting || undefined} className="-mx-2 space-y-0.5">
      {BACKENDS.map((b, i) => {
        const d = detections?.find((x) => x.backend === b);
        const checked = b === value;
        return (
          <button
            key={b}
            ref={(el) => {
              rows.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === current ? 0 : -1}
            onClick={() => onChange(b)}
            onKeyDown={(e) => move(e, i)}
            className="flex min-h-12 w-full items-center gap-3 rounded-[11px] px-2 py-2 text-left transition-colors hover:bg-hover aria-checked:bg-hover"
          >
            <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-line-strong">
              {checked && <span className="size-2 rounded-full bg-ink" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] leading-5 font-medium">{BACKEND_LABEL[b]}</span>
              <span className={cn('block text-[12px] leading-4 break-words', d && !d.available ? 'text-warn' : 'text-fg-muted')}>
                {d && !d.available ? d.detail : BACKEND_SUB[b]}
              </span>
            </span>
            {busyBackend === b ? (
              <Spinner className="size-3.5 text-fg-subtle" />
            ) : !d ? (
              // 正在用的那个没有检测结果时不写「未检测」，免得像没装好
              <span className="shrink-0 text-[12px] text-fg-subtle">{checked ? '已选用' : '未检测'}</span>
            ) : d.available ? (
              <Badge tone="ok" dot>{d.models.length} 个模型</Badge>
            ) : (
              <Badge tone="warn" dot>需配置</Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

const DETECT_KEY = 'emaki.assistant.detect';

/** 上次检测的结果存在 sessionStorage：站内切页、刷新都不丢 */
function storedDetections(): AssistantDetection[] | undefined {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(DETECT_KEY) ?? 'null');
    return Array.isArray(parsed) ? (parsed as AssistantDetection[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 去掉某个 backend 的检测结果（缓存和 sessionStorage 一起），那一行回到没检测过的样子 */
export function dropDetection(client: QueryClient, backend: AssistantBackend) {
  const next = client.setQueryData<AssistantDetection[]>(['assistant-detect'], (d) => d?.filter((x) => x.backend !== backend));
  try {
    if (next) sessionStorage.setItem(DETECT_KEY, JSON.stringify(next));
  } catch {
    /* 存不了就只在这次生效 */
  }
}

/** 检测会拉起 Codex、Pi、DSH，所以不自动跑：只在开启时和点「重新检测」时跑 */
function useDetections() {
  return useQuery({
    queryKey: ['assistant-detect'],
    queryFn: async () => {
      const results = await assistantApi.detect();
      try {
        sessionStorage.setItem(DETECT_KEY, JSON.stringify(results));
      } catch {
        /* 存不了就只在这次生效 */
      }
      return results;
    },
    initialData: storedDetections,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ------------------------------------------------------------------ Pi 模型列表

export interface PiModelPickerProps {
  /** 读到的模型；null = 还没读 */
  models: readonly { id: string; name: string }[] | null;
  selected: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  /** 读取失败的原因：有它就只显示这一行 */
  error?: string;
}

/** 读到的 Pi 模型列表：能筛选、能勾选（墨色勾，不用朱），不套描边框 */
export function PiModelPicker({ models, selected, onToggle, error }: PiModelPickerProps) {
  const [search, setSearch] = useState('');
  if (error) return <p role="alert" className="text-[12px] text-danger">{error}</p>;
  if (!models) return null;
  if (!models.length) return <p className="text-[12px] text-fg-subtle">服务返回了空列表，可以在下面手填。</p>;
  const q = search.trim().toLowerCase();
  const shown = q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
  return (
    <div>
      <SearchInput size="sm" aria-label="筛选模型" placeholder="筛选模型名或 ID" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} />
      <ul className="mt-2 -mx-1 max-h-56 overflow-y-auto overscroll-contain scrollbar-thin">
        {shown.map((m) => {
          const on = selected.has(m.id);
          return (
            <li key={m.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => onToggle(m.id, !on)}
                className="flex w-full items-start gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
              >
                <span
                  aria-hidden
                  className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px]', on ? 'bg-ink text-fg-inverse' : 'text-transparent ring-1 ring-line-strong ring-inset')}
                >
                  <Check className="size-3" strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1 break-all">
                  {m.name}
                  {m.id !== m.name && <span className="block font-mono text-[11px] text-fg-subtle">{m.id}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ 设置节

type Perform = (fn: () => Promise<unknown>) => Promise<boolean>;

const ACCESS_OPTIONS: SegmentedOption<AssistantSettings['accessMode']>[] = [
  { value: 'ask', label: '按需审批' },
  { value: 'full', label: '完全访问' },
];

export function AssistantSettingsSection() {
  const query = useAssistantSettings(), save = useAssistantSave();
  const detections = useDetections();
  const [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const [pendingBackend, setPendingBackend] = useState<AssistantBackend | null>(null);
  const switchBox = useRef<HTMLSpanElement>(null);
  const refocusSwitch = useRef(false);
  useEffect(() => {
    if (busy || !refocusSwitch.current) return;
    refocusSwitch.current = false;
    // 这期间用户已经点到别处就不抢
    if (document.activeElement && document.activeElement !== document.body) return;
    switchBox.current?.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true });
  }, [busy]);
  const settings = query.data;
  // 出错时 toast 报原因，返回 false
  const perform: Perform = async (fn) => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const detect = async () => {
    await detections.refetch({ throwOnError: true });
    await query.refetch();
  };
  const enable = () => {
    setConfirming(false);
    void perform(async () => {
      await save({ enabled: true });
      toast('助手已开启', { description: `点右下角的助手，或按 ${modKeyLabel} J` });
      await detect();
    });
  };
  const chooseBackend = (backend: AssistantBackend) => {
    // 上一次切换还没存完时不再发：并发的 PATCH 可能让界面和服务端对不上
    if (backend === settings?.backend || pendingBackend) return;
    setPendingBackend(backend);
    void perform(() => save({ backend })).finally(() => setPendingBackend((p) => (p === backend ? null : p)));
  };
  const accessHint =
    settings?.accessMode === 'full' ? (
      <>
        读写文件、运行命令、联网都不再询问。切换会暂停当前任务。
        <p className="mt-1 text-[12.5px] text-warn">上传图片前征求同意只靠助手自觉。</p>
      </>
    ) : (
      '改对话目录外的文件、运行沙盒外的命令前先问你。切换会暂停当前任务。'
    );
  const backend = settings?.backend ?? null;
  const detection = detections.data?.find((d) => d.backend === backend);

  return (
    <SettingsSection id="assistant" description="让助手帮你找图、认角色、整理图库。对话和它看过的图片会发给你选的模型服务。">
      <SettingsCard>
        <Field label="开启助手" hint="关闭会结束助手进程，设置和对话都保留。">
          {/* 开启先确认，关闭直接生效 */}
          <span ref={switchBox} className="contents">
            <Switch
              label="开启 AI 助手"
              checked={settings?.enabled ?? false}
              disabled={busy || !settings}
              onCheckedChange={(enabled) => {
                if (enabled) setConfirming(true);
                else void perform(() => save({ enabled: false }));
              }}
            />
          </span>
        </Field>
        {query.isError && (
          <div role="alert" className="flex items-center gap-3 py-3 text-[12.5px] text-danger">
            <CircleAlert className="size-3.5 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 break-words">{query.error.message}</span>
            <Button size="sm" variant="outline" loading={query.isFetching} onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        )}
        {settings?.enabled && (
          <>
            <Field label="操作权限" hint={accessHint}>
              <Segmented size="sm" value={settings.accessMode} options={ACCESS_OPTIONS} disabled={busy} onChange={(accessMode) => void perform(() => save({ accessMode }))} />
            </Field>
            <BlockRow
              label={
                <span className="flex items-center justify-between gap-3">
                  Agent 应用
                  <Button size="sm" variant="ghost" className="-my-1" icon={<RotateCw strokeWidth={1.8} />} loading={detections.isFetching} disabled={busy} onClick={() => void perform(detect)}>
                    重新检测
                  </Button>
                </span>
              }
              hint="负责调用模型和工具。模型和思考强度在对话里选。"
            >
              <BackendList value={pendingBackend ?? backend} detections={detections.data} detecting={detections.isFetching} busyBackend={pendingBackend} onChange={chooseBackend} />
            </BlockRow>
            {(backend === 'codex' || backend === 'dsh') && (
              <PathRow key={`${backend}:${backend === 'dsh' ? settings.dshPath ?? '' : settings.codexPath}`} backend={backend} settings={settings} detection={detection} busy={busy} perform={perform} save={save} />
            )}
            {backend === 'pi' && <PiApiRow key={JSON.stringify(settings.pi)} pi={settings.pi} busy={busy} perform={perform} save={save} />}
            <McpRow busy={busy} perform={perform} />
          </>
        )}
      </SettingsCard>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        // 对话框不是从 Radix 的触发器打开的，关上后自己把焦点还给开关
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const sw = switchBox.current?.querySelector<HTMLButtonElement>('[role="switch"]');
          // 点了「开启」时开关正在保存、是 disabled 的，focus 不上：等保存完再还
          if (sw?.disabled) refocusSwitch.current = true;
          else sw?.focus({ preventScroll: true });
        }}
        title="开启 AI 助手？"
        description="实验功能。开启前请看一下这四点。"
        width={520}
      >
        <AssistantDisclosure />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={enable}>
            我已了解，开启
          </Button>
        </DialogFooter>
      </Dialog>
    </SettingsSection>
  );
}

type Save = (body: unknown) => Promise<unknown>;

/** Codex / DSH 的可执行文件位置：留空自动查找，检测到了就把找到的路径写进 placeholder */
function PathRow({ backend, settings, detection, busy, perform, save }: { backend: 'codex' | 'dsh'; settings: AssistantSettings; detection?: AssistantDetection; busy: boolean; perform: Perform; save: Save }) {
  const client = useQueryClient();
  const saved = backend === 'dsh' ? settings.dshPath ?? '' : settings.codexPath;
  const [path, setPath] = useState(saved);
  const dirty = path.trim() !== saved.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    const body = backend === 'dsh' ? { dshPath: path.trim() } : { codexPath: path.trim() };
    if (!(await perform(() => save(body)))) return;
    // 换了位置，上次的检测结果（比如「未找到」）就不作数了，等重新检测
    dropDetection(client, backend);
    toast('已保存', { description: '点「重新检测」确认能不能用' });
  };
  return (
    <BlockRow
      label={backend === 'dsh' ? 'DSH 位置' : 'Codex 位置'}
      hint={backend === 'dsh' ? '留空自动查找，沿用它的登录和模型配置。' : '留空自动查找，沿用它的登录配置。对话记录由 Codex 存在 ~/.codex，删除 Emaki 数据不会清理。'}
    >
      <form className="flex gap-2" onSubmit={(e) => void submit(e)}>
        <Input
          className="flex-1 font-mono !text-[12.5px]"
          aria-label="可执行文件路径"
          placeholder={detection?.path ? `自动查找（找到 ${detection.path}）` : '自动查找'}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy || !dirty}>
          保存
        </Button>
      </form>
    </BlockRow>
  );
}

const PROTOCOLS: SegmentedOption<AssistantSettings['pi']['api']>[] = [
  { value: 'openai-completions', label: 'OpenAI 兼容' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic' },
];

const splitIds = (text: string) => text.split(',').map((id) => id.trim()).filter(Boolean);

/** Pi 的模型 API：协议、地址、密钥，读到列表后勾选；能力开关对这组配置里的所有模型生效 */
function PiApiRow({ pi: savedPi, busy, perform, save }: { pi: AssistantSettings['pi']; busy: boolean; perform: Perform; save: Save }) {
  const id = useId();
  const [pi, setPi] = useState(savedPi), [key, setKey] = useState('');
  const [available, setAvailable] = useState<{ id: string; name: string }[] | null>(null);
  const [fetching, setFetching] = useState(false), [modelError, setModelError] = useState('');
  const selected = new Set(splitIds(pi.model));
  const readModels = async () => {
    setFetching(true);
    setModelError('');
    try {
      const models = await assistantApi.apiModels({ baseUrl: pi.baseUrl.trim(), api: pi.api, ...(key ? { apiKey: key } : {}) });
      setAvailable(models);
      // 读到的先全部选上，再按需去掉
      setPi((current) => ({ ...current, model: [...new Set([...splitIds(current.model), ...models.map((m) => m.id)])].join(', ') }));
    } catch (e) {
      setAvailable(null);
      setModelError((e as Error).message);
    } finally {
      setFetching(false);
    }
  };
  // 协议、地址、密钥变了，读到的列表就不作数了
  const resetModels = () => {
    setAvailable(null);
    setModelError('');
  };
  const toggle = (model: string, on: boolean) => {
    const ids = new Set(selected);
    if (on) ids.add(model);
    else ids.delete(model);
    setPi({ ...pi, model: [...ids].join(', ') });
  };
  const submit = async () => {
    const body = { pi: { provider: pi.provider, baseUrl: pi.baseUrl.trim(), model: pi.model, api: pi.api, vision: pi.vision, reasoning: pi.reasoning }, ...(key ? { apiKey: key } : {}) };
    if (await perform(() => save(body))) toast('已保存');
  };
  const locked = busy || fetching;
  return (
    <BlockRow label="Pi 模型 API" hint="推荐用能看图的模型。地址和密钥都留空时，沿用本机 Pi 的配置。">
      <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-[13px]">
        <span id={`${id}-api`} className="text-fg-muted">协议</span>
        <div role="group" aria-labelledby={`${id}-api`} className="max-w-full overflow-x-auto scrollbar-none">
          <Segmented
            size="sm"
            value={pi.api}
            options={PROTOCOLS}
            disabled={fetching}
            onChange={(api) => {
              setPi({ ...pi, api });
              resetModels();
            }}
          />
        </div>
        <label htmlFor={`${id}-url`} className="text-fg-muted">地址</label>
        <Input
          id={`${id}-url`}
          size="sm"
          className="font-mono"
          disabled={fetching}
          placeholder={pi.api === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://…/v1'}
          value={pi.baseUrl}
          onChange={(e) => {
            setPi({ ...pi, baseUrl: e.target.value });
            resetModels();
          }}
        />
        <label htmlFor={`${id}-key`} className="text-fg-muted">密钥</label>
        <Input
          id={`${id}-key`}
          size="sm"
          type="password"
          autoComplete="new-password"
          disabled={fetching}
          placeholder={pi.apiKeyConfigured ? '已保存，留空不变' : '本地服务可以留空'}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            resetModels();
          }}
        />
        <label htmlFor={`${id}-model`} className="self-start pt-1.5 text-fg-muted">模型</label>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" loading={fetching} disabled={busy || !pi.baseUrl.trim()} onClick={() => void readModels()}>
            读取模型列表
          </Button>
          {available && (
            <span className="text-[11.5px] text-fg-subtle tabular">
              {available.length} 个 · 已选 {selected.size}
            </span>
          )}
        </div>
        {(available || modelError) && (
          <div className={available ? 'col-span-2' : 'col-start-2'}>
            <PiModelPicker models={available} selected={selected} onToggle={toggle} error={modelError} />
          </div>
        )}
        <Input id={`${id}-model`} size="sm" className="col-start-2 font-mono" placeholder="手填模型 ID，英文逗号分隔" value={pi.model} onChange={(e) => setPi({ ...pi, model: e.target.value })} />
        <span className="self-start pt-0.5 text-fg-muted">能力</span>
        <div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-[13px]">
              <Switch label="能看图" checked={pi.vision} onCheckedChange={(vision) => setPi({ ...pi, vision })} />
              能看图
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch label="支持思考强度" checked={pi.reasoning} onCheckedChange={(reasoning) => setPi({ ...pi, reasoning })} />
              支持思考强度
            </label>
          </div>
          <p className="mt-1.5 text-[12px] text-fg-subtle">对这组配置里的所有模型生效。</p>
        </div>
        <div className="col-span-2 mt-1 flex justify-end gap-2">
          {pi.apiKeyConfigured && (
            <Button variant="ghost" disabled={locked} onClick={() => void perform(() => save({ apiKey: '' }))}>
              清除密钥
            </Button>
          )}
          <Button variant="primary" disabled={locked} onClick={() => void submit()}>
            保存 API 配置
          </Button>
        </div>
      </div>
    </BlockRow>
  );
}

/** 给其他 Agent 应用用的 MCP 配置：显示后能一键复制 */
function McpRow({ busy, perform }: { busy: boolean; perform: Perform }) {
  const [json, setJson] = useState(''), [shown, setShown] = useState(false), [copied, setCopied] = useState(false);
  const toggle = () => {
    if (shown || json) return setShown(!shown);
    void perform(async () => {
      const c = await assistantApi.mcpConfig();
      setJson(JSON.stringify({ mcpServers: { emaki: { url: c.url, headers: { Authorization: `Bearer ${c.token}` } } } }, null, 2));
      setShown(true);
    });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div>
      <Field label="连接其他 Agent 应用" hint="把配置复制过去，就能查询和修改这个图库。">
        <Button size="sm" variant="outline" disabled={busy && !shown} onClick={toggle}>
          {shown ? '隐藏配置' : '显示配置'}
        </Button>
      </Field>
      {shown && (
        <>
          <div className="group/pre relative pb-2">
            <pre className="max-h-56 overflow-auto rounded-[10px] bg-sunken p-3 pr-11 font-mono text-[11.5px] leading-relaxed text-fg-muted scrollbar-thin">{json}</pre>
            <IconButton size="sm" label={copied ? '已复制' : '复制'} className="absolute top-2 right-2" onClick={() => void copy()}>
              {copied ? <Check strokeWidth={1.8} /> : <Copy strokeWidth={1.8} />}
            </IconButton>
          </div>
          <p className="pb-4 text-[12px] text-warn">配置里有图库访问凭证，别发给别人。</p>
        </>
      )}
    </div>
  );
}
