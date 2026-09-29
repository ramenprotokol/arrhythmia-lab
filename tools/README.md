# Offline data tools

Everything here runs on the maker's machine and is never shipped. Raw downloads live
OUTSIDE the repo (default `~/heart-data/`) and are never committed.

## Rerun the heart pipeline

```sh
python3 -m venv ~/heart-data/venv
~/heart-data/venv/bin/pip install numpy scipy meshio scikit-image trimesh fast-simplification
tools/fetch_heart.sh                     # ~700 MB, resumable; default archive 23.tar.gz
curl -sL https://zenodo.org/api/records/3890034 -o ~/heart-data/record.json   # credit metadata
~/heart-data/venv/bin/python tools/build_heart.py                  # add --surfaces-only to keep heart.bin as it is
npx vitest run tests/data/heart-format.test.ts tests/render/anatomy.test.ts
~/heart-data/venv/bin/python tools/build_frame.py     # anatomical frame for the ECG, see "Heart frame" below
npx vitest run tests/data/heart-frame.test.ts
```

`fetch_heart.sh` takes an archive name as its argument (`01.tar.gz` ... `24.tar.gz`) and
checks the download's md5 before it unpacks anything; if it is wrong the script stops and
says what it wanted and what it got. The md5 of the default archive is built in
(`23.tar.gz`: `880a642341f66700986dee7d58891c2d`, verified). For another archive, give the md5
from the Zenodo file list in `HEART_MD5` (`HEART_MD5=... tools/fetch_heart.sh 07.tar.gz`), or
the script stops before it downloads anything. `tests/tools/fetch-heart.test.ts` runs the
script against a stand-in for curl, so nothing is downloaded.

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
6. Outer surfaces (also the whole of `--surfaces-only`, which leaves heart.bin untouched): every tet
   of the mesh, whatever its tag, is rasterised at 0.5 mm; the empty space reachable from outside is
   flood filled, so the four chambers count as solid (tissue 243 ml, with the chambers 728 ml);
   marching cubes on that solid (Gaussian 0.7 voxel) gives one closed surface of the whole heart. The
   aorta and pulmonary trunk are open tubes in the data, so their lumens stay open down to the valve
   planes. The surface is Taubin-smoothed (40 iterations) and every face takes the part of the tissue
   under it (majority of its corners, then a neighbour majority filter and no islands under 200 faces):
   ventricles (tags 1, 2), left atrium (3), right atrium (4), aorta (5), pulmonary artery (6), veins
   (7-13: rings of the four pulmonary vein stumps, the left atrial appendage and the two caval veins, as
   the dataset labels them) and caps (14-24: the valve planes and the planes that close those stumps).
   It is decimated jointly to 320,000 triangles, split into the ventricles and the rest, and each is
   decimated on its own to 52,000 and 28,000 triangles with its border held fixed, so the two share
   their seam vertex for vertex (956 vertices). Normals come from the joined surface, so shading is
   continuous across the seam. The simplifier does not check the link condition: one edge on a thin
   vessel rim ends up shared by four faces, which draws fine; the build checks that no edge is open.
   Baked per vertex: ambient occlusion (64 cosine-weighted rays marched through the filled volume, 35 mm
   reach, a hit counting less the farther it is), concavity (minus the mean curvature of the dense
   surface, cotangent Laplacian, averaged over about a millimetre, creases capped at 0.5 per mm), and on
   the ventricles the signed distance along the surface to the interventricular grooves (the zero line
   of the UVC intraventricular label, smoothed; negative on the LV side) and the distance from the base
   (the seam). Coordinates are shifted into the grid frame.
7. `credits.json` gets the heart dataset's credit from the Zenodo record metadata (`record.json`), merged into
   the file: the script owns only the fields listed below and keeps every other entry (credits other parts of the
   project add, such as recordings and fonts).

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
This heart: V = 26,479, I = 156,000 (52,000 triangles), 1,259,508 bytes. The surface is open only
along its seam with the rest of the heart (the atrioventricular junction and the roots of the aorta
and pulmonary trunk), whose outer surface is in `heart-anatomy.bin`.

### `public/data/heart-anatomy.bin` (magic `ANA1`; `tests/render/anatomy.test.ts` checks it)

| offset | type | meaning |
|---|---|---|
| 0 | 4 x uint8 | ASCII `ANA1` |
| 4 | uint32 | V, the vertexCount of `heart-surface.bin` (the records below follow its vertex order) |
| 8 | uint32 | E, vertices of the rest of the heart |
| 12 | uint32 | EI, its index count (multiple of 3) |
| 16 | int16 x 4V | per ventricle vertex: groove (0.1 mm), base (0.1 mm), ao (x 32767), concavity (per mm x 10000) |
| 16 + 8V | float32 x 3E | positions of the rest, grid frame |
| 16 + 8V + 12E | int8 x 4E | its unit outward normals x 127 (x, y, z, unused) |
| 16 + 8V + 16E | uint8 x 4E | part, distance from the ventricular muscle (mm, capped at 255), ao (x 255), 128 + concavity x 400 |
| 16 + 8V + 20E | uint32 x EI | triangle indices, counter-clockwise seen from outside |

