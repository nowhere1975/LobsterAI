#!/usr/bin/env node
/**
 * cn-docx: 中文文档生成脚本（Node.js 版）
 *
 * 支持两种模式：
 *   official  - 正式公文（GB/T 9704-2012，standard/strict）
 *   general   - 通用文档（工作总结、项目方案等）
 *
 * 依赖：npm install docx
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const {
  Document, Packer, Paragraph, TextRun, Footer, Header,
  AlignmentType, PageOrientation, BorderStyle,
  convertInchesToTwip, PageNumber,
  TabStopPosition, TabStopType,
  // Phase 1: 表格、图片、列表
  Table, TableRow, TableCell, WidthType, ShadingType,
  ImageRun,
  LevelFormat,
  // Phase 2: 超链接
  ExternalHyperlink,
} = require("docx");

// ─────────────────────────────────────────────
// 字体常量
// ─────────────────────────────────────────────

const F = {
  fangsong : "仿宋_GB2312",
  heiti    : "黑体",
  kaiti    : "楷体_GB2312",
  songti   : "宋体",
  biaosong : "方正小标宋简体",
  western  : "Times New Roman",
};

// ─────────────────────────────────────────────
// 版式配置
// ─────────────────────────────────────────────

const CM = (n) => Math.round(n * 567);
const PT = (n) => n * 20;  // points → twips
const MM = (n) => Math.round(n * 56.7); // mm → twips

// 页面可用宽度（DXA）= A4宽(11906) - 左边距 - 右边距
const USABLE_DXA = {
  official: 8844,  // 11906 - CM(2.8)[1588] - CM(2.6)[1474]
  general:  8312,  // 11906 - CM(3.17)[1797] - CM(3.17)[1797]
};

// GB/T 9704-2012：版心 156mm×225mm，天头 37mm，订口 28mm
// 一行 = 3号字高度(16pt ≈ 5.64mm) + 行距(7/8 × 5.64mm ≈ 4.94mm) ≈ 10.23mm
// 22行 × 10.23mm ≈ 225mm
const LINE_HEIGHT_PT = 28.95; // 固定行距，保证每页22行（225mm / 22 ≈ 10.23mm ≈ 29pt）

const LAYOUT = {
  // 正式公文（GB/T 9704-2012）
  official: {
    margin      : { top: CM(3.7), bottom: CM(3.5), left: CM(2.8), right: CM(2.6) },
    titleSizePt : 22,   // 二号
    h1SizePt    : 16,   // 三号
    h2SizePt    : 16,
    h3SizePt    : 16,
    bodySizePt  : 16,
    lineSpacingFixed : LINE_HEIGHT_PT, // 固定行距
    footerStyle : "chinese",   // 页码：— N —
  },
  // 通用文档（工作总结、项目方案等）
  general: {
    margin      : { top: CM(2.54), bottom: CM(2.54), left: CM(3.17), right: CM(3.17) },
    titleSizePt : 18,   // 小二
    h1SizePt    : 15,   // 小三
    h2SizePt    : 14,   // 四号（加粗）
    h3SizePt    : 14,   // 四号
    bodySizePt  : 14,   // 四号
    lineSpacingMultiple : 1.5,  // 1.5倍行距
    footerStyle : "arabic",    // 页码：1
  },
};

// ─────────────────────────────────────────────
// Phase 3：预设风格配方
// preset 提供 mode/style 默认值及外观覆盖，用户仍可通过显式字段覆盖
// ─────────────────────────────────────────────

const PRESETS = {
  // 政府公文（standard 红头公文请用 gov-strict）
  gov: {
    mode: "official", style: "standard",
  },
  "gov-strict": {
    mode: "official", style: "strict",
  },
  // 企业报告：蓝色标题，适合商业报告/白皮书
  corporate: {
    mode: "general",
    titleColor: "2E75B6",
    h1Color:    "2E75B6",
    h2Color:    "2E75B6",
  },
  // 学术论文：双倍行距，适合研究报告/论文
  academic: {
    mode: "general",
    lineSpacingMultiple: 2.0,
  },
  // 内部备忘录：紧凑行距，适合会议纪要/内部通知
  memo: {
    mode: "general",
    lineSpacingMultiple: 1.2,
    marginOverride: { top: CM(2.0), bottom: CM(2.0), left: CM(2.5), right: CM(2.5) },
  },
  // 极简打印：宋体贯穿，适合合同/协议
  minimal: {
    mode: "general",
    lineSpacingMultiple: 1.2,
    h1Font: "宋体",
    titleFont: "宋体",
  },
  // 中文通用报告：微软雅黑标题，现代商务风格
  "chinese-report": {
    mode: "general",
    h1Font: "微软雅黑",
    titleFont: "微软雅黑",
  },
};

// ─────────────────────────────────────────────
// 辅助：中文字体 TextRun
// WPS 要求 ascii/hAnsi/eastAsia/cs 全部设为中文字体名才能正确渲染
// ─────────────────────────────────────────────

function cnRun({ text, cnFont, sizePt, bold = false, color }) {
  const run = new TextRun({
    text,
    font: { name: cnFont, eastAsia: cnFont, hint: "eastAsia" },
    size: sizePt * 2,
    bold,
    color,
  });
  // patch：docx 库 bug，eastAsia 实际被设成 name 的值，需直接修改内部对象
  try {
    run.root[0].root[0].root[0].root.eastAsia.value = cnFont;
    if (run.root[0].root[0].root[0].root.cs) {
      run.root[0].root[0].root[0].root.cs.value = cnFont;
    }
  } catch (e) { /* 静默跳过 */ }
  return run;
}

// ─────────────────────────────────────────────
// 辅助：构建 Paragraph
// ─────────────────────────────────────────────

function makePara({ runs = [], alignment = AlignmentType.BOTH,
                    firstLineIndentTwips = 0,
                    rightIndentTwips = 0,
                    spaceBefore = 0, spaceAfter = 0,
                    lineSpacingFixed = null,
                    lineSpacingMultiple = null,
                    border } = {}) {
  const spacing = { before: spaceBefore, after: spaceAfter };
  if (lineSpacingFixed) {
    spacing.line     = Math.round(lineSpacingFixed * 20);
    spacing.lineRule = "exact";
  } else if (lineSpacingMultiple) {
    spacing.line     = Math.round(lineSpacingMultiple * 240);
    spacing.lineRule = "auto";
  }
  const indent = {};
  if (firstLineIndentTwips) indent.firstLine = firstLineIndentTwips;
  if (rightIndentTwips) indent.right = rightIndentTwips;
  return new Paragraph({
    alignment,
    children: runs,
    spacing,
    indent : (indent.firstLine || indent.right) ? indent : undefined,
    border,
  });
}

// ─────────────────────────────────────────────
// 辅助：汉字日期
// ─────────────────────────────────────────────

