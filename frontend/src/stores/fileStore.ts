/**
 * FluxFile - 文件管理状态存储
 * ===============================
 * 
 * 使用 Zustand 管理双栏文件管理器的状态。
 * 
 * 核心设计：
 * 1. 左右两个独立的面板状态
 * 2. 每个面板可以是远程（服务器）或本地（File System Access API）
 * 3. 支持多选、排序、过滤
 * 4. 使用 Immer 进行不可变更新
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
    FileEntry,
    PanelState,
    PanelId,
    PanelSource,
    SortField,
    SortDirection,
    SortConfig,
    TransferTask,
    ViewMode,
} from '@/types';

// ============================================================================
// 初始状态
// ============================================================================

/**
 * 创建面板初始状态
 */
const createInitialPanelState = (
    id: PanelId,
    source: PanelSource = 'remote'
): PanelState => ({
    id,
    source,
    currentPath: '/',
    entries: [],
    selectedIndices: new Set<number>(),
    lastSelectedIndex: -1,
    focusIndex: 0,
    sort: { field: 'name', direction: 'asc' },
    showHidden: false,
    loading: false,
    error: null,
    viewMode: 'details',
    localHandle: undefined,
});

// ============================================================================
// Store 类型定义
// ============================================================================

interface FileStoreState {
    // 面板状态
    leftPane: PanelState;
    rightPane: PanelState;

    // 活动面板
    activePane: PanelId;

    // 传输任务
    transfers: TransferTask[];

    // UI 状态
    showTransferPanel: boolean;
    commandPalette: boolean;
}

interface FileStoreActions {
    // ========================================================================
    // 面板通用操作
    // ========================================================================

    /**
     * 设置活动面板
     */
    setActivePane: (pane: PanelId) => void;

    /**
     * 获取面板状态
     */
    getPane: (pane: PanelId) => PanelState;

    /**
     * 更新面板文件列表
     */
    setEntries: (pane: PanelId, entries: FileEntry[]) => void;

    /**
     * 设置当前路径
     */
    setCurrentPath: (pane: PanelId, path: string) => void;

    /**
     * 设置加载状态
     */
    setLoading: (pane: PanelId, loading: boolean) => void;

    /**
     * 设置错误
     */
    setError: (pane: PanelId, error: string | null) => void;

    /**
     * 设置面板源类型
     */
    setPanelSource: (pane: PanelId, source: PanelSource) => void;

    /**
     * 设置本地文件句柄
     */
    setLocalHandle: (pane: PanelId, handle: FileSystemDirectoryHandle | undefined) => void;

    // ========================================================================
    // 选择操作
    // ========================================================================

    /**
     * 选中单个项目（清除其他选择）
     */
    selectSingle: (pane: PanelId, index: number) => void;

    /**
     * 切换选中状态（Ctrl+点击）
     */
    toggleSelect: (pane: PanelId, index: number) => void;

    /**
     * 范围选择（Shift+点击）
     */
    selectRange: (pane: PanelId, index: number) => void;

    /**
     * 全选
     */
    selectAll: (pane: PanelId) => void;

    /**
     * 取消全部选择
     */
    clearSelection: (pane: PanelId) => void;

    /**
     * 反选
     */
    invertSelection: (pane: PanelId) => void;

    /**
     * 选择匹配模式的文件
     */
    selectByPattern: (pane: PanelId, pattern: string) => void;

    /**
     * 设置焦点索引（键盘导航）
     */
    setFocusIndex: (pane: PanelId, index: number) => void;

    /**
     * 获取选中的文件列表
     */
    getSelectedEntries: (pane: PanelId) => FileEntry[];

    // ========================================================================
    // 排序操作
    // ========================================================================

    /**
     * 设置排序
     */
    setSort: (pane: PanelId, field: SortField, direction?: SortDirection) => void;

    /**
     * 切换排序方向
     */
    toggleSortDirection: (pane: PanelId) => void;

    /**
     * 应用排序（内部）
     */
    sortEntries: (pane: PanelId) => void;

    // ========================================================================
    // 视图操作
    // ========================================================================

    /**
     * 切换隐藏文件显示
     */
    toggleHidden: (pane: PanelId) => void;

    /**
     * 设置视图模式
     */
    setViewMode: (pane: PanelId, mode: ViewMode) => void;

    // ========================================================================
    // 导航操作
    // ========================================================================

    /**
     * 进入目录
     */
    navigateTo: (pane: PanelId, path: string) => void;

