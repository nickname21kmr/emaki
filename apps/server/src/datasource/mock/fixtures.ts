import type {
  CharacterSource,
  ContentKind,
  ContentKindSource,
  DuplicateKind,
  ExclusionKind,
  FocusPoint,
  ID,
  ImageFormat,
  ImageSource,
  Rating,
  Settings,
  TagScore,
} from '@emaki/shared';
import { seedCollections } from './collections-seed.ts';
import { hashString, seededRandom } from './placeholder.ts';
import { ARTISTS, GENERAL_TAGS, LONG_TAIL_WORKS, SEED_WORKS, type SeedWork } from './seed-data.ts';

/** mock 数据库里的行：只存「原始」字段，计数等派生字段由 MockDataSource 现算。 */
export interface WorkRow {
  id: ID;
  name: string;
  danbooruTag: string | null;
  aliases: string[];
  hue: number;
}

export interface CharacterRow {
  id: ID;
  name: string;
  danbooruTag: string | null;
  source: CharacterSource;
  aliases: string[];
  workIds: ID[];
  newCount: number;
  coverImageId: ID | null;
  /** 封面是用户手动设的；不写时按「有 coverImageId 就算手动」（和 sqlite 种子一致） */
  coverManual?: boolean;
  coverFocus: FocusPoint | null;
  pinned: boolean;
}

export interface ImageRow {
  id: ID;
  relPath: string;
  fileName: string;
  libraryRootId: ID;
  width: number;
  height: number;
  bytes: number;
  format: ImageFormat;
  addedAt: string;
  modifiedAt: string;
  rating: Rating;
  characterIds: ID[];
  /** tagger 识别出的作品（即使没识别出角色也可能有） */
  copyrightWorkIds: ID[];
  hue: number;
  /** 占位图的随机种子；重复组里的副本沿用原图的种子，看起来才像同一张图 */
  seed: string;
  source: ImageSource | null;
  favorite: boolean;
  tags: TagScore[];
  /** 未识别图片的候选角色：[danbooruTag, score] */
  suggestions: [string, number][];
  tagged: boolean;
  excludedBy: ID | null;
  /** 被「重复」处理移到回收站 */
  trashed: boolean;
  /** 内容类型（T27）；不写 = 插画（契约夹具不动，BI-7） */
  kind?: ContentKind;
  /** 规则判出的类型：「恢复自动判断」回到它；不写 = 按 classifyContent 现算 */
  autoKind?: ContentKind;
  kindSource?: ContentKindSource | null;
  kindEvidence?: string | null;
  kindManual?: boolean;
  /** 「放下」的时间（T27 补充） */
  shelvedAt?: string | null;
  /** 「归为原创」的时间 */
  originalAt?: string | null;
  /** 所在合集和页码（T38c） */
  collectionId?: ID | null;
  pageNo?: number | null;
}

/** 合集（T38c）：字段与 collections 表一一对应，外加手动关联 */
export interface CollectionRow {
  id: ID;
  rootId: ID;
  relDir: string;
  kind: 'doujin' | 'artbook';
  kindSource: 'pages' | 'name' | 'manual';
  kindManual: boolean;
  title: string | null;
  titleManual: boolean;
  event: string | null;
  circle: string | null;
  artist: string | null;
  parody: string | null;
  translator: string | null;
  seriesKey: string | null;
  volumeNo: number | null;
  seriesManual: boolean;
  pageOrder: 'name' | 'mtime';
  coverImageId: ID | null;
  origin: 'auto' | 'manual';
  state: 'active' | 'dismissed';
  evidence: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  manualCharacterIds: ID[];
  manualWorkIds: ID[];
}

export interface DuplicateRow {
  id: ID;
  kind: DuplicateKind;
  similarity: number;
  imageIds: ID[];
  suggestedKeepId: ID;
  resolved: boolean;
}

export interface ExclusionRow {
  id: ID;
  kind: ExclusionKind;
  target: string;
  label: string;
  createdAt: string;
}

