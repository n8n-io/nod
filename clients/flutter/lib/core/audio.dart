import 'attachments.dart';

abstract interface class NodAudioRepository {
  Future<void> sendAudio(
    String text,
    NodUploadFile recording, {
    required String clientMessageId,
    List<NodArtifact> attachments = const [],
  });
}
