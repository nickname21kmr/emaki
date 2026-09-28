/**
 * Mock 模式用的种子数据：真实存在的作品 / 角色名和 Danbooru 标签，
 * 让前端开发时看到的界面和真实使用时尽量一致。
 *
 * weight 决定这个作品 / 角色分到多少张图（大致按 Zipf 分布）。
 */

export interface SeedWork {
  key: string;
  name: string;
  tag: string | null;
  aliases: string[];
  /** 主题色 hue（0~360） */
  hue: number;
  characters: SeedCharacter[];
}

export interface SeedCharacter {
  name: string;
  tag: string | null;
  aliases: string[];
  weight: number;
}

const c = (name: string, tag: string | null, aliases: string[], weight: number): SeedCharacter => ({
  name,
  tag,
  aliases,
  weight,
});

export const SEED_WORKS: SeedWork[] = [
  {
    key: 'ba',
    name: '蔚蓝档案',
    tag: 'blue_archive',
    aliases: ['ブルーアーカイブ', 'Blue Archive', 'BA', '碧蓝档案', 'ブルアカ'],
    hue: 205,
    characters: [
      c('圣园未花', 'mika_(blue_archive)', ['ミカ', 'mika', '未花', '聖園ミカ'], 100),
      c('美甘妮露', 'neru_(blue_archive)', ['ネル', 'neru'], 22),
      c('老师', 'sensei_(blue_archive)', ['先生', 'sensei'], 21),
      c('百合园圣娅', 'seia_(blue_archive)', ['セイア', 'seia', '圣娅'], 20),
      c('樱井美代', 'miyo_(blue_archive)', ['ミヨ', 'miyo'], 19),
      c('小鸟游星野', 'hoshino_(blue_archive)', ['ホシノ', 'hoshino', '星野'], 18),
      c('砂狼白子', 'shiroko_(blue_archive)', ['シロコ', 'shiroko', '白子'], 17),
      c('空崎日奈', 'hina_(blue_archive)', ['ヒナ', 'hina', '日奈'], 15),
      c('早濑优香', 'yuuka_(blue_archive)', ['ユウカ', 'yuuka', '优香'], 14),
      c('天童爱丽丝', 'aris_(blue_archive)', ['アリス', 'aris', 'alice', '爱丽丝'], 13),
      c('桐藤渚', 'nagisa_(blue_archive)', ['ナギサ', 'nagisa', '渚'], 11),
      c('陆八魔阿露', 'aru_(blue_archive)', ['アル', 'aru', '阿露'], 10),
      c('生盐诺亚', 'noa_(blue_archive)', ['ノア', 'noa', '诺亚'], 9),
      c('伊落玛丽', 'mari_(blue_archive)', ['マリー', 'mari', '玛丽'], 8),
      c('下江小春', 'koharu_(blue_archive)', ['コハル', 'koharu', '小春'], 7),
      c('狐坂若藻', 'wakamo_(blue_archive)', ['ワカモ', 'wakamo', '若藻'], 6),
      c('浅黄睦月', 'mutsuki_(blue_archive)', ['ムツキ', 'mutsuki', '睦月'], 5),
    ],
  },
  {
    key: 'holo',
    name: 'hololive',
    tag: 'hololive',
    aliases: ['ホロライブ', 'holo', '猴楼'],
    hue: 196,
    characters: [
      c('兔田佩克拉', 'usada_pekora', ['ぺこら', 'pekora', '佩克拉', '兔子'], 14),
      c('宝钟玛琳', 'houshou_marine', ['マリン', 'marine', '船长'], 13),
      c('白上吹雪', 'shirakami_fubuki', ['フブキ', 'fubuki', '吹雪', '白上'], 10),
      c('湊阿库娅', 'minato_aqua', ['あくあ', 'aqua', '夸哥'], 9),
      c('星街彗星', 'hoshimachi_suisei', ['すいせい', 'suisei', '彗星'], 8),
      c('猫又小粥', 'nekomata_okayu', ['おかゆ', 'okayu', '小粥'], 6),
      c('噶呜·古拉', 'gawr_gura', ['ぐら', 'gura', '鲨鲨'], 7),
    ],
  },
  {
    key: 'hsr',
    name: '崩坏：星穹铁道',
    tag: 'honkai:_star_rail',
    aliases: ['星穹铁道', '星铁', 'Honkai Star Rail', 'HSR', 'スターレイル'],
    hue: 262,
    characters: [
      c('流萤', 'firefly_(honkai:_star_rail)', ['ホタル', 'firefly', '萨姆'], 14),
      c('花火', 'sparkle_(honkai:_star_rail)', ['花火', 'sparkle', 'hanabi'], 11),
      c('黄泉', 'acheron_(honkai:_star_rail)', ['黄泉', 'acheron'], 10),
      c('三月七', 'march_7th_(honkai:_star_rail)', ['三月なのか', 'march 7th'], 8),
      c('卡芙卡', 'kafka_(honkai:_star_rail)', ['カフカ', 'kafka'], 8),
      c('银狼', 'silver_wolf_(honkai:_star_rail)', ['銀狼', 'silver wolf'], 7),
      c('知更鸟', 'robin_(honkai:_star_rail)', ['ロビン', 'robin'], 6),
      c('黑天鹅', 'black_swan_(honkai:_star_rail)', ['ブラックスワン', 'black swan'], 5),
    ],
  },
  {
    key: 'ark',
    name: '明日方舟',
    tag: 'arknights',
    aliases: ['アークナイツ', 'Arknights', '舟', '粥'],
    hue: 18,
    characters: [
      c('阿米娅', 'amiya_(arknights)', ['アーミヤ', 'amiya', '兔兔'], 12),
      c('德克萨斯', 'texas_(arknights)', ['テキサス', 'texas', '德狗'], 10),
      c('能天使', 'exusiai_(arknights)', ['エクシア', 'exusiai', '阿能'], 9),
      c('斯卡蒂', 'skadi_(arknights)', ['スカジ', 'skadi', '蒂蒂'], 8),
      c('铃兰', 'suzuran_(arknights)', ['スズラン', 'suzuran'], 7),
      c('澄闪', 'goldenglow_(arknights)', ['ゴールデングロー', 'goldenglow'], 6),
      c('陈', "ch'en_(arknights)", ['チェン', 'chen', '陈sir'], 6),
    ],
  },
  {
    key: 'gi',
    name: '原神',
    tag: 'genshin_impact',
    aliases: ['げんしん', 'Genshin Impact', '原'],
    hue: 42,
    characters: [
      c('芙宁娜', 'furina_(genshin_impact)', ['フリーナ', 'furina', '芙芙'], 12),
      c('纳西妲', 'nahida_(genshin_impact)', ['ナヒーダ', 'nahida', '草神'], 10),
      c('雷电将军', 'raiden_shogun', ['雷電将軍', 'raiden', '雷神', '影'], 9),
      c('胡桃', 'hu_tao_(genshin_impact)', ['フータオ', 'hu tao'], 8),
      c('甘雨', 'ganyu_(genshin_impact)', ['甘雨', 'ganyu'], 7),
      c('八重神子', 'yae_miko', ['八重神子', 'yae miko', '狐狸'], 7),
      c('可莉', 'klee_(genshin_impact)', ['クレー', 'klee'], 5),
    ],
  },
  {
    key: 'fate',
    name: 'Fate',
    tag: 'fate_(series)',
    aliases: ['Fate/Grand Order', 'FGO', '型月', 'フェイト'],
    hue: 350,
    characters: [
      c('玛修·基列莱特', 'mash_kyrielight', ['マシュ', 'mash', '玛修', '学妹'], 11),
      c('阿尔托莉雅', 'artoria_pendragon_(fate)', ['アルトリア', 'saber', '呆毛王'], 10),
      c('远坂凛', 'tohsaka_rin', ['遠坂凛', 'rin', '凛'], 9),
      c('间桐樱', 'matou_sakura', ['間桐桜', 'sakura', '樱'], 7),
      c('贞德', "jeanne_d'arc_(fate)", ['ジャンヌ', 'jeanne', '贞德'], 7),
      c('伊什塔尔', 'ishtar_(fate)', ['イシュタル', 'ishtar'], 5),
    ],
  },
  {
    key: 'al',
    name: '碧蓝航线',
    tag: 'azur_lane',
    aliases: ['アズールレーン', 'Azur Lane', '碧蓝', 'アズレン'],
    hue: 222,
    characters: [
      c('大凤', 'taihou_(azur_lane)', ['大鳳', 'taihou'], 9),
      c('信浓', 'shinano_(azur_lane)', ['信濃', 'shinano'], 7),
      c('贝尔法斯特', 'belfast_(azur_lane)', ['ベルファスト', 'belfast', '女仆长'], 7),
      c('爱宕', 'atago_(azur_lane)', ['愛宕', 'atago'], 5),
      c('拉菲', 'laffey_(azur_lane)', ['ラフィー', 'laffey'], 5),
    ],
  },
  {
    key: 'uma',
    name: '赛马娘',
    tag: 'umamusume',
    aliases: ['ウマ娘', 'Umamusume', '马娘', 'ウマ娘 プリティーダービー'],
    hue: 142,
    characters: [
      c('东海帝王', 'tokai_teio_(umamusume)', ['トウカイテイオー', 'teio', '帝宝'], 8),
      c('米浴', 'rice_shower_(umamusume)', ['ライスシャワー', 'rice shower'], 8),
      c('特别周', 'special_week_(umamusume)', ['スペシャルウィーク', 'special week', '特别周'], 6),
      c('无声铃鹿', 'silence_suzuka_(umamusume)', ['サイレンススズカ', 'suzuka'], 6),
      c('目白麦昆', 'mejiro_mcqueen_(umamusume)', ['メジロマックイーン', 'mcqueen', '麦昆'], 5),
    ],
  },
  {
    key: 'bocchi',
    name: '孤独摇滚！',
    tag: 'bocchi_the_rock!',
    aliases: ['ぼっち・ざ・ろっく！', 'Bocchi the Rock', '孤独摇滚', 'btr'],
    hue: 330,
    characters: [
      c('后藤一里', 'gotoh_hitori', ['後藤ひとり', 'bocchi', '波奇酱', '小孤独'], 9),
      c('喜多郁代', 'kita_ikuyo', ['喜多郁代', 'kita', '喜多'], 6),
      c('伊地知虹夏', 'ijichi_nijika', ['伊地知虹夏', 'nijika', '虹夏'], 5),
      c('山田凉', 'yamada_ryo', ['山田リョウ', 'ryo', '凉'], 5),
    ],
  },
  {
    key: 'frieren',
    name: '葬送的芙莉莲',
    tag: 'sousou_no_frieren',
    aliases: ['葬送のフリーレン', 'Frieren', '芙莉莲'],
    hue: 170,
    characters: [
      c('芙莉莲', 'frieren', ['フリーレン', 'frieren'], 8),
      c('菲伦', 'fern_(sousou_no_frieren)', ['フェルン', 'fern'], 6),
    ],
  },
  {
    key: 'voc',
    name: 'VOCALOID',
    tag: 'vocaloid',
    aliases: ['ボーカロイド', 'V家', '术力口'],
    hue: 178,
    characters: [
      c('初音未来', 'hatsune_miku', ['初音ミク', 'miku', '葱'], 10),
      c('镜音铃', 'kagamine_rin', ['鏡音リン', 'rin'], 4),
    ],
  },
  {
    key: 'original',
    name: '原创',
    tag: 'original',
    aliases: ['オリジナル', 'original', 'OC'],
    hue: 30,
    characters: [
      // 自建角色：tag 为 null。第一个在 mock 里被当作「能对上 Danbooru」的那个。
      c('雪见（自设）', null, ['yukimi', '雪见'], 4),
      c('猫耳女仆 A', null, ['maid'], 3),
      c('画师 OC · 柚', null, ['yuzu', '柚'], 3),
    ],
  },
];

