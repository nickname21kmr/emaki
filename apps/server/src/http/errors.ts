import type { ApiError } from '@emaki/shared';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiError['code'],
    message: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, 'not_found', `找不到${what}`);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, 'bad_request', message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'conflict', message);
  }
}

/**
 * 还没实现的功能统一抛这个，参数是 docs/TASKS.md 里的任务编号，
 * 这样前端 toast 能直接告诉你缺的是哪一项。
 */
export class NotImplementedError extends HttpError {
  constructor(taskId: string, what = '') {
    super(501, 'not_implemented', `尚未实现${what ? `：${what}` : ''}（见 docs/TASKS.md ${taskId}）`);
  }
}

export function toApiError(err: unknown): { statusCode: number; body: ApiError } {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { ok: false, error: err.message, code: err.code } };
  }
  // fastify 的校验错误等
  const statusCode = (err as { statusCode?: number }).statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      body: { ok: false, error: (err as Error).message, code: 'bad_request' },
    };
  }
  return {
    statusCode: 500,
    body: { ok: false, error: err instanceof Error ? err.message : String(err), code: 'internal' },
  };
}
