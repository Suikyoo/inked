function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Unit-normalises, then scales to int8 (×127, rounded, clamped). */
export function quantize(v: Float32Array): Int8Array {
  const u = normalize(v);
  const out = new Int8Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(u[i] * 127)));
  return out;
}

export function dequantize(q: Int8Array): Float32Array {
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] / 127;
  return normalize(v);
}

export { normalize };
