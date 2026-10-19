import { expect, it } from 'vitest';
import { boundedText, toolPreview } from './activity.ts';

it('keeps tool previews bounded and strips credentials and binary media', () => {
  const text = toolPreview({ api_key: 'private-key', content: [{ type: 'image', data: 'large-base64' }, { type: 'text', text: '3 matching images' }] });
  expect(text).not.toContain('private-key'); expect(text).not.toContain('large-base64'); expect(text).toContain('3 matching images');
  expect(boundedText('x'.repeat(30000))).toHaveLength(24000 + '\n…（内容较长，显示前 24000 字符）'.length);
});