/** 长尾作品：只有少量图，用来撑出作品数量和「全部作品」下拉。 */
export const LONG_TAIL_WORKS: SeedWork[] = [
  { key: 'gfl', name: '少女前线', tag: "girls'_frontline", aliases: ['少前', 'ドルフロ'], hue: 25, characters: [c('HK416', "hk416_(girls'_frontline)", ['416'], 3)] },
  { key: 'shiny', name: '偶像大师 闪耀色彩', tag: 'idolmaster_shiny_colors', aliases: ['シャニマス', '闪耀色彩'], hue: 300, characters: [c('樋口圆香', 'higuchi_madoka', ['円香', 'madoka'], 3)] },
  { key: 'lyco', name: '莉可丽丝', tag: 'lycoris_recoil', aliases: ['リコリス・リコイル', 'リコリコ'], hue: 0, characters: [c('锦木千束', 'nishikigi_chisato', ['千束', 'chisato'], 3), c('井之上泷奈', 'inoue_takina', ['たきな', 'takina'], 2)] },
  { key: 'spy', name: '间谍过家家', tag: 'spy_x_family', aliases: ['SPY×FAMILY', '间谍家家酒'], hue: 320, characters: [c('阿尼亚', 'anya_(spy_x_family)', ['アーニャ', 'anya'], 2), c('约尔', 'yor_briar', ['ヨル', 'yor'], 2)] },
  { key: 'touhou', name: '东方Project', tag: 'touhou', aliases: ['東方', '车万'], hue: 5, characters: [c('博丽灵梦', 'hakurei_reimu', ['霊夢', 'reimu', '灵梦'], 2), c('雾雨魔理沙', 'kirisame_marisa', ['魔理沙', 'marisa'], 2)] },
  { key: 'gakumas', name: '学园偶像大师', tag: 'gakuen_idolmaster', aliases: ['学マス', '学马'], hue: 45, characters: [c('花海咲季', 'hanami_saki', ['咲季', 'saki'], 2)] },
  { key: 'zzz', name: '绝区零', tag: 'zenless_zone_zero', aliases: ['ゼンゼロ', 'ZZZ'], hue: 60, characters: [c('艾莲', 'ellen_joe', ['エレン', 'ellen'], 2)] },
  { key: 'ww', name: '鸣潮', tag: 'wuthering_waves', aliases: ['鳴潮', 'Wuthering Waves'], hue: 190, characters: [c('今汐', 'jinhsi_(wuthering_waves)', ['今汐', 'jinhsi'], 2)] },
  { key: 'nikke', name: '胜利女神：妮姬', tag: 'goddess_of_victory:_nikke', aliases: ['NIKKE', '妮姬'], hue: 355, characters: [c('拉毗', 'rapi_(nikke)', ['ラピ', 'rapi'], 2)] },
  { key: 'oshi', name: '我推的孩子', tag: 'oshi_no_ko', aliases: ['推しの子', '【推しの子】'], hue: 280, characters: [c('星野爱', 'hoshino_ai_(oshi_no_ko)', ['アイ', 'ai'], 2)] },
  { key: 'csm', name: '电锯人', tag: 'chainsaw_man', aliases: ['チェンソーマン', '链锯人'], hue: 12, characters: [c('玛奇玛', 'makima_(chainsaw_man)', ['マキマ', 'makima'], 2), c('帕瓦', 'power_(chainsaw_man)', ['パワー', 'power'], 2)] },
];

