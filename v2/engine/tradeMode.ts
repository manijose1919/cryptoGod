import type { V2Mode } from '../pipeline/types.ts';

export function resolveV2Mode(
  requestedMode: string | undefined,
  liveConfirmation: string | undefined,
): V2Mode {
  if (requestedMode === 'live') {
    return liveConfirmation === 'yes' ? 'live' : 'paper';
  }
  if (requestedMode === 'paper' || requestedMode === 'shadow') {
    return requestedMode;
  }
  return 'shadow';
}