function dateToChinese(dateStr) {
  const digitMap = { "0":"〇","1":"一","2":"二","3":"三","4":"四",
                     "5":"五","6":"六","7":"七","8":"八","9":"九" };
  const cnNum = ["","一","二","三","四","五","六","七","八","九","十",
    "十一","十二","十三","十四","十五","十六","十七","十八","十九",
    "二十","二十一","二十二","二十三","二十四","二十五","二十六",
    "二十七","二十八","二十九","三十","三十一"];
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const yearCn = String(y).split("").map(c => digitMap[c]).join("");
    return `${yearCn}年${cnNum[m]}月${cnNum[d]}日`;
  } catch { return dateStr; }
}

// ─────────────────────────────────────────────
// 辅助：阿拉伯数字日期（月日不编虚位）
// ─────────────────────────────────────────────

function dateToArabic(dateStr) {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    return `${y}年${m}月${d}日`;
  } catch { return dateStr; }
}

// ─────────────────────────────────────────────
// 辅助：清理序号末尾顿号，防止重复
// ─────────────────────────────────────────────

function joinNumberHeading(number, heading, sep = "、") {
  if (!number) return heading || "";
  const trimmed = number.replace(/[、，,]\s*$/, "");
  return heading ? `${trimmed}${sep}${heading}` : `${trimmed}${sep}`;
}

// ─────────────────────────────────────────────
// 页脚
// ─────────────────────────────────────────────

function makeFooters(style) {
  if (style === "chinese") {
    // GB/T 9704-2012 §7.5：4号半角宋体阿拉伯数字
    // 数字左右各放一条一字线（—）
    // 单页码居右空一字，双页码居左空一字
    const makePageNumPara = (alignment, paddingSide) => {
      const children = [
        cnRun({ text: "— ", cnFont: F.songti, sizePt: 14 }),
        new TextRun({ children: [PageNumber.CURRENT],
          font: { name: F.songti, eastAsia: F.songti }, size: 28 }),
        cnRun({ text: " —", cnFont: F.songti, sizePt: 14 }),
      ];
      const indent = {};
      if (paddingSide === "right") indent.right = PT(16); // 右空一字
      if (paddingSide === "left") indent.firstLine = PT(16); // 左空一字
      return new Paragraph({
        alignment,
        children,
        indent: (indent.right || indent.firstLine) ? indent : undefined,
      });
    };

    return {
      default: new Footer({ children: [makePageNumPara(AlignmentType.RIGHT, "right")] }),  // 奇数页（单页码）居右空一字
      even   : new Footer({ children: [makePageNumPara(AlignmentType.LEFT, "left")] }),     // 偶数页（双页码）居左空一字
    };
  } else {
    // 通用文档页脚：阿拉伯数字居中
    const para = new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ children: [PageNumber.CURRENT],
          font: { name: F.songti, eastAsia: F.songti }, size: 24 }),
      ],
    });
    return {
      default: new Footer({ children: [para] }),
    };
  }
}

// ─────────────────────────────────────────────
// Phase 1：辅助 — 提取图片像素尺寸（PNG / JPEG，无需外部依赖）
// ─────────────────────────────────────────────

function getImageDimensions(buf) {
  // PNG：magic bytes 89 50 4E 47，宽高在 offset 16/20
  if (buf.length > 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG：SOF 段（0xFF 0xCx，排除 C4/C8/CC）
  if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const marker = buf[i + 1];
      const segLen  = buf.readUInt16BE(i + 2);
      if (marker >= 0xC0 && marker <= 0xCF &&
          marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + segLen;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Phase 1：表格渲染
// 支持三种样式：three-line（三线表，默认）/ bordered（全框线）/ light-grid（细网格）
// ─────────────────────────────────────────────

function renderTable(node, ctx) {
  const { usableDxa, bodySizePt, cnFont, lineSpacingFixed, lineSpacingMultiple } = ctx;
  const { caption, headers = [], rows = [], style = "three-line", widths } = node;
  const items = [];

  // 表格标题（上方，居中）
  if (caption) {
    items.push(makePara({
      runs: [cnRun({ text: caption, cnFont, sizePt: bodySizePt })],
      alignment: AlignmentType.CENTER,
      spaceAfter: 60,
    }));
  }

  const allRows = headers.length > 0 ? [headers, ...rows] : rows;
  const colCount = allRows.reduce((max, r) => Math.max(max, r.length), 0);
  if (colCount === 0) return items;

  // 列宽计算（DXA）
  let colWidths;
  if (widths && widths.length >= colCount) {
    const totalPct = widths.slice(0, colCount).reduce((s, w) => s + w, 0);
    colWidths = widths.slice(0, colCount).map(w => Math.round(w / totalPct * usableDxa));
  } else {
    const perCol = Math.floor(usableDxa / colCount);
    colWidths = Array(colCount).fill(perCol);
  }
  // 末列补齐，确保总宽 = 可用宽度
  const widthSum = colWidths.reduce((s, w) => s + w, 0);
  colWidths[colWidths.length - 1] += (usableDxa - widthSum);

  // 边框定义
  const BNONE   = { style: "none",   size: 0,  color: "auto"   };
  const BTHICK  = { style: "single", size: 12, color: "000000" }; // 1.5pt
  const BMEDIUM = { style: "single", size: 8,  color: "000000" }; // 1pt
  const BTHIN   = { style: "single", size: 4,  color: "000000" }; // 0.5pt
  const BLIGHT  = { style: "single", size: 4,  color: "AAAAAA" }; // 0.5pt 灰

  function getCellBorders(isHeader, isLastRow) {
    if (style === "bordered")   return { top: BTHIN,  bottom: BTHIN,  left: BTHIN,  right: BTHIN  };
    if (style === "light-grid") return { top: BLIGHT, bottom: BLIGHT, left: BLIGHT, right: BLIGHT };
    // three-line（默认）
    if (isHeader)   return { top: BTHICK,  bottom: BMEDIUM, left: BNONE, right: BNONE };
    if (isLastRow)  return { top: BNONE,   bottom: BTHICK,  left: BNONE, right: BNONE };
    return { top: BNONE, bottom: BNONE, left: BNONE, right: BNONE };
  }

  const tableRows = allRows.map((row, rowIdx) => {
    const isHeader  = headers.length > 0 && rowIdx === 0;
    const isLastRow = rowIdx === allRows.length - 1;
    const cells = Array.from({ length: colCount }, (_, colIdx) => {
      const cellText = String(row[colIdx] ?? "");
      return new TableCell({
        width  : { size: colWidths[colIdx], type: WidthType.DXA },
        borders: getCellBorders(isHeader, isLastRow),
        shading: isHeader ? { fill: "F2F2F2", type: ShadingType.CLEAR } : undefined,
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children : [cnRun({ text: cellText, cnFont, sizePt: bodySizePt, bold: isHeader })],
        })],
      });
    });
    return new TableRow({ tableHeader: isHeader, children: cells });
  });

  items.push(new Table({
    width      : { size: usableDxa, type: WidthType.DXA },
    columnWidths: colWidths,
    margins    : { top: 80, bottom: 80, left: 100, right: 100 },
    rows       : tableRows,
  }));

  // 表格后间距
  items.push(makePara({
    runs     : [],
    spaceAfter: lineSpacingFixed ? Math.round(lineSpacingFixed * 10) : 80,
    lineSpacingFixed,
    lineSpacingMultiple,
  }));

  return items;
}

