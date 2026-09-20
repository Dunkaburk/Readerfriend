/**
 * OpenRouter TTS integration (SPEC §5, §13 trap 3/6/7/8).
 *
 * The key never leaves the Worker: the client asks /api/tts/models for the
 * live model list and POSTs to the audio endpoint here. The speech endpoint
 * returns raw audio bytes, not JSON. Free model slugs rotate without notice,
 * so nothing is hardcoded and failures surface with clear messages.
 */

import type { TtsModel } from '@readerfriend/shared';
import type { Env } from './env';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Retry-After seconds to pass through on upstream rate limits. */
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    voices?: unknown;
  };
  voices?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** A model can speak when its output modalities include audio/speech. */
function isTtsModel(m: OpenRouterModel): boolean {
  const out = m.architecture?.output_modalities;
  if (Array.isArray(out) && (out.includes('audio') || out.includes('speech'))) return true;
  // Older shape: architecture.modality = "text->audio".
  return /->\s*audio/i.test(m.architecture?.modality ?? '');
}

/** Call OpenRouter's models API and reduce it to the TTS-capable subset. */
export async function fetchTtsModels(apiKey: string): Promise<TtsModel[]> {
  let res: Response;
  try {
    res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new TtsError('Could not reach OpenRouter to list models.', 502);
  }
  if (res.status === 401) {
    throw new TtsError('OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.', 502);
  }
  if (!res.ok) {
    throw new TtsError(`OpenRouter models request failed (${res.status}).`, 502);
  }
  let body: { data?: OpenRouterModel[] };
  try {
    body = (await res.json()) as { data?: OpenRouterModel[] };
  } catch {
    throw new TtsError('OpenRouter models response was not JSON.', 502);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((m): m is OpenRouterModel => typeof m?.id === 'string')
    .filter(isTtsModel)
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      free: m.id.endsWith(':free'),
      voices: asStringArray(m.voices ?? m.architecture?.voices),
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    }))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
}

// The list changes only when free models rotate; cache briefly per isolate.
let modelsCache: { at: number; models: TtsModel[] } | null = null;
const MODELS_CACHE_MS = 10 * 60 * 1000;

export async function fetchTtsModelsCached(apiKey: string): Promise<TtsModel[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.models;
  const models = await fetchTtsModels(apiKey);
  modelsCache = { at: Date.now(), models };
  return models;
}

export interface SpeechRequest {
  model: string;
  /** Optional — some providers accept a default voice when it is omitted. */
  voice?: string | null;
  input: string;
  responseFormat?: string;
}

/**
 * Request speech for a chunk. Returns the raw upstream Response — the caller
 * tees its body to R2 and the client (SPEC §13 trap 4: never buffer audio).
 */
export async function requestSpeech(apiKey: string, req: SpeechRequest): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        input: req.input,
        // Omit an unset voice — upstream models that have no default voice
        // would reject `null`, and models with one treat omission as default.
        ...(req.voice ? { voice: req.voice } : {}),
        response_format: req.responseFormat ?? 'mp3',
      }),
      // A speech render can legitimately take a while — measured ~60s for a
      // 2,000-char chunk on fish-audio free models, streaming the whole time
      // (TTFB is instant) — but an upstream hang must end somewhere; the
      // client queue retries on our failure.
      signal: AbortSignal.timeout(110_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new TtsError('OpenRouter took too long to generate speech.', 504);
    }
    throw new TtsError('Could not reach OpenRouter for speech generation.', 502);
  }
  if (res.ok) return res;

  let detail = '';
  try {
    const text = await res.text();
    // Never echo the key; trim to keep the message bounded.
    detail = text.replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    /* body unreadable — fall through with empty detail */
  }
  if (res.status === 429) {
    throw new TtsError(
      detail || 'OpenRouter rate-limited the request (429).',
      429,
      res.headers.get('Retry-After'),
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new TtsError('OpenRouter rejected the server API key.', 502);
  }
  if (res.status === 404) {
    // Free models rotate out without notice (SPEC §13 trap 6).
    throw new TtsError(
      `TTS model "${req.model}" is not available (404). Pick another model in Settings — free models rotate out from time to time.`,
      502,
    );
  }
  throw new TtsError(detail || `Speech generation failed (${res.status}).`, 502);
}
