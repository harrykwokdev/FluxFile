"""
FluxFile - 核心配置模块
=========================

使用 pydantic-settings 管理应用配置，支持从环境变量加载。

配置优先级：
1. 环境变量
2. .env 文件
3. 默认值
"""

from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    应用配置类
    
    所有配置项都可以通过环境变量覆盖。
    环境变量名为大写的配置项名称，前缀为 FLUX_。
    
    例如：FLUX_DEBUG=true
    """
    
    model_config = SettingsConfigDict(
        env_prefix="FLUX_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
    
    # ========================================================================
    # 基础配置
    # ========================================================================
    
    # 应用名称
    APP_NAME: str = "FluxFile"
    
    # 版本
    VERSION: str = "1.0.0"
    
    # 调试模式
    DEBUG: bool = False
    
    # 服务器配置
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    WORKERS: int = 4
    
    # ========================================================================
    # 安全配置
    # ========================================================================
    
    # JWT 密钥（生产环境必须修改！）
    SECRET_KEY: str = "your-secret-key-change-in-production"
    
    # JWT 过期时间（分钟）
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    
    # 允许的 CORS 源
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:5173"]
    
    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """解析 CORS 配置，支持逗号分隔的字符串"""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",")]
        return v
    
    # ========================================================================
    # 文件系统配置
    # ========================================================================
    
    # 根目录（用户可访问的最高目录）
    ROOT_PATH: str = "/"
    
    # 允许访问的目录列表（为空表示允许所有）
    ALLOWED_PATHS: List[str] = []
    
    # 禁止访问的目录列表
    FORBIDDEN_PATHS: List[str] = [
        "/proc",
        "/sys",
        "/dev",
        "/.git",
    ]
    
    # 单文件大小限制（字节，默认 10GB）
    MAX_FILE_SIZE: int = 10 * 1024 * 1024 * 1024
    
    # 目录扫描最大文件数
    MAX_SCAN_FILES: int = 100000
    
    # 是否显示隐藏文件
    SHOW_HIDDEN_FILES: bool = False
    
    # ========================================================================
    # Redis 配置
    # ========================================================================
    
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: str = ""
    REDIS_DB: int = 0
    
    @property
    def redis_url(self) -> str:
        """构建 Redis 连接 URL"""
        if self.REDIS_PASSWORD:
            return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
    
    # ========================================================================
    # ClickHouse 配置
    # ========================================================================
    
    CLICKHOUSE_HOST: str = "localhost"
    CLICKHOUSE_PORT: int = 9000
    CLICKHOUSE_USER: str = "default"
    CLICKHOUSE_PASSWORD: str = ""
    CLICKHOUSE_DATABASE: str = "fluxfile"
    
    # ========================================================================
    # LDAP 配置
    # ========================================================================
    
    LDAP_ENABLED: bool = False
    LDAP_SERVER: str = "ldap://localhost:389"
    LDAP_BASE_DN: str = "dc=example,dc=com"
    LDAP_USER_DN: str = "ou=users"
    LDAP_BIND_DN: str = ""
    LDAP_BIND_PASSWORD: str = ""
    
    # ========================================================================
    # WebRTC 配置
    # ========================================================================
    
    # STUN/TURN 服务器
    STUN_SERVERS: List[str] = ["stun:stun.l.google.com:19302"]
    TURN_SERVERS: List[str] = []
    
    @field_validator("STUN_SERVERS", "TURN_SERVERS", mode="before")
    @classmethod
    def parse_ice_servers(cls, v):
        """解析 ICE 服务器配置"""
        if isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return v
    
    # ========================================================================
    # 性能配置
    # ========================================================================
    
    # 使用 C++ fast_fs 扩展
    USE_FAST_FS: bool = True
    
    # 并行哈希计算线程数（0 = 自动）
    HASH_THREADS: int = 0
    
    # 文件读取缓冲区大小
    READ_BUFFER_SIZE: int = 1024 * 1024  # 1MB


@lru_cache()
def get_settings() -> Settings:
    """
    获取配置单例
    
    使用 lru_cache 确保配置只加载一次
    """
    return Settings()


# 全局配置实例
settings = get_settings()
