"""One canonical grid for everything the viewer shows.

Array axes are (x, y, z) with x increasing to the patient's left, y to posterior, z to superior: DICOM's patient axes (LPS). A NIfTI or DICOM volume
is brought to that order by permuting and flipping whole axes only. Nothing is resampled or rotated, so a voxel shown is a voxel acquired. An oblique
acquisition therefore stays on its own grid; how far its axes are from the patient axes is measured and reported, and the viewer says so.
"""
from __future__ import annotations

import gzip
import io

import nibabel as nib
import numpy as np

FLIP_XY = np.diag([-1.0, -1.0, 1.0, 1.0])          # RAS <-> LPS


def canonical(image: nib.spatialimages.SpatialImage, dtype=None) -> tuple[np.ndarray, np.ndarray]:
    """(array in LPS index order, 4x4 index -> LPS millimetres). 4-D input is refused by the caller, not squeezed here."""
    ras = nib.as_closest_canonical(image)
    data = np.asanyarray(ras.dataobj)
    if dtype is not None:
        data = data.astype(dtype)
    data = np.ascontiguousarray(data[::-1, ::-1, :])
    shape = np.array(ras.shape[:3])
    flip = np.eye(4); flip[0, 0] = flip[1, 1] = -1; flip[0, 3] = shape[0] - 1; flip[1, 3] = shape[1] - 1
    return data, FLIP_XY @ ras.affine @ flip


def spacing_of(affine: np.ndarray) -> tuple[float, float, float]:
    return tuple(float(np.linalg.norm(affine[:3, k])) for k in range(3))


def obliquity_degrees(affine: np.ndarray) -> float:
    """The largest angle between a grid axis and the patient axis it is shown as."""
    worst = 0.0
    for k in range(3):
        direction = affine[:3, k] / np.linalg.norm(affine[:3, k])
        worst = max(worst, float(np.degrees(np.arccos(np.clip(abs(direction[k]), 0.0, 1.0)))))
    return worst


def display_strides(shape, spacing, max_voxels: int) -> tuple[int, int, int]:
    """Whole-number strides that bring a volume under the display budget, coarsening the finest axis first."""
    stride = [1, 1, 1]
    while np.prod([int(np.ceil(n / s)) for n, s in zip(shape, stride)]) > max_voxels:
        k = int(np.argmin([sp * st for sp, st in zip(spacing, stride)]))
        stride[k] += 1
    return tuple(stride)


def block_mean(data: np.ndarray, stride) -> np.ndarray:
    """The image on the display grid: the mean of each block, so nothing aliases. Blocks at the far edge are cropped to whole blocks."""
    if tuple(stride) == (1, 1, 1):
        return data
    sx, sy, sz = stride
    nx, ny, nz = (data.shape[0] // sx, data.shape[1] // sy, data.shape[2] // sz)
    trimmed = data[:nx * sx, :ny * sy, :nz * sz].astype(np.float32)
    return trimmed.reshape(nx, sx, ny, sy, nz, sz).mean(axis=(1, 3, 5))


def block_pick(labels: np.ndarray, stride) -> np.ndarray:
    """Labels on the display grid: the label at each block's centre. Label values are never averaged."""
    if tuple(stride) == (1, 1, 1):
        return labels
    sx, sy, sz = stride
    nx, ny, nz = (labels.shape[0] // sx, labels.shape[1] // sy, labels.shape[2] // sz)
    return np.ascontiguousarray(labels[sx // 2:nx * sx:sx, sy // 2:ny * sy:sy, sz // 2:nz * sz:sz])


def display_values(data: np.ndarray, modality: str) -> tuple[np.ndarray, dict]:
    """The image as the viewer holds it: int16 in [-1024, 3071].

    CT keeps Hounsfield units. Any other modality has no unit, so its values are scaled linearly (0 .. the 99.5th percentile -> 0 .. 2000) and the
    scale is returned, so the status line can show the stored value again.
    """
    if modality == 'CT':
        return np.clip(np.rint(data), -1024, 3071).astype(np.int16), {'unit': 'HU', 'scale': 1.0, 'offset': 0.0, 'window': [40, 400]}
    finite = data[np.isfinite(data)]
    top = float(np.percentile(finite, 99.5)) if finite.size else 1.0
    low = float(min(0.0, finite.min())) if finite.size else 0.0
    scale = 2000.0 / max(top - low, 1e-6)
    scaled = np.clip(np.rint((np.nan_to_num(data) - low) * scale), 0, 4095).astype(np.int16) - 1024
    return scaled, {'unit': None, 'scale': scale, 'offset': low, 'window': [-24, 2000]}


def to_bytes(array: np.ndarray, dtype) -> bytes:
    """x fastest, then y, then z, little-endian: the order the viewer indexes in."""
    return np.ascontiguousarray(array.transpose(2, 1, 0)).astype(dtype, copy=False).astype(np.dtype(dtype).newbyteorder('<'), copy=False).tobytes()


def gz(raw: bytes, level: int = 6) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', compresslevel=level, mtime=0) as handle:
        handle.write(raw)
    return buffer.getvalue()
