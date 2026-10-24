import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import type { AssistantMessage } from '@emaki/shared';
import { useLightbox } from '@/lib/stores';
import { BackendList, dropDetection } from '../AssistantSettingsSection';
import type { Turn } from '../presentation';
import { showInLightbox } from './parts';
import { approvalCommand } from './QuestionNote';
import { requestSelection, turnSignature } from './Turn';

afterEach(() => useLightbox.setState({ open: false, ids: [], index: 0 }));

describe('问句下的选图小字', () => {
  it('看图器里问的写当前这张，不写已选 1 张', () => {
    expect(requestSelection('lightbox', 1)).toEqual(['看图器', '当前这张']);
    expect(requestSelection('gallery', 3)).toEqual(['已选 3 张']);
    expect(requestSelection('assistant-result:c1', 2)).toEqual(['助手结果', '2 张']);
    expect(requestSelection('gallery', 0)).toEqual([]);
  });
});

describe('一轮的签名', () => {
  const msg = (text: string): AssistantMessage => ({ id: 'a', role: 'assistant', text });
  const turn = (text: string): Turn => ({ id: 't', request: null, variant: 'ask', items: [{ kind: 'prose', message: msg(text) }] });
  it('流式追加的正文会改签名，内容没变的新对象不改', () => {
    expect(turnSignature(turn('你好'))).toBe(turnSignature(turn('你好')));
    expect(turnSignature(turn('你好'))).not.toBe(turnSignature(turn('你好，这是')));
  });
});

describe('许可便笺里的命令', () => {
  it('带 command 的 JSON 取出命令，别的原样', () => {
    expect(approvalCommand('{"command":"Get-ChildItem | Measure-Object"}')).toBe('Get-ChildItem | Measure-Object');
    expect(approvalCommand('{"command":["ls","-la"]}')).toBe('ls -la');
    expect(approvalCommand('{"path":"a.txt"}')).toBeNull();
    expect(approvalCommand('rm -rf build')).toBeNull();
    expect(approvalCommand('{broken')).toBeNull();
  });
});

describe('助手里点缩略图看大图', () => {
  it('看图器开着、图在当前序列里时只跳过去', () => {
    useLightbox.getState().show(['x', 'y', 'z'], 0);
    showInLightbox(['z'], 0);
    expect(useLightbox.getState().ids).toEqual(['x', 'y', 'z']);
    expect(useLightbox.getState().index).toBe(2);
  });
  it('不在序列里或看图器没开时换成新列表', () => {
    showInLightbox(['a', 'b'], 1);
    expect(useLightbox.getState()).toMatchObject({ open: true, ids: ['a', 'b'], index: 1 });
    showInLightbox(['q'], 0);
    expect(useLightbox.getState().ids).toEqual(['q']);
  });
});

describe('设置里的 Agent 应用', () => {
  it('改了位置后丢掉那个 backend 的旧检测结果', () => {
    const client = new QueryClient();
    client.setQueryData(['assistant-detect'], [
      { backend: 'dsh', available: false, detail: '未找到 DSH', models: [] },
      { backend: 'codex', available: true, models: [] },
    ]);
    dropDetection(client, 'dsh');
    expect(client.getQueryData<{ backend: string }[]>(['assistant-detect'])?.map(d => d.backend)).toEqual(['codex']);
  });
  it('正在用的那个没检测过时写「已选用」', () => {
    const html = renderToStaticMarkup(<BackendList value="dsh" detections={[]} onChange={() => {}} />);
    expect(html).toContain('已选用');
    expect(html.match(/未检测/g)).toHaveLength(2);
  });
});
