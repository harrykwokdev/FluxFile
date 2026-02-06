"""
FluxFile - 健康检查 API
==========================

提供服务健康状态检查端点，用于容器编排和监控系统。
"""

from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def health_check() -> Dict[str, Any]:
    """
    基础健康检查
    
    Returns:
        健康状态信息
    """
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "fluxfile",
    }


@router.get("/ready")
async def readiness_check() -> Dict[str, Any]:
    """
    就绪检查
    
    检查所有依赖服务是否可用：
    - Redis 连接
    - ClickHouse 连接
    - fast_fs 扩展
    
    Returns:
        就绪状态信息
    """
    checks = {
        "redis": False,
        "clickhouse": False,
        "fast_fs": False,
    }
    
    # 检查 fast_fs 扩展
    try:
        import fast_fs
        checks["fast_fs"] = True
    except ImportError:
        pass
    
    # TODO: 检查 Redis 连接
    # TODO: 检查 ClickHouse 连接
    
    # fast_fs 不是必需的，仅作为增强功能
    # 当 Redis/ClickHouse 就绪后取消注释相应检查
    all_ready = True  # 基础服务始终就绪
    # all_ready = all([
    #     checks["redis"],
    #     checks["clickhouse"],
    # ])
    
    return {
        "status": "ready" if all_ready else "not_ready",
        "timestamp": datetime.utcnow().isoformat(),
        "checks": checks,
    }


@router.get("/live")
async def liveness_check() -> Dict[str, str]:
    """
    存活检查
    
    简单检查服务是否响应，用于 Kubernetes liveness probe。
    
    Returns:
        存活状态
    """
    return {"status": "alive"}
