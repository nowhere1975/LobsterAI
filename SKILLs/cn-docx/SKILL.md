---
name: 中文文档生成
description: 起草并生成中文 Word 文档（.docx）。支持正式公文（GB/T 9704-2012）和通用文档两种模式。当用户要求起草、生成、写作任何中文文档时触发，包括：通知、报告、请示、函、纪要、讲话稿、方案、工作总结等。Do NOT use when the user wants to edit, modify, comment on, or extract text from an existing .docx file — use the docx skill instead.
---

# cn-docx · 中文文档生成

## 工作方式

收到用户的文档需求后：

1. **先判断文档类型是否明确**（见下方"文档类型澄清"）
2. 判断文档类型，选择 `mode`
3. 将内容组织成结构化的 `body` 节点
4. 用 stdin 调用 `generate.js` 生成 `.docx` 文件
5. 告知用户文件保存路径

> 中文引号 `"这样写"` 直接写在 JSON 字符串里，完全没问题。

---

## 文档类型澄清

**当用户只给了一段文本，或需求描述模糊时，必须先澄清，再生成。** 不要自行猜测。

按以下顺序判断是否需要澄清：

### 1. 用途/场景不明确 → 询问用途

用户说"帮我生成 Word"、"把这段话做成文档"、"帮我写一个关于 XX 的文件"，没有说明是哪类文档，先问：

> 请问这份文档是用来做什么的？
>
> - **通知 / 通报 / 请示 / 函**（发给其他单位或部门的正式公文）
> - **报告 / 纪要 / 讲话稿 / 方案**（上报或内部使用的正式公文）
> - **工作总结 / 项目方案 / 调研报告**（个人或内部通用文档）

### 2. 文种已知，发文单位不明确 → 询问落款

确认是公文（official）后，如果用户没有提供发文单位和日期，再问：

> 请提供发文单位名称和落款日期，例如"某市应急管理局，2026年3月"。
>
> 如果是红头公文（strict 模式），还需要文号，例如"某政发〔2026〕1号"。

### 3. 内容已足够 → 直接生成，无需多问

用户已经说明文种（"帮我写一个通知"）且提供了标题、正文内容，直接生成，不用再问。

---

## 模式选择

| mode | 适用场景 | 字体风格 |
|------|---------|---------|
| `official` | 通知、报告、请示、函、纪要、讲话稿、方案 | 宋体/黑体/楷体，三号 |
| `general` | 工作总结、项目方案、调研报告等个人/内部文档 | 黑体标题，宋体正文，四号 |

---

## 调用方式（stdin JSON）

不要写临时 JS 脚本，直接用 stdin 传 JSON：

```bash
echo '{ ...JSON... }' | node {SKILL_DIR}/generate.js
```

### official 模式 - standard 示例

```bash
echo '{
  "mode": "official",
  "style": "standard",
  "docType": "tongzhi",
  "outputPath": "{OUTPUT_DIR}/通知.docx",
  "content": {
    "title": "关于××××的通知",
    "recipient": "各部门、各单位：",
    "org": "××单位",
    "date": "二〇二六年三月十五日",
    "body": [
      { "level": 0, "text": "正文段落，首行自动缩进两字。" },
      { "level": 1, "number": "一", "heading": "一级标题（黑体三号）" },
      { "level": 2, "number": "（一）", "heading": "二级标题（宋体三号加粗）" },
      { "level": 0, "text": "正文内容。" },
      { "level": 3, "number": "1.", "heading": "三级小标题", "text": "后面是同段正文。" },
      { "level": 4, "number": "（1）", "text": "四级标题，行内正文。" }
    ],
    "attachments": ["附件一名称", "附件二名称"]
  }
}' | node {SKILL_DIR}/generate.js
```

### official 模式 - strict 示例（红头公文，GB/T 9704-2012）

```bash
echo '{
  "mode": "official",
  "style": "strict",
  "docType": "tongzhi",
  "outputPath": "{OUTPUT_DIR}/红头通知.docx",
  "content": {
    "title": "关于开展安全生产大检查的通知",
    "recipient": "各县区人民政府，市直各单位：",
    "org": "某市人民政府",
    "doc_number": "某政发〔2026〕1号",
    "date": "二〇二六年三月十五日",
    "serial_number": "000001",
    "secret_level": "机密★1年",
    "urgency": "特急",
    "signers": ["张三", "李四"],
    "cc": "市安委会各成员单位",
    "print_org": "某市人民政府办公室",
    "print_date": "2026年3月15日",
    "body": [
      { "level": 0, "text": "正文内容。" }
    ],
    "attachments": ["安全生产检查表"]
  }
}' | node {SKILL_DIR}/generate.js
```

