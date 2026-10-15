/**
 * Synthetic CPU/memory pairs for the demo.
 * Valid pairs follow the bounded Fargate-style table in catalog/config-change.md.
 * A valid pair above the preferred maximum is a SIZE-01 concern for the assessor.
 * It is not an invalid configuration.
 */

const PREFERRED_MAX_CPU = 1024;
const PREFERRED_MAX_MEMORY = 2048;

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

const MEMORY_BY_CPU: Readonly<Record<number, readonly number[]>> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 3072, 4096],
  1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  2048: range(4096, 16384, 1024),
  4096: range(8192, 30720, 1024),
};

export function isValidCpuMemory(cpu: number, memory: number): boolean {
  const allowed = MEMORY_BY_CPU[cpu];
  return allowed !== undefined && allowed.includes(memory);
}

export function exceedsPreferredSize(cpu: number, memory: number): boolean {
  return cpu > PREFERRED_MAX_CPU || memory > PREFERRED_MAX_MEMORY;
}

export function cpuMemoryError(cpu: number, memory: number): string | undefined {
  if (!Number.isInteger(cpu) || !Number.isInteger(memory)) {
    return "cpu and memory must be integers";
  }
  if (!isValidCpuMemory(cpu, memory)) {
    return `invalid CPU/memory combination: cpu ${cpu}, memory ${memory}`;
  }
  return undefined;
}
