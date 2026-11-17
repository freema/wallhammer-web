// Dimensions the structure generator and shader take from the project (metres, unless noted), and the fixed sizes of
// the interior (`INTERIOR_DIM`), which the interior plan and the structure shader share.

/** Sizes the mesh generator needs. */
export interface ArchMeshDims {
  /** Lowest wall above the highest ground point under the footprint. */
  minWallHeight: number;
  /** How far walls reach below the lowest ground point. */
  wallBelowGround: number;
  /** Range of believable storey heights; a levels hint outside it is ignored. */
  floorHeightMin: number;
  floorHeightMax: number;
  /** Inset of the parapet ring on flat roofs. */
  parapetThickness: number;
  /** Pitched roof slope range (rise over run). */
  roofSlopeMin: number;
  roofSlopeMax: number;
  /** Boxes on flat roofs: smallest roof that gets any, area per box, most boxes per roof, box size and height ranges. */
  roofUnitMinRoofArea: number;
  roofUnitAreaPerUnit: number;
  roofUnitMaxCount: number;
  roofUnitMinSize: number;
  roofUnitMaxSize: number;
  roofUnitMinHeight: number;
  roofUnitMaxHeight: number;
  /**
   * Budget for one `field` roof. The roof is refined in rounds that halve every edge longer than 1.5 m; a round that
   * would leave more than this many triangles is not taken, so a large footprint stops at coarser edges. The final
   * roof can exceed the budget by the triangles added where planes meet (ridges, hips, valleys), typically a few
   * per cent. Default: no budget (every edge refined to 1.5 m).
   */
  fieldRoofMaxTriangles?: number;
}

/** Sizes the structure shader bakes in as constants. */
export interface ArchShadeDims {
  /** Height of the darker band at the wall foot. */
  plinthHeight: number;
  /** Height over which the wall foot brightens from its contact shadow. */
  wallBaseShadeHeight: number;
  /** Height of the parapet, for the shading on its inner side. */
  parapetHeight: number;
}

export type ArchDims = ArchMeshDims & ArchShadeDims;

/** Sizes of the interior in metres. */
export const INTERIOR_DIM = {
  /** Floor slab thickness (the roof keeps its own, `DESTRUCT_DIM.roofSlab`). */
  slab: 0.22,
  /** Partition wall thickness. */
  partition: 0.12,
  /** Door opening in a partition: width (the stair core gets a wider one) and height. */
  doorWidth: 0.9,
  coreDoorWidth: 1.1,
  doorHeight: 2.05,
  /** Footprint depth from which a corridor runs along the long axis, and its width range. */
  corridorDepth: 10,
  corridorWidthMin: 1.7,
  corridorWidthMax: 2.2,
  /** Room widths along the long axis: smallest, range of the seeded target, widest free span between cuts. */
  roomMin: 2.4,
  roomWidthMin: 3.2,
  roomWidthMax: 5.6,
  roomMax: 7,
  /** Deepest row of rooms across the long axis. */
  rowMax: 7.5,
  /** Below this area or width the whole storey is one room. */
  oneRoomArea: 28,
  oneRoomWidth: 4,
  /** Dog-leg stair: width range, landing depth range, rise per step, tread range, gap between flights. */
  stairWidthMin: 2.2,
  stairWidthMax: 2.7,
  landingMin: 0.9,
  landingMax: 1.15,
  stairRise: 0.185,
  stairRiseMax: 0.23,
  treadMin: 0.21,
  treadMax: 0.29,
  flightGap: 0.14,
  /** Cells smaller than this are empty. */
  minCellArea: 0.6,
} as const;
