"""Builds reference/ from the files prepared for the approved demo: the labelled CT of another subject and the cadaver cryosections.

    python tools/build_reference.py <demo site/data folder>

The labelled CT is subject s0913 of the TotalSegmentator CT dataset v2.0.1 (CC BY 4.0) with that dataset's own reference labels. The cryosections are
the Visible Human male (U.S. National Library of Medicine). Both are another body: an independent reference, never registered to a patient.
"""
import json, struct, sys, zlib, shutil
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from anatomy.registry import registry
from anatomy.volumes import gz

def png_payload(path: Path, length: int) -> bytes:
    """The bytes carried in one of the demo's plain RGB PNG containers."""
    data = path.read_bytes(); offset = 8; parts = []; width = height = 0
    while offset + 12 <= len(data):
        size, kind = struct.unpack('>I4s', data[offset:offset + 8])
        if kind == b'IHDR': width, height = struct.unpack('>II', data[offset + 8:offset + 16])
        elif kind == b'IDAT': parts.append(data[offset + 8:offset + 8 + size])
        offset += 12 + size
    rows = zlib.decompress(b''.join(parts)); stride = width * 3
    return b''.join(rows[r * (stride + 1) + 1:(r + 1) * (stride + 1)] for r in range(height))[:length]

source, out = Path(sys.argv[1]), Path(__file__).resolve().parent.parent / 'reference'
meta = json.loads((source / 'reference.json').read_text())
n = int(np.prod(meta['dims']))
packed = np.frombuffer(png_payload(source / 'reference_ct.png', n * 2), dtype=np.uint8)
hu = (packed[n:].astype(np.int32) << 8 | packed[:n]).astype(np.int32) * meta['huStep'] + meta['huOffset']
old = np.frombuffer(png_payload(source / 'reference_labels.png', n), dtype=np.uint8)
by_key = registry()['byKey']
lut = np.zeros(256, dtype=np.uint16); kept = []
for s in meta['structures']:
    if s['key'] in by_key: lut[s['id']] = by_key[s['key']]['id']; kept.append({'id': by_key[s['key']]['id'], 'key': s['key'], 'voxels': s['voxels']})
folder = out / 'labelled-ct'; folder.mkdir(parents=True, exist_ok=True)
(folder / 'volume.i16.gz').write_bytes(gz(hu.astype('<i2').tobytes(), 9))
(folder / 'labels.u16.gz').write_bytes(gz(lut[old].astype('<u2').tobytes(), 9))
(folder / 'reference.json').write_text(json.dumps({
    'kind': 'labelled-ct', 'title': 'Labelled CT of another subject', 'modality': 'CT', 'dims': meta['dims'], 'spacing': meta['spacing'], 'structures': kept,
    'values': {'unit': 'HU', 'scale': 1.0, 'offset': 0.0, 'step': meta['huStep']},
    'origin': 'INDEPENDENT_REFERENCE', 'spatial': 'UNLINKED', 'labels': "the dataset's own reference segmentations (not this workstation's model output)",
    'source': {'dataset': 'TotalSegmentator CT dataset v2.0.1', 'subject': 's0913', 'licence': 'CC BY 4.0', 'doi': '10.5281/zenodo.10047292', 'citation': 'Wasserthal et al., Radiology: Artificial Intelligence 2023'},
}, indent=1))
cadaver = json.loads((source / 'cadaver.json').read_text())
folder = out / 'cadaver'; folder.mkdir(parents=True, exist_ok=True)
for k in range(cadaver['sheets']): shutil.copyfile(source / f'cadaver_{k:02d}.jpg', folder / f'sheet-{k:02d}.jpg')
(folder / 'reference.json').write_text(json.dumps({
    'kind': 'cadaver', 'title': 'Cadaver cryosections', 'dims': cadaver['dims'], 'spacing': cadaver['spacing'], 'cols': cadaver['cols'], 'rows': cadaver['rows'], 'sheets': cadaver['sheets'],
    'origin': 'INDEPENDENT_REFERENCE', 'spatial': 'UNLINKED', 'labels': None,
    'source': {'dataset': 'Visible Human Project, male, cryosection colour images', 'publisher': 'U.S. National Library of Medicine', 'slices': cadaver['source']['slices'],
               'processing': cadaver['source']['note'], 'credit': 'Courtesy of the U.S. National Library of Medicine. Not the most current data available from NLM.'},
}, indent=1))
print('labelled CT', meta['dims'], len(kept), 'structures; cadaver', cadaver['dims'])
