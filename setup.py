"""
FluxFile - setup.py
=====================

此文件用于编译和安装 fast_fs C++ 扩展模块。

安装方式：
---------
1. 开发模式安装（推荐开发时使用）：
   pip install -e .

2. 普通安装：
   pip install .

3. 构建 wheel：
   pip wheel .

依赖项：
-------
- pybind11 >= 2.10.0
- CMake >= 3.16
- C++17 兼容编译器 (GCC 8+, Clang 10+, MSVC 2019+)

注意事项：
---------
- macOS M1/M2 芯片需要 arm64 版本的 Python
- Windows 需要 Visual Studio 2019 或更高版本
- Linux 需要 GCC 8+ 或 Clang 10+
"""

import os
import sys
import subprocess
import platform
from pathlib import Path

from setuptools import setup, Extension, find_packages
from setuptools.command.build_ext import build_ext


class CMakeExtension(Extension):
    """
    CMake 扩展类
    
    此类表示一个由 CMake 构建的扩展模块。
    与标准的 setuptools Extension 不同，它不需要指定源文件列表，
    因为构建过程完全由 CMake 控制。
    """
    
    def __init__(self, name: str, sourcedir: str = ""):
        """
        初始化 CMake 扩展
        
        Args:
            name: 扩展模块名称（如 "fast_fs"）
            sourcedir: CMakeLists.txt 所在目录的路径
        """
        super().__init__(name, sources=[])
        self.sourcedir = os.path.abspath(sourcedir)


class CMakeBuild(build_ext):
    """
    CMake 构建命令类
    
    此类重写 setuptools 的 build_ext 命令，使用 CMake 来构建扩展。
    支持 Windows、macOS 和 Linux 平台。
    """
    
    def build_extension(self, ext: CMakeExtension) -> None:
        """
        构建单个扩展模块
        
        构建流程：
        1. 创建构建目录
        2. 配置 CMake（生成构建文件）
        3. 执行构建
        4. 将输出文件复制到正确位置
        """
        # 获取扩展输出路径
        ext_fullpath = Path.cwd() / self.get_ext_fullpath(ext.name)
        extdir = ext_fullpath.parent.resolve()
        
        # 确定 CMake 构建类型
        # 使用 DEBUG 环境变量来控制
        debug = int(os.environ.get("DEBUG", 0)) if self.debug is None else self.debug
        cfg = "Debug" if debug else "Release"

        # CMake 配置参数
        cmake_args = [
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={extdir}",
            f"-DPYTHON_EXECUTABLE={sys.executable}",
            f"-DCMAKE_BUILD_TYPE={cfg}",
        ]
        
        # 构建参数
        build_args = []
        
        # 平台特定配置
        if platform.system() == "Windows":
            # Windows: 使用 Visual Studio 生成器
            cmake_args += [
                f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY_{cfg.upper()}={extdir}",
            ]
            # 根据 Python 架构选择平台
            if sys.maxsize > 2**32:
                cmake_args += ["-A", "x64"]
            else:
                cmake_args += ["-A", "Win32"]
            build_args += ["--config", cfg]
        else:
            # Unix-like 系统
            # 使用 Ninja 如果可用，否则使用 Makefile
            try:
                subprocess.check_call(["ninja", "--version"], 
                    stdout=subprocess.DEVNULL, 
                    stderr=subprocess.DEVNULL)
                cmake_args += ["-G", "Ninja"]
            except (subprocess.CalledProcessError, FileNotFoundError):
                pass  # 使用默认生成器

        # 使用 ccache 加速编译（如果可用）
        if self._is_command_available("ccache"):
            cmake_args += [
                "-DCMAKE_C_COMPILER_LAUNCHER=ccache",
                "-DCMAKE_CXX_COMPILER_LAUNCHER=ccache",
            ]

        # 设置并行编译任务数
        if "CMAKE_BUILD_PARALLEL_LEVEL" not in os.environ:
            # 检查 CPU 核心数
            try:
                import multiprocessing
                parallel_jobs = multiprocessing.cpu_count()
            except:
                parallel_jobs = 2
            build_args += ["-j", str(parallel_jobs)]

        # 创建构建目录
        build_temp = Path(self.build_temp) / ext.name
        build_temp.mkdir(parents=True, exist_ok=True)

        # 执行 CMake 配置
        print(f"\n{'='*60}")
        print(f"Configuring {ext.name} with CMake")
        print(f"{'='*60}")
        print(f"Source directory: {ext.sourcedir}")
        print(f"Build directory: {build_temp}")
        print(f"Output directory: {extdir}")
        print(f"Build type: {cfg}")
        print(f"CMake args: {' '.join(cmake_args)}")
        print(f"{'='*60}\n")
        
        subprocess.check_call(
            ["cmake", ext.sourcedir] + cmake_args,
            cwd=build_temp,
        )

        # 执行构建
        print(f"\n{'='*60}")
        print(f"Building {ext.name}")
        print(f"{'='*60}\n")
        
        subprocess.check_call(
            ["cmake", "--build", "."] + build_args,
            cwd=build_temp,
        )
        
        print(f"\n{'='*60}")
        print(f"Successfully built {ext.name}")
        print(f"Output: {ext_fullpath}")
        print(f"{'='*60}\n")

    @staticmethod
    def _is_command_available(command: str) -> bool:
        """检查命令是否可用"""
        try:
            subprocess.check_call(
                [command, "--version"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False


# ============================================================================
# 项目元数据和配置
# ============================================================================

# 读取 README
readme_path = Path(__file__).parent / "README.md"
long_description = ""
if readme_path.exists():
    long_description = readme_path.read_text(encoding="utf-8")

# 读取版本号
VERSION = "1.0.0"

setup(
    name="fluxfile",
    version=VERSION,
    author="FluxFile Team",
    author_email="fluxfile@example.com",
    description="高性能内网文件传输系统",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/fluxfile/fluxfile",
    
    # Python 版本要求
    python_requires=">=3.9",
    
    # 包配置
    packages=find_packages(where="backend"),
    package_dir={"": "backend"},
    
    # C++ 扩展模块
    ext_modules=[
        CMakeExtension("fast_fs", sourcedir="cpp_src"),
    ],
    cmdclass={"build_ext": CMakeBuild},
    
    # 构建依赖
    setup_requires=[
        "pybind11>=2.10.0",
    ],
    
    # 运行时依赖
    install_requires=[
        "fastapi>=0.100.0",
        "uvicorn[standard]>=0.23.0",
        "python-multipart>=0.0.6",
        "aiofiles>=23.0.0",
        "redis>=4.5.0",
        "clickhouse-driver>=0.2.5",
        "python-ldap>=3.4.0",
        "casbin>=1.20.0",
        "pydantic>=2.0.0",
        "pydantic-settings>=2.0.0",
    ],
    
    # 开发依赖
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-asyncio>=0.21.0",
            "pytest-cov>=4.0.0",
            "black>=23.0.0",
            "isort>=5.12.0",
            "mypy>=1.0.0",
            "ruff>=0.0.270",
        ],
    },
    
    # 分类信息
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Programming Language :: C++",
        "Topic :: System :: Filesystems",
        "Topic :: Internet :: WWW/HTTP :: HTTP Servers",
    ],
    
    # 不压缩安装（方便调试）
    zip_safe=False,
)
