const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

export interface DownloadedMetaMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Two-step Meta media fetch: the webhook only carries a media id, and the
 * bytes live behind a short-lived URL that itself requires the access token.
 */
export async function downloadMetaMedia(
  accessToken: string,
  mediaId: string,
): Promise<DownloadedMetaMedia> {
  const metaRes = await fetch(`${META_GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    throw new Error(`Meta media lookup failed with status ${metaRes.status}`);
  }

  const meta = (await metaRes.json()) as {
    url?: string;
    mime_type?: string;
    file_size?: number;
  };
  if (!meta.url) {
    throw new Error('Meta media lookup returned no download URL');
  }

  const mimeType = (meta.mime_type ?? '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported media type: ${meta.mime_type ?? 'unknown'}`);
  }
  if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) {
    throw new Error('Media file is too large');
  }

  const fileRes = await fetch(meta.url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Meta media download failed with status ${fileRes.status}`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Media file is too large');
  }

  return { buffer: Buffer.from(arrayBuffer), mimeType };
}
