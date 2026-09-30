export function stlByteLength(triangleCount: number): number {
  return 84 + triangleCount * 50;
}

/** Binary STL: 80-byte header, uint32 count, then 50 bytes per triangle. */
export function writeBinaryStl(
  positions: Float32Array,
  indices: Uint32Array,
  header = 'mountain-maker',
): ArrayBuffer {
  const count = indices.length / 3;
  const buf = new ArrayBuffer(stlByteLength(count));
  const view = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, count, true);

  let o = 84;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, positions[v], true);
      view.setFloat32(o + 4, positions[v + 1], true);
      view.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    o += 2; // attribute byte count, unused
  }
  return buf;
}
