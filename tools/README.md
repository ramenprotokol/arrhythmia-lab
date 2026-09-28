# Offline data tools

Everything here runs on the maker's machine and is never shipped. Raw downloads live
OUTSIDE the repo (default `~/heart-data/`) and are never committed.

## Rerun the heart pipeline

```sh
python3 -m venv ~/heart-data/venv
~/heart-data/venv/bin/pip install numpy scipy meshio scikit-image trimesh fast-simplification
tools/fetch_heart.sh                     # ~700 MB, resumable; default archive 23.tar.gz
curl -sL https://zenodo.org/api/records/3890034 -o ~/heart-data/record.json   # credit metadata
~/heart-data/venv/bin/python tools/build_heart.py
npx vitest run tests/data/heart-format.test.ts
```

`fetch_heart.sh` takes an archive name as its argument (`01.tar.gz` ... `24.tar.gz`) and
checks nothing beyond HTTP success; compare the md5 with the Zenodo file list if in doubt
(`23.tar.gz`: `880a642341f66700986dee7d58891c2d`, verified).

## Source data (what is really in the archive)

Strocchi et al., "A Publicly Available Virtual Cohort of Four-chamber Heart Meshes for
Cardiac Electro-mechanics Simulations", Zenodo record 3890034
(https://zenodo.org/records/3890034), licence CC BY 4.0. 24 hearts; we use archive
`23.tar.gz`, the smallest. Each archive holds two versions of the same heart:

- the standard mesh, ~1.1 mm average edge, **EnSight Gold, C Binary** (`23.case` + `.geo` + `.ens`
  variable files). This is the one we use.
- a 350 um refined mesh (`23-350um.vtk`, 2.2 GB). Not used.

Standard mesh facts, checked on the real files:

- Mesh: 407,578 nodes, 1,991,085 linear tetrahedra (`tetra4`), one part. Little-endian.
- Units: millimetres (nodes span about 141 x 115 x 124 mm).
- Element tags (`tags.ens`, scalar per element, stored as float): 1 LV myocardium,
  2 RV myocardium, 3 LA myocardium, 4 RA myocardium, 5 aorta wall, 6 pulmonary artery wall,
  7-13 vessel/appendage rings, 14-24 valve planes and vessel valve planes. Only 1 and 2 are kept.
  Blood pools are NOT meshed: the ventricular cavities are empty space bounded by muscle and valve planes.
- Fibres (`fiber.ens`) and sheets (`sheet.ens`): **vector per element** (not per node),
  component-major (all x, then all y, then all z). Unit length on ventricular elements
  (checked: 0.99999 - 1.00000); non-ventricular elements hold default vectors. Rule-based fibres.
  Published fibre angle runs from +80 degrees (endo) to -60 degrees (epi); measured rotation on
  this heart is about 130 degrees across the wall.
- Universal ventricular coordinates, **scalar per node** (`*_uvc_*.ens`): transmural (0 endo, 1 epi,
  -100 outside the ventricles), longitudinal, rotational, intraventricular (-1 LV, +1 RV).

EnSight variable file layout used by the reader: 80-byte description line, 80-byte `part`,
int32 part number, 80-byte block name (`tetra4` or `coordinates`), then float32 values.

## How `build_heart.py` works

1. Keep tags 1 and 2 only (ventricular muscle, 1,504,195 tets, 182.3 ml).
2. Find the muscle's boundary faces; drop faces touching atria, valve planes or vessels (the
   basal cut). The rest form three connected surfaces: LV cavity, RV cavity and the outer
   epicardium (identified with the UVC labels: epicardium faces are all transmural = 1).
3. Voxelise at 1.0 mm over the muscle's bounding box plus 1 empty voxel each side. A voxel is
   muscle if its centre lies inside a ventricular tetrahedron (exact test). The muscle voxel
   volume equals the mesh volume (182.3 ml).
4. Fibre of a voxel = fibre of its containing tetrahedron, normalised, stored as int8 x 127.
   No averaging, so no sign cancellation. Fibre sign is not made consistent (a fibre and its
   negative are the same for wave spread); neighbouring voxels can therefore differ by a
   sign or by up to about 40 degrees where the fibre rotates fastest (mid to outer wall).
