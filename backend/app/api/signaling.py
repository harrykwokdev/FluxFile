"""
FluxFile - WebRTC 信令 API
============================

提供 WebRTC P2P 连接所需的信令服务。
FastAPI 作为信令服务器，客户端之间通过 WebRTC 直接传输文件。

信令流程：
1. 发送方创建 offer，通过 WebSocket 发送给服务器
2. 服务器转发 offer 给接收方
3. 接收方创建 answer，通过 WebSocket 发送给服务器
4. 服务器转发 answer 给发送方
5. 双方交换 ICE candidates
6. WebRTC 连接建立，开始 P2P 传输
"""

import asyncio
import json
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.core.logging import get_logger

router = APIRouter()
logger = get_logger(__name__)


# ============================================================================
# 数据模型
# ============================================================================

class RTCSessionDescription(BaseModel):
    """WebRTC SDP 描述"""
    type: str = Field(..., description="offer 或 answer")
    sdp: str = Field(..., description="SDP 内容")


class RTCIceCandidate(BaseModel):
    """WebRTC ICE 候选"""
    candidate: str
    sdpMid: Optional[str] = None
    sdpMLineIndex: Optional[int] = None


class SignalingMessage(BaseModel):
    """信令消息"""
    type: str = Field(..., description="消息类型: offer, answer, ice-candidate, join, leave")
    from_peer: Optional[str] = Field(None, description="发送方 ID")
    to_peer: Optional[str] = Field(None, description="接收方 ID")
    room_id: Optional[str] = Field(None, description="房间 ID")
    payload: Optional[Dict[str, Any]] = Field(None, description="消息负载")


class Room(BaseModel):
    """传输房间"""
    id: str
    name: str
    created_at: datetime
    peers: List[str] = []


# ============================================================================
# 连接管理器
# ============================================================================

class ConnectionManager:
    """
    WebSocket 连接管理器
    
    管理所有活动的 WebSocket 连接，组织成房间结构。
    """
    
    def __init__(self):
        # 所有活动连接: peer_id -> WebSocket
        self.connections: Dict[str, WebSocket] = {}
        # 房间成员: room_id -> List[peer_id]
        self.rooms: Dict[str, List[str]] = {}
        # peer 所在房间: peer_id -> room_id
        self.peer_rooms: Dict[str, str] = {}
    
    async def connect(self, websocket: WebSocket, peer_id: str):
        """建立新连接"""
        await websocket.accept()
        self.connections[peer_id] = websocket
        logger.info(f"Peer {peer_id} 已连接")
    
    def disconnect(self, peer_id: str):
        """断开连接"""
        if peer_id in self.connections:
            del self.connections[peer_id]
        
        # 从房间移除
        if peer_id in self.peer_rooms:
            room_id = self.peer_rooms[peer_id]
            if room_id in self.rooms:
                self.rooms[room_id] = [
                    p for p in self.rooms[room_id] if p != peer_id
                ]
                # 如果房间为空，删除房间
                if not self.rooms[room_id]:
                    del self.rooms[room_id]
            del self.peer_rooms[peer_id]
        
        logger.info(f"Peer {peer_id} 已断开")
    
    async def join_room(self, peer_id: str, room_id: str):
        """加入房间"""
        # 如果已在其他房间，先离开
        if peer_id in self.peer_rooms:
            old_room = self.peer_rooms[peer_id]
            await self.leave_room(peer_id)
        
        # 创建房间（如果不存在）
        if room_id not in self.rooms:
            self.rooms[room_id] = []
        
        # 加入房间
        if peer_id not in self.rooms[room_id]:
            self.rooms[room_id].append(peer_id)
            self.peer_rooms[peer_id] = room_id
        
        logger.info(f"Peer {peer_id} 加入房间 {room_id}")
        
        # 通知房间内其他成员
        await self.broadcast_to_room(
            room_id,
            {
                "type": "peer-joined",
                "peer_id": peer_id,
                "room_id": room_id,
            },
            exclude=[peer_id],
        )
        
        # 返回房间内现有成员
        return [p for p in self.rooms[room_id] if p != peer_id]
    
    async def leave_room(self, peer_id: str):
        """离开房间"""
        if peer_id not in self.peer_rooms:
            return
        
        room_id = self.peer_rooms[peer_id]
        
        # 通知房间内其他成员
        await self.broadcast_to_room(
            room_id,
            {
                "type": "peer-left",
                "peer_id": peer_id,
                "room_id": room_id,
            },
            exclude=[peer_id],
        )
        
        # 从房间移除
        if room_id in self.rooms:
            self.rooms[room_id] = [
                p for p in self.rooms[room_id] if p != peer_id
            ]
            if not self.rooms[room_id]:
                del self.rooms[room_id]
        
        del self.peer_rooms[peer_id]
        logger.info(f"Peer {peer_id} 离开房间 {room_id}")
    
    async def send_to_peer(self, peer_id: str, message: Dict[str, Any]):
        """发送消息给指定 peer"""
        if peer_id in self.connections:
            websocket = self.connections[peer_id]
            try:
                await websocket.send_json(message)
            except Exception as e:
                logger.error(f"发送消息给 {peer_id} 失败: {e}")
                self.disconnect(peer_id)
    
    async def broadcast_to_room(
        self, 
        room_id: str, 
        message: Dict[str, Any],
        exclude: Optional[List[str]] = None,
    ):
        """向房间内所有成员广播消息"""
        if room_id not in self.rooms:
            return
        
        exclude = exclude or []
        for peer_id in self.rooms[room_id]:
            if peer_id not in exclude:
                await self.send_to_peer(peer_id, message)
    
    def get_room_peers(self, room_id: str) -> List[str]:
        """获取房间内所有成员"""
        return self.rooms.get(room_id, [])


