import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PrivateMessageDocument = PrivateMessage & Document;

@Schema()
export class Reaction {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  emoji: string;

  @Prop({ default: Date.now })
  timestamp: Date;
}

@Schema()
export class PrivateMessage {
  @Prop({ required: true })
  sender: string;

  @Prop({ required: true })
  receiver: string;

  @Prop({ required: true })
  content: string;

  @Prop({ default: false })
  isRead: boolean;

  @Prop({ default: false })
  isDelivered: boolean;

  @Prop({ default: Date.now })
  timestamp: Date;

  @Prop({ default: Date.now })
  deliveredAt: Date;

  @Prop({ default: null })
  readAt: Date;

  @Prop({ default: null })
  fileUrl: string;

  @Prop({ default: null })
  fileName: string;

  @Prop({ default: null })
  fileType: string;

  @Prop({ default: null })
  fileSize: number;

  @Prop({ default: false })
  isVoiceMessage: boolean;

  @Prop({ default: null })
  duration: number; // Duration in seconds for voice messages

  @Prop({ type: [Reaction], default: [] })
  reactions: Reaction[];

  @Prop({ type: [String], default: [] })
  likes: string[];

  @Prop({ type: [String], default: [] })
  dislikes: string[];
}

export const PrivateMessageSchema = SchemaFactory.createForClass(PrivateMessage); 