# ZeekaRad Anatomy workstation, server build for Render

The seven-panel anatomy workstation (patient, segmentation and labels, reference, 3D anatomy, MPR, curved reformat, volume rendering), served
by gunicorn on Render. Same code as the local Flask build, with two differences:

- **No sample studies.** The server starts empty; everything shown is what is uploaded to it. The reference anatomy of panel C (a labelled
  CT of another subject, Visible Human cryosections) is included.
- **gunicorn** serves it (`requirements.txt`, `render.yaml`).

It is a test build. Labels are model output that no clinician has reviewed. It is not for diagnosis.

## Deploy

1. Put the contents of this folder at the root of a Git repository (GitHub, GitLab or Bitbucket) and push it.
2. In Render: **New → Blueprint**, choose the repository. Render reads `render.yaml` and creates the web service with its disk.
3. Wait for the first build (about 3 minutes: NumPy, SciPy, VTK, GDCM wheels).
4. Open the service URL. No password is asked for: anyone with the address can open the workstation, upload, view and delete studies.

Without Blueprint: **New → Web Service** from the repository, runtime Python, then

| Setting | Value |
|---|---|
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app --workers 1 --threads 8 --timeout 300 --bind 0.0.0.0:$PORT` |
| Health check path | `/healthz` |
| Environment | `ZK_ANATOMY_DATA` = `/var/data` (only with a disk mounted there), `ZK_ANATOMY_AUTO_SEGMENT` = `0` |
| Disk | mount path `/var/data`, so that uploads survive restarts and deploys |

Python: `.python-version` asks for 3.13 (the build was tested on 3.13). If Render rejects that form, set the environment variable
`PYTHON_VERSION` to a full 3.13 release instead.

## Plan and cost

`render.yaml` asks for the **Standard** plan (2 GB of memory) and a 10 GB disk. Both cost money; change them in `render.yaml` before
creating the Blueprint if you want something else.

- Memory measured while reading uploads (gunicorn worker, this build): 86 MB idle; a 34 MB CT of 25 million voxels peaks at 389 MB. A full
  clinical CT of about 130 million voxels needs about 1.5 GB, so 512 MB plans (Free, Starter) handle only small volumes.
- Render's disks need a paid plan. Without a disk the server still works: if `ZK_ANATOMY_DATA` names a folder it cannot write (for example
  `/var/data` with no disk mounted), it keeps uploads in a temporary folder instead and the upload dialog says so. Those uploads are lost
  when the service restarts or redeploys, and a Free service sleeps when idle.

## If an upload fails

The upload dialog now shows the reason: the server's own message, or, when the host answered instead of the workstation, the HTTP status
and what it usually means. Common ones on Render:

| Message | Cause | What to do |
|---|---|---|
| HTTP 502 or 503, or no answer | The service ran out of memory reading the study and restarted | A plan with more memory, or a smaller study |
| HTTP 413 | The upload is larger than the host accepts | Upload the series as a zip, or fewer files at a time |
| Permission denied, or the temporary-folder note | `ZK_ANATOMY_DATA` points at a folder without a disk | Add a disk at that path, or remove the variable |

The full error is also in the service's **Logs** on Render.

## What works on the server

Upload a DICOM series (loose files, a folder or a zip) or a NIfTI volume. Every panel opens: the images in A, planes in E, volume rendering
in G, the reference in C, window presets and cine.

**Segmentation is not installed on the server**, so uploads are shown without labels: panels B, D and F wait for a segmentation, and G shows
the volume without structures or explode. Labels, 3D surfaces, hover names and explode need a segmented study. Two ways to have them:

1. **Segment on your computer** with the local Flask build (it has the engine), then copy the study folder (`data/studies/<id>`) to the
   server's disk under `/var/data/studies/` (for example with Render's shell or `scp` to a service with SSH). The server shows it
   with everything, including the light surfaces for smooth motion.
2. **Install the engine on the server**: add `pip install -r requirements-segmentation.txt` to the build command and set
   `ZK_ANATOMY_AUTO_SEGMENT=1`. This was not tested on Render. The engine installs PyTorch (several GB), downloads model weights on first
   use, and needs far more memory than Standard: on the 8 GB build machine one fine-structure model ran out of memory on a large CT. Expect
   a plan with at least 8 to 16 GB, and minutes per study on CPU. If you do, set `ZK_ANATOMY_LEVEL=standard`: that runs only `total` and
   `total_mr`, the two tasks approved in ZeekaRad's licence registry; the fine-structure tasks of the extended level are not approved there.

## Privacy

There is no password: anyone who has the address can open the workstation and see, upload or delete studies. Uploads are stored on
Render's servers. The workstation keeps no patient name, patient ID, date or UID from the DICOM headers, but it does
keep the pixels, and some images carry identifiers burned into them. Use de-identified studies unless your agreements allow otherwise.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ZK_ANATOMY_DATA` | `./data` | Where uploads are kept; `/var/data` on Render with the disk. A folder that cannot be written falls back to a temporary one |
| `ZK_ANATOMY_AUTO_SEGMENT` | 1 | 0: do not start segmentation on upload. `render.yaml` sets 0 |
| `ZK_ANATOMY_MAX_UPLOAD_MB` | 4096 | Largest upload. `render.yaml` sets 1024 |
| `ZK_ANATOMY_MAX_DISPLAY_VOXELS` | 48000000 | Largest volume sent to the browser at full resolution |
| `ZK_ANATOMY_LEVEL` | extended | Segmentation level when an engine is installed: quick, standard, extended |
| `ZK_ANATOMY_DEVICE` | auto | auto, cpu or gpu |

The health check `/healthz` says only that the server answers.

## Run it on your own computer

```
pip install -r requirements.txt
python app.py                      then open http://127.0.0.1:5000
```

## What was tested for this build

On Linux, Python 3.13, installed fresh from `requirements.txt`, served by gunicorn 27.0.0 exactly as `render.yaml` starts it:

- The upload failure reported after the first deployment was reproduced: running as an ordinary (non-root) user, as Render does, with
  `ZK_ANATOMY_DATA=/var/data` and no disk there, every upload failed with a bare HTTP 500 page. With this build the same setup takes the
  upload into a temporary folder, the dialog says so, and an upload of a DICOM zip through the Upload button in Chrome opened the study.
  This is the most likely cause of the failure on Render; the Render logs were not available here to confirm it.
- Every page and API call answers without any password.
- The 29-check workstation verification (29 of 29) and the 20-check hover and explode check (20 of 20) in Google Chrome on this exact
  build, with no password, on a segmented study placed on the server and an unsegmented upload.
- `python -m pytest tests`: 49 passed (including the fallback folder and that every upload failure is answered with its reason).

Not tested: an actual deployment on Render (its build machines, `.python-version` handling, disk mounting, request size limits), the
segmentation engine on Render, Windows, a graphics card.

## Layout

```
app.py                         Flask routes, health check
render.yaml, .python-version   Render Blueprint and Python version
anatomy/                       ingest (DICOM, NIfTI), study store, label merge, surfaces, job queue
anatomy/data/structures.json   243 structures and their names in 14 languages, with the source of every name
static/, templates/            the workstation page and its rendering bundle (three.js, vtk.js)
reference/                     panel C: labelled CT of another subject; Visible Human cryosections
tests/                         pytest suite (pip install -r requirements-dev.txt)
tools/                         build_reference.py, build_light_meshes.py, vendor/ (rebuilds static/vendor.js)
licenses/, NOTICE.md           third-party licences and data credits
```
