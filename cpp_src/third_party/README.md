# Third-party Dependencies

此目录用于存放第三方依赖：

- `blake3/` - BLAKE3 哈希库 C 实现
- `pybind11/` - Python C++ 绑定库（可选）

## 自动下载

运行 `./scripts/build.sh` 会自动下载所需依赖。

## 手动下载

```bash
# BLAKE3
git clone --depth 1 --branch 1.4.1 https://github.com/BLAKE3-team/BLAKE3.git
mv BLAKE3/c blake3
rm -rf BLAKE3

# pybind11（可选，pip 安装更方便）
git clone --depth 1 --branch v2.11.1 https://github.com/pybind/pybind11.git
```
