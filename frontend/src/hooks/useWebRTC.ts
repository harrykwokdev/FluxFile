/**
 * FluxFile - WebRTC P2P 文件传输 Hook
 * =====================================
 * 
 * 实现浏览器端到端的直接文件传输，绕过服务器存储。
 * 
 * 核心特性：
 * 1. RTCPeerConnection + RTCDataChannel 建立 P2P 连接
 * 2. 文件分片传输（16KB/片），防止内存溢出
 * 3. 流控：监听 bufferedAmountLow 事件，防止发送缓冲区溢出
 * 4. 进度反馈：实时传输进度和速度统计
 * 
 * 数据通道消息协议：
 * - meta: { type: 'meta', ...P2PFileMetadata } 文件元数据
 * - chunk: { type: 'chunk', fileId, index, data } 文件数据块
 * - ack: { type: 'ack', fileId, index } 确认接收
 * - complete: { type: 'complete', fileId } 传输完成
 * - cancel: { type: 'cancel', fileId } 取消传输
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    WebRTCConnectionState,
    SignalingMessage,
    P2PFileMetadata,
    P2PTransferProgress,
    P2PPeer,
    P2PFolderProgress,
} from '@/types';

// ============================================================================
// 配置常量
// ============================================================================

/** 每个分片大小（bytes） */
const CHUNK_SIZE = 16 * 1024; // 16KB

/** 发送缓冲区低水位阈值 */
const BUFFER_LOW_THRESHOLD = 256 * 1024; // 256KB

/** 发送缓冲区最大值 */
const BUFFER_HIGH_THRESHOLD = 1024 * 1024; // 1MB

/** ICE 服务器配置 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

/** 信令服务器 WebSocket URL */
const getSignalingUrl = (peerId: string, roomId?: string): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let url = `${protocol}//${host}/api/signaling/ws/${peerId}`;
    if (roomId) {
        url += `?room=${encodeURIComponent(roomId)}`;
    }
    return url;
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成唯一 ID
 */
