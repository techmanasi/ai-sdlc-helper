import type { HarnessModel } from '../types.js';

/**
 * Queries the OpenAI `/v1/models` endpoint directly using an API key
 * or bearer access token if present in the environment.
 */
export async function queryOpenAiApiModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<HarnessModel[] | null> {
  const token =
    env.OPENAI_API_KEY ||
    env.OPENAI_ACCESS_TOKEN ||
    env.ACCESS_TOKEN;

  if (!token) {
    return null;
  }

  const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetchFn(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return null;
    }

    const body = (await res.json()) as { data?: Array<{ id: string }> };
    if (!Array.isArray(body?.data)) {
      return null;
    }

    // Filter down to coding-relevant models (gpt, o1, o3, etc.)
    const supportedIds = body.data
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o1|o3|o4|chatgpt-)/i.test(id))
      .filter((id) => !/(realtime|audio|transcription|tts|embedding|moderation|dall-e)/i.test(id));

    if (supportedIds.length === 0) {
      return null;
    }

    return supportedIds.map((id) => ({
      id,
      name: `OpenAI ${id}`,
      harness: 'codex',
      supportsEffort: /^o[134]/i.test(id),
      defaultEffort: /^o[134]/i.test(id) ? 'medium' : undefined,
    }));
  } catch {
    return null;
  }
}
