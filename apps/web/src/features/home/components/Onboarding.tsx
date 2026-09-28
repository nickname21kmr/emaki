import { FolderPlus, ScanSearch } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useRunningJob } from '@/lib/events';
import { useSettings, useStartJob } from '@/lib/queries';

const STEPS = [
  { title: '添加图片文件夹', body: '在设置里选一个或几个存图的文件夹，比如 pixiv 的下载目录。原文件不会被移动。' },
  { title: '扫描与识别', body: '生成缩略图，再用本地的 WD14 模型认出画里的角色和作品。' },
  { title: '整理', body: '没把握的进「未识别」，重复的进「重复」，一张张确认就好。' },
];

/**
 * 空库时的首次使用引导。左边一枚印章 + 一句话 + 主按钮，右边三步说明。
 * 刻意不做居中大标题 hero，保持和其他页面一样的左对齐节奏。
 *
 * 三种情况：还没加文件夹 / 加了但没扫描 / 正在扫描（顶部横幅同时显示进度）。
 */
export function Onboarding() {
  const navigate = useNavigate();
  const settings = useSettings();
  const job = useRunningJob();
  const scan = useStartJob(() => '已开始扫描图库');

  const hasRoots = (settings.data?.libraryRoots.length ?? 0) > 0;
  const scanning = job?.kind === 'scan' || job?.kind === 'thumbnail' || job?.kind === 'tag';
  const stage = scanning ? 'scanning' : hasRoots ? 'ready' : 'empty';
  // 当前进行到第几步，用朱色数字标出来
  const current = stage === 'empty' ? 0 : 1;

  const copy = {
    empty: {
      glyph: '始',
      title: '从一个图片文件夹开始',
      body: 'Emaki 会把文件夹里的插画按角色和作品整理好。所有处理都在这台电脑上完成，图片不会上传到任何地方。',
    },
    ready: {
      glyph: '扫',
      title: '文件夹已添加，还没有扫描',
      body: '扫描会生成缩略图并识别角色，第一次可能要几分钟。之后新存的图会自动入库。',
    },
    scanning: {
      glyph: '待',
      title: '正在扫描你的文件夹',
      body: '第一批插画入库后，这里会出现统计、待处理和最新入库。进度在页面顶部。',
    },
  }[stage];

  return (
    <div className="grid items-center gap-14 border-t border-line pt-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div key={stage} className="animate-rise">
        <Seal glyph={copy.glyph} />
        <h2 className="mt-8 text-[28px] leading-tight font-semibold tracking-tight">{copy.title}</h2>
        <p className="mt-3 max-w-md text-[14px] leading-relaxed text-fg-muted">{copy.body}</p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {stage === 'ready' ? (
            <>
              <Button
                variant="primary"
                size="lg"
                icon={<ScanSearch className="size-[18px]" />}
                loading={scan.isPending}
                onClick={() => scan.mutate('scan')}
              >
                立即扫描
              </Button>
              <Button variant="ghost" size="lg" onClick={() => navigate('/settings')}>
                管理文件夹
              </Button>
            </>
          ) : stage === 'empty' ? (
            <>
              <Button
                variant="primary"
                size="lg"
                icon={<FolderPlus className="size-[18px]" />}
                onClick={() => navigate('/welcome')}
              >
                添加图片文件夹
              </Button>
              <span className="ml-1 text-[12.5px] text-fg-subtle">支持 jpg · png · webp · gif · avif</span>
            </>
          ) : (
            <Button variant="outline" size="lg" onClick={() => navigate('/settings')}>
              查看设置
            </Button>
          )}
        </div>
      </div>

      <ol className="flex flex-col">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className={cn('flex gap-5 py-5 animate-rise', i > 0 && 'border-t border-line')}
            style={{ animationDelay: `${120 + i * 80}ms` }}
          >
            <span
              className={cn(
                'numeral w-8 shrink-0 text-[44px] transition-colors duration-500',
                i === current ? 'text-shu' : i < current ? 'text-fg-muted' : 'text-fg-subtle',
              )}
            >
              {i + 1}
            </span>
            <div className="min-w-0 pt-1">
              <div className={cn('text-[15px] font-semibold tracking-tight', i < current && 'text-fg-muted line-through decoration-line-strong')}>
                {step.title}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 和 EmptyState 同一套「印章」语言：两张错开的圆角纸 + 一个汉字 */
function Seal({ glyph }: { glyph: string }) {
  return (
    <div className="relative flex size-20 items-center justify-center">
      <div className="absolute inset-0 rotate-6 rounded-[24px] bg-shu-soft" />
      <div className="absolute inset-0 -rotate-3 rounded-[24px] bg-raised shadow-lift ring-1 ring-line" />
      <span className="relative font-display text-[40px] leading-none text-shu">{glyph}</span>
    </div>
  );
}
