#!/bin/bash
# UdiskAI 落地页一键部署脚本
# 用法：在服务器上直接运行此脚本
# 需要：root 权限，域名 udiskai.top 已解析到本机

set -e
DOMAIN="udiskai.top"
WEBROOT="/var/www/udiskai"
EMAIL="UdiskAI@163.com"

echo "===> [1/6] 更新 apt 并安装 nginx、certbot..."
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx

echo "===> [2/6] 创建网站目录..."
mkdir -p "$WEBROOT"

echo "===> [3/6] 写入落地页 HTML..."
cat > "$WEBROOT/index.html" << 'HTMLEOF'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UdiskAI — 你的随身AI办公助手</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --indigo: #6366f1; --indigo-dark: #4f46e5;
      --indigo-light: #e0e7ff; --indigo-xlight: #f5f3ff;
      --text-primary: #111827; --text-secondary: #6b7280;
      --text-muted: #9ca3af; --border: #e5e7eb;
      --bg-gray: #f9fafb; --white: #ffffff;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    html { scroll-behavior: smooth; font-family: var(--font); color: var(--text-primary); background: var(--white); }
    body { line-height: 1.6; -webkit-font-smoothing: antialiased; }
    a { color: inherit; text-decoration: none; }

    /* NAV */
    nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      max-width: 1120px; margin: 0 auto; padding: 0 24px;
      height: 60px; display: flex; align-items: center; justify-content: space-between;
    }
    .nav-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1.1rem; }
    .nav-brand img { width: 32px; height: 32px; border-radius: 8px; object-fit: contain; }
    .nav-links { display: flex; align-items: center; gap: 24px; }
    .nav-links a { font-size: 0.875rem; color: var(--text-secondary); transition: color 0.2s; }
    .nav-links a:hover { color: var(--indigo); }
    .nav-github {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
      font-size: 0.85rem; font-weight: 500; transition: border-color 0.2s, color 0.2s;
    }
    .nav-github:hover { border-color: var(--indigo); color: var(--indigo); }

    /* HERO */
    .hero {
      position: relative; overflow: hidden;
      padding: 72px 24px 80px; background: var(--white);
    }
    .hero::before {
      content: ''; position: absolute; inset: 0;
      background-image: radial-gradient(circle, #c7d2fe 1px, transparent 1px);
      background-size: 28px 28px; opacity: 0.45; pointer-events: none;
    }
    .hero::after {
      content: ''; position: absolute; top: -80px; left: 30%;
      width: 700px; height: 400px;
      background: radial-gradient(ellipse at center, rgba(99,102,241,0.12) 0%, transparent 70%);
      pointer-events: none;
    }
    .hero-inner {
      position: relative; z-index: 1;
      max-width: 1200px; margin: 0 auto;
      display: grid; grid-template-columns: 2fr 3fr; gap: 32px; align-items: center;
      animation: fadeUp 0.75s ease both;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(24px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .hero-text { display: flex; flex-direction: column; align-items: flex-start; }
    .hero-logo {
      width: 72px; height: 72px; border-radius: 18px; object-fit: contain;
      margin-bottom: 24px; box-shadow: 0 8px 32px rgba(99,102,241,0.18);
    }
    .hero-title {
      font-size: clamp(2.2rem, 4vw, 3.4rem); font-weight: 800;
      letter-spacing: -0.03em; line-height: 1.1; margin-bottom: 16px;
    }
    .hero-title span {
      background: linear-gradient(135deg, var(--indigo) 0%, #818cf8 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .hero-tagline { font-size: 1.15rem; color: var(--text-secondary); margin-bottom: 36px; line-height: 1.6; }
    .hero-cta { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
    .btn-download {
      display: inline-flex; align-items: center; gap: 10px;
      padding: 14px 36px; background: var(--indigo); color: var(--white);
      font-size: 1.05rem; font-weight: 600; border-radius: 12px;
      box-shadow: 0 4px 20px rgba(99,102,241,0.35);
      transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
    }
    .btn-download:hover {
      background: var(--indigo-dark); transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(99,102,241,0.45);
    }
    .hero-note { font-size: 0.82rem; color: var(--text-muted); letter-spacing: 0.02em; }
    .hero-screenshot {
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 8px 16px rgba(0,0,0,0.06), 0 32px 80px rgba(99,102,241,0.14), 0 0 0 1px rgba(0,0,0,0.06);
    }
    .hero-screenshot img { display: block; width: 100%; height: auto; }

    /* CASES */
    .cases { padding: 88px 24px; background: var(--bg-gray); }
    .cases-grid {
      max-width: 1120px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px;
    }
    .case-card {
      background: var(--white); border: 1px solid var(--border);
      border-radius: 16px; overflow: hidden;
      transition: box-shadow 0.2s, transform 0.2s, border-color 0.2s;
    }
    .case-card:hover {
      box-shadow: 0 8px 32px rgba(99,102,241,0.1);
      border-color: #c7d2fe; transform: translateY(-3px);
    }
    .case-img { display: block; width: 100%; height: auto; border-bottom: 1px solid var(--border); }
    .case-body { padding: 20px 22px 24px; }
    .case-tag {
      display: inline-block; padding: 3px 10px;
      background: var(--indigo-light); color: var(--indigo);
      font-size: 0.72rem; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; border-radius: 100px; margin-bottom: 10px;
    }
    .case-title { font-size: 1rem; font-weight: 700; margin-bottom: 6px; }
    .case-desc { font-size: 0.875rem; color: var(--text-secondary); line-height: 1.6; }
    .case-prompt {
      margin-top: 12px; padding: 10px 14px;
      background: var(--bg-gray); border-radius: 8px;
      font-size: 0.82rem; color: var(--text-secondary);
      border-left: 3px solid #c7d2fe; line-height: 1.55;
    }
    .case-prompt::before { content: '💬 '; }

    /* FEATURES */
    .features { padding: 88px 24px; background: var(--white); }
    .section-header { text-align: center; margin-bottom: 56px; }
    .section-label {
      display: inline-block; padding: 4px 14px;
      background: var(--indigo-light); color: var(--indigo);
      font-size: 0.78rem; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; border-radius: 100px; margin-bottom: 14px;
    }
    .section-title { font-size: clamp(1.6rem, 3vw, 2.2rem); font-weight: 800; letter-spacing: -0.02em; }
    .features-grid {
      max-width: 1120px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;
    }
    .feature-card {
      background: var(--white); border: 1px solid var(--border);
      border-radius: 16px; padding: 32px 28px;
      transition: box-shadow 0.2s, transform 0.2s, border-color 0.2s;
    }
    .feature-card:hover {
      box-shadow: 0 8px 32px rgba(99,102,241,0.1);
      border-color: #c7d2fe; transform: translateY(-3px);
    }
    .feature-icon {
      width: 48px; height: 48px; background: var(--indigo-xlight);
      border-radius: 12px; display: flex; align-items: center;
      justify-content: center; margin-bottom: 18px;
    }
    .feature-icon svg { width: 22px; height: 22px; stroke: var(--indigo); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; }
    .feature-name { font-size: 1.05rem; font-weight: 700; margin-bottom: 8px; }
    .feature-desc { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.65; }

    /* SKILLS */
    .skills { padding: 72px 24px; background: var(--bg-gray); }
    .skills-grid {
      max-width: 960px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;
    }
    .skill-card {
      background: var(--white); border: 1px solid var(--border);
      border-radius: 14px; padding: 22px 20px;
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      transition: box-shadow 0.2s, border-color 0.2s, transform 0.2s;
    }
    .skill-card:hover {
      box-shadow: 0 6px 24px rgba(99,102,241,0.1);
      border-color: #c7d2fe; transform: translateY(-2px);
    }
    .skill-icon {
      width: 40px; height: 40px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .skill-icon svg { width: 20px; height: 20px; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; }
    .skill-name { font-size: 0.9rem; font-weight: 700; }
    .skill-desc { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.55; }

    /* CHANGELOG */
    .changelog { padding: 72px 24px; background: var(--white); }
    .changelog-inner { max-width: 720px; margin: 0 auto; }
    .changelog-entry { margin-bottom: 32px; }
    .changelog-version {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em;
      color: var(--indigo); background: var(--indigo-light);
      padding: 4px 12px; border-radius: 100px; margin-bottom: 14px;
    }
    .changelog-version .badge-new {
      background: var(--indigo); color: #fff;
      font-size: 0.65rem; padding: 1px 7px; border-radius: 100px; letter-spacing: 0.05em;
    }
    .changelog-items { display: flex; flex-direction: column; gap: 8px; }
    .changelog-item {
      display: flex; gap: 10px; align-items: flex-start;
      font-size: 0.875rem; color: var(--text-secondary); line-height: 1.6;
    }
    .changelog-item .dot {
      width: 6px; height: 6px; background: var(--indigo); border-radius: 50%;
      flex-shrink: 0; margin-top: 8px;
    }

    /* HOW TO */
    .howto { padding: 88px 24px; background: var(--bg-gray); }
    .steps-row {
      max-width: 960px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(3, 1fr);
      gap: 0; position: relative;
    }
    .steps-row::before {
      content: ''; position: absolute; top: 31px;
      left: calc(16.66% + 16px); right: calc(16.66% + 16px);
      border-top: 2px dashed #c7d2fe; pointer-events: none;
    }
    .step { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 28px; }
    .step-num {
      width: 64px; height: 64px; background: var(--indigo); color: var(--white);
      font-size: 1.4rem; font-weight: 800; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin-bottom: 20px; box-shadow: 0 4px 16px rgba(99,102,241,0.3);
      position: relative; z-index: 1;
    }
    .step-title { font-size: 1rem; font-weight: 700; margin-bottom: 8px; }
    .step-desc { font-size: 0.875rem; color: var(--text-secondary); line-height: 1.65; }

    /* FOOTER */
    footer { background: #0f172a; color: #94a3b8; padding: 40px 24px; }
    .footer-inner {
      max-width: 1120px; margin: 0 auto;
      display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center;
    }
    .footer-logo { display: flex; align-items: center; gap: 8px; color: #e2e8f0; font-weight: 700; font-size: 1rem; margin-bottom: 4px; }
    .footer-logo img { width: 26px; height: 26px; border-radius: 6px; opacity: 0.9; }
    .footer-links { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; }
    .footer-links a { font-size: 0.82rem; color: #64748b; transition: color 0.2s; }
    .footer-links a:hover { color: #a5b4fc; }
    .footer-copy { font-size: 0.78rem; color: #475569; margin-top: 4px; }

    /* RESPONSIVE */
    @media (max-width: 900px) {
      .hero-inner { grid-template-columns: 1fr; gap: 40px; }
      .hero-text { align-items: center; text-align: center; }
      .hero-cta { align-items: center; }
      .hero-screenshot { max-width: 560px; margin: 0 auto; }
    }
    @media (max-width: 768px) {
      .cases-grid { grid-template-columns: 1fr; max-width: 480px; }
      .skills-grid { grid-template-columns: repeat(2, 1fr); }
      .features-grid { grid-template-columns: 1fr; max-width: 480px; }
      .steps-row { grid-template-columns: 1fr; gap: 40px; }
      .steps-row::before { display: none; }
      .step { padding: 0; }
    }
    @media (max-width: 480px) {
      .hero { padding: 56px 20px 64px; }
      .nav-inner { padding: 0 16px; }
    }
  </style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <a class="nav-brand" href="#">
      <img src="/logo.png" alt="UdiskAI" />
      UdiskAI
    </a>
    <div class="nav-links">
      <a href="#cases">案例</a>
      <a href="#skills">技能</a>
      <a href="#features">功能</a>
      <a href="#changelog">更新</a>
      <a href="#howto">使用说明</a>
      <a class="nav-github" href="https://github.com/nowhere1975/UdiskAI" target="_blank" rel="noopener">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
        </svg>
        GitHub
      </a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="hero-inner">
    <div class="hero-text">
      <img class="hero-logo" src="/logo.png" alt="UdiskAI" />
      <h1 class="hero-title"><span>UdiskAI</span></h1>
      <p class="hero-tagline">你的随身 AI 办公助手</p>
      <div class="hero-cta">
        <a class="btn-download" href="https://www.123865.com/s/YdozTd-CXkq3" target="_blank" rel="noopener">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          免费下载
        </a>
        <span class="hero-note">Windows 便携版 · 免费使用</span>
      </div>
    </div>
    <div class="hero-screenshot">
      <img src="/screenshot.png" alt="UdiskAI 界面截图" />
    </div>
  </div>
</section>

<section class="cases" id="cases">
  <div class="section-header">
    <div class="section-label">使用案例</div>
    <h2 class="section-title">看看别人怎么用 UdiskAI</h2>
  </div>
  <div class="cases-grid">
    <div class="case-card">
      <img class="case-img" src="/case-search-pdf.png" alt="搜索生成报告" />
      <div class="case-body">
        <span class="case-tag">搜索 · PDF</span>
        <div class="case-title">一句话生成调研报告</div>
        <p class="case-desc">让 AI 自动搜索多个信源，整合分析，直接输出结构化 PDF 报告。</p>
        <div class="case-prompt">请搜索关于美伊战争的新闻和动态，总结一份态势报告，生成 PDF</div>
      </div>
    </div>
    <div class="case-card">
      <img class="case-img" src="/case-excel.png" alt="Excel数据分析" />
      <div class="case-body">
        <span class="case-tag">Excel · 数据分析</span>
        <div class="case-title">表格数据交给 AI 算</div>
        <p class="case-desc">上传销售表格，用自然语言提需求，自动完成统计汇总并生成新文件。</p>
        <div class="case-prompt">我有一个销售表格，需要你帮我做统计工作，汇总各产品销量</div>
      </div>
    </div>
    <div class="case-card">
      <img class="case-img" src="/case-word.png" alt="生成Word文档" />
      <div class="case-body">
        <span class="case-tag">Word · 文档生成</span>
        <div class="case-title">读取文件自动写报告</div>
        <p class="case-desc">指定工作文件夹，AI 自动读取材料，生成完整的季度工作总结 Word 文档。</p>
        <div class="case-prompt">我的工作文件在 C 盘工作文件夹，按里面的内容帮我写季度工作总结</div>
      </div>
    </div>
  </div>
</section>

<section class="skills" id="skills">
  <div class="section-header">
    <div class="section-label">内置技能</div>
    <h2 class="section-title">开箱即用的办公能力</h2>
  </div>
  <div class="skills-grid">
    <div class="skill-card">
      <div class="skill-icon" style="background:#e0e7ff">
        <svg viewBox="0 0 24 24" stroke="#6366f1"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      </div>
      <div class="skill-name">中文文档生成</div>
      <p class="skill-desc">正式公文（GB/T 9704）、工作总结、项目方案，直接输出 .docx</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#dcfce7">
        <svg viewBox="0 0 24 24" stroke="#16a34a"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
      </div>
      <div class="skill-name">Excel 数据分析</div>
      <p class="skill-desc">读取表格、自动统计汇总、图表生成，结果保存为新文件</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#fef9c3">
        <svg viewBox="0 0 24 24" stroke="#ca8a04"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="m9 21 3-9 3 9"/></svg>
      </div>
      <div class="skill-name">PPT 制作</div>
      <p class="skill-desc">工作汇报、项目介绍、培训材料，AI 全自动生成幻灯片</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#fee2e2">
        <svg viewBox="0 0 24 24" stroke="#dc2626"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="skill-name">PDF 处理</div>
      <p class="skill-desc">读取、提取文本、合并拆分，支持将文档导出为 PDF</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#e0f2fe">
        <svg viewBox="0 0 24 24" stroke="#0284c7"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </div>
      <div class="skill-name">网页搜索</div>
      <p class="skill-desc">实时检索多个信源，获取最新信息，整合生成结构化报告</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#f3e8ff">
        <svg viewBox="0 0 24 24" stroke="#9333ea"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      </div>
      <div class="skill-name">邮件收发</div>
      <p class="skill-desc">读取收件箱、起草并发送邮件，支持主流邮箱协议</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#cffafe">
        <svg viewBox="0 0 24 24" stroke="#0891b2"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>
      </div>
      <div class="skill-name">朋友圈卡片</div>
      <p class="skill-desc">输入文字生成精美图片，长图、信息图、九宫格等 6 种风格</p>
    </div>
    <div class="skill-card">
      <div class="skill-icon" style="background:#fce7f3">
        <svg viewBox="0 0 24 24" stroke="#db2777"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </div>
      <div class="skill-name">Word 编辑</div>
      <p class="skill-desc">打开并修改现有 Word 文档，重新排版或按模板套用格式</p>
    </div>
  </div>
</section>

<section class="changelog" id="changelog">
  <div class="section-header">
    <div class="section-label">更新日志</div>
    <h2 class="section-title">持续迭代中</h2>
  </div>
  <div class="changelog-inner">
    <div class="changelog-entry">
      <div class="changelog-version">
        v2026.3.24 <span class="badge-new">最新</span>
      </div>
      <div class="changelog-items">
        <div class="changelog-item"><div class="dot"></div><span><strong>朋友圈卡片技能</strong>：输入文字生成精美图片，支持长图、信息图、九宫格、手绘笔记、白板框图、漫画格 6 种风格，调用系统 Edge 渲染，无需额外下载浏览器</span></div>
        <div class="changelog-item"><div class="dot"></div><span><strong>首页快捷按钮</strong>：新增「发朋友圈」和「PPT 制作」两个快捷入口，各含 4 个子场景模板</span></div>
        <div class="changelog-item"><div class="dot"></div><span>去除 <code style="font-size:0.8em;background:#f3f4f6;padding:1px 5px;border-radius:4px">启动.bat</code>，直接双击 UdiskAI.exe 即可运行，程序自动识别便携模式</span></div>
        <div class="changelog-item"><div class="dot"></div><span>修复快捷按钮、技能删除、MiniMax API 连接等多项 Bug</span></div>
      </div>
    </div>
    <div class="changelog-entry">
      <div class="changelog-version">v2026.3.22 — 首个正式版本</div>
      <div class="changelog-items">
        <div class="changelog-item"><div class="dot"></div><span><strong>便携模式</strong>：解压即用，数据全存 data/ 目录，支持 U 盘随身携带</span></div>
        <div class="changelog-item"><div class="dot"></div><span>内置 Word、Excel、PPT、PDF、网页搜索、邮件等办公技能</span></div>
        <div class="changelog-item"><div class="dot"></div><span>技能安全扫描：从技能市场安装第三方技能时自动审查</span></div>
        <div class="changelog-item"><div class="dot"></div><span>项目由 LobsterAI 重命名为 UdiskAI，移除非便携功能，精简包体积</span></div>
      </div>
    </div>
  </div>
</section>

<section class="features" id="features">
  <div class="section-header">
    <div class="section-label">核心功能</div>
    <h2 class="section-title">为什么选择 UdiskAI？</h2>
  </div>
  <div class="features-grid">
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
      <div class="feature-name">解压即用</div>
      <p class="feature-desc">无需安装，不写注册表。解压后直接双击 UdiskAI.exe 即可启动，零配置上手。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg></div>
      <div class="feature-name">随身携带</div>
      <p class="feature-desc">放在 U 盘或移动硬盘，插入任意 Windows 电脑即可使用，数据全部存于本地。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg></div>
      <div class="feature-name">办公技能预置</div>
      <p class="feature-desc">内置 Word、Excel、PPT、PDF 等 10+ 办公技能，覆盖日常文档处理需求。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg></div>
      <div class="feature-name">持久记忆</div>
      <p class="feature-desc">自动从对话中学习你的偏好与习惯，越用越懂你，提升每次交互效率。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg></div>
      <div class="feature-name">数据本地存储</div>
      <p class="feature-desc">聊天记录与配置全部保存在本地，不上传任何数据，隐私完全掌握在自己手中。</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><svg viewBox="0 0 24 24"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg></div>
      <div class="feature-name">Claude 驱动</div>
      <p class="feature-desc">基于 Anthropic Claude 大模型，接入你自己的 API Key，性能与官方体验一致。</p>
    </div>
  </div>
</section>

<section class="howto" id="howto">
  <div class="section-header">
    <div class="section-label">使用说明</div>
    <h2 class="section-title">三步开始使用</h2>
  </div>
  <div class="steps-row">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-title">下载解压</div>
      <p class="step-desc">从下载页获取 zip 压缩包，解压到任意本地目录或 U 盘根目录。</p>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-title">填入 API Key</div>
      <p class="step-desc">打开设置页面，填入你的大模型 API Key，多个主流大模型供应商可选。</p>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-title">开始使用</div>
      <p class="step-desc">直接对话，让 AI 帮你处理 Word、Excel、PPT 等各类办公任务。</p>
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <img src="/logo.png" alt="UdiskAI" />
      UdiskAI
    </div>
    <div class="footer-links">
      <a href="https://www.123865.com/s/YdozTd-CXkq3" target="_blank" rel="noopener">免费下载</a>
      <a href="https://github.com/nowhere1975/UdiskAI" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:UdiskAI@163.com">UdiskAI@163.com</a>
    </div>
    <p class="footer-copy">Base on LobsterAI by NetEase Youdao. MIT License.</p>
  </div>
</footer>

</body>
</html>
HTMLEOF

echo "===> [4/6] 下载 logo 和截图..."
BASE_URL="https://raw.githubusercontent.com/nowhere1975/UdiskAI/main"
dl() {
  local url="$1" dest="$2"
  if command -v wget &>/dev/null; then
    wget -q "$url" -O "$dest" 2>/dev/null || echo "    下载失败：$url，请手动上传到 $dest"
  else
    curl -sL "$url" -o "$dest" 2>/dev/null || echo "    下载失败：$url，请手动上传到 $dest"
  fi
}
dl "$BASE_URL/public/logo.png"                             "$WEBROOT/logo.png"
dl "$BASE_URL/scripts/web-assets/screenshot.png"           "$WEBROOT/screenshot.png"
dl "$BASE_URL/scripts/web-assets/case-search-pdf.png"      "$WEBROOT/case-search-pdf.png"
dl "$BASE_URL/scripts/web-assets/case-excel.png"           "$WEBROOT/case-excel.png"
dl "$BASE_URL/scripts/web-assets/case-word.png"            "$WEBROOT/case-word.png"

echo "===> [5/6] 配置 nginx..."
cat > /etc/nginx/sites-available/udiskai << NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    root $WEBROOT;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # 静态文件缓存
    location ~* \.(png|ico|css|js)$ {
        expires 7d;
        add_header Cache-Control "public";
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/udiskai /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "===> [6/6] 申请 Let's Encrypt HTTPS 证书..."
certbot --nginx \
  -d "$DOMAIN" -d "www.$DOMAIN" \
  --non-interactive --agree-tos \
  --email "$EMAIL" \
  --redirect

echo ""
echo "✅ 部署完成！"
echo "   访问：https://$DOMAIN"
