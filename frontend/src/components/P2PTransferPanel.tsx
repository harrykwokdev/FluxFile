/**
 * FluxFile - P2P 传输面板组件
 * =============================
 * 
 * 展示 WebRTC P2P 文件传输功能的 UI 组件。
 * 包含房间管理、Peer 列表、文件发送、传输进度等功能。
 */

import { memo, useState, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { useWebRTC } from '@/hooks/useWebRTC';
import { cn } from '@/utils/cn';
import type { P2PTransferProgress, P2PFolderProgress } from '@/types';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化文件大小
 */
const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

/**
 * 格式化速度
 */
const formatSpeed = (bytesPerSecond: number): string => {
    return `${formatSize(bytesPerSecond)}/s`;
};

/**
 * 格式化剩余时间
 */
const formatTime = (seconds: number): string => {
    if (seconds <= 0) return '--';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

/**
 * 生成随机 Peer ID
 */
const generatePeerId = (): string => {
    return `peer-${Math.random().toString(36).slice(2, 8)}`;
};

// ============================================================================
// 进度条组件
// ============================================================================

interface TransferItemProps {
    transfer: P2PTransferProgress;
    onCancel?: () => void;
}

const TransferItem = memo<TransferItemProps>(({ transfer, onCancel }) => {
    const statusColors = {
        pending: 'bg-yellow-500',
        transferring: 'bg-blue-500',
        completed: 'bg-green-500',
        failed: 'bg-red-500',
        cancelled: 'bg-gray-500',
    };

    const statusLabels = {
        pending: '等待中',
        transferring: '传输中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
    };

    return (
        <div className="bg-commander-header rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate flex-1" title={transfer.fileName}>
                    {transfer.fileName}
                </span>
                <span className={cn(
                    'text-xs px-2 py-0.5 rounded',
                    statusColors[transfer.status],
                    'text-white'
                )}>
                    {statusLabels[transfer.status]}
                </span>
            </div>

            <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-commander-border rounded-full overflow-hidden">
                    <div
                        className={cn(
                            'h-full transition-all duration-300',
                            transfer.status === 'failed' ? 'bg-red-500' :
                                transfer.status === 'completed' ? 'bg-green-500' :
                                    'bg-commander-accent'
                        )}
                        style={{ width: `${transfer.progress}%` }}
                    />
                </div>
                <span className="text-xs text-commander-text-dim w-12 text-right">
                    {Math.round(transfer.progress)}%
                </span>
            </div>

            <div className="flex items-center justify-between text-xs text-commander-text-dim">
                <span>
                    {formatSize(transfer.transferredBytes)} / {formatSize(transfer.totalBytes)}
                </span>
                {transfer.status === 'transferring' && (
                    <>
                        <span>{formatSpeed(transfer.speed)}</span>
                        <span>剩余 {formatTime(transfer.remainingTime)}</span>
                    </>
                )}
                {transfer.status === 'transferring' && onCancel && (
                    <button
                        onClick={onCancel}
                        className="text-red-400 hover:text-red-300"
                    >
                        取消
                    </button>
                )}
            </div>
        </div>
    );
});

TransferItem.displayName = 'TransferItem';

// ============================================================================
// P2P 传输面板
// ============================================================================

interface P2PTransferPanelProps {
    className?: string;
}

export const P2PTransferPanel = memo<P2PTransferPanelProps>(({ className }) => {
    const [peerId] = useState(() => generatePeerId());
    const [roomId, setRoomId] = useState('');
    const [inputRoomId, setInputRoomId] = useState('');
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
    const [receivedFiles, setReceivedFiles] = useState<File[]>([]);
    const [receivedFolders, setReceivedFolders] = useState<Array<{
        batchId: string;
        folderName: string;
        files: Map<string, File>;
    }>>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);

    const handleFileReceived = useCallback((file: File, fromPeer: string) => {
        console.log(`Received file from ${fromPeer}:`, file.name);
        setReceivedFiles((prev) => [...prev, file]);
    }, []);

    const handleFolderReceived = useCallback((
        batchId: string,
        folderName: string,
        files: Map<string, File>
    ) => {
        console.log(`Received folder: ${folderName} (${files.size} files)`);
        setReceivedFolders((prev) => [...prev, { batchId, folderName, files }]);
    }, []);

    const handleProgress = useCallback((progress: P2PTransferProgress) => {
        console.log('Transfer progress:', progress);
    }, []);

    const handleFolderProgress = useCallback((progress: P2PFolderProgress) => {
        console.log('Folder transfer progress:', progress);
    }, []);

    const handleError = useCallback((error: Error) => {
        console.error('WebRTC error:', error);
        alert(`错误: ${error.message}`);
    }, []);

    const {
        connectionState,
        peers,
        transfers,
        connect,
        disconnect,
        connectToPeer,
        sendFile,
        sendFolder,
        cancelTransfer,
        roomPeers,
        folderTransfers,
    } = useWebRTC({
        peerId,
        roomId: roomId || undefined,
        onProgress: handleProgress,
        onFileReceived: handleFileReceived,
        onFolderReceived: handleFolderReceived,
        onFolderProgress: handleFolderProgress,
        onError: handleError,
    });

    // 加入房间
    const handleJoinRoom = useCallback(() => {
        if (inputRoomId.trim()) {
            setRoomId(inputRoomId.trim());
            // 需要重新连接
            if (connectionState === 'connected') {
                disconnect();
            }
        }
    }, [inputRoomId, connectionState, disconnect]);

    // 连接到 Peer
    const handleConnectToPeer = useCallback(async (targetPeerId: string) => {
        try {
            await connectToPeer(targetPeerId);
            setSelectedPeer(targetPeerId);
        } catch (e) {
            console.error('Failed to connect to peer:', e);
        }
    }, [connectToPeer]);

    // 发送文件
    const handleSendFile = useCallback(async () => {
        if (!selectedPeer || !fileInputRef.current?.files?.length) {
            return;
        }

        const file = fileInputRef.current.files[0];
        try {
            await sendFile(selectedPeer, file);
        } catch (e) {
            console.error('Failed to send file:', e);
        }

        // 清空文件选择
        fileInputRef.current.value = '';
    }, [selectedPeer, sendFile]);

    // 发送文件夹
    const handleSendFolder = useCallback(async () => {
        if (!selectedPeer || !folderInputRef.current?.files?.length) {
            return;
        }

        const files = folderInputRef.current.files;
        try {
            await sendFolder(selectedPeer, files);
        } catch (e) {
            console.error('Failed to send folder:', e);
        }

        // 清空文件夹选择
        folderInputRef.current.value = '';
    }, [selectedPeer, sendFolder]);

    // 下载接收到的文件
    const handleDownloadFile = useCallback((file: File) => {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
    }, []);

    // 下载接收到的文件夹（打包为 zip）
    const handleDownloadFolder = useCallback(async (
        folderName: string,
        files: Map<string, File>
    ) => {
        const zip = new JSZip();

        for (const [relativePath, file] of files) {
            const arrayBuffer = await file.arrayBuffer();
            zip.file(relativePath, arrayBuffer);
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${folderName}.zip`;
        a.click();
        URL.revokeObjectURL(url);
    }, []);

    return (
        <div className={cn('flex flex-col bg-commander-bg p-4 space-y-4', className)}>
            {/* 标题 */}
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">
                    <span className="text-commander-accent">P2P</span> 文件传输
                </h2>
                <span className={cn(
                    'text-xs px-2 py-1 rounded',
                    connectionState === 'connected' ? 'bg-green-500/20 text-green-400' :
                        connectionState === 'connecting' ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-red-500/20 text-red-400'
                )}>
                    {connectionState === 'connected' ? '已连接' :
                        connectionState === 'connecting' ? '连接中...' :
                            '未连接'}
                </span>
            </div>

            {/* 本机信息 */}
            <div className="bg-commander-header rounded-lg p-3">
                <div className="text-xs text-commander-text-dim">我的 Peer ID</div>
                <div className="font-mono text-sm mt-1">{peerId}</div>
            </div>

            {/* 房间管理 */}
            <div className="space-y-2">
                <div className="text-sm font-medium">房间</div>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={inputRoomId}
                        onChange={(e) => setInputRoomId(e.target.value)}
                        placeholder="输入房间 ID"
                        className="flex-1 px-3 py-1.5 bg-commander-bg border border-commander-border rounded text-sm"
                    />
                    <button
                        onClick={handleJoinRoom}
                        className="px-4 py-1.5 bg-commander-accent text-white rounded text-sm hover:bg-opacity-90"
                    >
                        加入
                    </button>
                </div>

                {roomId && (
                    <div className="text-xs text-commander-text-dim">
                        当前房间: <span className="font-mono">{roomId}</span>
                    </div>
                )}
            </div>

            {/* 连接控制 */}
            <div className="flex gap-2">
                <button
                    onClick={connect}
                    disabled={connectionState === 'connected' || connectionState === 'connecting'}
                    className={cn(
                        'flex-1 px-4 py-2 rounded text-sm font-medium transition-colors',
                        connectionState === 'connected' || connectionState === 'connecting'
                            ? 'bg-commander-border text-commander-text-dim cursor-not-allowed'
                            : 'bg-green-600 text-white hover:bg-green-500'
                    )}
                >
                    连接
                </button>
                <button
                    onClick={disconnect}
                    disabled={connectionState !== 'connected'}
                    className={cn(
                        'flex-1 px-4 py-2 rounded text-sm font-medium transition-colors',
                        connectionState !== 'connected'
                            ? 'bg-commander-border text-commander-text-dim cursor-not-allowed'
                            : 'bg-red-600 text-white hover:bg-red-500'
                    )}
                >
                    断开
                </button>
            </div>

            {/* 房间内的 Peers */}
            {roomPeers.length > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium">房间成员 ({roomPeers.length})</div>
                    <div className="space-y-1">
                        {roomPeers.map((peer) => {
                            const peerInfo = peers.get(peer);
                            const isConnected = peerInfo?.dataChannelState === 'open';

                            return (
                                <div
                                    key={peer}
                                    className={cn(
                                        'flex items-center justify-between p-2 rounded',
                                        'bg-commander-header hover:bg-commander-hover',
                                        selectedPeer === peer && 'ring-1 ring-commander-accent'
                                    )}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={cn(
                                            'w-2 h-2 rounded-full',
                                            isConnected ? 'bg-green-500' : 'bg-gray-500'
                                        )} />
                                        <span className="font-mono text-sm">{peer}</span>
                                    </div>
                                    {!isConnected ? (
                                        <button
                                            onClick={() => handleConnectToPeer(peer)}
                                            className="text-xs px-2 py-1 bg-commander-accent text-white rounded hover:bg-opacity-90"
                                        >
                                            连接
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => setSelectedPeer(peer)}
                                            className="text-xs px-2 py-1 bg-commander-border text-commander-text rounded hover:bg-commander-hover"
                                        >
                                            选择
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 发送文件 / 文件夹 */}
            {selectedPeer && (
                <div className="space-y-3">
                    <div className="text-sm font-medium">发送到 {selectedPeer}</div>

                    {/* 发送单个文件 */}
                    <div className="space-y-1">
                        <div className="text-xs text-commander-text-dim">文件</div>
                        <div className="flex gap-2">
                            <input
                                ref={fileInputRef}
                                type="file"
                                className="flex-1 text-sm"
                            />
                            <button
                                onClick={handleSendFile}
                                className="px-4 py-1.5 bg-commander-accent text-white rounded text-sm hover:bg-opacity-90"
                            >
                                发送
                            </button>
                        </div>
                    </div>

                    {/* 发送文件夹 */}
                    <div className="space-y-1">
                        <div className="text-xs text-commander-text-dim">文件夹（保持目录结构）</div>
                        <div className="flex gap-2">
                            <input
                                ref={folderInputRef}
                                type="file"
                                webkitdirectory=""
                                directory=""
                                multiple
                                className="flex-1 text-sm"
                            />
                            <button
                                onClick={handleSendFolder}
                                className="px-4 py-1.5 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-500"
                            >
                                发送文件夹
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 文件夹传输进度 */}
            {folderTransfers.size > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium">文件夹传输 ({folderTransfers.size})</div>
                    <div className="space-y-2 max-h-48 overflow-auto">
                        {Array.from(folderTransfers.values()).map((ft) => (
                            <div key={ft.batchId} className="bg-commander-header rounded-lg p-3 space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium truncate flex-1" title={ft.folderName}>
                                        📁 {ft.folderName}
                                    </span>
                                    <span className={cn(
                                        'text-xs px-2 py-0.5 rounded text-white',
                                        ft.status === 'completed' ? 'bg-green-500' :
                                            ft.status === 'transferring' ? 'bg-blue-500' :
                                                'bg-yellow-500'
                                    )}>
                                        {ft.status === 'completed' ? '已完成' :
                                            ft.status === 'transferring' ? '传输中' :
                                                '等待中'}
                                    </span>
                                </div>

                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-2 bg-commander-border rounded-full overflow-hidden">
                                        <div
                                            className={cn(
                                                'h-full transition-all duration-300',
                                                ft.status === 'completed' ? 'bg-green-500' : 'bg-indigo-500'
                                            )}
                                            style={{ width: `${ft.progress}%` }}
                                        />
                                    </div>
                                    <span className="text-xs text-commander-text-dim w-12 text-right">
                                        {Math.round(ft.progress)}%
                                    </span>
                                </div>

                                <div className="flex items-center justify-between text-xs text-commander-text-dim">
                                    <span>{ft.completedFiles} / {ft.totalFiles} 文件</span>
                                    <span>{formatSize(ft.transferredBytes)} / {formatSize(ft.totalBytes)}</span>
                                    {ft.status === 'transferring' && ft.speed > 0 && (
                                        <span>{formatSpeed(ft.speed)}</span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 单文件传输进度 */}
            {transfers.size > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium">传输任务 ({transfers.size})</div>
                    <div className="space-y-2 max-h-48 overflow-auto">
                        {Array.from(transfers.values()).map((transfer) => (
                            <TransferItem
                                key={transfer.fileId}
                                transfer={transfer}
                                onCancel={
                                    transfer.status === 'transferring'
                                        ? () => cancelTransfer(transfer.fileId)
                                        : undefined
                                }
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* 接收到的文件 */}
            {receivedFiles.length > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium">接收到的文件 ({receivedFiles.length})</div>
                    <div className="space-y-1">
                        {receivedFiles.map((file, index) => (
                            <div
                                key={index}
                                className="flex items-center justify-between p-2 bg-commander-header rounded"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm truncate">{file.name}</div>
                                    <div className="text-xs text-commander-text-dim">
                                        {formatSize(file.size)}
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleDownloadFile(file)}
                                    className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-500"
                                >
                                    下载
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 接收到的文件夹 */}
            {receivedFolders.length > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium">接收到的文件夹 ({receivedFolders.length})</div>
                    <div className="space-y-1">
                        {receivedFolders.map((folder) => (
                            <div
                                key={folder.batchId}
                                className="flex items-center justify-between p-2 bg-commander-header rounded"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm truncate">📁 {folder.folderName}</div>
                                    <div className="text-xs text-commander-text-dim">
                                        {folder.files.size} 个文件 · {formatSize(
                                            Array.from(folder.files.values()).reduce((sum, f) => sum + f.size, 0)
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleDownloadFolder(folder.folderName, folder.files)}
                                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-500"
                                >
                                    下载 ZIP
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
});

P2PTransferPanel.displayName = 'P2PTransferPanel';

export default P2PTransferPanel;
