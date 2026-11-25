/**
 * 插件的视图在 MCP 里（docs/plugins.md 第 5 节「向外」）：在 Claude 这类 MCP Apps 宿主里打开同一个页面。
 *
 * 视图在 Emaki 里用 `<script src="/plugin-sdk/app.js"></script>` 加载宿主给的库（官方 App 类加上 Emaki 的小封装，
 * 网页构建时生成，apps/web/plugin-sdk.ts）。别的宿主那里没有这个地址，所以经 MCP 给出去的页面把它内联进来（forMcp）。
 * 这里还放给 AI 助手看的写法（VIEW_GUIDE，plugins_save_view 的说明）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/** MCP Apps 视图资源的类型（2026-01-26 稳定版） */
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** 视图里加载宿主的库的地址 */
export const SDK_PATH = '/plugin-sdk/app.js';

const SDK_TAG = /<script\b[^>]*\bsrc\s*=\s*["']?\/plugin-sdk\/app\.js["']?[^>]*>\s*<\/script\s*>/gi;

/** 给别的宿主的页面：把 /plugin-sdk/app.js 内联进来（没有构建过网页时 sdk 是 null，原样返回，页面在那边打不开） */
export function forMcp(html: string, sdk: string | null): string {
  if (sdk === null) return html;
  // 内联的脚本里不能出现 </script，转成 <\/script（在字符串、正则里意思不变）
  const inline = `<script>${sdk.replace(/<\/script/gi, '<\\/script')}</script>`;
  return html.replace(SDK_TAG, () => inline);
}

let cached: { file: string; mtime: number; text: string } | null = null;

/** 网页构建出的 /plugin-sdk/app.js（按修改时间缓存）；没有构建过是 null */
export function loadSdk(webDist = config.webDist): string | null {
  const file = path.join(webDist, 'plugin-sdk', 'app.js');
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (cached?.file !== file || cached.mtime !== mtime) cached = { file, mtime, text: readFileSync(file, 'utf8') };
  return cached.text;
}

/** plugins_save_view 的说明里给 AI 看的写法：模板、能用的方法、限制 */
export const VIEW_GUIDE = `视图的写法（MCP Apps 的 HTML 视图；在隔离的 iframe 里，不能联网、不能直接请求 /api，只能经桥接调工具）：
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 16px 24px; font-family: var(--font-sans); color: var(--color-text-primary); background: var(--color-background-primary); }
</style></head><body>
<div id="app">加载中…</div>
<script src="/plugin-sdk/app.js"></script>
<script type="module">
  const view = await Emaki.connect({ name: 'fav-stats', version: '1.0.0' });
  const works = await view.read('/api/works?limit=20');      // 就是 read_library：地址和你能用的一样，返回解析好的 JSON
  const r = await view.call('curation_set_favorite', { ids: ['1'], value: true }); // 别的工具（写操作的 operationId 会自动补）
  img.src = await view.thumb(imageId);                         // 缩略图地址；原图用 view.original(id)
  view.open('/gallery?workId=12');                             // 跳到 Emaki 的一页；view.openImages(ids) 用看图器打开
  await view.storage.set('lastTab', 'works');                  // 这一页自己的存储（键值）
  view.onChanged(() => render());                              // 图库变了（整理、导入以后）重新取数
</script></body></html>
- 只用分页和统计的查询（/api/stats、/api/summary、/api/works、/api/characters?sort=…&limit=…、/api/images?limit=…），不要一次拉全部图片；数据多时分页取。
- 只读的页面 scopes 用默认的 ["read"]；要改数据才加对应的范围（不能超过你自己的）。
- 样式用宿主给的 CSS 变量（MCP Apps 标准：--color-background-primary/secondary、--color-text-primary/secondary、--color-border-primary、--font-sans、--font-mono、--border-radius-md 等），浅色深色都要能看；不要引外部的脚本、字体、图片（会被拦），图表用 SVG 或 canvas 自己画。
- 同一页在 Claude 里也能打开：那里没有 view.open、view.storage（调用不报错，什么都不做 / 存在内存里），图片经 read_media 取成 data: 地址，所以只在要显示时取，别一次取几百张。
- 页面不要写死 Emaki 内部的表结构（不用 SQL）：只用工具和 read_library 的地址，Emaki 升级以后照样能用。`;
