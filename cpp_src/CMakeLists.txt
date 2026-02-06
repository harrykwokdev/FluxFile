# ============================================================================
# FluxFile fast_fs C++ Extension - CMake 配置文件
# ============================================================================
# 
# 本文件配置 fast_fs Python 扩展模块的构建过程。
# 使用 pybind11 将 C++ 代码编译为 Python 可导入的 .so/.pyd 文件。
#
# 构建命令：
#   mkdir build && cd build
#   cmake .. -DPYTHON_EXECUTABLE=$(which python3)
#   make -j$(nproc)
#
# ============================================================================

cmake_minimum_required(VERSION 3.16)
project(fast_fs VERSION 1.0.0 LANGUAGES CXX C)

# ============================================================================
# 编译器配置
# ============================================================================

# 要求 C++17 标准（用于 std::filesystem）
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# C 标准（用于 BLAKE3）
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# 优化选项
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Release 模式下的优化标志
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -march=native")
set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG -march=native")

# Debug 模式下的标志
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -Wall -Wextra -Wpedantic")
set(CMAKE_C_FLAGS_DEBUG "-g -O0 -Wall -Wextra")

# ============================================================================
# 依赖：Pybind11
# ============================================================================

# 方式 1：通过 pip 安装的 pybind11
find_package(pybind11 CONFIG)

# 方式 2：如果未找到，尝试从子目录加载
if(NOT pybind11_FOUND)
    # 检查是否有本地 pybind11 副本
    if(EXISTS "${CMAKE_SOURCE_DIR}/third_party/pybind11/CMakeLists.txt")
        add_subdirectory(third_party/pybind11)
    else()
        # 使用 FetchContent 下载 pybind11
        include(FetchContent)
        FetchContent_Declare(
            pybind11
            GIT_REPOSITORY https://github.com/pybind/pybind11.git
            GIT_TAG        v2.11.1
        )
        FetchContent_MakeAvailable(pybind11)
    endif()
endif()

# ============================================================================
# 依赖：BLAKE3
# ============================================================================

# BLAKE3 源文件（需要下载到 third_party/blake3/）
set(BLAKE3_DIR "${CMAKE_SOURCE_DIR}/third_party/blake3")

# 检查 BLAKE3 是否存在
if(NOT EXISTS "${BLAKE3_DIR}/blake3.c")
    message(STATUS "BLAKE3 not found, will download during build")
    
    # 使用 FetchContent 下载 BLAKE3
    include(FetchContent)
    FetchContent_Declare(
        blake3
        GIT_REPOSITORY https://github.com/BLAKE3-team/BLAKE3.git
        GIT_TAG        1.4.1
        SOURCE_SUBDIR  c  # 只需要 C 实现
    )
    FetchContent_GetProperties(blake3)
    if(NOT blake3_POPULATED)
        FetchContent_Populate(blake3)
        set(BLAKE3_DIR "${blake3_SOURCE_DIR}/c")
    endif()
endif()

# BLAKE3 源文件
set(BLAKE3_SOURCES
    ${BLAKE3_DIR}/blake3.c
    ${BLAKE3_DIR}/blake3_dispatch.c
    ${BLAKE3_DIR}/blake3_portable.c
)

# 根据平台添加优化实现
if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|amd64")
    # x86-64 平台：添加 SSE/AVX 优化
    list(APPEND BLAKE3_SOURCES
        ${BLAKE3_DIR}/blake3_sse2_x86-64_unix.S
        ${BLAKE3_DIR}/blake3_sse41_x86-64_unix.S
        ${BLAKE3_DIR}/blake3_avx2_x86-64_unix.S
        ${BLAKE3_DIR}/blake3_avx512_x86-64_unix.S
    )
    # 注意：Windows 使用不同的汇编文件
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|ARM64|arm64")
    # ARM64 平台：添加 NEON 优化
    list(APPEND BLAKE3_SOURCES
        ${BLAKE3_DIR}/blake3_neon.c
    )
    add_compile_definitions(BLAKE3_USE_NEON)
endif()

# 创建 BLAKE3 静态库
add_library(blake3 STATIC ${BLAKE3_SOURCES})
target_include_directories(blake3 PUBLIC ${BLAKE3_DIR})

# ============================================================================
# fast_fs Python 扩展模块
# ============================================================================

# 创建 Python 模块
pybind11_add_module(fast_fs 
    fast_fs.cpp
)

# 链接 BLAKE3
target_link_libraries(fast_fs PRIVATE blake3)

# 头文件路径
target_include_directories(fast_fs PRIVATE 
    ${CMAKE_SOURCE_DIR}
    ${BLAKE3_DIR}
)

# Linux 需要链接 pthread 和 stdc++fs
if(UNIX AND NOT APPLE)
    target_link_libraries(fast_fs PRIVATE pthread)
    # GCC 8 及更早版本需要单独链接 filesystem
    if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS 9)
        target_link_libraries(fast_fs PRIVATE stdc++fs)
    endif()
endif()

# macOS 特定设置
if(APPLE)
    # 确保使用正确的 macOS SDK
    target_compile_options(fast_fs PRIVATE -stdlib=libc++)
endif()

# ============================================================================
# 安装配置
# ============================================================================

# 获取 Python site-packages 路径
execute_process(
    COMMAND ${PYTHON_EXECUTABLE} -c "import site; print(site.getsitepackages()[0])"
    OUTPUT_VARIABLE PYTHON_SITE_PACKAGES
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

# 安装目标
install(TARGETS fast_fs
    LIBRARY DESTINATION ${PYTHON_SITE_PACKAGES}
)

# ============================================================================
# 测试配置（可选）
# ============================================================================

option(BUILD_TESTS "Build tests" OFF)

if(BUILD_TESTS)
    enable_testing()
    
    # 创建测试可执行文件
    add_executable(test_fast_fs tests/test_fast_fs.cpp)
    target_link_libraries(test_fast_fs PRIVATE blake3)
    target_include_directories(test_fast_fs PRIVATE 
        ${CMAKE_SOURCE_DIR}
        ${BLAKE3_DIR}
    )
    
    add_test(NAME test_fast_fs COMMAND test_fast_fs)
endif()

# ============================================================================
# 输出构建信息
# ============================================================================

message(STATUS "========================================")
message(STATUS "FluxFile fast_fs Build Configuration")
message(STATUS "========================================")
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "C++ Compiler: ${CMAKE_CXX_COMPILER}")
message(STATUS "C++ Flags: ${CMAKE_CXX_FLAGS_RELEASE}")
message(STATUS "BLAKE3 Dir: ${BLAKE3_DIR}")
message(STATUS "Python: ${PYTHON_EXECUTABLE}")
message(STATUS "========================================")
