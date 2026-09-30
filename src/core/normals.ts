/**
 * Un-index a mesh and give it "creased" normals: smooth across gentle curvature (the
 * terrain), sharp across edges steeper than `creaseDeg` (plinth corners, text, the
 * terrain's rim). Used for the preview only; the STL carries no normals worth keeping.
 */
export function creasedGeometry(positions: Float32Array, indices: Uint32Array, creaseDeg = 40) {
  const T = indices.length / 3;
  const V = positions.length / 3;
  const face = new Float32Array(T * 3); // area-weighted face normals
  const unit = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    face[t * 3] = nx; face[t * 3 + 1] = ny; face[t * 3 + 2] = nz;
    unit[t * 3] = nx / len; unit[t * 3 + 1] = ny / len; unit[t * 3 + 2] = nz / len;
  }

  // Vertex → faces adjacency in CSR form.
  const start = new Uint32Array(V + 1);
  for (const v of indices) start[v + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const fill = start.slice(0, V);
  const faces = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) faces[fill[indices[i]]++] = (i / 3) | 0;

  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const outPos = new Float32Array(T * 9);
  const outNrm = new Float32Array(T * 9);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const g = faces[j];
        const dot = unit[t * 3] * unit[g * 3] + unit[t * 3 + 1] * unit[g * 3 + 1] + unit[t * 3 + 2] * unit[g * 3 + 2];
        if (dot >= cosCrease) {
          nx += face[g * 3]; ny += face[g * 3 + 1]; nz += face[g * 3 + 2];
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = t * 9 + k * 3;
      outPos[o] = positions[v * 3]; outPos[o + 1] = positions[v * 3 + 1]; outPos[o + 2] = positions[v * 3 + 2];
      outNrm[o] = nx / len; outNrm[o + 1] = ny / len; outNrm[o + 2] = nz / len;
    }
  }
  return { positions: outPos, normals: outNrm };
}
