import { House } from 'lucide-react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState } from '@/components/ui';
import { LOCAL_ONLY, type Capability } from '@/lib/capabilities';
import { PAGES, type PageId } from '@/pages';
import { scopeText } from './format';

/** 能力的名字：和设置 →「手机访问」里勾选框上的那一行一样，照着就能找到 */
export function capabilityName(cap: Capability): string {
  return cap === 'assistant' ? 'AI 助手' : scopeText(cap).head;
}

/** 说明页的两句话：缺哪项权限、去哪里加（电脑上才有的能力说到电脑上用） */
export function noAccessText(cap: Capability): { title: string; description: string } {
  const name = capabilityName(cap);
  if (LOCAL_ONLY.includes(cap))
    return { title: `「${name}」只能在电脑上用`, description: '手机上没有这一项，到电脑上打开 Emaki 处理。' };
  return {
    title: `这台设备没有「${name}」的权限`,
    description: '可以在电脑上 设置 → 手机访问 里给它加上；加上以后这一页会自己换过来，不用刷新。',
  };
}

/**
 * 直接打开没权限的地址时显示的说明页（docs/mobile.md 4.4，FRONTEND.md 的空状态写法）：页头照常（卷号按路由），
 * 下面写清缺哪项权限、在电脑上哪里加。权限加上后 me 事件让 /api/me 重新取，PageGate 自动换回真正的页面。
 */
export function NoAccessPage({ page, need }: { page: PageId; need: Capability }) {
  const navigate = useNavigate();
  const { title, description } = noAccessText(need);
  return (
    <>
      <PageHeader title={PAGES[page].title} />
      <PageBody>
        <EmptyState
          glyph="限"
          title={title}
          description={description}
          action={
            <Button variant="secondary" size="sm" icon={<House />} onClick={() => navigate('/')}>
              回首页
            </Button>
          }
        />
      </PageBody>
    </>
  );
}
