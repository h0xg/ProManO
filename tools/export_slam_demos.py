#!/usr/bin/env python3
"""Export memory-bounded offline SLAM replays from the unmodified research runs.

Run under systemd-run --user with MemoryMax=2G CPUQuota=100%. No inference is
performed. A final, sampled reconstruction is the static backdrop; each image
and camera pose comes from the same timestamped keyframe record.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import numpy as np
from PIL import Image

# VIO's gravity-aligned Z-up world -> right-handed Y-up display world.
WORLD_TO_DISPLAY = np.array([[1., 0., 0.], [0., 0., 1.], [0., -1., 0.]])
TYPES = {"double": "<f8", "float": "<f4", "uchar": "u1", "uint8": "u1"}


def sample_cloud(path: Path, requested=180_000):
    """Uniform stratified sample, using only sequential 8-MiB reads."""
    with path.open("rb") as handle:
        if handle.readline().strip() != b"ply":
            raise ValueError("Not PLY")
        count = None
        binary = False
        properties = []
        in_vertices = False
        for line in handle:
            text = line.decode("ascii").strip().split()
            if text[:2] == ["format", "binary_little_endian"]:
                binary = True
            elif text[:2] == ["element", "vertex"]:
                count, in_vertices = int(text[2]), True
            elif text and text[0] == "element":
                in_vertices = False
            elif text and text[0] == "property" and in_vertices:
                properties.append((text[2], TYPES[text[1]]))
            elif text == ["end_header"]:
                break
        if not count or not binary:
            raise ValueError("Unsupported PLY header")
        dtype = np.dtype(properties)
        step = max(1, (8 * 1024 * 1024) // dtype.itemsize)
        # Distinct linear indices preserve coverage and are deterministic.
        selected = np.linspace(0, count - 1, min(requested, count), dtype=np.int64)
        parts = []
        for offset in range(0, count, step):
            length = min(step, count - offset)
            block = np.fromfile(handle, dtype=dtype, count=length)
            if len(block) != length:
                raise IOError("Truncated vertex stream")
            lo, hi = np.searchsorted(selected, [offset, offset + length])
            if hi > lo:
                parts.append(block[selected[lo:hi] - offset].copy())
        records = np.concatenate(parts)
    xyz = np.column_stack([records[n] for n in ("x", "y", "z")])
    rgb = np.column_stack([records[n] for n in ("red", "green", "blue")])
    good = np.isfinite(xyz).all(axis=1)
    return xyz[good], rgb[good], count


def round_vector(vector):
    return np.round(vector, 8).tolist()


def export(config, destination: Path, scratch: Path):
    started = time.time()
    ident = config["id"]
    out = destination / ident
    tmp = scratch / ident
    out.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)
    summary = json.loads((config["cloud"].parent / "summary.json").read_text())
    if Path(summary["args"]["cameras_json"]) != config["cameras"]:
        raise ValueError("Camera metadata does not match the reconstruction run")
    cameras = json.loads(config["cameras"].read_text())["cameras"]
    cameras.sort(key=lambda c: c["timestamp_ns"])
    stamps = np.array([c["timestamp_ns"] for c in cameras], dtype=np.int64)
    positions = np.array([np.array(c["T_w_c"])[:3, 3] for c in cameras]) @ WORLD_TO_DISPLAY.T
    print(f"{ident}: sequential cloud read starting", flush=True)
    xyz, rgb, original_count = sample_cloud(config["cloud"])
    xyz = xyz @ WORLD_TO_DISPLAY.T
    # Remove only extreme display outliers. The originals remain unmodified.
    low, high = np.quantile(xyz, [.003, .997], axis=0)
    keep = ((xyz >= low) & (xyz <= high)).all(axis=1)
    xyz, rgb = xyz[keep], rgb[keep]
    selected = np.linspace(0, len(xyz) - 1, min(120_000, len(xyz)), dtype=np.int64)
    xyz, rgb = xyz[selected], rgb[selected]
    both = np.concatenate((xyz, positions))
    low, high = both.min(axis=0), both.max(axis=0)
    center = (low + high) / 2
    metres = float(np.max(high - low) / 2)
    normalized = (xyz - center) / metres
    packed = np.empty(len(xyz), dtype=np.dtype([("p", "<i2", (3,)), ("c", "u1", (3,))]))
    packed["p"] = np.rint(normalized * 32767).astype("<i2")
    packed["c"] = rgb
    packed.tofile(out / "cloud.bin")
    first, last = int(stamps[0]), int(stamps[-1])
    # Sampling endpoints map to the first and last displayed video frames.
    queries = np.linspace(first, last, 160)
    indices = []
    for query in queries:
        idx = int(np.searchsorted(stamps, query))
        idx = min(idx, len(stamps) - 1)
        if idx and abs(int(stamps[idx - 1]) - query) <= abs(int(stamps[idx]) - query):
            idx -= 1
        indices.append(idx)
    frames = []
    width = 480
    with Image.open(cameras[0]["image_path"]) as image:
        height = int(round(image.height * width / image.width / 2) * 2)
    for number, index in enumerate(indices):
        camera = cameras[index]
        pose = np.asarray(camera["T_w_c"], dtype=float)
        rotation = WORLD_TO_DISPLAY @ pose[:3, :3]
        frames.append(dict(
            time=number / 8,
            sourceTime=int(camera["timestamp_ns"]) / 1e9,
            sourceElapsed=(int(camera["timestamp_ns"]) - first) / 1e9,
            position=round_vector((positions[index] - center) / metres),
            right=round_vector(rotation[:, 0]),
            up=round_vector(-rotation[:, 1]),
            forward=round_vector(rotation[:, 2]),
        ))
        with Image.open(camera["image_path"]) as image:
            image = image.convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
            image.save(tmp / f"{number:04d}.jpg", quality=86, optimize=False)
            if number == 0:
                image.save(out / "poster.jpg", quality=92)
    print(f"{ident}: encoding {len(frames)} synchronized frames", flush=True)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-threads", "1", "-framerate", "8", "-i", str(tmp / "%04d.jpg"),
               "-c:v", "libx264", "-threads", "1", "-preset", "fast", "-crf", "24",
               "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(out / "input.mp4")]
    subprocess.run(command, check=True)
    prefix = f"assets/demos/{ident}"
    item = dict(id=ident, title=config["title"], dataset=config["dataset"],
                sequence=config["sequence"], cloud=f"{prefix}/cloud.bin", count=len(xyz),
                metresPerUnit=round(metres, 8), duration=20,
                sourceDuration=round((last - first) / 1e9, 6),
                inputVideo=f"{prefix}/input.mp4", poster=f"{prefix}/poster.jpg",
                playback="offline-keyframe-replay", geometry="final-reconstruction",
                frames=frames)
    provenance = dict(id=ident, cloud=str(config["cloud"]), cameras=str(config["cameras"]),
                      originalVertices=original_count, displayVertices=len(xyz),
                      worldToDisplay=WORLD_TO_DISPLAY.tolist(), centerMetres=center.tolist(),
                      metresPerUnit=metres, selectedCameraIndices=indices,
                      sourceCameraCount=len(cameras),
                      extremeOutlierQuantiles=[.003, .997],
                      explanation="Final-map backdrop and synchronized recorded camera keyframes. No online SLAM or inference.")
    (scratch / f"{ident}-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    (out / "scene.json").write_text(json.dumps(item, separators=(",", ":")) + "\n")
    print(f"{ident}: done in {time.time() - started:.1f}s, {len(xyz)} points", flush=True)
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True,
                        help="JSON array: id,title,dataset,sequence,cloud,cameras paths")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    args.destination.mkdir(parents=True, exist_ok=True)
    manifest = []
    for config in json.loads(args.config.read_text()):
        config["cloud"] = Path(config["cloud"])
        config["cameras"] = Path(config["cameras"])
        if args.only and config["id"] not in args.only:
            continue
        manifest.append(export(config, args.destination, args.scratch))
        (args.destination / "scenes.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
