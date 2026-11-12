"""Adds the light surface pack (meshes_lo.bin.gz) to studies segmented before it existed, from their own full pack:
    python tools/build_light_meshes.py [study folder ...]     (default: every uploaded study that has surfaces)"""
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from anatomy import config, meshes          # noqa: E402
from anatomy.studies import write_json       # noqa: E402

folders = [Path(a) for a in sys.argv[1:]] or sorted(p for p in (config.STUDIES_DIR.iterdir() if config.STUDIES_DIR.is_dir() else []) if (p / "seg" / "meshes.bin.gz").is_file())
for folder in folders:
    pack = gzip.decompress((folder / 'seg' / 'meshes.bin.gz').read_bytes())
    low, facts = meshes.reduce_pack(pack)
    (folder / 'seg' / 'meshes_lo.bin.gz').write_bytes(gzip.compress(low, 9))
    seg = json.loads((folder / 'seg' / 'seg.json').read_text())
    seg['meshes']['light'] = facts
    write_json(folder / 'seg' / 'seg.json', seg)
    full = {i for i, _, _ in meshes.read_pack(pack)}; light = {i for i, _, _ in meshes.read_pack(low)}
    assert full == light, 'the light pack must hold the same structures'
    print(folder.name, f"full {seg['meshes']['triangles']:,} triangles -> light {facts['triangles']:,}; {len(light)} surfaces;",
          f"{(folder / 'seg' / 'meshes_lo.bin.gz').stat().st_size / 1e6:.2f} MB on disk")
