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
      <a href="#features">功能</a>
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
dl "$BASE_URL/public/logo.png"                        "$WEBROOT/logo.png"
dl "$BASE_URL/scripts/web-assets/screenshot.png"      "$WEBROOT/screenshot.png"

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
