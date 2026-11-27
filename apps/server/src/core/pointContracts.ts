/**
 * 内部点的约定（docs/plugins.md 第 7 节）：每个点「补丁能看到、依赖的样子」，记在 pointContracts.json 里（随代码一起提交）。
 * 指纹只按约定算（core/points.ts）：约定没变、只改了里面的实现，改它的插件照常用；约定变了才自动停用、等你「仍然启用」。
 *
 * 约定是什么（scripts/pointContracts.ts 生成）：
 * - 命令、查询：权限范围、能不能撤销、输入的 JSON Schema、手动的 contractVersion（返回的格式变了时加一）；
 * - 对变化的反应：订阅哪些变化、在哪个阶段、会声明哪些变化、没有变化也跑不跑；
 * - 后台任务：执行体拿到任务上下文、返回一句话（种类在名字里）；
 * - 口径、网页的函数：函数的参数和返回（源码里写的签名）和版本号；
 * - 网页的组件：props 的类型（源码里写的，去掉注释和空白）和版本号。
 *
 * test/architecture/pointContracts.test.ts 现场再生成一遍和这份比：改了约定（加了点、改了 props、改了命令的输入……）测试就失败，
 * 改的人运行 `npm run points:contracts -w @emaki/server` 更新这份文件，在 diff 里看清楚改了哪些插件依赖的东西。
 */
import { readFileSync } from 'node:fs';

export type PointContracts = Record<string, string[]>;

export const CONTRACTS_FILE = new URL('./pointContracts.json', import.meta.url);

let cache: PointContracts | null = null;

/** 记下的约定（读不到就是空的：指纹退回按实现算） */
export function pointContracts(): PointContracts {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8')) as PointContracts;
    } catch {
      cache = {};
    }
  }
  return cache;
}
