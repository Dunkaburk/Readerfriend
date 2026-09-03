/**
 * Subscribe a component to the generation queue's status (§9.2 progress).
 */

import { useEffect, useState } from 'react';
import { generationQueue, type GenerationStatus } from './generationQueue';

export function useGenerationStatus(): GenerationStatus {
  const [status, setStatus] = useState<GenerationStatus>(() => generationQueue.status());
  useEffect(() => generationQueue.subscribe(setStatus), []);
  return status;
}
