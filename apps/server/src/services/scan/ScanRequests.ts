/**
 * 待扫描的范围：全量，或 T08 文件监听报上来的「脏目录」。T07、T08 共用。
 */
export interface ScanScope {
  rootId: number;
  relDir: string;
  recursive: boolean;
}

const key = (rootId: number, relDir: string) => `${rootId}\n${relDir}`;

/** relDir 是否在 ancestor 之下（含相等） */
const within = (relDir: string, ancestor: string) => ancestor === '' || relDir === ancestor || relDir.startsWith(ancestor + '/');

export class ScanRequests {
  private full = false;
  private readonly dirty = new Map<string, ScanScope>();

  requestFull(): void {
    this.full = true;
  }

  addDirty(s: ScanScope): void {
    // 已被某个（同一或祖先）目录的递归 scope 覆盖就不加
    for (const d of this.dirty.values()) {
      if (d.rootId === s.rootId && d.recursive && within(s.relDir, d.relDir)) return;
    }
    const k = key(s.rootId, s.relDir);
    const prev = this.dirty.get(k);
    const merged = { ...s, recursive: s.recursive || (prev?.recursive ?? false) };
    // 新的是递归 scope：删掉被它覆盖的子 scope
    if (merged.recursive) {
      for (const [dk, d] of this.dirty) if (d.rootId === s.rootId && dk !== k && within(d.relDir, s.relDir)) this.dirty.delete(dk);
    }
    this.dirty.set(k, merged);
  }

  get pending(): boolean {
    return this.full || this.dirty.size > 0;
  }

  /** 取出并清空。没有任何请求时（比如手动 startJob）视为全量 */
  take(): { full: boolean; scopes: ScanScope[] } {
    const full = this.full || this.dirty.size === 0;
    const scopes = full ? [] : [...this.dirty.values()];
    this.full = false;
    this.dirty.clear();
    return { full, scopes };
  }
}
