/**
 * FluxFile - Commander 双栏布局
 * ===============================
 * 
 * WinSCP 风格的双栏文件管理器布局。
 * 左右两个可调整大小的面板，底部功能键栏。
 */

import { memo, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { FilePanel } from '@/components/FilePanel';
import { P2PTransferPanel } from '@/components/P2PTransferPanel';
import { useFileStore } from '@/stores/fileStore';
import { cn } from '@/utils/cn';

// ============================================================================
// 可调整大小的分隔条
// ============================================================================

interface ResizerProps {
    onResize: (delta: number) => void;
}

const Resizer = memo<ResizerProps>(({ onResize }) => {
    const isDragging = useRef(false);
    const startX = useRef(0);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true;
        startX.current = e.clientX;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;
            const delta = e.clientX - startX.current;
            startX.current = e.clientX;
            onResize(delta);
        };

        const handleMouseUp = () => {
            isDragging.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [onResize]);

    return (
        <div
            className={cn(
                'w-1 flex-shrink-0 cursor-col-resize',
                'bg-commander-border hover:bg-commander-accent',
                'transition-colors duration-150'
            )}
            onMouseDown={handleMouseDown}
        />
    );
});

Resizer.displayName = 'Resizer';

// ============================================================================
// 功能键栏
// ============================================================================

interface FunctionKey {
    key: string;
    label: string;
    action: () => void;
    disabled?: boolean;
}

const FunctionKeyBar = memo(() => {
    const getSelectedEntries = useFileStore((state) => state.getSelectedEntries);
    const activePane = useFileStore((state) => state.activePane);

    const functionKeys: FunctionKey[] = useMemo(() => [
        { key: 'F3', label: '查看', action: () => console.log('View') },
        { key: 'F4', label: '编辑', action: () => console.log('Edit') },
        {
            key: 'F5', label: '复制', action: () => {
                const selected = getSelectedEntries(activePane);
                console.log('Copy:', selected);
            }
        },
        { key: 'F6', label: '移动', action: () => console.log('Move') },
        { key: 'F7', label: '新建目录', action: () => console.log('NewDir') },
        { key: 'F8', label: '删除', action: () => console.log('Delete') },
    ], [getSelectedEntries, activePane]);

    // 全局快捷键
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const fKey = functionKeys.find((fk) => fk.key === e.key);
            if (fKey && !fKey.disabled) {
                e.preventDefault();
                fKey.action();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [functionKeys]);

    return (
        <div className="flex bg-commander-header border-t border-commander-border">
            {functionKeys.map((fk) => (
                <button
                    key={fk.key}
                    className={cn(
                        'flex-1 flex items-center justify-center gap-1 py-1.5',
                        'text-xs text-commander-text',
                        'hover:bg-commander-hover transition-colors',
                        'border-r border-commander-border last:border-r-0',
                        fk.disabled && 'opacity-50 cursor-not-allowed'
                    )}
                    onClick={fk.action}
                    disabled={fk.disabled}
                >
                    <span className="text-commander-accent font-medium">{fk.key}</span>
                    <span>{fk.label}</span>
                </button>
            ))}
        </div>
    );
});

FunctionKeyBar.displayName = 'FunctionKeyBar';

// ============================================================================
// 传输面板
// ============================================================================

