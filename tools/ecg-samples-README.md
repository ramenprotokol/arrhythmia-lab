# Recorded ECG samples

`public/data/ecg-samples.json` holds four short, real, recorded ECG excerpts (lead II, 5 seconds each, 250 samples per second, about 33 KB in total). The app shows them next to the simulated lead II, for visual comparison only.

Rebuild with `build_ecg_samples.py`. It downloads only the records listed below, not the datasets, into a folder outside the repo (`ECG_RAW_DIR`), so raw data is never committed.

```
python3 -m venv /path/to/venv
/path/to/venv/bin/pip install wfdb numpy scipy
ECG_RAW_DIR=/path/to/raw /path/to/venv/bin/python tools/build_ecg_samples.py
```

## Records used

| id | Plain-English label | Record | Excerpt | Published label |
|----|---------------------|--------|---------|-----------------|
| `normal-sinus` | Normal sinus rhythm | PTB-XL ecg_id 33 (`records500/00000/00033_hr`) | 2.0 to 7.0 s | SCP codes `NORM` (100) and `SR`; human-validated |
| `pvc` | Premature ventricular beats | MIT-BIH Arrhythmia Database record 119, lead MLII | 19.3 to 24.3 s | Beat annotations: N N **V** N **V** (V = premature ventricular contraction); the record's rhythm annotation marks ventricular bigeminy from 21.1 s, inside this window |
| `vtach` | Ventricular tachycardia | MIT-BIH Arrhythmia Database record 205, lead MLII | 1460.0 to 1465.0 s | Rhythm annotation `(VT` (episode starts at 1460.5 s); 12 consecutive V beats after one normal beat |
| `afib` | Atrial fibrillation | PTB-XL ecg_id 8215 (`records500/08000/08215_hr`) | 0.0 to 5.0 s | SCP code `AFIB` (100), no other codes; human-validated |

MIT-BIH lead MLII is the modified limb lead II, which is the same view as lead II for this purpose.

## Checks the script runs

- PTB-XL: the chosen ecg_id must carry exactly the expected published SCP codes (read from `ptbxl_database.csv`). Normal sinus must have regular R-R intervals (variation under 5%); atrial fibrillation must be irregularly irregular (over 8%). Measured: normal sinus 75 bpm with 1.3% variation, atrial fibrillation 85 bpm with 14.6%.
- MIT-BIH premature ventricular beats: the beat annotations in the window must contain at least 2 V beats and 3 normal beats.
- MIT-BIH ventricular tachycardia: a `(VT` rhythm mark must fall inside the window, with at least 10 V beats and a V-beat rate above 150 bpm after the first two beats. Measured: about 203 bpm (160 to 223). The run starts with a few slower wide beats before it speeds up; that is the real onset, left in.
- Every excerpt is at most 250 Hz and 5 seconds, and the whole file must stay under 200 KB.

Processing: anti-aliased resampling (500 Hz or 360 Hz down to 250 Hz), the median is subtracted so each trace is centred on zero, values rounded to 0.001 mV. No filtering beyond that, no synthesis, no editing of the waveform.

## Licences and links

- PTB-XL 1.0.3, CC BY 4.0. Wagner P, Strodthoff N, Bousseljot R, et al. https://physionet.org/content/ptb-xl/1.0.3/
- MIT-BIH Arrhythmia Database 1.0.0, ODC-By 1.0 (Open Data Commons Attribution License). Moody GB, Mark RG. https://physionet.org/content/mitdb/1.0.0/
- PhysioNet: Goldberger AL, et al. Circulation 101(23):e215-e220, 2000.

Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.
