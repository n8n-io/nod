export interface SiteIcon {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon';
}

export interface PreviewImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface LinkPreviewProvider {
  icon(origin: string): Promise<SiteIcon | null>;
  image?(url: string, signal?: AbortSignal): Promise<PreviewImage | null>;
  mapTile?(zoom: number, x: number, y: number, signal?: AbortSignal): Promise<PreviewImage | null>;
}
