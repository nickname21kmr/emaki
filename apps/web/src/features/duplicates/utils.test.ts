import { describe, expect, it } from 'vitest';
import { kindLabel } from './utils';

describe('duplicate match explanations', () => {
  it('distinguishes byte identity, pixel identity and verified derivatives, without a hash percentage', () => {
    expect(kindLabel({ kind: 'exact' })).toBe('文件相同');
    expect(kindLabel({ kind: 'similar', comparison: 'pixels' })).toBe('画面相同');
    expect(kindLabel({ kind: 'similar', comparison: 'visual' })).toBe('疑似缩放 / 压缩副本');
    expect(kindLabel({ kind: 'similar' })).toBe('疑似重复');
  });
});