    /**
     * 返回上级目录
     */
    navigateUp: (pane: PanelId) => void;

    /**
     * 刷新当前目录
     */
    refresh: (pane: PanelId) => void;

    // ========================================================================
    // 传输操作
    // ========================================================================

    /**
     * 添加传输任务
     */
    addTransfer: (task: TransferTask) => void;

    /**
     * 更新传输进度
     */
    updateTransfer: (id: string, update: Partial<TransferTask>) => void;

    /**
     * 移除传输任务
     */
    removeTransfer: (id: string) => void;

    /**
     * 切换传输面板显示
     */
    toggleTransferPanel: () => void;
}

type FileStore = FileStoreState & FileStoreActions;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 排序比较函数
 */
const compareEntries = (
    a: FileEntry,
    b: FileEntry,
    sort: SortConfig
): number => {
    const direction = sort.direction === 'asc' ? 1 : -1;

    // 目录始终在前面
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;

    switch (sort.field) {
        case 'name':
            return direction * a.name.localeCompare(b.name, undefined, {
                numeric: true,
                sensitivity: 'base',
            });
        case 'size':
            return direction * (a.size - b.size);
        case 'mtime':
            return direction * (a.mtime - b.mtime);
        case 'type':
            return direction * (a.extension || '').localeCompare(b.extension || '');
        default:
            return 0;
    }
};

/**
 * 匹配文件名模式（支持通配符）
 */
const matchPattern = (name: string, pattern: string): boolean => {
    const regex = new RegExp(
        '^' +
        pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
        '$',
        'i'
    );
    return regex.test(name);
};

// ============================================================================
// 创建 Store
// ============================================================================

