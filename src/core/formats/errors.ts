/** Thrown for anything the user should see a readable message about
 *  (spec §5.1: corrupt file, wrong format, empty mesh). */
export class MeshParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeshParseError'
  }
}

/** Triangle soup under construction, shared by the text-based parsers.
 *  STL's own format is a soup, and every other format gets flattened into one
 *  so that indexing and welding stay the single source of topology. */
export class SoupBuilder {
  private readonly values: number[] = []

  /** Push one triangle by its three corner positions. */
  triangle(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    this.values.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  }

  /** Fan-triangulate a polygon given as flat xyz triples. Formats that allow
   *  n-gons (OBJ, PLY) are almost always convex or planar in practice, and a
   *  fan is what every other importer does with them. */
  polygon(points: number[]): void {
    for (let i = 1; i + 1 < points.length / 3; i++) {
      this.triangle(
        points[0]!, points[1]!, points[2]!,
        points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!,
        points[(i + 1) * 3]!, points[(i + 1) * 3 + 1]!, points[(i + 1) * 3 + 2]!,
      )
    }
  }

  get triangleCount(): number {
    return this.values.length / 9
  }

  positions(): Float32Array {
    return Float32Array.from(this.values)
  }
}
