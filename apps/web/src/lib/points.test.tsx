/**
 * 网页的内部点（lib/points.tsx，docs/plugins.md 第 7 节）：组件、函数的补丁叠起来、撤掉；出错退回原来的样子、记在插件头上；
 * 登记的名字和 @emaki/shared 的 WEB_POINTS 一一对上（扫源码：每个点在它写的那个文件里登记）。
 */
import { WEB_POINTS } from '@emaki/shared';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { countUnit } from './countUnit';
import { PatchBoundary, patchable, webPoints } from './points';

const SRC = path.resolve(import.meta.dirname, '..');

afterEach(() => {
  for (const p of ['a', 'b', 'c']) webPoints.removeOwner(p);
});

// 测试用：借一个登记过的名字（组件的名字只能是 WEB_POINTS 里的）
const Hello = ({ name }: { name: string }) => createElement('b', null, `你好 ${name}`);
const Card = patchable('component:character.Cover', Hello as never) as unknown as (p: { name: string }) => ReactNode;
const html = (name = '爱丽丝') => renderToStaticMarkup(createElement(Card, { name }));

describe('网页的内部点', () => {
  it('函数：没有补丁就是原来的，补丁叠起来、撤得掉', () => {
    expect(countUnit()).toBe('张');
    const undo = webPoints.patch('fn:count.unit', 'a', { after: () => '件' });
    expect(countUnit()).toBe('件');
    webPoints.patch('fn:count.unit', 'b', { after: (r) => `${r}！` });
    expect(countUnit()).toBe('件！');
    undo();
    expect(countUnit()).toBe('张！');
    webPoints.removeOwner('b');
    expect(countUnit()).toBe('张');
  });

  it('组件：before 换 props、around 包一层、after 换结果，后加的在外层', () => {
    expect(html()).toBe('<b>你好 爱丽丝</b>');
    webPoints.patch('component:character.Cover', 'a', { before: ([p]) => [{ ...(p as object), name: '鲍勃' }] });
    expect(html()).toBe('<b>你好 鲍勃</b>');
    webPoints.patch('component:character.Cover', 'b', { around: (Next, p) => createElement('i', null, createElement(Next, p)) });
    webPoints.patch('component:character.Cover', 'c', { after: (el) => createElement('u', null, el) });
    expect(html()).toBe('<u><i><b>你好 鲍勃</b></i></u>');
    webPoints.removeOwner('b');
    expect(html()).toBe('<u><b>你好 鲍勃</b></u>');
    expect(webPoints.list().find((p) => p.name === 'component:character.Cover')?.owners).toEqual(['a', 'c']);
  });

  it('补丁自己抛的错记在它头上；错误边界退回原来的样子，没记过的算在改这一处的插件头上', () => {
    const errors: [string, string][] = [];
    const off = webPoints.onPatchError((owner, point) => errors.push([owner, point]));
    webPoints.patch('component:character.Cover', 'a', {
      before: () => {
        throw new Error('坏了');
      },
    });
    expect(html).toThrow('坏了');
    expect(errors).toEqual([['a', 'component:character.Cover']]);
    // 错误边界（服务端渲染里不生效，直接看它的行为）：出错以后画 fallback；层里记过的不再记
    const b = new PatchBoundary({ point: 'component:character.Cover', fallback: () => '原来的' });
    b.state = PatchBoundary.getDerivedStateFromError();
    expect(b.render()).toBe('原来的');
    const claimed = new Error('层里记过了');
    webPoints.claimed.add(claimed);
    b.componentDidCatch(claimed, { componentStack: '' });
    b.componentDidCatch(new Error('画子组件时坏了'), { componentStack: '' });
    expect(errors).toEqual([
      ['a', 'component:character.Cover'],
      ['a', 'component:character.Cover'],
    ]);
    off();
  });

  it('只能改登记过的点', () => {
    expect(() => webPoints.patch('component:nope', 'a', { after: (r) => r })).toThrow(/没有内部点/);
    expect(() => patchable('component:nope', Hello)).toThrow(/WEB_POINTS/);
  });

  it('WEB_POINTS 和源码里登记的一一对上：每个点在它写的那个文件里登记', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(SRC);
    const found = new Map<string, string>();
    for (const f of files) {
      // 注释里的例子不算
      const text = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join('\n');
      for (const m of text.matchAll(/patchable(?:Fn)?\(\s*'([^']+)'/g)) found.set(m[1]!, path.relative(SRC, f).split(path.sep).join('/'));
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(WEB_POINTS.map((p) => [p.name, p.file])));
  });
});
