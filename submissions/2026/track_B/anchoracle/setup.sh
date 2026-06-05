#!/usr/bin/env bash
# Anchoracle 一键启动脚本 (macOS / Linux)
# 用法：bash setup.sh
set -e

echo "🚀 Anchoracle——与故人同行 · 一键启动"
echo

# 1. 准备环境变量文件
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "✅ 已根据模板创建 .env.local"
  echo "⚠️  请编辑 .env.local，填入你的 GOOGLE_API_KEY"
  echo "    申请地址：https://aistudio.google.com/apikey"
  echo "    （中国大陆需自备代理 / VPN，节点首选新加坡或美国）"
  echo "    填好后，重新运行：bash setup.sh"
  exit 0
fi

# 2. 校验 key 是否已填写
if grep -q "your-google-ai-studio-api-key-here" .env.local; then
  echo "⚠️  .env.local 中的 GOOGLE_API_KEY 仍是占位符，请先填入真实 key 再运行。"
  exit 1
fi

# 3. 安装依赖
echo "📦 安装依赖（npm install）..."
npm install

# 4. 启动开发服务器
echo
echo "🌐 启动开发服务器：http://localhost:3000"
echo "   （这是本机地址，仅本地有效；线上体验见 https://travel-history-agent.vercel.app）"
npm run dev
