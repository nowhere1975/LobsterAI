#!/bin/bash
# UdiskAI 服务端一键部署脚本
# 在腾讯云服务器上执行：bash deploy.sh
set -e

SERVER_DIR="/opt/udiskai-server"
SERVICE_NAME="udiskai-server"

echo "===> [1/5] 安装 Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v)" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "===> [2/5] 复制服务端文件..."
mkdir -p "$SERVER_DIR"
# 从 GitHub 拉取（或手动上传后修改路径）
BASE_URL="https://raw.githubusercontent.com/nowhere1975/UdiskAI/main/server"
curl -sL "$BASE_URL/server.js"      -o "$SERVER_DIR/server.js"
curl -sL "$BASE_URL/package.json"   -o "$SERVER_DIR/package.json"

echo "===> [3/5] 安装依赖..."
cd "$SERVER_DIR"
npm install --production

echo "===> [4/5] 配置环境变量..."
if [ ! -f "$SERVER_DIR/.env" ]; then
  curl -sL "$BASE_URL/.env.example" -o "$SERVER_DIR/.env"
  echo ""
  echo "⚠️  请编辑 $SERVER_DIR/.env，填入 DEEPSEEK_API_KEY 等配置，然后重启服务"
  echo "   nano $SERVER_DIR/.env"
fi

echo "===> [5/5] 注册 systemd 服务..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=UdiskAI Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${SERVER_DIR}
ExecStart=/usr/bin/node ${SERVER_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager

echo ""
echo "✅ 服务端部署完成！"
echo "   服务运行在 http://127.0.0.1:3000"
echo "   测试：curl http://127.0.0.1:3000/credits?deviceId=test123"
echo ""
echo "接下来："
echo "  1. 编辑 $SERVER_DIR/.env，填入 DEEPSEEK_API_KEY"
echo "  2. 将 server/nginx-api.conf 内容追加到 nginx 的 server {} 块中"
echo "  3. systemctl reload nginx"
