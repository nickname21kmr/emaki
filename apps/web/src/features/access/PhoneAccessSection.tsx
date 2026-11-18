/**
 * 设置 →「手机访问」（docs/mobile.md 第 2 节）：局域网入口的开关、状态、电脑名称、端口、二维码，等批准的请求，已批准的设备。
 * 数据来自查询 access.status（GET /api/access），SSE 的 access 事件到了就重新取（lib/events.ts）。只有本机入口能用。
 */
import type { AccessStatus } from '@emaki/shared';
import { CircleAlert, Copy, QrCode } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Field, IconButton, Input, Skeleton, Spinner, Switch } from '@/components/ui';
import { SettingsCard, SettingsSection } from '@/features/settings/components/SettingsSection';
import { useNow } from '@/features/settings/hooks';
import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { errorMessage, useAccessStatus } from '@/lib/queries';
import { DeviceList } from './DeviceList';
import { useConfigureAccess } from './hooks';
import { QrDialog } from './QrDialog';
import { RequestCard } from './RequestCard';

export function PhoneAccessSection() {
  const status = useAccessStatus();
  return (
    <SettingsSection id="phone" description="在手机上看图库、整理图片。图片、数据库和识别都留在这台电脑上，手机只是另一个窗口。">
      {status.isPending ? (
        <SettingsCard className="py-4">
          <Skeleton className="h-10 w-full rounded-lg" />
        </SettingsCard>
      ) : status.isError ? (
        <SettingsCard>
          <Field label="读不到手机访问的状态" hint={errorMessage(status.error)}>
            <Button size="sm" onClick={() => void status.refetch()}>
              重试
            </Button>
          </Field>
        </SettingsCard>
      ) : !status.data ? (
        // 局域网入口上的设备（有 settings 权限也一样）：管理设备只能在电脑上
        <SettingsCard>
          <p className="py-4 text-[13px] text-fg-muted">手机访问只能在电脑上设置。</p>
        </SettingsCard>
      ) : (
        <AccessBody status={status.data} />
      )}
    </SettingsSection>
  );
}

export function AccessBody({ status }: { status: AccessStatus }) {
  const { configure, isPending } = useConfigureAccess();
  const [qrOpen, setQrOpen] = useState(false);
  const focus = (useLocation().state as { request?: string } | null)?.request;
  const now = useNow(status.requests.length > 0);
  const requests = status.requests.filter((r) => Date.parse(r.expiresAt) > now);
  const on = status.enabled;

  return (
    <div className="space-y-6">
      <SettingsCard>
        <Field label="让手机连接这台电脑" hint="打开后手机上的 Emaki App 能在局域网里找到这台电脑，连接要你在这里批准。">
          <div className="flex items-center gap-2.5">
            {isPending && <Spinner className="size-3.5 text-fg-subtle" />}
            <Switch checked={on} onCheckedChange={(enabled) => configure({ enabled })} label="让手机连接这台电脑" />
          </div>
        </Field>

        {on && (
          <>
            <StatusRow status={status} />
            <Field label="电脑名称" hint={`手机上看到的名字。留空恢复成「${status.defaultName}」。`}>
              <CommitInput
                key={status.name ?? ''}
                initial={status.name ?? ''}
                placeholder={status.defaultName}
                className="w-56"
                maxLength={60}
                label="电脑名称"
                onCommit={(v) => configure({ name: v.trim() || null })}
              />
            </Field>
            <Field label="端口" hint="1024–65535，默认 5175。改了立即生效，浏览器要换成新地址。">
              <CommitInput
                key={status.port}
                initial={String(status.port)}
                className="w-24"
                inputMode="numeric"
                label="端口"
                validate={(v) => {
                  const n = Number(v);
                  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? null : '端口要是 1024–65535 之间的整数';
                }}
                onCommit={(v) => configure({ port: Number(v) })}
              />
            </Field>
            <Field label="用二维码添加" hint="手机上的 Emaki App 扫一下就连上，不用再批准。搜不到这台电脑时（访客 Wi-Fi、路由器隔离）用它。">
              <Button size="sm" icon={<QrCode />} disabled={!status.listening} onClick={() => setQrOpen(true)}>
                显示二维码
              </Button>
            </Field>
          </>
        )}
      </SettingsCard>

      {on && (
        <Group title="等你批准的请求" count={requests.length}>
          {requests.length ? (
            <SettingsCard>
              <ul className="divide-y divide-line">
                {requests.map((r) => (
                  <RequestCard key={r.id} request={r} now={now} defaultOpen={r.id === focus} />
                ))}
              </ul>
            </SettingsCard>
          ) : (
            <Empty>
              现在没有。手机上打开 Emaki App，或者用手机浏览器打开上面的地址，点「请求连接」，请求会出现在这里，任何页面也会弹出提示。
            </Empty>
          )}
        </Group>
      )}

      {(on || status.devices.length > 0) && (
        <Group title="已连接的设备" count={status.devices.length}>
          {status.devices.length ? (
            <SettingsCard>
              <DeviceList devices={status.devices} />
            </SettingsCard>
          ) : (
            <Empty>还没有。批准过的手机会列在这里，可以改名称、改权限，也可以随时移除。</Empty>
          )}
        </Group>
      )}

      <QrDialog open={qrOpen} onOpenChange={setQrOpen} />
    </div>
  );
}

