// Faithful port of Python's built-in round() — round-half-to-even (banker's
// rounding), NOT JS Math.round (which rounds half up). Used only where a rounded
// value is API-visible and could differ on an exact .5 (percentile indexes in
// browse.ts, rate values in rates.ts). Keep the port using this, not Math.round,
// anywhere Python used round().
export function pyround(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

// Python round(x, 2): round to 2 decimals, half to even.
export function pyround2(x: number): number {
  return pyround(x * 100) / 100
}
