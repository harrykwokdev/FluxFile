/**
 * FluxFile - 本地文件系统 Hook
 * ===============================
 * 
 * 使用 File System Access API 浏览本地文件系统。
 * 通过 IndexedDB 持久化目录句柄，实现"记住路径"功能。
 * 
 * 浏览器兼容性：
 * - Chrome 86+
 * - Edge 86+
 * - Opera 72+
 * - Firefox: 不支持（需降级方案）
 * 
 * @see https://developer.chrome.com/articles/file-system-access/
 */

import { useCallback, useEffect, useRef } from 'react';
import { get, set, del } from 'idb-keyval';
import { useFileStore } from '@/stores/fileStore';
import type { FileEntry, PanelId } from '@/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * File System Access API 支持检测
 */
export const isFileSystemAccessSupported = (): boolean => {
    return 'showDirectoryPicker' in window;
};

/**
 * IndexedDB 键前缀
 */
const IDB_KEY_PREFIX = 'fluxfile:local-handle:';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 从 File System Access API 读取目录内容
 */
async function readDirectory(
    handle: FileSystemDirectoryHandle,
    path: string = '/'
): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];

    // 添加父目录项（如果不是根目录）
    if (path !== '/') {
        entries.push({
            name: '..',
            path: path.split('/').slice(0, -1).join('/') || '/',
            type: 'directory',
            size: 0,
            mtime: 0,
            extension: undefined,
            isHidden: false,
        });
    }

    // 遍历目录
    for await (const entry of handle.values()) {
        const fileHandle = entry as FileSystemHandle;

        let size = 0;
        let mtime = 0;

        if (fileHandle.kind === 'file') {
            try {
                const file = await (fileHandle as FileSystemFileHandle).getFile();
                size = file.size;
                mtime = Math.floor(file.lastModified / 1000);
            } catch {
                // 无法访问文件，跳过
                continue;
            }
        }

        const name = fileHandle.name;
        const extension = fileHandle.kind === 'file'
            ? name.split('.').pop() || ''
            : undefined;

        entries.push({
            name,
            path: path === '/' ? `/${name}` : `${path}/${name}`,
            type: fileHandle.kind === 'directory' ? 'directory' : 'file',
            size,
            mtime,
            extension,
            isHidden: name.startsWith('.'),
        });
    }

    return entries;
}

/**
 * 按路径导航到子目录
 */
async function navigateToPath(
    rootHandle: FileSystemDirectoryHandle,
    path: string
): Promise<{
    handle: FileSystemDirectoryHandle;
    entries: FileEntry[];
}> {
    // 根目录
    if (path === '/' || path === '') {
        const entries = await readDirectory(rootHandle, '/');
        return { handle: rootHandle, entries };
    }

    // 分解路径
    const parts = path.split('/').filter(Boolean);
    let currentHandle = rootHandle;

    // 逐级导航
    for (const part of parts) {
        if (part === '..') {
            // 返回上级 - 需要重新从根目录导航
            const newPath = parts.slice(0, parts.indexOf(part)).join('/');
            return navigateToPath(rootHandle, newPath || '/');
        }

        try {
            currentHandle = await currentHandle.getDirectoryHandle(part);
        } catch (error) {
            throw new Error(`无法访问目录: ${part}`);
        }
    }

    const entries = await readDirectory(currentHandle, path);
    return { handle: currentHandle, entries };
}

// ============================================================================
// Hook 定义
// ============================================================================

interface UseLocalFileSystemOptions {
    /** 面板 ID */
    pane: PanelId;
    /** 是否自动恢复上次的目录 */
    autoRestore?: boolean;
}

interface UseLocalFileSystemReturn {
    /** 是否支持 File System Access API */
    isSupported: boolean;
    /** 打开目录选择器 */
    pickDirectory: () => Promise<void>;
    /** 导航到路径 */
    navigateTo: (path: string) => Promise<void>;
    /** 刷新当前目录 */
    refresh: () => Promise<void>;
    /** 返回上级目录 */
    navigateUp: () => Promise<void>;
    /** 清除保存的句柄 */
    clearSavedHandle: () => Promise<void>;
    /** 读取文件内容 */
    readFile: (path: string) => Promise<File | null>;
    /** 获取文件句柄（用于写入或其他操作） */
    getFileHandle: (path: string) => Promise<FileSystemFileHandle | null>;
}

/**
 * 本地文件系统 Hook
 */
