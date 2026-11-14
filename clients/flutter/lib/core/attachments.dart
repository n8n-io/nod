import 'dart:io';

const nodAttachmentLimit = 90 * 1024 * 1024;

class NodArtifact {
  const NodArtifact({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.size,
  });

  final String id;
  final String name;
  final String mimeType;
  final int size;
}

class NodUploadFile {
  const NodUploadFile({
    this.path = '',
    this.read,
    required this.name,
    required this.size,
    required this.mimeType,
  });

  final String path;
  final Stream<List<int>> Function()? read;
  final String name;
  final int size;
  final String mimeType;
}

abstract interface class NodAttachmentsRepository {
  bool get attachmentsSupported;
  Future<NodArtifact> uploadAttachment(
    NodUploadFile file, {
    required Future<void> cancelled,
    required void Function(double) onProgress,
  });
  Future<List<NodArtifact>> renewAttachments(List<String> ids);
  Future<void> sendAttachments(
    String text,
    List<NodArtifact> attachments, {
    required String clientMessageId,
  });
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File destination, {
    required Future<void> cancelled,
  });
}
