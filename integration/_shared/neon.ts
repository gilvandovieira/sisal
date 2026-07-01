/** Configures `@neon/serverless` for local wsproxy integration runs. */
export async function configureNeonWebSocketProxy(
  wsProxy: string | undefined,
): Promise<void> {
  if (wsProxy === undefined) return;
  const mod = await import("@neon/serverless");
  const neonConfig = mod.neonConfig as unknown as Record<string, unknown>;
  neonConfig.wsProxy = () => `${wsProxy}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}
