/**
 * 内部点的约定有一份提交在仓库里（src/core/pointContracts.json，docs/plugins.md 第 7 节）：插件改的点只在约定变了时才自动停用。
 * 这里现场再生成一遍（scripts/pointContracts.ts）和那份比：加了点、删了点、改了命令的输入、组件的 props、函数的签名、版本号，
 * 测试就失败。改的人确认这是要改的，运行 `npm run points:contracts -w @emaki/server` 更新那份文件（改它的插件更新以后会自动停用）。
 */
import { describe, expect, it } from 'vitest';
import { componentProps, functionSignature, generatePointContracts, stripComments } from '../../scripts/pointContracts.ts';
import { pointContracts } from '../../src/core/pointContracts.ts';

describe('内部点的约定', () => {
  it('和提交的那份一样（不一样就运行 npm run points:contracts -w @emaki/server，看 diff）', async () => {
    const now = await generatePointContracts();
    const saved = pointContracts();
    const changed = [...new Set([...Object.keys(now), ...Object.keys(saved)])]
      .filter((k) => JSON.stringify(now[k]) !== JSON.stringify(saved[k]))
      .map((k) => (!saved[k] ? `新加了 ${k}` : !now[k] ? `删掉了 ${k}` : `${k} 的约定变了`));
    expect(changed, '内部点的约定变了：确认以后运行 npm run points:contracts -w @emaki/server').toEqual([]);
  }, 60_000);

  it('从源码里取约定：去掉注释、跳过字符串', () => {
    expect(stripComments("a /* x */ b // y\nc '//不是注释' \"/*也不是*/\"")).toBe("a   b \nc '//不是注释' \"/*也不是*/\"");
  });

  it('只看约定：组件里面改了、注释和换行改了不算，props 改了才算', () => {
    const v1 = `function CardView({ a, b = 1 }: {
      /** 名字 */
      a: string;
      b?: number;
    }) {
      return a + b;
    }`;
    const props = (src: string) => componentProps(stripComments(src), 'CardView');
    expect(props(v1)).toBe('{ a: string; b?: number; }');
    // 里面的实现、注释、换行变了：约定一样
    expect(props(v1.replace('return a + b;', 'const x = { y: 1 };\n      return x.y + a;').replace('/** 名字 */', '// 改了说法'))).toBe(props(v1));
    // props 多了一个：约定变了
    expect(props(v1.replace('b?: number;', 'b?: number;\n      c: boolean;'))).toBe('{ a: string; b?: number; c: boolean; }');
    // 函数的签名
    expect(functionSignature("export const UNIT = (a = 'i'): string => `${a}.id`;", 'UNIT')).toBe("(a = 'i'): string");
    expect(functionSignature('function f(x: number, y: { z: string }): Promise<void> { return go(); }', 'f')).toBe('(x: number, y: { z: string }): Promise<void>');
  });
});
