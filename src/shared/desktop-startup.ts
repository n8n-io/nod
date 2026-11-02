export type StartupStage = 'computer' | 'storage' | 'workspace' | 'browser' | 'ready';

export function startupMessage(stage?: StartupStage) {
  if (stage === 'ready') return 'Getting ready…';
  if (stage === 'storage') return 'Preparing your database…';
  if (stage === 'workspace') return 'Preparing your workspace…';
  if (stage === 'browser') return 'Preparing your browser…';
  return 'Starting your private computer…';
}
