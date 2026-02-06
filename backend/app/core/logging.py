"""
FluxFile - 日志配置模块
=========================

配置结构化日志输出，支持 JSON 格式（用于生产环境日志收集）。
"""

import logging
import sys
from typing import Optional

from app.core.config import settings


def setup_logging(
    level: Optional[str] = None,
    json_format: bool = False,
) -> logging.Logger:
    """
    配置应用日志
    
    Args:
        level: 日志级别（默认根据 DEBUG 设置）
        json_format: 是否使用 JSON 格式输出
        
    Returns:
        配置好的 Logger 实例
    """
    # 确定日志级别
    if level is None:
        level = "DEBUG" if settings.DEBUG else "INFO"
    
    # 创建日志格式
    if json_format:
        # JSON 格式（生产环境）
        log_format = (
            '{"time": "%(asctime)s", "level": "%(levelname)s", '
            '"module": "%(module)s", "message": "%(message)s"}'
        )
    else:
        # 可读格式（开发环境）
        log_format = (
            "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s"
        )
    
    # 配置根日志器
    logging.basicConfig(
        level=getattr(logging, level.upper()),
        format=log_format,
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )
    
    # 降低第三方库的日志级别
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    
    # 返回应用日志器
    logger = logging.getLogger("fluxfile")
    logger.setLevel(getattr(logging, level.upper()))
    
    return logger


# 获取默认日志器
def get_logger(name: str = "fluxfile") -> logging.Logger:
    """获取指定名称的日志器"""
    return logging.getLogger(name)
