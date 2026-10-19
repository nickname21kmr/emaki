# 报告叙述与数据格式

简体中文，写得平实、具体，每句话都尽量带数字或例子。不要营销腔，不要"你是一个……的人"这类空话，也不要把相关说成因果。先写出乎意料的结论，再写确认性的。每个字段都可以省略，没有文字的那一节只显示图表。

```json
{
  "date": "2026-09-29",
  "title": "一句话标题",
  "lead": "两三句：用了什么数据、和谁比、有哪些结论和直觉相反（可以用 <b>）",
  "persona": "一段画像：喜欢什么样的角色、怎么看她、怎么收图",
  "tags": [["发色", "金 / 黑"], ["性格", "高傲大小姐"]],
  "findings": [{ "h": "短标题", "b": "带数字的一两句" }],
  "sections": {
    "rhythm": { "text": "", "points": [] },
    "works": { "text": "", "points": [] },
    "looks": { "text": "", "points": [], "note": "" },
    "persona": { "text": "", "points": [], "note": "" },
    "camera": { "text": "", "points": [] },
    "loves": { "text": "", "points": [] },
    "cn": { "text": "", "points": [], "note": "" },
    "shift": { "text": "", "points": [] },
    "arcs": { "text": "", "points": [] },
    "most": { "text": "" },
    "private": { "text": "", "points": [] },
    "method": { "note": "" }
  },
  "mostIds": [123, 456],
  "summary": ["<h3>小标题</h3><p>一段</p>"]
}
```

- `findings` 数量服从证据和篇幅，只保留有解释价值的发现，不为凑条数制造结论。
- `mostIds` 可选：从 `data.mostYou` 里挑，先通过 Emaki 看一眼缩略图（`/api/images/<id>/thumb?w=480`），去掉截图、照片这类误分类的。
