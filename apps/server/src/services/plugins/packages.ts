/**
 * 插件包放在哪（docs/plugins.md E2）：把一个 zip、一个文件夹、一个 git 地址变成「准备安装」的包，确认后放到固定的位置。
 *
 * 目录都在 <数据目录>/plugins/ 下：
 * - staging/<令牌>/：准备安装的（zip 解开的、git 克隆下来的）。一小时没装就作废；启动时整个清空。
 * - packages/<id>@<版本>-<令牌前 8 位>/：装好的包，装好以后不再改。没有插件指向的在启动时删掉
 *   （撤销只在内存里，重启以后不会再有撤销把删掉的插件找回来，所以那时删是安全的）。
 * - 文件夹装的不复制，直接用那个文件夹：给写插件的人用，改了以后在插件页上「重新读取」。
 * 库里记的包位置：装好的包记相对 plugins/ 的路径（数据文件夹整个搬走也认得），文件夹装的记绝对路径（stored / resolve）。
 *
 * 这里只管文件；清单的检查在 domain/plugins/manifest.ts，库里记什么在 domain/plugins/plugins.ts。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PackageKind } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { resolveProxy } from '../../net/proxy.ts';
import { unzip, ZipError } from './zip.ts';

/** 准备安装的包过多久作废 */
export const STAGING_TTL_MS = 3600_000;
const MANIFEST_FILE = 'emaki-plugin.json';

export interface Staged {
  token: string;
  kind: PackageKind;
  /** 文件名、文件夹的路径、git 地址 */
  location: string;
  ref: string | null;
  /** 清单所在的文件夹 */
  root: string;
  /** 文件夹装的：root 就是用户的文件夹，不复制、不删 */
  linked: boolean;
  createdAt: number;
}

export class PluginPackages {
  private readonly staged = new Map<string, Staged>();

  constructor(
    readonly dataDir: string,
    private readonly clock: () => number,
    /** git 命令（测试换成假的） */
    private readonly git: (args: string[], opts: { timeout: number }) => Promise<void> = runGit,
  ) {}

  get pluginsDir(): string {
    return path.join(this.dataDir, 'plugins');
  }
  private get stagingDir(): string {
    return path.join(this.pluginsDir, 'staging');
  }
  get packagesDir(): string {
    return path.join(this.pluginsDir, 'packages');
  }

  // ---------------------------------------------------------------- 准备

  /** 一个 zip：解开到 staging；清单可以在最外层，也可以在唯一的一个文件夹里（直接压缩一个文件夹的情况） */
  stageZip(fileName: string, buf: Buffer): Staged {
    let entries;
    try {
      entries = unzip(buf);
    } catch (e) {
      throw new BadRequestError(e instanceof ZipError ? `「${fileName}」解不开：${e.message}` : `「${fileName}」解不开`);
    }
    const s = this.newStaging('file', fileName, null);
    for (const e of entries) {
      const to = path.join(s.root, ...e.path.split('/'));
      try {
        mkdirSync(path.dirname(to), { recursive: true });
        writeFileSync(to, e.data);
      } catch {
        this.discard(s.token, s);
        throw new BadRequestError(`「${fileName}」里的「${e.path}」在这台电脑上存不了（文件名里有不能用的字符？）`);
      }
    }
    s.root = this.findRoot(s.root, fileName);
    return this.remember(s);
  }

  /** 这台电脑上的一个文件夹：不复制 */
  stageFolder(folder: string): Staged {
    const dir = path.resolve(folder);
    if (!path.isAbsolute(folder)) throw new BadRequestError('要写完整的路径，比如 D:\\plugins\\my-plugin');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BadRequestError(`找不到文件夹：${dir}`);
    if (!existsSync(path.join(dir, MANIFEST_FILE))) throw new BadRequestError(`这个文件夹里没有 ${MANIFEST_FILE}`);
    const token = randomBytes(12).toString('base64url');
    return this.remember({ token, kind: 'folder', location: dir, ref: null, root: dir, linked: true, createdAt: this.clock() });
  }

  /** 一个 git 地址：浅克隆到 staging（走 Emaki 的代理设置），去掉 .git */
  async stageGit(url: string, ref: string | null): Promise<Staged> {
    checkGitUrl(url);
    if (ref !== null && !/^[\w][\w./-]{0,99}$/.test(ref)) throw new BadRequestError(`分支或标签「${ref}」的写法不对`);
    const s = this.newStaging('git', url, ref);
    const proxy = (await resolveProxy()).url;
    const args = [
      // 不让地址里的 ext::、file:// 这类方式执行命令或读本机文件
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'protocol.file.allow=never',
      ...(proxy ? ['-c', `http.proxy=${proxy}`] : []),
      'clone',
      '--depth',
      '1',
      ...(ref ? ['--branch', ref] : []),
      '--',
      url,
      s.root,
    ];
    try {
      await this.git(args, { timeout: 120_000 });
    } catch (e) {
      this.discard(s.token, s);
      throw new BadRequestError(gitMessage(e));
    }
    rmSync(path.join(s.root, '.git'), { recursive: true, force: true });
    s.root = this.findRoot(s.root, url);
    return this.remember(s);
  }

