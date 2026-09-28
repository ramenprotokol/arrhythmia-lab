#!/usr/bin/env python3
"""Build public/data/ecg-samples.json from a few real PhysioNet recordings.

Offline tool, never shipped. It downloads only the handful of records listed
in SAMPLES (individual files, not whole datasets) into a raw-data folder that
must stay outside the repo, checks that each excerpt really matches its
published label, downsamples to 250 Hz at most, and writes the JSON.

Sources (both open, see tools/ecg-samples-README.md):
  PTB-XL 1.0.3                  CC BY 4.0   https://physionet.org/content/ptb-xl/1.0.3/
  MIT-BIH Arrhythmia Database   ODC-By 1.0  https://physionet.org/content/mitdb/1.0.0/

Set up and run (use a virtual environment outside the repo):
  python3 -m venv /path/to/venv
  /path/to/venv/bin/pip install wfdb numpy scipy
  ECG_RAW_DIR=/path/to/raw /path/to/venv/bin/python tools/build_ecg_samples.py

ECG_RAW_DIR defaults to a folder in the system temp directory.
"""

import ast
import csv
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import wfdb
from scipy.signal import find_peaks, resample_poly

PTBXL_BASE = "https://physionet.org/files/ptb-xl/1.0.3/"
MITDB_BASE = "https://physionet.org/files/mitdb/1.0.0/"

MAX_FS = 250
WINDOW_S = 5.0
MAX_BYTES = 200 * 1024

RAW = Path(os.environ.get("ECG_RAW_DIR") or Path(tempfile.gettempdir()) / "arrhythmia-lab-ecg-raw")
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "ecg-samples.json"


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, dest)
    return dest


def fetch_ptbxl_record(path: str) -> str:
    """path like 'records500/00000/00033_hr'; returns the local record path."""
    for ext in ("hea", "dat"):
        fetch(PTBXL_BASE + f"{path}.{ext}", RAW / "ptbxl" / f"{path}.{ext}")
    return str(RAW / "ptbxl" / path)


def fetch_mitdb_record(name: str) -> str:
    for ext in ("hea", "dat", "atr"):
        fetch(MITDB_BASE + f"{name}.{ext}", RAW / "mitdb" / f"{name}.{ext}")
    return str(RAW / "mitdb" / name)


def ptbxl_row(ecg_id: int) -> dict:
    meta = fetch(PTBXL_BASE + "ptbxl_database.csv", RAW / "ptbxl" / "ptbxl_database.csv")
    with open(meta, newline="") as f:
        for row in csv.DictReader(f):
            if int(row["ecg_id"]) == ecg_id:
                return row
    raise SystemExit(f"PTB-XL ecg_id {ecg_id} not found")


