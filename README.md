# FluxFile - 内网文件传输系统

## 项目结构

```
FluxFile/
├── backend/                    # FastAPI 后端服务
│   ├── app/
│   │   ├── api/               # API 路由
│   │   ├── core/              # 核心配置
│   │   ├── models/            # 数据模型
│   │   ├── services/          # 业务逻辑
│   │   └── utils/             # 工具函数
│   ├── tests/
│   └── requirements.txt
├── frontend/                   # React 18 + Vite 前端
│   ├── src/
│   │   ├── components/        # React 组件
│   │   ├── hooks/             # 自定义 Hooks
│   │   ├── stores/            # Zustand 状态管理
│   │   ├── services/          # API 服务
│   │   └── utils/             # 工具函数
│   ├── package.json
│   └── vite.config.ts
├── cpp_src/                    # C++ Pybind11 扩展
│   ├── fast_fs.cpp            # 核心性能模块
│   ├── CMakeLists.txt
│   └── third_party/           # 第三方库 (BLAKE3)
├── deploy/                     # 部署配置
│   ├── docker-compose.yml
│   ├── Dockerfile.backend
│   └── Dockerfile.frontend
└── setup.py                    # Python 扩展构建脚本
```

## 技术栈

- **Frontend**: React 18 + TypeScript + Vite + Zustand + Tailwind CSS + react-window
- **Backend**: Python FastAPI (ASGI)
- **Performance Core**: C++ (Pybind11) - fast_fs 扩展模块
- **Transport**: HTTP Zero-Copy (sendfile) + WebRTC P2P
- **Database**: ClickHouse (审计日志) + Redis (缓存)
- **Security**: LDAP + Casbin RBAC

## 快速开始

```bash
# 1. 编译 C++ 扩展
pip install -e .

# 2. 启动后端
cd backend && uvicorn app.main:app --reload

# 3. 启动前端
cd frontend && npm run dev
```

## 终止服务

```bash
# 终止后端 / 前端（在对应终端中）
Ctrl + C

# 或根据端口查找并终止进程
# 后端 (默认端口 8000)
lsof -ti :8000 | xargs kill -9

# 前端 (默认端口 5173)

```