/** 生成图片标签时用的通用标签池。 */
export const GENERAL_TAGS = [
  '1girl', 'solo', 'long_hair', 'looking_at_viewer', 'smile', 'blush', 'open_mouth', 'bangs',
  'short_hair', 'simple_background', 'white_background', 'halo', 'wings', 'dress', 'school_uniform',
  'hair_ornament', 'hair_ribbon', 'twintails', 'ponytail', 'animal_ears', 'hat', 'gloves',
  'upper_body', 'full_body', 'cowboy_shot', 'outdoors', 'sky', 'cloud', 'flower', 'petals',
  'holding', 'hand_up', 'v', 'closed_eyes', 'one_eye_closed', 'from_side', 'from_above',
  'star_(symbol)', 'heart', 'food', 'cup', 'night', 'sunset', 'water', 'beach', 'swimsuit',
  'bikini', 'kimono', 'maid', 'jacket', 'hoodie', 'thighhighs', 'pleated_skirt', 'bow',
];

export const ARTISTS = [
  'mignon', 'ask_(askzy)', 'rella', 'mika_pikazo', 'fuzichoco', 'tiv', 'kantoku', 'hiten',
  'lm7_(op-center)', 'ningen_mame', 'swav', 'void_0', 'yuzuki_gao', 'rurudo', 'neco',
];
