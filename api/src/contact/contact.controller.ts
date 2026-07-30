import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { ContactService } from './contact.service';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';

@Controller({ path: 'contact', version: '1' })
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /** Public — reached from the sign-in page by prospects with no account yet. */
  @Public()
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 5, ttl: 60_000 } })
  @Post()
  submit(@Body() dto: CreateContactMessageDto) {
    return this.contactService.submit(dto);
  }
}
