sealed class NodException implements Exception {
  const NodException(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

final class NodOriginException extends NodException {
  const NodOriginException()
    : super('Use an HTTPS Nod address or a loopback development address.');
}

final class NodCredentialStorageException extends NodException {
  const NodCredentialStorageException()
    : super('Secure connection storage is unavailable.');
}

final class NodUnauthorizedException extends NodException {
  const NodUnauthorizedException()
    : super('The Nod connection token was rejected.');
}

final class NodForbiddenException extends NodException {
  const NodForbiddenException()
    : super('This client is not permitted to connect to that Nod server.');
}

enum NodConflictKind { conversationReset, duplicateClientMessage, unknown }

final class NodConflictException extends NodException {
  const NodConflictException(this.kind)
    : super(
        kind == NodConflictKind.conversationReset
            ? 'The conversation changed. Reload it before continuing.'
            : kind == NodConflictKind.duplicateClientMessage
            ? 'That client message ID is already in use.'
            : 'The request conflicts with the current conversation state.',
      );

  final NodConflictKind kind;
}

final class NodTimeoutException extends NodException {
  const NodTimeoutException()
    : super('The Nod server took too long to respond.');
}

final class NodOfflineException extends NodException {
  const NodOfflineException()
    : super('The Nod server is offline or unreachable.');
}

final class NodUnavailableException extends NodException {
  const NodUnavailableException()
    : super('The Nod server is temporarily unavailable.');
}

final class NodProtocolException extends NodException {
  const NodProtocolException()
    : super('The Nod server returned an unsupported response.');
}

final class NodAppSetupException extends NodException {
  const NodAppSetupException()
    : super('This app needs additional setup in the Nod web app.');
}

enum NodAudioFailure {
  setup,
  modelSetup,
  noSpeech,
  transcription,
  tooLarge,
  unsupportedServer,
  uncertain,
  send,
}

final class NodAudioException extends NodException {
  const NodAudioException(this.kind, {this.retryable = false})
    : super('Could not send voice message.');

  final bool retryable;

  @override
  String get message => switch (kind) {
    NodAudioFailure.setup => 'Voice messages need speech recognition on your Nod server. Set it up in Nod web → Settings → General → Voice, then send this recording again.',
    NodAudioFailure.modelSetup => 'Connect an AI provider in Nod web → Settings → Models before sending a voice message.',
    NodAudioFailure.noSpeech =>
      'No speech was detected. Check your microphone and record again.',
    NodAudioFailure.transcription => 'The recording could not be transcribed. Your recording is kept; try again or send a text message.',
    NodAudioFailure.tooLarge => 'This voice message is too large or too long. Record a shorter message (up to 25 MB).',
    NodAudioFailure.unsupportedServer => 'This Nod server does not support voice messages. Update the server before sending audio.',
    NodAudioFailure.uncertain => 'This recording may already have been received. Check the conversation before recording or sending another message.',
    NodAudioFailure.send => 'Could not send the voice message. Your recording is kept. Check the connection and voice setup on your Nod server.',
  };
  final NodAudioFailure kind;
}

final class NodRequestException extends NodException {
  const NodRequestException()
    : super('The Nod request could not be completed.');
}
