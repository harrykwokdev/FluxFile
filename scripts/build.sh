#!/bin/bash
# ============================================================================
# FluxFile - 构建脚本
# ============================================================================
# 
# 此脚本用于自动化 fast_fs C++ 扩展模块的编译和安装过程。
#
# 使用方法：
#   ./scripts/build.sh [选项]
#
# 选项：
#   --release     Release 模式编译（默认）
#   --debug       Debug 模式编译
#   --clean       清理构建目录后重新编译
#   --install     编译后安装到当前 Python 环境
#   --test        编译后运行测试
#   --help        显示帮助信息
#
# ============================================================================

set -e  # 遇错即停

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CPP_SRC_DIR="$PROJECT_ROOT/cpp_src"
BUILD_DIR="$PROJECT_ROOT/build"

# 默认选项
BUILD_TYPE="Release"
CLEAN_BUILD=false
DO_INSTALL=false
DO_TEST=false

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --release)
            BUILD_TYPE="Release"
            shift
            ;;
        --debug)
            BUILD_TYPE="Debug"
            shift
            ;;
        --clean)
            CLEAN_BUILD=true
            shift
            ;;
        --install)
            DO_INSTALL=true
            shift
            ;;
        --test)
            DO_TEST=true
            shift
            ;;
        --help)
            echo "FluxFile 构建脚本"
            echo ""
            echo "用法: ./scripts/build.sh [选项]"
            echo ""
            echo "选项:"
            echo "  --release     Release 模式编译（默认）"
            echo "  --debug       Debug 模式编译"
            echo "  --clean       清理构建目录后重新编译"
            echo "  --install     编译后安装到当前 Python 环境"
            echo "  --test        编译后运行测试"
            echo "  --help        显示帮助信息"
            exit 0
            ;;
        *)
            log_error "未知选项: $1"
            exit 1
            ;;
    esac
done

# ============================================================================
# 环境检查
# ============================================================================

log_info "正在检查构建环境..."

# 检查 Python
if ! command -v python3 &> /dev/null; then
    log_error "未找到 Python3，请先安装 Python 3.9+"
    exit 1
fi
PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
log_info "Python 版本: $PYTHON_VERSION"

# 检查 CMake
if ! command -v cmake &> /dev/null; then
    log_error "未找到 CMake，请先安装 CMake 3.16+"
    log_info "安装命令: pip install cmake 或 brew install cmake"
    exit 1
