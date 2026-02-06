"""
FluxFile - 文件操作 API
==========================

提供文件系统操作接口：
- 目录浏览
- 文件下载（Zero-Copy）
- 文件上传
- 文件删除/移动/复制
- 文件哈希计算
"""

import os
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.services.filesystem import FileSystemService, _permissions_to_string

router = APIRouter()
logger = get_logger(__name__)

# 文件系统服务实例
fs_service = FileSystemService()


# ============================================================================
# 请求/响应模型
# ============================================================================

class FileInfo(BaseModel):
    """文件信息模型"""
    name: str = Field(..., description="文件名")
    path: str = Field(..., description="相对路径")
    size: int = Field(..., description="文件大小（字节）")
    mtime: float = Field(..., description="修改时间（Unix 时间戳）")
    is_directory: bool = Field(..., description="是否为目录")
    is_symlink: bool = Field(False, description="是否为符号链接")
    permissions: Optional[str] = Field(None, description="权限（如 rwxr-xr-x）")


class DirectoryListing(BaseModel):
    """目录列表响应模型"""
    path: str = Field(..., description="当前目录路径")
    parent: Optional[str] = Field(None, description="父目录路径")
    files: List[FileInfo] = Field(..., description="文件列表")
    total: int = Field(..., description="文件总数")


class HashResult(BaseModel):
    """哈希计算结果"""
    path: str
    algorithm: str = "blake3"
    hash: str
    size: int


class FileOperationRequest(BaseModel):
    """文件操作请求"""
    source: str = Field(..., description="源路径")
    destination: str = Field(..., description="目标路径")
    overwrite: bool = Field(False, description="是否覆盖已存在文件")


# ============================================================================
# API 端点
# ============================================================================

@router.get("/list", response_model=DirectoryListing)
async def list_directory(
    path: str = Query("/", description="目录路径"),
    show_hidden: bool = Query(False, description="显示隐藏文件"),
    sort_by: str = Query("name", description="排序字段: name, size, mtime"),
    sort_desc: bool = Query(False, description="降序排列"),
) -> DirectoryListing:
    """
    列出目录内容
    
    使用 C++ fast_fs 扩展进行高性能目录扫描。
    
    - **path**: 要浏览的目录路径
    - **show_hidden**: 是否显示以 . 开头的隐藏文件
    - **sort_by**: 排序字段 (name/size/mtime)
    - **sort_desc**: 是否降序排列
    
    Returns:
        目录内容列表
    """
    try:
        result = await fs_service.list_directory(
            path=path,
            show_hidden=show_hidden,
            sort_by=sort_by,
            sort_desc=sort_desc,
        )
        return result
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权访问此目录")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="目录不存在")
    except Exception as e:
        logger.error(f"目录列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/info")
async def get_file_info(
    path: str = Query(..., description="文件路径"),
) -> FileInfo:
    """
    获取文件详细信息
    
    - **path**: 文件或目录路径
    
    Returns:
        文件详细信息
    """
    try:
        info = await fs_service.get_file_info(path)
        # Convert permissions from int to rwx string if needed
        perms = info.get("permissions")
        if isinstance(perms, int):
            info["permissions"] = _permissions_to_string(perms)
        return FileInfo(
            name=info["name"],
            path=info["path"],
            size=info.get("size", 0),
            mtime=info["mtime"],
            is_directory=info.get("is_directory", False),
            is_symlink=info.get("is_symlink", False),
            permissions=info.get("permissions"),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="文件不存在")
    except Exception as e:
        logger.error(f"获取文件信息失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download")
async def download_file(
    path: str = Query(..., description="文件路径"),
) -> FileResponse:
    """
    下载文件（Zero-Copy）
    
    使用 os.sendfile 实现零拷贝传输，最大化传输效率。
    
    - **path**: 要下载的文件路径
    
    Returns:
        文件内容流
    """
    try:
        file_path = fs_service.validate_and_resolve_path(path)
        
        if not file_path.is_file():
            raise HTTPException(status_code=400, detail="路径不是文件")
        
        # 检查文件大小
        file_size = file_path.stat().st_size
        if file_size > settings.MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413, 
                detail=f"文件过大，最大允许 {settings.MAX_FILE_SIZE} 字节"
            )
        
        # 使用 FileResponse 自动处理 sendfile（需要 aiofiles）
        return FileResponse(
            path=str(file_path),
            filename=file_path.name,
            media_type="application/octet-stream",
        )
        
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权访问此文件")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="文件不存在")


