export type StartupStage = 'computer' | 'storage' | 'workspace' | 'browser' | 'ready';

export function startupMessage(stage?: StartupStage) {
  if (stage === 'ready') return 'Getting ready…';
  if (stage === 'storage' || stage === 'workspace' || stage === 'browser')
    return 'Preparing your workspace…';
  return 'Starting your private computer…';
}