groove is the signed distance along the surface to the interventricular grooves (negative on the LV
side), base the distance along the surface from the seam, ao 0 shut in to 1 open, concavity positive in
grooves and creases. part is 1 left atrium, 2 right atrium, 3 aorta, 4 pulmonary artery, 5 veins, 6 cap;
a vertex on a border between parts is stored once per part, so every triangle has a single part. The rest
of the heart is drawn but not simulated. Total size = 16 + 8V + 20E + 4EI. This heart: E = 15,413,
EI = 84,000 (28,000 triangles), 856,108 bytes.

### Shared coordinate frame

All three files are in millimetres with the origin at the grid's minimum corner, axes as in the source
mesh (no rotation, so fibre vectors need no transformation). A vertex at `(px, py, pz)` sits at voxel
coordinate `p / voxelSizeMm`. The dataset frame origin of the grid corner was
(-43.84, 70.25, 36.57) mm (informational only; nothing else needs it).

### `public/data/credits.json`

`{ title, authors[], licence: "CC BY 4.0", url, doi, note, ... }`: the first six fields are the heart dataset's,
written from the Zenodo record metadata by `build_heart.py` (its `CREDIT_FIELDS`); anything else in the file belongs
to other parts of the project and a rebuild leaves it as it is.

## Limits worth knowing

- One idealised virtual heart from a heart-failure cohort (a dilated LV is expected); it is not
  a patient-specific model of anyone using the site.
- Fibres are the dataset authors' rule-based fibres, not measured.
- Layer thirds are a simple geometric rule; real endo/mid/epi cell types do not follow exact thirds.
- Only the ventricles are simulated. The atria and the stumps of the great vessels and veins are drawn from
  the same heart; the data cuts the pulmonary trunk short above its valve and closes the left atrial appendage
  off with a plane, like the vein stumps.

## Heart frame for the ECG (`build_frame.py`)

The ECG has to put its electrodes where they belong relative to this heart, so `build_frame.py` measures which
way the heart points and writes `public/data/heart-frame.json` (about 500 bytes). Run it after `build_heart.py`:
it reads the same mesh (reusing the EnSight reader from `build_heart.py`) and the shipped `heart.bin`, and stops
with an error if `heart.bin` was not built from that mesh. `src/data/heartFrame.ts` reads and validates the file
(`parseFrame`, `loadFrame`); `tests/data/heart-frame.test.ts` checks the shipped file, and `HEART_FRAME=path`
points the same checks at another file.

### Coordinates

All positions are in **voxel index coordinates of the unpadded grid in `heart.bin`, where the centre of voxel
(i, j, k) is exactly (i, j, k)**; millimetres are the coordinate times `voxelMm`. This is the convention of
`Simulation.stimulate` and of the ECG kernel. A source-mesh point `p` (mm) maps to `(p - origin) / voxelMm - 0.5`,
with `origin` the grid corner (-43.84, 70.25, 36.57), which the script recomputes exactly as `build_heart.py`
does. Note the half voxel: the surface file measures from the grid corner, so a surface vertex in mm divided by
`voxelMm` is the frame coordinate plus 0.5. The script and the test both check that the mesh centroid and the mean
muscle voxel of `heart.bin` agree to 0.1 voxel (they agree to 0.02), which would catch a shifted or swapped axis.

### Keys

| key | meaning |
|---|---|
| `voxelMm` | voxel size, 1.0 |
| `centroid` | volume-weighted centroid of the whole ventricular muscle (tags 1 and 2) |
| `lvCentroid`, `rvCentroid` | the same for tag 1 and tag 2 |
| `atriaCentroid` | the same for tags 3 and 4 (both atria) |
| `longAxis` | unit vector from the base to the apex |
| `leftDir` | unit vector from the RV toward the LV, made orthogonal to `longAxis` |
| `superiorDir` | unit vector from the apex toward the base, `-longAxis` |
| `anteriorDir` | unit vector completing a right-handed frame: `superiorDir x leftDir` is posterior, anterior is its negative |
| `apexVoxel`, `baseVoxel` | the muscle voxels farthest along `longAxis` toward the apex and toward the base (indices) |
| `lengthMm` | extent of the muscle along `longAxis` |

`parseFrame` requires all keys, unit lengths within 1e-3, mutual orthogonality of left, superior and anterior
within 1e-2, and a right-handed triple. This heart: left (0.636, 0.751, 0.180), superior (-0.750, 0.545, 0.375),
anterior (0.183, -0.373, 0.909) in the mesh's axes; apex voxel (119, 19, 23), base voxel (31, 79, 68); length 115.6 mm.

