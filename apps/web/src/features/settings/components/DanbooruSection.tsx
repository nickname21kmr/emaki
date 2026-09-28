import type { Settings } from '@emaki/shared';
import { CloudDownload, KeyRound, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Field, Input, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useSaveSettings } from '../hooks';
import { JobAction } from './JobAction';
import { SettingsCard, SettingsSection } from './SettingsSection';

export function DanbooruSection({ danbooru }: { danbooru: Settings['danbooru'] }) {
  const save = useSaveSettings();
  const off = !danbooru.enabled;

  return (
    <SettingsSection id="danbooru" description="从 Danbooru 获取角色、作品的标准名称和别名，让识别结果和搜索更准。">
      <SettingsCard>
        <Field label="允许联网同步" hint="只下载标签元数据（角色名、作品、别名），不会上传任何图片。">
          <Switch
            checked={danbooru.enabled}
            onCheckedChange={(enabled) => save({ danbooru: { enabled } })}
            label="允许联网同步"
          />
        </Field>

        {/* 关闭同步时下面几项淡下去，但仍可编辑（先填好账号再打开也行） */}
        <div className={cn('divide-y divide-line transition-opacity duration-300', off && 'opacity-50')}>
          <Field label="用户名" hint="可选。填了用户名和 API Key，请求频率上限会高一些。">
            {/* key：服务端值变化（比如撤销）时重置输入框 */}
            <UsernameInput
              key={danbooru.username}
              initial={danbooru.username}
              onSave={(username) => save({ danbooru: { username } })}
            />
          </Field>

          <Field label="API Key" hint="只写不读：保存后不会再显示明文，也不会出现在任何日志里。">
            <ApiKeyInput hasKey={danbooru.hasApiKey} onSave={(key) => save({ danbooruApiKey: key })} />
          </Field>

          <Field
            label="上次同步"
            hint={
              danbooru.lastSyncAt ? (
                <span className="tabular" title={formatDateTime(danbooru.lastSyncAt)}>
                  {formatRelative(danbooru.lastSyncAt)} · {formatDateTime(danbooru.lastSyncAt)}
                </span>
              ) : (
                '还没有同步过'
              )
            }
          >
            <JobAction kind="danbooru-sync" icon={<CloudDownload />} disabled={off}>
              立即同步
            </JobAction>
          </Field>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

/** 失焦或回车时保存，没改动就不发请求 */
function UsernameInput({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const v = value.trim();
    if (v !== initial) onSave(v);
  };
  return (
    <Input
      size="sm"
      className="w-64"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(initial);
          e.currentTarget.blur();
        }
      }}
      leading={<UserRound />}
      placeholder="可选"
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/**
 * API Key 只写不读：输入框永远是空的，已设置时右侧显示「已设置」。
 * 有输入时出现「保存」，已设置且没在输入时出现「清除」。
 */
function ApiKeyInput({ hasKey, onSave }: { hasKey: boolean; onSave: (v: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    onSave(v);
    setValue('');
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      {value ? (
        <Button type="submit" size="sm" variant="primary" className="animate-fade-in">
          保存
        </Button>
      ) : (
        hasKey && (
          <Button type="button" size="sm" variant="ghost" className="animate-fade-in" onClick={() => onSave('')}>
            清除
          </Button>
        )
      )}
      <Input
        size="sm"
        type="password"
        className="w-64"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setValue('');
        }}
        leading={<KeyRound />}
        trailing={
          !value && (
            <Badge tone={hasKey ? 'ok' : 'neutral'} dot={hasKey}>
              {hasKey ? '已设置' : '未设置'}
            </Badge>
          )
        }
        placeholder={hasKey ? '输入新的 Key 替换' : '粘贴 API Key'}
        autoComplete="new-password"
        spellCheck={false}
      />
    </form>
  );
}
