"""Turns uploaded files into volumes, or says exactly why it cannot.

Accepted: classic single-frame DICOM series (one volume per series) and NIfTI volumes (.nii, .nii.gz). A series is read from its own geometry
(Image Position / Orientation Patient, Pixel Spacing): file names, instance numbers and Slice Thickness are never used to place a slice.
Refused, with the reason shown to the user: enhanced multi-frame objects, a series holding more than one volume, mixed orientations, sheared or
unevenly spaced stacks, and anything with no patient geometry. Nothing is guessed to make a refused series load.
"""
from __future__ import annotations

import os
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import nibabel as nib
import numpy as np

ENHANCED = {'1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT', '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR', '1.2.840.10008.5.1.4.1.1.2.2': 'Legacy converted enhanced CT',
            '1.2.840.10008.5.1.4.1.1.4.4': 'Legacy converted enhanced MR'}
NIFTI_SUFFIXES = ('.nii', '.nii.gz')


@dataclass
class Candidate:
    """One volume found in an upload, ready to be stored, or one refusal."""
    title: str
    modality: str | None = None
    image: nib.Nifti1Image | None = None
    refused: str | None = None
    facts: dict = field(default_factory=dict)


def expand(folder: Path, limit_bytes: int) -> None:
    """Unpacks every zip under the folder in place. Entries that would land outside it are skipped, and the unpacked size is capped."""
    total = 0
    for path in list(folder.rglob('*.zip')):
        target = path.with_suffix('')
        target.mkdir(exist_ok=True)
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                destination = (target / info.filename).resolve()
                if not str(destination).startswith(str(target.resolve()) + os.sep):
                    continue
                total += info.file_size
                if total > limit_bytes:
                    raise ValueError('The archive unpacks to more than the upload limit.')
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, open(destination, 'wb') as out:
                    while chunk := source.read(1 << 20):
                        out.write(chunk)
        path.unlink()


def _nifti(path: Path) -> Candidate:
    title = re.sub(r'^\d{6}_', '', path.name)          # the upload's own file name, without the inbox numbering
    try:
        image = nib.load(str(path))
        if len(image.shape) != 3 and not (len(image.shape) == 4 and image.shape[3] == 1):
            return Candidate(title, refused=f'This file holds {len(image.shape)} dimensions ({" x ".join(map(str, image.shape))}). Only a single 3-D volume is read.')
        data = np.asanyarray(image.dataobj).reshape(image.shape[:3])
        if min(data.shape) < 2:
            return Candidate(title, refused='This file holds a single image, not a volume.')
        if abs(np.linalg.det(image.affine[:3, :3])) < 1e-9:
            return Candidate(title, refused='This file states no usable voxel-to-patient geometry.')
        clean = nib.Nifti1Image(np.asarray(data), image.affine)
        return Candidate(title, image=clean, facts={'format': 'NIfTI', 'file': title, 'note': 'A NIfTI file carries no modality, patient or study identity.'})
    except Exception as error:          # an unreadable file is reported, not skipped silently
        return Candidate(title, refused=f'Not readable as NIfTI: {error}')


