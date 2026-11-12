"""Surfaces for the 3D panel, built from the label volume: one closed surface per structure, and the body outline from the image.

Each surface is extracted from that structure's own voxels (VTK flying edges), reduced and smoothed for display. These are display surfaces: no
measurement is taken from them (volumes come from voxel counts). The pack is a small binary: a JSON header, then per mesh quantised positions and indices.
"""
from __future__ import annotations

import json
import struct

import numpy as np
from scipy import ndimage as ndi

from .registry import registry

BODY_ID = 65535


def _vtk():
    """Only the VTK filters used here. `import vtk` would also load VTK's rendering modules, which need desktop graphics libraries that
    a server (Render's included) may not have."""
    from types import SimpleNamespace

    from vtkmodules.util import numpy_support
    from vtkmodules.vtkCommonCore import VTK_FLOAT, vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkImageData, vtkPolyData
    from vtkmodules.vtkFiltersCore import vtkCleanPolyData, vtkFlyingEdges3D, vtkQuadricDecimation, vtkWindowedSincPolyDataFilter
    vtk = SimpleNamespace(VTK_FLOAT=VTK_FLOAT, vtkPoints=vtkPoints, vtkCellArray=vtkCellArray, vtkImageData=vtkImageData, vtkPolyData=vtkPolyData,
                          vtkCleanPolyData=vtkCleanPolyData, vtkFlyingEdges3D=vtkFlyingEdges3D, vtkQuadricDecimation=vtkQuadricDecimation,
                          vtkWindowedSincPolyDataFilter=vtkWindowedSincPolyDataFilter)
    return vtk, numpy_support


def _surface(sub: np.ndarray, spacing, origin, budget: float):
    vtk, ns = _vtk()
    image = vtk.vtkImageData(); image.SetDimensions(*sub.shape); image.SetSpacing(*spacing); image.SetOrigin(*origin)
    image.GetPointData().SetScalars(ns.numpy_to_vtk(np.ascontiguousarray(sub.transpose(2, 1, 0)).ravel(), deep=True, array_type=vtk.VTK_FLOAT))
    edges = vtk.vtkFlyingEdges3D(); edges.SetInputData(image); edges.SetValue(0, 0.5); edges.ComputeNormalsOff(); edges.ComputeGradientsOff(); edges.Update()
    count = edges.GetOutput().GetNumberOfPolys()
    if count < 30:
        return None
    target = int(min(max(count * budget, 2000), 45000))
    current = edges
    if count > target:
        reduce = vtk.vtkQuadricDecimation(); reduce.SetInputConnection(edges.GetOutputPort()); reduce.SetTargetReduction(1 - target / count); reduce.VolumePreservationOn(); current = reduce
    smooth = vtk.vtkWindowedSincPolyDataFilter(); smooth.SetInputConnection(current.GetOutputPort()); smooth.SetNumberOfIterations(24); smooth.SetPassBand(0.06)
    smooth.BoundarySmoothingOff(); smooth.FeatureEdgeSmoothingOff(); smooth.NonManifoldSmoothingOn(); smooth.NormalizeCoordinatesOn()
    clean = vtk.vtkCleanPolyData(); clean.SetInputConnection(smooth.GetOutputPort()); clean.Update()
    poly = clean.GetOutput()
    if poly.GetNumberOfPoints() < 4:
        return None
    points = ns.vtk_to_numpy(poly.GetPoints().GetData()).astype(np.float64)
    cells = ns.vtk_to_numpy(poly.GetPolys().GetConnectivityArray()).astype(np.uint32)
    if len(cells) % 3:
        return None
    triangles = cells.reshape(-1, 3)
    a, b, c = points[triangles[:, 0]], points[triangles[:, 1]], points[triangles[:, 2]]
    if np.einsum('ij,ij->i', a, np.cross(b, c)).sum() < 0:              # outward-facing, whatever the filter chain left
        cells = triangles[:, ::-1].copy().ravel()
    return points, cells


