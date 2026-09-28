// Base tissue constants for the 3D solver, calibrated on a 1 mm grid (see docs/receipts.md).
// On a block with fibres along x: conduction speed 0.89 mm/ms along, 0.35 mm/ms across (ratio 2.6).
// Smaller values fail to conduct across the fibres on a grid this coarse.
/** Diffusion coefficient along the fibre, mm^2 per ms. */
export const BASE_D_PAR = 0.4;
/** Diffusion coefficient across the fibre, mm^2 per ms. */
export const BASE_D_PERP = 0.13;
