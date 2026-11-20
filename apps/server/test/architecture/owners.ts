/**
 * 「表 → 主人模块」映射（docs/core-architecture.md 第 2.4、3 节）。
 *
 * 每张表（images 按列组）只由一个模块写入。主人目录是将来的领域模块位置：现在这些目录大多还不存在，
 * 所以现有的写入几乎都记在允许清单（writers.allowlist.ts）里，随着 P2–P6 把代码搬进主人目录逐步删掉。
 *
 * 新建表、给 images 加列时，要在这里（或 sqlWrites.ts 的 IMAGE_COLUMN_GROUPS）登记主人，否则测试失败。
 */
import { DYNAMIC_TABLE } from './sqlWrites.ts';

export type ModuleId =
  | 'library'
  | 'analysis'
  | 'evidence'
  | 'catalog'
  | 'curation'
  | 'visibility'
  | 'collections'
  | 'duplicates'
  | 'settings'
  | 'commands'
  | 'propagation'
  | 'access'
  | 'upload';

/** 模块的中文名和目录（相对 apps/server/src，以 / 结尾） */
export const MODULES: Record<ModuleId, { name: string; dir: string }> = {
  library: { name: '图库与文件', dir: 'domain/library/' },
  analysis: { name: '分析', dir: 'domain/analysis/' },
  evidence: { name: '证据', dir: 'domain/evidence/' },
  catalog: { name: '编目', dir: 'domain/catalog/' },
  curation: { name: '归类', dir: 'domain/curation/' },
  visibility: { name: '可见性', dir: 'domain/visibility/' },
  collections: { name: '合集', dir: 'domain/collections/' },
  duplicates: { name: '查重', dir: 'domain/duplicates/' },
  settings: { name: '设置', dir: 'domain/settings/' },
  // 命令层：撤销记录的回放（按表名拼 SQL）和改动记录（change_log）
  commands: { name: '命令层', dir: 'commands/' },
  // 变更传播（P2）：变化集、反应注册表；排队状态（pending_work）
  propagation: { name: '变更传播', dir: 'propagation/' },
  // 设备与访问（docs/mobile.md 第 2 节）：局域网入口、配对、设备凭证
  access: { name: '设备与访问', dir: 'access/' },
  // 手机上传（docs/mobile.md 5.4）：上传的批次和每个文件的进度；入库走图库与文件的导入
  upload: { name: '手机上传', dir: 'domain/upload/' },
};

/** 表（images 是 images#<列组>）→ 主人 */
export const TABLE_OWNERS: Record<string, ModuleId> = {
  // 图库与文件：文件夹、漫画区设置、观测列、扫描错误、回收批次
  library_roots: 'library',
  comic_folders: 'library',
  scan_errors: 'library',
  pending_trash: 'library',
  pending_trash_items: 'library',
  'images#library': 'library',
  // 分析：派生数据（P4a 删掉了没人读写的 image_fingerprints，迁移 037）
  'images#analysis': 'analysis',
  // 证据：模型标签、按「图片 × 来源」的角色 / 作品候选和原创信号（建议是它派生的视图，P3b）、Pixiv 和 Danbooru 的缓存与待查记录、
  // 识别进度、文件名解析的来源
  tags: 'evidence',
  image_tags: 'evidence',
  image_evidence: 'evidence',
  character_evidence: 'evidence',
  work_evidence: 'evidence',
  pixiv_artwork_cache: 'evidence',
  pixiv_character_checks: 'evidence',
  pixiv_unavailable_posts: 'evidence',
  danbooru_tags: 'evidence',
  danbooru_artists: 'evidence',
  'images#evidence': 'evidence',
  // 编目：角色、作品、画师合并、别名、重定向、Danbooru 绑定和核验、名字索引和词库
  characters: 'catalog',
  works: 'catalog',
  character_works: 'catalog',
  aliases: 'catalog',
  danbooru_tag_redirects: 'catalog',
  custom_character_matches: 'catalog',
  character_verified_forms: 'catalog',
  character_verified_names: 'catalog',
  artist_links: 'catalog',
  tag_i18n: 'catalog',
  tag_name_keys: 'catalog',
  tag_renames: 'catalog',
  // 归类：图 ↔ 角色 / 作品 / 画师、否决、收藏分级原创放下等决定列
  image_characters: 'curation',
  image_copyrights: 'curation',
  image_artists: 'curation',
  character_vetoes: 'curation',
  'images#curation': 'curation',
  // 可见性：排除规则和排除结果
  exclusions: 'visibility',
  'images#visibility': 'visibility',
  // 合集
  collections: 'collections',
  collection_characters: 'collections',
  collection_works: 'collections',
  'images#collections': 'collections',
  // 查重
  duplicate_groups: 'duplicates',
  duplicate_members: 'duplicates',
  duplicate_comparisons: 'duplicates',
  // 设置
  settings: 'settings',
  // 命令层：最近的改动（可撤回）、审计记录和 operationId 幂等（P6，迁移 040）
  change_log: 'commands',
  command_log: 'commands',
  [DYNAMIC_TABLE]: 'commands',
  // 变更传播：交给后台任务、还没做完的工作和用户的暂停（迁移 033）；派生数据的版本（迁移 037）
  pending_work: 'propagation',
  derived_versions: 'propagation',
  // 设备与访问：局域网入口的配置（迁移 041）、批准过的设备和凭证的哈希
  lan_access: 'access',
  devices: 'access',
  // 手机上传（迁移 042）、同步相册（迁移 043）
  upload_batches: 'upload',
  uploads: 'upload',
  device_albums: 'upload',
  device_sync: 'upload',
};

/**
 * 永久例外：可以写任何表的目录。
 * demo/ 是演示数据灌入——把固定的演示数据直接写进一个空的一次性库，不经过命令（也不该触发连带处理）。
 */
export const EXEMPT_DIRS: { dir: string; why: string }[] = [{ dir: 'demo/', why: '演示数据灌入空库' }];
