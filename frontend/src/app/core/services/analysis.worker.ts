/// <reference lib="webworker" />
import { computeAnalysis, AnalysisInput } from '../analysis';

addEventListener('message', ({ data }: MessageEvent<{ id: number; input: AnalysisInput }>) => {
  const { id, input } = data;
  try {
    const result = computeAnalysis(input);
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