export function useLocalFileSystem(
    options: UseLocalFileSystemOptions
): UseLocalFileSystemReturn {
    const { pane, autoRestore = true } = options;

    // 从 store 获取状态和 actions
    const {
        setEntries,
        setCurrentPath,
        setLoading,
        setError,
        setLocalHandle,
        sortEntries,
    } = useFileStore();

    // 获取面板状态
    const getPane = useFileStore((state) => state.getPane);

    // 保存根目录句柄的引用
    const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(null);

    // IndexedDB 键
    const idbKey = `${IDB_KEY_PREFIX}${pane}`;

    /**
     * 检查是否支持 File System Access API
     */
    const isSupported = isFileSystemAccessSupported();

    /**
     * 打开目录选择器
     */
    const pickDirectory = useCallback(async () => {
        if (!isSupported) {
            setError(pane, '此浏览器不支持本地文件访问');
            return;
        }

        try {
            setLoading(pane, true);

            // 打开目录选择器
            const handle = await window.showDirectoryPicker({
                mode: 'readwrite',
            });

            // 保存句柄到 IndexedDB
            await set(idbKey, handle);

            // 保存到 ref 和 store
            rootHandleRef.current = handle;
            setLocalHandle(pane, handle);

            // 读取目录内容
            const entries = await readDirectory(handle, '/');

            setCurrentPath(pane, '/');
            setEntries(pane, entries);
            sortEntries(pane);
            setLoading(pane, false);
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                // 用户取消选择
                setLoading(pane, false);
                return;
            }

            setError(pane, (error as Error).message || '无法打开目录');
        }
    }, [isSupported, pane, idbKey, setLoading, setLocalHandle, setCurrentPath, setEntries, sortEntries, setError]);

    /**
     * 导航到指定路径
     */
    const navigateTo = useCallback(async (path: string) => {
        const rootHandle = rootHandleRef.current;

        if (!rootHandle) {
            setError(pane, '请先选择一个目录');
            return;
        }

        try {
            setLoading(pane, true);

            const { entries } = await navigateToPath(rootHandle, path);

            setCurrentPath(pane, path);
            setEntries(pane, entries);
            sortEntries(pane);
            setLoading(pane, false);
        } catch (error) {
            setError(pane, (error as Error).message || '无法导航到目录');
        }
    }, [pane, setLoading, setCurrentPath, setEntries, sortEntries, setError]);

    /**
     * 刷新当前目录
     */
    const refresh = useCallback(async () => {
        const panelState = getPane(pane);
        await navigateTo(panelState.currentPath);
    }, [pane, getPane, navigateTo]);

    /**
     * 返回上级目录
     */
    const navigateUp = useCallback(async () => {
        const panelState = getPane(pane);
        const currentPath = panelState.currentPath;

        if (currentPath === '/') return;

        const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
        await navigateTo(parentPath);
    }, [pane, getPane, navigateTo]);

    /**
     * 清除保存的句柄
     */
    const clearSavedHandle = useCallback(async () => {
        await del(idbKey);
        rootHandleRef.current = null;
        setLocalHandle(pane, undefined);
        setEntries(pane, []);
        setCurrentPath(pane, '/');
    }, [idbKey, pane, setLocalHandle, setEntries, setCurrentPath]);

    /**
     * 读取文件内容
     */
    const readFile = useCallback(async (path: string): Promise<File | null> => {
        const rootHandle = rootHandleRef.current;

        if (!rootHandle) {
            return null;
        }

        try {
            const parts = path.split('/').filter(Boolean);
            const fileName = parts.pop();

            if (!fileName) return null;

            // 导航到文件所在目录
            let dirHandle = rootHandle;
            for (const part of parts) {
                dirHandle = await dirHandle.getDirectoryHandle(part);
            }

            // 获取文件句柄
            const fileHandle = await dirHandle.getFileHandle(fileName);

            // 读取文件
            return await fileHandle.getFile();
        } catch {
            return null;
        }
    }, []);

    /**
     * 获取文件句柄
     */
    const getFileHandle = useCallback(async (
        path: string
    ): Promise<FileSystemFileHandle | null> => {
        const rootHandle = rootHandleRef.current;

        if (!rootHandle) {
            return null;
        }

        try {
            const parts = path.split('/').filter(Boolean);
            const fileName = parts.pop();

            if (!fileName) return null;

            // 导航到文件所在目录
            let dirHandle = rootHandle;
            for (const part of parts) {
                dirHandle = await dirHandle.getDirectoryHandle(part);
            }

            // 获取文件句柄
            return await dirHandle.getFileHandle(fileName);
        } catch {
            return null;
        }
    }, []);

    /**
     * 自动恢复上次的目录
     */
    useEffect(() => {
        if (!autoRestore || !isSupported) return;

        const restoreHandle = async () => {
            try {
                const savedHandle = await get<FileSystemDirectoryHandle>(idbKey);

                if (!savedHandle) return;

                // 验证权限
                const permission = await savedHandle.queryPermission({ mode: 'readwrite' });

                if (permission === 'granted') {
                    // 权限已授予，直接使用
                    rootHandleRef.current = savedHandle;
                    setLocalHandle(pane, savedHandle);

                    // 读取目录内容
                    const entries = await readDirectory(savedHandle, '/');
                    setCurrentPath(pane, '/');
                    setEntries(pane, entries);
                    sortEntries(pane);
                } else if (permission === 'prompt') {
                    // 需要重新请求权限
                    // 这里可以选择请求权限或等待用户操作
                    // 为了不打扰用户，我们不自动请求
                    console.log('FluxFile: 需要重新授权访问本地目录');
                }
            } catch (error) {
                console.error('FluxFile: 恢复目录句柄失败', error);
                // 清除无效的句柄
                await del(idbKey);
            }
        };

        restoreHandle();
    }, [autoRestore, isSupported, idbKey, pane, setLocalHandle, setCurrentPath, setEntries, sortEntries]);

    return {
        isSupported,
        pickDirectory,
        navigateTo,
        refresh,
        navigateUp,
        clearSavedHandle,
        readFile,
        getFileHandle,
    };
}

export default useLocalFileSystem;
