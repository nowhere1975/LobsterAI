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
  convertInchesToTwip,
  PageNumber,
  TabStopPosition, TabStopType,
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
// 正文渲染（公文模式）
// ─────────────────────────────────────────────

function renderBodyOfficial(body, bodyFont, lineSpacingFixed, isStandard) {
  const INDENT = PT(32);  // 首行缩进两字（三号16pt×2=32pt）
  const paras = [];
  // standard 模式下二级标题用宋体加粗；strict 模式用楷体
  const h2Font = isStandard ? F.songti : F.kaiti;
  const h2Bold = isStandard;

  for (const node of body) {
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

function renderBodyGeneral(body, layout) {
  const { h1SizePt, h2SizePt, h3SizePt, bodySizePt, lineSpacingMultiple } = layout;
  const INDENT = bodySizePt * 2 * 20;  // 首行缩进两字
  const paras = [];

  for (const node of body) {
    const { level = 0, number = "", heading, text = "" } = node;

    if (level === 0) {
      paras.push(makePara({
        runs: [cnRun({ text, cnFont: F.songti, sizePt: bodySizePt })],
        firstLineIndentTwips: INDENT,
        lineSpacingMultiple,
      }));
    } else if (level === 1) {
      // 一级标题：黑体小三，独立成行，段前段后间距（黑体本身已足够醒目，不另加粗）
      paras.push(makePara({
        runs: [cnRun({ text: joinNumberHeading(number, heading, "、"), cnFont: F.heiti, sizePt: h1SizePt })],
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
      // 二级标题：宋体四号加粗
      paras.push(makePara({
        runs: [cnRun({ text: heading ? `${number}${heading}` : number, cnFont: F.songti, sizePt: h2SizePt, bold: true })],
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

async function generate({ mode = "official", style = "standard", docType = "baogao",
                           content = {}, outputPath = "output.docx" }) {

  const layout = mode === "general" ? LAYOUT.general : LAYOUT.official;
  const { margin, titleSizePt, bodySizePt, footerStyle } = layout;
  const lineSpacingFixed = layout.lineSpacingFixed || null;

  // 公文模式字体选择
  const isStrict = (mode === "official" && style === "strict");
  const isStandard = (mode === "official" && style === "standard");
  const isOfficial = (mode === "official");
  // official 模式（无论 strict/standard）都使用固定行距，确保每页 22 行
  const officialLS = isOfficial ? lineSpacingFixed : null;
  const titleFont = isStrict ? F.biaosong : F.songti;
  const bodyFont  = isStrict ? F.fangsong : F.songti;
  const titleBold = isOfficial && !isStrict;  // 仅 official standard 宋体标题加粗；general 黑体 / strict 方正小标宋均不需要

  const { title = "", recipient = "", body = [],
          org = "", date = "", doc_number = "", attachments = [],
          // strict 模式新增字段
          serial_number = "",   // 份号（6位数字）
          secret_level = "",    // 密级和保密期限（如"机密★1年"）
          urgency = "",         // 紧急程度（如"特急""加急"）
          signers = [],         // 签发人（上行文），如 ["张三", "李四"]
          cc = "",              // 抄送机关
          print_org = "",       // 印发机关
          print_date = "",      // 印发日期
  } = content;

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
      runs: [cnRun({ text: title, cnFont: mode === "general" ? F.heiti : titleFont,
                     sizePt: titleSizePt, bold: titleBold })],
    }));
  }

  // ── 副标题 / 作者（通用文档可选）──
  if (mode === "general" && content.author) {
    children.push(makePara({
      alignment: AlignmentType.CENTER,
      spaceAfter: PT(6),
      lineSpacingMultiple: layout.lineSpacingMultiple,
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
  if (mode === "general") {
    children.push(...renderBodyGeneral(body, layout));
  } else {
    children.push(...renderBodyOfficial(body, bodyFont, officialLS, isStandard));
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
  const doc = new Document({
    evenAndOddHeaderAndFooters: footerStyle === "chinese", // 启用奇偶页页脚区分
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
      footers,
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outDir = path.dirname(outputPath);
  if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
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
        .then(out => console.log("✅ 已生成：" + out))
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
  }).then(out => console.log("✅ 已生成：" + out))
    .catch(e  => { console.error("❌ 失败：", e.message); process.exit(1); });
}
