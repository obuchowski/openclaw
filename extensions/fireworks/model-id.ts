export function isFireworksKimiModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return /^kimi-k2(?:p[56]|[.-][56])(?:[-_].+)?$/.test(lastSegment);
}

function lastModelIdSegment(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return normalized.split("/").pop() ?? normalized;
}

export function isFireworksDeepSeekV4ModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  return /^deepseek[-_.]?v4(?:[-_.]|$)/.test(lastSegment);
}

export function isFireworksMinimaxM2ModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  return /^minimax[-_.]?m2(?:[-_.]|$)/.test(lastSegment);
}

export function isFireworksGlmReasoningModelId(modelId: string): boolean {
  const lastSegment = lastModelIdSegment(modelId);
  return /^glm[-_.]?(?:5|[4-9]\d?)(?:[-_.]|$)/.test(lastSegment);
}

export function isFireworksGptOss120bModelId(modelId: string): boolean {
  return lastModelIdSegment(modelId) === "gpt-oss-120b";
}
