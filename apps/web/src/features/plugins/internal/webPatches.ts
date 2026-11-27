/**
 * 改网页的插件（第 3 层，docs/plugins.md 第 7 节，E6）：在这个页面里加载插件的 web 入口，让它给登记过名字的组件和函数打补丁（lib/points.tsx）。
 *
 * - 加载哪些：服务端算好的 PluginsState.webPatches（启用着、授权了改内部、它改的点没变的；安全模式下没有）。
 *   插件变了（plugins.changed 以后重新取）就对一遍：不在了、地址变了（更新、按文件夹装的改了代码）的撤掉它的全部补丁，新的 import。
 * - import 入口（/api/plugin-web/…），调它导出的 activate(internal)：
 *   internal.patch(点, { before, after, around }) 只能改清单 patch@1 里列的网页的点；internal.React、internal.h 是 Emaki 用的 React
 *   （插件的模块不能 import 'react'）；internal.points() 列出网页的点。activate 抛错：撤掉已经加上的，记一次错误。
 * - 补丁出错（函数的补丁抛错、组件的补丁画的时候出错）记在插件头上（POST /api/plugins/:id/errors，短时间多次就自动停用）；
 *   同一个插件同一处一分钟只记一次。
 */
import type { WebPatchModule } from '@emaki/shared';
import * as React from 'react';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { usePlugins } from '@/lib/plugins';
import { webPoints } from '@/lib/points';
import type { PatchSpec } from '@emaki/shared';

/** activate(internal) 拿到的东西 */
export interface WebInternalApi {
  plugin: { id: string; version: string };
  patch(point: string, spec: PatchSpec): () => void;
  points(): { name: string; label: string; owners: string[] }[];
  React: typeof React;
  h: typeof React.createElement;
  log(...args: unknown[]): void;
}

type Module = { activate?: (api: WebInternalApi) => unknown; default?: { activate?: (api: WebInternalApi) => unknown } };

export interface LoaderDeps {
  import: (url: string) => Promise<Module>;
  report: (plugin: string, source: string, message: string) => void;
  now: () => number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 加载和撤掉（一个页面一份；测试里换掉 import 和 report） */
export class WebPatchLoader {
  private readonly loaded = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly lastReport = new Map<string, number>();
  private readonly off: () => void;

  constructor(private readonly deps: LoaderDeps) {
    this.off = webPoints.onPatchError((owner, point, err) => this.report(owner, `${point}：${message(err)}`));
  }

  /** 按服务端给的清单对一遍；返回的 Promise 在这一遍做完时好 */
  sync(list: readonly WebPatchModule[]): Promise<void> {
    this.queue = this.queue.then(() => this.syncNow(list)).catch(() => {});
    return this.queue;
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  close(): void {
    this.off();
    for (const id of this.loaded.keys()) webPoints.removeOwner(id);
    this.loaded.clear();
  }

  private async syncNow(list: readonly WebPatchModule[]): Promise<void> {
    for (const [id, url] of this.loaded) {
      if (list.some((x) => x.plugin === id && x.url === url)) continue;
      webPoints.removeOwner(id);
      this.loaded.delete(id);
    }
    for (const m of list) {
      if (this.loaded.has(m.plugin)) continue;
      try {
        await this.load(m);
        this.loaded.set(m.plugin, m.url);
      } catch (e) {
        webPoints.removeOwner(m.plugin);
        this.deps.report(m.plugin, '改网页', `加载不了：${message(e)}`);
      }
    }
  }

  private async load(m: WebPatchModule): Promise<void> {
    const mod = await this.deps.import(m.url);
    const activate = mod.activate ?? mod.default?.activate;
    if (typeof activate !== 'function') throw new Error('没有导出 activate(internal)');
    const declared = new Set(m.points);
    const api: WebInternalApi = {
      plugin: { id: m.plugin, version: m.version },
      patch: (point, spec) => {
        if (!declared.has(point)) throw new Error(`「${point}」没有写在清单的 patch@1 里，改不了`);
        return webPoints.patch(point, m.plugin, spec);
      },
      points: () => webPoints.list(),
      React,
      h: React.createElement,
      log: (...args) => console.info(`[插件 ${m.plugin}]`, ...args),
    };
    await activate(api);
  }

  /** 同一个插件同一处一分钟只记一次（组件出错会跟着重画再出） */
  private report(plugin: string, text: string): void {
    const key = `${plugin}\n${text}`;
    const now = this.deps.now();
    if (now - (this.lastReport.get(key) ?? -Infinity) < 60_000) return;
    this.lastReport.set(key, now);
    this.deps.report(plugin, '改网页', text);
  }
}

let shared: WebPatchLoader | null = null;

/** 在 App 根上调一次：按插件的状态加载、撤掉改网页的插件 */
export function useWebPatches(): void {
  const { state } = usePlugins();
  const list = state.webPatches;
  const key = JSON.stringify(list ?? []);
  useEffect(() => {
    shared ??= new WebPatchLoader({
      import: (url) => import(/* @vite-ignore */ url) as Promise<Module>,
      report: (plugin, source, text) => void api.pluginError(plugin, text.slice(0, 500), source).catch(() => {}),
      now: () => Date.now(),
    });
    void shared.sync(list ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按内容比，不按引用
  }, [key]);
}
