"""
FluxFile - 文件系统 API 路由
==============================

提供文件系统操作的 RESTful API：
- /api/fs/list - 目录列表
- /api/fs/info - 文件信息
- /api/fs/download - 文件下载（Zero-Copy）
- /api/fs/hash - 哈希计算

关键实现：
1. 使用依赖注入获取 fast_fs 单例
2. 统一的异常处理
3. 路径安全验证
"""

import os
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from enum import Enum

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings


def _to_camel(string: str) -> str:
    """snake_case 转 camelCase"""
    components = string.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])


class CamelModel(BaseModel):
    """camelCase JSON 输出的基类"""
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
    )
from app.core.dependencies import (
    FastFSLoader,
    get_fast_fs,
    get_filesystem_service,
    get_request_context,
    RequestContext,
)
from app.core.logging import get_logger
from app.services.filesystem import FileSystemService
from app.utils.responses import ZeroCopyFileResponse

router = APIRouter()
logger = get_logger(__name__)

# \u914d\u7f6e FastAPI \u9ed8\u8ba4\u4f7f\u7528 camelCase \u522b\u540d\u8f93\u51fa JSON
# Pydantic v2 \u9700\u8981\u663e\u5f0f\u542f\u7528 by_alias
_RESPONSE_CONFIG = {"response_model_by_alias": True}


# ============================================================================
# 请求/响应模型
# ============================================================================

class SortField(str, Enum):
    """排序字段枚举"""
    NAME = "name"
    SIZE = "size"
    MTIME = "mtime"
    TYPE = "type"


class FileType(str, Enum):
    """文件类型枚举"""
    FILE = "file"
    DIRECTORY = "directory"
    SYMLINK = "symlink"


class FileEntry(CamelModel):
    """文件条目模型"""
    name: str = Field(..., description="文件名")
    path: str = Field(..., description="相对路径")
    absolute_path: Optional[str] = Field(None, description="绝对路径（可选）")
    size: int = Field(..., description="文件大小（字节）")
    mtime: float = Field(..., description="修改时间（Unix 时间戳）")
    mtime_iso: Optional[str] = Field(None, description="修改时间（ISO 格式）")
    type: FileType = Field(..., description="文件类型")
    is_hidden: bool = Field(False, description="是否为隐藏文件")
    permissions: Optional[str] = Field(None, description="权限字符串")
    extension: Optional[str] = Field(None, description="文件扩展名")
    
    @field_validator("mtime_iso", mode="before")
    @classmethod
    def format_mtime(cls, v, info):
        """格式化时间戳为 ISO 格式"""
        if v is None and "mtime" in info.data:
            from datetime import datetime
            try:
                return datetime.fromtimestamp(info.data["mtime"]).isoformat()
            except:
                return None
        return v


class DirectoryListResponse(CamelModel):
    """目录列表响应"""
    success: bool = True
    path: str = Field(..., description="当前目录")
    parent: Optional[str] = Field(None, description="父目录")
    entries: List[FileEntry] = Field(..., description="条目列表")
    total_count: int = Field(..., description="总条目数")
    directory_count: int = Field(0, description="目录数量")
    file_count: int = Field(0, description="文件数量")
    total_size: int = Field(0, description="总大小（字节）")


class FileInfoResponse(CamelModel):
    """文件信息响应"""
    success: bool = True
    path: str
    name: str
    size: int
    mtime: float
    mtime_iso: str
    type: FileType
    permissions: str
    owner: Optional[str] = None
    group: Optional[str] = None
    mime_type: Optional[str] = None
    is_readable: bool = True
    is_writable: bool = True
    is_executable: bool = False


class HashResponse(CamelModel):
    """哈希响应"""
    success: bool = True
    path: str
    algorithm: str
    hash: str
    size: int
    duration_ms: float = Field(..., description="计算耗时（毫秒）")


class BatchHashRequest(BaseModel):
    """批量哈希请求"""
    paths: List[str] = Field(..., min_length=1, max_length=1000)


class ErrorResponse(CamelModel):
    """错误响应"""
    success: bool = False
    error: str
    error_code: str
    path: Optional[str] = None


# ============================================================================
# 辅助函数
# ============================================================================

