export interface GenerateSeedDataResult {
  version: number
  count: number
  changed: boolean
}

export function generateSeedData(): Promise<GenerateSeedDataResult>
