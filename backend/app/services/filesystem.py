"""
FluxFile - 文件系统服务
=========================

封装文件系统操作逻辑，优先使用 C++ fast_fs 扩展。
"""

import asyncio
import os
import shutil
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# 尝试导入 C++ 扩展
try:
    import fast_fs
    HAS_FAST_FS = True
    logger.info("使用 C++ fast_fs 扩展进行文件操作")
except ImportError:
    HAS_FAST_FS = False
    logger.warning("fast_fs 扩展不可用，使用 Python 原生实现")


# 线程池用于执行阻塞 IO
_executor = ThreadPoolExecutor(max_workers=4)


def _permissions_to_string(mode: int) -> str:
    """将权限模式转换为字符串表示（如 rwxr-xr-x）"""
    perms = []
    for who in ["USR", "GRP", "OTH"]:
        for what in ["R", "W", "X"]:
            perm = getattr(stat, f"S_I{what}{who}", 0)
            perms.append(what.lower() if mode & perm else "-")
    return "".join(perms)


class FileSystemService:
    """
    文件系统服务类
    
    提供安全的文件系统操作接口，包括：
    - 路径验证和权限检查
    - 目录列表
    - 文件信息获取
    - 哈希计算
    - 文件操作（创建、删除、移动、复制）
    """
    
    def __init__(self):
        self.root_path = Path(settings.ROOT_PATH).resolve()
        self.forbidden_paths = [Path(p) for p in settings.FORBIDDEN_PATHS]
        self.use_fast_fs = settings.USE_FAST_FS and HAS_FAST_FS
    
    def validate_and_resolve_path(self, path: str) -> Path:
        """
        验证并解析路径
        
        确保路径：
        1. 在允许的根目录下
        2. 不在禁止访问列表中
        3. 解析后不包含符号链接逃逸
        
        Args:
            path: 用户请求的路径
            
        Returns:
            解析后的绝对路径
            
        Raises:
            PermissionError: 如果路径不允许访问
            FileNotFoundError: 如果路径不存在
        """
        # 将相对路径转为绝对路径
        if not path.startswith("/"):
            path = "/" + path
        
        resolved = Path(path).resolve()
        
        # 检查是否在根目录下
        try:
            resolved.relative_to(self.root_path)
        except ValueError:
            # 检查是否在允许的路径列表中
            if settings.ALLOWED_PATHS:
                allowed = False
                for allowed_path in settings.ALLOWED_PATHS:
                    try:
                        resolved.relative_to(Path(allowed_path).resolve())
                        allowed = True
                        break
                    except ValueError:
                        continue
                if not allowed:
                    raise PermissionError(f"路径不在允许范围内: {path}")
        
        # 检查禁止访问的路径
        for forbidden in self.forbidden_paths:
            try:
                resolved.relative_to(forbidden)
                raise PermissionError(f"禁止访问: {path}")
            except ValueError:
                continue
        
        # 检查路径是否存在
        if not resolved.exists():
            raise FileNotFoundError(f"路径不存在: {path}")
        
        return resolved
    
    async def list_directory(
        self,
        path: str,
        show_hidden: bool = False,
        sort_by: str = "name",
        sort_desc: bool = False,
    ) -> Dict[str, Any]:
        """
        列出目录内容
        
        优先使用 fast_fs 扩展进行高性能扫描。
        """
        resolved = self.validate_and_resolve_path(path)
        
        if not resolved.is_dir():
            raise NotADirectoryError(f"不是目录: {path}")
        
        # 在线程池中执行 IO 操作
        loop = asyncio.get_running_loop()
        
        if self.use_fast_fs:
            # 使用 C++ 扩展
            files = await loop.run_in_executor(
                _executor,
                lambda: fast_fs.scandir_recursive(
                    str(resolved),
                    max_depth=1,  # 只扫描当前目录
                    include_hidden=show_hidden,
                )
            )
        else:
            # 使用 Python 原生实现
            files = await loop.run_in_executor(
                _executor,
                lambda: self._scandir_python(resolved, show_hidden)
            )
        
        # 过滤只保留直接子项
        result_files = []
        for f in files:
            file_path = Path(f["path"])
            # 确保是直接子项
            if file_path.parent == resolved:
                result_files.append({
                    "name": f["name"],
                    "path": str(file_path.relative_to(self.root_path)),
                    "size": f["size"],
                    "mtime": f["mtime"],
                    "is_directory": f["is_directory"],
                    "is_symlink": f.get("is_symlink", False),
                })
        
        # 排序
        reverse = sort_desc
        if sort_by == "name":
            result_files.sort(key=lambda x: x["name"].lower(), reverse=reverse)
        elif sort_by == "size":
            result_files.sort(key=lambda x: x["size"], reverse=reverse)
        elif sort_by == "mtime":
            result_files.sort(key=lambda x: x["mtime"], reverse=reverse)
        
        # 目录始终在前面
        dirs = [f for f in result_files if f["is_directory"]]
        files_ = [f for f in result_files if not f["is_directory"]]
        result_files = dirs + files_
        
        # 计算父目录
        parent = None
        if resolved != self.root_path:
            parent_path = resolved.parent
            try:
                parent = "/" + str(parent_path.relative_to(self.root_path))
            except ValueError:
                parent = "/"
        
        return {
            "path": "/" + str(resolved.relative_to(self.root_path)) if resolved != self.root_path else "/",
            "parent": parent,
            "files": result_files,
            "total": len(result_files),
        }
    
    def _scandir_python(self, path: Path, show_hidden: bool) -> List[Dict[str, Any]]:
        """Python 原生目录扫描实现"""
        results = []
        
        try:
            for entry in os.scandir(path):
                try:
                    # 跳过隐藏文件
                    if not show_hidden and entry.name.startswith("."):
                        continue
                    
                    stat_info = entry.stat(follow_symlinks=False)
                    
                    results.append({
                        "path": entry.path,
                        "name": entry.name,
                        "size": stat_info.st_size if not entry.is_dir() else 0,
                        "mtime": stat_info.st_mtime,
                        "is_directory": entry.is_dir(),
                        "is_symlink": entry.is_symlink(),
                    })
                except (PermissionError, OSError):
                    continue
        except PermissionError:
            raise
        
        return results
    
    async def get_file_info(self, path: str) -> Dict[str, Any]:
        """获取文件详细信息"""
        resolved = self.validate_and_resolve_path(path)
        
        loop = asyncio.get_running_loop()
        
        if self.use_fast_fs:
            info = await loop.run_in_executor(
                _executor,
                lambda: fast_fs.get_file_info(str(resolved))
            )
        else:
            # Python 原生实现
            stat_info = resolved.stat()
            info = {
                "path": str(resolved),
                "name": resolved.name,
                "size": stat_info.st_size if resolved.is_file() else 0,
                "mtime": stat_info.st_mtime,
                "is_directory": resolved.is_dir(),
                "is_symlink": resolved.is_symlink(),
                "permissions": _permissions_to_string(stat_info.st_mode),
            }
        
        # 转换为相对路径
        info["path"] = "/" + str(resolved.relative_to(self.root_path))
        return info
    
    async def calculate_hash(self, path: str) -> Dict[str, Any]:
        """计算文件 BLAKE3 哈希"""
        resolved = self.validate_and_resolve_path(path)
        
        if not resolved.is_file():
            raise ValueError("只能计算文件的哈希值")
        
        loop = asyncio.get_running_loop()
        
        if self.use_fast_fs:
            hash_value = await loop.run_in_executor(
                _executor,
                lambda: fast_fs.calculate_blake3(str(resolved))
            )
        else:
            # Python 原生实现（使用 hashlib，没有 blake3 则用 sha256）
            hash_value = await loop.run_in_executor(
                _executor,
                lambda: self._calculate_hash_python(resolved)
            )
        
        return {
            "path": "/" + str(resolved.relative_to(self.root_path)),
            "algorithm": "blake3" if self.use_fast_fs else "sha256",
            "hash": hash_value,
            "size": resolved.stat().st_size,
        }
    
    def _calculate_hash_python(self, path: Path) -> str:
        """Python 原生哈希实现"""
        import hashlib
        
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                hasher.update(chunk)
        return hasher.hexdigest()
    
    async def calculate_hash_batch(self, paths: List[str]) -> Dict[str, Any]:
        """批量计算哈希"""
        # 验证所有路径
        resolved_paths = []
        for p in paths:
            try:
                resolved = self.validate_and_resolve_path(p)
                if resolved.is_file():
                    resolved_paths.append(str(resolved))
            except (PermissionError, FileNotFoundError):
                continue
        
        loop = asyncio.get_running_loop()
        
        if self.use_fast_fs and resolved_paths:
            results = await loop.run_in_executor(
                _executor,
                lambda: fast_fs.calculate_blake3_batch(
                    resolved_paths,
                    settings.HASH_THREADS,
                )
            )
        else:
            # 串行计算
            results = {}
            for p in resolved_paths:
                try:
                    hash_val = self._calculate_hash_python(Path(p))
                    results[p] = hash_val
                except Exception as e:
                    results[p] = {"error": str(e)}
        
        return results
    
    async def create_directory(self, path: str, parents: bool = True):
        """创建目录"""
        # 验证目标路径安全性
        if not path.startswith("/"):
            path = "/" + path
        target = Path(path).resolve()
        
        # 检查是否在根目录下
        try:
            target.relative_to(self.root_path)
        except ValueError:
            raise PermissionError(f"路径不在允许范围内: {path}")
        
        # 检查禁止访问的路径
        for forbidden in self.forbidden_paths:
            forbidden_name = str(forbidden).strip('/')
            if any(part == forbidden_name for part in target.parts):
                raise PermissionError(f"禁止访问: {path}")
        
        if target.exists():
            raise FileExistsError(f"目录已存在: {path}")
        
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            _executor,
            lambda: target.mkdir(parents=parents, exist_ok=False)
        )
    
    async def delete(self, path: str, recursive: bool = False):
        """删除文件或目录"""
        resolved = self.validate_and_resolve_path(path)
        
        loop = asyncio.get_running_loop()
        
        if resolved.is_dir():
            if recursive:
                await loop.run_in_executor(
                    _executor,
                    lambda: shutil.rmtree(resolved)
                )
            else:
                await loop.run_in_executor(
                    _executor,
                    lambda: resolved.rmdir()
                )
        else:
            await loop.run_in_executor(
                _executor,
                lambda: resolved.unlink()
            )
    
    async def move(self, source: str, destination: str, overwrite: bool = False):
        """移动/重命名"""
        src_resolved = self.validate_and_resolve_path(source)
        
        # 目标路径不需要存在
        dst_path = Path(destination)
        if not dst_path.is_absolute():
            dst_path = self.root_path / destination
        
        if dst_path.exists() and not overwrite:
            raise FileExistsError(f"目标已存在: {destination}")
        
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            _executor,
            lambda: shutil.move(str(src_resolved), str(dst_path))
        )
    
    async def copy(self, source: str, destination: str, overwrite: bool = False):
        """复制文件"""
        src_resolved = self.validate_and_resolve_path(source)
        
        dst_path = Path(destination)
        if not dst_path.is_absolute():
            dst_path = self.root_path / destination
        
        if dst_path.exists() and not overwrite:
            raise FileExistsError(f"目标已存在: {destination}")
        
        loop = asyncio.get_running_loop()
        
        if src_resolved.is_dir():
            await loop.run_in_executor(
                _executor,
                lambda: shutil.copytree(str(src_resolved), str(dst_path))
            )
        else:
            await loop.run_in_executor(
                _executor,
                lambda: shutil.copy2(str(src_resolved), str(dst_path))
            )
