#!/bin/bash
# ============================================================
#  FindaSpot 一键启动脚本
#  用法: bash start.sh
# ============================================================

set -e

# ── 颜色 ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

cd "$(dirname "$0")"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║        FindaSpot 座位推荐系统          ║${NC}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 检测 Python ──
PYTHON=""
if command -v python3 &> /dev/null; then
    PYTHON=python3
elif command -v python &> /dev/null; then
    PYTHON=python
else
    echo -e "${RED}✘ 未找到 Python，请先安装 Python 3.10+:${NC}"
    echo "  https://www.python.org/downloads/"
    exit 1
fi

PY_VERSION=$($PYTHON --version 2>&1 | awk '{print $2}')
echo -e "${GREEN}✔ Python ${PY_VERSION}${NC}"

# ── 检测 Node.js ──
if ! command -v node &> /dev/null; then
    echo -e "${RED}✘ 未找到 Node.js，请先安装 Node.js 18+:${NC}"
    echo "  https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✔ Node.js ${NODE_VERSION}${NC}"

# ── 创建 Python 虚拟环境（如果不存在） ──
if [ ! -d ".venv" ]; then
    echo ""
    echo -e "${YELLOW}⏳ 首次运行，正在创建 Python 虚拟环境...${NC}"
    $PYTHON -m venv .venv
    echo -e "${GREEN}✔ 虚拟环境已创建${NC}"
fi

# ── 安装 Python 依赖 ──
echo ""
echo -e "${YELLOW}⏳ 正在安装 Python 依赖...${NC}"
.venv/bin/pip install -r requirements.txt -q
echo -e "${GREEN}✔ Python 依赖已就绪${NC}"

# ── 安装前端依赖 ──
echo ""
echo -e "${YELLOW}⏳ 正在安装前端依赖...${NC}"
cd frontend
if [ ! -d "node_modules" ]; then
    npm install --silent
else
    echo -e "${GREEN}✔ 前端依赖已存在，跳过${NC}"
fi
cd ..

# ── 清理旧进程 ──
for port in 8000 5173; do
    PID=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$PID" ]; then
        kill -9 $PID 2>/dev/null || true
    fi
done

# ── 启动数据库 (PostgreSQL via Docker) + 迁移 ──
echo ""
echo -e "${YELLOW}⏳ 启动数据库 PostgreSQL...${NC}"
if command -v docker &> /dev/null; then
    docker compose up -d db
    # 等待数据库就绪
    for i in $(seq 1 30); do
        if .venv/bin/python -c "from api.db import engine; from sqlalchemy import text; engine.connect().execute(text('SELECT 1'))" 2>/dev/null; then
            break
        fi
        sleep 1
    done
else
    echo -e "${YELLOW}⚠ 未找到 docker，假定 DATABASE_URL 指向已运行的 PostgreSQL${NC}"
fi
.venv/bin/python -m alembic upgrade head
# 数据库为空时，从 data/*.json 导入种子数据
if [ "$(.venv/bin/python -c 'from api.repository import get_floors; print(len(get_floors()))' 2>/dev/null)" = "0" ]; then
    echo -e "${YELLOW}⏳ 从 data/*.json 导入初始数据...${NC}"
    .venv/bin/python scripts/migrate_json_to_db.py
fi
echo -e "${GREEN}✔ 数据库就绪${NC}"

# ── 启动后端 ──
echo ""
echo -e "${YELLOW}⏳ 启动后端 API...${NC}"
.venv/bin/python api/server.py &
BACKEND_PID=$!

# 等待后端就绪
for i in $(seq 1 30); do
    if curl -s http://localhost:8000/api/ > /dev/null 2>&1; then
        echo -e "${GREEN}✔ 后端已就绪: http://localhost:8000${NC}"
        break
    fi
    sleep 0.5
done

# ── 启动前端 ──
echo -e "${YELLOW}⏳ 启动前端...${NC}"
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

# 等待前端就绪
for i in $(seq 1 30); do
    if curl -s http://localhost:5173/ > /dev/null 2>&1; then
        echo -e "${GREEN}✔ 前端已就绪${NC}"
        break
    fi
    sleep 0.5
done

# ── 打印访问地址 ──
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║  打开浏览器访问:                              ║${NC}"
echo -e "${GREEN}${BOLD}║                                                ║${NC}"
echo -e "${GREEN}${BOLD}║    → http://localhost:5173/ ←                  ║${NC}"
echo -e "${GREEN}${BOLD}║                                                ║${NC}"
echo -e "${GREEN}${BOLD}║  按 Ctrl+C 停止所有服务                       ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════════════╝${NC}"
echo ""

# ── 捕获 Ctrl+C 并清理 ──
trap "echo ''; echo -e '${YELLOW}正在停止服务...${NC}'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo -e '${GREEN}已停止所有服务${NC}'; exit 0" INT TERM

wait