def _series(datasets: list, uid: str) -> Candidate:
    import pydicom  # noqa: F401  (kept local: a NIfTI-only install still starts)
    first = datasets[0]
    modality = str(getattr(first, 'Modality', '') or '').upper() or None
    description = str(getattr(first, 'SeriesDescription', '') or getattr(first, 'StudyDescription', '') or '').strip()
    title = f'{modality or "Series"} · {description or f"{len(datasets)} images"}'
    # No patient name, patient ID, date or UID is kept: the workstation stores the image and its geometry, not who it is of.
    facts = {'format': 'DICOM', 'images': len(datasets), 'seriesDescription': description, 'studyDescription': str(getattr(first, 'StudyDescription', '') or ''),
             'manufacturer': str(getattr(first, 'Manufacturer', '') or '')}
    sop_class = str(getattr(first, 'SOPClassUID', ''))
    if sop_class in ENHANCED:
        return Candidate(title, modality, refused=f'{ENHANCED[sop_class]} (multi-frame) objects are not read by this build; they need per-frame geometry.', facts=facts)
    if len(datasets) < 3:
        return Candidate(title, modality, refused=f'{len(datasets)} image(s): not a volume. Projection images and single slices have no cross-sectional anatomy to show here.', facts=facts)
    if any(not hasattr(ds, 'ImagePositionPatient') or not hasattr(ds, 'ImageOrientationPatient') or not hasattr(ds, 'PixelSpacing') for ds in datasets):
        return Candidate(title, modality, refused='The series states no patient geometry (position, orientation or pixel spacing). No geometry is invented for it.', facts=facts)
    orientation = np.array(first.ImageOrientationPatient, dtype=float)
    for ds in datasets:
        if not np.allclose(np.array(ds.ImageOrientationPatient, dtype=float), orientation, atol=1e-4):
            return Candidate(title, modality, refused='The series mixes image orientations (a localizer or several stacks). It is not one volume.', facts=facts)
        if (ds.Rows, ds.Columns) != (first.Rows, first.Columns) or not np.allclose(np.array(ds.PixelSpacing, dtype=float), np.array(first.PixelSpacing, dtype=float), atol=1e-6):
            return Candidate(title, modality, refused='Images of the series differ in size or pixel spacing.', facts=facts)
    row_dir, col_dir = orientation[:3], orientation[3:]            # direction of increasing column index, of increasing row index
    normal = np.cross(row_dir, col_dir)
    ordered = sorted(datasets, key=lambda ds: float(np.dot(normal, np.array(ds.ImagePositionPatient, dtype=float))))
    positions = np.array([ds.ImagePositionPatient for ds in ordered], dtype=float)
    steps = np.diff(positions, axis=0)
    lengths = np.linalg.norm(steps, axis=1)
    if np.any(lengths < 1e-4):
        return Candidate(title, modality, refused='Two images share one position: the series holds more than one volume (several echoes, b-values, phases or time points) or a repeated slice. '
                                                   'Time-resolved and multi-volume series are not read by this build.', facts=facts)
    step = steps.mean(axis=0)
    if np.max(np.abs(lengths - lengths.mean())) > max(0.01, 0.01 * lengths.mean()):
        return Candidate(title, modality, refused=f'Slices are unevenly spaced ({lengths.min():.3f} to {lengths.max():.3f} mm): a slice is missing or the spacing varies. No slice is interpolated in.', facts=facts)
    if np.linalg.norm(np.cross(step / np.linalg.norm(step), normal)) > 0.01:
        return Candidate(title, modality, refused='The stack is sheared (on CT, a tilted gantry): slice positions do not advance along the image normal.', facts=facts)
    try:
        frames = []
        for ds in ordered:
            pixels = ds.pixel_array.astype(np.float32)
            slope, intercept = float(getattr(ds, 'RescaleSlope', 1) or 1), float(getattr(ds, 'RescaleIntercept', 0) or 0)
            frames.append(pixels * slope + intercept)
    except Exception as error:
        return Candidate(title, modality, refused=f'The pixel data could not be decoded ({error}). Compressed series need the python-gdcm package listed in requirements.txt.', facts=facts)
    if modality == 'CT' and str(getattr(first, 'RescaleType', 'HU') or 'HU').strip().upper() not in ('HU', ''):
        return Candidate(title, modality, refused=f'Rescale Type {first.RescaleType} is not Hounsfield units.', facts=facts)
    volume = np.stack(frames, axis=-1).transpose(1, 0, 2)          # (column, row, slice)
    spacing_row, spacing_col = float(first.PixelSpacing[0]), float(first.PixelSpacing[1])
    lps = np.eye(4)
    lps[:3, 0] = row_dir * spacing_col; lps[:3, 1] = col_dir * spacing_row; lps[:3, 2] = step; lps[:3, 3] = positions[0]
    ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ lps
    data = np.rint(volume).astype(np.int16) if modality == 'CT' else volume
    facts['sliceSpacing'] = round(float(lengths.mean()), 4)
    return Candidate(title, modality, image=nib.Nifti1Image(data, ras), facts=facts)


def find_volumes(folder: Path) -> list[Candidate]:
    """Every volume, and every refusal, in a folder of uploaded files."""
    found: list[Candidate] = []
    by_series: dict[str, list] = {}
    unreadable = 0
    for path in sorted(p for p in folder.rglob('*') if p.is_file()):
        if path.name.lower().endswith(NIFTI_SUFFIXES):
            found.append(_nifti(path))
            continue
        try:
            import pydicom
            ds = pydicom.dcmread(str(path), force=False)
        except Exception:
            unreadable += 1
            continue
        if not hasattr(ds, 'SeriesInstanceUID') or 'PixelData' not in ds:
            continue                                                  # DICOMDIR, reports, presentation states: not images
        by_series.setdefault(str(ds.SeriesInstanceUID), []).append(ds)
    for uid, datasets in by_series.items():
        found.append(_series(datasets, uid))
    if not found:
        found.append(Candidate('Upload', refused=f'No DICOM image series and no NIfTI volume was found ({unreadable} file(s) were not DICOM).'))
    return found