5. Wall layer from distances to the three surfaces (nearest point on a dense surface sample):
   - free wall: depth = dCavity / (dCavity + dEpicardium), 0 at the blood, 1 at the epicardium;
     depth < 1/3 endo, < 2/3 mid, else epi.
   - septum (both faces touch blood, no epicardium between them: the farther cavity is closer
     than the epicardium): u = dNear / (dNear + dFar), 0 on either septal face, 0.5 mid-septum;
     u < 0.25 endo, else mid. The septum therefore has endocardium on both sides and no epi.
6. Outer surface: the epicardial triangles, oriented outward, Taubin-smoothed (20 iterations),
   quadric-decimated to 40,000 triangles, vertex normals recomputed. It is open at the base
   (where the atria were), about 300 boundary edges. Coordinates are shifted into the grid frame.
7. `credits.json` is written from the Zenodo record metadata (`record.json`).

## Binary formats (little-endian; `tests/data/heart-format.test.ts` checks them)

### `public/data/heart.bin` (magic `HRT1`)

| offset | type | meaning |
|---|---|---|
| 0 | 4 x uint8 | ASCII `HRT1` |
| 4 | uint32 | nx |
| 8 | uint32 | ny |
| 12 | uint32 | nz |
| 16 | float32 | voxelSizeMm (1.0) |
| 20 | 4 bytes x nx*ny*nz | voxel records, see below |

Total size = 20 + 4 * nx * ny * nz. Voxel index `i = x + nx * (y + ny * z)` (x fastest), so
record `i` starts at byte `20 + 4 * i`. Each 4-byte record is **interleaved**:

| byte | type | meaning |
|---|---|---|
| 0 | uint8 | tissue: 0 outside, 1 endo, 2 mid, 3 epi |
| 1 | int8 | fibre x, scaled by 127 |
| 2 | int8 | fibre y, scaled by 127 |
| 3 | int8 | fibre z, scaled by 127 |

Decode a fibre component as `int8 / 127`; the three together have length 1 (+-1%) on every muscle
voxel. Outside voxels (tissue 0) store fibre 0, 0, 0. The voxel with indices (x, y, z) covers
`[x, x+1) * voxelSizeMm` in each axis in the shared millimetre frame below, centre at `(x + 0.5) * voxelSizeMm`.
The loader can de-interleave into `tissue: Uint8Array` (length n) and `fibre: Int8Array` (length 3n).

This heart: 125 x 106 x 117, voxel 1.0 mm, 6,201,020 bytes; 182,253 muscle voxels
(endo 63,551 / mid 67,403 / epi 51,299).

### `public/data/heart-surface.bin` (magic `SRF1`)

| offset | type | meaning |
|---|---|---|
| 0 | 4 x uint8 | ASCII `SRF1` |
| 4 | uint32 | vertexCount V |
| 8 | uint32 | indexCount I (multiple of 3) |
| 12 | float32 x 3V | positions x,y,z per vertex (interleaved x0 y0 z0 x1 y1 z1 ...) |
| 12 + 12V | float32 x 3V | unit normals, same layout, pointing away from the muscle |
| 12 + 24V | uint32 x I | triangle vertex indices, counter-clockwise seen from outside |

Total size = 12 + 24 V + 4 I. All offsets are multiples of 4, so typed-array views are aligned.
This heart: V = 20,167, I = 120,000 (40,000 triangles), 964,020 bytes.

### Shared coordinate frame

Both files are in millimetres with the origin at the grid's minimum corner, axes as in the source
mesh (no rotation, so fibre vectors need no transformation). A vertex at `(px, py, pz)` sits at voxel
coordinate `p / voxelSizeMm`. The dataset frame origin of the grid corner was
(-43.84, 70.25, 36.57) mm (informational only; nothing else needs it).

### `public/data/credits.json`

`{ title, authors[], licence: "CC BY 4.0", url, doi, note }`, copied from the Zenodo record metadata.

## Limits worth knowing

- One idealised virtual heart from a heart-failure cohort (a dilated LV is expected); it is not
  a patient-specific model of anyone using the site.
- Fibres are the dataset authors' rule-based fibres, not measured.
- Layer thirds are a simple geometric rule; real endo/mid/epi cell types do not follow exact thirds.
- The ventricles are not closed at the base; there are no atria, valves or vessels in the data.
