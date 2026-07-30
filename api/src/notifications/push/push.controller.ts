import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../../common/decorators/authenticated-only.decorator';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { PushService } from './push.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';

/** Personal, like the rest of Notifications — every user manages their own device registrations. */
@Controller({ path: 'push', version: '1' })
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key')
  @AuthenticatedOnly()
  getPublicKey() {
    return { publicKey: this.push.getPublicKey() };
  }

  @Post('subscribe')
  @AuthenticatedOnly()
  subscribe(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: SubscribePushDto) {
    return this.push.subscribe(user.userId, dto);
  }

  @Post('unsubscribe')
  @AuthenticatedOnly()
  unsubscribe(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UnsubscribePushDto) {
    return this.push.unsubscribe(user.userId, dto.endpoint);
  }
}
