import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import type { AssistantBackend } from '@emaki/shared';
import { PANEL_W, SIDE_BY_SIDE_MIN, useLightboxPrefs } from '@/components/media/lightbox/prefs';
import { useHotkey } from '@/lib/hotkeys';
import { useOverlays } from '@/lib/stores';
import { useAssistantSettings } from './client';
import { closeAssistant, focusAssistant, leafWidth, LIVE_SHEET, openAssistant, useAssistantDock, useSheetForm, useViewportWidth, type SheetForm } from './dock';
import { erratumOf, splitQuestionTitle } from './presentation';
import { useConversation, type ConversationView } from './useConversation';
import { Capsule } from './view/Capsule';
import { Sheet } from './view/Sheet';

// 挂着的 AssistantRoot 个数（StrictMode 假卸载时用来判断是不是马上又挂回来了）
let mounted = 0;

/**
 * 助手的根（懒加载，开启后才下载）：注册 mod+J，挂着对话状态，在胶囊和附页之间二选一，
 * 附页平时 portal 到 body，看图器开着时 portal 到暗房插槽。另有一个只给读屏的播报区。
 */
export function AssistantRoot() {
  const backend = useAssistantSettings().data?.backend ?? null;
  // 设置里关掉助手时整个卸载：收起，两个 CSS 变量清零。
  // 开发时 StrictMode 会假卸载一次再马上挂回：等一拍，确实没挂回才清，免得刚点开就被关掉
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      setTimeout(() => {
        if (mounted) return;
        useAssistantDock.setState({ open: false, shown: false, wantsFocus: false, lastStatus: null, runStartedAt: null, unseen: null });
        const root = document.documentElement.style;
        root.setProperty('--assistant-right', '0px');
        root.setProperty('--assistant-cover', '0px');
      });
    };
  }, []);
  return <Assistant key={backend ?? ''} backend={backend} />;
}

function Assistant({ backend }: { backend: AssistantBackend | null }) {
  const conv = useConversation(backend);
  const open = useAssistantDock(s => s.open);
  const shown = useAssistantDock(s => s.shown);
  const width = useAssistantDock(s => s.width);
  const slotEl = useAssistantDock(s => s.slotEl);
  const form = useSheetForm();
  const vw = useViewportWidth();
  const announcement = useAnnouncement(conv);

  // 收起时打开；开着而焦点在外面时把焦点移进去；焦点在里面时收起。看图器里同样生效
  useHotkey('mod+j', () => {
    const overlays = useOverlays.getState();
    if (overlays.commandOpen || overlays.helpOpen) return;
    if (!useAssistantDock.getState().open) return openAssistant();
    const active = document.activeElement;
    if (active?.closest(LIVE_SHEET)) return closeAssistant();
    // 从页面上（比如搜索框）跳进来：记下这里，再按一次收起时焦点回到这里
    if (active instanceof HTMLElement && active !== document.body) useAssistantDock.setState({ opener: active });
    focusAssistant();
  }, { allowInInputs: true });

  // toast 和多选栏避让（index.css）：并排 / 覆盖时右边让出附页的宽度。
  // 暗房里让出插槽，信息面板也开着时再让出它，toast 落在图的那块
  const infoPanel = useLightboxPrefs(s => s.panelOpen) && vw >= SIDE_BY_SIDE_MIN;
  useEffect(() => {
    const leaf = form === 'bound' || form === 'overlay';
    const right = !shown ? 0
      : leaf ? leafWidth(form, width, vw) + 8
      : form === 'darkroom' ? leafWidth(form, width, vw) + 12 + (infoPanel ? PANEL_W : 0)
      : 0;
    const root = document.documentElement.style;
    root.setProperty('--assistant-right', `${right}px`);
    root.setProperty('--assistant-cover', form === 'overlay' ? `${right}px` : '0px');
  }, [form, width, vw, shown, infoPanel]);

  const target = form === 'darkroom' ? slotEl : document.body;
  // bound / overlay / sheet 之间只是换样式；进出暗房、浮起和贴边互换才先退后进
  const frame = form === 'darkroom' ? 'darkroom' : form === 'float' ? 'float' : 'page';
  return (
    <>
      <AnimatePresence
        mode="wait"
        onExitComplete={() => {
          const dock = useAssistantDock.getState();
          if (!dock.open) dock.setShown(false);
        }}
      >
        {open ? (target && <SheetPortal key={`sheet:${frame}`} target={target} conv={conv} form={form} />) : <CapsulePortal key="capsule" />}
      </AnimatePresence>
      {/* 看图器开着时 Radix 给 Dialog 以外的节点加 aria-hidden，播报区要跟着附页进暗房才读得到 */}
      {createPortal(<div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>, form === 'darkroom' && slotEl ? slotEl : document.body)}
    </>
  );
}

function SheetPortal({ target, conv, form }: { target: HTMLElement; conv: ConversationView; form: SheetForm }) {
  return createPortal(<Sheet conv={conv} form={form} />, target);
}

function CapsulePortal() {
  return createPortal(<Capsule />, document.body);
}

/** 只在状态转换时播报一次（正文 aria-live=off，流式输出不播） */
function useAnnouncement(conv: ConversationView) {
  const { session, sessionId, connected } = conv;
  const [text, setText] = useState('');
  const last = useRef<{ sessionId: string; status: string; connected: boolean; errata: Set<string> } | null>(null);
  useEffect(() => {
    if (!session) return;
    const previous = last.current;
    last.current = { sessionId, status: session.status, connected, errata: new Set(session.messages.filter(m => m.undoToken).map(m => m.id)) };
    // 切会话后的第一份快照不播
    if (!previous || previous.sessionId !== sessionId) return;
    const lines: string[] = [];
    if (previous.connected !== connected) lines.push(connected ? '已重新连接' : '连接断了');
    session.messages.forEach((m, i) => {
      if (m.undoToken && !previous.errata.has(m.id)) lines.push(`已改：${erratumOf(session.messages, i).sentence}`);
    });
    if (previous.status !== session.status) {
      const lead = session.questions[0] ? splitQuestionTitle(session.questions[0].title).lead.slice(0, 30) : '';
      if (session.status === 'running' && previous.status !== 'waiting') lines.push('助手开始处理');
      else if (session.status === 'waiting') lines.push(lead ? `助手在等你回应：${lead}` : '助手在等你回应');
      else if (session.status === 'error' || (session.status === 'idle' && session.interruption)) lines.push('处理中断了');
      else if (session.status === 'idle') lines.push('助手回复完了');
    }
    if (lines.length) setText(lines.join('。'));
  }, [session, sessionId, connected]);
  return text;
}
