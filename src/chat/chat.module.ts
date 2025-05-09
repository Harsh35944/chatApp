import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatGateway } from './chat.gateway';
import { Message, MessageSchema } from '../schemas/message.schema';
import { PrivateMessage, PrivateMessageSchema } from '../schemas/private-message.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: PrivateMessage.name, schema: PrivateMessageSchema },
      { name: User.name, schema: UserSchema },
    ]),
    JwtModule.register({
      secret: 'your-secret-key', // In production, use environment variable
      signOptions: { expiresIn: '1d' },
    }),
  ],
  providers: [ChatGateway],
})
export class ChatModule {} 