// ─────────────────────────────────────────────
// Phase 1：图片渲染
// ─────────────────────────────────────────────

function renderImage(node, ctx) {
  const { usableDxa, bodySizePt, cnFont, lineSpacingFixed, lineSpacingMultiple } = ctx;
  const { src, width: widthMm, height: heightMm, caption, align = "center" } = node;
  const items = [];

  if (!src) return items;

  let imgBuf;
  try {
    imgBuf = fs.readFileSync(src);
  } catch {
    items.push(makePara({
      runs: [cnRun({ text: `[图片加载失败：${src}]`, cnFont, sizePt: bodySizePt, color: "888888" })],
    }));
    return items;
  }

  const usableMm  = usableDxa * 25.4 / 1440;  // 可用宽度（mm）
  const PX_PER_MM = 96 / 25.4;                 // 96 DPI
  const dims      = getImageDimensions(imgBuf);

  let displayW, displayH;
  if (widthMm) {
    const actualMm = Math.min(widthMm, usableMm);
    displayW = Math.round(actualMm * PX_PER_MM);
    displayH = heightMm
      ? Math.round(heightMm * PX_PER_MM)
      : dims ? Math.round(displayW * dims.h / dims.w) : Math.round(displayW * 0.75);
  } else if (dims) {
    const naturalMm = dims.w / PX_PER_MM;
    const finalMm   = Math.min(naturalMm, usableMm);
    displayW = Math.round(finalMm * PX_PER_MM);
    displayH = Math.round(displayW * dims.h / dims.w);
  } else {
    displayW = Math.round(usableMm * 0.7 * PX_PER_MM);
    displayH = Math.round(displayW * 0.75);
  }

  const ext   = path.extname(src).toLowerCase().slice(1);
  const itype = { jpg: "jpg", jpeg: "jpg", png: "png", gif: "gif", bmp: "bmp" }[ext] || "png";
  const al    = { center: AlignmentType.CENTER, left: AlignmentType.LEFT, right: AlignmentType.RIGHT }[align]
                ?? AlignmentType.CENTER;

  items.push(new Paragraph({
    alignment: al,
    spacing  : { before: 80, after: 40 },
    children : [new ImageRun({ data: imgBuf, transformation: { width: displayW, height: displayH }, type: itype })],
  }));

  if (caption) {
    items.push(makePara({
      runs: [cnRun({ text: caption, cnFont, sizePt: bodySizePt - 1 })],
      alignment: AlignmentType.CENTER,
      spaceAfter: 80,
      lineSpacingFixed,
      lineSpacingMultiple,
    }));
  }

  return items;
}

// ─────────────────────────────────────────────
// Phase 1：列表渲染（有序 / 无序，最多 3 级嵌套）
// ─────────────────────────────────────────────

function renderList(node, ctx) {
  const { bodySizePt, cnFont, lineSpacingFixed, lineSpacingMultiple } = ctx;
  const { ordered = false, items = [] } = node;
  const ref = ordered ? "cn-numbered" : "cn-bullet";
  const paras = [];

  function renderItems(itemList, depth) {
    for (const item of itemList) {
      const spacing = {};
      if (lineSpacingFixed) {
        spacing.line     = Math.round(lineSpacingFixed * 20);
        spacing.lineRule = "exact";
      } else if (lineSpacingMultiple) {
        spacing.line     = Math.round(lineSpacingMultiple * 240);
        spacing.lineRule = "auto";
      }
      paras.push(new Paragraph({
        numbering: { reference: ref, level: depth },
        children : [cnRun({ text: item.text || "", cnFont, sizePt: bodySizePt })],
        spacing,
      }));
      if (item.children && item.children.length > 0) {
        renderItems(item.children, depth + 1);
      }
    }
  }

  renderItems(items, 0);
  return paras;
}

// ─────────────────────────────────────────────
// Phase 1：文档级列表编号配置（供 Document 构造函数使用）
// ─────────────────────────────────────────────

function makeNumberingConfig(bodySizePt, cnFont) {
  const makeLevels = (isBullet) =>
    [0, 1, 2].map(lvl => ({
      level : lvl,
      format: isBullet ? LevelFormat.BULLET : LevelFormat.DECIMAL,
      text  : isBullet ? "\u2022" : `%${lvl + 1}.`,
      alignment: AlignmentType.LEFT,
      style: {
        run      : { font: { name: cnFont, eastAsia: cnFont }, size: bodySizePt * 2 },
        paragraph: { indent: { left: 360 + 360 * lvl, hanging: 260 } },
      },
    }));
  return [
    { reference: "cn-bullet",   levels: makeLevels(true)  },
    { reference: "cn-numbered", levels: makeLevels(false) },
  ];
}

// ─────────────────────────────────────────────
// Phase 2：分页符
// ─────────────────────────────────────────────

function renderPageBreak() {
  return [new Paragraph({ pageBreakBefore: true, children: [] })];
}

// ─────────────────────────────────────────────
// Phase 2：水平分割线
// ─────────────────────────────────────────────

