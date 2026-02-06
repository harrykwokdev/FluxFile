/**
 * @file blake3.h
 * @brief BLAKE3 头文件包装器
 *
 * 此文件作为 BLAKE3 库的包装器头文件。
 * 在构建时，CMake 会自动下载完整的 BLAKE3 库到 third_party/blake3 目录。
 *
 * 如果你手动安装 BLAKE3，请将此文件替换为实际的 blake3.h 或确保
 * 包含路径正确指向 BLAKE3 库目录。
 *
 * BLAKE3 特性：
 * - 比 SHA-256 快 5-10 倍
 * - 256-bit 安全性
 * - 支持并行计算
 * - 支持增量更新
 *
 * 下载 BLAKE3 源码：
 *   git clone https://github.com/BLAKE3-team/BLAKE3.git third_party/blake3
 *
 * 或者使用 CMake FetchContent（自动）
 */

#ifndef BLAKE3_H
#define BLAKE3_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

    // ============================================================================
    // BLAKE3 常量定义
    // ============================================================================

#define BLAKE3_VERSION_STRING "1.4.1"
#define BLAKE3_KEY_LEN 32
#define BLAKE3_OUT_LEN 32
#define BLAKE3_BLOCK_LEN 64
#define BLAKE3_CHUNK_LEN 1024
#define BLAKE3_MAX_DEPTH 54

    // ============================================================================
    // BLAKE3 Hasher 结构体
    // ============================================================================

    /**
     * @brief BLAKE3 哈希器状态结构体
     *
     * 此结构体包含 BLAKE3 算法的完整状态。
     * 大小约为 1912 字节，可以安全地在栈上分配。
     *
     * 使用方式：
     *   blake3_hasher hasher;
     *   blake3_hasher_init(&hasher);
     *   blake3_hasher_update(&hasher, input, len);
     *   blake3_hasher_finalize(&hasher, output, BLAKE3_OUT_LEN);
     */
    typedef struct
    {
        uint32_t key[8];
        uint64_t chunk_counter;
        uint8_t buf[BLAKE3_BLOCK_LEN];
        uint8_t buf_len;
        uint8_t blocks_compressed;
        uint8_t flags;
        // 内部使用的 CV 栈
        uint8_t cv_stack_len;
        uint8_t cv_stack[(BLAKE3_MAX_DEPTH + 1) * BLAKE3_OUT_LEN];
    } blake3_hasher;

    // ============================================================================
    // BLAKE3 API 函数声明
    // ============================================================================

    /**
     * @brief 初始化 BLAKE3 hasher（普通哈希模式）
     *
     * @param self 指向 blake3_hasher 结构体的指针
     */
    void blake3_hasher_init(blake3_hasher *self);

    /**
     * @brief 初始化 BLAKE3 hasher（带密钥模式）
     *
     * 使用 32 字节密钥初始化，用于 MAC（消息认证码）
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param key 32 字节的密钥
     */
    void blake3_hasher_init_keyed(blake3_hasher *self,
                                  const uint8_t key[BLAKE3_KEY_LEN]);

    /**
     * @brief 初始化 BLAKE3 hasher（密钥派生模式）
     *
     * 从上下文字符串派生密钥
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param context 上下文字符串
     * @param context_len 上下文字符串长度
     */
    void blake3_hasher_init_derive_key(blake3_hasher *self, const char *context,
                                       size_t context_len);

    /**
     * @brief 使用原始上下文初始化 BLAKE3 hasher（密钥派生模式）
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param context 原始上下文数据
     * @param context_len 上下文数据长度
     */
    void blake3_hasher_init_derive_key_raw(blake3_hasher *self, const void *context,
                                           size_t context_len);

    /**
     * @brief 更新 BLAKE3 hasher 状态
     *
     * 可以多次调用以处理大文件或流数据
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param input 输入数据
     * @param input_len 输入数据长度
     */
    void blake3_hasher_update(blake3_hasher *self, const void *input,
                              size_t input_len);

    /**
     * @brief 完成哈希计算并输出结果
     *
     * 此函数不会修改 hasher 状态，可以多次调用获取不同长度的输出
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param out 输出缓冲区
     * @param out_len 期望的输出长度（通常为 BLAKE3_OUT_LEN）
     */
    void blake3_hasher_finalize(const blake3_hasher *self, uint8_t *out,
                                size_t out_len);

    /**
     * @brief 从指定位置完成哈希计算并输出结果
     *
     * 用于可扩展输出函数（XOF）场景
     *
     * @param self 指向 blake3_hasher 结构体的指针
     * @param seek 起始位置（字节偏移）
     * @param out 输出缓冲区
     * @param out_len 期望的输出长度
     */
    void blake3_hasher_finalize_seek(const blake3_hasher *self, uint64_t seek,
                                     uint8_t *out, size_t out_len);

    /**
     * @brief 重置 hasher 状态
     *
     * 保持原有的模式（普通/带密钥/密钥派生），但清除所有输入数据
     *
     * @param self 指向 blake3_hasher 结构体的指针
     */
    void blake3_hasher_reset(blake3_hasher *self);

#ifdef __cplusplus
}
#endif

#endif // BLAKE3_H
