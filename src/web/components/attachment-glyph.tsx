import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  Workflow,
} from './icons';
import { attachmentKind } from '../lib/attachment-kind';

export function FileGlyph({
  name,
  mimeType,
  size = 16,
  className,
}: {
  name: string;
  mimeType: string;
  size?: number;
  className?: string;
}) {
  const kind = attachmentKind(mimeType, name);
  const Icon =
    kind === 'image'
      ? FileImage
      : kind === 'audio'
        ? FileAudio
        : kind === 'video'
          ? FileVideo
          : kind === 'archive'
            ? FileArchive
            : kind === 'csv' || kind === 'spreadsheet'
              ? FileSpreadsheet
              : kind === 'presentation'
                ? Presentation
                : kind === 'n8n-workflow'
                  ? Workflow
                  : kind === 'html' || (kind === 'text' && /\.(?!txt$|log$)[a-z0-9]+$/i.test(name))
                    ? FileCode
                    : kind
                      ? FileText
                      : File;
  return <Icon className={className} size={size} aria-hidden="true" />;
}
