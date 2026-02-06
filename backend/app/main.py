"""
FluxFile - FastAPI 应用入口
=============================

高性能内网文件传输系统的后端 API 服务。

启动命令：
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
    
生产环境：
    uvicorn app.main:app --workers 4 --host 0.0.0.0 --port 8000

WebDAV 访问：
    挂载在 /webdav 路径下，可通过文件管理器直接访问
"""

import os
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import files, health, signaling
from app.api import fs as fs_api  # 新的文件系统 API
from app.core.config import settings
from app.core.logging import setup_logging
from app.core.dependencies import get_service_container

# 设置日志
logger = setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    应用生命周期管理
    
    启动时：
    - 初始化 Redis 连接
    - 初始化 ClickHouse 连接
    - 加载 Casbin 策略
    - 验证 fast_fs 扩展可用
    
    关闭时：
    - 关闭所有连接
    - 清理资源
    """
    logger.info("FluxFile 正在启动...")
    
    # 初始化服务容器（确保单例已创建）
    container = get_service_container()
    
    # 验证 fast_fs 扩展
    if container.fast_fs.is_available:
        logger.info(f"fast_fs 扩展已加载 (版本: {container.fast_fs.module.__version__})")
    else:
        logger.warning(
            f"fast_fs 扩展未安装: {container.fast_fs.load_error}. "
            "将使用 Python 原生实现。运行 'pip install -e .' 编译扩展。"
        )
    
    # TODO: 初始化 Redis
    # TODO: 初始化 ClickHouse
    # TODO: 初始化 Casbin
    
    # 挂载 WebDAV
    try:
        from app.integrations.webdav import mount_webdav_with_auth
        mount_webdav_with_auth(app)
    except ImportError as e:
        logger.warning(f"WebDAV 功能不可用: {e}. 安装 wsgidav: pip install wsgidav")
    except Exception as e:
        logger.error(f"WebDAV 挂载失败: {e}")
    
    logger.info("FluxFile 启动完成")
    logger.info(f"API 文档: http://{settings.HOST}:{settings.PORT}/api/docs")
    logger.info(f"WebDAV: http://{settings.HOST}:{settings.PORT}/webdav")
    
    yield  # 应用运行中
    
    # 关闭清理
    logger.info("FluxFile 正在关闭...")
    # TODO: 关闭连接
    logger.info("FluxFile 已关闭")


# 创建 FastAPI 应用实例
app = FastAPI(
    title="FluxFile",
    description="高性能内网文件传输系统 API",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ============================================================================
# 中间件配置
# ============================================================================

# CORS 中间件 - 允许前端跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# API 路由注册
# ============================================================================

# 健康检查 API
app.include_router(
    health.router,
    prefix="/api/health",
    tags=["Health"],
)

# 文件操作 API（旧版，保持兼容）
app.include_router(
    files.router,
    prefix="/api/files",
    tags=["Files"],
)

# 文件系统 API（新版，使用依赖注入）
app.include_router(
    fs_api.router,
    prefix="/api/fs",
    tags=["FileSystem"],
)

# WebRTC 信令 API
app.include_router(
    signaling.router,
    prefix="/api/signaling",
    tags=["Signaling"],
)


# ============================================================================
# 根路由
# ============================================================================

@app.get("/", include_in_schema=False)
async def root():
    """根路由返回 API 信息"""
    return {
        "name": "FluxFile",
        "version": "1.0.0",
        "description": "高性能内网文件传输系统",
        "docs": "/api/docs",
        "redoc": "/api/redoc",
        "webdav": "/webdav",
        "status": "healthy",
    }


@app.get("/api", include_in_schema=False)
async def api_info():
    """API 入口信息"""
    from app.core.dependencies import get_fast_fs
    fast_fs = get_fast_fs()
    
    return {
        "version": "1.0.0",
        "endpoints": {
            "health": "/api/health",
            "files": "/api/files",
            "fs": "/api/fs",
            "signaling": "/api/signaling",
        },
        "fast_fs_available": fast_fs.is_available,
        "docs": "/api/docs",
    }


# ============================================================================
# CLI 入口点
# ============================================================================

def cli():
    """命令行入口点"""
    import uvicorn
    
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        workers=1 if settings.DEBUG else settings.WORKERS,
    )


if __name__ == "__main__":
    cli()
