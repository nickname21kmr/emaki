// 运行时测试用的插件（test/plugins/runtime.test.ts）：每个命令演示 emaki 的一样东西
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const code = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e.code ?? e.message;
  }
};

export async function activate(emaki) {
  emaki.commands.handle('echo', (input, { caller }) => ({ text: input.text, caller }));

  emaki.commands.handle('probe', ({ outside }) => ({
    readOutside: code(() => readFileSync(outside)),
    writeOutside: code(() => writeFileSync(`${outside}.evil`, 'x')),
    writeInside: code(() => writeFileSync(emaki.files.path('mine.txt'), 'x')),
    readInside: code(() => readFileSync(emaki.files.path('mine.txt'))),
    spawn: code(() => {
      const r = spawnSync(process.execPath, ['-e', '1']);
      if (r.error) throw r.error;
    }),
    escape: code(() => emaki.files.path('..', 'x')),
  }));

  // 经宿主做的事：op 是 emaki 上的方法
  emaki.commands.handle('host', async ({ op, arg }) => {
    switch (op) {
      case 'call':
        return { value: await emaki.call(arg.name, arg.input) };
      case 'settings':
        return {
          token: await emaki.settings.get('token'),
          name: await emaki.settings.get('name'),
          session: await emaki.secrets.get('session'),
        };
      case 'setSecret':
        await emaki.secrets.set('session', arg);
        return {};
      case 'storage':
        await emaki.storage.set('k', arg);
        return { value: await emaki.storage.get('k'), keys: await emaki.storage.list() };
      case 'download': {
        const r = await emaki.fetch(arg.url, { saveAs: `dl/${arg.name}`, headers: { referer: 'https://example.test/' } });
        if (!r.ok) return { status: r.status };
        return await emaki.library.import({ files: [{ path: r.path, fileName: arg.name }] });
      }
      case 'fetch':
        return await emaki.fetch(arg.url, arg.options ?? {});
      case 'import':
        return await emaki.library.import(arg);
      case 'job':
        return await emaki.jobs.start('count', arg, { title: `数到 ${arg.n}` });
      case 'lastChange':
        return { changes: (await emaki.storage.get('lastChange')) ?? null };
      default:
        throw new Error(`不认识 ${op}`);
    }
  });

  emaki.commands.handle('crash', () => {
    setTimeout(() => {
      throw new Error('故意崩的');
    });
    return { ok: true };
  });
  emaki.commands.handle('hang', () => new Promise(() => {}));

  emaki.jobs.register('count', async ({ n, stepMs = 5 }, job) => {
    job.setTotal(n);
    for (let i = 0; i < n; i++) {
      if (job.signal.aborted) throw new Error('取消了');
      await new Promise((r) => setTimeout(r, stepMs));
      job.advance(1, `数到 ${i + 1}`);
    }
    return `数完了 ${n} 个`;
  });

  emaki.on('changed', (e) => emaki.storage.set('lastChange', e.changes));
}
