import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantDisclosure } from './AssistantSettingsSection';

it('开启前的说明写清楚会发出去什么、本机能做什么', () => {
  const html = renderToStaticMarkup(<AssistantDisclosure />);
  for (const text of ['模型服务', '文件路径和文件夹名', '分级', 'Yandex', '你同意后', '去掉元数据', '完全访问', '不移动或删除图库文件', '不发送图库内容']) {
    expect(html).toContain(text);
  }
});
