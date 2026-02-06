/**
 * FluxFile - 文件面板组件
 * =========================
 * 
 * 单个文件浏览面板，包含：
 * 1. 工具栏（路径输入、刷新、选择目录按钮）
 * 2. 虚拟化文件列表
 * 3. 状态栏
 */

import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { VirtualFileTable } from '@/components/VirtualFileTable';
import { useLocalFileSystem } from '@/hooks/useLocalFileSystem';
import { useFileStore, usePane } from '@/stores/fileStore';
import { cn } from '@/utils/cn';
import type { PanelId, FileEntry } from '@/types';

// ============================================================================
// API 调用函数（远程文件系统）
// ============================================================================

const API_BASE = '/api';

async function fetchRemoteDirectory(path: string): Promise<FileEntry[]> {
    const response = await fetch(`${API_BASE}/fs/list?path=${encodeURIComponent(path)}`);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data.entries as FileEntry[];
}

// ============================================================================
// 工具栏组件
// ============================================================================

interface PanelToolbarProps {
    pane: PanelId;
    currentPath: string;
    source: 'local' | 'remote';
    isLocalSupported: boolean;
    onPickDirectory: () => void;
    onRefresh: () => void;
    onNavigateTo: (path: string) => void;
    onNavigateUp: () => void;
}

const PanelToolbar = memo<PanelToolbarProps>(({
    pane,
    currentPath,
    source,
    isLocalSupported,
    onPickDirectory,
    onRefresh,
    onNavigateTo,
    onNavigateUp,
}) => {
    const [editingPath, setEditingPath] = useState(false);
    const [pathInput, setPathInput] = useState(currentPath);
    const inputRef = useRef<HTMLInputElement>(null);

    const setPanelSource = useFileStore((state) => state.setPanelSource);

    // 同步路径
    useEffect(() => {
        if (!editingPath) {
            setPathInput(currentPath);
        }
    }, [currentPath, editingPath]);

    // 处理路径编辑
    const handlePathSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (pathInput.trim()) {
            onNavigateTo(pathInput.trim());
        }
        setEditingPath(false);
    };

    const handlePathFocus = () => {
        setEditingPath(true);
        setTimeout(() => inputRef.current?.select(), 0);
    };

    const handlePathBlur = () => {
        setEditingPath(false);
        setPathInput(currentPath);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setEditingPath(false);
            setPathInput(currentPath);
            inputRef.current?.blur();
        }
    };

    return (
        <div className="flex items-center gap-1 px-2 py-1 bg-commander-header border-b border-commander-border">
            {/* 源切换按钮 */}
            <div className="flex rounded overflow-hidden border border-commander-border">
                <button
                    className={cn(
                        'px-2 py-0.5 text-xs transition-colors',
                        source === 'local'
                            ? 'bg-commander-accent text-white'
                            : 'bg-commander-bg text-commander-text-dim hover:bg-commander-hover'
                    )}
                    onClick={() => {
                        if (isLocalSupported) {
                            setPanelSource(pane, 'local');
                        }
                    }}
                    title={isLocalSupported ? '本地文件' : '浏览器不支持本地文件访问'}
                    disabled={!isLocalSupported}
                >
                    本地
                </button>
                <button
                    className={cn(
                        'px-2 py-0.5 text-xs transition-colors',
                        source === 'remote'
                            ? 'bg-commander-accent text-white'
                            : 'bg-commander-bg text-commander-text-dim hover:bg-commander-hover'
                    )}
                    onClick={() => setPanelSource(pane, 'remote')}
                    title="服务器文件"
                >
                    远程
                </button>
            </div>

            {/* 返回上级 */}
            <button
                className="p-1 text-commander-text-dim hover:text-commander-text hover:bg-commander-hover rounded transition-colors"
                onClick={onNavigateUp}
                title="返回上级 (Backspace)"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
            </button>

            {/* 路径输入框 */}
            <form onSubmit={handlePathSubmit} className="flex-1 min-w-0">
                <input
                    ref={inputRef}
                    type="text"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onFocus={handlePathFocus}
                    onBlur={handlePathBlur}
                    onKeyDown={handleKeyDown}
                    className={cn(
                        'w-full px-2 py-0.5 text-sm',
                        'bg-commander-bg text-commander-text',
                        'border border-commander-border rounded',
                        'focus:outline-none focus:border-commander-accent',
                        'font-mono'
                    )}
                />
            </form>

            {/* 刷新 */}
            <button
                className="p-1 text-commander-text-dim hover:text-commander-text hover:bg-commander-hover rounded transition-colors"
                onClick={onRefresh}
                title="刷新 (F5)"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
            </button>

            {/* 选择目录（仅本地） */}
            {source === 'local' && isLocalSupported && (
                <button
                    className="p-1 text-commander-text-dim hover:text-commander-text hover:bg-commander-hover rounded transition-colors"
                    onClick={onPickDirectory}
                    title="选择目录"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v16h16V7l-4-3H4z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4v3h5" />
                    </svg>
                </button>
            )}
        </div>
    );
});