  /** 宿主自己生成的包（AI 助手做的页面）：几个文件写到 staging。files 的键是相对路径（只用 / 分隔，宿主给的，不含 ..） */
  stageFiles(kind: PackageKind, location: string, files: Record<string, string>): Staged {
    const s = this.newStaging(kind, location, null);
    for (const [rel, text] of Object.entries(files)) {
      const to = path.join(s.root, ...rel.split('/'));
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, text);
    }
    return this.remember(s);
  }

  /** 准备好的包；过期的、没有的返回 null */
  get(token: string): Staged | null {
    this.expire();
    return this.staged.get(token) ?? null;
  }

  /** 不装了：删掉解开的文件 */
  discard(token: string, s = this.staged.get(token)): void {
    this.staged.delete(token);
    if (s && !s.linked) rmSync(path.join(this.stagingDir, s.token), { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 装

  /** 放到固定的位置，返回库里记的位置（stored） */
  commit(s: Staged, id: string, version: string): string {
    this.staged.delete(s.token);
    if (s.linked) return s.root;
    const name = `${id}@${version}-${s.token.slice(0, 8)}`;
    const dir = path.join(this.packagesDir, name);
    mkdirSync(this.packagesDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    cpSync(s.root, dir, { recursive: true });
    rmSync(path.join(this.stagingDir, s.token), { recursive: true, force: true });
    return `packages/${name}`;
  }

  /** 库里记的位置 → 磁盘上的文件夹 */
  resolve(stored: string): string {
    return path.isAbsolute(stored) ? stored : path.join(this.pluginsDir, ...stored.split('/'));
  }

  /** 启动时：清空 staging，删掉没有插件指向的包（referenced 是库里记的位置） */
  cleanup(referenced: Iterable<string>): void {
    rmSync(this.stagingDir, { recursive: true, force: true });
    if (!existsSync(this.packagesDir)) return;
    const keep = new Set([...referenced].map((p) => path.resolve(this.resolve(p))));
    for (const name of readdirSync(this.packagesDir)) {
      const dir = path.join(this.packagesDir, name);
      if (!keep.has(path.resolve(dir))) rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- 内部

  private newStaging(kind: PackageKind, location: string, ref: string | null): Staged {
    this.expire();
    const token = randomBytes(12).toString('base64url');
    const root = path.join(this.stagingDir, token);
    mkdirSync(kind === 'git' ? this.stagingDir : root, { recursive: true });
    return { token, kind, location, ref, root, linked: false, createdAt: this.clock() };
  }

  private remember(s: Staged): Staged {
    this.staged.set(s.token, s);
    return s;
  }

  private expire(): void {
    const now = this.clock();
    for (const s of [...this.staged.values()]) if (now - s.createdAt > STAGING_TTL_MS) this.discard(s.token, s);
  }

  /** 清单在最外层，或者在唯一的一个文件夹里 */
  private findRoot(dir: string, label: string): string {
    if (existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
    if (entries.length === 1 && entries[0]!.isDirectory() && existsSync(path.join(dir, entries[0]!.name, MANIFEST_FILE)))
      return path.join(dir, entries[0]!.name);
    rmSync(dir, { recursive: true, force: true });
    throw new BadRequestError(`「${label}」里没有 ${MANIFEST_FILE}，不是 Emaki 插件`);
  }
}

/** 只认 https://、http://、ssh://、git@主机:路径；不认 ext::、file://、本机路径，也不能以 - 开头（会被当成参数） */
export function checkGitUrl(url: string): void {
  const ok = /^(https?|ssh):\/\/[^\s]+$/i.test(url) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url);
  if (!ok || url.startsWith('-') || url.includes('::')) throw new BadRequestError('git 地址要写成 https://…、ssh://… 或 git@主机:路径');
}

async function runGit(args: string[], opts: { timeout: number }): Promise<void> {
  await promisify(execFile)('git', args, {
    timeout: opts.timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    // 不弹登录框：私有仓库要么已经配好凭证，要么直接失败
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' },
  });
}

function gitMessage(e: unknown): string {
  const err = e as { code?: string; killed?: boolean; stderr?: string; message?: string };
  if (err.code === 'ENOENT') return '这台电脑上没有装 git，装好以后再试，或者下载 zip 再从文件安装';
  if (err.killed) return 'git 下载超时了（2 分钟）';
  const lines = String(err.stderr ?? err.message ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.filter((l) => /fatal|error|could not|not found/i.test(l)).at(-1) ?? lines.at(-1) ?? '未知错误';
  return `git 下载失败：${last}`;
}