/** 状态：在监听哪个端口、这台电脑的局域网地址；出错时醒目地写原因；Windows 防火墙的提醒 */
function StatusRow({ status }: { status: AccessStatus }) {
  const urls = status.addresses.map((a) => `https://${a}:${status.port}`);
  return (
    <div className="py-3.5">
      <div className="flex items-center justify-between gap-6">
        <div className="text-sm font-medium">状态</div>
        {status.error ? (
          <Badge tone="danger" dot>
            没能打开
          </Badge>
        ) : status.listening ? (
          <Badge tone="ok" dot>
            正在监听端口 {status.port}
          </Badge>
        ) : (
          <Badge>
            <Spinner className="size-3" /> 正在打开…
          </Badge>
        )}
      </div>
      {status.error && (
        <p
          role="alert"
          className="mt-2.5 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-[13px] leading-relaxed text-danger"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {status.error}
        </p>
      )}
      {status.listening && (
        <div className="mt-2.5">
          <div className="text-[12.5px] text-fg-muted">
            {urls.length
              ? '这台电脑的局域网地址（手机浏览器也能直接打开，第一次会看到证书警告）：'
              : '没找到这台电脑的局域网地址：看看是不是连上了 Wi-Fi 或网线。'}
          </div>
          {urls.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {urls.map((u) => (
                <li key={u} className="flex items-center gap-0.5 rounded-md bg-sunken py-0.5 pr-0.5 pl-2.5">
                  <code className="font-mono text-xs">{u}</code>
                  <IconButton
                    size="sm"
                    label="复制地址"
                    onClick={() =>
                      void copyText(u).then(
                        () => toast('已复制'),
                        () => toast.error('复制失败'),
                      )
                    }
                  >
                    <Copy />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mt-2.5 text-[12px] leading-relaxed text-fg-subtle">
        Windows 第一次打开时防火墙会弹窗，要允许「专用网络」，否则手机连不上。
      </p>
    </div>
  );
}

/** 失焦或回车时提交，没改动就不发；Esc 还原。validate 返回错误时不提交，写在下面 */
function CommitInput({
  initial,
  onCommit,
  validate,
  label,
  className,
  ...rest
}: {
  initial: string;
  onCommit: (v: string) => void;
  validate?: (v: string) => string | null;
  label: string;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  inputMode?: 'numeric';
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (value.trim() === initial.trim()) return setError(null);
    const problem = validate?.(value.trim()) ?? null;
    setError(problem);
    if (!problem) onCommit(value);
  };
  return (
    <div className="flex flex-col items-end">
      <Input
        size="sm"
        aria-label={label}
        aria-invalid={!!error || undefined}
        className={cn(className, error && 'shadow-[0_0_0_1px_var(--c-danger)]')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setValue(initial);
            setError(null);
            e.currentTarget.blur();
          }
        }}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      {error && <span className="mt-1 text-[12px] text-danger">{error}</span>}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 flex items-baseline gap-2 pl-1 text-[13px] font-medium text-fg-muted">
        {title}
        {count > 0 && <span className="text-fg-subtle tabular">{count}</span>}
      </h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl px-5 py-4 text-[13px] leading-relaxed text-fg-muted ring-1 ring-line ring-inset">{children}</p>;
}
