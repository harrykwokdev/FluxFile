"""
FluxFile - 自定义响应类
=========================

实现高性能的文件响应，核心是 Zero-Copy 传输。

关键技术：
1. 使用 os.sendfile() 系统调用（Linux）
2. 文件内容直接从内核空间发送到 socket，不经过用户空间
3. 严禁将文件内容读入 Python 内存
"""

import asyncio
import mimetypes
import os
import stat
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from starlette.background import BackgroundTask
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from app.core.logging import get_logger

logger = get_logger(__name__)


# ============================================================================
# Zero-Copy 文件响应
# ============================================================================

class ZeroCopyFileResponse(Response):
    """
    零拷贝文件响应类
    
    核心原理：
    -----------
    传统文件传输流程（4 次拷贝）：
    1. 磁盘 -> 内核缓冲区（DMA 拷贝）
    2. 内核缓冲区 -> 用户空间缓冲区（CPU 拷贝）
    3. 用户空间缓冲区 -> socket 缓冲区（CPU 拷贝）
    4. socket 缓冲区 -> 网卡（DMA 拷贝）
    
    sendfile 零拷贝流程（2 次拷贝）：
    1. 磁盘 -> 内核缓冲区（DMA 拷贝）
    2. 内核缓冲区 -> 网卡（DMA 拷贝）
    
    实现要点：
    ----------
    1. Linux 使用 os.sendfile()
    2. macOS 使用 os.sendfile()（API 略有不同）
    3. Windows 使用 TransmitFile（需要 pywin32）
    4. 降级方案：使用 aiofiles 流式传输
    
    严禁：
    ------
    - 将文件读入 Python bytes 对象
    - 使用 f.read() 读取整个文件
    - 在 Python 层面处理文件内容
    """
    
    # 最大单次传输大小（避免长时间阻塞）
    SENDFILE_CHUNK_SIZE = 64 * 1024 * 1024  # 64MB
    
    # 流式传输的块大小（降级方案）
    STREAM_CHUNK_SIZE = 256 * 1024  # 256KB
    
    def __init__(
        self,
        path: str,
        status_code: int = 200,
        headers: Optional[Mapping[str, str]] = None,
        media_type: Optional[str] = None,
        filename: Optional[str] = None,
        background: Optional[BackgroundTask] = None,
        stat_result: Optional[os.stat_result] = None,
    ):
        """
        初始化 Zero-Copy 文件响应
        
        Args:
            path: 文件路径
            status_code: HTTP 状态码
            headers: 额外的响应头
            media_type: MIME 类型（自动检测）
            filename: 下载时的文件名（设置 Content-Disposition）
            background: 后台任务
            stat_result: 预先获取的 stat 结果（避免重复调用）
        """
        self.path = path
        self.filename = filename
        self.background = background
        
        # 获取文件信息
        if stat_result is None:
            stat_result = os.stat(path)
        self.stat_result = stat_result
        self.file_size = stat_result.st_size
        
        # 确定 MIME 类型
        if media_type is None:
            media_type, _ = mimetypes.guess_type(path)
            if media_type is None:
                media_type = "application/octet-stream"
        
        # 构建响应头
        response_headers: Dict[str, str] = {}
        
        # Content-Length
        response_headers["content-length"] = str(self.file_size)
        
        # Content-Type
        response_headers["content-type"] = media_type
        
        # ETag（基于文件修改时间和大小）
        etag = f'"{stat_result.st_mtime:.6f}-{stat_result.st_size}"'
        response_headers["etag"] = etag
        
        # Last-Modified
        from email.utils import formatdate
        response_headers["last-modified"] = formatdate(
            stat_result.st_mtime, usegmt=True
        )
        
        # Content-Disposition（如果指定了文件名）
        if filename:
            # 处理非 ASCII 文件名
            try:
                filename.encode("ascii")
                response_headers["content-disposition"] = (
                    f'attachment; filename="{filename}"'
                )
            except UnicodeEncodeError:
                # RFC 5987 编码
                from urllib.parse import quote
                encoded = quote(filename, safe="")
                response_headers["content-disposition"] = (
                    f"attachment; filename*=UTF-8''{encoded}"
                )
        
        # Accept-Ranges（支持断点续传）
        response_headers["accept-ranges"] = "bytes"
        
        # 合并用户提供的头
        if headers:
            response_headers.update(headers)
        
        # 初始化父类
        super().__init__(
            content=None,
            status_code=status_code,
            headers=response_headers,
            media_type=media_type,
            background=background,
        )
    
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """
        ASGI 接口实现
        
        根据平台选择最优传输方式：
        1. 尝试使用 sendfile 零拷贝
        2. 降级到流式传输
        """
        # 发送响应头
        await send({
            "type": "http.response.start",
            "status": self.status_code,
            "headers": self.raw_headers,
        })
        
        # 发送文件内容
        if self.file_size > 0:
            # 尝试零拷贝传输
            if await self._try_sendfile(scope, send):
                pass  # 成功
            else:
                # 降级到流式传输
                await self._stream_file(send)
        
        # 发送结束标记
        await send({
            "type": "http.response.body",
            "body": b"",
            "more_body": False,
        })
        
        # 执行后台任务
        if self.background is not None:
            await self.background()
    
    async def _try_sendfile(self, scope: Scope, send: Send) -> bool:
        """
        尝试使用 sendfile 系统调用
        
        返回 True 表示成功，False 表示需要降级
        """
        # 检查是否支持 sendfile
        if not hasattr(os, "sendfile"):
            logger.debug("当前平台不支持 os.sendfile")
            return False
        
        # 尝试获取底层 socket 文件描述符
        # 注意：这依赖于 ASGI 服务器的实现
        # uvicorn 支持通过 scope["transport"] 获取
        transport = scope.get("transport")
        if transport is None:
            logger.debug("无法获取 transport，降级到流式传输")
            return False
        
        try:
            # 获取 socket 文件描述符
            # 注意：这是实现特定的，可能在某些服务器上不可用
            socket = transport.get_extra_info("socket")
            if socket is None:
                logger.debug("无法获取 socket，降级到流式传输")
                return False
            
            sock_fd = socket.fileno()
            if sock_fd < 0:
                return False
            
            # 打开源文件
            file_fd = os.open(self.path, os.O_RDONLY)
            
            try:
                offset = 0
                remaining = self.file_size
                
                while remaining > 0:
                    # 计算本次传输大小
                    chunk_size = min(remaining, self.SENDFILE_CHUNK_SIZE)
                    
                    # 在线程池中执行 sendfile（避免阻塞事件循环）
                    loop = asyncio.get_event_loop()
                    sent = await loop.run_in_executor(
                        None,
                        self._do_sendfile,
                        sock_fd,
                        file_fd,
                        offset,
                        chunk_size,
                    )
                    
                    if sent == 0:
                        # 对端关闭连接
                        break
                    
                    offset += sent
                    remaining -= sent
                
                logger.debug(
                    f"sendfile 传输完成: {self.path}, "
                    f"大小: {self.file_size}, 发送: {offset}"
                )
                return True
                
            finally:
                os.close(file_fd)
        
        except (AttributeError, OSError) as e:
            logger.warning(f"sendfile 失败，降级到流式传输: {e}")
            return False
    
    @staticmethod
    def _do_sendfile(
        out_fd: int,
        in_fd: int,
        offset: int,
        count: int,
    ) -> int:
        """
        执行 sendfile 系统调用
        
        这是阻塞操作，应在线程池中执行
        """
        import sys
        
        if sys.platform == "linux":
            # Linux: sendfile(out_fd, in_fd, offset, count)
            return os.sendfile(out_fd, in_fd, offset, count)
        
        elif sys.platform == "darwin":
            # macOS Python os.sendfile 签名:
            # os.sendfile(out_fd, in_fd, offset, count) -> sent_bytes
            # 注意: macOS 的 Python 封装参数顺序与 Linux 相同
            # 但底层 sendfile(2) 的 C API 不同
            try:
                return os.sendfile(out_fd, in_fd, offset, count)
            except (TypeError, OSError) as e:
                raise OSError(f"sendfile not supported on this macOS: {e}")
        
        else:
            raise OSError("sendfile not supported on this platform")
    
    async def _stream_file(self, send: Send) -> None:
        """
        流式传输文件（降级方案）
        
        使用 aiofiles 异步读取文件并发送。
        虽然会经过 Python 内存，但仍然是高效的流式处理。
        """
        try:
            import aiofiles
            
            async with aiofiles.open(self.path, "rb") as f:
                while True:
                    chunk = await f.read(self.STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    
                    await send({
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    })
            
            logger.debug(f"流式传输完成: {self.path}")
        
        except ImportError:
            # 如果没有 aiofiles，使用同步方式在线程池中读取
            loop = asyncio.get_event_loop()
            
            with open(self.path, "rb") as f:
                while True:
                    chunk = await loop.run_in_executor(
                        None, f.read, self.STREAM_CHUNK_SIZE
                    )
                    if not chunk:
                        break
                    
                    await send({
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    })


# ============================================================================
# 范围请求响应（断点续传支持）
# ============================================================================

class RangeFileResponse(ZeroCopyFileResponse):
    """
    支持 Range 请求的文件响应
    
    用于支持：
    - 断点续传
    - 视频流播放
    - 大文件分片下载
    """
    
    def __init__(
        self,
        path: str,
        range_header: Optional[str] = None,
        **kwargs,
    ):
        super().__init__(path, **kwargs)
        
        self.range_header = range_header
        self.start = 0
        self.end = self.file_size - 1
        
        if range_header:
            self._parse_range(range_header)
    
    def _parse_range(self, range_header: str) -> None:
        """解析 Range 请求头"""
        try:
            if not range_header.startswith("bytes="):
                return
            
            range_spec = range_header[6:]
            parts = range_spec.split("-")
            
            if parts[0]:
                self.start = int(parts[0])
            
            if len(parts) > 1 and parts[1]:
                self.end = int(parts[1])
            
            # 验证范围
            if self.start > self.end or self.end >= self.file_size:
                self.status_code = 416  # Range Not Satisfiable
                return
            
            # 设置部分响应
            self.status_code = 206
            content_length = self.end - self.start + 1
            
            self.headers["content-length"] = str(content_length)
            self.headers["content-range"] = (
                f"bytes {self.start}-{self.end}/{self.file_size}"
            )
        
        except (ValueError, IndexError):
            pass  # 无效的 Range 头，忽略
    
    async def _stream_file(self, send: Send) -> None:
        """流式传输指定范围的文件内容"""
        try:
            import aiofiles
            
            async with aiofiles.open(self.path, "rb") as f:
                await f.seek(self.start)
                remaining = self.end - self.start + 1
                
                while remaining > 0:
                    chunk_size = min(remaining, self.STREAM_CHUNK_SIZE)
                    chunk = await f.read(chunk_size)
                    
                    if not chunk:
                        break
                    
                    await send({
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    })
                    
                    remaining -= len(chunk)
        
        except ImportError:
            # 降级到同步实现
            loop = asyncio.get_event_loop()
            
            with open(self.path, "rb") as f:
                f.seek(self.start)
                remaining = self.end - self.start + 1
                
                while remaining > 0:
                    chunk_size = min(remaining, self.STREAM_CHUNK_SIZE)
                    chunk = await loop.run_in_executor(None, f.read, chunk_size)
                    
                    if not chunk:
                        break
                    
                    await send({
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    })
                    
                    remaining -= len(chunk)


# ============================================================================
# 目录打包响应
# ============================================================================

class DirectoryZipResponse(Response):
    """
    目录打包为 ZIP 流式响应
    
    不会在服务器上创建临时 ZIP 文件，而是直接流式输出。
    适合大目录的打包下载。
    """
    
    def __init__(
        self,
        directory: str,
        filename: Optional[str] = None,
        exclude_patterns: Optional[list] = None,
        background: Optional[BackgroundTask] = None,
    ):
        self.directory = directory
        self.exclude_patterns = exclude_patterns or []
        self.background = background
        
        # 设置文件名
        if filename is None:
            filename = Path(directory).name + ".zip"
        
        headers = {
            "content-type": "application/zip",
            "content-disposition": f'attachment; filename="{filename}"',
        }
        
        super().__init__(
            content=None,
            status_code=200,
            headers=headers,
            media_type="application/zip",
            background=background,
        )
    
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """流式生成 ZIP 文件"""
        import zipfile
        from io import BytesIO
        
        await send({
            "type": "http.response.start",
            "status": self.status_code,
            "headers": self.raw_headers,
        })
        
        # 使用内存中的单一 ZIP 文件，分批发送
        root = Path(self.directory)
        buffer = BytesIO()
        
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in root.rglob("*"):
                if file_path.is_file():
                    # 检查排除模式
                    rel_path = file_path.relative_to(root)
                    if any(rel_path.match(p) for p in self.exclude_patterns):
                        continue
                    
                    zf.write(file_path, rel_path)
                    
                    # 每累积一定数据后 flush 发送，避免内存过大
                    if buffer.tell() > 4 * 1024 * 1024:  # 4MB
                        await send({
                            "type": "http.response.body",
                            "body": buffer.getvalue(),
                            "more_body": True,
                        })
                        buffer.seek(0)
                        buffer.truncate()
        
        # 发送剩余数据（包含 ZIP 尾部标记）
        remaining = buffer.getvalue()
        if remaining:
            await send({
                "type": "http.response.body",
                "body": remaining,
                "more_body": True,
            })
        
        await send({
            "type": "http.response.body",
            "body": b"",
            "more_body": False,
        })
        
        if self.background is not None:
            await self.background()
