import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const report = (event: string, data: Record<string, unknown> = {}): void => {
  process.stderr.write(`FALLBACK_FIXTURE ${JSON.stringify({ event, ...data })}\n`);
};
const facts = (model: { id?: string; provider?: string; baseUrl?: string } | undefined) =>
  model ? { id: model.id, provider: model.provider, baseUrl: model.baseUrl } : undefined;

// Only provider registration and observation are fixtures. OMP owns the
// provider transport, fallback chain, model changes and RPC lifecycle.
export default function fallbackHost(pi: ExtensionAPI): void {
  const providers: Array<{ name: string; model: string; baseUrl: string }> =
    JSON.parse(process.env.WAKEGUARD_FALLBACK_PROVIDERS!);
  for (const provider of providers) {
    pi.registerProvider(provider.name, {
      baseUrl: provider.baseUrl,
      apiKey: "fixture-not-a-secret",
      api: "openai-completions",
      models: [{
        id: provider.model,
        name: provider.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 128,
      }],
    });
  }
  pi.on("session_start", (_event, ctx) => {
    report("ready", { model: facts(ctx.model) });
  });
  pi.on("retry_fallback_applied", (event, ctx) => {
    report("fallback_applied", { from: event.from, to: event.to, model: facts(ctx.model) });
  });
  pi.on("retry_fallback_succeeded", (event, ctx) => {
    report("fallback_succeeded", { model: event.model, currentModel: facts(ctx.model) });
  });
}
