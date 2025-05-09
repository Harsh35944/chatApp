import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message } from '../schemas/message.schema';
import { PrivateMessage } from '../schemas/private-message.schema';
import { User } from '../schemas/user.schema';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  maxHttpBufferSize: 1e8, // Increase buffer size to 100MB
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private connectedUsers: Map<string, string> = new Map(); // socketId -> username
  private typingUsers: Map<string, Set<string>> = new Map(); // username -> Set of users they're typing to
  private uploadDir = path.join(process.cwd(), 'uploads');
  private tempUploads: Map<string, { chunks: Buffer[], totalChunks: number }> = new Map();

  constructor(
    @InjectModel(Message.name) private messageModel: Model<Message>,
    @InjectModel(PrivateMessage.name) private privateMessageModel: Model<PrivateMessage>,
    @InjectModel(User.name) private userModel: Model<User>,
    private jwtService: JwtService,
  ) {
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  afterInit(server: Server) {
    server.use(async (socket: Socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (!token) {
          throw new UnauthorizedException('Authentication token not found');
        }

        const payload = this.jwtService.verify(token);
        socket.data.user = payload;
        next();
      } catch (error) {
        next(new UnauthorizedException('Invalid token'));
      }
    });
  }

  async handleConnection(client: Socket) {
    const username = client.data.user.username;
    this.connectedUsers.set(client.id, username);
    this.typingUsers.set(username, new Set());
    
    // Update user status to online
    await this.userModel.findOneAndUpdate(
      { username },
      { isOnline: true, lastSeen: new Date() }
    );

    // Broadcast user list update
    this.broadcastUserList();
    console.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    const username = this.connectedUsers.get(client.id);
    if (username) {
      // Update user status to offline
      await this.userModel.findOneAndUpdate(
        { username },
        { isOnline: false, lastSeen: new Date() }
      );
      this.connectedUsers.delete(client.id);
      this.typingUsers.delete(username);
      
      // Broadcast user list update
      this.broadcastUserList();
    }
    console.log(`Client disconnected: ${client.id}`);
  }

  private async broadcastUserList() {
    const users = await this.userModel.find({}, { password: 0 });
    this.server.emit('userList', users);
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(client: Socket, room: string) {
    client.join(room);
    console.log(`Client ${client.id} joined room: ${room}`);
  }

  @SubscribeMessage('leaveRoom')
  async handleLeaveRoom(client: Socket, room: string) {
    client.leave(room);
    console.log(`Client ${client.id} left room: ${room}`);
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(client: Socket, payload: { room: string; content: string }) {
    const message = new this.messageModel({
      sender: client.data.user.username,
      content: payload.content,
      room: payload.room,
    });
    await message.save();

    this.server.to(payload.room).emit('newMessage', message);
  }

  @SubscribeMessage('sendPrivateMessage')
  async handlePrivateMessage(client: Socket, payload: { receiver: string; content: string }) {
    const message = new this.privateMessageModel({
      sender: client.data.user.username,
      receiver: payload.receiver,
      content: payload.content,
      isDelivered: false,
      isRead: false,
    });
    await message.save();

    // Find receiver's socket
    const receiverSocket = Array.from(this.connectedUsers.entries())
      .find(([_, username]) => username === payload.receiver)?.[0];

    if (receiverSocket) {
      this.server.to(receiverSocket).emit('newPrivateMessage', message);
      // Mark as delivered when receiver is online
      message.isDelivered = true;
      message.deliveredAt = new Date();
      await message.save();
      client.emit('messageDelivered', { messageId: message._id });
    }
    client.emit('newPrivateMessage', message);

    // Clear typing indicator after sending message
    this.handleStopTyping(client, { receiver: payload.receiver });
  }

  @SubscribeMessage('markMessageAsRead')
  async handleMarkMessageAsRead(client: Socket, payload: { messageId: string }) {
    const message = await this.privateMessageModel.findById(payload.messageId);
    if (message && message.receiver === client.data.user.username) {
      message.isRead = true;
      message.readAt = new Date();
      await message.save();

      // Notify sender that message was read
      const senderSocket = Array.from(this.connectedUsers.entries())
        .find(([_, username]) => username === message.sender)?.[0];

      if (senderSocket) {
        this.server.to(senderSocket).emit('messageRead', {
          messageId: message._id,
          readAt: message.readAt
        });
      }
    }
  }

  @SubscribeMessage('getPrivateMessages')
  async handleGetPrivateMessages(client: Socket, payload: { otherUser: string }) {
    const messages = await this.privateMessageModel.find({
      $or: [
        { sender: client.data.user.username, receiver: payload.otherUser },
        { sender: payload.otherUser, receiver: client.data.user.username },
      ],
    }).sort({ timestamp: 1 });

    // Mark unread messages as delivered when user opens the chat
    const unreadMessages = messages.filter(
      msg => !msg.isDelivered && msg.receiver === client.data.user.username
    );

    if (unreadMessages.length > 0) {
      await this.privateMessageModel.updateMany(
        { _id: { $in: unreadMessages.map(msg => msg._id) } },
        { 
          $set: { 
            isDelivered: true,
            deliveredAt: new Date()
          }
        }
      );

      // Notify senders that their messages were delivered
      unreadMessages.forEach(async (msg) => {
        const senderSocket = Array.from(this.connectedUsers.entries())
          .find(([_, username]) => username === msg.sender)?.[0];

        if (senderSocket) {
          this.server.to(senderSocket).emit('messageDelivered', {
            messageId: msg._id
          });
        }
      });
    }

    client.emit('privateMessages', messages);
  }

  @SubscribeMessage('searchUsers')
  async handleSearchUsers(client: Socket, query: string) {
    const users = await this.userModel.find({
      username: { $regex: query, $options: 'i' },
    }, { password: 0 });
    client.emit('searchResults', users);
  }

  @SubscribeMessage('typing')
  async handleTyping(client: Socket, payload: { receiver: string }) {
    const sender = client.data.user.username;
    const receiver = payload.receiver;

    // Add to typing set
    if (!this.typingUsers.has(sender)) {
      this.typingUsers.set(sender, new Set());
    }
    const typingSet = this.typingUsers.get(sender);
    if (typingSet) {
      typingSet.add(receiver);
    }

    // Find receiver's socket
    const receiverSocket = Array.from(this.connectedUsers.entries())
      .find(([_, username]) => username === receiver)?.[0];

    if (receiverSocket) {
      this.server.to(receiverSocket).emit('userTyping', { username: sender });
    }
  }

  @SubscribeMessage('stopTyping')
  async handleStopTyping(client: Socket, payload: { receiver: string }) {
    const sender = client.data.user.username;
    const receiver = payload.receiver;

    // Remove from typing set
    const typingSet = this.typingUsers.get(sender);
    if (typingSet) {
      typingSet.delete(receiver);
    }

    // Find receiver's socket
    const receiverSocket = Array.from(this.connectedUsers.entries())
      .find(([_, username]) => username === receiver)?.[0];

    if (receiverSocket) {
      this.server.to(receiverSocket).emit('userStoppedTyping', { username: sender });
    }
  }

  @SubscribeMessage('startFileUpload')
  async handleStartFileUpload(client: Socket, payload: {
    receiver: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    totalChunks: number;
  }) {
    try {
      const uploadId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      this.tempUploads.set(uploadId, {
        chunks: [],
        totalChunks: payload.totalChunks
      });

      client.emit('uploadStarted', { uploadId });
    } catch (error) {
      console.error('Start upload error:', error);
      client.emit('uploadError', { message: 'Failed to start upload' });
    }
  }

  @SubscribeMessage('uploadChunk')
  async handleUploadChunk(client: Socket, payload: {
    uploadId: string;
    chunk: string;
    chunkIndex: number;
    receiver: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  }) {
    try {
      const upload = this.tempUploads.get(payload.uploadId);
      if (!upload) {
        throw new Error('Upload session not found');
      }

      // Convert base64 chunk to buffer
      const chunkData = Buffer.from(payload.chunk.split(',')[1], 'base64');
      upload.chunks[payload.chunkIndex] = chunkData;

      // Check if all chunks are received
      if (upload.chunks.filter(Boolean).length === upload.totalChunks) {
        // Combine chunks and save file
        const fileData = Buffer.concat(upload.chunks);
        const safeFileName = `${Date.now()}-${payload.fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const filePath = path.join(this.uploadDir, safeFileName);
        
        await fs.promises.writeFile(filePath, fileData);

        // Create message with file info
        const message = new this.privateMessageModel({
          sender: client.data.user.username,
          receiver: payload.receiver,
          content: `Shared a file: ${payload.fileName}`,
          fileUrl: `/uploads/${safeFileName}`,
          fileName: payload.fileName,
          fileType: payload.fileType,
          fileSize: payload.fileSize,
        });
        await message.save();

        // Notify receiver
        const receiverSocket = Array.from(this.connectedUsers.entries())
          .find(([_, username]) => username === payload.receiver)?.[0];

        if (receiverSocket) {
          this.server.to(receiverSocket).emit('newPrivateMessage', message);
          message.isDelivered = true;
          message.deliveredAt = new Date();
          await message.save();
          client.emit('messageDelivered', { messageId: message._id });
        }
        client.emit('newPrivateMessage', message);

        // Clean up
        this.tempUploads.delete(payload.uploadId);
      }

      // Acknowledge chunk received
      client.emit('chunkReceived', { 
        uploadId: payload.uploadId,
        chunkIndex: payload.chunkIndex
      });
    } catch (error) {
      console.error('Chunk upload error:', error);
      client.emit('uploadError', { 
        message: 'Failed to upload chunk',
        uploadId: payload.uploadId
      });
    }
  }

  @SubscribeMessage('cancelUpload')
  async handleCancelUpload(client: Socket, payload: { uploadId: string }) {
    this.tempUploads.delete(payload.uploadId);
    client.emit('uploadCancelled', { uploadId: payload.uploadId });
  }
} 