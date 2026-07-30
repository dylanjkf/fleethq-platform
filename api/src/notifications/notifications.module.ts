import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATION_CHANNEL } from './channels/notification-channel';
import { LoggingNotificationChannel } from './channels/logging-notification-channel';
import { SesNotificationChannel } from './channels/ses-notification-channel';
import { PushService } from './push/push.service';
import { PushController } from './push/push.controller';
import { NotificationPresetsController } from './notification-presets/notification-presets.controller';
import { NotificationPresetsService } from './notification-presets/notification-presets.service';

@Module({
  controllers: [NotificationsController, PushController, NotificationPresetsController],
  providers: [
    NotificationsService,
    NotificationPresetsService,
    PushService,
    // The single swap point the NotificationChannel abstraction was built for:
    // use the real SES channel only when it's actually configured
    // (`EMAIL_PROVIDER=ses` + a verified `EMAIL_FROM_ADDRESS`), otherwise the
    // logging channel — so local dev / CI / an un-provisioned deploy all keep
    // working with zero email config and nothing else in the module changes.
    {
      provide: NOTIFICATION_CHANNEL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('EMAIL_PROVIDER');
        const from = config.get<string>('EMAIL_FROM_ADDRESS');
        if (provider === 'ses' && from) {
          return new SesNotificationChannel(config);
        }
        return new LoggingNotificationChannel();
      },
    },
  ],
  exports: [NotificationsService, NOTIFICATION_CHANNEL],
})
export class NotificationsModule {}
