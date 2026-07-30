import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { decodeIntegrationCredentialKey } from '../config/env.validation';

const ALGORITHM = 'aes-256-gcm';
/** 12 bytes is the NIST-recommended (and Node default) IV length for GCM. */
const IV_BYTES = 12;

export interface EncryptedPayload {
  encryptedPayload: string;
  iv: string;
  tag: string;
}

/**
 * The Integration Hub's credential vault crypto (10-Integrations/
 * Integration_Hub.md). AES-256-GCM, keyed off `INTEGRATION_CREDENTIAL_KEY`
 * (base64 or hex, validated at boot — see env.validation.ts so a
 * missing/malformed key fails the process before it ever serves traffic, not
 * on the first credential a user tries to save). A fresh random IV is
 * generated per `encrypt` call and stored alongside the ciphertext — GCM's
 * authentication tag means any tampering with the stored payload/iv/tag is
 * detected on decrypt (throws) rather than silently returning garbage.
 */
@Injectable()
export class IntegrationCryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('INTEGRATION_CREDENTIAL_KEY') ?? '';
    const key = decodeIntegrationCredentialKey(raw);
    // Defence in depth only: validateEnv already fails the boot on a real
    // app before this constructor runs. This guards any test/tool that
    // constructs the service directly, bypassing ConfigModule's validate step.
    if (!key) {
      throw new Error(
        'INTEGRATION_CREDENTIAL_KEY is missing or malformed — must be a 32-byte key, base64 or hex. See .env.example.',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      encryptedPayload: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedPayload, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