### general 模式示例

```bash
echo '{
  "mode": "general",
  "outputPath": "{OUTPUT_DIR}/工作总结.docx",
  "content": {
    "title": "2026年第一季度工作总结",
    "author": "张三",
    "org": "某部门",
    "date": "2026年3月15日",
    "body": [
      { "level": 0, "text": "总体情况说明段落。" },
      { "level": 1, "number": "一", "heading": "一级标题（黑体小三加粗）" },
      { "level": 2, "number": "（一）", "heading": "二级标题（宋体四号加粗）" },
      { "level": 0, "text": "正文内容，宋体四号，1.5倍行距。" },
      { "level": 3, "number": "1.", "heading": "三级小标题", "text": "同段正文内容。" }
    ],
    "attachments": ["附件名称"]
  }
}' | node {SKILL_DIR}/generate.js
```

### Markdown 输入模式（推荐用于 AI 生成内容）

当用户把 AI 的 Markdown 回答直接转为 Word 时，使用 `markdown` 字段替代 `body`：

```bash
echo '{
  "mode": "general",
  "outputPath": "{OUTPUT_DIR}/工作总结.docx",
  "content": {
    "title": "2026年Q1工作总结",
    "org": "某部门",
    "date": "2026年3月15日",
    "markdown": "## 一、总体情况\n\n本季度完成了各项目标。\n\n## 二、主要成果\n\n| 项目 | 完成率 |\n|------|-------|\n| 建设 | 100% |\n\n- 完成预算编制\n- 推进重点项目"
  }
}' | node {SKILL_DIR}/generate.js
```

`markdown` 字段支持的 Markdown 元素：