def build(labels: np.ndarray, values: np.ndarray, spacing, modality: str, budget: float = 0.25, on_progress=None) -> tuple[bytes, dict]:
    """(mesh pack, facts). labels and values are on the display grid, axes (x, y, z)."""
    by_id = registry()['byId']
    entries, blobs, offset, total = [], [], 0, 0
    boxes = ndi.find_objects(labels, max_label=int(labels.max()))
    jobs = [(i + 1, box) for i, box in enumerate(boxes) if box is not None and (i + 1) in by_id and not by_id[i + 1]['region']]
    jobs.append((BODY_ID, None))
    for n, (ident, box) in enumerate(jobs):
        if on_progress and n % 12 == 0:
            on_progress(n, len(jobs))
        if ident == BODY_ID:
            # CT: everything denser than -300 HU. Other modalities: everything brighter than 6 % of the scaled range. Holes are closed slice by slice.
            mask = np.pad(values > (-300 if modality == 'CT' else -1024 + 120), 3)
            mask = ndi.binary_opening(mask, iterations=2)
            sub = ndi.gaussian_filter(ndi.binary_fill_holes(mask).astype(np.float32), 1.2)[::2, ::2, ::2]
            step, low = 2, [-3, -3, -3]
        else:
            if int((labels[box] == ident).sum()) < 120:
                continue
            low = [max(s.start - 4, 0) for s in box]; high = [min(s.stop + 4, d) for s, d in zip(box, labels.shape)]
            sub = ndi.gaussian_filter((labels[low[0]:high[0], low[1]:high[1], low[2]:high[2]] == ident).astype(np.float32), 0.75)
            step = 1
        result = _surface(sub, [p * step for p in spacing], [l * p for l, p in zip(low, spacing)], budget)
        if result is None:
            continue
        points, cells = result
        lo, hi = points.min(0), points.max(0); extent = np.maximum(hi - lo, 1e-6)
        quantised = np.round((points - lo) / extent * 65535).astype('<u2')
        short = len(points) <= 65535
        index_bytes = (cells.astype('<u2') if short else cells.astype('<u4')).tobytes(); position_bytes = quantised.tobytes()
        pad_p, pad_i = (-len(position_bytes)) % 4, (-len(index_bytes)) % 4
        entries.append({'id': ident, 'verts': len(points), 'tris': len(cells) // 3, 'min': lo.tolist(), 'max': hi.tolist(), 'idx16': short, 'pos': offset, 'idx': offset + len(position_bytes) + pad_p})
        blobs += [position_bytes, b'\0' * pad_p, index_bytes, b'\0' * pad_i]
        offset += len(position_bytes) + pad_p + len(index_bytes) + pad_i; total += len(cells) // 3
    header = json.dumps({'meshes': entries}).encode()
    header += b' ' * ((-len(header)) % 4)
    return struct.pack('<I', len(header)) + header + b''.join(blobs), {'surfaces': len([e for e in entries if e['id'] != BODY_ID]), 'triangles': total}


def read_pack(pack: bytes) -> list[tuple[int, np.ndarray, np.ndarray]]:
    """[(id, points (n, 3) float64 in mm, triangle indices (m, 3))] from a pack written by build()."""
    (length,) = struct.unpack_from('<I', pack, 0)
    head = json.loads(pack[4:4 + length]); base = 4 + length; out = []
    for e in head['meshes']:
        q = np.frombuffer(pack, '<u2', e['verts'] * 3, base + e['pos']).reshape(-1, 3).astype(np.float64)
        lo, hi = np.array(e['min']), np.array(e['max'])
        points = lo + q / 65535 * (hi - lo)
        cells = np.frombuffer(pack, '<u2' if e['idx16'] else '<u4', e['tris'] * 3, base + e['idx']).astype(np.uint32).reshape(-1, 3)
        out.append((e['id'], points, cells))
    return out


def _write(items) -> tuple[bytes, int]:
    entries, blobs, offset, total = [], [], 0, 0
    for ident, points, cells in items:
        cells = np.asarray(cells, dtype=np.uint32).ravel()
        lo, hi = points.min(0), points.max(0); extent = np.maximum(hi - lo, 1e-6)
        quantised = np.round((points - lo) / extent * 65535).astype('<u2')
        short = len(points) <= 65535
        index_bytes = (cells.astype('<u2') if short else cells.astype('<u4')).tobytes(); position_bytes = quantised.tobytes()
        pad_p, pad_i = (-len(position_bytes)) % 4, (-len(index_bytes)) % 4
        entries.append({'id': ident, 'verts': len(points), 'tris': len(cells) // 3, 'min': lo.tolist(), 'max': hi.tolist(), 'idx16': short, 'pos': offset, 'idx': offset + len(position_bytes) + pad_p})
        blobs += [position_bytes, b'\0' * pad_p, index_bytes, b'\0' * pad_i]
        offset += len(position_bytes) + pad_p + len(index_bytes) + pad_i; total += len(cells) // 3
    header = json.dumps({'meshes': entries}).encode()
    header += b' ' * ((-len(header)) % 4)
    return struct.pack('<I', len(header)) + header + b''.join(blobs), total


def reduce_pack(pack: bytes, fraction: float = 0.12, floor: int = 120, cap: int = 3500) -> tuple[bytes, dict]:
    """The light pack drawn while a 3D view moves: every surface of the full pack, same ids, about `fraction` of its triangles
    (at least `floor`, at most `cap`). A surface that cannot be reduced is copied unchanged, so both packs always hold the same structures."""
    vtk, ns = _vtk()
    items = []
    for ident, points, cells in read_pack(pack):
        target = int(min(max(len(cells) * fraction, floor), cap))
        if len(cells) <= target * 1.15:
            items.append((ident, points, cells)); continue
        poly = vtk.vtkPolyData(); vp = vtk.vtkPoints(); vp.SetData(ns.numpy_to_vtk(np.ascontiguousarray(points), deep=True)); poly.SetPoints(vp)
        ca = vtk.vtkCellArray(); ca.SetData(3, ns.numpy_to_vtkIdTypeArray(np.ascontiguousarray(cells.ravel().astype(np.int64)), deep=True)); poly.SetPolys(ca)
        reduce = vtk.vtkQuadricDecimation(); reduce.SetInputData(poly); reduce.SetTargetReduction(1 - target / len(cells)); reduce.VolumePreservationOn()
        clean = vtk.vtkCleanPolyData(); clean.SetInputConnection(reduce.GetOutputPort()); clean.Update()
        out = clean.GetOutput()
        conn = ns.vtk_to_numpy(out.GetPolys().GetConnectivityArray()) if out.GetNumberOfPolys() else np.zeros(0)
        if out.GetNumberOfPoints() < 4 or len(conn) % 3 or len(conn) < 12:
            items.append((ident, points, cells)); continue
        items.append((ident, ns.vtk_to_numpy(out.GetPoints().GetData()).astype(np.float64), conn.astype(np.uint32).reshape(-1, 3)))
    data, total = _write(items)
    return data, {'triangles': total, 'bytes': len(data)}