def _permissions_to_string(mode: int) -> str:
    """将权限模式转换为 rwx 格式"""
    perms = []
    for who in ["USR", "GRP", "OTH"]:
        for what in ["R", "W", "X"]:
            perm_flag = getattr(stat, f"S_I{what}{who}", 0)
            perms.append(what.lower() if mode & perm_flag else "-")
    return "".join(perms)


def _validate_path(path: str, root: Path) -> Path:
    """
    验证并解析路径
    
    确保路径安全，防止目录穿越攻击
    
    Args:
        path: 用户请求的路径
        root: 允许访问的根目录
        
    Returns:
        解析后的安全路径
        
    Raises:
        HTTPException: 如果路径不安全或不存在
    """
    # 规范化路径
    if not path.startswith("/"):
        path = "/" + path
    
    # 解析为绝对路径
    try:
        resolved = Path(path).resolve()
    except Exception:
        raise HTTPException(
            status_code=400,
            detail={"error": "Invalid path", "error_code": "INVALID_PATH"}
        )
    
    # 检查是否在根目录下（防止目录穿越）
    try:
        resolved.relative_to(root)
    except ValueError:
        # 如果配置了额外的允许路径，检查是否在允许列表中
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
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "Access denied: path outside allowed scope",
                        "error_code": "ACCESS_DENIED"
                    }
                )
        else:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "Access denied: path outside root directory",
                    "error_code": "ACCESS_DENIED"
                }
            )
    
    # 检查禁止访问的路径（检查路径组件，而不仅仅是前缀匹配）
    resolved_str = str(resolved)
    for forbidden in settings.FORBIDDEN_PATHS:
        # 支持绝对路径和目录名组件匹配
        forbidden_path = Path(forbidden).resolve() if forbidden.startswith('/') else None
        if forbidden_path:
            try:
                resolved.relative_to(forbidden_path)
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "Access denied: forbidden path",
                        "error_code": "FORBIDDEN_PATH"
                    }
                )
            except ValueError:
                pass
        # 也检查路径组件中是否包含禁止的目录名（如 .git）
        forbidden_name = forbidden.strip('/')
        if any(part == forbidden_name for part in resolved.parts):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "Access denied: forbidden path",
                    "error_code": "FORBIDDEN_PATH"
                }
            )
    
    return resolved


def _convert_to_file_entry(
    item: Dict[str, Any],
    root: Path,
    include_absolute: bool = False,
) -> FileEntry:
    """将原始文件信息转换为 FileEntry 模型"""
    from datetime import datetime
    
    item_path = Path(item["path"])
    name = item["name"]
    
    # 确定类型
    if item.get("is_symlink", False):
        file_type = FileType.SYMLINK
    elif item.get("is_directory", False):
        file_type = FileType.DIRECTORY
    else:
        file_type = FileType.FILE
    
    # 计算相对路径
    try:
        rel_path = "/" + str(item_path.relative_to(root))
    except ValueError:
        rel_path = str(item_path)
    
    # 获取扩展名
    extension = item_path.suffix.lstrip(".") if file_type == FileType.FILE else None
    
    return FileEntry(
        name=name,
        path=rel_path,
        absolute_path=str(item_path) if include_absolute else None,
        size=item.get("size", 0),
        mtime=item.get("mtime", 0),
        mtime_iso=datetime.fromtimestamp(item.get("mtime", 0)).isoformat(),
        type=file_type,
        is_hidden=name.startswith("."),
        extension=extension,
    )


# ============================================================================
# API 端点
# ============================================================================

