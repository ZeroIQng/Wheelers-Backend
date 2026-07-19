import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class DriverKycStorage {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(params: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string }) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${params.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
      },
    });
    this.bucket = params.bucket;
    this.prefix = params.prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  async upload(params: {
    driverId: string;
    type: string;
    imageBuffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    const ext = params.mimeType === 'image/png' ? 'png' : 'jpg';
    const objectKey = `${this.prefix}/${params.driverId}/${params.type}-${Date.now()}-${randomUUID()}.${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: params.imageBuffer,
        ContentType: params.mimeType,
      }),
    );

    return objectKey;
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  async getImageAsBase64(key: string): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const response = await this.s3.send(command);
      if (!response.Body) return null;

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const mimeType = key.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
