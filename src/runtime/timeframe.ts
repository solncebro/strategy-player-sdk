const DURATION_MS_BY_RESOLUTION: Record<string, number> = {
  "1": 60_000,
  "15": 900_000,
  "30": 1_800_000,
  "60": 3_600_000,
  "240": 14_400_000,
  "1D": 86_400_000,
};

export function barDurationMs(resolution: string): number {
  const value = DURATION_MS_BY_RESOLUTION[resolution];

  if (value === undefined) {
    throw new Error(`Unsupported resolution: ${resolution}`);
  }

  return value;
}
