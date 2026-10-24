import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AssistantBackend, AssistantMessage, AssistantSession, ImageItem } from '@emaki/shared';
import { Chip, Segmented, type SegmentedOption } from '@/components/ui';
import { Thumb } from '@/components/media/Thumb';
import { cn } from '@/lib/cn';
import { AssistantDisclosure, BackendList, PiModelPicker } from '@/features/assistant/AssistantSettingsSection';
import type { SheetForm } from '@/features/assistant/dock';
import { assistantFixtures, FIXTURE_FLAGS, FIXTURE_KEYS, useFixtureConversation, type FixtureFlag, type FixtureKey, type Fixtures } from '@/features/assistant/fixtures';
import { erratumOf, layoutTranscript, type CapsuleStatus, type TurnItem } from '@/features/assistant/presentation';
import type { ConversationView } from '@/features/assistant/useConversation';
import { useAssistantView } from '@/features/assistant/viewState';
import { Capsule } from '@/features/assistant/view/Capsule';
import { Erratum } from '@/features/assistant/view/Erratum';
import { Figure } from '@/features/assistant/view/Figure';
import { Footer } from '@/features/assistant/view/Footer';
import { InterruptionNote } from '@/features/assistant/view/InterruptionNote';
import { QuestionNote } from '@/features/assistant/view/QuestionNote';
import { Sheet } from '@/features/assistant/view/Sheet';
import { SideNote } from '@/features/assistant/view/SideNote';

/**
 * /dev/ui 的「AI 助手」节（final-spec §21.3）：用夹具把附页的每种形态、每种状态摆出来，不连模型。
 * 控件状态写在 URL 上（?a=complete&form=bound&theme=dark&palette=mint&flags=busy,viewing#assistant），方便截图脚本直接打开。
 * 只被 DevUiPage 懒加载，正式包里没有它。
 */

type Theme = 'auto' | 'light' | 'dark';
type Palette = 'washi' | 'mono' | 'mint' | 'sky' | 'lilac';
type Img = Pick<ImageItem, 'id' | 'dominantColor' | 'rating' | 'kind'>;

const FORMS: SegmentedOption<SheetForm>[] = [
  { value: 'bound', label: '并排' },
  { value: 'overlay', label: '覆盖' },
  { value: 'float', label: '浮页' },
  { value: 'darkroom', label: '暗房' },
  { value: 'sheet', label: '底页' },
];
const THEMES: SegmentedOption<Theme>[] = [
  { value: 'auto', label: '跟随' },
  { value: 'light', label: '浅' },
  { value: 'dark', label: '深' },
];
const PALETTES: SegmentedOption<Palette>[] = [
  { value: 'washi', label: '米纸' },
  { value: 'mono', label: '黑白' },
  { value: 'mint', label: '薄荷' },
  { value: 'sky', label: '天青' },
  { value: 'lilac', label: '雾紫' },
];
const CAPSULES: { status: CapsuleStatus; label: string }[] = [
  { status: 'idle', label: '空闲' },
  { status: 'running', label: '处理中' },
  { status: 'waiting', label: '等你回应' },
  { status: 'reply', label: '有新回复' },
  { status: 'incomplete', label: '没有完成' },
];
// 「加载骨架」用的假 id：先挂一个永远不返回的查询，图版就一直停在骨架上
const LOADING_IDS = Array.from({ length: 6 }, (_, i) => `dev-loading-${i + 1}`);

const oneOf = <T extends string>(value: string | null, options: readonly { value: T }[] | readonly T[], fallback: T): T => {
  const all = options.map((o) => (typeof o === 'string' ? o : o.value));
  return all.includes(value as T) ? (value as T) : fallback;
};

