/**
 * How many columns to lay n equal panels out in.
 *
 * ONE STATEMENT OF "4 GIVES A 2x2", for any methodology and any surface. It
 * lived in CaptureBoard, where it shaped the wall of sticky notes from the
 * CATEGORY count — 4 gives 2x2, 6 gives 3x2, 9 gives 3x3 — and the relationship
 * matrix then needed exactly the same answer from the RELATIONSHIP TYPE count,
 * so it moved here rather than being written twice with a chance to disagree.
 *
 * It names no methodology. A square is what a reader expects of four related
 * cells, whether they are SWOT's four categories or TOWS's four quadrants, and
 * that expectation is about the number four, not about either methodology.
 */
export function boardColumns(n: number): number {
  if (n <= 2) return Math.max(1, n);
  if (n <= 4) return 2;
  return 3;
}