function renderDivider() {
  return [new Paragraph({
    spacing: { before: 80, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA", space: 1 } },
    children: [],
  })];
}

// ─────────────────────────────────────────────
// Phase 2：超链接段落
// node: { type:"link", text, url, prefix?, suffix? }
// ─────────────────────────────────────────────

function renderLink(node, ctx) {
  const { bodySizePt, cnFont, lineSpacingFixed, lineSpacingMultiple } = ctx;
  const { text = "", url = "", prefix = "", suffix = "" } = node;

  const children = [];
  if (prefix) children.push(cnRun({ text: prefix, cnFont, sizePt: bodySizePt }));
  children.push(new ExternalHyperlink({
    link: url,
    children: [new TextRun({
      text,
      style: "Hyperlink",
      font: { name: cnFont, eastAsia: cnFont, cs: cnFont },
      size: bodySizePt * 2,
    })],
  }));
  if (suffix) children.push(cnRun({ text: suffix, cnFont, sizePt: bodySizePt }));

  const spacing = {};
  if (lineSpacingFixed)    { spacing.line = Math.round(lineSpacingFixed * 20); spacing.lineRule = "exact"; }
  else if (lineSpacingMultiple) { spacing.line = Math.round(lineSpacingMultiple * 240); spacing.lineRule = "auto"; }

  return [new Paragraph({ children, spacing })];
}

// ─────────────────────────────────────────────
// Phase 2：自定义页眉（仅 general 模式）
// ─────────────────────────────────────────────

function makeHeaders(headerText, headerOdd, headerEven, bodySizePt, cnFont) {
  const odd  = headerOdd  || headerText || "";
  const even = headerEven || headerText || "";
  if (!odd && !even) return null;

  const makeHeaderPara = (text) => new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA", space: 1 } },
    spacing: { after: 0 },
    children: [cnRun({ text, cnFont, sizePt: Math.max(bodySizePt - 2, 10) })],
  });

  if (headerOdd || headerEven) {
    // 奇偶页不同
    return {
      default: new Header({ children: [makeHeaderPara(odd)] }),
      even   : new Header({ children: [makeHeaderPara(even)] }),
    };
  }
  return {
    default: new Header({ children: [makeHeaderPara(odd)] }),
  };
}

// ─────────────────────────────────────────────
// Markdown 预处理：将 MD 字符串转为 body 节点数组
// 支持：标题(#~###)、表格、无序/有序列表、段落、代码块、引用块
// 行内格式（**bold** *italic* `code` [link]()）统一剥除为纯文本
// ─────────────────────────────────────────────

function stripInlineMarkdown(text) {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1")
    .trim();
}

function parseMarkdownTableLines(lines) {
  const isSep = l => /^\|[\s\-:|]+\|$/.test(l.trim());
  const parseRow = l =>
    l.trim().replace(/^\||\|$/g, "").split("|")
      .map(c => stripInlineMarkdown(c.trim()));

  const contentLines = lines.filter(l => !isSep(l));
  if (contentLines.length === 0) return null;

  const allRows = contentLines.map(parseRow);
  const hasHeader = lines.length > 1 && isSep(lines[1]);

  if (hasHeader) {
    return { type: "table", headers: allRows[0], rows: allRows.slice(1), style: "three-line" };
  }
  return { type: "table", rows: allRows, style: "three-line" };
}

function parseMarkdownListBlock(lines, startI) {
  const firstLine = lines[startI];
  const ordered = /^\s*\d+[.)]\s/.test(firstLine);
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)/;
  const baseIndent = (firstLine.match(/^(\s*)/) || ["", ""])[1].length;

  function collectLevel(i, minIndent) {
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; break; }
      const m = line.match(listRe);
      if (!m) break;
      const indent = m[1].length;
      if (indent < minIndent) break;
      if (indent > minIndent) break; // child — handled by parent

      const item = { text: stripInlineMarkdown(m[3]) };
      i++;

      // Check next lines for children (deeper indent)
      if (i < lines.length) {
        const nm = lines[i].match(listRe);
        if (nm && nm[1].length > indent) {
          const { items: children, newI } = collectLevel(i, nm[1].length);
          if (children.length > 0) item.children = children;
          i = newI;
        }
      }
      items.push(item);
    }
    return { items, newI: i };
  }

  const { items, newI } = collectLevel(startI, baseIndent);
  return { node: { type: "list", ordered, items }, newI };
}

function parseMarkdown(md) {
  const lines = md.split("\n");
  const body  = [];
  let i = 0;

  while (i < lines.length) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // ATX 标题 #~######
    const hm = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (hm) {
      const depth = hm[1].length;
      const text  = stripInlineMarkdown(hm[2]);
      if (depth <= 3) {
        body.push({ level: depth, heading: text });
      } else {
        body.push({ level: 0, text });   // h4-h6 降级为正文段落
      }
      i++; continue;
    }

    // 水平分隔线
    if (/^[-*_]{3,}$/.test(trimmed)) { i++; continue; }

    // 代码块 ``` 或 ~~~
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const fence = trimmed.slice(0, 3);
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]); i++;
      }
      i++; // 跳过闭合 fence
      if (codeLines.length > 0) {
        body.push({ level: 0, text: codeLines.join("\n") });
      }
      continue;
    }

    // 引用块 >
    if (trimmed.startsWith(">")) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(lines[i].trim().replace(/^>\s?/, "")); i++;
      }
      body.push({ level: 0, text: stripInlineMarkdown(qLines.join(" ")) });
      continue;
    }

    // 表格 |...|
    if (trimmed.startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]); i++;
      }
      const tnode = parseMarkdownTableLines(tableLines);
      if (tnode) body.push(tnode);
      continue;
    }

    // 列表（无序 / 有序）
    if (/^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      const { node, newI } = parseMarkdownListBlock(lines, i);
      body.push(node);
      i = newI;
      continue;
    }

    // 普通段落：合并到空行或结构元素为止
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i], t = l.trim();
      if (!t) break;
      if (/^#{1,6}\s/.test(t) || t.startsWith("|") ||
          t.startsWith("```") || t.startsWith("~~~") ||
          /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t) ||
          /^[-*_]{3,}$/.test(t)) break;
      paraLines.push(l); i++;
    }
    if (paraLines.length > 0) {
      body.push({ level: 0, text: stripInlineMarkdown(paraLines.join(" ")) });
    }
  }

  return body;
}

// ─────────────────────────────────────────────
// 正文渲染（公文模式）
// ─────────────────────────────────────────────

