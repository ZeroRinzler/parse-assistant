/**
 * Public surface of the pure analysis core.
 *
 * The Web Worker and the Angular shell import `computeAnalysis` / `AnalysisInput`
 * from here. The focused modules (bench-stats, rule-engine, cooldown-analysis,
 * ...) are imported directly by their specs.
 */
export { computeAnalysis, type AnalysisInput } from './compute-analysis';
