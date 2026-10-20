export interface PublicLinkMetadata {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  player?: string;
}

export interface PreviewImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface SiteIcon {
  bytes: Uint8Array;
  mimeType: PreviewImage['mimeType'] | 'image/x-icon';
}

export interface LinkPreviewProvider {
  metadata(url: string): Promise<PublicLinkMetadata | null>;
  image(url: string): Promise<PreviewImage | null>;
  icon?(origin: string): Promise<SiteIcon | null>;
}