const generateId = (): string => {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

/**
 * 将 File 转换为 ArrayBuffer 分片
 */
async function* fileToChunks(
    file: File,
    chunkSize: number = CHUNK_SIZE
): AsyncGenerator<{ index: number; data: ArrayBuffer; isLast: boolean }> {
    const totalChunks = Math.ceil(file.size / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const blob = file.slice(start, end);
        const data = await blob.arrayBuffer();

        yield {
            index: i,
            data,
            isLast: i === totalChunks - 1,
        };
    }
}

/**
 * 将接收到的分片组装成 File
 */
function chunksToFile(
    chunks: Map<number, ArrayBuffer>,
    metadata: P2PFileMetadata
): File {
    const sortedChunks: ArrayBuffer[] = [];

    for (let i = 0; i < metadata.totalChunks; i++) {
        const chunk = chunks.get(i);
        if (!chunk) {
            throw new Error(`Missing chunk ${i}`);
        }
        sortedChunks.push(chunk);
    }

    const blob = new Blob(sortedChunks, { type: metadata.type });
    return new File([blob], metadata.name, {
        type: metadata.type,
        lastModified: metadata.lastModified,
    });
}

// ============================================================================
// 类型定义
// ============================================================================

interface UseWebRTCOptions {
    /** 本地 Peer ID */
    peerId: string;
    /** 房间 ID（可选） */
    roomId?: string;
    /** ICE 服务器配置 */
    iceServers?: RTCIceServer[];
    /** 传输进度回调 */
    onProgress?: (progress: P2PTransferProgress) => void;
    /** 文件接收完成回调 */
    onFileReceived?: (file: File, fromPeer: string) => void;
    /** Peer 加入回调 */
    onPeerJoined?: (peerId: string) => void;
    /** Peer 离开回调 */
    onPeerLeft?: (peerId: string) => void;
    /** 错误回调 */
    onError?: (error: Error) => void;
    /** 文件夹接收完成回调 */
    onFolderReceived?: (batchId: string, folderName: string, files: Map<string, File>) => void;
    /** 文件夹传输进度回调 */
    onFolderProgress?: (progress: P2PFolderProgress) => void;
}

interface UseWebRTCReturn {
    /** 连接状态 */
    connectionState: WebRTCConnectionState;
    /** 已连接的 Peers */
    peers: Map<string, P2PPeer>;
    /** 当前传输任务 */
    transfers: Map<string, P2PTransferProgress>;
    /** 连接到信令服务器 */
    connect: () => void;
    /** 断开信令连接 */
    disconnect: () => void;
    /** 向指定 Peer 发起连接 */
    connectToPeer: (targetPeerId: string) => Promise<void>;
    /** 发送文件到指定 Peer */
    sendFile: (targetPeerId: string, file: File) => Promise<string>;
    /** 发送文件夹到指定 Peer（保持目录结构） */
    sendFolder: (targetPeerId: string, files: FileList) => Promise<string>;
    /** 取消传输 */
    cancelTransfer: (fileId: string) => void;
    /** 房间内的其他 Peers */
    roomPeers: string[];
    /** 文件夹传输进度 */
    folderTransfers: Map<string, P2PFolderProgress>;
}

// ============================================================================
// Hook 实现
// ============================================================================

export function useWebRTC(options: UseWebRTCOptions): UseWebRTCReturn {
    const {
        peerId,
        roomId,
        iceServers = DEFAULT_ICE_SERVERS,
        onProgress,
        onFileReceived,
        onPeerJoined,
        onPeerLeft,
        onError,
        onFolderReceived,
        onFolderProgress,
    } = options;

    // 状态
    const [connectionState, setConnectionState] = useState<WebRTCConnectionState>('new');
    const [peers, setPeers] = useState<Map<string, P2PPeer>>(new Map());
    const [transfers, setTransfers] = useState<Map<string, P2PTransferProgress>>(new Map());
    const [roomPeers, setRoomPeers] = useState<string[]>([]);
    const [folderTransfers, setFolderTransfers] = useState<Map<string, P2PFolderProgress>>(new Map());

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());

    // 接收缓冲区: peerId -> fileId -> { metadata, chunks }
    const receiveBuffersRef = useRef<Map<string, Map<string, {
        metadata: P2PFileMetadata;
        chunks: Map<number, ArrayBuffer>;
        receivedBytes: number;
        startTime: number;
    }>>>(new Map());

    // 发送任务: fileId -> { file, targetPeer, cancel }
    const sendTasksRef = useRef<Map<string, {
        file: File;
        targetPeer: string;
        cancelled: boolean;
    }>>(new Map());

    // 文件夹批次接收跟踪: batchId -> { folderName, totalFiles, receivedFiles, totalBytes, receivedBytes }
    const folderBatchesRef = useRef<Map<string, {
        folderName: string;
        totalFiles: number;
        totalBytes: number;
        receivedBytes: number;
        receivedFiles: Map<string, File>;
        startTime: number;
    }>>(new Map());

    // ========================================================================
    // 信令处理
    // ========================================================================

    /**
     * 发送信令消息
     */
    const sendSignaling = useCallback((message: Partial<SignalingMessage>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(message));
        }
    }, []);

    /**
     * 清理 Peer 连接
     */
    const cleanupPeerConnection = useCallback((targetPeerId: string) => {
        // 关闭 DataChannel
        const dc = dataChannelsRef.current.get(targetPeerId);
        if (dc) {
            dc.close();
            dataChannelsRef.current.delete(targetPeerId);
        }

        // 关闭 PeerConnection
        const pc = peerConnectionsRef.current.get(targetPeerId);
        if (pc) {
            pc.close();
            peerConnectionsRef.current.delete(targetPeerId);
        }

        // 更新状态
        setPeers((prev) => {
            const next = new Map(prev);
            next.delete(targetPeerId);
            return next;
        });

        // 清理接收缓冲区
        receiveBuffersRef.current.delete(targetPeerId);
    }, []);

    // ========================================================================
    // WebRTC 连接管理
    // ========================================================================

    /**
     * 创建 PeerConnection
     */
    const createPeerConnection = useCallback((targetPeerId: string): RTCPeerConnection => {
        const pc = new RTCPeerConnection({ iceServers });
        peerConnectionsRef.current.set(targetPeerId, pc);

        // 更新 Peer 状态
        const updatePeerState = () => {
            setPeers((prev) => {
                const next = new Map(prev);
                const dc = dataChannelsRef.current.get(targetPeerId);
                next.set(targetPeerId, {
                    id: targetPeerId,
                    connectionState: pc.connectionState as WebRTCConnectionState,
                    dataChannelState: dc?.readyState || 'none',
                });
                return next;
            });
        };

        // ICE Candidate 事件
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignaling({
                    type: 'ice-candidate',
                    to_peer: targetPeerId,
                    candidate: event.candidate.toJSON(),
                });
            }
        };

        // 连接状态变化
        pc.onconnectionstatechange = () => {
            updatePeerState();

            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                cleanupPeerConnection(targetPeerId);
            }
        };

        // DataChannel 事件（接收方）
        pc.ondatachannel = (event) => {
            const dc = event.channel;
            setupDataChannel(dc, targetPeerId);
        };

        return pc;
    }, [iceServers, sendSignaling, cleanupPeerConnection]);

    /**
     * 设置 DataChannel
     */
    const setupDataChannel = useCallback((dc: RTCDataChannel, targetPeerId: string) => {
        dataChannelsRef.current.set(targetPeerId, dc);
        dc.binaryType = 'arraybuffer';

        const updatePeerState = () => {
            setPeers((prev) => {
                const next = new Map(prev);
                const pc = peerConnectionsRef.current.get(targetPeerId);
                next.set(targetPeerId, {
                    id: targetPeerId,
                    connectionState: (pc?.connectionState as WebRTCConnectionState) || 'closed',
                    dataChannelState: dc.readyState,
                });
                return next;
            });
        };

        dc.onopen = updatePeerState;
        dc.onclose = updatePeerState;
        dc.onerror = (event) => {
            console.error('DataChannel error:', event);
            onError?.(new Error('DataChannel error'));
        };

        // 消息处理
        dc.onmessage = (event) => {
            handleDataChannelMessage(targetPeerId, event.data);
        };
    }, [onError]);

    /**
     * 处理 DataChannel 消息
     */
    const handleDataChannelMessage = useCallback((fromPeer: string, data: ArrayBuffer | string) => {
        // 如果是字符串，解析为 JSON 控制消息
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                handleControlMessage(fromPeer, message);
            } catch (e) {
                console.error('Failed to parse control message:', e);
            }
            return;
        }

        // 二进制数据：文件分片
        // 前 4 字节是 fileId 长度，接下来是 fileId，然后是 4 字节 index，最后是数据
        const view = new DataView(data);
        const fileIdLength = view.getUint32(0);
        const fileIdBytes = new Uint8Array(data, 4, fileIdLength);
        const fileId = new TextDecoder().decode(fileIdBytes);
        const chunkIndex = view.getUint32(4 + fileIdLength);
        const chunkData = data.slice(8 + fileIdLength);

        handleChunkReceived(fromPeer, fileId, chunkIndex, chunkData);
    }, []);

    /**
     * 处理控制消息
     */
    const handleControlMessage = useCallback((fromPeer: string, message: any) => {
        switch (message.type) {
            case 'meta':
                // 文件元数据
                handleFileMetadata(fromPeer, message as P2PFileMetadata);
                break;

            case 'complete':
                // 传输完成
                handleTransferComplete(fromPeer, message.fileId);
                break;

            case 'cancel':
                // 传输取消
                handleTransferCancel(fromPeer, message.fileId);
                break;

            case 'batch-start':
                // 文件夹批量传输开始
                handleBatchStart(message);
                break;

            case 'batch-end':
                // 文件夹批量传输结束
                handleBatchEnd(message.batchId);
                break;
        }
    }, []);

    /**
     * 处理文件夹批量传输开始
     */
    const handleBatchStart = useCallback((message: any) => {
        const { batchId, folderName, totalFiles, totalBytes } = message;

        folderBatchesRef.current.set(batchId, {
            folderName,
            totalFiles,
            totalBytes: totalBytes || 0,
            receivedBytes: 0,
            receivedFiles: new Map(),
            startTime: Date.now(),
        });

        const folderProgress: P2PFolderProgress = {
            batchId,
            folderName,
            totalFiles,
            completedFiles: 0,
            totalBytes: totalBytes || 0,
            transferredBytes: 0,
            progress: 0,
            speed: 0,
            status: 'pending',
        };

        setFolderTransfers((prev) => new Map(prev).set(batchId, folderProgress));
        onFolderProgress?.(folderProgress);
    }, [onFolderProgress]);

    /**
     * 处理文件夹批量传输结束
     */
    const handleBatchEnd = useCallback((batchId: string) => {
        const batch = folderBatchesRef.current.get(batchId);
        if (!batch) return;

        // 触发文件夹接收回调
        if (batch.receivedFiles.size > 0) {
            onFolderReceived?.(batchId, batch.folderName, batch.receivedFiles);
        }

        // 更新进度状态
        setFolderTransfers((prev) => {
            const next = new Map(prev);
            const existing = next.get(batchId);
            if (existing) {
                next.set(batchId, {
                    ...existing,
                    status: 'completed',
                    progress: 100,
                    completedFiles: batch.receivedFiles.size,
                });
            }
            return next;
        });

        // 不立即清理 ref，让 UI 有时间显示
    }, [onFolderReceived]);

    /**
     * 处理文件元数据
     */
    const handleFileMetadata = useCallback((fromPeer: string, metadata: P2PFileMetadata) => {
        if (!receiveBuffersRef.current.has(fromPeer)) {
            receiveBuffersRef.current.set(fromPeer, new Map());
        }

        receiveBuffersRef.current.get(fromPeer)!.set(metadata.id, {
            metadata,
            chunks: new Map(),
            receivedBytes: 0,
            startTime: Date.now(),
        });

        // 如果属于批量传输，不为每个文件单独显示进度条（由 folderTransfers 统一跟踪）
        if (metadata.batchId) {
            return;
        }

        // 更新传输状态（单文件传输）
        const progress: P2PTransferProgress = {
            fileId: metadata.id,
            fileName: metadata.name,
            totalBytes: metadata.size,
            transferredBytes: 0,
            progress: 0,
            speed: 0,
            remainingTime: 0,
            status: 'pending',
        };

        setTransfers((prev) => new Map(prev).set(metadata.id, progress));
        onProgress?.(progress);
    }, [onProgress]);

    /**
     * 处理接收到的分片
     */
    const handleChunkReceived = useCallback((
        fromPeer: string,
        fileId: string,
        index: number,
        data: ArrayBuffer
    ) => {
        const peerBuffers = receiveBuffersRef.current.get(fromPeer);
        const fileBuffer = peerBuffers?.get(fileId);

        if (!fileBuffer) {
            console.warn('Received chunk for unknown file:', fileId);
            return;
        }

        // 存储分片
        fileBuffer.chunks.set(index, data);
        fileBuffer.receivedBytes += data.byteLength;

        const isBatchFile = !!fileBuffer.metadata.batchId;
        const batchId = fileBuffer.metadata.batchId;

        // 更新文件夹批次进度
        if (isBatchFile && batchId) {
            const batch = folderBatchesRef.current.get(batchId);
            if (batch) {
                batch.receivedBytes += data.byteLength;

                const elapsed = (Date.now() - batch.startTime) / 1000;
                const speed = elapsed > 0 ? batch.receivedBytes / elapsed : 0;

                const folderProgress: P2PFolderProgress = {
                    batchId,
                    folderName: batch.folderName,
                    totalFiles: batch.totalFiles,
                    completedFiles: batch.receivedFiles.size,
                    totalBytes: batch.totalBytes,
                    transferredBytes: batch.receivedBytes,
                    progress: batch.totalBytes > 0 ? (batch.receivedBytes / batch.totalBytes) * 100 : 0,
                    speed,
                    status: 'transferring',
                };

                setFolderTransfers((prev) => new Map(prev).set(batchId, folderProgress));
                onFolderProgress?.(folderProgress);
            }
        }

        if (!isBatchFile) {
            // 单文件传输：更新进度
            const elapsed = (Date.now() - fileBuffer.startTime) / 1000;
            const speed = elapsed > 0 ? fileBuffer.receivedBytes / elapsed : 0;
            const remaining = speed > 0
                ? (fileBuffer.metadata.size - fileBuffer.receivedBytes) / speed
                : 0;

            const progress: P2PTransferProgress = {
                fileId,
                fileName: fileBuffer.metadata.name,
                totalBytes: fileBuffer.metadata.size,
                transferredBytes: fileBuffer.receivedBytes,
                progress: (fileBuffer.receivedBytes / fileBuffer.metadata.size) * 100,
                speed,
                remainingTime: remaining,
                status: 'transferring',
            };

            setTransfers((prev) => new Map(prev).set(fileId, progress));
            onProgress?.(progress);
        }

        // 检查是否接收完成
        if (fileBuffer.chunks.size === fileBuffer.metadata.totalChunks) {
            try {
                const file = chunksToFile(fileBuffer.chunks, fileBuffer.metadata);

                if (isBatchFile && batchId) {
                    // 文件夹批次：存入 batch，不触发单文件回调
                    const batch = folderBatchesRef.current.get(batchId);
                    if (batch) {
                        const relativePath = fileBuffer.metadata.relativePath || fileBuffer.metadata.name;
                        batch.receivedFiles.set(relativePath, file);

                        // 更新文件夹进度中的 completedFiles
                        const elapsed = (Date.now() - batch.startTime) / 1000;
                        const speed = elapsed > 0 ? batch.receivedBytes / elapsed : 0;

                        const folderProgress: P2PFolderProgress = {
                            batchId,
                            folderName: batch.folderName,
                            totalFiles: batch.totalFiles,
                            completedFiles: batch.receivedFiles.size,
                            totalBytes: batch.totalBytes,
                            transferredBytes: batch.receivedBytes,
                            progress: batch.totalBytes > 0 ? (batch.receivedBytes / batch.totalBytes) * 100 : 0,
                            speed,
                            status: 'transferring',
                        };

                        setFolderTransfers((prev) => new Map(prev).set(batchId, folderProgress));
                        onFolderProgress?.(folderProgress);
                    }
                } else {
                    // 单文件：更新完成状态并触发回调
                    const completeProgress: P2PTransferProgress = {
                        fileId,
                        fileName: fileBuffer.metadata.name,
                        totalBytes: fileBuffer.metadata.size,
                        transferredBytes: fileBuffer.metadata.size,
                        progress: 100,
                        speed: 0,
                        remainingTime: 0,
                        status: 'completed',
                    };
                    setTransfers((prev) => new Map(prev).set(fileId, completeProgress));
                    onProgress?.(completeProgress);
                    onFileReceived?.(file, fromPeer);
                }

                // 清理缓冲区
                peerBuffers?.delete(fileId);
            } catch (e) {
                console.error('Failed to assemble file:', e);
                onError?.(e as Error);
            }
        }
    }, [onProgress, onFileReceived, onError, onFolderProgress]);

    /**
     * 处理传输完成
     */
    const handleTransferComplete = useCallback((_fromPeer: string, fileId: string) => {
        setTransfers((prev) => {
            const next = new Map(prev);
            const existing = next.get(fileId);
            if (existing) {
                next.set(fileId, { ...existing, status: 'completed', progress: 100 });
            }
            return next;
        });
    }, []);

    /**
     * 处理传输取消
     */
    const handleTransferCancel = useCallback((fromPeer: string, fileId: string) => {
        // 清理接收缓冲区
        receiveBuffersRef.current.get(fromPeer)?.delete(fileId);

        setTransfers((prev) => {
            const next = new Map(prev);
            const existing = next.get(fileId);
            if (existing) {
                next.set(fileId, { ...existing, status: 'cancelled' });
            }
            return next;
        });
    }, []);

    // ========================================================================
    // SDP 处理
    // ========================================================================

    /**
     * 处理收到的 Offer
     */
    const handleOffer = useCallback(async (
        fromPeer: string,
        sdp: RTCSessionDescriptionInit
    ) => {
        let pc = peerConnectionsRef.current.get(fromPeer);
        if (!pc) {
            pc = createPeerConnection(fromPeer);
        }

        await pc.setRemoteDescription(sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignaling({
            type: 'answer',
            to_peer: fromPeer,
            sdp: answer,
        });
    }, [createPeerConnection, sendSignaling]);

    /**
     * 处理收到的 Answer
     */
    const handleAnswer = useCallback(async (
        fromPeer: string,
        sdp: RTCSessionDescriptionInit
    ) => {
        const pc = peerConnectionsRef.current.get(fromPeer);
        if (pc) {
            await pc.setRemoteDescription(sdp);
        }
    }, []);

    /**
     * 处理收到的 ICE Candidate
     */
    const handleIceCandidate = useCallback(async (
        fromPeer: string,
        candidate: RTCIceCandidateInit
    ) => {
        const pc = peerConnectionsRef.current.get(fromPeer);
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }, []);

    /**
     * 处理收到的信令消息
     */
    const handleSignalingMessage = useCallback(async (message: SignalingMessage) => {
        const { type, from_peer, sdp, candidate, peers: roomPeerList } = message;

        switch (type) {
            case 'room-joined':
            case 'room-info':
                // 收到房间信息
                if (roomPeerList) {
                    setRoomPeers(roomPeerList);
                    onPeerJoined?.(from_peer || 'room');
                }
                break;

            case 'peer-joined':
                // 新 Peer 加入
                if (from_peer) {
                    setRoomPeers((prev) => [...prev.filter((p) => p !== from_peer), from_peer]);
                    onPeerJoined?.(from_peer);
                }
                break;

            case 'peer-left':
                // Peer 离开
                if (from_peer) {
                    setRoomPeers((prev) => prev.filter((p) => p !== from_peer));
                    // 清理连接
                    cleanupPeerConnection(from_peer);
                    onPeerLeft?.(from_peer);
                }
                break;

            case 'offer':
                // 收到 SDP Offer
                if (from_peer && sdp) {
                    await handleOffer(from_peer, sdp);
                }
                break;

            case 'answer':
                // 收到 SDP Answer
                if (from_peer && sdp) {
                    await handleAnswer(from_peer, sdp);
                }
                break;

            case 'ice-candidate':
                // 收到 ICE Candidate
                if (from_peer && candidate) {
                    await handleIceCandidate(from_peer, candidate);
                }
                break;

            case 'error':
                onError?.(new Error(message.error || 'Signaling error'));
                break;
        }
    }, [onPeerJoined, onPeerLeft, onError, handleOffer, handleAnswer, handleIceCandidate, cleanupPeerConnection]);

    // ========================================================================
    // 公开方法
    // ========================================================================

    /**
     * 连接到信令服务器
     */
    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            return;
        }

        setConnectionState('connecting');

        const ws = new WebSocket(getSignalingUrl(peerId, roomId));
        wsRef.current = ws;

        ws.onopen = () => {
            setConnectionState('connected');

            // 如果有 roomId，加入房间
            if (roomId) {
                sendSignaling({
                    type: 'join',
                    room_id: roomId,
                });
            }
        };

        ws.onclose = () => {
            setConnectionState('disconnected');
        };

        ws.onerror = () => {
            setConnectionState('failed');
            onError?.(new Error('WebSocket connection failed'));
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data) as SignalingMessage;
                handleSignalingMessage(message);
            } catch (e) {
                console.error('Failed to parse signaling message:', e);
            }
        };
    }, [peerId, roomId, sendSignaling, handleSignalingMessage, onError]);

    /**
     * 断开信令连接
     */
    const disconnect = useCallback(() => {
        // 清理所有 Peer 连接
        for (const peerId of peerConnectionsRef.current.keys()) {
            cleanupPeerConnection(peerId);
        }

        // 关闭 WebSocket
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        setConnectionState('closed');
        setPeers(new Map());
        setRoomPeers([]);
    }, [cleanupPeerConnection]);

    /**
     * 向指定 Peer 发起连接
     */
    const connectToPeer = useCallback(async (targetPeerId: string) => {
        // 创建 PeerConnection
        const pc = createPeerConnection(targetPeerId);

        // 创建 DataChannel
        const dc = pc.createDataChannel('fileTransfer', {
            ordered: true,
        });
        setupDataChannel(dc, targetPeerId);

        // 创建并发送 Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignaling({
            type: 'offer',
            to_peer: targetPeerId,
            sdp: offer,
        });
    }, [createPeerConnection, setupDataChannel, sendSignaling]);

    /**
     * 发送文件到指定 Peer
     */
    const sendFile = useCallback(async (
        targetPeerId: string,
        file: File
    ): Promise<string> => {
        const dc = dataChannelsRef.current.get(targetPeerId);

        if (!dc || dc.readyState !== 'open') {
            throw new Error('DataChannel not ready');
        }

        const fileId = generateId();
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        // 创建任务
        sendTasksRef.current.set(fileId, {
            file,
            targetPeer: targetPeerId,
            cancelled: false,
        });

        // 发送元数据
        const metadata = {
            type: 'meta',
            id: fileId,
            name: file.name,
            size: file.size,
            mimeType: file.type,
            lastModified: file.lastModified,
            chunkSize: CHUNK_SIZE,
            totalChunks,
        };

        dc.send(JSON.stringify(metadata));

        // 初始化进度
        const progress: P2PTransferProgress = {
            fileId,
            fileName: file.name,
            totalBytes: file.size,
            transferredBytes: 0,
            progress: 0,
            speed: 0,
            remainingTime: 0,
            status: 'transferring',
        };

        setTransfers((prev) => new Map(prev).set(fileId, progress));
        onProgress?.(progress);

        // 发送分片
        const startTime = Date.now();
        let sentBytes = 0;

        for await (const { index, data } of fileToChunks(file, CHUNK_SIZE)) {
            // 检查是否取消
            const task = sendTasksRef.current.get(fileId);
            if (!task || task.cancelled) {
                dc.send(JSON.stringify({ type: 'cancel', fileId }));
                setTransfers((prev) => {
                    const next = new Map(prev);
                    const existing = next.get(fileId);
                    if (existing) {
                        next.set(fileId, { ...existing, status: 'cancelled' });
                    }
                    return next;
                });
                throw new Error('Transfer cancelled');
            }

            // 流控：等待缓冲区有空间
            while (dc.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
                await new Promise<void>((resolve) => {
                    const onBufferLow = () => {
                        dc.removeEventListener('bufferedamountlow', onBufferLow);
                        resolve();
                    };
                    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
                    dc.addEventListener('bufferedamountlow', onBufferLow);
                });
            }

            // 构建二进制消息：fileId长度(4) + fileId + index(4) + data
            const fileIdBytes = new TextEncoder().encode(fileId);
            const header = new ArrayBuffer(8 + fileIdBytes.length);
            const headerView = new DataView(header);
            headerView.setUint32(0, fileIdBytes.length);
            new Uint8Array(header, 4, fileIdBytes.length).set(fileIdBytes);
            headerView.setUint32(4 + fileIdBytes.length, index);

            // 合并 header 和 data
            const message = new Uint8Array(header.byteLength + data.byteLength);
            message.set(new Uint8Array(header), 0);
            message.set(new Uint8Array(data), header.byteLength);

            dc.send(message.buffer);

            sentBytes += data.byteLength;

            // 更新进度
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = elapsed > 0 ? sentBytes / elapsed : 0;
            const remaining = speed > 0 ? (file.size - sentBytes) / speed : 0;

            const currentProgress: P2PTransferProgress = {
                fileId,
                fileName: file.name,
                totalBytes: file.size,
                transferredBytes: sentBytes,
                progress: (sentBytes / file.size) * 100,
                speed,
                remainingTime: remaining,
                status: 'transferring',
            };

            setTransfers((prev) => new Map(prev).set(fileId, currentProgress));
            onProgress?.(currentProgress);
        }

        // 发送完成消息
        dc.send(JSON.stringify({ type: 'complete', fileId }));

        // 更新状态
        const completeProgress: P2PTransferProgress = {
            fileId,
            fileName: file.name,
            totalBytes: file.size,
            transferredBytes: file.size,
            progress: 100,
            speed: 0,
            remainingTime: 0,
            status: 'completed',
        };

        setTransfers((prev) => new Map(prev).set(fileId, completeProgress));
        onProgress?.(completeProgress);

        // 清理任务
        sendTasksRef.current.delete(fileId);

        return fileId;
    }, [onProgress]);

    /**
     * 取消传输
     */
    const cancelTransfer = useCallback((fileId: string) => {
        const task = sendTasksRef.current.get(fileId);
        if (task) {
            task.cancelled = true;
        }
    }, []);

    /**
     * 发送文件夹到指定 Peer（保持目录结构）
     * 
     * 使用 webkitdirectory 选取的 FileList，每个 File 通过 webkitRelativePath 获取相对路径。
     * 协议：batch-start -> (meta + chunks) * N -> batch-end
     */
    const sendFolder = useCallback(async (
        targetPeerId: string,
        files: FileList
    ): Promise<string> => {
        const dc = dataChannelsRef.current.get(targetPeerId);

        if (!dc || dc.readyState !== 'open') {
            throw new Error('DataChannel not ready');
        }

        if (files.length === 0) {
            throw new Error('No files to send');
        }

        const batchId = generateId();

        // 提取文件夹名称（从第一个文件的 webkitRelativePath）
        const firstPath = files[0].webkitRelativePath || files[0].name;
        const folderName = firstPath.split('/')[0] || 'folder';

        // 计算总大小
        let totalBytes = 0;
        for (let i = 0; i < files.length; i++) {
            totalBytes += files[i].size;
        }

        // 发送 batch-start
        dc.send(JSON.stringify({
            type: 'batch-start',
            batchId,
            folderName,
            totalFiles: files.length,
            totalBytes,
        }));

        // 初始化文件夹传输进度
        const folderProgress: P2PFolderProgress = {
            batchId,
            folderName,
            totalFiles: files.length,
            completedFiles: 0,
            totalBytes,
            transferredBytes: 0,
            progress: 0,
            speed: 0,
            status: 'transferring',
        };
        setFolderTransfers((prev) => new Map(prev).set(batchId, folderProgress));
        onFolderProgress?.(folderProgress);

        const startTime = Date.now();
        let totalSentBytes = 0;
        let completedFiles = 0;

        // 逐个发送文件
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const relativePath = file.webkitRelativePath || file.name;
            const fileId = generateId();
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

            // 发送文件元数据（含 relativePath 和 batchId）
            const metadata = {
                type: 'meta',
                id: fileId,
                name: file.name,
                size: file.size,
                mimeType: file.type,
                lastModified: file.lastModified,
                chunkSize: CHUNK_SIZE,
                totalChunks,
                relativePath,
                batchId,
            };

            dc.send(JSON.stringify(metadata));

            // 发送文件分片
            for await (const { index, data } of fileToChunks(file, CHUNK_SIZE)) {
                // 流控
                while (dc.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
                    await new Promise<void>((resolve) => {
                        const onBufferLow = () => {
                            dc.removeEventListener('bufferedamountlow', onBufferLow);
                            resolve();
                        };
                        dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
                        dc.addEventListener('bufferedamountlow', onBufferLow);
                    });
                }

                // 构建二进制消息
                const fileIdBytes = new TextEncoder().encode(fileId);
                const header = new ArrayBuffer(8 + fileIdBytes.length);
                const headerView = new DataView(header);
                headerView.setUint32(0, fileIdBytes.length);
                new Uint8Array(header, 4, fileIdBytes.length).set(fileIdBytes);
                headerView.setUint32(4 + fileIdBytes.length, index);

                const message = new Uint8Array(header.byteLength + data.byteLength);
                message.set(new Uint8Array(header), 0);
                message.set(new Uint8Array(data), header.byteLength);

                dc.send(message.buffer);
                totalSentBytes += data.byteLength;

                // 更新文件夹进度
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = elapsed > 0 ? totalSentBytes / elapsed : 0;

                const currentFolderProgress: P2PFolderProgress = {
                    batchId,
                    folderName,
                    totalFiles: files.length,
                    completedFiles,
                    totalBytes,
                    transferredBytes: totalSentBytes,
                    progress: totalBytes > 0 ? (totalSentBytes / totalBytes) * 100 : 0,
                    speed,
                    status: 'transferring',
                };

                setFolderTransfers((prev) => new Map(prev).set(batchId, currentFolderProgress));
                onFolderProgress?.(currentFolderProgress);
            }

            // 发送单个文件完成
            dc.send(JSON.stringify({ type: 'complete', fileId }));
            completedFiles++;
        }

        // 发送 batch-end
        dc.send(JSON.stringify({ type: 'batch-end', batchId }));

        // 更新最终状态
        const completeProgress: P2PFolderProgress = {
            batchId,
            folderName,
            totalFiles: files.length,
            completedFiles: files.length,
            totalBytes,
            transferredBytes: totalBytes,
            progress: 100,
            speed: 0,
            status: 'completed',
        };

        setFolderTransfers((prev) => new Map(prev).set(batchId, completeProgress));
        onFolderProgress?.(completeProgress);

        return batchId;
    }, [onFolderProgress]);

    // ========================================================================
    // 清理
    // ========================================================================

    useEffect(() => {
        return () => {
            disconnect();
        };
    }, [disconnect]);

    return {
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
    };
}

export default useWebRTC;
