/**
 * 和启动器（scripts/start.mjs）之间的约定。
 *
 * 启动器一上来就在后端的端口上起一个「启动页」，窗口先打开（scripts/splash-server.mjs）。后端这边要做两件事：
 * - 监听之前请它把端口让出来（before-listen → port-free）；
 * - 应用窗口关掉时听它的通知，自己正常收尾后退出（shutdown），不用等它来强杀。
 * 走的是启动器 spawn 后端时带的 ipc 通道，消息的 type 都以 emaki: 开头。
 *
 * 只认启动器起的后端：环境变量 EMAKI_LAUNCHER=1 而且有 ipc 通道。光看 process.send 不行：
 * `node --watch`（npm run dev）和 vitest 的子进程也有 ipc 通道，对面不懂这些消息，只会白等。
 */

/** 用到的那一小部分 process（测试里换成假的） */
export interface LauncherProcess {
  env: NodeJS.ProcessEnv;
  send?: (message: unknown, sendHandle?: undefined, options?: undefined, callback?: (error: Error | null) => void) => unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface Launcher {
  /** 监听之前调用：请启动器让出端口，等它说让好了（最多 waitMs；等不到照样往下走，监听那一步自己会重试） */
  releasePort(waitMs?: number): Promise<void>;
  /** 启动器说应用窗口关了、该退出了；只留最后一次设的处理函数 */
  onShutdown(handler: () => void): void;
}

const typeOf = (message: unknown): unknown => (typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined);

/** 是启动器起的就接上它，不是返回 null（npm run dev、测试、别的脚本直接起后端：行为和没有启动器时一样） */
export function connectLauncher(proc: LauncherProcess = process): Launcher | null {
  const marked = proc.env.EMAKI_LAUNCHER === '1';
  // 用过就删：AI 助手的 agent、识别子进程会继承环境，它们再起的后端（npm run dev 之类）不该把父进程当成启动器
  delete proc.env.EMAKI_LAUNCHER;
  if (!marked || typeof proc.send !== 'function') return null;
  // 带回调：启动器已经不在时错误交给回调，不会变成进程上没人接的 error 事件
  const send = (type: string) => void proc.send?.({ type }, undefined, undefined, () => {});
  let shutdown = (): void => {};
  proc.on('message', (message) => {
    if (typeOf(message) === 'emaki:shutdown') shutdown();
  });
  // 从这时起收得到退出通知。在这之前窗口就关了的话，启动器直接结束这个进程（代码还在加载，没有要收尾的）
  send('emaki:hello');
  return {
    releasePort(waitMs = 3000) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          proc.off('message', onMessage);
          resolve();
        };
        const onMessage = (message: unknown) => {
          if (typeOf(message) === 'emaki:port-free') done();
        };
        const timer = setTimeout(done, waitMs);
        proc.on('message', onMessage);
        send('emaki:before-listen');
      });
    },
    onShutdown(handler) {
      shutdown = handler;
    },
  };
}

/**
 * 启动器刚让出端口的那一瞬可能还占不上：遇到端口被占用就隔 everyMs 再试，最多 forMs；别的错误直接抛。
 * listen 失败后可以原样再调（fastify 的 listen 是这样）。
 */
export async function listenWhenFree<T>(listen: () => Promise<T>, { everyMs = 100, forMs = 3000 } = {}): Promise<T> {
  const deadline = Date.now() + forMs;
  for (;;) {
    try {
      return await listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
}
