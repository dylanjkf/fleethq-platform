import { ConfigService } from '@nestjs/config';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { SesNotificationChannel } from './ses-notification-channel';

/**
 * Unit-tests the SES channel against a mocked SES client — no network, no real
 * AWS account. Verifies the command is built with the configured From address
 * and the message's recipient/subject/body, and that SMS is a logged no-op.
 */
describe('SesNotificationChannel', () => {
  const send = jest.fn().mockResolvedValue({});

  function makeChannel(overrides: Record<string, string | undefined> = {}) {
    const values: Record<string, string | undefined> = {
      AWS_REGION: 'ap-southeast-2',
      EMAIL_FROM_ADDRESS: 'noreply@fleetos.example',
      ...overrides,
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService;
    const channel = new SesNotificationChannel(config);
    // Replace the real SES client with a spy — SESClient.send is the only method used.
    (channel as unknown as { client: { send: typeof send } }).client = { send };
    return channel;
  }

  beforeEach(() => send.mockClear());

  it('sends an email as a SendEmailCommand from the configured address to the recipient', async () => {
    const channel = makeChannel();
    await channel.sendEmail({ to: 'ops@acme.example', subject: 'Digest', body: 'You have 3 unread notifications.' });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.Source).toBe('noreply@fleetos.example');
    expect(command.input.Destination?.ToAddresses).toEqual(['ops@acme.example']);
    expect(command.input.Message?.Subject?.Data).toBe('Digest');
    expect(command.input.Message?.Body?.Text?.Data).toBe('You have 3 unread notifications.');
  });

  it('propagates a send failure to the caller rather than swallowing it', async () => {
    const channel = makeChannel();
    send.mockRejectedValueOnce(new Error('SES throttled'));
    await expect(
      channel.sendEmail({ to: 'ops@acme.example', subject: 'x', body: 'y' }),
    ).rejects.toThrow('SES throttled');
  });

  it('does not attempt to send SMS (email-only channel)', async () => {
    const channel = makeChannel();
    await channel.sendSms({ to: '+61400000000', body: 'test' });
    expect(send).not.toHaveBeenCalled();
  });
});
