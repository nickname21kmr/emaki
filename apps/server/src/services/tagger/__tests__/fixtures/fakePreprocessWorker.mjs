// PreprocessPool 测试用的假工作线程：path 是 'crash' 就直接退出，'slow:<ms>' 延迟后回复，其余回一个小数组
import { parentPort } from 'node:worker_threads';

parentPort.on('message', async ({ id, path }) => {
  if (path === 'crash') process.exit(3);
  if (path === 'missing') return parentPort.postMessage({ id, ok: false, code: 'ENOENT', message: '文件不存在' });
  if (path.startsWith('slow:')) await new Promise((r) => setTimeout(r, Number(path.slice(5))));
  const data = new Float32Array([1, 2, 3]);
  parentPort.postMessage({ id, ok: true, data }, [data.buffer]);
});
