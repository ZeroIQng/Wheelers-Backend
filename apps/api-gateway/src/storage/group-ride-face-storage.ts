import { randomUUID } from 'node:crypto';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type GroupRideFaceUploadDescriptor = {
  bucket: string;
  objectKey: string;
  uploadUrl: string;
  expiresInSeconds: number;
  mimeType: string;
};

export type StoredGroupRideFaceObject = {
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes?: number;
  etag?: string;
  capturedAt?: Date;
};

export class GroupRideFaceStorage {
  private readonly s3: S3Client;

  constructor(params: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    prefix: string;
    uploadUrlTtlSeconds: number;
  }) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${params.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
      },
    });
    this.bucket = params.bucket;
    this.prefix = normalizePrefix(params.prefix);
    this.uploadUrlTtlSeconds = params.uploadUrlTtlSeconds;
  }

  private readonly bucket: string;
  private readonly prefix: string;
  private readonly uploadUrlTtlSeconds: number;

  async createUploadUrl(params: {
    matchRequestId: string;
    userId: string;
    mimeType: string;
  }): Promise<GroupRideFaceUploadDescriptor> {
    const objectKey = this.buildObjectKey(params.matchRequestId, params.userId, params.mimeType);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: params.mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, {
      expiresIn: this.uploadUrlTtlSeconds,
    });

    return {
      bucket: this.bucket,
      objectKey,
      uploadUrl,
      expiresInSeconds: this.uploadUrlTtlSeconds,
      mimeType: params.mimeType,
    };
  }

  async verifyUploadedObject(params: {
    bucket: string;
    objectKey: string;
  }): Promise<StoredGroupRideFaceObject> {
    const result = await this.s3.send(
      new HeadObjectCommand({
        Bucket: params.bucket,
        Key: params.objectKey,
      }),
    );

    return {
      bucket: params.bucket,
      objectKey: params.objectKey,
      mimeType: result.ContentType ?? 'application/octet-stream',
      sizeBytes: typeof result.ContentLength === 'number' ? result.ContentLength : undefined,
      etag: result.ETag?.replaceAll('"', ''),
      capturedAt: result.LastModified,
    };
  }

  private buildObjectKey(matchRequestId: string, userId: string, mimeType: string): string {
    const ext = inferExtension(mimeType);
    return `${this.prefix}/${matchRequestId}/${userId}/${Date.now()}-${randomUUID()}.${ext}`;
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function inferExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
    case 'image/heif':
      return 'heic';
    case 'image/jpeg':
    case 'image/jpg':
    default:
      return 'jpg';
  }
}