/** 跟随时取 <html data-theme>：底色的覆盖规则要和 data-theme 写在同一个元素上 */
function useRootTheme() {
  return useSyncExternalStore(
    (onChange) => {
      const mo = new MutationObserver(onChange);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => mo.disconnect();
    },
    (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  );
}

export function AssistantDevSection({ images }: { images: readonly Img[] }) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const key = oneOf<FixtureKey>(params.get('a'), FIXTURE_KEYS, 'complete');
  const form = oneOf<SheetForm>(params.get('form'), FORMS, 'bound');
  const theme = oneOf<Theme>(params.get('theme'), THEMES, 'auto');
  const palette = oneOf<Palette>(params.get('palette'), PALETTES, 'washi');
  const flags = (params.get('flags') ?? '').split(',').filter((f): f is FixtureFlag => (FIXTURE_FLAGS as readonly string[]).includes(f));
  const rootTheme = useRootTheme();
  const look = { theme: theme === 'auto' ? rootTheme : theme, palette };
  const set = (name: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  const toggleFlag = (flag: FixtureFlag) => set('flags', (flags.includes(flag) ? flags.filter((f) => f !== flag) : [...flags, flag]).join(',') || null);

  // 图换了才重做夹具（夹具一换，假会话的本地状态就重置）
  const ids = images.map((i) => i.id).join(',');
  const fx = useMemo(() => assistantFixtures(ids ? ids.split(',') : []), [ids]);
  const conv = useFixtureConversation(key, flags, fx);
  const [now] = useState(() => Date.now());

  // 带 #assistant 打开时滚到这一节。纸是自己滚的，上面几节的图又是异步读进来的，会把这一节往下推，所以头一秒多跳几次
  useEffect(() => {
    if (hash !== '#assistant') return;
    const go = () => document.getElementById('assistant')?.scrollIntoView();
    const timers = [0, 300, 800, 1500].map((ms) => window.setTimeout(go, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时跳
  }, []);

  return (
    <section id="assistant" className="scroll-mt-8 space-y-8">
      <h2 className="text-sm font-semibold text-fg-muted">AI 助手（夹具，不连模型）</h2>

      <div className="space-y-3">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none fade-x">
          {FIXTURE_KEYS.map((k) => (
            <Chip key={k} size="sm" selected={k === key} onClick={() => set('a', k)}>
              {k}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented size="sm" value={form} options={FORMS} onChange={(v) => set('form', v)} />
          <Segmented size="sm" value={theme} options={THEMES} onChange={(v) => set('theme', v === 'auto' ? null : v)} />
          <Segmented size="sm" value={palette} options={PALETTES} onChange={(v) => set('palette', v === 'washi' ? null : v)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FIXTURE_FLAGS.map((f) => (
            <Chip key={f} size="sm" selected={flags.includes(f)} onClick={() => toggleFlag(f)}>
              {f}
            </Chip>
          ))}
        </div>
      </div>

      <Look {...look} className="rounded-[var(--radius-sheet)] bg-canvas p-6">
        <Stage form={form} conv={conv} images={images} />
      </Look>

      <div className="space-y-3">
        <Heading>胶囊</Heading>
        {(['light', 'dark'] as const).map((t) => (
          <Look key={t} theme={t} palette={palette} className="flex flex-wrap items-end gap-6 rounded-[var(--radius-sheet)] bg-canvas p-5">
            {CAPSULES.map((c) => (
              <div key={c.status} className="flex flex-col items-start gap-2">
                <Capsule static status={c.status} startedAt={c.status === 'running' ? now - 42_000 : null} />
                <span className="text-[11px] text-fg-subtle">{c.label}</span>
              </div>
            ))}
          </Look>
        ))}
      </div>

      <Look {...look} className="space-y-8 rounded-[var(--radius-sheet)] bg-canvas p-6 text-fg">
        <PartsWall fx={fx} />
      </Look>

      <Look {...look} className="rounded-[var(--radius-sheet)] bg-canvas p-6 text-fg">
        <SettingsParts fx={fx} />
      </Look>
    </section>
  );
}

function Look({ theme, palette, className, children }: { theme: 'light' | 'dark'; palette: Palette; className?: string; children: ReactNode }) {
  return (
    <div data-theme={theme} data-palette={palette} className={className}>
      {children}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold tracking-[0.08em] text-fg-subtle">{children}</h3>;
}

/** 主纸的样子：几张缩略图，看附页压在纸上、贴着纸时的关系 */
function Paper({ images, className }: { images: readonly Img[]; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[var(--radius-sheet)] bg-sheet p-6 shadow-[var(--shadow-sheet)] paper', className)}>
      <div className="kicker mb-4">图库</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
        {images.slice(0, 24).map((img) => (
          <Thumb key={img.id} image={img} width={240} className="aspect-[4/5] rounded-[var(--radius-plate-sm)]" />
        ))}
      </div>
    </div>
  );
}

/** 舞台：五种形态各按真实的位置关系摆，附页用 frame="static"（不定位、不拖动、不写 CSS 变量） */
function Stage({ form, conv, images }: { form: SheetForm; conv: ConversationView; images: readonly Img[] }) {
  const sheet = <Sheet frame="static" form={form} conv={conv} />;
  if (form === 'bound') {
    return (
      <div className="flex h-[720px] gap-2">
        <Paper images={images} className="min-w-0 flex-1" />
        <div className="relative w-[400px] shrink-0">{sheet}</div>
      </div>
    );
  }
  if (form === 'overlay' || form === 'float') {
    return (
      <div className="relative h-[720px]">
        <Paper images={images} className="absolute inset-0" />
        <div className={form === 'overlay' ? 'absolute inset-y-0 right-0 w-[400px]' : 'absolute right-6 bottom-6 h-[640px] w-[400px]'}>{sheet}</div>
      </div>
    );
  }
  if (form === 'sheet') {
    return (
      <div className="relative h-[720px] w-[390px] overflow-hidden rounded-[28px] bg-canvas ring-1 ring-line">
        <Paper images={images} className="absolute inset-2" />
        <div className="absolute inset-x-0 bottom-0 h-[88%]">{sheet}</div>
      </div>
    );
  }
  // 暗房：图 | 附页（真实看图器里 InfoPanel 夹在中间）
  return (
    <div className="flex h-[720px] overflow-hidden rounded-[20px] bg-stage">
      <div className="flex min-w-0 flex-1 items-center justify-center p-10">
        {images[0] && <Thumb image={images[0]} width={960} className="aspect-[4/5] h-full max-h-[600px] rounded-[var(--radius-plate)]" />}
      </div>
      <div className="relative w-[400px] shrink-0 py-3 pr-3">{sheet}</div>
    </div>
  );
}

// ------------------------------------------------------------------ 零件墙

/** 一个零件：标注状态名，按需要接一份假会话 */
function Part({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <figure className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <figcaption className="mb-2 text-[11.5px] text-fg-subtle">{label}</figcaption>
      {children}
    </figure>
  );
}

/** 纸面：零件放在附页同款的 sheet 纸上，宽度按附页版心 */
function Leaf({ children, raised, className }: { children: ReactNode; raised?: boolean; className?: string }) {
  return (
    <div className={cn('@container w-full max-w-[400px] overflow-hidden rounded-[var(--radius-sheet)] ring-1 ring-line', raised ? 'bg-raised' : 'bg-sheet px-5 py-5', className)}>
      {children}
    </div>
  );
}

function WithConv({ fixture, flags = [], fx, children }: { fixture: FixtureKey; flags?: FixtureFlag[]; fx: Fixtures; children: (conv: ConversationView) => ReactNode }) {
  const conv = useFixtureConversation(fixture, flags, fx);
  return <>{children(conv)}</>;
}

/** 会话里第 n 个某种条目 */
function itemOf<K extends TurnItem['kind']>(session: AssistantSession, kind: K, n = 0): Extract<TurnItem, { kind: K }> | undefined {
  const items = layoutTranscript(session.messages, session.status).flatMap((t) => t.items);
  return items.filter((i): i is Extract<TurnItem, { kind: K }> => i.kind === kind)[n];
}

const withReason = (conv: ConversationView, reason: NonNullable<AssistantSession['interruption']>['reason']): ConversationView =>
  conv.session?.interruption ? { ...conv, session: { ...conv.session, interruption: { ...conv.session.interruption, reason } } } : conv;

function PartsWall({ fx }: { fx: Fixtures }) {
  const { complete, running, streaming } = fx.sessions;
  const client = useQueryClient();
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    for (const id of LOADING_IDS) void client.prefetchQuery({ queryKey: ['image', id], queryFn: () => new Promise<never>(() => {}) });
    setSeeded(true);
  }, [client]);

  const runningNote = itemOf(running, 'note');
  const doneNote = itemOf(complete, 'note');
  const singleNote = itemOf(streaming, 'note');
  const thinking = complete.messages.filter((m) => m.reasoning);
  const openId = doneNote ? `${doneNote.id}:dev-open` : '';
  useEffect(() => {
    if (openId) useAssistantView.getState().setExpanded(openId, true);
  }, [openId]);

  const undoIndex = complete.messages.findIndex((m) => m.undoToken);
  const undoMessage = complete.messages[undoIndex];
  const erratum = undoIndex >= 0 ? erratumOf(complete.messages, undoIndex) : null;
  const figures = layoutTranscript(complete.messages, complete.status)
    .flatMap((t) => t.items)
    .filter((i): i is Extract<TurnItem, { kind: 'figure' }> => i.kind === 'figure');
  const plates = figures.find((f) => f.card.imageIds.length > 0);
  const twoCol = figures.find((f) => f.card.columns?.length === 2);
  const manyCol = figures.find((f) => (f.card.columns?.length ?? 0) > 2);
  const loadingCard = { id: 'dev-loading', title: '读取中的图', imageIds: LOADING_IDS };
  const loadingMessage: AssistantMessage = { id: 'dev-loading', role: 'tool', text: loadingCard.title, cards: [loadingCard] };

  return (
    <>
      <div className="space-y-4">
        <Heading>旁注</Heading>
        <div className="grid gap-6 sm:grid-cols-2">
          {runningNote && (
            <Part label="运行中：露出最后 3 步">
              <Leaf><SideNote id={runningNote.id} messages={runningNote.messages} /></Leaf>
            </Part>
          )}
          {doneNote && (
            <Part label="完成：收起">
              <Leaf><SideNote id={doneNote.id} messages={doneNote.messages} /></Leaf>
            </Part>
          )}
          {doneNote && (
            <Part label="完成：展开">
              <Leaf><SideNote id={openId} messages={doneNote.messages} /></Leaf>
            </Part>
          )}
          {singleNote && (
            <Part label="只有一条">
              <Leaf><SideNote id={singleNote.id} messages={singleNote.messages} /></Leaf>
            </Part>
          )}
          {thinking.length > 0 && (
            <Part label="只有思考">
              <Leaf><SideNote id="note:dev-thinking" messages={thinking} /></Leaf>
            </Part>
          )}
        </div>
      </div>

      {undoMessage && erratum && (
        <div className="space-y-4">
          <Heading>勘误条</Heading>
          <WithConv fixture="complete" fx={fx}>
            {(c) => (
              <div className="grid gap-6 sm:grid-cols-2">
                <Part label="可以撤销"><Leaf><Erratum message={undoMessage} erratum={erratum} conv={c} state="idle" /></Leaf></Part>
                <Part label="撤销中"><Leaf><Erratum message={undoMessage} erratum={erratum} conv={c} state="undoing" /></Leaf></Part>
                <Part label="已撤销"><Leaf><Erratum message={undoMessage} erratum={erratum} conv={c} state="undone" /></Leaf></Part>
                <Part label="撤销失败"><Leaf><Erratum message={undoMessage} erratum={erratum} conv={c} state={{ failed: '可以再试一次' }} /></Leaf></Part>
              </div>
            )}
          </WithConv>
        </div>
      )}

      <div className="space-y-4">
        <Heading>提问便笺</Heading>
        <div className="grid gap-6 sm:grid-cols-2">
          <WithConv fixture="waiting" fx={fx}>
            {(c) => c.session && (
              <>
                {c.session.questions[0] && <Part label="许可"><Leaf><QuestionNote question={c.session.questions[0]} conv={c} /></Leaf></Part>}
                {c.session.questions[1] && <Part label="选项 + 自由输入"><Leaf><QuestionNote question={c.session.questions[1]} conv={c} /></Leaf></Part>}
              </>
            )}
          </WithConv>
          <WithConv fixture="emakiBlocked" fx={fx}>
            {(c) => c.session?.questions[0] && <Part label="emaki 提问，这一轮还在跑"><Leaf><QuestionNote question={c.session.questions[0]} conv={c} /></Leaf></Part>}
          </WithConv>
          <WithConv fixture="waiting" flags={['disconnected']} fx={fx}>
            {(c) => c.session?.questions[1] && <Part label="断线"><Leaf><QuestionNote question={c.session.questions[1]} conv={c} /></Leaf></Part>}
          </WithConv>
        </div>
      </div>

      <div className="space-y-4">
        <Heading>中断便笺</Heading>
        <div className="grid gap-6 sm:grid-cols-2">
          <WithConv fixture="interrupted" fx={fx}>
            {(c) => (
              <>
                <Part label="重启过"><Leaf><InterruptionNote conv={c} /></Leaf></Part>
                <Part label="已经停下"><Leaf><InterruptionNote conv={withReason(c, 'stopped')} /></Leaf></Part>
              </>
            )}
          </WithConv>
          <WithConv fixture="error" fx={fx}>
            {(c) => <Part label="处理出错"><Leaf><InterruptionNote conv={c} /></Leaf></Part>}
          </WithConv>
          <WithConv fixture="interrupted" flags={['modelsError']} fx={fx}>
            {(c) => <Part label="没选模型"><Leaf><InterruptionNote conv={c} /></Leaf></Part>}
          </WithConv>
        </div>
      </div>

      <div className="space-y-4">
        <Heading>图与表</Heading>
        <div className="grid gap-6 sm:grid-cols-2">
          {plates && (
            <WithConv fixture="complete" fx={fx}>
              {(c) => <Part label="图版：12 张以上"><Leaf><Figure message={plates.message} card={plates.card} figureNo={plates.figureNo} tableNo={plates.tableNo} conv={c} /></Leaf></Part>}
            </WithConv>
          )}
          {plates && (
            <WithConv fixture="complete" flags={['resultSelected']} fx={fx}>
              {(c) => <Part label="图版：选中 3 张"><Leaf><Figure message={plates.message} card={plates.card} figureNo={plates.figureNo} tableNo={plates.tableNo} conv={c} /></Leaf></Part>}
            </WithConv>
          )}
          {seeded && (
            <WithConv fixture="complete" fx={fx}>
              {(c) => <Part label="图版：读取中"><Leaf><Figure message={loadingMessage} card={loadingCard} figureNo={9} conv={c} /></Leaf></Part>}
            </WithConv>
          )}
          {twoCol && (
            <WithConv fixture="complete" fx={fx}>
              {(c) => <Part label="表：两列"><Leaf><Figure message={twoCol.message} card={twoCol.card} figureNo={twoCol.figureNo} tableNo={twoCol.tableNo} conv={c} /></Leaf></Part>}
            </WithConv>
          )}
          {manyCol && (
            <WithConv fixture="complete" fx={fx}>
              {(c) => <Part label="表：多列"><Leaf><Figure message={manyCol.message} card={manyCol.card} figureNo={manyCol.figureNo} tableNo={manyCol.tableNo} conv={c} /></Leaf></Part>}
            </WithConv>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <Heading>页脚</Heading>
        <div className="grid gap-6 sm:grid-cols-2">
          <FooterPart label="状态行：断线" fixture="complete" flags={['disconnected']} fx={fx} />
          <FooterPart label="状态行：等你回应" fixture="waiting" fx={fx} />
          <FooterPart label="状态行：运行中" fixture="running" fx={fx} />
          <FooterPart label="状态行：出错" fixture="error" fx={fx} />
          <FooterPart label="空闲" fixture="complete" fx={fx} />
          <FooterPart label="错误行：发送失败" fixture="complete" flags={['opError']} fx={fx} />
          <FooterPart label="错误行：模型没读出来" fixture="complete" flags={['modelsError']} fx={fx} />
          <FooterPart label="模型不识图" fixture="complete" flags={['nonVision']} fx={fx} />
          <FooterPart label="结果图选择" fixture="complete" flags={['resultSelected']} fx={fx} />
          <FooterPart label="看图器上下文" fixture="complete" flags={['viewing']} fx={fx} />
          <FooterPart label="并排 / 暗房（不加底色）" fixture="complete" fx={fx} bare />
        </div>
      </div>
    </>
  );
}

function FooterPart({ label, fixture, flags, fx, bare }: { label: string; fixture: FixtureKey; flags?: FixtureFlag[]; fx: Fixtures; bare?: boolean }) {
  return (
    <WithConv fixture={fixture} flags={flags} fx={fx}>
      {(c) => (
        <Part label={label}>
          <Leaf raised={!bare} className={bare ? '!bg-sheet !p-0' : undefined}>
            <Footer conv={c} floating={!bare} />
          </Leaf>
        </Part>
      )}
    </WithConv>
  );
}

// ------------------------------------------------------------------ 设置零件

const PI_MODELS = [
  { id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex' },
  { id: 'gpt-5.5-mini', name: 'GPT-5.5 mini' },
  { id: 'deepseek-v4', name: 'DeepSeek V4' },
  { id: 'qwen3-vl-235b-a22b-instruct', name: 'qwen3-vl-235b-a22b-instruct' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'glm-4.5v', name: 'GLM-4.5V' },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick' },
];

function SettingsParts({ fx }: { fx: Fixtures }) {
  const [backend, setBackend] = useState<AssistantBackend | null>('codex');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(['gpt-5.5-codex', 'qwen3-vl-235b-a22b-instruct']));
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const card = 'rounded-xl bg-raised px-5 py-4 ring-1 ring-line';
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <Heading>设置：Agent 应用</Heading>
        <div className="grid gap-6 lg:grid-cols-2">
          <Part label="都可用"><div className={card}><BackendList value={backend} detections={fx.detections.allOk} onChange={setBackend} /></div></Part>
          <Part label="DSH 没找到"><div className={card}><BackendList value={backend} detections={fx.detections.mixed} onChange={setBackend} /></div></Part>
          <Part label="没检测过"><div className={card}><BackendList value={null} detections={fx.detections.none} onChange={setBackend} /></div></Part>
          <Part label="正在保存 Pi"><div className={card}><BackendList value="pi" detections={fx.detections.allOk} busyBackend="pi" detecting onChange={setBackend} /></div></Part>
        </div>
      </div>
      <div className="space-y-4">
        <Heading>设置：Pi 模型列表</Heading>
        <div className="grid gap-6 lg:grid-cols-3">
          <Part label="已读取"><div className={card}><PiModelPicker models={PI_MODELS} selected={picked} onToggle={toggle} /></div></Part>
          <Part label="空列表"><div className={card}><PiModelPicker models={[]} selected={picked} onToggle={toggle} /></div></Part>
          <Part label="读取失败"><div className={card}><PiModelPicker models={null} selected={picked} onToggle={toggle} error="401 Unauthorized：密钥无效" /></div></Part>
        </div>
      </div>
      <div className="space-y-4">
        <Heading>设置：开启确认</Heading>
        <div className={cn(card, 'max-w-[520px] p-6')}>
          <AssistantDisclosure />
        </div>
      </div>
    </div>
  );
}