@router.get(
    "/list",
    response_model=DirectoryListResponse,
    response_model_by_alias=True,
    responses={
        403: {"model": ErrorResponse, "description": "权限不足"},
        404: {"model": ErrorResponse, "description": "路径不存在"},
    },
    summary="列出目录内容",
    description="使用高性能 C++ 扩展扫描目录，返回文件列表",
)
async def list_directory(
    path: str = Query("/", description="目录路径"),
    show_hidden: bool = Query(False, description="显示隐藏文件"),
    sort_by: SortField = Query(SortField.NAME, description="排序字段"),
    sort_desc: bool = Query(False, description="降序排列"),
    dirs_first: bool = Query(True, description="目录优先"),
    limit: int = Query(0, ge=0, le=10000, description="限制返回数量（0=不限）"),
    offset: int = Query(0, ge=0, description="偏移量"),
    fast_fs: FastFSLoader = Depends(get_fast_fs),
) -> DirectoryListResponse:
    """
    列出目录内容
    
    调用 C++ fast_fs.scandir_recursive 进行高性能目录扫描。
    
    特性：
    - 使用 C++ 扩展突破 Python GIL 限制
    - 支持 10 万+ 文件的高效扫描
    - 自动降级到 Python 实现（如果扩展不可用）
    
    路径安全：
    - 验证路径在允许范围内
    - 防止目录穿越攻击
    """
    root = Path(settings.ROOT_PATH).resolve()
    
    # 验证路径
    try:
        resolved = _validate_path(path, root)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    # 检查路径是否存在
    if not resolved.exists():
        raise HTTPException(
            status_code=404,
            detail={"error": "Path not found", "error_code": "NOT_FOUND", "path": path}
        )
    
    # 检查是否为目录
    if not resolved.is_dir():
        raise HTTPException(
            status_code=400,
            detail={"error": "Path is not a directory", "error_code": "NOT_DIRECTORY", "path": path}
        )
    
    # 调用 fast_fs 扫描（或降级实现）
    try:
        raw_results = fast_fs.scandir_recursive(
            str(resolved),
            max_depth=1,  # 只扫描当前层
            include_hidden=show_hidden,
        )
    except PermissionError:
        raise HTTPException(
            status_code=403,
            detail={"error": "Permission denied", "error_code": "PERMISSION_DENIED", "path": path}
        )
    except Exception as e:
        logger.error(f"目录扫描失败: {path}, 错误: {e}")
        raise HTTPException(
            status_code=500,
            detail={"error": str(e), "error_code": "SCAN_ERROR", "path": path}
        )
    
    # 过滤只保留直接子项
    entries = []
    for item in raw_results:
        item_path = Path(item["path"])
        if item_path.parent == resolved:
            entries.append(_convert_to_file_entry(item, root))
    
    # 排序
    def sort_key(entry: FileEntry):
        if sort_by == SortField.NAME:
            return entry.name.lower()
        elif sort_by == SortField.SIZE:
            return entry.size
        elif sort_by == SortField.MTIME:
            return entry.mtime
        elif sort_by == SortField.TYPE:
            return entry.type.value
        return entry.name.lower()
    
    entries.sort(key=sort_key, reverse=sort_desc)
    
    # 目录优先
    if dirs_first:
        dirs = [e for e in entries if e.type == FileType.DIRECTORY]
        files = [e for e in entries if e.type != FileType.DIRECTORY]
        entries = dirs + files
    
    # 统计
    total_count = len(entries)
    directory_count = sum(1 for e in entries if e.type == FileType.DIRECTORY)
    file_count = total_count - directory_count
    total_size = sum(e.size for e in entries)
    
    # 分页
    if limit > 0:
        entries = entries[offset:offset + limit]
    elif offset > 0:
        entries = entries[offset:]
    
    # 计算父目录
    parent = None
    if resolved != root:
        try:
            parent = "/" + str(resolved.parent.relative_to(root))
        except ValueError:
            parent = "/"
    
    return DirectoryListResponse(
        path="/" + str(resolved.relative_to(root)) if resolved != root else "/",
        parent=parent,
        entries=entries,
        total_count=total_count,
        directory_count=directory_count,
        file_count=file_count,
        total_size=total_size,
    )


