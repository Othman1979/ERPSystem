const WEBHOOK_TIMEOUT_MS = 10_000;

export async function postAlertWebhook(url: string, text: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Alert webhook unreachable: ${error instanceof Error ? error.name : 'error'}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Alert webhook answered ${response.status}`);
}