const TransferPanel = memo(() => {
    const transfers = useFileStore((state) => state.transfers);
    const showTransferPanel = useFileStore((state) => state.showTransferPanel);
    const toggleTransferPanel = useFileStore((state) => state.toggleTransferPanel);

    if (!showTransferPanel) return null;

    const activeTransfers = transfers.filter((t) => t.status !== 'completed');

    return (
        <div className="h-32 bg-commander-bg border-t border-commander-border">
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-1 bg-commander-header border-b border-commander-border">
                <span className="text-sm text-commander-text">
                    传输任务 ({activeTransfers.length})
                </span>
                <button
                    className="text-commander-text-dim hover:text-commander-text"
                    onClick={toggleTransferPanel}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* 传输列表 */}
            <div className="overflow-auto h-[calc(100%-28px)]">
                {transfers.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-commander-text-dim text-sm">
                        暂无传输任务
                    </div>
                ) : (
                    <div className="p-2 space-y-1">
                        {transfers.map((task) => (
                            <div
                                key={task.id}
                                className="flex items-center gap-2 px-2 py-1 bg-commander-header rounded text-sm"
                            >
                                <span className="flex-shrink-0">
                                    {task.operation === 'upload' ? '⬆️' : '⬇️'}
                                </span>
                                <span className="flex-1 min-w-0 truncate text-commander-text">
                                    {task.fileName}
                                </span>
                                <span className="flex-shrink-0 text-commander-text-dim tabular-nums">
                                    {Math.round((task.transferredBytes / task.totalBytes) * 100)}%
                                </span>
                                <div className="w-24 h-1.5 bg-commander-border rounded-full overflow-hidden">
                                    <div
                                        className={cn(
                                            'h-full transition-all duration-300',
                                            task.status === 'failed' ? 'bg-red-500' : 'bg-commander-accent'
                                        )}
                                        style={{ width: `${(task.transferredBytes / task.totalBytes) * 100}%` }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

TransferPanel.displayName = 'TransferPanel';

// ============================================================================
// Commander 布局主组件
// ============================================================================

export const CommanderLayout = memo(() => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [leftWidth, setLeftWidth] = useState(50); // 百分比
    const [showP2P, setShowP2P] = useState(false);

    const handleResize = useCallback((delta: number) => {
        if (!containerRef.current) return;

        const containerWidth = containerRef.current.offsetWidth;
        const deltaPercent = (delta / containerWidth) * 100;

        setLeftWidth((prev) => {
            const newWidth = prev + deltaPercent;
            // 限制在 20% - 80% 之间
            return Math.max(20, Math.min(80, newWidth));
        });
    }, []);

    return (
        <div className="flex flex-col h-screen bg-commander-bg text-commander-text">
            {/* 标题栏 */}
            <header className="flex items-center justify-between px-4 py-2 bg-commander-header border-b border-commander-border">
                <h1 className="text-lg font-semibold">
                    <span className="text-commander-accent">Nexus</span>File
                </h1>
                <div className="flex items-center gap-2">
                    <button
                        className={cn(
                            'px-3 py-1 text-sm rounded transition-colors',
                            showP2P
                                ? 'text-commander-accent bg-commander-hover'
                                : 'text-commander-text-dim hover:text-commander-text hover:bg-commander-hover'
                        )}
                        onClick={() => setShowP2P((v) => !v)}
                        title="P2P 传输"
                    >
                        📡 P2P
                    </button>
                    <button
                        className="px-3 py-1 text-sm text-commander-text-dim hover:text-commander-text hover:bg-commander-hover rounded transition-colors"
                        title="设置"
                    >
                        ⚙️ 设置
                    </button>
                </div>
            </header>

            {/* 主内容区 */}
            <main ref={containerRef} className="flex flex-1 min-h-0">
                {/* 左面板 */}
                <div style={{ width: `${leftWidth}%` }} className="min-w-0">
                    <FilePanel pane="left" />
                </div>

                {/* 分隔条 */}
                <Resizer onResize={handleResize} />

                {/* 右面板 */}
                <div style={{ width: `${100 - leftWidth}%` }} className="min-w-0">
                    <FilePanel pane="right" />
                </div>
            </main>

            {/* P2P 传输面板 */}
            {showP2P && <P2PTransferPanel />}

            {/* 传输面板 */}
            <TransferPanel />

            {/* 功能键栏 */}
            <FunctionKeyBar />
        </div>
    );
});

CommanderLayout.displayName = 'CommanderLayout';

export default CommanderLayout;
