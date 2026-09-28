#!/usr/bin/env python3
"""Turn one Strocchi et al. heart (EnSight Gold case, 1.1 mm tetrahedral mesh) into the
two small files the website ships:

  public/data/heart.bin          voxel grid: tissue layer + fibre direction (see tools/README.md)
  public/data/heart-surface.bin  smooth outer (epicardial) surface mesh
  public/data/credits.json       dataset credit, taken from the Zenodo record metadata

Usage:
  python tools/build_heart.py [--src ~/heart-data/23/23] [--case 23]
                              [--record ~/heart-data/record.json] [--out public/data]
                              [--voxel-mm 1.0] [--triangles 40000]

Needs numpy, scipy, trimesh, fast-simplification (see tools/README.md for the venv).
Raw data stays outside the repo; nothing here writes outside --out.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import scipy.sparse as sp
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

LV_TAG, RV_TAG = 1, 2  # ventricular myocardium labels in the dataset


# ---------------------------------------------------------------- EnSight Gold C Binary reader
def read_geo(path):
    """Points (mm, float32 Nx3) and tetra4 connectivity (0-based int Mx4) of a one-part
    'C Binary' EnSight Gold geometry file with node ids and element ids given."""
    b = Path(path).read_bytes()
    o = 80 * 6  # 'C Binary', 2 description lines, 'node id given', 'element id given', 'part'
    o += 4 + 80 + 80  # part number, part description, 'coordinates'
    n = int(np.frombuffer(b, "<i4", 1, o)[0])
    o += 4 + 4 * n  # count + node ids
    xyz = np.frombuffer(b, "<f4", 3 * n, o).reshape(3, n).T.copy()  # x[n], y[n], z[n]
    o += 12 * n
    etype = b[o : o + 80].split(b"\0")[0].decode().strip()
    if etype != "tetra4":
        raise SystemExit(f"expected a tetra4 block, found {etype!r}")
    o += 80
    ne = int(np.frombuffer(b, "<i4", 1, o)[0])
    o += 4 + 4 * ne  # count + element ids
    conn = np.frombuffer(b, "<i4", 4 * ne, o).reshape(ne, 4) - 1
    if o + 16 * ne != len(b):
        raise SystemExit("unexpected trailing data in geometry file")
    return xyz, conn


def read_var(path, count, comps=1):
    """Variable file: 80-char description, 'part', int part number, block name (244 bytes),
    then the values, component-major (all x, then all y, then all z) for vectors."""
    a = np.frombuffer(Path(path).read_bytes(), "<f4", count * comps, 244)
    return a.reshape(comps, count).T.copy() if comps > 1 else a.copy()


# ---------------------------------------------------------------- surfaces
TET_FACES = np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]])


def ventricular_boundary(conn, vent, npts):
    """Faces of ventricular tets that are NOT shared with another ventricular tet, with the
    index of their owner tet. Includes faces against atria/valve planes (basal cut)."""
    vc = conn[vent]
    owner = np.repeat(np.flatnonzero(vent), 4)
    faces = np.sort(vc[:, TET_FACES], axis=2).reshape(-1, 3)
    key = (faces[:, 0].astype(np.int64) * npts + faces[:, 1]) * npts + faces[:, 2]
    order = np.argsort(key)
    ks = key[order]
    uniq, start, cnt = np.unique(ks, return_index=True, return_counts=True)
    keep = order[start[cnt == 1]]
    return faces[keep], owner[keep]


def face_components(faces, npts):
    ed = np.concatenate([faces[:, [0, 1]], faces[:, [0, 2]], faces[:, [1, 2]]])
    fid = np.tile(np.arange(len(faces)), 3)
    ek = ed[:, 0].astype(np.int64) * npts + ed[:, 1]
    o = np.argsort(ek)
    ek, f2 = ek[o], fid[o]
    same = ek[1:] == ek[:-1]
    g = sp.coo_matrix((np.ones(same.sum()), (f2[:-1][same], f2[1:][same])), shape=(len(faces),) * 2)
    return connected_components(g, directed=False)[1]


def surface_samples(xyz, faces):
    """Dense point sample of a triangle set (vertices + 3 interior points per face)."""
    p = xyz[faces].astype(np.float64)
    pts = [p.reshape(-1, 3)]
    for w in ((2 / 3, 1 / 6, 1 / 6), (1 / 6, 2 / 3, 1 / 6), (1 / 6, 1 / 6, 2 / 3)):
        pts.append(p[:, 0] * w[0] + p[:, 1] * w[1] + p[:, 2] * w[2])
    return np.concatenate(pts)


# ---------------------------------------------------------------- voxelisation
def voxelise(xyz, conn, vent, fib, origin, dims, vs):
    """Exact point-in-tetrahedron test for every voxel centre near ventricular tets.
    Returns (flat index of inside voxels, containing tet index for each)."""
    vt = np.flatnonzero(vent)
    P = xyz[conn[vt]].astype(np.float64)  # m,4,3
    cent = P.mean(1)
    tree = cKDTree(cent)
    v0 = P[:, 0]
    T = np.stack([P[:, 1] - v0, P[:, 2] - v0, P[:, 3] - v0], axis=2)  # columns are edges
    Tinv = np.linalg.inv(T)

    nx, ny, nz = dims
    gi = np.arange(nx * ny * nz)
    ix = gi % nx
    iy = (gi // nx) % ny
    iz = gi // (nx * ny)
    centres = origin + (np.stack([ix, iy, iz], axis=1) + 0.5) * vs
    dist, _ = tree.query(centres, k=1, distance_upper_bound=2.0)
    cand = np.flatnonzero(np.isfinite(dist))

    inside_idx, inside_tet = [], []
    chunk = 100_000
    K = 16
    for s in range(0, len(cand), chunk):
        ci = cand[s : s + chunk]
        _, nn = tree.query(centres[ci], k=K)
        d = centres[ci][:, None, :] - v0[nn]  # c,K,3
        lam = np.einsum("ckij,ckj->cki", Tinv[nn], d)
        l0 = 1 - lam.sum(2)
        ok = (lam.min(2) >= -1e-9) & (l0 >= -1e-9)
        hit = ok.any(1)
        first = ok.argmax(1)
        inside_idx.append(ci[hit])
        inside_tet.append(vt[nn[np.arange(len(ci)), first][hit]])
    return np.concatenate(inside_idx), np.concatenate(inside_tet)


def main():
    ap = argparse.ArgumentParser()
    home = Path.home()
    ap.add_argument("--src", default=str(home / "heart-data/23/23"))
    ap.add_argument("--case", default="23")
    ap.add_argument("--record", default=str(home / "heart-data/record.json"))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public/data"))
    ap.add_argument("--voxel-mm", type=float, default=1.0)
    ap.add_argument("--triangles", type=int, default=40000)
    ap.add_argument("--margin", type=int, default=1, help="empty voxels around the muscle")
    a = ap.parse_args()

    src, out, vs = Path(a.src), Path(a.out), float(a.voxel_mm)
    out.mkdir(parents=True, exist_ok=True)

    print("reading mesh")
    xyz, conn = read_geo(src / f"{a.case}.geo")
    npts, ne = len(xyz), len(conn)
    tags = read_var(src / f"{a.case}.tags.ens", ne).astype(int)
    fib = read_var(src / f"{a.case}.fiber.ens", ne, 3)
    utm = read_var(src / f"{a.case}_uvc_transmural.ens", npts)
    uiv = read_var(src / f"{a.case}_uvc_intraventricular.ens", npts)
    vent = np.isin(tags, [LV_TAG, RV_TAG])
    print(f"  nodes {npts}, tets {ne}, ventricular tets {vent.sum()}")

    # --- classify boundary surfaces of the ventricular muscle
    faces, owner = ventricular_boundary(conn, vent, npts)
    # keep faces on the outside of the whole mesh or against unmeshed blood; faces against
    # other tagged tissue (atria, valve planes, vessels) are the basal cut and are excluded
    all_faces = np.sort(conn[:, TET_FACES], axis=2).reshape(-1, 3)
    key_all = (all_faces[:, 0].astype(np.int64) * npts + all_faces[:, 1]) * npts + all_faces[:, 2]
    key_f = (faces[:, 0].astype(np.int64) * npts + faces[:, 1]) * npts + faces[:, 2]
    shared_with_other = np.isin(key_f, key_all[np.repeat(~vent, 4)])
    faces, owner = faces[~shared_with_other], owner[~shared_with_other]
    comp = face_components(faces, npts)
    ncomp = comp.max() + 1
    sizes = np.bincount(comp, minlength=ncomp)
    big = [c for c in range(ncomp) if sizes[c] > 1000]
    if len(big) != 3:
        raise SystemExit(f"expected 3 big surface components (LV cavity, RV cavity, epicardium), got {sizes}")
    tface = utm[faces].mean(1)
    # epicardium: the component whose faces are all transmural=1 (UVC epi); cavities have t=0 faces
    epi_c = [c for c in big if (tface[comp == c] < 0.5).mean() < 0.01]
    if len(epi_c) != 1:
        raise SystemExit("could not identify the epicardial component")
    epi_c = epi_c[0]
    cav = [c for c in big if c != epi_c]
    # LV cavity = the cavity component whose faces are all intraventricular = -1
    ivf = uiv[faces].mean(1)
    lv_c = [c for c in cav if (ivf[comp == c] < 0).mean() > 0.99]
    if len(lv_c) != 1:
        raise SystemExit("could not identify the LV cavity component")
    lv_c = lv_c[0]
    rv_c = [c for c in cav if c != lv_c][0]
    area = lambda m: 0.5 * np.linalg.norm(
        np.cross(xyz[faces[m]][:, 1] - xyz[faces[m]][:, 0], xyz[faces[m]][:, 2] - xyz[faces[m]][:, 0]), axis=1
    ).sum() / 100
    print(f"  surfaces: epi {area(comp == epi_c):.0f} cm2, LV cavity {area(comp == lv_c):.0f} cm2, "
          f"RV cavity {area(comp == rv_c):.0f} cm2")

    tree_epi = cKDTree(surface_samples(xyz, faces[comp == epi_c]))
    tree_lv = cKDTree(surface_samples(xyz, faces[comp == lv_c]))
    tree_rv = cKDTree(surface_samples(xyz, faces[comp == rv_c]))

    # --- voxel grid around the muscle
    vpts = xyz[np.unique(conn[vent])]
    lo, hi = vpts.min(0), vpts.max(0)
    origin = lo - a.margin * vs
    dims = tuple(int(np.ceil((hi[k] - lo[k]) / vs)) + 2 * a.margin for k in range(3))
    print(f"voxelising {dims[0]}x{dims[1]}x{dims[2]} at {vs} mm")
    idx, tet = voxelise(xyz, conn, vent, fib, origin, dims, vs)
    nx, ny, nz = dims
    n_vox = len(idx)
    mesh_vol = np.abs(np.einsum("ij,ij->i",
        np.cross(xyz[conn[vent]][:, 1] - xyz[conn[vent]][:, 0], xyz[conn[vent]][:, 2] - xyz[conn[vent]][:, 0]),
        xyz[conn[vent]][:, 3] - xyz[conn[vent]][:, 0])).sum() / 6
    print(f"  muscle voxels {n_vox} = {n_vox * vs**3 / 1000:.1f} ml, mesh volume {mesh_vol / 1000:.1f} ml")

    ix = idx % nx
    iy = (idx // nx) % ny
    iz = idx // (nx * ny)
    centres = origin + (np.stack([ix, iy, iz], axis=1) + 0.5) * vs

    # --- wall layer from distance to the cavity and to the outer surface
    d_epi = tree_epi.query(centres)[0]
    d_lv = tree_lv.query(centres)[0]
    d_rv = tree_rv.query(centres)[0]
    near = np.minimum(d_lv, d_rv)
    far = np.maximum(d_lv, d_rv)
    # free wall: normalised depth 0 at the cavity, 1 at the epicardium
    depth = near / np.maximum(near + d_epi, 1e-6)
    layer = np.where(depth < 1 / 3, 1, np.where(depth < 2 / 3, 2, 3))
    # septum: both faces touch a blood cavity and there is no epicardium between them.
    # It has endocardium on each side and mid-wall in the centre.
    septum = far < d_epi
    u = near / np.maximum(near + far, 1e-6)  # 0 on either septal face, 0.5 mid-septum
    layer = np.where(septum, np.where(u < 0.25, 1, 2), layer)
    layer = layer.astype(np.uint8)
    print(f"  layers: endo {np.sum(layer == 1)}, mid {np.sum(layer == 2)}, epi {np.sum(layer == 3)}, "
          f"septal voxels {int(septum.sum())}")

    # --- fibres: from the containing tet, normalised, int8 x127
    f = fib[tet].astype(np.float64)
    ln = np.linalg.norm(f, axis=1)
    bad = int((np.abs(ln - 1) > 0.01).sum())
    if bad:
        raise SystemExit(f"{bad} muscle voxels have a non-unit source fibre vector")
    f = f / ln[:, None]
    q = np.rint(f * 127).astype(np.int8)

    grid = np.zeros((nx * ny * nz, 4), dtype=np.uint8)
    grid[idx, 0] = layer
    grid[idx, 1:] = q.view(np.uint8)
    with open(out / "heart.bin", "wb") as fh:
        fh.write(b"HRT1")
        fh.write(struct.pack("<IIIf", nx, ny, nz, vs))
        fh.write(grid.tobytes())

    # --- outer surface: smooth, decimate, orient outward, write
    import fast_simplification
    import trimesh

    ef = faces[comp == epi_c]
    eo = owner[comp == epi_c]
    P = xyz[ef].astype(np.float64)
    nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    opp = np.array([[v for v in conn[t] if v not in fc][0] for t, fc in zip(eo, ef)])
    inward = ((xyz[opp] - P.mean(1)) * nrm).sum(1) > 0
    ef[inward] = ef[inward][:, ::-1]  # normals now point away from the muscle
    used, inv = np.unique(ef, return_inverse=True)
    mesh = trimesh.Trimesh(xyz[used].astype(np.float64), inv.reshape(-1, 3), process=False)
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=20)
    v2, f2 = fast_simplification.simplify(
        mesh.vertices, mesh.faces, target_reduction=1 - a.triangles / len(mesh.faces)
    )
    m2 = trimesh.Trimesh(v2, f2, process=True)
    m2.remove_unreferenced_vertices()
    normals = np.asarray(m2.vertex_normals)
    verts = np.asarray(m2.vertices) - origin  # same frame as the grid: mm from the grid corner
    idxs = np.asarray(m2.faces, dtype=np.uint32).reshape(-1)
    with open(out / "heart-surface.bin", "wb") as fh:
        fh.write(b"SRF1")
        fh.write(struct.pack("<II", len(verts), len(idxs)))
        fh.write(verts.astype("<f4").tobytes())
        fh.write(normals.astype("<f4").tobytes())
        fh.write(idxs.astype("<u4").tobytes())
    print(f"surface: {len(verts)} vertices, {len(idxs) // 3} triangles (from {len(ef)})")

    # --- credits, from the Zenodo record metadata
    rec = json.loads(Path(a.record).read_text())
    md = rec["metadata"]
    credits = {
        "title": md["title"],
        "authors": [c["name"] for c in md["creators"]],
        "licence": "CC BY 4.0",
        "url": "https://zenodo.org/records/3890034",
        "doi": "https://doi.org/" + rec["doi"],
        "note": "One heart (archive %s.tar.gz), ventricles only, resampled to a coarse voxel grid "
        "and smoothed surface by the tools in this repository." % a.case,
    }
    (out / "credits.json").write_text(json.dumps(credits, indent=2, ensure_ascii=False) + "\n")

    print("grid origin in source frame (mm):", np.round(origin, 2).tolist())
    print("grid dims:", dims, " bytes:", (out / "heart.bin").stat().st_size, (out / "heart-surface.bin").stat().st_size)


if __name__ == "__main__":
    main()