def downsample(x: np.ndarray, fs: int) -> tuple[np.ndarray, int]:
    """Anti-aliased resample to at most MAX_FS."""
    if fs <= MAX_FS:
        return x, fs
    g = np.gcd(fs, MAX_FS)
    return resample_poly(x, MAX_FS // g, fs // g), MAX_FS


def excerpt(sig: np.ndarray, fs: int, start_s: float, dur_s: float = WINDOW_S) -> tuple[np.ndarray, int]:
    """Resample with one second of margin either side so filter edges are cropped away."""
    margin = 1.0
    a = max(0, int((start_s - margin) * fs))
    b = min(len(sig), int((start_s + dur_s + margin) * fs))
    y, new_fs = downsample(sig[a:b].astype(float), fs)
    lo = int(round((start_s - a / fs) * new_fs))
    y = y[lo : lo + int(round(dur_s * new_fs))]
    y = y - np.median(y)  # centre on zero; absolute DC offset carries no meaning here
    return np.round(y, 3), new_fs


def lead_ii(rec, names=("II", "MLII")) -> np.ndarray:
    for n in names:
        if n in rec.sig_name:
            return rec.p_signal[:, rec.sig_name.index(n)]
    raise SystemExit(f"no lead II in {rec.sig_name}")


def r_peaks(x: np.ndarray, fs: int) -> np.ndarray:
    pk, _ = find_peaks(x, height=0.5 * x.max(), distance=int(0.25 * fs))
    return pk


def ptbxl_sample(sample_id, label, ecg_id, start_s, want_codes, regular):
    row = ptbxl_row(ecg_id)
    codes = ast.literal_eval(row["scp_codes"])
    assert set(codes) == set(want_codes), f"PTB-XL {ecg_id} labels are {codes}"
    assert codes[want_codes[0]] == 100.0
    rec = wfdb.rdrecord(fetch_ptbxl_record(row["filename_hr"]))
    y, fs = excerpt(lead_ii(rec), rec.fs, start_s)
    rr = np.diff(r_peaks(y, fs)) / fs
    cv = float(rr.std() / rr.mean())
    print(f"[{sample_id}] PTB-XL {ecg_id} labels {codes} | R peaks {len(rr) + 1}, mean HR {60 / rr.mean():.0f} bpm, RR CV {cv:.3f}")
    if regular:
        assert cv < 0.05, "rhythm should be regular"
    else:
        assert cv > 0.08, "rhythm should be irregularly irregular"
    return dict(id=sample_id, label=label, lead="II", fs=fs, mv=y.tolist(), record=f"PTB-XL ecg_id {ecg_id}")


def mitdb_window(name, start_s):
    p = fetch_mitdb_record(name)
    rec = wfdb.rdrecord(p)
    ann = wfdb.rdann(p, "atr")
    t = ann.sample / rec.fs
    m = (t >= start_s) & (t < start_s + WINDOW_S)
    beats = [(float(ti), s) for ti, s in zip(t[m], np.array(ann.symbol)[m]) if s not in "+~|!"]
    return rec, ann, beats


def mitdb_pvc_sample(sample_id, label, name, start_s):
    rec, _, beats = mitdb_window(name, start_s)
    syms = "".join(s for _, s in beats)
    n_v = syms.count("V")
    assert n_v >= 2 and syms.count("N") >= 3, f"unexpected beats {syms}"
    y, fs = excerpt(lead_ii(rec), rec.fs, start_s)
    print(f"[{sample_id}] MIT-BIH {name} beat annotations in window: {syms} ({n_v} PVCs of {len(beats)} beats)")
    return dict(id=sample_id, label=label, lead="II", fs=fs, mv=y.tolist(), record=f"MIT-BIH {name}")


def mitdb_vt_sample(sample_id, label, name, start_s):
    rec, ann, beats = mitdb_window(name, start_s)
    syms = "".join(s for _, s in beats)
    # The annotators marked "(VT" in this stretch of the record.
    vt_marks = [ti / rec.fs for ti, aux in zip(ann.sample, ann.aux_note) if aux.strip("\x00") == "(VT"]
    assert any(start_s <= tm < start_s + WINDOW_S for tm in vt_marks), "no (VT rhythm mark in window"
    vt_beats = [(ti, s) for ti, s in beats if s == "V"]
    times = np.array([ti for ti, _ in vt_beats])
    # Rate over the fast part of the run (skip the first beats while it winds up).
    rr = np.diff(times)[2:]
    hr = 60 / rr
    assert len(vt_beats) >= 10 and hr.mean() > 150, f"not fast VT: {hr}"
    y, fs = excerpt(lead_ii(rec), rec.fs, start_s)
    print(f"[{sample_id}] MIT-BIH {name} beats in window: {syms}; V-beat rate after wind-up {hr.mean():.0f} bpm (min {hr.min():.0f}, max {hr.max():.0f})")
    return dict(id=sample_id, label=label, lead="II", fs=fs, mv=y.tolist(), record=f"MIT-BIH {name}")


def main() -> int:
    samples = [
        ptbxl_sample(
            "normal-sinus",
            "Normal sinus rhythm: steady, regular heartbeat",
            ecg_id=33, start_s=2.0, want_codes=["NORM", "SR"], regular=True,
        ),
        mitdb_pvc_sample(
            "pvc",
            "Premature ventricular beats: early, wide extra beats that start in the ventricles",
            "119", 19.3,
        ),
        mitdb_vt_sample(
            "vtach",
            "Ventricular tachycardia: a fast run of wide beats from the ventricles",
            "205", 1460.0,
        ),
        ptbxl_sample(
            "afib",
            "Atrial fibrillation: irregular beats with no clear P waves",
            ecg_id=8215, start_s=0.0, want_codes=["AFIB"], regular=False,
        ),
    ]
    for s in samples:
        assert s["fs"] <= MAX_FS and len(s["mv"]) / s["fs"] <= WINDOW_S + 1e-9

    data = {
        "samples": samples,
        "source": "PhysioNet: PTB-XL 1.0.3 (Wagner et al., https://physionet.org/content/ptb-xl/1.0.3/) and MIT-BIH Arrhythmia Database 1.0.0 (Moody and Mark, https://physionet.org/content/mitdb/1.0.0/). Lead II excerpts, downsampled, baseline-centred.",
        "licence": "PTB-XL: CC BY 4.0. MIT-BIH Arrhythmia Database: ODC-By 1.0.",
        "url": "https://physionet.org/content/ptb-xl/1.0.3/",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    size = OUT.stat().st_size
    print(f"wrote {OUT.name}: {len(samples)} samples, {size} bytes")
    assert size < MAX_BYTES
    return 0


if __name__ == "__main__":
    sys.exit(main())