PanelToolbar.displayName = 'PanelToolbar';

// ============================================================================
// 文件面板主组件
// ============================================================================

interface FilePanelProps {
    pane: PanelId;
    className?: string;
}

export const FilePanel = memo<FilePanelProps>(({ pane, className }) => {
    const panelState = usePane(pane);
    const { source, currentPath } = panelState;

    const setEntries = useFileStore((state) => state.setEntries);
    const setLoading = useFileStore((state) => state.setLoading);
    const setError = useFileStore((state) => state.setError);
    const setCurrentPath = useFileStore((state) => state.setCurrentPath);
    const sortEntries = useFileStore((state) => state.sortEntries);

    // 本地文件系统 Hook
    const localFS = useLocalFileSystem({ pane });

    // 导航到路径（根据源类型选择实现）
    const handleNavigateTo = useCallback(async (path: string) => {
        if (source === 'local') {
            await localFS.navigateTo(path);
        } else {
            // 远程文件系统
            try {
                setLoading(pane, true);
                const entries = await fetchRemoteDirectory(path);
                setCurrentPath(pane, path);
                setEntries(pane, entries);
                sortEntries(pane);
                setLoading(pane, false);
            } catch (error) {
                setError(pane, (error as Error).message || '无法加载远程目录');
            }
        }
    }, [source, pane, localFS, setLoading, setCurrentPath, setEntries, sortEntries, setError]);

    // 刷新
    const handleRefresh = useCallback(async () => {
        if (source === 'local') {
            await localFS.refresh();
        } else {
            await handleNavigateTo(currentPath);
        }
    }, [source, currentPath, localFS, handleNavigateTo]);

    // 返回上级
    const handleNavigateUp = useCallback(async () => {
        if (source === 'local') {
            await localFS.navigateUp();
        } else {
            if (currentPath === '/') return;
            const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
            await handleNavigateTo(parentPath);
        }
    }, [source, currentPath, localFS, handleNavigateTo]);

    // 打开文件（目前只打印）
    const handleOpenFile = useCallback((entry: FileEntry) => {
        console.log('Opening file:', entry);
        // TODO: 实现文件预览或下载
    }, []);

    // 初始加载远程根目录
    useEffect(() => {
        if (source === 'remote' && panelState.entries.length === 0 && !panelState.loading) {
            handleNavigateTo('/');
        }
    }, [source, panelState.entries.length, panelState.loading, handleNavigateTo]);

    return (
        <div className={cn('flex flex-col h-full', className)}>
            {/* 工具栏 */}
            <PanelToolbar
                pane={pane}
                currentPath={currentPath}
                source={source}
                isLocalSupported={localFS.isSupported}
                onPickDirectory={localFS.pickDirectory}
                onRefresh={handleRefresh}
                onNavigateTo={handleNavigateTo}
                onNavigateUp={handleNavigateUp}
            />

            {/* 文件列表 */}
            <VirtualFileTable
                pane={pane}
                onNavigate={handleNavigateTo}
                onOpen={handleOpenFile}
                className="flex-1 min-h-0"
            />
        </div>
    );
});

FilePanel.displayName = 'FilePanel';

export default FilePanel;