fi
CMAKE_VERSION=$(cmake --version | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
log_info "CMake 版本: $CMAKE_VERSION"

# 检查编译器
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    if ! command -v clang++ &> /dev/null; then
        log_error "未找到 Clang++，请安装 Xcode Command Line Tools"
        log_info "安装命令: xcode-select --install"
        exit 1
    fi
    CXX_COMPILER="clang++"
    CXX_VERSION=$(clang++ --version | head -n1)
else
    # Linux
    if command -v g++ &> /dev/null; then
        CXX_COMPILER="g++"
        CXX_VERSION=$(g++ --version | head -n1)
    elif command -v clang++ &> /dev/null; then
        CXX_COMPILER="clang++"
        CXX_VERSION=$(clang++ --version | head -n1)
    else
        log_error "未找到 C++ 编译器，请安装 GCC 或 Clang"
        exit 1
    fi
fi
log_info "C++ 编译器: $CXX_VERSION"

# 检查 pybind11
if ! python3 -c "import pybind11" &> /dev/null; then
    log_warning "未安装 pybind11，正在安装..."
    pip install pybind11
fi

# ============================================================================
# 下载 BLAKE3（如果需要）
# ============================================================================

BLAKE3_DIR="$CPP_SRC_DIR/third_party/blake3"

if [[ ! -f "$BLAKE3_DIR/blake3.c" ]]; then
    log_info "正在下载 BLAKE3..."
    mkdir -p "$CPP_SRC_DIR/third_party"
    
    # 使用 git clone 下载
    if command -v git &> /dev/null; then
        git clone --depth 1 --branch 1.4.1 \
            https://github.com/BLAKE3-team/BLAKE3.git \
            "$CPP_SRC_DIR/third_party/BLAKE3_temp"
        mv "$CPP_SRC_DIR/third_party/BLAKE3_temp/c" "$BLAKE3_DIR"
        rm -rf "$CPP_SRC_DIR/third_party/BLAKE3_temp"
    else
        # 使用 curl 下载
        curl -L https://github.com/BLAKE3-team/BLAKE3/archive/refs/tags/1.4.1.tar.gz \
            -o /tmp/blake3.tar.gz
        tar -xzf /tmp/blake3.tar.gz -C "$CPP_SRC_DIR/third_party"
        mv "$CPP_SRC_DIR/third_party/BLAKE3-1.4.1/c" "$BLAKE3_DIR"
        rm -rf "$CPP_SRC_DIR/third_party/BLAKE3-1.4.1" /tmp/blake3.tar.gz
    fi
    
    log_success "BLAKE3 下载完成"
fi

# ============================================================================
# 清理构建目录
# ============================================================================

if [[ "$CLEAN_BUILD" == true ]]; then
    log_info "正在清理构建目录..."
    rm -rf "$BUILD_DIR"
    rm -rf "$PROJECT_ROOT"/*.egg-info
    rm -rf "$PROJECT_ROOT"/dist
    find "$PROJECT_ROOT" -name "*.so" -delete
    find "$PROJECT_ROOT" -name "*.pyd" -delete
    log_success "清理完成"
fi

# ============================================================================
# 创建构建目录
# ============================================================================

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# ============================================================================
# CMake 配置
# ============================================================================

log_info "正在配置 CMake (${BUILD_TYPE} 模式)..."

CMAKE_ARGS=(
    "-DCMAKE_BUILD_TYPE=$BUILD_TYPE"
    "-DPYTHON_EXECUTABLE=$(which python3)"
)

# 使用 Ninja 如果可用
if command -v ninja &> /dev/null; then
    CMAKE_ARGS+=("-G" "Ninja")
    log_info "使用 Ninja 构建系统"
fi

cmake "$CPP_SRC_DIR" "${CMAKE_ARGS[@]}"

# ============================================================================
# 编译
# ============================================================================

log_info "正在编译 fast_fs 模块..."

# 获取 CPU 核心数
if [[ "$OSTYPE" == "darwin"* ]]; then
    NPROC=$(sysctl -n hw.ncpu)
else
    NPROC=$(nproc)
fi

cmake --build . -j "$NPROC"

log_success "编译完成!"

# 查找编译好的模块
if [[ "$OSTYPE" == "darwin"* ]]; then
    SO_FILE=$(find "$BUILD_DIR" -name "fast_fs*.so" | head -n1)
else
    SO_FILE=$(find "$BUILD_DIR" -name "fast_fs*.so" | head -n1)
fi

if [[ -n "$SO_FILE" ]]; then
    log_success "模块文件: $SO_FILE"
fi

# ============================================================================
# 安装（可选）
# ============================================================================

if [[ "$DO_INSTALL" == true ]]; then
    log_info "正在安装到 Python 环境..."
    cd "$PROJECT_ROOT"
    pip install -e .
    log_success "安装完成!"
fi

# ============================================================================
# 测试（可选）
# ============================================================================

if [[ "$DO_TEST" == true ]]; then
    log_info "正在运行测试..."
    cd "$PROJECT_ROOT"
    
    # 简单测试：导入模块
    python3 -c "
import fast_fs
print(f'fast_fs version: {fast_fs.__version__}')
print('Module imported successfully!')

# 测试 scandir
import tempfile
import os

with tempfile.TemporaryDirectory() as tmpdir:
    # 创建测试文件
    for i in range(10):
        with open(os.path.join(tmpdir, f'test_{i}.txt'), 'w') as f:
            f.write(f'Test content {i}')
    
    # 扫描目录
    files = fast_fs.scandir_recursive(tmpdir)
    print(f'Scanned {len(files)} files')
    
    # 测试哈希
    test_file = os.path.join(tmpdir, 'test_0.txt')
    hash_value = fast_fs.calculate_blake3(test_file)
    print(f'BLAKE3 hash: {hash_value}')

print('All tests passed!')
"
    
    log_success "测试完成!"
fi

# ============================================================================
# 完成
# ============================================================================

echo ""
log_success "=========================================="
log_success "FluxFile fast_fs 构建成功!"
log_success "=========================================="
echo ""
echo "下一步："
echo "  1. 安装开发模式: pip install -e ."
echo "  2. 在 Python 中使用:"
echo "     >>> import fast_fs"
echo "     >>> files = fast_fs.scandir_recursive('/path/to/dir')"
echo ""
