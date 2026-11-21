/**
 * 「连接到电脑」（docs/mobile.md 2.3）：手机浏览器打开局域网入口、还没有凭证（或被电脑移除了）时整页换成它（main.tsx，lib/deviceAuth.ts）。
 * 填设备名称 → 请求连接 → 大号显示校验码，等电脑上核对后批准 → 服务端已经 Set-Cookie，重新加载页面就进图库了。
 * 协议和安全性说明见 ./pairing.ts。本机入口上不会出现这个页面。
 */
import type { LanHello } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { RotateCw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Spinner } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';
import { useNow } from '@/features/settings/hooks';
import type { DeviceAuthLost } from '@/lib/deviceAuth';
import { formatCountdown } from './format';
import { getHello, guessDevice, PairError, startPairing, waitForDecision, type PairAttempt } from './pairing';
import { PairCode } from './RequestCard';

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'waiting'; attempt: PairAttempt }
  | { kind: 'approved' }
  | { kind: 'rejected' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

export function PairingPage({ reason }: { reason: DeviceAuthLost }) {
  const hello = useQuery({ queryKey: ['lan-hello'], queryFn: ({ signal }) => getHello({ signal }), retry: 2, staleTime: Infinity });
  const guess = useRef(guessDevice(typeof navigator === 'undefined' ? '' : navigator.userAgent)).current;
  const [name, setName] = useState(guess.name);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const request = async (h: LanHello) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase({ kind: 'sending' });
    try {
      const attempt = await startPairing(h, { name: name.trim() || guess.name, model: guess.model }, { signal: ctrl.signal });
      setPhase({ kind: 'waiting', attempt });
      const result = await waitForDecision(attempt.id, { signal: ctrl.signal });
      if (result.status === 'approved') {
        setPhase({ kind: 'approved' });
        // 批准的响应已经带了 Set-Cookie（HttpOnly）：重新加载，之后的请求都带着凭证
        window.setTimeout(() => window.location.reload(), 600);
      } else setPhase({ kind: result.status });
    } catch (err) {
      if (isAbort(err)) return;
      setPhase({ kind: 'error', message: err instanceof PairError ? err.message : String(err) });
    }
  };

  const cancel = () => {
    abort.current?.abort();
    setPhase({ kind: 'idle' });
  };

  const h = hello.data;
  return (
    <div className="flex min-h-full items-start justify-center bg-canvas px-4 py-8 sm:items-center">
      <main className="w-full max-w-[440px] overflow-hidden rounded-[var(--radius-sheet)] bg-sheet shadow-[var(--shadow-sheet)]">
        <header className="px-6 pt-7 sm:px-8">
          <div className="kicker flex items-center">
            <Emblem size={14} className="mr-2" />
            <span className="font-semibold text-brand">Emaki</span>
            <span className="ml-3">手机访问</span>
          </div>
          <h1 className="display-title mt-2.5 text-[30px]">连接到电脑</h1>
          <p className="mt-1.5 min-h-5 text-[13px] break-words text-fg-muted">
            {h ? `「${h.name}」上的 Emaki` : hello.isError ? '没找到电脑' : '正在找电脑…'}
          </p>
          <div aria-hidden className="rule-double mt-5" />
        </header>

        <section className="px-6 pt-5 pb-7 sm:px-8" aria-live="polite">
          {reason === 'device_revoked' && phase.kind === 'idle' && (
            <p role="alert" className="mb-5 rounded-lg bg-warn-soft px-3.5 py-3 text-[13px] leading-relaxed text-warn">
              这台设备已被电脑移除。要继续用，请重新请求连接，再到电脑上批准。
            </p>
          )}

          {hello.isPending ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-fg-muted">
              <Spinner className="size-4" /> 正在连接电脑…
            </div>
          ) : !h ? (
            <Problem
              message={hello.error instanceof PairError ? hello.error.message : '连不上电脑：看看电脑上的 Emaki 还开着'}
              action="重试"
              onAction={() => void hello.refetch()}
            />
          ) : phase.kind === 'idle' || phase.kind === 'sending' ? (
            <RequestForm
              name={name}
              onName={setName}
              sending={phase.kind === 'sending'}
              accepting={h.pairing}
              onSubmit={() => void request(h)}
            />
          ) : phase.kind === 'waiting' ? (
            <Waiting attempt={phase.attempt} onCancel={cancel} />
          ) : phase.kind === 'approved' ? (
            <div className="flex items-center gap-2 py-6 text-[14px] font-medium">
              <Spinner className="size-4" /> 电脑已批准，正在打开图库…
            </div>
          ) : phase.kind === 'rejected' ? (
            <Problem message="电脑上拒绝了这个请求。" action="重新请求" onAction={() => setPhase({ kind: 'idle' })} />
          ) : phase.kind === 'expired' ? (
            <Problem message="请求过期了：5 分钟内电脑上没有批准。" action="重新请求" onAction={() => setPhase({ kind: 'idle' })} />
          ) : (
            <Problem message={phase.message} action="重试" onAction={() => setPhase({ kind: 'idle' })} />
          )}
        </section>
      </main>
    </div>
  );
}

function RequestForm({
  name,
  onName,
  sending,
  accepting,
  onSubmit,
}: {
  name: string;
  onName: (v: string) => void;
  sending: boolean;
  accepting: boolean;
  onSubmit: () => void;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sending && accepting) onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <label htmlFor="pair-device-name" className="text-sm font-medium">
        设备名称
      </label>
      <Input
        id="pair-device-name"
        className="mt-2"
        size="lg"
        leading={<Smartphone />}
        value={name}
        maxLength={60}
        onChange={(e) => onName(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">电脑上会用这个名字列出这台设备，以后也能在电脑上改。</p>
      <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" loading={sending} disabled={!accepting}>
        请求连接
      </Button>
      <p className="mt-3 text-[12.5px] leading-relaxed text-fg-subtle">
        {accepting ? '电脑上会弹出提示。两边显示的校验码一样，再在电脑上点「批准」。' : '电脑现在不接受新的请求。'}
      </p>
    </form>
  );
}

function Waiting({ attempt, onCancel }: { attempt: PairAttempt; onCancel: () => void }) {
  const now = useNow(true);
  const left = Date.parse(attempt.expiresAt) - now;
  return (
    <div>
      <div className="text-[13px] text-fg-muted">校验码</div>
      <PairCode code={attempt.code} className="mt-1 block text-[46px] leading-none" />
      <p className="mt-4 text-[14px] leading-relaxed font-medium">在电脑上核对数字一样后点「批准」</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">数字不一样的话点「拒绝」：可能有别人在冒充这台设备。</p>
      <div className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-4">
        <span className="flex items-center gap-2 text-[12.5px] text-fg-subtle tabular">
          <Spinner className="size-3.5" />
          等电脑批准{left > 0 ? ` · 还剩 ${formatCountdown(left)}` : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function Problem({ message, action, onAction }: { message: string; action: string; onAction: () => void }) {
  return (
    <div>
      <p role="alert" className="text-[14px] leading-relaxed">
        {message}
      </p>
      <Button className="mt-5" icon={<RotateCw />} onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
