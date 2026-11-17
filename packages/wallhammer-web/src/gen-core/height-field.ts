// Height field: a regular grid of heights with a bilinear height query and grid normals.

export class HeightField {
  /** Vertex spacing in metres. */
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
  /** Heights in metres above sea level, row by row from the north. */
  readonly heights: Float32Array;
  readonly minY: number;
  readonly maxY: number;

  constructor(step: number, cols: number, rows: number, heights: Float32Array) {
    this.step = step;
    this.cols = cols;
    this.rows = rows;
    this.heights = heights;
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    this.minY = lo;
    this.maxY = hi;
  }

  get sizeX(): number {
    return (this.cols - 1) * this.step;
  }

  get sizeZ(): number {
    return (this.rows - 1) * this.step;
  }

  /**
   * Thins a denser grid to every n-th vertex. The height of a new vertex is a weighted average of its 3 × 3 neighbourhood,
   * so the thinning does not pick random spikes.
   */
  static decimate(step: number, cols: number, rows: number, src: ArrayLike<number>, scale: number, offset: number, n: number): HeightField {
    const c2 = Math.floor((cols - 1) / n) + 1;
    const r2 = Math.floor((rows - 1) / n) + 1;
    const out = new Float32Array(c2 * r2);
    for (let j = 0; j < r2; j++) {
      for (let i = 0; i < c2; i++) {
        let sum = 0;
        let wsum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j * n + dj;
          if (jj < 0 || jj >= rows) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i * n + di;
            if (ii < 0 || ii >= cols) continue;
            const w = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
            sum += src[jj * cols + ii]! * w;
            wsum += w;
          }
        }
        out[j * c2 + i] = n === 1 ? src[j * cols + i]! * scale + offset : (sum / wsum) * scale + offset;
      }
    }
    return new HeightField(step * n, c2, r2, out);
  }

  /**
   * The surface that a grid thinned to every n-th vertex would draw, evaluated at every vertex of the full grid: at a
   * kept vertex the value itself, between kept vertices the value of the coarse triangle there (a coarse quad is split
   * by the same diagonal as in `heightAt`). This is the shape of a level of detail n times coarser, sampled where the
   * finer level has its vertices; a blend between two levels needs it. `cols − 1` and `rows − 1` must be multiples of
   * n. Works for any per-vertex value (a height, one component of a normal, one colour channel).
   *
   * On a line of the coarse grid the value depends only on the two kept vertices of that line, in one fixed formula,
   * so two grids that share such a line (neighbouring cells) get identical numbers along it.
   */
  static coarseSurface(cols: number, rows: number, src: ArrayLike<number>, n: number): Float64Array {
    if (n < 1 || (cols - 1) % n !== 0 || (rows - 1) % n !== 0) throw new Error(`coarseSurface: a ${cols} × ${rows} grid cannot be thinned by ${n}`);
    const out = new Float64Array(cols * rows);
    const lastI = Math.max(0, cols - 1 - n);
    const lastJ = Math.max(0, rows - 1 - n);
    for (let j = 0; j < rows; j++) {
      const j0 = Math.min(j - (j % n), lastJ);
      const fv = (j - j0) / n;
      const onJ = j % n === 0;
      for (let i = 0; i < cols; i++) {
        const i0 = Math.min(i - (i % n), lastI);
        const fu = (i - i0) / n;
        const onI = i % n === 0;
        let v: number;
        if (onI && onJ) v = src[j * cols + i]!;
        else if (onI) {
          const p = src[j0 * cols + i]!;
          v = p + (src[(j0 + n) * cols + i]! - p) * fv;
        } else if (onJ) {
          const p = src[j * cols + i0]!;
          v = p + (src[j * cols + i0 + n]! - p) * fu;
        } else {
          const a = src[j0 * cols + i0]!;
          const b = src[j0 * cols + i0 + n]!;
          const c = src[(j0 + n) * cols + i0]!;
          const d = src[(j0 + n) * cols + i0 + n]!;
          v = fu + fv <= 1 ? a + (b - a) * fu + (c - a) * fv : d + (c - d) * (1 - fu) + (b - d) * (1 - fv);
        }
        out[j * cols + i] = v;
      }
    }
    return out;
  }

  /** Height at a point. Computed per triangle exactly as the mesh draws them, so objects sit precisely on the surface. */
  heightAt(x: number, z: number): number {
    const gx = Math.min(Math.max(x / this.step, 0), this.cols - 1.0001);
    const gz = Math.min(Math.max(z / this.step, 0), this.rows - 1.0001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const k = j * this.cols + i;
    const a = this.heights[k]!;
    const b = this.heights[k + 1]!;
    const c = this.heights[k + this.cols]!;
    const d = this.heights[k + this.cols + 1]!;
    // The cell is split by the b–c diagonal.
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }

  /** Normal of grid vertex (i, j), same as in `heightFieldMesh`: from the difference of neighbouring heights. */
  vertexNormal(i: number, j: number): [number, number, number] {
    const { cols, rows, step, heights } = this;
    const h = (ii: number, jj: number): number => heights[Math.min(rows - 1, Math.max(0, jj)) * cols + Math.min(cols - 1, Math.max(0, ii))]!;
    const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * step);
    const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * step);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  }
}
