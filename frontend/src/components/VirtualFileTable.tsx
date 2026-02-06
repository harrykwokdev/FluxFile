/**
 * FluxFile - 虚拟化文件表格组件
 * ================================
 * 
 * 使用 @tanstack/react-virtual 实现高性能虚拟滚动。
 * 即使有 100,000 条数据，DOM 中也只渲染视口内的 20-30 个节点。
 * 
 * 特性：
 * 1. 虚拟化渲染 - 只渲染可见行
 * 2. 支持键盘导航 - 上下箭头、Page Up/Down、Home/End
 * 3. 支持多选 - Ctrl+点击、Shift+范围选择
 * 4. 支持排序 - 点击列头排序
 * 5. 双击进入目录
 */

import { useRef, useCallback, useEffect, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFileStore, usePane } from '@/stores/fileStore';
import type { FileEntry, PanelId, SortField } from '@/types';
import { cn } from '@/utils/cn';

// ============================================================================
// 配置常量
// ============================================================================

const ROW_HEIGHT = 28; // 行高（像素）
const OVERSCAN = 5; // 预渲染行数

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化文件大小
 */
const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '—';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

/**
 * 格式化日期时间
 */
const formatDateTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}`;
};

/**
 * 获取文件图标
 */
const getFileIcon = (entry: FileEntry): string => {
    if (entry.type === 'directory') return '📁';

    const ext = entry.extension?.toLowerCase();

    const iconMap: Record<string, string> = {
        // 图片
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
        // 视频
        mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', wmv: '🎬', flv: '🎬', webm: '🎬',
        // 音频
        mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', wma: '🎵',
        // 文档
        pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
        // 代码
        js: '📜', ts: '📜', jsx: '📜', tsx: '📜', py: '🐍', java: '☕', c: '⚙️', cpp: '⚙️',
        h: '⚙️', rs: '🦀', go: '🐹', rb: '💎', php: '🐘', swift: '🍎', kt: '🟣',
        // 配置
        json: '⚙️', yaml: '⚙️', yml: '⚙️', toml: '⚙️', xml: '⚙️', ini: '⚙️',
        // 压缩
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦', bz2: '📦', xz: '📦',
        // 文本
        txt: '📄', md: '📝', log: '📄', csv: '📊',
        // 可执行
        exe: '⚡', msi: '⚡', dmg: '⚡', app: '⚡', sh: '⚡', bat: '⚡',
    };

    return iconMap[ext || ''] || '📄';
};

// ============================================================================
// 列头组件
// ============================================================================

interface TableHeaderProps {
    pane: PanelId;
    sortField: SortField;
    sortDirection: 'asc' | 'desc';
}

const TableHeader = memo<TableHeaderProps>(({ pane, sortField, sortDirection }) => {
    const setSort = useFileStore((state) => state.setSort);

    const getSortIndicator = (field: SortField) => {
        if (sortField !== field) return null;
        return sortDirection === 'asc' ? '▲' : '▼';
    };

    const handleSort = (field: SortField) => {
        setSort(pane, field);
    };

    return (
        <div className="bg-commander-header text-commander-text-dim text-xs select-none border-b border-commander-border overflow-x-hidden">
            <div className="flex min-w-[340px]">
                <div
                    className="flex-1 min-w-[120px] px-2 py-1 cursor-pointer hover:bg-commander-hover flex items-center gap-1"
                    onClick={() => handleSort('name')}
                >
                    <span>名称</span>
                    <span className="text-commander-accent">{getSortIndicator('name')}</span>
                </div>
                <div
                    className="w-20 flex-shrink-0 px-2 py-1 cursor-pointer hover:bg-commander-hover flex items-center justify-end gap-1"
                    onClick={() => handleSort('size')}
                >
                    <span>大小</span>
                    <span className="text-commander-accent">{getSortIndicator('size')}</span>
                </div>
                <div
                    className="w-32 flex-shrink-0 px-2 py-1 cursor-pointer hover:bg-commander-hover flex items-center gap-1"
                    onClick={() => handleSort('mtime')}
                >
                    <span>修改时间</span>
                    <span className="text-commander-accent">{getSortIndicator('mtime')}</span>
                </div>
            </div>
        </div>
    );
});

TableHeader.displayName = 'TableHeader';

// ============================================================================
// 行组件
// ============================================================================

interface FileRowProps {
    entry: FileEntry;
    index: number;
    isSelected: boolean;
    isFocused: boolean;
    style: React.CSSProperties;
    onClick: (e: React.MouseEvent, index: number) => void;
    onDoubleClick: (entry: FileEntry) => void;
}

const FileRow = memo<FileRowProps>(({
    entry,
    index,
    isSelected,
    isFocused,
    style,
    onClick,
    onDoubleClick,
}) => {
    return (
        <div
            style={style}
            className={cn(
                'flex items-center text-sm cursor-default select-none min-w-[340px]',
                'transition-colors duration-75',
                isSelected
                    ? 'bg-commander-selected text-white'
                    : 'hover:bg-commander-hover',
                isFocused && 'ring-1 ring-inset ring-commander-accent'
            )}
            onClick={(e) => onClick(e, index)}
            onDoubleClick={() => onDoubleClick(entry)}
        >
            {/* 文件名列 */}
            <div className="flex-1 min-w-[120px] px-2 flex items-center gap-1.5 overflow-hidden">
                <span className="flex-shrink-0 text-base leading-none">
                    {getFileIcon(entry)}
                </span>
                <span className="truncate">
                    {entry.name}
                </span>
            </div>

            {/* 大小列 */}
            <div className="w-20 flex-shrink-0 px-2 text-right text-commander-text-dim tabular-nums">
                {entry.type === 'directory' ? '<DIR>' : formatFileSize(entry.size)}
            </div>

            {/* 修改时间列 */}
            <div className="w-32 flex-shrink-0 px-2 text-commander-text-dim tabular-nums">
                {formatDateTime(entry.mtime)}
            </div>
        </div>
    );
});

FileRow.displayName = 'FileRow';

// ============================================================================
// 虚拟文件表格主组件
// ============================================================================

interface VirtualFileTableProps {
    pane: PanelId;
    onNavigate?: (path: string) => void;
    onOpen?: (entry: FileEntry) => void;
    className?: string;
}

export const VirtualFileTable = memo<VirtualFileTableProps>(({
    pane,
    onNavigate,
    onOpen,
    className,
}) => {
    const parentRef = useRef<HTMLDivElement>(null);

    // 从 store 获取状态
    const panelState = usePane(pane);
    const { entries, selectedIndices, focusIndex, sort, loading, error } = panelState;

    // 获取 actions
    const {
        selectSingle,
        toggleSelect,
        selectRange,
        setFocusIndex,
        setActivePane,
    } = useFileStore();

    // 虚拟化器
    const virtualizer = useVirtualizer({
        count: entries.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
    });

    // 滚动到焦点项
    useEffect(() => {
        if (focusIndex >= 0 && focusIndex < entries.length) {
            virtualizer.scrollToIndex(focusIndex, { align: 'auto' });
        }
    }, [focusIndex, entries.length, virtualizer]);

    // 点击处理
    const handleClick = useCallback(
        (e: React.MouseEvent, index: number) => {
            setActivePane(pane);

            if (e.ctrlKey || e.metaKey) {
                // Ctrl+点击：切换选中
                toggleSelect(pane, index);
            } else if (e.shiftKey) {
                // Shift+点击：范围选择
                selectRange(pane, index);
            } else {
                // 普通点击：单选
                selectSingle(pane, index);
            }
        },
        [pane, setActivePane, toggleSelect, selectRange, selectSingle]
    );

    // 双击处理
    const handleDoubleClick = useCallback(
        (entry: FileEntry) => {
            if (entry.type === 'directory') {
                onNavigate?.(entry.path);
            } else {
                onOpen?.(entry);
            }
        },
        [onNavigate, onOpen]
    );

    // 键盘导航
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const len = entries.length;
            if (len === 0) return;

            let newIndex = focusIndex;

            switch (e.key) {
                case 'ArrowUp':
                    newIndex = Math.max(0, focusIndex - 1);
                    break;
                case 'ArrowDown':
                    newIndex = Math.min(len - 1, focusIndex + 1);
                    break;
                case 'PageUp':
                    newIndex = Math.max(0, focusIndex - 10);
                    break;
                case 'PageDown':
                    newIndex = Math.min(len - 1, focusIndex + 10);
                    break;
                case 'Home':
                    newIndex = 0;
                    break;
                case 'End':
                    newIndex = len - 1;
                    break;
                case 'Enter': {
                    const entry = entries[focusIndex];
                    if (entry) {
                        if (entry.type === 'directory') {
                            onNavigate?.(entry.path);
                        } else {
                            onOpen?.(entry);
                        }
                    }
                    return;
                }
                case ' ':
                    // 空格键切换选中
                    toggleSelect(pane, focusIndex);
                    e.preventDefault();
                    return;
                case 'a':
                    if (e.ctrlKey || e.metaKey) {
                        // Ctrl+A 全选
                        const { selectAll } = useFileStore.getState();
                        selectAll(pane);
                        e.preventDefault();
                    }
                    return;
                default:
                    return;
            }

            e.preventDefault();

            if (e.shiftKey) {
                // Shift+方向键：扩展选择
                selectRange(pane, newIndex);
            } else if (e.ctrlKey || e.metaKey) {
                // Ctrl+方向键：只移动焦点
                setFocusIndex(pane, newIndex);
            } else {
                // 普通方向键：移动并选中
                selectSingle(pane, newIndex);
            }
        },
        [entries, focusIndex, pane, onNavigate, onOpen, toggleSelect, selectRange, setFocusIndex, selectSingle]
    );

    // 获取焦点
    const handleFocus = useCallback(() => {
        setActivePane(pane);
    }, [pane, setActivePane]);

    // 渲染虚拟行
    const virtualItems = virtualizer.getVirtualItems();

    return (
        <div
            className={cn(
                'flex flex-col bg-commander-bg border border-commander-border rounded',
                'focus:outline-none focus:ring-1 focus:ring-commander-accent',
                className
            )}
            onFocus={handleFocus}
            tabIndex={0}
        >
            {/* 列头 */}
            <TableHeader
                pane={pane}
                sortField={sort.field}
                sortDirection={sort.direction}
            />

            {/* 虚拟列表容器 */}
            <div
                ref={parentRef}
                className="flex-1 overflow-auto"
                onKeyDown={handleKeyDown}
            >
                {loading ? (
                    <div className="flex items-center justify-center h-full text-commander-text-dim">
                        <span className="animate-pulse">加载中...</span>
                    </div>
                ) : error ? (
                    <div className="flex items-center justify-center h-full text-red-400">
                        <span>{error}</span>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-commander-text-dim">
                        <span>空目录</span>
                    </div>
                ) : (
                    <div
                        style={{
                            height: `${virtualizer.getTotalSize()}px`,
                            width: '100%',
                            minWidth: '340px',
                            position: 'relative',
                        }}
                    >
                        {virtualItems.map((virtualItem) => {
                            const entry = entries[virtualItem.index];
                            if (!entry) return null;

                            return (
                                <FileRow
                                    key={virtualItem.key}
                                    entry={entry}
                                    index={virtualItem.index}
                                    isSelected={selectedIndices.has(virtualItem.index)}
                                    isFocused={focusIndex === virtualItem.index}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: `${virtualItem.size}px`,
                                        transform: `translateY(${virtualItem.start}px)`,
                                    }}
                                    onClick={handleClick}
                                    onDoubleClick={handleDoubleClick}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 状态栏 */}
            <div className="flex items-center justify-between px-2 py-0.5 bg-commander-header text-xs text-commander-text-dim border-t border-commander-border min-w-[340px]">
                <span>
                    {entries.length} 项
                    {selectedIndices.size > 0 && ` • 已选 ${selectedIndices.size} 项`}
                </span>
                <span>{panelState.currentPath}</span>
            </div>
        </div>
    );
});

VirtualFileTable.displayName = 'VirtualFileTable';

export default VirtualFileTable;