### How the long axis is found (and two things that do not work)

- **Not the principal axis of the muscle.** The heart-failure ventricles are so round that the three spreads
  of the muscle are nearly equal (sd 23.0, 27.4 and 28.8 mm), and the leading principal axis lies along the
  RV-to-LV direction (8.5 degrees from it), 69 degrees away from the base-to-apex axis. (`heartShape` in
  `tests/gpu/heartGeometry.ts` uses this method and returns apex voxel (3, 25, 55) and base voxel (110, 82, 52):
  the "apex" is the far right edge of the RV free wall.)
- **Not "the end with fewer muscle voxels is the apex".** The base is a hollow ring: a slab of 15% of the length
  holds 9,998 muscle voxels at the base and 12,906 at the apex. Width, the RMS distance from the axis, is what
  differs: 39.7 mm at the base end against 18.8 mm at the apex end.
- **What is used:** a least-squares fit of node position against the dataset's own UVC longitudinal coordinate
  (0 at the apex, 1 at the base); the base-to-apex direction is minus its gradient. Two independent definitions
  must agree with it within 15 degrees, or the script stops: the normal of the basal cut (the ventricular faces
  shared with atria, valve planes and vessels; 1.5 degrees away here) and the line from the basal cut's centre to
  the farthest muscle node (8.5 degrees away). All three point the same way. Reading the mesh axes as x left,
  y posterior, z superior (see the last section) that is toward the patient's left, front and feet, where an
  apex belongs.

### The checks

Every one is asserted in `build_frame.py` before anything is written.

- **(a) Handedness.** The derivation gives anterior by the right-hand rule, which assumes the mesh is not a mirror
  image. The check first proposed for this, "the RV centroid lies anterior of the LV centroid", is identically
  zero here: `leftDir` is built from the RV-to-LV vector, so that vector lies in the left/superior plane and has
  no anterior component at all (the script prints -4e-16). It tests nothing, so two independent checks replace it.
  (i) The great vessels: in a normal heart in a right-handed frame the determinant
  `det[base->apex, RV->LV, aorta->PA]` is positive (the pulmonary trunk sits to the left of, in front of and above
  the aortic root; tags 5 and 6). Here it is +1126, which is the same statement as `(PA - aorta) . anterior`
  = +25.2 mm scaled by the RV-to-LV distance. A mirrored mesh would give a negative number. (ii) The fibres wind like a right-handed screw about the long axis at the endocardium and a left-handed
  one at the epicardium (Streeter); a mirror image swaps them. Measured on the free wall of the LV, mid-ventricle:
  endocardium 76% right-handed, epicardium 4%. The test repeats (ii) from `heart.bin` alone.
- **(b) Atria superior of the ventricles:** the atria centroid is 61.8 mm on the superior side of the centroid.
- **(c) Apex at the narrower end:** slab width 18.8 mm at the apex end, 39.7 mm at the base end.
- LV and RV from the element tags give the same left axis as LV and RV from the UVC intraventricular coordinate,
  to 0.05 degrees.

### What the frame is, and is not

- It is a frame of **this heart**, not of a body. The mesh appears to be in a patient frame with +x toward the
  patient's left, +y posterior and +z superior (I believe so from where the labelled chambers and vessels sit;
  the dataset does not say). Read that way, this dilated heart lies flat and rotated: `superiorDir` is 68 degrees
  from vertical and `leftDir` is 50 degrees from the patient's left. The patient's front, written in the frame's
  (left, anterior, superior) components, is (-0.75, +0.37, -0.54). Electrode offsets given as (left, anterior,
  superior) in this frame therefore follow the heart, not a real chest: with the standard chest offsets, V6 lands
  about 89 mm behind the ventricular centroid and V1 about 53 mm in front of it.
- The three sanity checks show the frame is not flipped or mirrored. They do not show it matches a particular
  body, and it does not need to: the ECG is a simulation and qualitative.
- A measurement that bears on which frame the electrodes should use (28 Sep 2026, ECG gain 85, integral of each
  lead over the first 250 ms after pacing the real heart, mV.ms). With the standard offsets in this heart-based
  frame, a wave started at the apex gives V1 to V6 of +154, +147, +61, -12, -19, -21. With the same offsets placed
  along the mesh axes read as a patient frame (left = +x, anterior = -y, superior = +z) it gives +49, -86, -252,
  -346, -297, -210, and a wave started at the base gives +106, +186, +252, +273, +221, +156 (all positive). The
  patient reading matches the usual teaching rule (from memory, not checked against a source here): precordial
  leads negative for an apical origin and positive for a basal one. It also supports the reading of the mesh axes
  as a patient frame.
