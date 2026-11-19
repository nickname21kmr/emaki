import { describe, expect, it } from 'vitest';
import { normalizeTarget } from './utils';

describe('排除规则目标的预览（归一化在服务端，标签用同一个函数，附录 #38）', () => {
  it('标签：小写、空白换下划线', () => expect(normalizeTarget('tag', '  Some Tag ')).toBe('some_tag'));
  it('文件夹：正斜杠、去掉结尾斜杠', () => expect(normalizeTarget('folder', 'D:\\Pics\\')).toBe('D:/Pics'));
});
