import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Chip } from './Chip';

it('Chip 默认 type=button：放在表单里时输入框回车不会点到它', () => {
  expect(renderToStaticMarkup(createElement(Chip, null, '蔚蓝档案'))).toContain('type="button"');
  expect(renderToStaticMarkup(createElement(Chip, { type: 'submit' }, '保存'))).toContain('type="submit"');
});