function renderBodyOfficial(body, bodyFont, lineSpacingFixed, isStandard, ctx) {
  const INDENT = PT(32);  // 首行缩进两字（三号16pt×2=32pt）
  const paras = [];
  // standard 模式下二级标题用宋体加粗；strict 模式用楷体
  const h2Font = isStandard ? F.songti : F.kaiti;
  const h2Bold = isStandard;

  for (const node of body) {
    if (ctx) {
      if (node.type === "table")     { paras.push(...renderTable(node, ctx));  continue; }
      if (node.type === "image")     { paras.push(...renderImage(node, ctx));  continue; }
      if (node.type === "list")      { paras.push(...renderList(node, ctx));   continue; }
      if (node.type === "pageBreak") { paras.push(...renderPageBreak());        continue; }
      if (node.type === "divider")   { paras.push(...renderDivider());          continue; }
      if (node.type === "link")      { paras.push(...renderLink(node, ctx));   continue; }
    }
    const { level = 0, number = "", heading, text = "" } = node;

    if (level === 0) {
      paras.push(makePara({
        runs: [cnRun({ text, cnFont: bodyFont, sizePt: 16 })],
        firstLineIndentTwips: INDENT,
        lineSpacingFixed,
      }));
    } else if (level === 1) {
      // 一级标题：黑体三号，独立成行，不缩进
      paras.push(makePara({
        runs: [cnRun({ text: joinNumberHeading(number, heading, "、"), cnFont: F.heiti, sizePt: 16 })],
        lineSpacingFixed,
      }));
      if (text) paras.push(makePara({
        runs: [cnRun({ text, cnFont: bodyFont, sizePt: 16 })],
        firstLineIndentTwips: INDENT,
        lineSpacingFixed,
      }));
    } else if (level === 2) {
      // 二级标题：strict=楷体三号, standard=宋体三号加粗
      paras.push(makePara({
        runs: [cnRun({ text: heading ? `${number}${heading}` : number, cnFont: h2Font, sizePt: 16, bold: h2Bold })],
        firstLineIndentTwips: INDENT,
        lineSpacingFixed,
      }));
      if (text) paras.push(makePara({
        runs: [cnRun({ text, cnFont: bodyFont, sizePt: 16 })],
        firstLineIndentTwips: INDENT,
        lineSpacingFixed,
      }));
    } else if (level === 3) {
      // 三级标题：仿宋/宋体三号，序号+标题加粗，正文不加粗，同段
      const runs = [];
      const titlePart = heading ? `${number}${heading}` : `${number}${text}`;
      if (heading) {
        // heading + text 分开：heading加粗，text不加粗
        runs.push(cnRun({ text: titlePart, cnFont: bodyFont, sizePt: 16, bold: true }));
        if (text) runs.push(cnRun({ text, cnFont: bodyFont, sizePt: 16 }));
      } else {
        // 只有 text，全部加粗（向后兼容）
        runs.push(cnRun({ text: titlePart, cnFont: bodyFont, sizePt: 16, bold: true }));
      }
      paras.push(makePara({ runs, firstLineIndentTwips: INDENT, lineSpacingFixed }));
    } else if (level === 4) {
      paras.push(makePara({
        runs: [cnRun({ text: `${number}${text}`, cnFont: bodyFont, sizePt: 16 })],
        firstLineIndentTwips: INDENT,
        lineSpacingFixed,
      }));
    }
  }
  return paras;
}

// ─────────────────────────────────────────────
// 正文渲染（通用文档模式）
// ─────────────────────────────────────────────

function renderBodyGeneral(body, layout, ctx) {
  const { h1SizePt, h2SizePt, h3SizePt, bodySizePt } = layout;
  // ctx 中的 lineSpacingMultiple 已合并 preset 覆盖
  const lineSpacingMultiple = (ctx && ctx.lineSpacingMultiple) || layout.lineSpacingMultiple;
  const h1Font  = (ctx && ctx.h1Font)  || F.heiti;
  const h1Color = (ctx && ctx.h1Color) || undefined;
  const h2Color = (ctx && ctx.h2Color) || undefined;
  const INDENT = bodySizePt * 2 * 20;  // 首行缩进两字
  const paras = [];

  for (const node of body) {
    if (ctx) {
      if (node.type === "table")     { paras.push(...renderTable(node, ctx));  continue; }
      if (node.type === "image")     { paras.push(...renderImage(node, ctx));  continue; }
      if (node.type === "list")      { paras.push(...renderList(node, ctx));   continue; }
      if (node.type === "pageBreak") { paras.push(...renderPageBreak());        continue; }
      if (node.type === "divider")   { paras.push(...renderDivider());          continue; }
      if (node.type === "link")      { paras.push(...renderLink(node, ctx));   continue; }
    }
    const { level = 0, number = "", heading, text = "" } = node;

    if (level === 0) {
      paras.push(makePara({
        runs: [cnRun({ text, cnFont: F.songti, sizePt: bodySizePt })],
        firstLineIndentTwips: INDENT,
        lineSpacingMultiple,
      }));
    } else if (level === 1) {
      // 一级标题：黑体小三（可被 preset 覆盖字体/颜色），独立成行，段前段后间距
      paras.push(makePara({
        runs: [cnRun({ text: joinNumberHeading(number, heading, "、"), cnFont: h1Font, sizePt: h1SizePt, color: h1Color })],
        spaceBefore: PT(7),
        spaceAfter : PT(4),
        lineSpacingMultiple,
      }));
      if (text) paras.push(makePara({
        runs: [cnRun({ text, cnFont: F.songti, sizePt: bodySizePt })],
        firstLineIndentTwips: INDENT,
        lineSpacingMultiple,
      }));
    } else if (level === 2) {
      // 二级标题：宋体四号加粗（可被 preset 覆盖颜色）
      paras.push(makePara({
        runs: [cnRun({ text: heading ? `${number}${heading}` : number, cnFont: F.songti, sizePt: h2SizePt, bold: true, color: h2Color })],
        firstLineIndentTwips: INDENT,
        spaceBefore: PT(4),
        spaceAfter : PT(2),
        lineSpacingMultiple,
      }));
      if (text) paras.push(makePara({
        runs: [cnRun({ text, cnFont: F.songti, sizePt: bodySizePt })],
        firstLineIndentTwips: INDENT,
        lineSpacingMultiple,
      }));
    } else if (level === 3) {
      // 三级标题：宋体四号，序号+标题加粗，正文不加粗，同段
      const runs = [];
      const titlePart = heading ? `${number}${heading}` : `${number}${text}`;
      if (heading) {
        runs.push(cnRun({ text: titlePart, cnFont: F.songti, sizePt: h3SizePt, bold: true }));
        if (text) runs.push(cnRun({ text, cnFont: F.songti, sizePt: bodySizePt }));
      } else {
        runs.push(cnRun({ text: titlePart, cnFont: F.songti, sizePt: h3SizePt, bold: true }));
      }
      paras.push(makePara({ runs, firstLineIndentTwips: INDENT, lineSpacingMultiple }));
    } else if (level === 4) {
      paras.push(makePara({
        runs: [cnRun({ text: `${number}${text}`, cnFont: F.songti, sizePt: bodySizePt })],
        firstLineIndentTwips: INDENT,
        lineSpacingMultiple,
      }));
    }
  }
  return paras;
}

// ─────────────────────────────────────────────
// 版记（strict 模式专用）
// GB/T 9704-2012 §7.4
// ─────────────────────────────────────────────

