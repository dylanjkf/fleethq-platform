import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { BROADCAST_THROTTLE } from '../common/throttles';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { ListMessagesDto } from './dto/list-messages.dto';

@Controller({ path: 'messages', version: '1' })
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.MESSAGES_VIEW)
  list(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListMessagesDto) {
    return this.messages.list(user.companyId, user.userId, query.operatorId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.MESSAGES_SEND)
  send(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: SendMessageDto) {
    return this.messages.send(user.companyId, user.userId, dto);
  }

  // Fans out to every operator in the company — tighter limit than an ordinary
  // send so one account can't spam the whole fleet.
  @Post('broadcast')
  @Throttle(BROADCAST_THROTTLE)
  @RequirePermission(PERMISSIONS.MESSAGES_BROADCAST)
  broadcast(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: BroadcastMessageDto) {
    return this.messages.broadcast(user.companyId, user.userId, dto);
  }
}
