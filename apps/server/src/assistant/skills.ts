import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One authored copy per skill; each harness reads the same session-local package. */
export function prepareSkills(repoRoot: string, cwd: string, dataDir: string, apiBaseUrl: string) {
  const sources = [
    ['emaki-library', 'apps/server/assets/assistant/emaki-library'],
    ['taste-profile', '.claude/skills/taste-profile'],
  ] as const;
  return sources.map(([name, relative]) => {
    const dir = path.join(cwd, '.agents/skills', name);
    mkdirSync(dir, { recursive: true });
    cpSync(path.join(repoRoot, relative), dir, { recursive: true });
    if (name === 'taste-profile') {
      writeFileSync(path.join(dir, '.emaki-runtime.json'), JSON.stringify({
        repoRoot, dataDir, apiBaseUrl,
        // 所有会话共用一个输出目录：快照原地覆盖（整库一份几百 MB），WD 抽样和对照缓存也能接着用
        outDir: path.join(dataDir, 'profile', 'assistant'),
      }, null, 2));
    }
    const file = path.join(dir, 'SKILL.md');
    const description = /^description:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1];
    if (!description) throw new Error(`Skill ${name} 缺少 description`);
    return { name, path: file, description };
  });
}
