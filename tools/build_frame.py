#!/usr/bin/env python3
"""Anatomical frame of the shipped heart: public/data/heart-frame.json.

The ECG needs to know where the heart points so it can put electrodes where they belong. This reads the same
Strocchi et al. mesh as build_heart.py (reusing its EnSight reader) plus the shipped heart.bin, and writes a
small frame in the coordinates of heart.bin: voxel INDEX coordinates of the unpadded grid, where the centre
of voxel (i, j, k) is exactly (i, j, k). Derivation and checks are in tools/README.md.

Usage:
  ~/heart-data/venv/bin/python tools/build_frame.py [--src ~/heart-data/23/23] [--case 23]
                                                    [--heart public/data/heart.bin]
                                                    [--out public/data/heart-frame.json]

Run it after build_heart.py. Raw data stays outside the repo; nothing here writes outside --out.
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np

import build_heart as bh  # EnSight reader, boundary-face helper

# element tags of the dataset (see tools/README.md)
LV_TAG, RV_TAG, LA_TAG, RA_TAG, AORTA_TAG, PA_TAG = 1, 2, 3, 4, 5, 6


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def check(ok, message):
    """A frame check. Unlike a bare assert this still runs under python -O, and nothing is written if it fails."""
    if not ok:
        raise SystemExit(f"frame check failed: {message}")


def angle_deg(a, b):
    return float(np.degrees(np.arccos(np.clip(np.dot(unit(a), unit(b)), -1.0, 1.0))))


def read_heart_bin(path):
    """Grid header and the muscle voxels of heart.bin: (nx, ny, nz, voxel mm, index coords Nx3, tissue N, fibre Nx3)."""
    b = Path(path).read_bytes()
    if b[:4] != b"HRT1":
        raise SystemExit(f"{path}: not an HRT1 file")
    nx, ny, nz = struct.unpack("<III", b[4:16])
    vs = struct.unpack("<f", b[16:20])[0]
    rec = np.frombuffer(b, np.uint8, 4 * nx * ny * nz, 20).reshape(-1, 4)
    idx = np.flatnonzero(rec[:, 0] > 0)
    vox = np.stack([idx % nx, (idx // nx) % ny, idx // (nx * ny)], axis=1).astype(np.float64)
    fibre = rec[idx, 1:].view(np.int8).astype(np.float64) / 127.0
    return nx, ny, nz, float(vs), vox, rec[idx, 0], fibre


def uvc_long_axis(xyz, nodes, z):
    """Base-to-apex direction: least-squares fit of node position against the dataset's own longitudinal
    coordinate (0 at the apex, 1 at the base), so the base-to-apex direction is minus the gradient."""
    a = np.c_[np.ones(len(z)), z]
    coef = np.linalg.lstsq(a, xyz[nodes].astype(np.float64), rcond=None)[0]
    return unit(-coef[1])


def basal_cut_geometry(xyz, conn, vent, npts):
    """Centre and plane normal (pointing into the ventricles) of the basal cut: the faces of ventricular
    tetrahedra that are shared with atria, valve planes or vessels."""
    faces, _ = bh.ventricular_boundary(conn, vent, npts)
    other = np.sort(conn[~vent][:, bh.TET_FACES], axis=2).reshape(-1, 3)
    key = lambda f: (f[:, 0].astype(np.int64) * npts + f[:, 1]) * npts + f[:, 2]
    cut = faces[np.isin(key(faces), key(other))]
    p = xyz[cut].astype(np.float64)
    area = 0.5 * np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1)
    fc = p.mean(1)
    centre = (fc * area[:, None]).sum(0) / area.sum()
    _, vecs = np.linalg.eigh(np.cov((fc - centre).T, aweights=area))
    return centre, vecs[:, 0], len(cut)  # smallest-variance direction = plane normal


def helix_right_handed_fraction(vox, tissue, fibre, layer, axis, centre):
    """Fraction of free-wall voxels of one layer (1 endo, 3 epi) whose fibre winds like a right-handed screw
    about the long axis. Same selection as tests/data/heart-frame.test.ts."""
    p = vox - centre
    along = p @ axis
    radial = p - np.outer(along, axis)
    r = np.linalg.norm(radial, axis=1)
    keep = (tissue == layer) & (r >= 5) & (r <= 45) & (np.abs(along) <= 25)
    theta = np.cross(axis, radial[keep] / r[keep, None])
    f = fibre[keep]
    return float(np.mean((f @ axis) * np.sum(f * theta, axis=1) > 0))


def slab_width(vox, centroid, axis, end, frac=0.15):
    """RMS distance from the long axis of the muscle in the slab covering `frac` of the length at one end."""
    t = (vox - centroid) @ axis
    span = t.max() - t.min()
    sel = t > t.max() - frac * span if end == "apex" else t < t.min() + frac * span
    perp = (vox[sel] - centroid) - np.outer(t[sel], axis)
    return float(np.sqrt((perp**2).sum(1).mean())), int(sel.sum())


def main():
    ap = argparse.ArgumentParser()
    home = Path.home()
    repo = Path(__file__).resolve().parent.parent
    ap.add_argument("--src", default=str(home / "heart-data/23/23"))
    ap.add_argument("--case", default="23")
    ap.add_argument("--heart", default=str(repo / "public/data/heart.bin"))
    ap.add_argument("--out", default=str(repo / "public/data/heart-frame.json"))
    ap.add_argument("--margin", type=int, default=1, help="empty voxels around the muscle, as in build_heart.py")
    a = ap.parse_args()

    src = Path(a.src)
    print("reading mesh and heart.bin")
    xyz, conn = bh.read_geo(src / f"{a.case}.geo")
    npts, ne = len(xyz), len(conn)
    tags = bh.read_var(src / f"{a.case}.tags.ens", ne).astype(int)
    uvc_iv = bh.read_var(src / f"{a.case}_uvc_intraventricular.ens", npts)  # -1 LV, +1 RV
    uvc_long = bh.read_var(src / f"{a.case}_uvc_longitudinal.ens", npts)  # 0 apex, 1 base
    vent = np.isin(tags, [LV_TAG, RV_TAG])
    vent_nodes = np.unique(conn[vent])

    nx, ny, nz, vs, vox, tissue, fibre = read_heart_bin(a.heart)

    # --- grid origin, exactly as build_heart.py: minimum ventricular node minus the margin. If the heart.bin
    # dimensions do not come out the same, heart.bin was built from something else.
    lo, hi = xyz[vent_nodes].min(0), xyz[vent_nodes].max(0)
    origin = lo - a.margin * vs
    dims = tuple(int(np.ceil((hi[k] - lo[k]) / vs)) + 2 * a.margin for k in range(3))
    if dims != (nx, ny, nz):
        raise SystemExit(f"heart.bin is {(nx, ny, nz)} but this mesh and margin give {dims}: rebuild heart.bin first")
    # a source point p (mm) in index coordinates: voxel centres sit at (index + 0.5) * vs from the origin
    to_idx = lambda p: (np.asarray(p, dtype=np.float64) - origin) / vs - 0.5

    # --- element centroids and volumes for exact, volume-weighted centroids of any label set
    pts = xyz[conn].astype(np.float64)
    ecent = pts.mean(1)
    e0 = pts[:, 0]
    evol = np.abs(np.einsum("ij,ij->i", np.cross(pts[:, 1] - e0, pts[:, 2] - e0), pts[:, 3] - e0)) / 6
    wcent = lambda m: to_idx((ecent[m] * evol[m, None]).sum(0) / evol[m].sum())

    centroid = wcent(vent)
    lv, rv = wcent(tags == LV_TAG), wcent(tags == RV_TAG)
    atria = wcent(np.isin(tags, [LA_TAG, RA_TAG]))
    aorta, pulm = wcent(tags == AORTA_TAG), wcent(tags == PA_TAG)

    mean_voxel = vox.mean(0)
    off = float(np.linalg.norm(mean_voxel - centroid))
    print(f"ventricular centroid, mesh {np.round(centroid, 3)} vs muscle voxels {np.round(mean_voxel, 3)}: {off:.3f} voxel apart")
    if off > 0.1:
        raise SystemExit("mesh centroid and heart.bin disagree: the coordinate convention is off")

    # --- long axis, base to apex. Three independent definitions must agree.
    long_axis = uvc_long_axis(xyz, vent_nodes, uvc_long[vent_nodes].astype(np.float64))
    base_centre, base_normal, n_cut = basal_cut_geometry(xyz, conn, vent, npts)
    if np.dot(to_idx(xyz[vent_nodes].mean(0)) - to_idx(base_centre), base_normal) < 0:
        base_normal = -base_normal  # point from the base into the ventricles, which is base to apex
    far = vent_nodes[np.argmax(np.linalg.norm(xyz[vent_nodes] - base_centre, axis=1))]
    axis_far = unit(xyz[far] - base_centre)
    print(f"long axis from UVC fit {np.round(long_axis, 3)}; basal cut of {n_cut} faces has normal at {angle_deg(long_axis, base_normal):.1f} deg, "
          f"base centre to farthest muscle node at {angle_deg(long_axis, axis_far):.1f} deg")
    if angle_deg(long_axis, base_normal) > 15 or angle_deg(long_axis, axis_far) > 15:
        raise SystemExit("the three long-axis definitions disagree by more than 15 degrees")

    # For the record: the principal axis of the muscle is NOT the long axis of this dilated heart.
    w, v = np.linalg.eigh(np.cov((vox - mean_voxel).T))
    print(f"  (principal axis of the muscle, sd {np.round(np.sqrt(w), 1)} mm, is {min(angle_deg(v[:, 2], long_axis), angle_deg(-v[:, 2], long_axis)):.0f} "
          "deg from the long axis: three nearly equal spreads, so PCA cannot find it)")

    # --- the frame, as specified: left = RV to LV across the long axis, superior = -long axis, anterior = -(superior x left)
    d = lv - rv
    left = unit(d - np.dot(d, long_axis) * long_axis)
    sup = unit(-(long_axis - np.dot(long_axis, left) * left))
    posterior = np.cross(sup, left)
    ant = -posterior

    t = (vox - centroid) @ long_axis
    apex_voxel, base_voxel = vox[np.argmax(t)].astype(int), vox[np.argmin(t)].astype(int)
    length_mm = float((t.max() - t.min()) * vs)

    # --- checks. Every one must pass or nothing is written.
    print("checks")
    tol = 1e-9
    check(abs(np.dot(left, sup)) < tol and abs(np.dot(left, ant)) < tol and abs(np.dot(sup, ant)) < tol, "axes not orthogonal")
    check(abs(np.linalg.norm(ant) - 1) < tol and np.dot(np.cross(sup, left), ant) < 0, "axes not unit and right-handed")
    # UVC intraventricular gives the same LV/RV split as the element tags (the septum is the only place they differ)
    ue = uvc_iv[conn].mean(1)
    d_uvc = wcent(vent & (ue < 0)) - wcent(vent & (ue > 0))
    left_uvc = unit(d_uvc - np.dot(d_uvc, long_axis) * long_axis)
    print(f"  LV/RV from tags vs from the UVC intraventricular coordinate: left axis differs by {angle_deg(left, left_uvc):.2f} deg")
    check(angle_deg(left, left_uvc) < 2, "tags and UVC disagree about which muscle is LV")
    # (a) as first worded, the RV centroid should be anterior of the LV centroid. That cannot work: left is BUILT
    # from the RV to LV vector, so that vector has no component along the third axis. It is zero, not positive.
    zero = float(np.dot(rv - lv, ant))
    print(f"  (a) as worded, (rv - lv) . anterior = {zero:.1e}  (zero by construction, so it tests nothing)")
    check(abs(zero) < 1e-9, "the RV to LV vector should have no anterior component by construction")
    # (a) instead, two independent handedness checks. (i) In a right-handed frame the pulmonary trunk lies in front
    # of the aortic root; that is the sign of det[base->apex, RV->LV, aorta->PA] and equals (PA - aorta) . anterior.
    pa_front = float(np.dot(pulm - aorta, ant))
    det = float(np.linalg.det(np.array([long_axis, lv - rv, pulm - aorta])))
    print(f"  (a) pulmonary artery is {pa_front:+.1f} mm anterior of the aorta; chirality determinant {det:+.0f} (positive = not mirrored)")
    check(pa_front > 0 and det > 0, "frame is mirrored: anterior is on the wrong side")
    # (ii) the fibres: right-handed helix at the endocardium, left-handed at the epicardium (Streeter), which a
    # mirror image would swap. Uses only heart.bin, so tests/data/heart-frame.test.ts repeats it.
    endo = helix_right_handed_fraction(vox, tissue, fibre, 1, long_axis, lv)
    epi = helix_right_handed_fraction(vox, tissue, fibre, 3, long_axis, lv)
    print(f"  (a) fibre helix: endocardium {100 * endo:.0f}% right-handed, epicardium {100 * epi:.0f}% right-handed")
    check(endo > 0.6 and epi < 0.2, "fibre helix handedness is wrong: mirrored coordinates")
    # (b) the atria are on the superior side of the ventricles
    up = float(np.dot(atria - centroid, sup))
    print(f"  (b) atria centroid is {up:+.1f} mm superior of the ventricles")
    check(up > 0, "atria are not superior: the long axis points the wrong way")
    # (c) the apex end is the narrower end. Width is the RMS distance from the axis in the end slab; muscle voxel
    # count is not used because the base is a hollow ring (fewer voxels than the solid apex).
    w_apex, n_apex = slab_width(vox, centroid, long_axis, "apex")
    w_base, n_base = slab_width(vox, centroid, long_axis, "base")
    print(f"  (c) end slabs (15% of length): apex width {w_apex:.1f} mm ({n_apex} voxels), base width {w_base:.1f} mm ({n_base} voxels)")
    check(w_apex < w_base, "apex end is not the narrower end")
    # --- write
    r6 = lambda v: [round(float(x), 6) for x in v]
    fields = [
        ("voxelMm", round(vs, 6)),
        ("centroid", r6(centroid)),
        ("lvCentroid", r6(lv)),
        ("rvCentroid", r6(rv)),
        ("atriaCentroid", r6(atria)),
        ("longAxis", r6(long_axis)),
        ("leftDir", r6(left)),
        ("superiorDir", r6(sup)),
        ("anteriorDir", r6(ant)),
        ("apexVoxel", [int(x) for x in apex_voxel]),
        ("baseVoxel", [int(x) for x in base_voxel]),
        ("lengthMm", round(length_mm, 6)),
    ]
    body = ",\n".join(f'  "{k}": {json.dumps(v)}' for k, v in fields)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("{\n" + body + "\n}\n")
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    print(f"  apex voxel {apex_voxel.tolist()}, base voxel {base_voxel.tolist()}, length {length_mm:.1f} mm")


if __name__ == "__main__":
    main()