export interface MockDb {
  works: Map<ID, WorkRow>;
  characters: Map<ID, CharacterRow>;
  images: Map<ID, ImageRow>;
  duplicates: DuplicateRow[];
  exclusions: ExclusionRow[];
  settings: Settings;
  collections: Map<ID, CollectionRow>;
}

const IMAGE_COUNT = 9000;
const DAY = 86_400_000;

export function buildMockDb(now = Date.now()): MockDb {
  const r = seededRandom(20260927);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;

  const works = new Map<ID, WorkRow>();
  const characters = new Map<ID, CharacterRow>();
  const charByTag = new Map<string, CharacterRow>();

  const allSeeds: SeedWork[] = [...SEED_WORKS, ...LONG_TAIL_WORKS];
  let wi = 0;
  let ci = 0;
  const weighted: { char: CharacterRow; weight: number; hue: number }[] = [];

  for (const sw of allSeeds) {
    const work: WorkRow = { id: `w${++wi}`, name: sw.name, danbooruTag: sw.tag, aliases: sw.aliases, hue: sw.hue };
    works.set(work.id, work);
    for (const sc of sw.characters) {
      const ch: CharacterRow = {
        id: `c${++ci}`,
        name: sc.name,
        danbooruTag: sc.tag,
        source: sc.tag ? 'danbooru' : 'custom',
        aliases: sc.aliases,
        workIds: [work.id],
        newCount: 0,
        coverImageId: null,
        coverFocus: null,
        pinned: false,
      };
      characters.set(ch.id, ch);
      if (sc.tag) charByTag.set(sc.tag, ch);
      weighted.push({ char: ch, weight: sc.weight, hue: sw.hue });
    }
  }

  // 跨作品角色的例子：玛修同时属于 Fate 系列 和 FGO（这里用 Fate 本身演示 workIds 可以多个）
  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  const pickChar = () => {
    let x = r() * totalWeight;
    for (const w of weighted) {
      x -= w.weight;
      if (x <= 0) return w;
    }
    return weighted[0]!;
  };

  const images = new Map<ID, ImageRow>();
  const ratings: [Rating, number][] = [
    ['general', 0.55],
    ['sensitive', 0.3],
    ['questionable', 0.12],
    ['explicit', 0.03],
  ];
  const pickRating = (): Rating => {
    let x = r();
    for (const [rating, p] of ratings) {
      x -= p;
      if (x <= 0) return rating;
    }
    return 'general';
  };

  for (let i = 1; i <= IMAGE_COUNT; i++) {
    const id = `i${i}`;
    // 越新的图越多：用 r()^1.5 把时间往「最近」挤
    const age = Math.pow(r(), 1.5) * 900 * DAY;
    const addedAt = new Date(now - age).toISOString();
    const modifiedAt = new Date(now - age - r() * 30 * DAY).toISOString();

    const shape = r();
    // 62% 竖图、25% 横图、13% 方图
    const width =
      shape < 0.62 ? pick([1200, 1414, 1600, 2048]) : shape < 0.87 ? pick([1920, 2560, 1600]) : pick([1500, 2000, 1200]);
    const h =
      shape < 0.62 ? Math.round(width * (1.3 + r() * 0.3)) : shape < 0.87 ? Math.round(width * (0.52 + r() * 0.12)) : width;

    const unrecognized = r() < 0.075;
    const primary = pickChar();
    const characterIds: ID[] = [];
    if (!unrecognized) {
      characterIds.push(primary.char.id);
      if (r() < 0.1) {
        // 双人图：大概率同作品
        const sameWork = weighted.filter((w) => w.char.workIds[0] === primary.char.workIds[0] && w.char !== primary.char);
        const second = sameWork.length && r() < 0.8 ? pick(sameWork) : pickChar();
        if (second.char !== primary.char) characterIds.push(second.char.id);
      }
    }

    const siteRoll = r();
    const artist = pick(ARTISTS);
    const postId = String(100_000_000 + Math.floor(r() * 30_000_000));
    let fileName: string;
    let source: ImageSource | null;
    let format: ImageFormat;
    if (siteRoll < 0.6) {
      format = r() < 0.7 ? 'png' : 'jpeg';
      fileName = `${postId}_p${Math.floor(r() * 3)}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      source = { site: 'pixiv', postId, artist, url: `https://www.pixiv.net/artworks/${postId}` };
    } else if (siteRoll < 0.85) {
      format = 'jpeg';
      fileName = `G${Math.floor(r() * 1e9).toString(36).toUpperCase()}aAbC.jpg`;
      source = { site: 'twitter', artist };
    } else if (siteRoll < 0.93) {
      format = 'webp';
      fileName = `illust_${postId}.webp`;
      source = { site: 'danbooru', postId, url: `https://danbooru.donmai.us/posts/${postId}`, artist };
    } else {
      format = pick(['png', 'jpeg', 'webp'] as const);
      fileName = `IMG_${String(i).padStart(5, '0')}.${format === 'jpeg' ? 'jpg' : format}`;
      source = null;
    }

    const workName = works.get(primary.char.workIds[0]!)!.name;
    const folder = unrecognized ? '未整理' : workName;
    const rating = pickRating();

    const tags: TagScore[] = [];
    const nGeneral = 8 + Math.floor(r() * 10);
    const used = new Set<string>();
    for (let k = 0; k < nGeneral; k++) {
      const t = pick(GENERAL_TAGS);
      if (used.has(t)) continue;
      used.add(t);
      tags.push({ tag: t, category: 'general', score: 0.35 + r() * 0.64 });
    }
    for (const cid of characterIds) {
      const ch = characters.get(cid)!;
      if (ch.danbooruTag) tags.push({ tag: ch.danbooruTag, category: 'character', score: 0.75 + r() * 0.24 });
    }
    const copyrightWorkIds = unrecognized && r() < 0.5 ? [] : [...primary.char.workIds];
    for (const wid of copyrightWorkIds) {
      const w = works.get(wid)!;
      if (w.danbooruTag) tags.push({ tag: w.danbooruTag, category: 'copyright', score: 0.6 + r() * 0.39 });
    }
    if (source?.artist) tags.push({ tag: source.artist, category: 'artist', score: 1 });
    tags.sort((a, b) => b.score - a.score);

    const suggestions: [string, number][] = [];
    const tagged = !unrecognized || r() < 0.7;
    if (unrecognized && tagged && primary.char.danbooruTag) {
      suggestions.push([primary.char.danbooruTag, 0.2 + r() * 0.5]);
      const alt = pickChar();
      if (alt.char.danbooruTag && alt.char !== primary.char) suggestions.push([alt.char.danbooruTag, 0.1 + r() * 0.3]);
      suggestions.sort((a, b) => b[1] - a[1]);
    }

    images.set(id, {
      id,
      relPath: `${folder}/${fileName}`,
      fileName,
      libraryRootId: r() < 0.8 ? 'root1' : 'root2',
      width,
      height: h,
      bytes: Math.round(width * h * (format === 'png' ? 1.4 : 0.35) * (0.6 + r() * 0.8)),
      format,
      addedAt,
      modifiedAt,
      rating,
      characterIds,
      copyrightWorkIds,
      hue: primary.hue,
      seed: id,
      source,
      favorite: r() < 0.08,
      tags,
      suggestions,
      tagged,
      excludedBy: null,
      trashed: false,
    });
  }

  // 内容类型（T27）：按 id 哈希分配，约 漫画 12%、截图 8%、表情 4%、文字 3%、照片 2%、动图 2%，其余插画
  for (const img of images.values()) {
    const h = hashString(img.id + 'kind') % 100;
    const kind: ContentKind =
      h < 12 ? 'comic' : h < 20 ? 'screenshot' : h < 24 ? 'meme' : h < 27 ? 'text' : h < 29 ? 'photo' : h < 31 ? 'animated' : 'illustration';
    if (kind === 'illustration') continue;
    img.kind = kind;
    img.autoKind = kind;
    img.kindSource = kind === 'animated' ? 'format' : 'tags';
    img.kindEvidence = kind === 'animated' ? 'GIF 动图' : `识别标签（演示数据）`;
  }

  // 未识别的主题（T34a）：给已识别的图按哈希补一个主题标签，约 45% 的未识别图没有建议（落进「没认出」）。
  // 只用哈希、不调用 r()，不打乱后面的随机序列
  const THEME_TAGS = [
    ['thighhighs', 'pantyhose'], ['barefoot', 'feet'], ['cleavage', 'large_breasts'], ['swimsuit', 'bikini'],
    ['cat_ears', 'animal_ears'], ['rabbit_ears', 'fake_animal_ears'], ['maid', 'maid_headdress'], ['miko', 'kimono'],
    ['multiple_girls', '2girls'], ['no_humans'],
  ];
  for (const img of images.values()) {
    if (!img.tagged) continue;
    const h = hashString(img.id + 'theme') % 100;
    if (h < 60) {
      for (const tag of THEME_TAGS[h % THEME_TAGS.length]!) {
        if (!img.tags.some((t) => t.tag === tag)) img.tags.push({ tag, category: 'general', score: 0.85 });
      }
      img.tags.sort((a, b) => b.score - a.score);
    }
    if (!img.characterIds.length && hashString(img.id + 'sug') % 100 < 45) img.suggestions = [];
  }

  // 「+N」角标：最近 1 天加进来的图算新图，但只给一部分角色（模拟用户看过一些）
  const threeDaysAgo = now - 1 * DAY;
  for (const img of images.values()) {
    if (Date.parse(img.addedAt) < threeDaysAgo) continue;
    for (const cid of img.characterIds) {
      const ch = characters.get(cid)!;
      ch.newCount += 1;
    }
  }
  for (const ch of characters.values()) {
    if (r() < 0.35) ch.newCount = 0;
  }

  // 封面：取该角色分辨率最高的单人竖图
  const bestCover = new Map<ID, ImageRow>();
  for (const img of images.values()) {
    if (img.characterIds.length !== 1 || img.height <= img.width || (img.kind ?? 'illustration') !== 'illustration') continue;
    const cid = img.characterIds[0]!;
    const cur = bestCover.get(cid);
    if (!cur || img.width * img.height > cur.width * cur.height || (img.rating === 'general' && cur.rating !== 'general')) {
      bestCover.set(cid, img);
    }
  }
  for (const [cid, img] of bestCover) {
    const ch = characters.get(cid)!;
    ch.coverImageId = img.id;
    ch.coverFocus = { x: 0.5, y: 0.3 };
  }

  // 排除规则
  const exclusions: ExclusionRow[] = [];
  const addExclusion = (kind: ExclusionKind, target: string, label: string, daysAgo: number, predicate: (img: ImageRow) => boolean) => {
    const row: ExclusionRow = {
      id: `x${exclusions.length + 1}`,
      kind,
      target,
      label,
      createdAt: new Date(now - daysAgo * DAY).toISOString(),
    };
    exclusions.push(row);
    for (const img of images.values()) if (!img.excludedBy && predicate(img)) img.excludedBy = row.id;
  };
  addExclusion('folder', 'D:/Pictures/twitter/表情包', '文件夹 · 推特/表情包', 40, (img) => img.source?.site === 'twitter' && r() < 0.04);
  addExclusion('tag', 'comic', '标签 · comic（漫画分镜）', 22, (img) => r() < 0.006);
  addExclusion('tag', 'ai-generated', '标签 · ai-generated', 9, (img) => r() < 0.005);
  const excludedImages = [...images.values()].filter((img) => !img.excludedBy).slice(40, 46);
  for (const img of excludedImages) {
    addExclusion('image', img.id, `单张 · ${img.fileName}`, Math.floor(r() * 20), (x) => x.id === img.id);
  }

  // 重复组
  const duplicates: DuplicateRow[] = [];
  const candidates = [...images.values()].filter((img) => !img.excludedBy && img.characterIds.length > 0);
  let nextImage = IMAGE_COUNT + 1;
  for (let g = 0; g < 36; g++) {
    const original = candidates[Math.floor(r() * candidates.length)]!;
    const kind: DuplicateKind = r() < 0.35 ? 'exact' : 'similar';
    const copies = 1 + (r() < 0.25 ? 1 : 0);
    const ids = [original.id];
    for (let k = 0; k < copies; k++) {
      const scale = kind === 'exact' ? 1 : pick([0.5, 0.6, 0.75]);
      const fmt: ImageFormat = kind === 'exact' ? original.format : pick(['jpeg', 'webp'] as const);
      const id = `i${nextImage++}`;
      const fileName = kind === 'exact' ? original.fileName.replace(/(\.\w+)$/, ' (1)$1') : original.fileName.replace(/\.\w+$/, fmt === 'jpeg' ? '.jpg' : '.webp');
      images.set(id, {
        ...original,
        id,
        fileName,
        relPath: `下载/${fileName}`,
        width: Math.round(original.width * scale),
        height: Math.round(original.height * scale),
        bytes: Math.round(original.bytes * scale * scale * (fmt === 'webp' ? 0.4 : 0.7)),
        format: fmt,
        addedAt: new Date(Math.min(now, Date.parse(original.addedAt) + r() * 60 * DAY)).toISOString(),
        favorite: false,
      });
      ids.push(id);
    }
    duplicates.push({
      id: `d${g + 1}`,
      kind,
      similarity: kind === 'exact' ? 1 : 0.9 + r() * 0.09,
      imageIds: ids,
      suggestedKeepId: original.id,
      resolved: false,
    });
  }

  const settings: Settings = {
    libraryRoots: [
      { id: 'root1', path: 'D:/Pictures/插画', enabled: true, imageCount: 0, lastScanAt: new Date(now - 2 * 3600_000).toISOString(), importedAt: new Date(now - 200 * DAY).toISOString() },
      { id: 'root2', path: 'E:/下载/pixiv', enabled: true, imageCount: 0, lastScanAt: new Date(now - 26 * 3600_000).toISOString(), importedAt: new Date(now - 200 * DAY).toISOString() },
    ],
    tagger: {
      model: 'A1yCE/pixai-tagger-v1.0-onnx-fp16',
      device: 'dml',
      generalThreshold: 0.35,
      characterThreshold: 0.35,
      autoAcceptThreshold: 0.85,
      batchSize: 8,
      legacyModel: 'SmilingWolf/wd-eva02-large-tagger-v3',
      legacyBefore: '2024-03-01',
      skipCameraPhotos: true,
      retryOld: false,
      keepAwake: true,
    },
    danbooru: { enabled: true, username: '', hasApiKey: false, lastSyncAt: new Date(now - 5 * DAY).toISOString() },
    dedupe: { hammingThreshold: 8, lastRunAt: new Date(now - 2 * 3600_000).toISOString() },
    ui: { theme: 'system', blurSensitive: true, density: 'comfortable' },
    browse: { customThemes: [] },
  };

  // 随机生成的文件名可能撞车；真实库里 (文件夹, 路径) 唯一，这里也保证唯一（放在最后做，不影响随机序列）
  const usedPaths = new Set<string>();
  for (const img of images.values()) {
    let n = 1;
    let fileName = img.fileName;
    while (usedPaths.has(`${img.libraryRootId}|${img.relPath.replace(/[^/]+$/, fileName)}`)) {
      fileName = img.fileName.replace(/(\.\w+)$/, ` (${++n})$1`);
    }
    img.fileName = fileName;
    img.relPath = img.relPath.replace(/[^/]+$/, fileName);
    usedPaths.add(`${img.libraryRootId}|${img.relPath}`);
  }

  const collections = new Map<ID, CollectionRow>();
  seedCollections({ images, characters, works, collections }, now);
  return { works, characters, images, duplicates, exclusions, settings, collections };
}
