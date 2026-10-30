import { createContext, useContext } from 'react';
import type { AttachmentTrigger, ImagePreview } from './attachment-images';

interface ArtifactDrawerControls {
  selectedId: string | null;
  open(id: string, trigger?: AttachmentTrigger, source?: 'drafts'): void;
  setDrafts(items: ImagePreview[]): void;
}

export const ArtifactDrawerContext = createContext<ArtifactDrawerControls>({
  selectedId: null,
  open: () => {},
  setDrafts: () => {},
});

export const useArtifactDrawer = () => useContext(ArtifactDrawerContext);
