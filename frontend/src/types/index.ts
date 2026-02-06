/**
 * FluxFile - 类型定义
 * ======================
 * 
 * 统一的类型定义，确保前后端数据格式一致。
 */

// ============================================================================
// 文件系统类型
// ============================================================================

/**
 * 文件类型枚举
 */
export type FileType = 'file' | 'directory' | 'symlink';

/**
 * 文件条目 - 与后端 API 完全对应
 */
export interface FileEntry {
    /** 文件名 */
    name: string;
    /** 相对路径 */
    path: string;
    /** 绝对路径（可选） */
    absolutePath?: string;
    /** 文件大小（字节） */
    size: number;
    /** 修改时间（Unix 时间戳） */
    mtime: number;
    /** 修改时间 ISO 格式 */
    mtimeIso?: string;
    /** 文件类型 */
    type: FileType;
    /** 是否为隐藏文件 */
    isHidden: boolean;
    /** 权限字符串 */
    permissions?: string;
    /** 文件扩展名 */
    extension?: string;
}

/**
 * 目录列表响应
 */
export interface DirectoryListing {
    success: boolean;
    path: string;
    parent: string | null;
    entries: FileEntry[];
    totalCount: number;
    directoryCount: number;
    fileCount: number;
    totalSize: number;
}

// ============================================================================
// 面板状态类型
// ============================================================================

/**
 * 排序字段
 */
export type SortField = 'name' | 'size' | 'mtime' | 'type';

/**
 * 排序方向
 */
export type SortDirection = 'asc' | 'desc';

/**
 * 排序配置
 */
export interface SortConfig {
    field: SortField;
    direction: SortDirection;
}

/**
 * 面板源类型
 */
export type PanelSource = 'remote' | 'local';

/**
 * 面板 ID
 */
export type PanelId = 'left' | 'right';

/**
 * 视图模式
 */
export type ViewMode = 'list' | 'details' | 'icons';

/**
 * 单个面板的状态
 */
export interface PanelState {
    /** 面板 ID */
    id: PanelId;
    /** 数据源类型 */
    source: PanelSource;
    /** 当前路径 */
    currentPath: string;
    /** 文件列表 */
    entries: FileEntry[];
    /** 选中项索引集合 */
    selectedIndices: Set<number>;
    /** 最后选中的索引（用于 Shift 多选） */
    lastSelectedIndex: number;
    /** 焦点索引（键盘导航） */
    focusIndex: number;
    /** 排序配置 */
    sort: SortConfig;
    /** 是否显示隐藏文件 */
    showHidden: boolean;
    /** 加载状态 */
    loading: boolean;
    /** 错误信息 */
    error: string | null;
    /** 视图模式 */
    viewMode: ViewMode;
    /** 本地文件系统句柄（仅 source=local 时有效） */
    localHandle?: FileSystemDirectoryHandle;
}

// ============================================================================
// 操作类型
// ============================================================================

/**
 * 文件操作类型
 */
export type FileOperation = 'copy' | 'move' | 'delete' | 'rename' | 'mkdir';

/**
 * 传输任务状态
 */
export type TransferStatus =
    | 'pending'
    | 'transferring'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

/**
 * 传输任务
 */
export interface TransferTask {
    id: string;
    operation: 'upload' | 'download';
    sourcePath: string;
    destPath: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    status: TransferStatus;
    error?: string;
    startTime: number;
    endTime?: number;
    speed: number; // bytes/s
}

// ============================================================================
// API 响应类型
// ============================================================================

/**
 * 通用 API 响应
 */
export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    errorCode?: string;
}

/**
 * 哈希响应
 */
export interface HashResponse {
    success: boolean;
    path: string;
    algorithm: string;
    hash: string;
    size: number;
    durationMs: number;
}

// ============================================================================
// 本地文件系统类型（File System Access API）
// ============================================================================

/**
 * 本地文件句柄包装
 */
export interface LocalFileHandle {
    handle: FileSystemFileHandle;
    entry: FileEntry;
}

/**
 * 本地目录句柄包装
 */
export interface LocalDirectoryHandle {
    handle: FileSystemDirectoryHandle;
    path: string;
    name: string;
}

/**
 * IndexedDB 存储的句柄信息
 */
export interface StoredHandle {
    id: string;
    name: string;
    path: string;
    timestamp: number;
}

// ============================================================================
// UI 状态类型
// ============================================================================

/**
 * 对话框类型
 */
export type DialogType =
    | 'rename'
    | 'mkdir'
    | 'delete'
    | 'properties'
    | 'transfer'
    | 'settings';

/**
 * 上下文菜单项
 */
export interface ContextMenuItem {
    id: string;
    label: string;
    icon?: string;
    shortcut?: string;
    disabled?: boolean;
    separator?: boolean;
    onClick?: () => void;
}

/**
 * 快捷键绑定
 */
export interface KeyBinding {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    action: string;
}
// ============================================================================
// WebRTC P2P 类型
// ============================================================================

/**
 * WebRTC 连接状态
 */
export type WebRTCConnectionState =
    | 'new'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'failed'
    | 'closed';

/**
 * 信令消息类型
 */
export type SignalingMessageType =
    | 'offer'
    | 'answer'
    | 'ice-candidate'
    | 'join'
    | 'leave'
    | 'peer-joined'
    | 'peer-left'
    | 'room-joined'
    | 'room-info'
    | 'error'
    | 'ping'
    | 'pong';

/**
 * 信令消息
 */
export interface SignalingMessage {
    type: SignalingMessageType;
    from_peer?: string;
    to_peer?: string;
    room_id?: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    peers?: string[];
    error?: string;
}

/**
 * P2P 文件传输元数据
 */
export interface P2PFileMetadata {
    id: string;
    name: string;
    size: number;
    type: string;
    lastModified: number;
    chunkSize: number;
    totalChunks: number;
    /** 文件在文件夹中的相对路径（文件夹传输时使用） */
    relativePath?: string;
    /** 批次 ID（文件夹传输时用于分组） */
    batchId?: string;
}

/**
 * P2P 传输进度
 */
export interface P2PTransferProgress {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    progress: number; // 0-100
    speed: number; // bytes/s
    remainingTime: number; // seconds
    status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
}

/**
 * P2P Peer 信息
 */
export interface P2PPeer {
    id: string;
    connectionState: WebRTCConnectionState;
    dataChannelState: RTCDataChannelState | 'none';
}

/**
 * P2P 文件夹批量传输信息
 */
export interface P2PFolderBatch {
    batchId: string;
    folderName: string;
    totalFiles: number;
    receivedFiles: Map<string, File>;
    status: 'receiving' | 'completed' | 'failed';
}

/**
 * P2P 文件夹传输进度
 */
export interface P2PFolderProgress {
    batchId: string;
    folderName: string;
    totalFiles: number;
    completedFiles: number;
    totalBytes: number;
    transferredBytes: number;
    progress: number; // 0-100
    speed: number; // bytes/s
    status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
}