@router.get(
    "/info",
    response_model=FileInfoResponse,
    response_model_by_alias=True,
    responses={
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
    summary="获取文件信息",
)
async def get_file_info(
    path: str = Query(..., description="文件路径"),
    fast_fs: FastFSLoader = Depends(get_fast_fs),
) -> FileInfoResponse:
    """获取文件或目录的详细信息"""
    from datetime import datetime
    import mimetypes
    
    root = Path(settings.ROOT_PATH).resolve()
    resolved = _validate_path(path, root)
    
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    
    try:
        info = fast_fs.get_file_info(str(resolved))
    except Exception as e:
        logger.error(f"获取文件信息失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
    # 获取 stat 信息
    stat_info = resolved.stat()
    
    # 确定文件类型
    if resolved.is_symlink():
        file_type = FileType.SYMLINK
    elif resolved.is_dir():
        file_type = FileType.DIRECTORY
    else:
        file_type = FileType.FILE
    
    # 获取 MIME 类型
    mime_type = None
    if file_type == FileType.FILE:
        mime_type, _ = mimetypes.guess_type(str(resolved))
    
    return FileInfoResponse(
        path="/" + str(resolved.relative_to(root)),
        name=resolved.name,
        size=info.get("size", stat_info.st_size),
        mtime=stat_info.st_mtime,
        mtime_iso=datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
        type=file_type,
        permissions=_permissions_to_string(stat_info.st_mode),
        mime_type=mime_type,
        is_readable=os.access(resolved, os.R_OK),
        is_writable=os.access(resolved, os.W_OK),
        is_executable=os.access(resolved, os.X_OK),
    )


@router.get(
    "/download",
    summary="下载文件（Zero-Copy）",
    description="使用 sendfile 系统调用实现零拷贝传输",
)
async def download_file(
    path: str = Query(..., description="文件路径"),
    attachment: bool = Query(True, description="作为附件下载"),
) -> Response:
    """
    下载文件
    
    使用自定义的 ZeroCopyFileResponse 实现零拷贝传输：
    - Linux: 使用 os.sendfile()
    - 其他平台: 降级到标准流式传输
    
    不会将文件内容读入 Python 内存！
    """
    root = Path(settings.ROOT_PATH).resolve()
    resolved = _validate_path(path, root)
    
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    
    # 检查文件大小限制
    file_size = resolved.stat().st_size
    if file_size > settings.MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max size: {settings.MAX_FILE_SIZE} bytes"
        )
    
    # 返回零拷贝响应
    return ZeroCopyFileResponse(
        path=str(resolved),
        filename=resolved.name if attachment else None,
        media_type="application/octet-stream",
    )


@router.get(
    "/hash",
    response_model=HashResponse,
    response_model_by_alias=True,
    summary="计算文件哈希",
)
async def calculate_hash(
    path: str = Query(..., description="文件路径"),
    fast_fs: FastFSLoader = Depends(get_fast_fs),
) -> HashResponse:
    """
    计算文件的 BLAKE3 哈希值
    
    使用 C++ 扩展进行高性能哈希计算。
    """
    import time
    
    root = Path(settings.ROOT_PATH).resolve()
    resolved = _validate_path(path, root)
    
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    
    start_time = time.perf_counter()
    
    try:
        hash_value = fast_fs.calculate_blake3(str(resolved))
    except Exception as e:
        logger.error(f"哈希计算失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
    duration_ms = (time.perf_counter() - start_time) * 1000
    
    return HashResponse(
        path="/" + str(resolved.relative_to(root)),
        algorithm="blake3" if fast_fs.is_available else "sha256",
        hash=hash_value,
        size=resolved.stat().st_size,
        duration_ms=round(duration_ms, 2),
    )


@router.post(
    "/hash/batch",
    summary="批量计算哈希",
)
async def calculate_hash_batch(
    request: BatchHashRequest,
    fast_fs: FastFSLoader = Depends(get_fast_fs),
) -> Dict[str, Any]:
    """
    批量计算多个文件的哈希值
    
    使用多线程并行计算，显著提升大量文件的处理速度。
    """
    import time
    
    root = Path(settings.ROOT_PATH).resolve()
    
    # 验证并解析所有路径
    valid_paths = []
    errors = {}
    
    for p in request.paths:
        try:
            resolved = _validate_path(p, root)
            if resolved.is_file():
                valid_paths.append(str(resolved))
            else:
                errors[p] = "Not a file"
        except HTTPException as e:
            errors[p] = e.detail.get("error", "Validation failed")
        except Exception as e:
            errors[p] = str(e)
    
    start_time = time.perf_counter()
    
    try:
        results = fast_fs.calculate_blake3_batch(
            valid_paths,
            settings.HASH_THREADS,
        )
    except Exception as e:
        logger.error(f"批量哈希计算失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
    duration_ms = (time.perf_counter() - start_time) * 1000
    
    # 转换路径为相对路径
    converted_results = {}
    for abs_path, value in results.items():
        try:
            rel_path = "/" + str(Path(abs_path).relative_to(root))
            converted_results[rel_path] = value
        except ValueError:
            converted_results[abs_path] = value
    
    return {
        "success": True,
        "algorithm": "blake3" if fast_fs.is_available else "sha256",
        "results": converted_results,
        "errors": errors,
        "total": len(request.paths),
        "successful": len(valid_paths),
        "failed": len(errors),
        "duration_ms": round(duration_ms, 2),
    }
