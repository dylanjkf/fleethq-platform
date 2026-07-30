import { Prisma } from '@prisma/client';
import { AttachmentsService } from './attachments.service';
import { AttachmentStorage } from './attachment-storage';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit-tests the storage-backend branch in AttachmentsService: with S3
 * configured, the bytes go to S3 and the row stores only the object key
 * (data null); with S3 unconfigured, bytes are stored inline. The e2e suites
 * already cover the inline path end-to-end against a real DB — this proves the
 * S3 routing without needing a real bucket.
 */
describe('AttachmentsService storage backend', () => {
  const oneByOnePngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function makeTx() {
    const create = jest.fn().mockImplementation(async ({ data }) => ({
      id: 'att-1',
      filename: data.filename,
      contentType: data.contentType,
      byteSize: data.byteSize,
      createdAt: new Date(),
      // echo the storage fields back so the test can assert what was persisted
      _persisted: { data: data.data, storageKey: data.storageKey },
    }));
    return { create, tx: { attachment: { create } } };
  }

  it('routes bytes to S3 and stores only the object key when S3 is configured', async () => {
    const put = jest.fn().mockResolvedValue('company-1/obj-key');
    const storage = { isConfigured: () => true, put, get: jest.fn() } as unknown as AttachmentStorage;
    const service = new AttachmentsService({} as PrismaService, storage);
    const { create, tx } = makeTx();

    await service.createInTx(tx as unknown as Prisma.TransactionClient, 'company-1', 'user-1', {
      filename: 'pod.png',
      contentType: 'image/png',
      dataBase64: oneByOnePngBase64,
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe('company-1');
    const persisted = create.mock.calls[0][0].data;
    expect(persisted.storageKey).toBe('company-1/obj-key');
    expect(persisted.data).toBeNull();
  });

  it('stores bytes inline and no object key when S3 is not configured', async () => {
    const put = jest.fn();
    const storage = { isConfigured: () => false, put, get: jest.fn() } as unknown as AttachmentStorage;
    const service = new AttachmentsService({} as PrismaService, storage);
    const { create, tx } = makeTx();

    await service.createInTx(tx as unknown as Prisma.TransactionClient, 'company-1', 'user-1', {
      filename: 'pod.png',
      contentType: 'image/png',
      dataBase64: oneByOnePngBase64,
    });

    expect(put).not.toHaveBeenCalled();
    const persisted = create.mock.calls[0][0].data;
    expect(persisted.storageKey).toBeNull();
    expect(Buffer.isBuffer(persisted.data)).toBe(true);
  });
});
