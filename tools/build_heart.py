#!/usr/bin/env python3
"""Turn one Strocchi et al. heart (EnSight Gold case, 1.1 mm tetrahedral mesh) into the
small files the website ships:

  public/data/heart.bin          voxel grid: tissue layer + fibre direction (see tools/README.md)
  public/data/heart-surface.bin  smooth outer (epicardial) surface mesh of the ventricles
  public/data/heart-anatomy.bin  per-vertex anatomy for that mesh (grooves, AO, curvature) and the
                                 outer surface of the atria, great vessels and vein stumps
  public/data/credits.json       dataset credit, taken from the Zenodo record metadata

Usage:
  python tools/build_heart.py [--src ~/heart-data/23/23] [--case 23]
                              [--record ~/heart-data/record.json] [--out public/data]
                              [--voxel-mm 1.0] [--triangles 52000] [--extra-triangles 28000]
                              [--surfaces-only]

--surfaces-only rebuilds the two surface files and credits.json and leaves heart.bin alone.

Needs numpy, scipy, trimesh, fast-simplification, scikit-image (see tools/README.md for the venv).
Raw data stays outside the repo; nothing here writes outside --out.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import scipy.sparse as sp
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

LV_TAG, RV_TAG = 1, 2  # ventricular myocardium labels in the dataset

# Parts of the whole-heart outer surface, from the dataset's element tags: 3 LA, 4 RA, 5 aorta wall,
# 6 pulmonary artery wall, 7-13 vein and appendage rings (pulmonary veins, left atrial appendage stub,
# caval veins), 14-17 valve planes, 18-24 the planes that close the vein and appendage stubs.
PART_VENTRICLE, PART_LA, PART_RA, PART_AORTA, PART_PA, PART_VEIN, PART_CAP = 0, 1, 2, 3, 4, 5, 6
TAG_PART = {1: 0, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, **{t: 5 for t in range(7, 14)}, **{t: 6 for t in range(14, 25)}}
FINE_MM = 0.5  # voxel size of the whole-heart voxelisation the outer surface is extracted from


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


# ---------------------------------------------------------------- whole-heart outer surface
def rasterise_tags(xyz, conn, tags, vs, pad=2.0):
    """Tag of the tet containing each voxel centre (0 outside every tet), on a grid of vs mm
    covering the whole mesh plus pad mm. Returns (tag volume, grid corner in mm)."""
    lo = xyz.min(0).astype(np.float64) - pad
    dims = np.ceil((xyz.max(0) - lo + pad) / vs).astype(int)
    P = xyz[conn].astype(np.float64)
    v0 = P[:, 0]
    Tinv = np.linalg.inv(np.stack([P[:, 1] - v0, P[:, 2] - v0, P[:, 3] - v0], axis=2))
    bmin = np.floor((P.min(1) - lo) / vs - 0.5).astype(int)
    ext = np.ceil((P.max(1) - lo) / vs - 0.5).astype(int) - bmin + 1
    E = ext.max(0)
    offs = np.stack(np.meshgrid(*[np.arange(e) for e in E], indexing="ij"), -1).reshape(-1, 3)
    vol = np.zeros(dims, dtype=np.uint8)
    chunk = 20000
    for s in range(0, len(conn), chunk):
        sl = slice(s, min(len(conn), s + chunk))
        idx = bmin[sl][:, None, :] + offs[None, :, :]
        ok = (offs[None, :, :] < ext[sl][:, None, :]).all(2) & (idx >= 0).all(2) & (idx < dims).all(2)
        lam = np.einsum("cij,ckj->cki", Tinv[sl], lo + (idx + 0.5) * vs - v0[sl][:, None, :])
        inside = ok & (lam.min(2) >= -1e-9) & (lam.sum(2) <= 1 + 1e-9)
        ci, ki = np.nonzero(inside)
        ii = idx[ci, ki]
        vol[ii[:, 0], ii[:, 1], ii[:, 2]] = tags[sl][ci]
    return vol, lo


def clean_labels(faces, labels, passes=3):
    """Majority filter over edge neighbours: removes specks and smooths the borders between parts."""
    import trimesh

    adj = trimesh.Trimesh(np.zeros((faces.max() + 1, 3)), faces, process=False).face_adjacency
    n = len(faces)
    A = sp.coo_matrix((np.ones(2 * len(adj)), (np.r_[adj[:, 0], adj[:, 1]], np.r_[adj[:, 1], adj[:, 0]])), shape=(n, n)).tocsr()
    A = A + sp.identity(n, format="csr")
    classes = np.unique(labels)
    for _ in range(passes):
        onehot = sp.csr_matrix((np.ones(n), (np.arange(n), np.searchsorted(classes, labels))), shape=(n, len(classes)))
        votes = (A @ onehot).toarray()
        labels = classes[votes.argmax(1)]
    return labels


def drop_islands(faces, labels, min_faces=200):
    """Give every connected patch of one label that is smaller than min_faces the label around it, so each
    part is one piece with no stray islands (an island of the ventricles would have a false basal edge)."""
    import trimesh

    adj = trimesh.Trimesh(np.zeros((faces.max() + 1, 3)), faces, process=False).face_adjacency
    same = labels[adj[:, 0]] == labels[adj[:, 1]]
    n = len(faces)
    _, comp = connected_components(sp.coo_matrix((np.ones(same.sum()), (adj[same, 0], adj[same, 1])), shape=(n, n)), directed=False)
    labels = np.where(np.bincount(comp)[comp] < min_faces, -1, labels)
    a, b = np.r_[adj[:, 0], adj[:, 1]], np.r_[adj[:, 1], adj[:, 0]]
    while (labels < 0).any():
        ok = (labels[a] < 0) & (labels[b] >= 0)
        if not ok.any():
            raise SystemExit("could not fill the labels of a surface island")
        votes = sp.coo_matrix((np.ones(ok.sum()), (a[ok], labels[b][ok])), shape=(n, labels.max() + 1)).tocsr()
        todo = np.unique(a[ok])  # unlabelled faces next to a labelled one take the most common label there
        labels[todo] = np.asarray(votes[todo].argmax(1)).ravel()
    return labels


def edge_graph(verts, faces, extra_nodes=0):
    """Symmetric sparse graph of mesh edges weighted by length, with room for extra nodes at the end."""
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    w = np.linalg.norm(verts[e[:, 0]] - verts[e[:, 1]], axis=1)
    n = len(verts) + extra_nodes
    return e, w, sp.coo_matrix((np.r_[w, w], (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n))


def distance_from(verts, faces, seeds, seed_dist):
    """Shortest distance along mesh edges from a set of seed vertices that start at seed_dist (mm)."""
    _, _, g = edge_graph(verts, faces, extra_nodes=1)
    src = len(verts)
    link = sp.coo_matrix((seed_dist + 1e-6, (np.full(len(seeds), src), seeds)), shape=g.shape)
    d = dijkstra((g + link).tocsr(), directed=True, indices=src)
    return d[: len(verts)]


def vertex_normals(verts, faces):
    fn = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])  # area weighted
    n = np.zeros_like(verts)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def concavity(verts, faces, normals, smooth=3):
    """Minus the mean curvature (per mm): positive in grooves, negative on convex bulges. Cotangent
    Laplacian with a barycentric area, then a little neighbour averaging."""
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    area2 = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    cot = lambda p, q, r: np.einsum("ij,ij->i", q - p, r - p) / np.maximum(np.linalg.norm(np.cross(q - p, r - p), axis=1), 1e-12)
    ca, cb, cc = cot(a, b, c), cot(b, c, a), cot(c, a, b)
    n = len(verts)
    rows = np.r_[faces[:, 1], faces[:, 2], faces[:, 2], faces[:, 0], faces[:, 0], faces[:, 1]]
    cols = np.r_[faces[:, 2], faces[:, 1], faces[:, 0], faces[:, 2], faces[:, 1], faces[:, 0]]
    w = 0.5 * np.r_[ca, ca, cb, cb, cc, cc]
    W = sp.coo_matrix((w, (rows, cols)), shape=(n, n)).tocsr()
    A = np.zeros(n)
    for k in range(3):
        np.add.at(A, faces[:, k], area2 / 6)
    lap = (W @ verts - np.asarray(W.sum(1)).ravel()[:, None] * verts) / np.maximum(A, 1e-9)[:, None]
    conc = 0.5 * np.einsum("ij,ij->i", lap, normals)  # a sphere of radius R gives -1/R
    e, _, _ = edge_graph(verts, faces)
    U = sp.coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    U = U + sp.identity(n, format="csr")
    deg = np.asarray(U.sum(1)).ravel()
    for _ in range(smooth):
        conc = (U @ conc) / deg
    return conc


def bake_ao(verts, normals, solid, lo, vs, rays=64, reach=35.0, start=1.0):
    """Ambient occlusion from cosine-weighted rays marched through the filled heart volume: 1 open, 0 shut.
    A hit near the surface counts fully, one near the end of the reach hardly at all."""
    k = np.arange(rays) + 0.5
    r = np.sqrt(k / rays)
    phi = k * np.pi * (3 - np.sqrt(5))
    local = np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - r * r)], 1)  # cosine weighted, z up
    steps = np.arange(start, reach, vs)
    fall = 1 - (steps / reach) ** 2
    dims = np.array(solid.shape)
    out = np.empty(len(verts))
    helper = np.where(np.abs(normals[:, 2:3]) < 0.9, [[0, 0, 1]], [[1, 0, 0]])
    t1 = np.cross(normals, helper)
    t1 /= np.linalg.norm(t1, axis=1, keepdims=True)
    t2 = np.cross(normals, t1)
    for s in range(0, len(verts), 1000):
        sl = slice(s, min(len(verts), s + 1000))
        d = local[None, :, 0:1] * t1[sl, None] + local[None, :, 1:2] * t2[sl, None] + local[None, :, 2:3] * normals[sl, None]
        p = verts[sl, None, None, :] + d[:, :, None, :] * steps[None, None, :, None]
        ijk = np.floor((p - lo) / vs).astype(np.int32)
        inside = (ijk >= 0).all(-1) & (ijk < dims).all(-1)
        ijk = np.clip(ijk, 0, dims - 1)
        hit = solid[ijk[..., 0], ijk[..., 1], ijk[..., 2]] & inside
        first = np.where(hit.any(-1), hit.argmax(-1), -1)
        occl = np.where(first >= 0, fall[np.maximum(first, 0)], 0.0)
        out[sl] = 1 - occl.mean(1)
    return out


def whole_heart_surfaces(xyz, conn, tags, iv, origin, vent_triangles, extra_triangles):
    """The outer surface of the whole heart, split into the ventricles and the rest, sharing their seam exactly.

    Every tet is rasterised at FINE_MM; the empty space reachable from outside is flood filled, so the
    chambers count as solid; marching cubes on that solid gives one closed surface (the open aorta and
    pulmonary trunk keep their lumens, down to their valve planes). Each face takes the part of the tissue
    it lies on. The surface is smoothed and decimated jointly to an intermediate size, split into the
    ventricles and the rest, and each is decimated on its own with its border (the seam) held fixed.
    """
    import fast_simplification
    import trimesh
    from scipy import ndimage
    from skimage import measure

    vs = FINE_MM
    tagvol, lo = rasterise_tags(xyz, conn, tags, vs)
    empty, _ = ndimage.label(tagvol == 0)
    faces_of_box = np.concatenate([empty[0].ravel(), empty[-1].ravel(), empty[:, 0].ravel(), empty[:, -1].ravel(), empty[:, :, 0].ravel(), empty[:, :, -1].ravel()])
    outside = np.isin(empty, np.unique(faces_of_box[faces_of_box > 0]))
    blurred = ndimage.gaussian_filter((~outside).astype(np.float32), 0.7)
    solid = blurred > 0.5
    print(f"  whole heart: tissue {np.count_nonzero(tagvol) * vs**3 / 1000:.0f} ml, with the chambers {solid.sum() * vs**3 / 1000:.0f} ml")

    v, f, _, _ = measure.marching_cubes(blurred, 0.5, spacing=(vs, vs, vs))
    mesh = trimesh.Trimesh(v + lo + 0.5 * vs, f[:, ::-1], process=False)
    pieces = mesh.split(only_watertight=False)
    mesh = max(pieces, key=lambda m: len(m.faces))  # the heart; specks of loose tissue go
    if not mesh.is_watertight or mesh.volume <= 0:
        raise SystemExit("the whole-heart surface is not a closed, outward-facing surface")
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=40)

    # part of every face: the tag of the nearest tissue voxel under each corner, by majority
    ti = np.argwhere(tagvol > 0)
    tissue_tree = cKDTree(lo + (ti + 0.5) * vs)
    vpart = np.vectorize(TAG_PART.get)(tagvol[tuple(ti[tissue_tree.query(mesh.vertices)[1]].T)])
    fp = vpart[mesh.faces]
    part = np.where((fp[:, 0] == fp[:, 1]) | (fp[:, 0] == fp[:, 2]), fp[:, 0], fp[:, 1])
    part = clean_labels(mesh.faces, part)
    # curvature on the dense, even surface, where the cotangent weights behave; carried over to the final vertices
    fine_conc = concavity(mesh.vertices, mesh.faces, vertex_normals(mesh.vertices, mesh.faces), smooth=4)
    fine_tree = cKDTree(mesh.vertices)

    # joint decimation to an intermediate size, so the seam is not needlessly dense
    centres = mesh.triangles_center
    v2, f2 = fast_simplification.simplify(mesh.vertices, mesh.faces, target_count=4 * (vent_triangles + extra_triangles))
    part2 = drop_islands(f2, clean_labels(f2, part[cKDTree(centres).query(v2[f2].mean(1))[1]]))

    def decimate(sel, target):
        used, inv = np.unique(f2[sel], return_inverse=True)
        pv, pf = fast_simplification.simplify(v2[used], inv.reshape(-1, 3), target_count=target, preserve_border=True)
        return pv, pf

    vv, vf = decimate(part2 == PART_VENTRICLE, vent_triangles)
    xv, xf = decimate(part2 != PART_VENTRICLE, extra_triangles)
    xpart = clean_labels(xf, part2[cKDTree(v2[f2].mean(1)).query(xv[xf].mean(1))[1]], passes=2)
    xpart = np.where(xpart == PART_VENTRICLE, PART_CAP, xpart)  # a speck of ventricle left on the far side of the seam

    # weld the two parts into one mesh (the seam vertices are bit-identical in both) for normals, AO, curvature
    key = lambda p: [bytes(r) for r in np.ascontiguousarray(p, dtype=np.float64)]
    index = {k: i for i, k in enumerate(key(vv))}
    xmap = np.empty(len(xv), dtype=np.int64)
    nxt = len(vv)
    for i, k in enumerate(key(xv)):
        if k in index:
            xmap[i] = index[k]
        else:
            xmap[i] = nxt
            nxt += 1
    seam = np.count_nonzero(xmap < len(vv))
    jv = np.empty((nxt, 3))
    jv[: len(vv)] = vv
    jv[xmap] = xv
    jf = np.concatenate([vf, xmap[xf]])
    # Closed means every edge has a face on both sides: no crack along the seam, no hole anywhere. The
    # simplifier does not check the link condition, so an edge on a thin rim of the vessels can end up
    # shared by four faces; that draws fine, so it is allowed.
    _, ec = np.unique(np.sort(np.concatenate([jf[:, [0, 1]], jf[:, [1, 2]], jf[:, [2, 0]]]), axis=1), axis=0, return_counts=True)
    if ec.min() < 2:
        raise SystemExit("the ventricles and the rest do not close up along their seam")
    if ec.max() > 2:
        print(f"  note: {np.count_nonzero(ec > 2)} edge(s) shared by more than two faces")
    jn = vertex_normals(jv, jf)
    # over the millimetre or so round each vertex; creases sharper than 2 mm radius count as 2 mm
    conc = np.clip(fine_conc, -0.5, 0.5)[fine_tree.query(jv, k=32)[1]].mean(1)
    ao = bake_ao(jv, jn, solid, lo, vs)
    print(f"  surfaces: ventricles {len(vv)} vertices, {len(vf)} triangles; rest {len(xv)} vertices, "
          f"{len(xf)} triangles; {seam} seam vertices shared")

    # ventricles: signed distance to the interventricular grooves (the LV/RV border of the UVC label,
    # smoothed so its zero line does not follow the triangle edges) and distance from the base
    vent_nodes = np.unique(conn[np.isin(tags, [LV_TAG, RV_TAG])])
    lab = iv[vent_nodes[cKDTree(xyz[vent_nodes]).query(vv)[1]]].astype(np.float64)
    e, w, _ = edge_graph(vv, vf)
    n = len(vv)
    U = sp.coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    U = U + sp.identity(n, format="csr")
    deg = np.asarray(U.sum(1)).ravel()
    for _ in range(6):
        lab = (U @ lab) / deg
    cross = np.sign(lab[e[:, 0]]) != np.sign(lab[e[:, 1]])
    ce, cw = e[cross], w[cross]
    t = lab[ce[:, 0]] / (lab[ce[:, 0]] - lab[ce[:, 1]])
    seeds = np.r_[ce[:, 0], ce[:, 1]]
    seed_d = np.r_[t * cw, (1 - t) * cw]
    groove = distance_from(vv, vf, seeds, seed_d) * np.sign(lab)
    es, ec = np.unique(np.sort(np.concatenate([vf[:, [0, 1]], vf[:, [1, 2]], vf[:, [2, 0]]]), axis=1), axis=0, return_counts=True)
    border = np.unique(es[ec == 1])
    base = distance_from(vv, vf, border, np.zeros(len(border)))

    # the rest: one vertex per part, so a triangle never blends two parts; distance from the ventricle muscle
    vt = np.argwhere(np.isin(tagvol, [LV_TAG, RV_TAG]))
    vent_tree = cKDTree(lo + (vt + 0.5) * vs)
    key2 = xf * 8 + xpart[:, None]
    uniq, inv = np.unique(key2.ravel(), return_inverse=True)
    src_v = uniq // 8
    extra = {
        "positions": xv[src_v],
        "normals": jn[xmap[src_v]],
        "part": (uniq % 8).astype(np.uint8),
        "dist": vent_tree.query(xv[src_v])[0],
        "ao": ao[xmap[src_v]],
        "concavity": conc[xmap[src_v]],
        "indices": inv.reshape(-1, 3),
    }
    vent = {"positions": vv, "normals": jn[: len(vv)], "indices": vf, "groove": groove, "base": base, "ao": ao[: len(vv)], "concavity": conc[: len(vv)]}
    for m in (vent, extra):
        m["positions"] = m["positions"] - origin  # the grid frame: mm from the heart.bin grid corner
    counts = np.bincount(extra["part"], minlength=7)
    print("  rest by part (vertices): LA %d, RA %d, aorta %d, pulmonary artery %d, veins %d, caps %d" % tuple(counts[1:7]))
    return vent, extra


def write_surface(path, m):
    with open(path, "wb") as fh:
        fh.write(b"SRF1")
        fh.write(struct.pack("<II", len(m["positions"]), m["indices"].size))
        fh.write(m["positions"].astype("<f4").tobytes())
        fh.write(m["normals"].astype("<f4").tobytes())
        fh.write(m["indices"].astype("<u4").tobytes())


def write_anatomy(path, vent, extra):
    """heart-anatomy.bin (ANA1), layout in tools/README.md."""
    i16 = lambda x: np.clip(np.rint(x), -32768, 32767).astype("<i2")
    u8 = lambda x: np.clip(np.rint(x), 0, 255).astype(np.uint8)
    va = np.stack([i16(vent["groove"] * 10), i16(vent["base"] * 10), i16(vent["ao"] * 32767), i16(vent["concavity"] * 10000)], 1)
    nrm = np.zeros((len(extra["normals"]), 4), dtype=np.int8)
    nrm[:, :3] = np.clip(np.rint(extra["normals"] * 127), -127, 127).astype(np.int8)
    attr = np.stack([extra["part"], u8(extra["dist"]), u8(extra["ao"] * 255), u8(128 + extra["concavity"] * 400)], 1).astype(np.uint8)
    with open(path, "wb") as fh:
        fh.write(b"ANA1")
        fh.write(struct.pack("<III", len(vent["positions"]), len(extra["positions"]), extra["indices"].size))
        fh.write(va.tobytes())
        fh.write(extra["positions"].astype("<f4").tobytes())
        fh.write(nrm.tobytes())
        fh.write(attr.tobytes())
        fh.write(extra["indices"].astype("<u4").tobytes())


def write_grid(out, vs, xyz, conn, fib, utm, uiv, vent, origin, dims):
    """heart.bin: the voxel grid of the ventricular muscle, with wall layer and fibre per voxel."""
    npts = len(xyz)
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


# The fields of credits.json this script owns. Everything else in the file (credits other parts of the project add,
# such as recordings and fonts) is kept as it is.
CREDIT_FIELDS = ("title", "authors", "licence", "url", "doi", "note")


def write_credits(path, record_path, case):
    """Write the heart dataset's credit into credits.json, keeping every other entry already in the file."""
    rec = json.loads(Path(record_path).read_text())
    md = rec["metadata"]
    ours = {
        "title": md["title"],
        "authors": [c["name"] for c in md["creators"]],
        "licence": "CC BY 4.0",
        "url": "https://zenodo.org/records/3890034",
        "doi": "https://doi.org/" + rec["doi"],
        "note": "One heart (archive %s.tar.gz). The ventricles are simulated on a coarse voxel grid; the atria "
        "and great vessels of the same heart are drawn but not simulated. Resampled and smoothed by the tools "
        "in this repository." % case,
    }
    path = Path(path)
    try:
        existing = json.loads(path.read_text()) if path.exists() else {}
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not valid JSON, refusing to overwrite it: {e}")
    if not isinstance(existing, dict):
        raise SystemExit(f"{path} does not hold a JSON object, refusing to overwrite it")
    # our fields first and in our order, then everyone else's, in theirs
    merged = {k: ours[k] for k in CREDIT_FIELDS}
    merged.update({k: v for k, v in existing.items() if k not in CREDIT_FIELDS})
    path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    home = Path.home()
    ap.add_argument("--src", default=str(home / "heart-data/23/23"))
    ap.add_argument("--case", default="23")
    ap.add_argument("--record", default=str(home / "heart-data/record.json"))
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public/data"))
    ap.add_argument("--voxel-mm", type=float, default=1.0)
    ap.add_argument("--triangles", type=int, default=52000, help="triangles of the ventricular surface")
    ap.add_argument("--extra-triangles", type=int, default=28000, help="triangles of the atria, vessels and vein stumps")
    ap.add_argument("--margin", type=int, default=1, help="empty voxels around the muscle")
    ap.add_argument("--surfaces-only", action="store_true", help="rebuild the surfaces and credits, keep heart.bin")
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

    # --- voxel grid around the muscle
    vpts = xyz[np.unique(conn[vent])]
    lo, hi = vpts.min(0), vpts.max(0)
    origin = lo - a.margin * vs
    dims = tuple(int(np.ceil((hi[k] - lo[k]) / vs)) + 2 * a.margin for k in range(3))
    if not a.surfaces_only:
        write_grid(out, vs, xyz, conn, fib, utm, uiv, vent, origin, dims)

    # --- outer surfaces: the whole heart, split into the ventricles and the rest
    print("building the whole-heart surface")
    vsurf, extra = whole_heart_surfaces(xyz, conn, tags, uiv, origin, a.triangles, a.extra_triangles)
    box = np.array(dims) * vs
    if vsurf["positions"].min() < -1 or (vsurf["positions"] > box + 1).any():
        raise SystemExit("the ventricular surface leaves the grid box")
    write_surface(out / "heart-surface.bin", vsurf)
    write_anatomy(out / "heart-anatomy.bin", vsurf, extra)

    # --- credits, from the Zenodo record metadata (merged into what the file already holds)
    write_credits(out / "credits.json", Path(a.record), a.case)

    print("grid origin in source frame (mm):", np.round(origin, 2).tolist())
    print("grid dims:", dims, " bytes:", {f: (out / f).stat().st_size for f in ("heart.bin", "heart-surface.bin", "heart-anatomy.bin") if (out / f).exists()})


if __name__ == "__main__":
    main()
