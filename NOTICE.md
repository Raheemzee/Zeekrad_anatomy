# Third-party material in this project

Nothing here comes from IMAIOS, NavRad or any other commercial atlas.

## Software bundled in `static/vendor.js`

Built from `tools/vendor/entry.js` with esbuild 0.28.2. The bundle holds exactly these packages; each licence text is in `licenses/`.

| Package | Version | Licence |
|---|---|---|
| three | 0.183.2 | MIT |
| @kitware/vtk.js | 38.0.7 | BSD-3-Clause |
| d3-array, d3-color, d3-format, d3-interpolate, d3-scale, d3-time, d3-time-format | 3.2.5, 3.1.1, 3.1.3, 3.0.2, 4.0.2, 3.1.1, 4.1.1 | ISC |
| gl-matrix | 3.4.3 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| seedrandom | 3.0.5 | MIT |
| spark-md5 | 3.0.2 | WTFPL or MIT |

## Software installed by `requirements.txt` (not bundled)

Flask (BSD-3-Clause), gunicorn (MIT), NumPy (BSD-3-Clause), SciPy (BSD-3-Clause), NiBabel (MIT), pydicom (MIT), python-gdcm / GDCM (BSD-3-Clause), VTK (BSD-3-Clause).

## Segmentation engine installed by `requirements-segmentation.txt` (optional, not bundled)

TotalSegmentator 2.18.0 (code: Apache-2.0), with PyTorch and nnU-Net. Model weights are downloaded by the engine on first use from its own release
server; none is in this project. See "Licence position of the models" in `README.md` before any use beyond local evaluation.

## Images

No sample study is included in this server build. The reference anatomy of panel C is:

| Where | Source | Licence | Citation |
|---|---|---|---|
| `reference/labelled-ct` | TotalSegmentator CT dataset v2.0.1, subject s0913 | CC BY 4.0 | Wasserthal J. et al., "TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images", Radiology: Artificial Intelligence 2023. doi:10.5281/zenodo.10047292 |
| `reference/cadaver` | Visible Human Project, male, cryosection photographs | No licence required by NLM | Courtesy of the U.S. National Library of Medicine. This is not the most current data available from NLM. |

Changes made: the CT is stored on the workstation's display grid with values clipped to the display range, and its labels are the dataset's
own published reference segmentations; the cryosections are reduced in size and packed into sheets.

## Names

| Source | Licence | Status |
|---|---|---|
| ZeekaRad term base (`shared/knowledge/ctMultilingualTerms.ts`, `mriReferenceTerms.ts`, repository commit 4c69f73) | ZeekaRad's own | source-attested, not clinician-reviewed |
| Wikidata labels, read 12 November 2026, entities confirmed by their TA98 or FMA identifier | CC0 1.0 | community-maintained, not clinician-reviewed |
