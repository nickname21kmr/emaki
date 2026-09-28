import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测试用临时目录，绝不放进仓库的 data/（那里是真实数据库）。
 * - 设了 EMAKI_TEST_TMP 就用它；
 * - 本机：仓库旁边有 .work 目录（F:/Claude/.work）就放在 .work/tmp-tests 下（F 盘，不占系统盘）；
 * - 其他环境（CI）：系统临时目录。
 */
const WORK_DIR = path.resolve(import.meta.dirname, '../../../../../.work');
export const TEST_TMP_ROOT = process.env.EMAKI_TEST_TMP
  ? path.resolve(process.env.EMAKI_TEST_TMP)
  : existsSync(WORK_DIR)
    ? path.join(WORK_DIR, 'tmp-tests')
    : path.join(os.tmpdir(), 'emaki-tests');

export function makeTmpDir(prefix: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TEST_TMP_ROOT, `${prefix}-`));
}
