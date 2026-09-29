# Recorded ECG samples

`public/data/ecg-samples.json` holds five short, real, recorded ECG excerpts (5 seconds each, 250 samples per second, about 41 KB in total). The app shows them next to the simulated trace, for visual comparison only. Each one carries a `caption` (at most 140 characters) that says which lead it is and what to look for.

Rebuild with `build_ecg_samples.py`. It downloads only the records listed below, not the datasets, into a folder outside the repo (`ECG_RAW_DIR`), so raw data is never committed. Rebuilding reproduces the shipped file exactly.

```
python3 -m venv /path/to/venv
/path/to/venv/bin/pip install wfdb numpy scipy
ECG_RAW_DIR=/path/to/raw /path/to/venv/bin/python tools/build_ecg_samples.py
```

## Records used

| id | Plain-English label | Record | Lead | Excerpt | Published label |
|----|---------------------|--------|------|---------|-----------------|
| `normal-sinus` | Normal sinus rhythm | PTB-XL ecg_id 33 (`records500/00000/00033_hr`) | II | 2.0 to 7.0 s | SCP codes `NORM` (100) and `SR`; human-validated |
| `pvc` | Premature ventricular beats | MIT-BIH Arrhythmia Database record 119 | MLII | 19.3 to 24.3 s | Beat annotations: N N **V** N **V** (V = premature ventricular contraction); the record's rhythm annotation marks ventricular bigeminy from 21.1 s, inside this window |
| `vtach` | Ventricular tachycardia | MIT-BIH Arrhythmia Database record 205 | MLII | 1460.0 to 1465.0 s | Rhythm annotation `(VT` (episode starts at 1460.5 s); 12 consecutive V beats after one normal beat |
| `vfib` | Ventricular fibrillation | CU Ventricular Tachyarrhythmia Database record cu11 | not stated | 399.2 to 404.2 s | Inside the ventricular flutter/fibrillation episode the annotators marked from 371.2 s (`[`) to the end of the record; no noise or rhythm-change marks within a second of the window |
| `afib` | Atrial fibrillation | PTB-XL ecg_id 8215 (`records500/08000/08215_hr`) | II | 0.0 to 5.0 s | SCP code `AFIB` (100), no other codes; human-validated |

About the leads. MIT-BIH's MLII is a modified lead II, recorded from electrodes on the chest; for this purpose it is the same view as lead II, and the `lead` field says `MLII` so the page can say so. The CU database records one monitor lead and does not say which, so its `lead` is `unspecified`.

Why these five. The lab makes a steady rhythm, early extra beats, a racing rhythm (ventricular tachycardia) and fibrillation of the lower chambers (ventricular fibrillation), so each has a real recording to compare with. Atrial fibrillation is kept on purpose, labelled as a different condition: it is common, it is what many people mean by "fibrillation", and the lower chambers still pump. The model has no upper chambers and cannot show it.

## Checks the script runs

- PTB-XL: the chosen ecg_id must carry exactly the expected published SCP codes (read from `ptbxl_database.csv`). Normal sinus must have regular R-R intervals (variation under 5%); atrial fibrillation must be irregularly irregular (over 8%). Measured: normal sinus 75 bpm with 1.3% variation, atrial fibrillation 85 bpm with 14.6%.
- MIT-BIH premature ventricular beats: the beat annotations in the window must contain at least 2 V beats and 3 normal beats.
- MIT-BIH ventricular tachycardia: a `(VT` rhythm mark must fall inside the window, with at least 10 V beats and a V-beat rate above 150 bpm after the first two beats. Measured: about 203 bpm (160 to 223). The run starts with a few slower wide beats before it speeds up; that is the real onset, left in.
- CU ventricular fibrillation: the record must not be one of the five from paced patients (cu12, cu15, cu24, cu25, cu32); the window must sit at least 2 s after the fibrillation mark and 1 s before its end, with no noise (`~`, `|`) or rhythm-change (`+`) mark within a second of it; the dominant rate must be 3 to 9 waves a second, the spacing of the waves irregular (coefficient of variation over 0.2), and there must be little power at 1.2 to 2.6 Hz, where chest compressions would show. Measured: 6.8 waves a second, spacing variation 0.36, compression band 1.3% of the power. The record was chosen by scanning every fibrillation episode in the database for clean, coarse, irregular 5-second windows and looking at the best of them; many records show chest compressions or repeated defibrillation, which the checks keep out.
- Every excerpt is at most 250 Hz and 5 seconds, fits the Compare panel's range (-1.5 to +3.5 mV), has a caption of at most 140 characters, and the whole file must stay under 200 KB.

Processing: anti-aliased resampling (500 Hz or 360 Hz down to 250 Hz; the CU records are already 250 Hz), the median is subtracted so each trace is centred on zero, values rounded to 0.001 mV. No filtering beyond that, no synthesis, no editing of the waveform.

## Licences and links

- PTB-XL 1.0.3, CC BY 4.0. Wagner P, Strodthoff N, Bousseljot R, et al. https://physionet.org/content/ptb-xl/1.0.3/
- MIT-BIH Arrhythmia Database 1.0.0, ODC-By 1.0 (Open Data Commons Attribution License). Moody GB, Mark RG. https://physionet.org/content/mitdb/1.0.0/
- CU Ventricular Tachyarrhythmia Database 1.0.0, ODC-By 1.0. Nolle FM, Badura FK, Catlett JM, Bowser RW, Sketch MH. CREI-GARD, a new concept in computerized arrhythmia monitoring systems. Computers in Cardiology 13:515-518 (1986). https://physionet.org/content/cudb/1.0.0/
- PhysioNet: Goldberger AL, et al. Circulation 101(23):e215-e220, 2000.

Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.