function renderBanji({ cc = "", printOrg = "", printDate = "", bodyFont }) {
  const paras = [];
  const sizePt = 14; // 4号

  // 首条分隔线（粗线）
  paras.push(new Paragraph({
    spacing: { before: 0, after: 0 },
    border: { top: { style: BorderStyle.SINGLE, size: 7, color: "000000", space: 1 } }, // 0.35mm ≈ 7 half-pt
    children: [],
  }));

  // 抄送机关
  if (cc) {
    paras.push(makePara({
      runs: [cnRun({ text: `抄送：${cc}`, cnFont: F.fangsong, sizePt })],
    }));
    // 中间分隔线（细线）
    paras.push(new Paragraph({
      spacing: { before: 0, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, size: 5, color: "000000", space: 1 } }, // 0.25mm ≈ 5 half-pt
      children: [],
    }));
  }

  // 印发机关和印发日期（同行，左右分列）
  if (printOrg || printDate) {
    const orgText = printOrg || "";
    const dateText = printDate ? `${printDate}印发` : "";
    paras.push(new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [
        cnRun({ text: orgText, cnFont: F.fangsong, sizePt }),
        // 用足够多的空格分隔，右对齐日期
        new TextRun({
          text: "                              ",
          font: { name: F.fangsong, eastAsia: F.fangsong },
          size: sizePt * 2,
        }),
        cnRun({ text: dateText, cnFont: F.fangsong, sizePt }),
      ],
    }));
  }

  // 末条分隔线（粗线）
  paras.push(new Paragraph({
    spacing: { before: 0, after: 0 },
    border: { top: { style: BorderStyle.SINGLE, size: 7, color: "000000", space: 1 } },
    children: [],
  }));

  return paras;
}

// ─────────────────────────────────────────────
// 主生成函数
// ─────────────────────────────────────────────

