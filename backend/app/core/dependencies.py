"""
FluxFile - 依赖注入模块
=========================

实现线程安全的单例模式来管理核心服务实例。
使用 FastAPI 的依赖注入系统提供服务。

关键设计：
1. 使用双重检查锁定（Double-Checked Locking）确保线程安全
2. 延迟加载 fast_fs 模块，优雅降级到 Python 实现
3. 提供统一的依赖注入接口
"""

import threading
from functools import lru_cache
from typing import Optional, Type, TypeVar, Callable, Any

from fastapi import Depends, Request

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# 泛型类型变量
T = TypeVar("T")


# ============================================================================
# 线程安全的单例元类
# ============================================================================

class SingletonMeta(type):
    """
    线程安全的单例元类
    
    使用双重检查锁定模式实现，确保：
    1. 只创建一个实例
    2. 多线程环境下的安全性
    3. 最小化锁的持有时间
    
    注意：使用 RLock（可重入锁）避免嵌套单例类的死锁问题
    """
    
    _instances: dict = {}
    _lock: threading.RLock = threading.RLock()  # 使用 RLock 避免递归调用死锁
    
    def __call__(cls, *args, **kwargs):
        # 第一次检查（无锁）
        if cls not in cls._instances:
            # 获取锁
            with cls._lock:
                # 第二次检查（有锁）- 双重检查锁定
                if cls not in cls._instances:
                    instance = super().__call__(*args, **kwargs)
                    cls._instances[cls] = instance
        return cls._instances[cls]


# ============================================================================
# fast_fs 模块加载器
# ============================================================================

class FastFSLoader(metaclass=SingletonMeta):
    """
    fast_fs C++ 扩展模块的线程安全加载器
    
    功能：
    - 延迟加载 fast_fs 模块
    - 加载失败时优雅降级
    - 提供模块可用性检查
    - 缓存模块引用避免重复导入
    
    使用示例：
        loader = FastFSLoader()
        if loader.is_available:
            files = loader.module.scandir_recursive("/path")
    """
    
    def __init__(self):
        self._module = None
        self._is_available = False
        self._load_error: Optional[str] = None
        self._lock = threading.Lock()
        self._loaded = False
        
        # 立即尝试加载
        self._try_load()
    
    def _try_load(self) -> None:
        """
        尝试加载 fast_fs 模块
        
        线程安全：使用锁确保只加载一次
        """
        if self._loaded:
            return
        
        with self._lock:
            # 双重检查
            if self._loaded:
                return
            
            try:
                import fast_fs
                self._module = fast_fs
                self._is_available = True
                logger.info(
                    f"fast_fs 扩展加载成功 (版本: {fast_fs.__version__})"
                )
            except ImportError as e:
                self._is_available = False
                self._load_error = str(e)
                logger.warning(
                    f"fast_fs 扩展加载失败: {e}. "
                    "将使用 Python 原生实现。"
                )
            except Exception as e:
                self._is_available = False
                self._load_error = str(e)
                logger.error(f"fast_fs 加载时发生未知错误: {e}")
            finally:
                self._loaded = True
    
    @property
    def is_available(self) -> bool:
        """检查 fast_fs 是否可用"""
        return self._is_available
    
    @property
    def module(self):
        """
        获取 fast_fs 模块
        
        Returns:
            fast_fs 模块，如果不可用则返回 None
        """
        if not self._is_available:
            return None
        return self._module
    
    @property
    def load_error(self) -> Optional[str]:
        """获取加载错误信息"""
        return self._load_error
    
    def scandir_recursive(
        self,
        path: str,
        max_depth: int = 0,
        include_hidden: bool = False,
    ) -> list:
        """
        调用 scandir_recursive，自动降级到 Python 实现
        
        Args:
            path: 扫描路径
            max_depth: 最大深度（0=无限）
            include_hidden: 是否包含隐藏文件
            
        Returns:
            文件信息列表
        """
        if self._is_available:
            return self._module.scandir_recursive(
                path, max_depth, include_hidden
            )
        else:
            # 降级到 Python 实现
            return self._python_scandir(path, max_depth, include_hidden)
    
    def calculate_blake3(self, path: str, chunk_size: int = 1048576) -> str:
        """
        计算 BLAKE3 哈希，自动降级到 SHA256
        
        Args:
            path: 文件路径
            chunk_size: 缓冲区大小
            
        Returns:
            哈希值（十六进制字符串）
        """
        if self._is_available:
            return self._module.calculate_blake3(path, chunk_size)
        else:
            return self._python_hash(path)
    
    def calculate_blake3_batch(
        self,
        paths: list,
        num_threads: int = 0,
    ) -> dict:
        """批量计算哈希"""
        if self._is_available:
            return self._module.calculate_blake3_batch(paths, num_threads)
        else:
            return {p: self._python_hash(p) for p in paths}
    
    def get_file_info(self, path: str) -> dict:
        """获取文件信息"""
        if self._is_available:
            return self._module.get_file_info(path)
        else:
            return self._python_file_info(path)
    
    # ========================================================================
    # Python 降级实现
    # ========================================================================
    
    @staticmethod
    def _python_scandir(
        path: str,
        max_depth: int,
        include_hidden: bool,
    ) -> list:
        """Python 原生 scandir 实现"""
        import os
        from pathlib import Path
        
        results = []
        root = Path(path)
        
        def scan(current_path: Path, depth: int):
            if max_depth > 0 and depth >= max_depth:
                return
            
            try:
                for entry in os.scandir(current_path):
                    if not include_hidden and entry.name.startswith('.'):
                        continue
                    
                    try:
                        stat_info = entry.stat(follow_symlinks=False)
                        results.append({
                            'path': entry.path,
                            'name': entry.name,
                            'size': stat_info.st_size if not entry.is_dir() else 0,
                            'mtime': stat_info.st_mtime,
                            'is_directory': entry.is_dir(),
                            'is_symlink': entry.is_symlink(),
                        })
                        
                        if entry.is_dir() and not entry.is_symlink():
                            scan(Path(entry.path), depth + 1)
                    except (PermissionError, OSError):
                        continue
            except PermissionError:
                pass
        
        scan(root, 0)
        return results
    
    @staticmethod
    def _python_hash(path: str) -> str:
        """Python SHA256 哈希实现"""
        import hashlib
        
        hasher = hashlib.sha256()
        with open(path, 'rb') as f:
            while chunk := f.read(1048576):
                hasher.update(chunk)
        return hasher.hexdigest()
    
    @staticmethod
    def _python_file_info(path: str) -> dict:
        """Python 文件信息获取"""
        import os
        from pathlib import Path
        
        p = Path(path)
        stat_info = p.stat()
        
        return {
            'path': str(p),
            'name': p.name,
            'size': stat_info.st_size if p.is_file() else 0,
            'mtime': stat_info.st_mtime,
            'is_directory': p.is_dir(),
            'is_symlink': p.is_symlink(),
        }