export const useFileStore = create<FileStore>()(
    subscribeWithSelector(
        immer((set, get) => ({
            // ======================================================================
            // 初始状态
            // ======================================================================

            leftPane: createInitialPanelState('left', 'local'),
            rightPane: createInitialPanelState('right', 'remote'),
            activePane: 'left',
            transfers: [],
            showTransferPanel: false,
            commandPalette: false,

            // ======================================================================
            // 面板通用操作
            // ======================================================================

            setActivePane: (pane) => {
                set((state) => {
                    state.activePane = pane;
                });
            },

            getPane: (pane) => {
                const state = get();
                return pane === 'left' ? state.leftPane : state.rightPane;
            },

            setEntries: (pane, entries) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.entries = entries;
                    panel.selectedIndices = new Set();
                    panel.focusIndex = 0;
                    panel.lastSelectedIndex = -1;
                });
            },

            setCurrentPath: (pane, path) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.currentPath = path;
                });
            },

            setLoading: (pane, loading) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.loading = loading;
                    if (loading) {
                        panel.error = null;
                    }
                });
            },

            setError: (pane, error) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.error = error;
                    panel.loading = false;
                });
            },

            setPanelSource: (pane, source) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.source = source;
                    panel.entries = [];
                    panel.currentPath = '/';
                    panel.selectedIndices = new Set();
                });
            },

            setLocalHandle: (pane, handle) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.localHandle = handle;
                });
            },

            // ======================================================================
            // 选择操作
            // ======================================================================

            selectSingle: (pane, index) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.selectedIndices = new Set([index]);
                    panel.lastSelectedIndex = index;
                    panel.focusIndex = index;
                });
            },

            toggleSelect: (pane, index) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const newSelection = new Set(panel.selectedIndices);

                    if (newSelection.has(index)) {
                        newSelection.delete(index);
                    } else {
                        newSelection.add(index);
                    }

                    panel.selectedIndices = newSelection;
                    panel.lastSelectedIndex = index;
                    panel.focusIndex = index;
                });
            },

            selectRange: (pane, index) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const start = Math.min(panel.lastSelectedIndex, index);
                    const end = Math.max(panel.lastSelectedIndex, index);

                    const newSelection = new Set(panel.selectedIndices);
                    for (let i = start; i <= end; i++) {
                        newSelection.add(i);
                    }

                    panel.selectedIndices = newSelection;
                    panel.focusIndex = index;
                });
            },

            selectAll: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const indices = new Set<number>();
                    for (let i = 0; i < panel.entries.length; i++) {
                        indices.add(i);
                    }
                    panel.selectedIndices = indices;
                });
            },

            clearSelection: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.selectedIndices = new Set();
                });
            },

            invertSelection: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const newSelection = new Set<number>();

                    for (let i = 0; i < panel.entries.length; i++) {
                        if (!panel.selectedIndices.has(i)) {
                            newSelection.add(i);
                        }
                    }

                    panel.selectedIndices = newSelection;
                });
            },

            selectByPattern: (pane, pattern) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const newSelection = new Set<number>();

                    panel.entries.forEach((entry, index) => {
                        if (matchPattern(entry.name, pattern)) {
                            newSelection.add(index);
                        }
                    });

                    panel.selectedIndices = newSelection;
                });
            },

            setFocusIndex: (pane, index) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.focusIndex = Math.max(0, Math.min(index, panel.entries.length - 1));
                });
            },

            getSelectedEntries: (pane) => {
                const state = get();
                const panel = pane === 'left' ? state.leftPane : state.rightPane;
                return Array.from(panel.selectedIndices)
                    .sort((a, b) => a - b)
                    .map((i) => panel.entries[i])
                    .filter(Boolean);
            },

            // ======================================================================
            // 排序操作
            // ======================================================================

            setSort: (pane, field, direction) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;

                    // 如果点击同一字段，切换方向
                    if (panel.sort.field === field && !direction) {
                        panel.sort.direction = panel.sort.direction === 'asc' ? 'desc' : 'asc';
                    } else {
                        panel.sort.field = field;
                        panel.sort.direction = direction || 'asc';
                    }

                    // 应用排序
                    panel.entries.sort((a, b) => compareEntries(a, b, panel.sort));
                });
            },

            toggleSortDirection: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.sort.direction = panel.sort.direction === 'asc' ? 'desc' : 'asc';
                    panel.entries.sort((a, b) => compareEntries(a, b, panel.sort));
                });
            },

            sortEntries: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.entries.sort((a, b) => compareEntries(a, b, panel.sort));
                });
            },

            // ======================================================================
            // 视图操作
            // ======================================================================

            toggleHidden: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.showHidden = !panel.showHidden;
                });
            },

            setViewMode: (pane, mode) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.viewMode = mode;
                });
            },

            // ======================================================================
            // 导航操作（占位，实际逻辑在 hooks 中）
            // ======================================================================

            navigateTo: (pane, path) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.currentPath = path;
                    panel.loading = true;
                    panel.selectedIndices = new Set();
                    panel.focusIndex = 0;
                });
            },

            navigateUp: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    const path = panel.currentPath;

                    if (path === '/') return;

                    const parent = path.split('/').slice(0, -1).join('/') || '/';
                    panel.currentPath = parent;
                    panel.loading = true;
                });
            },

            refresh: (pane) => {
                set((state) => {
                    const panel = pane === 'left' ? state.leftPane : state.rightPane;
                    panel.loading = true;
                    panel.error = null;
                });
            },

            // ======================================================================
            // 传输操作
            // ======================================================================

            addTransfer: (task) => {
                set((state) => {
                    state.transfers.push(task);
                    state.showTransferPanel = true;
                });
            },

            updateTransfer: (id, update) => {
                set((state) => {
                    const task = state.transfers.find((t) => t.id === id);
                    if (task) {
                        Object.assign(task, update);
                    }
                });
            },

            removeTransfer: (id) => {
                set((state) => {
                    state.transfers = state.transfers.filter((t) => t.id !== id);
                });
            },

            toggleTransferPanel: () => {
                set((state) => {
                    state.showTransferPanel = !state.showTransferPanel;
                });
            },
        }))
    )
);

// ============================================================================
// 选择器 Hooks（性能优化）
// ============================================================================

/**
 * 选择活动面板状态
 */
export const useActivePane = () =>
    useFileStore((state) =>
        state.activePane === 'left' ? state.leftPane : state.rightPane
    );

/**
 * 选择指定面板状态
 */
export const usePane = (pane: PanelId) =>
    useFileStore((state) => (pane === 'left' ? state.leftPane : state.rightPane));

/**
 * 选择面板的文件列表
 */
export const usePaneEntries = (pane: PanelId) =>
    useFileStore((state) =>
        pane === 'left' ? state.leftPane.entries : state.rightPane.entries
    );

/**
 * 选择面板的选中项
 */
export const usePaneSelection = (pane: PanelId) =>
    useFileStore((state) =>
        pane === 'left'
            ? state.leftPane.selectedIndices
            : state.rightPane.selectedIndices
    );

/**
 * 选择传输任务列表
 */
export const useTransfers = () => useFileStore((state) => state.transfers);

export default useFileStore;