async function generate(opts = {}) {
  const { docType = "baogao", content = {}, outputPath = "output.docx",
          preset = null } = opts;

  // preset 提供 mode/style 默认值，显式传参优先
  const pd   = preset ? (PRESETS[preset] || {}) : {};
  const mode  = opts.mode  ?? pd.mode  ?? "official";
  const style = opts.style ?? pd.style ?? "standard";

  const layout = mode === "general" ? LAYOUT.general : LAYOUT.official;
  // preset 可覆盖行距和页边距
  const mergedLineSpacingMultiple = pd.lineSpacingMultiple ?? layout.lineSpacingMultiple ?? null;
  const mergedMargin              = pd.marginOverride      ?? layout.margin;
  const { titleSizePt, bodySizePt, footerStyle } = layout;
  const margin = mergedMargin;
  const lineSpacingFixed = layout.lineSpacingFixed || null;

  // preset 外观参数（颜色/字体，仅影响 general 模式标题）
  const ps = {
    titleFont : pd.titleFont  || null,
    h1Font    : pd.h1Font     || null,
    titleColor: pd.titleColor || null,
    h1Color   : pd.h1Color    || null,
    h2Color   : pd.h2Color    || null,
  };

  // 公文模式字体选择
  const isStrict = (mode === "official" && style === "strict");
  const isStandard = (mode === "official" && style === "standard");
  const isOfficial = (mode === "official");
  // official 模式（无论 strict/standard）都使用固定行距，确保每页 22 行
  const officialLS = isOfficial ? lineSpacingFixed : null;
  const titleFont = isStrict ? F.biaosong : F.songti;
  const bodyFont  = isStrict ? F.fangsong : F.songti;
  const titleBold = isOfficial && !isStrict;  // 仅 official standard 宋体标题加粗；general 黑体 / strict 方正小标宋均不需要

  const { title = "", recipient = "",
          org = "", date = "", doc_number = "", attachments = [],
          // strict 模式新增字段
          serial_number = "",   // 份号（6位数字）
          secret_level = "",    // 密级和保密期限（如"机密★1年"）
          urgency = "",         // 紧急程度（如"特急""加急"）
          signers = [],         // 签发人（上行文），如 ["张三", "李四"]
          cc = "",              // 抄送机关
          print_org = "",       // 印发机关
          print_date = "",      // 印发日期
          // Phase 2：页眉（仅 general 模式有效）
          header = "",          // 统一页眉文字
          headerOdd = "",       // 奇数页页眉（优先于 header）
          headerEven = "",      // 偶数页页眉（优先于 header）
  } = content;

  // content.markdown 优先：将 Markdown 字符串解析为 body 节点
  const body = content.markdown ? parseMarkdown(content.markdown) : (content.body || []);

  // 日期处理
  let dateStr;
  if (date) {
    dateStr = date;
  } else if (mode === "general") {
    dateStr = dateToArabic(new Date().toISOString().slice(0, 10));
  } else {
    dateStr = dateToChinese(new Date().toISOString().slice(0, 10));
  }

  const children = [];

  // ══════════════════════════════════════════════
  // 公文 STRICT 模式：完整版头
  // ══════════════════════════════════════════════
  if (isStrict && org) {

    // ── 份号、密级、紧急程度（版心左上角）──
    // §7.2.1 份号：6位3号阿拉伯数字，顶格编排在版心左上角第一行
    if (serial_number) {
      children.push(makePara({
        runs: [cnRun({ text: serial_number, cnFont: F.songti, sizePt: 16 })],
        lineSpacingFixed,
      }));
    }
    // §7.2.2 密级：3号黑体，顶格编排在版心左上角
    if (secret_level) {
      children.push(makePara({
        runs: [cnRun({ text: secret_level, cnFont: F.heiti, sizePt: 16 })],
        lineSpacingFixed,
      }));
    }
    // §7.2.3 紧急程度：3号黑体，顶格编排在版心左上角
    if (urgency) {
      children.push(makePara({
        runs: [cnRun({ text: urgency, cnFont: F.heiti, sizePt: 16 })],
        lineSpacingFixed,
      }));
    }

    // ── 发文机关标志 ──
    // §7.2.4：居中，上边缘至版心上边缘为 35mm，红色小标宋体
    // 计算距离：如果有份号/密级/紧急在上方，需要减去已占用的行数
    const headerLines = [serial_number, secret_level, urgency].filter(Boolean).length;
    // 35mm ≈ CM(3.5) = 1985 twips; 每行约 LINE_HEIGHT_PT * 20 twips
    const lineHeight = Math.round(LINE_HEIGHT_PT * 20);
    const targetGap = CM(3.5) - headerLines * lineHeight;
    const orgSpaceBefore = Math.max(targetGap, 0);

    children.push(makePara({
      alignment: AlignmentType.CENTER,
      spaceBefore: orgSpaceBefore,
      runs: [cnRun({ text: org, cnFont: F.biaosong, sizePt: 22, color: "FF0000" })],
    }));

    // ── 发文字号 ──
    // §7.2.5：发文机关标志下空二行，居中排布
    // 上行文：发文字号居左空一字，签发人居右
    if (doc_number) {
      const twoLineGap = lineHeight * 2;
      if (signers.length > 0) {
        // 上行文格式：发文字号居左空一字，签发人居右
        // §7.2.6："签发人"三字用3号仿宋体字，签发人姓名用3号楷体字
        const signRunsLines = [];
        for (let i = 0; i < signers.length; i++) {
          if (i === 0) {
            // 第一行：发文字号在左，"签发人：姓名"在右
            // 使用制表符分隔不太可靠，用两个段落+右对齐处理
          }
          signRunsLines.push(signers[i]);
        }

        // 发文字号行（带签发人）
        // 简化处理：发文字号和签发人在同一段，中间用空格撑开
        const spacer = "                    ";
        const signLabel = "签发人：";
        const signerNames = signers.join("  ");

        children.push(makePara({
          spaceBefore: twoLineGap,
          runs: [
            cnRun({ text: ` ${doc_number}`, cnFont: bodyFont, sizePt: 16 }), // 左空一字
            cnRun({ text: spacer, cnFont: bodyFont, sizePt: 16 }),
            cnRun({ text: signLabel, cnFont: F.fangsong, sizePt: 16 }),
            cnRun({ text: signerNames, cnFont: F.kaiti, sizePt: 16 }),
          ],
          lineSpacingFixed,
        }));
      } else {
        // 下行文：发文字号居中
        children.push(makePara({
          alignment: AlignmentType.CENTER,
          spaceBefore: twoLineGap,
          runs: [cnRun({ text: doc_number, cnFont: bodyFont, sizePt: 16 })],
          lineSpacingFixed,
        }));
      }
    }

    // ── 版头分隔线 ──
    // §7.2.7：发文字号之下 4mm 处，与版心等宽的红色分隔线
    children.push(new Paragraph({
      spacing: { before: MM(4), after: 0 },
      border : { bottom: { style: BorderStyle.SINGLE, size: 6, color: "FF0000", space: 1 } },
      children: [],
    }));
  }

  // ══════════════════════════════════════════════
  // 公文 STANDARD 模式：简化红头（无红头，仅标题）
  // ══════════════════════════════════════════════
  // standard 模式无红头，直接走标题

  // ── 文档标题 ──
  if (title) {
    let titleSpaceBefore;
    if (isStrict) {
      // §7.3.1：红色分隔线下空二行
      const lineHeight = Math.round(LINE_HEIGHT_PT * 20);
      titleSpaceBefore = lineHeight * 2;
    } else if (mode === "general") {
      titleSpaceBefore = PT(12);
    } else {
      titleSpaceBefore = PT(24);
    }

    const generalLS = mode === "general" ? layout.lineSpacingMultiple : null;
    children.push(makePara({
      alignment  : AlignmentType.CENTER,
      spaceBefore: titleSpaceBefore,
      spaceAfter : isStrict ? Math.round(LINE_HEIGHT_PT * 20) : PT(12), // strict: 标题后空一行到主送机关
      lineSpacingFixed: officialLS,
      lineSpacingMultiple: generalLS,
      runs: [cnRun({ text: title,
                     cnFont: mode === "general" ? (ps.titleFont || F.heiti) : titleFont,
                     sizePt: titleSizePt, bold: titleBold,
                     color: mode === "general" ? (ps.titleColor || undefined) : undefined })],
    }));
  }

  // ── 副标题 / 作者（通用文档可选）──
  if (mode === "general" && content.author) {
    children.push(makePara({
      alignment: AlignmentType.CENTER,
      spaceAfter: PT(6),
      lineSpacingMultiple: mergedLineSpacingMultiple,
      runs: [cnRun({ text: content.author, cnFont: F.songti, sizePt: bodySizePt })],
    }));
  }

  // ── 主送机关（公文）──
  // §7.3.2：标题下空一行位置，居左顶格
  const noRecipientTypes = ["baogao", "jiyao", "jianghua", "fangan"];
  if (mode === "official" && recipient && !noRecipientTypes.includes(docType)) {
    children.push(makePara({
      runs: [cnRun({ text: recipient, cnFont: bodyFont, sizePt: 16 })],
      lineSpacingFixed: officialLS,
    }));
  }

  // ── 正文 ──
  const usableDxa = USABLE_DXA[mode === "general" ? "general" : "official"];
  const ctx = {
    usableDxa,
    bodySizePt,
    cnFont: bodyFont,
    lineSpacingFixed: officialLS,
    lineSpacingMultiple: mode === "general" ? mergedLineSpacingMultiple : null,
    // Phase 3: preset 外观
    h1Font    : ps.h1Font,
    h1Color   : ps.h1Color,
    h2Color   : ps.h2Color,
  };
  if (mode === "general") {
    children.push(...renderBodyGeneral(body, layout, ctx));
  } else {
    children.push(...renderBodyOfficial(body, bodyFont, officialLS, isStandard, ctx));
  }

  // ── 附件说明 ──
  // §7.3.4：正文下一行，左空二字"附件："，多附件用"1.XXXX"（阿拉伯数字+半角点号，名称后不加标点）
  if (attachments.length > 0) {
    const attSizePt = mode === "general" ? bodySizePt : 16;
    const attFont   = mode === "general" ? F.songti : bodyFont;
    const attIndent = attSizePt * 2 * 20;
    if (attachments.length === 1) {
      children.push(makePara({
        firstLineIndentTwips: attIndent,
        runs: [cnRun({ text: `附件：${attachments[0]}`, cnFont: attFont, sizePt: attSizePt })],
        lineSpacingFixed: officialLS,
      }));
    } else {
      children.push(makePara({
        firstLineIndentTwips: attIndent,
        runs: [cnRun({ text: "附件：", cnFont: attFont, sizePt: attSizePt })],
        lineSpacingFixed: officialLS,
      }));
      attachments.forEach((att, i) => {
        children.push(makePara({
          firstLineIndentTwips: attIndent,
          runs: [cnRun({ text: `${i + 1}.${att}`, cnFont: attFont, sizePt: attSizePt })],
          lineSpacingFixed: officialLS,
        }));
      });
    }
  }

  // ── 署名 + 日期（公文）──
  // §7.3.5.1：成文日期一般右空四字编排
  if (mode === "official" && (org || dateStr)) {
    const RIGHT_INDENT = PT(16 * 4); // 右空四字（三号字16pt × 4）

    // 正文与落款之间空两行
    for (let i = 0; i < 2; i++) {
      children.push(makePara({ runs: [cnRun({ text: " ", cnFont: bodyFont, sizePt: 16 })], lineSpacingFixed: officialLS }));
    }

    // 发文机关署名（strict 模式有红头时，版头已有机关名，但署名仍需要）
    if (org) {
      children.push(makePara({
        alignment: AlignmentType.RIGHT,
        rightIndentTwips: RIGHT_INDENT,
        runs: [cnRun({ text: org, cnFont: bodyFont, sizePt: 16 })],
        lineSpacingFixed: officialLS,
      }));
    }
    children.push(makePara({
      alignment: AlignmentType.RIGHT,
      rightIndentTwips: RIGHT_INDENT,
      runs: [cnRun({ text: dateStr, cnFont: bodyFont, sizePt: 16 })],
      lineSpacingFixed: officialLS,
    }));
    if (isStrict) {
      children.push(makePara({
        alignment: AlignmentType.RIGHT,
        rightIndentTwips: RIGHT_INDENT,
        runs: [cnRun({ text: "（此处加盖印章）", cnFont: bodyFont, sizePt: 16, color: "888888" })],
        lineSpacingFixed,
      }));
    }
  }

  // ── 版记（strict 模式）──
  // §7.4：抄送机关、印发机关和印发日期
  if (isStrict) {
    const banjiParas = renderBanji({
      cc,
      printOrg: print_org || org,
      printDate: print_date || dateStr,
      bodyFont,
    });
    children.push(...banjiParas);
  }

  // ── 落款（通用文档）──
  if (mode === "general" && (org || dateStr)) {
    const gLS = layout.lineSpacingMultiple;
    // 空两行
    for (let i = 0; i < 2; i++) {
      children.push(makePara({ runs: [cnRun({ text: " ", cnFont: F.songti, sizePt: bodySizePt })], lineSpacingMultiple: gLS }));
    }
    if (org) {
      children.push(makePara({
        alignment: AlignmentType.RIGHT,
        lineSpacingMultiple: gLS,
        runs: [cnRun({ text: org, cnFont: F.songti, sizePt: bodySizePt })],
      }));
    }
    children.push(makePara({
      alignment: AlignmentType.RIGHT,
      lineSpacingMultiple: gLS,
      runs: [cnRun({ text: dateStr, cnFont: F.songti, sizePt: bodySizePt })],
    }));
  }

  // ── 构建文档 ──
  const footers = makeFooters(footerStyle);
  // 页眉仅在 general 模式下生效（公文模式无页眉，符合 GB/T 9704 规范）
  const headers = (!isOfficial && (header || headerOdd || headerEven))
    ? makeHeaders(header, headerOdd, headerEven, bodySizePt, bodyFont)
    : null;
  const hasEvenOdd = footerStyle === "chinese" || !!(headerOdd || headerEven);
  const doc = new Document({
    evenAndOddHeaderAndFooters: hasEvenOdd,
    numbering: { config: makeNumberingConfig(bodySizePt, bodyFont) },
    styles: {
      default: {
        document: {
          run: { font: { name: F.songti, eastAsia: F.songti }, size: bodySizePt * 2 },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size  : { orientation: PageOrientation.PORTRAIT,
                    width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) },
          margin,
        },
      },
      ...(headers ? { headers } : {}),
      footers,
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outDir = path.dirname(outputPath);
  if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, buffer);

  // ── Phase 4：生成报告 ──
  return { path: outputPath, stats: calcStats(body, mode) };
}

// ─────────────────────────────────────────────
// Phase 4：生成统计报告
// ─────────────────────────────────────────────

function calcStats(body, mode) {
  let chars = 0, tables = 0, images = 0, lists = 0, paras = 0;

  function countChars(s) { chars += (s || "").replace(/\s/g, "").length; }

  function walkItems(items) {
    for (const item of (items || [])) {
      countChars(item.text);
      walkItems(item.children);
    }
  }

  for (const node of (body || [])) {
    if (!node) continue;
    switch (node.type) {
      case "table":
        tables++;
        (node.headers || []).forEach(countChars);
        (node.rows    || []).forEach(r => r.forEach(countChars));
        break;
      case "image":  images++; break;
      case "list":   lists++;  walkItems(node.items); break;
      case "link":   countChars(node.prefix); countChars(node.text); countChars(node.suffix); break;
      case "pageBreak": case "divider": break;
      default:
        paras++;
        countChars(node.text); countChars(node.heading);
    }
  }

  // 每页字符估算：公文 ~600，通用 ~700
  const charsPerPage = mode === "official" ? 600 : 700;
  const pages = Math.max(1, Math.ceil(chars / charsPerPage));

  return { chars, pages, tables, images, lists, paras };
}

// ─────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────

module.exports = { generate, dateToChinese, dateToArabic };

// ─────────────────────────────────────────────
// 直接运行示例
// ─────────────────────────────────────────────

if (require.main === module) {
  // ── stdin 模式：echo '{"mode":"general",...}' | node generate.js ──
  if (!process.stdin.isTTY) {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      let opts;
      try { opts = JSON.parse(raw); }
      catch (e) { console.error("❌ JSON 解析失败：" + e.message); process.exit(1); }
      generate(opts)
        .then(({ path: p, stats: s }) => {
          console.log(`✅ 已生成：${p}`);
          console.log(`   📄 估算约 ${s.pages} 页  ·  段落 ${s.paras}  ·  表格 ${s.tables}  ·  图片 ${s.images}  ·  列表 ${s.lists}  ·  字符 ${s.chars}`);
        })
        .catch(e  => { console.error("❌ 失败：" + e.message); process.exit(1); });
    });
    return;
  }

  // ── 直接运行示例 ──
  generate({
    mode      : "general",
    outputPath: "./output/工作总结示例.docx",
    content   : {
      title : "2026年第一季度工作总结",
      author: "张三",
      org   : "某部门",
      date  : dateToArabic(new Date().toISOString().slice(0, 10)),
      body  : [
        { level: 0, text: "2026年第一季度，在部门领导的带领下，本人圆满完成了各项工作任务，现将主要工作情况总结如下。" },
        { level: 1, number: "一", heading: "主要工作完成情况" },
        { level: 2, number: "（一）", heading: "重点项目推进" },
        { level: 0, text: '按照年度工作计划，本季度共推进重点项目3个，均按期完成，达到预期目标。其中"数字化转型"项目进展顺利，已完成总体方案设计。' },
        { level: 2, number: "（二）", heading: "日常工作开展" },
        { level: 0, text: "认真完成各项日常工作任务，处理各类文件材料共计120余件，参加各类会议18次，撰写各类报告、总结、方案等材料15篇。" },
        { level: 1, number: "二", heading: "存在的问题和不足" },
        { level: 0, text: "工作中也存在一些不足之处，主要表现在：统筹协调能力有待提升，个别工作存在被动应付现象；文字功底需进一步加强，材料质量有待提高。" },
        { level: 1, number: "三", heading: "下一步工作计划" },
        { level: 0, text: "下一步，将重点做好以下几方面工作：一是加强学习，提升业务能力；二是主动作为，提高工作效率；三是强化协作，形成工作合力。" },
      ],
    },
  }).then(({ path: p, stats: s }) => {
    console.log(`✅ 已生成：${p}`);
    console.log(`   📄 估算约 ${s.pages} 页  ·  段落 ${s.paras}  ·  表格 ${s.tables}  ·  图片 ${s.images}  ·  列表 ${s.lists}  ·  字符 ${s.chars}`);
  }).catch(e  => { console.error("❌ 失败：", e.message); process.exit(1); });
}