# ============================================================================
# 服务容器（依赖注入容器）
# ============================================================================

class ServiceContainer(metaclass=SingletonMeta):
    """
    服务容器 - 管理所有服务实例
    
    提供统一的服务访问点，支持：
    - 延迟初始化
    - 依赖注入
    - 服务生命周期管理
    """
    
    def __init__(self):
        self._services: dict = {}
        self._lock = threading.Lock()
        
        # 注册核心服务
        self._fast_fs = FastFSLoader()
    
    @property
    def fast_fs(self) -> FastFSLoader:
        """获取 fast_fs 加载器"""
        return self._fast_fs
    
    def register(self, name: str, service: Any) -> None:
        """注册服务"""
        with self._lock:
            self._services[name] = service
    
    def get(self, name: str) -> Optional[Any]:
        """获取服务"""
        return self._services.get(name)


# ============================================================================
# FastAPI 依赖注入函数
# ============================================================================

@lru_cache()
def get_service_container() -> ServiceContainer:
    """
    获取服务容器单例
    
    使用 lru_cache 确保在 FastAPI 依赖注入中只创建一次
    """
    return ServiceContainer()


def get_fast_fs() -> FastFSLoader:
    """
    获取 fast_fs 加载器
    
    用于 FastAPI 依赖注入：
        @router.get("/files")
        async def list_files(fast_fs: FastFSLoader = Depends(get_fast_fs)):
            ...
    """
    container = get_service_container()
    return container.fast_fs


async def get_fast_fs_async() -> FastFSLoader:
    """异步版本的 fast_fs 获取器"""
    return get_fast_fs()


# ============================================================================
# 请求上下文依赖
# ============================================================================

class RequestContext:
    """
    请求上下文
    
    封装单个请求的上下文信息，包括：
    - 用户信息
    - 权限信息
    - 请求元数据
    """
    
    def __init__(self, request: Request):
        self.request = request
        self.user_id: Optional[str] = None
        self.username: Optional[str] = None
        self.permissions: list = []
        
        # 从请求中提取信息
        self._extract_user_info()
    
    def _extract_user_info(self) -> None:
        """从请求头或 session 提取用户信息"""
        # TODO: 实现 JWT 解析或 session 读取
        auth_header = self.request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            # TODO: 解析 JWT token
            pass
    
    def has_permission(self, permission: str) -> bool:
        """检查是否有指定权限"""
        return permission in self.permissions


async def get_request_context(request: Request) -> RequestContext:
    """
    获取请求上下文
    
    用于 FastAPI 依赖注入
    """
    return RequestContext(request)


# ============================================================================
# 文件系统服务依赖
# ============================================================================

def get_filesystem_service():
    """
    获取文件系统服务
    
    延迟导入避免循环依赖
    """
    from app.services.filesystem import FileSystemService
    
    # 使用单例模式获取或创建服务实例
    container = get_service_container()
    
    service = container.get("filesystem")
    if service is None:
        service = FileSystemService()
        container.register("filesystem", service)
    
    return service


# ============================================================================
# 通用依赖装饰器
# ============================================================================

def singleton_service(service_class: Type[T]) -> Callable[[], T]:
    """
    单例服务装饰器
    
    将任意服务类转换为单例，用于依赖注入
    
    使用示例：
        @singleton_service
        class MyService:
            pass
        
        # 在路由中使用
        @router.get("/")
        def endpoint(service: MyService = Depends(get_my_service)):
            ...
    """
    instance: Optional[T] = None
    lock = threading.Lock()
    
    def get_instance() -> T:
        nonlocal instance
        if instance is None:
            with lock:
                if instance is None:
                    instance = service_class()
        return instance
    
    return get_instance
