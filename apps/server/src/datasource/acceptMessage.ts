/** 采纳建议的提示（mock / sqlite 共用）：一条时和以前一样；多条时列出名字，新建了角色再补一句 */
export function acceptMessage(names: string[], created: number): string {
  const list = [...new Set(names)].map((n) => `「${n}」`).join('');
  if (names.length === 1) return created ? `已新建角色${list}并归入` : `已归到${list}`;
  return created ? `已归到${list}，新建了 ${created} 个角色` : `已归到${list}`;
}
