/**
 * 「这种动作还在进行，同一种先不接」的小锁，多选栏用。
 *
 * useMutate 的 isPending 不适合当这把锁：它要等整轮刷新做完才放开，而且一个 hook 只跟最新那一次请求。
 * 排除完几张、想马上再选几张接着排除，会被悄悄吞掉。这里按动作的名字记，什么时候放开由调用方定：
 *   - 做完就清空选择的动作：请求一回来就放（选择已经没了，可以接着选、接着做，不用等后面的刷新）；
 *   - 选择还留着的（收藏、分级）：等刷新完再放，免得照着还没刷新的状态把同样的再提交一遍。
 */
import { useReducer, useRef } from 'react';

export interface ActionLock<K extends string> {
  /** 这种动作还在进行 */
  held(key: K): boolean;
  /** 有没有哪一种在进行 */
  any(): boolean;
  /** 占住；返回放开的函数，多调几次只算一次 */
  hold(key: K): () => void;
  /** request 在路上的这段时间占着，一回来（成功或失败）就放开；原样还回 request */
  during<T>(key: K, request: Promise<T>): Promise<T>;
}

export function createActionLock<K extends string>(onChange?: () => void): ActionLock<K> {
  const counts = new Map<K, number>();
  const hold = (key: K) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    onChange?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else counts.delete(key);
      onChange?.();
    };
  };
  return {
    held: (key) => counts.has(key),
    any: () => counts.size > 0,
    hold,
    during: (key, request) => {
      const release = hold(key);
      return request.finally(release);
    },
  };
}

/** 组件里用：锁变了就重渲染（按钮的转圈、禁用跟着变）。held / any 读的是当下的值，同一拍里连按两次也拦得住 */
export function useActionLock<K extends string>(): ActionLock<K> {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const lock = useRef<ActionLock<K> | null>(null);
  lock.current ??= createActionLock<K>(bump);
  return lock.current;
}
