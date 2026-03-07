/**
 * spatial-hash.ts — Spatial hash grid for efficient collision detection
 *
 * Problem: To check if any two segments are colliding, the naive approach
 * checks every pair: O(n^2). With 1000 segments, that's 500,000 checks per tick!
 *
 * Solution: Divide the world into a grid of cells. Each segment is placed into
 * the cell it overlaps. To find potential collisions, only check segments in the
 * same or neighboring cells. This reduces collision checks to roughly O(n).
 *
 * How it works:
 * 1. clear() — Empty all cells at the start of each tick
 * 2. insert(index, x, y) — Add a segment to its cell
 * 3. query(x, y) — Get all segment indices in the same + neighboring cells
 *
 * PERFORMANCE: Zero-allocation design.
 * - Query results go into a pre-allocated buffer (queryBuf) instead of allocating
 *   a new array per call. querySpatialHash returns the result count; callers
 *   read from hash.queryBuf[0..count-1].
 * - Cell arrays are pooled: on clear(), arrays go to a pool; on insert(),
 *   arrays are reused from the pool instead of allocating new ones.
 * - This eliminates thousands of short-lived array allocations per tick,
 *   reducing GC pressure at high organism counts and fast speeds.
 */

import { SPATIAL_HASH_CELL_SIZE } from '../constants';

export interface SpatialHash {
  cellSize: number;
  cells: Map<number, number[]>;  // cell key → array of segment indices
  cellPool: number[][];           // Pool of reusable cell arrays
  queryBuf: number[];             // Pre-allocated query result buffer
}

/**
 * Create a new spatial hash with the configured cell size.
 * queryBufSize determines the max number of results per query (default 16384).
 */
export function createSpatialHash(queryBufSize: number = 16384): SpatialHash {
  return {
    cellSize: SPATIAL_HASH_CELL_SIZE,
    cells: new Map(),
    cellPool: [],
    queryBuf: new Array(queryBufSize),
  };
}

/**
 * Convert a world position to a cell key.
 * We pack the cell (col, row) into a single number using bit shifting.
 * This is faster than using a string key like "3,5".
 */
function cellKey(x: number, y: number, cellSize: number): number {
  // Offset by 10000 to handle negative coordinates
  // (supports world from -10000*cellSize to +10000*cellSize)
  const col = Math.floor(x / cellSize) + 10000;
  const row = Math.floor(y / cellSize) + 10000;
  // Pack two 16-bit values into one 32-bit number
  return (col << 16) | (row & 0xFFFF);
}

/**
 * Remove all segments from the hash. Called at the start of each tick
 * before re-inserting all alive segments.
 * Cell arrays are returned to the pool for reuse instead of being GC'd.
 */
export function clearSpatialHash(hash: SpatialHash): void {
  const pool = hash.cellPool;
  for (const cell of hash.cells.values()) {
    cell.length = 0; // Clear contents but keep allocation
    pool.push(cell);
  }
  hash.cells.clear();
}

/**
 * Insert a segment into the spatial hash at its current position.
 *
 * @param hash The spatial hash
 * @param segmentIndex Index into the segment arrays (this is what we store)
 * @param x World X position
 * @param y World Y position
 */
export function insertIntoSpatialHash(
  hash: SpatialHash,
  segmentIndex: number,
  x: number,
  y: number,
): void {
  const key = cellKey(x, y, hash.cellSize);
  let cell = hash.cells.get(key);
  if (!cell) {
    // Reuse a pooled array if available, otherwise allocate
    cell = hash.cellPool.length > 0 ? hash.cellPool.pop()! : [];
    hash.cells.set(key, cell);
  }
  cell.push(segmentIndex);
}

/**
 * Query the spatial hash for all segments near a given position.
 * Checks the cell at (x, y) and all 8 neighboring cells (3x3 grid).
 *
 * Results are written to hash.queryBuf. Returns the number of results.
 * Callers must read results from hash.queryBuf[0..returnValue-1] BEFORE
 * calling querySpatialHash again on the same hash instance.
 *
 * @param hash The spatial hash
 * @param x Center X to query around
 * @param y Center Y to query around
 * @returns Number of segment indices written to hash.queryBuf
 */
export function querySpatialHash(
  hash: SpatialHash,
  x: number,
  y: number,
): number {
  const buf = hash.queryBuf;
  let len = 0;
  const cs = hash.cellSize;

  // Check the 3x3 grid of cells centered on (x, y)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = cellKey(x + dx * cs, y + dy * cs, cs);
      const cell = hash.cells.get(key);
      if (cell) {
        // Copy segment indices into buffer
        for (let i = 0; i < cell.length; i++) {
          buf[len++] = cell[i];
        }
      }
    }
  }

  return len;
}
