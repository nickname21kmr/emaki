import type { UnrecognizedAnnexKind, UnrecognizedTheme } from '@emaki/shared';

/**
 * 「没认出」按画面主题分组（T34b）：组名、一句话说明、怎么分进来的，以及处理小贴士。
 * 规则本身在服务端 services/classify/theme.ts，这里只是讲给用户听。
 */
export const THEME_META: Record<UnrecognizedTheme, { label: string; hint: string; rule: string; tip?: string }> = {
  legs: {
    label: '腿·足',
    hint: '丝袜、赤足、腿部特写',
    rule: '识别标签里有 thighhighs、pantyhose 这类腿部服饰（≥ 0.7，半身像除外），或 feet、barefoot、腿部特写。',
  },
  chest: { label: '胸', hint: '乳沟、胸部特写', rule: 'cleavage、breast_focus、sideboob 等 ≥ 0.6，或 large_breasts ≥ 0.8。' },
  nsfw: {
    label: '敏感',
    hint: '较敏感、限制级',
    rule: '分级是「较敏感」或「限制级」的都在这里，不管画的是什么。',
    tip: '开着模糊时这一组全部模糊，按 B 临时显示。',
  },
  swim: { label: '泳装', hint: '泳衣、比基尼', rule: 'swimsuit、bikini 等 ≥ 0.6。' },
  kemono: { label: '兽耳', hint: '猫耳、兔耳、狐耳', rule: 'animal_ears、cat_ears、rabbit_ears 等 ≥ 0.7。' },
  costume: { label: '女仆·和服', hint: '女仆装、和服、巫女', rule: 'maid、maid_headdress、kimono、miko、yukata 等 ≥ 0.7。' },
  multi: {
    label: '多人',
    hint: '两人以上、合影',
    rule: 'multiple_girls、2girls 等 ≥ 0.6，或同时有 1girl 和 1boy。',
    tip: '归到一个角色后这张就离开未识别，另一位之后可以在看图器里补。',
  },
  other: { label: '其他', hint: '单人、日常', rule: '识别过、上面都不像的插画。' },
  comic: {
    label: '漫画',
    hint: '合集外的散页',
    rule: '内容分类判成漫画、又不在任何合集里的页（识没识别都算）。成本的本子在「成册」里整本处理。',
  },
  odd: {
    label: '不像插画',
    hint: '照片、图标、梗图，多半该改类型',
    rule: '没有人物（no_humans ≥ 0.6），或画面质量分很低（截图、文字、照片的特征），或真人男性梗图。',
    tip: '全选后按 C 改成照片、文字或截图，它们会移到别册。',
  },
};

export const PRECEDENCE_NOTE = '一张图只放一组：先认漫画、不像插画、敏感，再看多人、泳装、兽耳、女仆·和服，最后才是腿·足、胸。';

export const ANNEX_HINT: Record<UnrecognizedAnnexKind, string> = {
  screenshot: '手机电脑截屏、视频截图',
  text: '文档、笔记、满屏文字',
  photo: '相机拍的照片、真人、实物',
  meme: '表情、梗图',
  animated: 'GIF 动图',
};

export const ORDER_NOTE = {
  theme: '越像插画越靠前',
  comic: '插画感强的在前',
  annex: '最新入库在前',
  shelved: '最近放下的在前',
} as const;

/** 目次里的汉字序号 */
export const CJK_NO = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
