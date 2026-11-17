// Names and relationships verified against publisher or creator pages.
export const verifiedWorkNames: Readonly<Record<string, readonly string[]>> = {
  'honkai:_star_rail': ['スターレイル', 'Star Rail', '崩坏星穹铁道'],
  toaru_anbu_no_item: ['とある暗部の少女共棲'],
  'seitokai_ni_mo_ana_wa_aru!': ['生徒会にも穴はある!', '生徒会にも穴はある', '生穴る'],
  kyoto_xanadu: ['亰都ザナドゥ'],
  ragnador: ['ラグナドール', 'Ragna Doll'],
  'yu-gi-oh!': ['遊戯王OCG', 'Yu-Gi-Oh! Trading Card Game'],
};

export const verifiedWorkParents: Readonly<Record<string, readonly string[]>> = {
  // https://dengekibunko.jp/product/index/322211000055.html
  toaru_anbu_no_item: ['toaru_majutsu_no_index'],
};

export const verifiedCharacterNames: Readonly<Record<string, readonly string[]>> = {
  // https://nama-anaru.com/
  kotobuki_hisako: ['古都吹寿子'],
  terui_arisu: ['照井有栖'],
  otori_tan: ['尾鳥たん'],
  // https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=20786&ope=2&request_locale=ja
  a_bao_a_qu_the_lightless_shadow: ['光なき影 ア＝バオ・ア・クゥー'],
};

export const verifiedCharacterWorks: Readonly<Record<string, readonly string[]>> = {
  kotobuki_hisako: ['seitokai_ni_mo_ana_wa_aru!'],
  terui_arisu: ['seitokai_ni_mo_ana_wa_aru!'],
  otori_tan: ['seitokai_ni_mo_ana_wa_aru!'],
  a_bao_a_qu_the_lightless_shadow: ['yu-gi-oh!'],
  'eve_(rurudo)': ['original'],
};

// Short names for original characters need the accompanying creator tag.
// https://rurudot.net/works/
export const creatorQualifiedNames = [
  { name: 'イヴちゃん', creator: 'rurudo', tag: 'eve_(rurudo)' },
] as const;