@router.get("/hash", response_model=HashResult)
async def calculate_hash(
    path: str = Query(..., description="文件路径"),
) -> HashResult:
    """
    计算文件 BLAKE3 哈希
    
    使用 C++ 扩展进行高性能哈希计算。
    
    - **path**: 要计算哈希的文件路径
    
    Returns:
        哈希值和文件信息
    """
    try:
        return await fs_service.calculate_hash(path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="文件不存在")
    except Exception as e:
        logger.error(f"哈希计算失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/hash/batch")
async def calculate_hash_batch(
    paths: List[str],
) -> Dict[str, Any]:
    """
    批量计算文件哈希
    
    使用多线程并行计算多个文件的哈希值。
    
    - **paths**: 文件路径列表
    
    Returns:
        路径到哈希值的映射
    """
    try:
        return await fs_service.calculate_hash_batch(paths)
    except Exception as e:
        logger.error(f"批量哈希计算失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/mkdir")
async def create_directory(
    path: str = Query(..., description="目录路径"),
    parents: bool = Query(True, description="创建父目录"),
) -> Dict[str, str]:
    """
    创建目录
    
    - **path**: 要创建的目录路径
    - **parents**: 是否同时创建不存在的父目录
    
    Returns:
        操作结果
    """
    try:
        await fs_service.create_directory(path, parents=parents)
        return {"status": "success", "path": path}
    except FileExistsError:
        raise HTTPException(status_code=409, detail="目录已存在")
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权创建目录")
    except Exception as e:
        logger.error(f"创建目录失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/delete")
async def delete_file(
    path: str = Query(..., description="文件或目录路径"),
    recursive: bool = Query(False, description="递归删除目录"),
) -> Dict[str, str]:
    """
    删除文件或目录
    
    - **path**: 要删除的路径
    - **recursive**: 对于目录是否递归删除
    
    Returns:
        操作结果
    """
    try:
        await fs_service.delete(path, recursive=recursive)
        return {"status": "success", "path": path}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="文件不存在")
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权删除")
    except OSError as e:
        if "not empty" in str(e).lower():
            raise HTTPException(status_code=400, detail="目录非空，请使用 recursive=true")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/move")
async def move_file(
    request: FileOperationRequest,
) -> Dict[str, str]:
    """
    移动/重命名文件
    
    - **source**: 源路径
    - **destination**: 目标路径
    - **overwrite**: 是否覆盖已存在文件
    
    Returns:
        操作结果
    """
    try:
        await fs_service.move(
            request.source, 
            request.destination, 
            overwrite=request.overwrite,
        )
        return {
            "status": "success",
            "source": request.source,
            "destination": request.destination,
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="源文件不存在")
    except FileExistsError:
        raise HTTPException(status_code=409, detail="目标文件已存在")
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权操作")
    except Exception as e:
        logger.error(f"移动文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/copy")
async def copy_file(
    request: FileOperationRequest,
) -> Dict[str, str]:
    """
    复制文件
    
    - **source**: 源路径
    - **destination**: 目标路径
    - **overwrite**: 是否覆盖已存在文件
    
    Returns:
        操作结果
    """
    try:
        await fs_service.copy(
            request.source,
            request.destination,
            overwrite=request.overwrite,
        )
        return {
            "status": "success",
            "source": request.source,
            "destination": request.destination,
        }
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="源文件不存在")
    except FileExistsError:
        raise HTTPException(status_code=409, detail="目标文件已存在")
    except PermissionError:
        raise HTTPException(status_code=403, detail="无权操作")
    except Exception as e:
        logger.error(f"复制文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