| 元素 | 语法 | 转换结果 |
|------|------|---------|
| 标题 | `#` / `##` / `###` | level 1 / 2 / 3 节点 |
| 表格 | `\| 列1 \| 列2 \|` + 分隔行 | `type: "table"` 三线表 |
| 无序列表 | `- 项目` 或 `* 项目` | `type: "list"` |
| 有序列表 | `1. 项目` | `type: "list"` ordered |
| 嵌套列表 | 缩进子项 | `children` 最多 3 级 |
| 段落 | 普通文本 | level 0 正文 |
| 代码块 | ` ``` ` | level 0 纯文本 |
| 引用块 | `> 内容` | level 0 正文 |
| 行内格式 | `**粗**` `*斜*` `` `代码` `` | 剥除格式符，保留文字 |

> **注意**：`markdown` 和 `body` 二选一，同时存在时 `markdown` 优先。

---

> **日期说明**：
> - official 模式默认使用汉字日期（如 `"二〇二六年三月十五日"`），可调用 `dateToChinese('2026-03-15')` 转换
> - general 模式默认使用阿拉伯数字日期（如 `"2026年3月15日"`）
> - `date` 字段直接填写最终日期字符串即可

---

## 文种（docType）

| 值 | 文种 | 需要 recipient |
|----|------|---------------|
| `tongzhi` | 通知 | ✅ |
| `tongbao` | 通报 | ✅ |
| `qingshi` | 请示 | ✅ |
| `han` | 函 | ✅ |
| `baogao` | 报告 | ❌ |
| `jiyao` | 纪要 | ❌ |
| `jianghua` | 讲话稿 | ❌ |
| `fangan` | 方案 | ❌ |

---

## style 模式

| 值 | 标题字体 | 正文字体 | 红头 | 二级标题 |
|----|---------|---------|------|---------|
| `standard` | 宋体加粗二号 | 宋体三号 | 无 | 宋体三号加粗 |
| `strict` | 方正小标宋二号 | 仿宋_GB2312三号 | 有（需 org + doc_number） | 楷体三号 |

> ⚠️ **strict 模式字体说明**：`方正小标宋简体` 和 `仿宋_GB2312` 是 Windows 系统内置字体。在 macOS/Linux 上生成的文档，若对方机器没有这两个字体，打开时会降级显示。建议仅在 Windows 环境下，或确认接收方为 Windows 时使用 strict 模式。

---

## content 字段说明

### 通用字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 文档标题 |
| `org` | string | 发文单位 / 落款单位 |
| `date` | string | 日期字符串（直接使用） |
| `body` | array | 正文节点数组 |
| `attachments` | string[] | 附件名称列表 |

### official 模式专用

| 字段 | 类型 | 说明 |
|------|------|------|
| `recipient` | string | 主送机关（如"各部门："） |
| `doc_number` | string | 发文字号（如"某政发〔2026〕1号"） |

### strict 模式专用（可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| `serial_number` | string | 份号（6位数字，如"000001"） |
| `secret_level` | string | 密级和保密期限（如"机密★1年"） |
| `urgency` | string | 紧急程度（如"特急""加急"） |
| `signers` | string[] | 签发人姓名（上行文用） |
| `cc` | string | 抄送机关 |
| `print_org` | string | 印发机关（默认同 org） |
| `print_date` | string | 印发日期（默认同 date） |

### general 模式专用

| 字段 | 类型 | 说明 |
|------|------|------|
| `author` | string | 作者（显示在标题下方） |

---

## body 节点规范

### official 模式

| level | 序号示例 | standard 字体 | strict 字体 | 格式 |
|-------|---------|--------------|------------|------|
| 0 | 无 | 宋体三号 | 仿宋三号 | 正文，首行缩进两字 |
| 1 | `一` | 黑体三号 | 黑体三号 | 独立成行，不缩进 |
| 2 | `（一）` | 宋体三号加粗 | 楷体三号 | 缩进两字 |
| 3 | `1.` | 宋体三号 | 仿宋三号 | heading 加粗 + text 不加粗，同段，缩进两字 |
| 4 | `（1）` | 宋体三号 | 仿宋三号 | 行内，缩进两字 |

### general 模式

| level | 序号示例 | 字体 | 格式 |
|-------|---------|------|------|
| 0 | 无 | 宋体四号 | 正文，首行缩进两字，1.5倍行距 |
| 1 | `一` | 黑体小三加粗 | 独立成行，段前段后间距 |
| 2 | `（一）` | 宋体四号加粗 | 缩进两字，段前段后间距 |
| 3 | `1.` | 宋体四号 | heading 加粗 + text 不加粗，同段，缩进两字 |
| 4 | `（1）` | 宋体四号 | 行内，缩进两字 |

### level 3 同段格式说明

level 3 和 level 4 支持 `heading` + `text` 分开，实现"标题加粗+正文不加粗"同段效果：

```json
{ "level": 3, "number": "1.", "heading": "加强管理。", "text": "各单位要认真落实各项管理制度。" }
```

生成效果：**1.加强管理。**各单位要认真落实各项管理制度。

如果只传 `text` 不传 `heading`，则整段加粗（向后兼容）。

> **序号说明**：`number` 字段不需要带末尾顿号，一级标题会自动补上"、"。例如传 `"一"` 而非 `"一、"`。

### 扩展节点类型（Phase 1）

除了 `level` 段落节点，body 数组还支持以下扩展类型，两种模式均可使用：

#### `type: "table"` — 表格

```json
{
  "type": "table",
  "caption": "表1 项目进度",
  "headers": ["阶段", "时间", "负责人"],
  "rows": [["需求分析", "1月", "张三"], ["开发实现", "2月", "李四"]],
  "style": "three-line",
  "widths": [40, 30, 30]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `headers` | string[] | 表头行（可选），自动加粗、灰色底色 |
| `rows` | string[][] | 数据行二维数组 |
| `style` | string | `three-line`（三线表，默认）/ `bordered`（全框线）/ `light-grid`（细网格灰线） |
| `widths` | number[] | 各列宽度百分比，如 `[30,40,30]`，不填则平均分配 |
| `caption` | string | 表格标题，显示在表格上方，居中 |

#### `type: "image"` — 图片

```json
{
  "type": "image",
  "src": "/absolute/path/to/chart.png",
  "width": 120,
  "caption": "图1 收入趋势图",
  "align": "center"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `src` | string | 本地图片绝对路径，支持 PNG / JPEG |
| `width` | number | 显示宽度（mm），不填则按原始尺寸缩放到不超过页宽 |
| `height` | number | 显示高度（mm），不填则按比例自动计算 |
| `caption` | string | 图注，显示在图片下方，居中 |
| `align` | string | `center`（默认）/ `left` / `right` |

#### `type: "list"` — 列表

```json
{
  "type": "list",
  "ordered": true,
  "items": [
    { "text": "第一项" },
    { "text": "第二项", "children": [
      { "text": "子项 A" },
      { "text": "子项 B" }
    ]}
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ordered` | boolean | `false`（无序圆点，默认）/ `true`（有序数字） |
| `items` | array | 列表项，每项有 `text` 字段；可嵌套 `children`（最多 3 级） |

#### `type: "link"` — 超链接段落

```json
{ "type": "link", "text": "国家标准全文公开系统", "url": "https://openstd.samr.gov.cn", "prefix": "参考资料：" }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | string | 链接显示文字 |
| `url` | string | 链接地址（外部 URL） |
| `prefix` | string | 链接前的普通文字（可选） |
| `suffix` | string | 链接后的普通文字（可选） |

#### `type: "pageBreak"` — 强制分页

```json
{ "type": "pageBreak" }
```

在此处强制另起一页，无其他参数。

#### `type: "divider"` — 水平分割线

```json
{ "type": "divider" }
```

渲染为灰色细线，用于章节之间的视觉分隔，无其他参数。

---

## 页眉（general 模式专用）

公文模式无页眉（符合 GB/T 9704 规范）。通用模式可在 `content` 中设置：

| 字段 | 说明 |
|------|------|
| `header` | 所有页统一页眉文字 |
| `headerOdd` | 奇数页页眉（与 `headerEven` 配合使用，优先于 `header`） |
| `headerEven` | 偶数页页眉 |

```json
{
  "mode": "general",
  "content": {
    "header": "某部门 2026年工作报告",
    ...
  }
}
```

---

## 版面规范

| | official | general |
|--|---------|---------|
| 页边距 | 上3.7 下3.5 左2.8 右2.6 cm | 上下2.54 左右3.17 cm |
| 行距 | 固定值约29pt（确保每页22行） | 1.5倍行距 |
| 页码 | `— N —` 宋体四号，单页居右空一字，双页居左空一字 | 阿拉伯数字居中 |
| 署名位置 | 右空四字 | 右对齐 |

---

## strict 模式 GB/T 9704-2012 合规说明

strict 模式严格遵循 GB/T 9704-2012 标准：

- **版头**：发文机关标志红色小标宋体，上边缘距版心上边缘 35mm；发文字号下空二行；版头分隔线红色与版心等宽
- **主体**：标题2号小标宋体，红色分隔线下空二行；主送机关标题下空一行
- **落款**：成文日期右空四字
- **版记**：自动生成抄送机关、印发机关和印发日期，含粗/细分隔线
- **页码**：奇偶页分别居右/居左
- **可选要素**：份号、密级和保密期限、紧急程度、签发人

---

## 预设风格（preset）

在顶层加 `preset` 字段，一键选定文档风格，无需手动指定 `mode`/`style`。显式传入的字段仍可覆盖 preset 默认值。

| preset | 说明 | 适用场景 |
|--------|------|---------|
| `gov` | 标准公文（standard 模式） | 通知、报告、请示 |
| `gov-strict` | 红头公文（GB/T 9704-2012 strict 模式） | 需要红头、版记的正式公文 |
| `corporate` | 企业报告，蓝色标题 | 商业报告、白皮书 |
| `academic` | 学术论文，双倍行距 | 论文、研究报告 |
| `memo` | 内部备忘录，紧凑行距 | 会议纪要、内部通知 |
| `minimal` | 极简黑白，宋体贯穿 | 合同、协议 |
| `chinese-report` | 微软雅黑标题，现代商务风 | 工作总结、项目方案 |

```bash
echo '{
  "preset": "corporate",
  "outputPath": "{OUTPUT_DIR}/商业报告.docx",
  "content": {
    "title": "2026年第一季度业务报告",
    "org": "某公司",
    "date": "2026年3月28日",
    "body": [...]
  }
}' | node {SKILL_DIR}/generate.js
```

> preset 与 mode/style 可混用：`preset: "corporate"` 设为 general 模式，但仍可加 `"mode": "official"` 覆盖。

---

## 生成报告

每次生成成功后，终端输出包含统计摘要：

```
✅ 已生成：/path/to/file.docx
   📄 估算约 3 页  ·  段落 12  ·  表格 2  ·  图片 1  ·  列表 3  ·  字符 2150
```

页数为基于字符数的估算值（公文 ~600字/页，通用 ~700字/页），仅供参考。

---

## 依赖

```bash
cd {SKILL_DIR} && npm install   # 仅需执行一次
```

Node.js ≥ 16，无其他运行时依赖。`docx` 版本已锁定，升级前务必先跑 `node test.js` 验证字体渲染正常。