# 全局连接管理器实例
manager = ConnectionManager()


# ============================================================================
# WebSocket 端点
# ============================================================================

@router.websocket("/ws/{peer_id}")
async def websocket_endpoint(websocket: WebSocket, peer_id: str):
    """
    WebSocket 信令端点
    
    处理 WebRTC 信令消息的交换。
    
    消息类型：
    - join: 加入房间
    - leave: 离开房间
    - offer: 发送 SDP offer
    - answer: 发送 SDP answer
    - ice-candidate: 发送 ICE candidate
    """
    await manager.connect(websocket, peer_id)
    
    try:
        while True:
            # 接收消息
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "join":
                # 加入房间
                room_id = data.get("room_id", "default")
                existing_peers = await manager.join_room(peer_id, room_id)
                
                # 返回房间内现有成员
                await manager.send_to_peer(peer_id, {
                    "type": "room-joined",
                    "room_id": room_id,
                    "peers": existing_peers,
                })
            
            elif message_type == "leave":
                # 离开房间
                await manager.leave_room(peer_id)
                await manager.send_to_peer(peer_id, {
                    "type": "room-left",
                })
            
            elif message_type == "offer":
                # 转发 SDP offer
                to_peer = data.get("to_peer")
                if to_peer:
                    await manager.send_to_peer(to_peer, {
                        "type": "offer",
                        "from_peer": peer_id,
                        "sdp": data.get("sdp"),
                    })
            
            elif message_type == "answer":
                # 转发 SDP answer
                to_peer = data.get("to_peer")
                if to_peer:
                    await manager.send_to_peer(to_peer, {
                        "type": "answer",
                        "from_peer": peer_id,
                        "sdp": data.get("sdp"),
                    })
            
            elif message_type == "ice-candidate":
                # 转发 ICE candidate
                to_peer = data.get("to_peer")
                if to_peer:
                    await manager.send_to_peer(to_peer, {
                        "type": "ice-candidate",
                        "from_peer": peer_id,
                        "candidate": data.get("candidate"),
                    })
            
            elif message_type == "ping":
                # 心跳响应
                await manager.send_to_peer(peer_id, {"type": "pong"})
            
            else:
                logger.warning(f"未知消息类型: {message_type}")
    
    except WebSocketDisconnect:
        manager.disconnect(peer_id)
    except Exception as e:
        logger.error(f"WebSocket 错误: {e}")
        manager.disconnect(peer_id)


# ============================================================================
# REST API 端点
# ============================================================================

@router.post("/room/create")
async def create_room(
    name: str = "Unnamed Room",
) -> Dict[str, Any]:
    """
    创建传输房间
    
    创建一个新的房间用于 P2P 文件传输。
    
    Returns:
        房间信息，包含 room_id
    """
    room_id = str(uuid4())[:8]  # 简短的房间 ID
    manager.rooms[room_id] = []
    
    return {
        "room_id": room_id,
        "name": name,
        "created_at": datetime.utcnow().isoformat(),
    }


@router.get("/room/{room_id}")
async def get_room_info(room_id: str) -> Dict[str, Any]:
    """
    获取房间信息
    
    Returns:
        房间信息，包含成员列表
    """
    if room_id not in manager.rooms:
        return {"error": "Room not found"}
    
    return {
        "room_id": room_id,
        "peers": manager.rooms[room_id],
        "peer_count": len(manager.rooms[room_id]),
    }


@router.get("/rooms")
async def list_rooms() -> Dict[str, Any]:
    """
    列出所有活跃房间
    
    Returns:
        房间列表
    """
    rooms = []
    for room_id, peers in manager.rooms.items():
        rooms.append({
            "room_id": room_id,
            "peers": peers,
            "peer_count": len(peers),
        })
    return {"rooms": rooms, "total": len(rooms)}


@router.get("/ice-servers")
async def get_ice_servers() -> Dict[str, Any]:
    """
    获取 ICE 服务器配置
    
    返回 STUN/TURN 服务器列表，供客户端建立 WebRTC 连接使用。
    
    Returns:
        ICE 服务器配置
    """
    from app.core.config import settings
    
    ice_servers = []
    
    # STUN 服务器
    for url in settings.STUN_SERVERS:
        ice_servers.append({"urls": url})
    
    # TURN 服务器（如果配置）
    for url in settings.TURN_SERVERS:
        ice_servers.append({
            "urls": url,
            # TODO: 添加 TURN 认证信息
        })
    
    return {"iceServers": ice_servers}
