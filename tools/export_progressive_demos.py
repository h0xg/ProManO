#!/usr/bin/env python3
"""Replay actual DA3 depth contributions in source keyframe order.

Uses the recorded final ProManO correction, not an online timing simulation.
The projection/correction formulas and owner-submap policy reproduce the
research exporter's frames(xx). The original voxel-fused PLY is not reordered.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import cv2
import numpy as np
from scipy.spatial.transform import Rotation

WORLD_TO_DISPLAY = np.array([[1., 0., 0.], [0., 0., 1.], [0., -1., 0.]])
PACKED = np.dtype([("p", "<i2", (3,)), ("c", "u1", (3,))])


def land_mask(camera, shape, sky):
    if sky == "none":
        return np.ones(shape, bool)
    image = cv2.imread(camera["sky_mask_path"], cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise IOError("Missing recorded sky mask")
    small = cv2.resize((image > 127).astype(np.float32), (shape[1], shape[0]),
                       interpolation=cv2.INTER_AREA) > 0
    return ~(cv2.dilate(small.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)


def export(config, root: Path, scratch: Path):
    started = time.monotonic()
    ident = config["id"]
    directory = root / "assets/demos" / ident
    scene = json.loads((directory / "scene.json").read_text())
    summary_path = Path(config["cloud"]).parent / "summary.json"
    summary = json.loads(summary_path.read_text())
    if Path(summary["args"]["cameras_json"]) != Path(config["cameras"]):
        raise ValueError("Camera metadata differs from the reconstruction run")
    cameras = json.loads(Path(config["cameras"]).read_text())["cameras"]
    da3_directory = Path(summary["args"]["da3_dir"])
    manifest = json.loads((da3_directory / "manifest.json").read_text())
    state = np.array(summary["state_final_np16"], dtype=float)
    pivots = np.array(summary["pivots"], dtype=float)
    rotations = Rotation.from_rotvec(state[:, 7:10]).as_matrix()
    scales = np.exp(state[:, 10])
    provenance = json.loads((scratch / f"{ident}-provenance.json").read_text())
    center = np.array(provenance["centerMetres"])
    metres = provenance["metresPerUnit"]
    owner = {}
    for chunk in manifest["chunks"]:
        regular = set(chunk.get("regular_keyframes", chunk["global_keyframe_indices"]))
        for local_index, global_index in enumerate(chunk["global_keyframe_indices"]):
            if global_index in regular:
                owner.setdefault(global_index, (chunk["chunk_id"], local_index))
    groups = {}
    for g, (c, li) in sorted(owner.items()):
        groups.setdefault(c, []).append((g, li))
    per_frame = max(1, 180_000 // len(owner))
    parts = {}
    records = []
    minimum, maximum = float(summary["args"]["min_depth_m"]), float(summary["args"]["max_cloud_depth_m"])
    confidence_threshold = float(summary["args"]["min_conf_percentile"])
    for chunk_id, members in sorted(groups.items()):
        print(f"{ident}: depth submap {chunk_id + 1}/{len(groups)}", flush=True)
        with np.load(da3_directory / f"chunk_{chunk_id:04d}.npz") as archive:
            depths = archive["depth"].astype(np.float32)
            gids = archive["global_keyframe_indices"].tolist()
            confidences = archive["confidence"] if confidence_threshold > 0 else None
        expected = manifest["chunks"][chunk_id]["global_keyframe_indices"]
        if gids != expected:
            raise ValueError("Submap's keyframe membership differs from manifest")
        p, pivot, sim_rotation = state[chunk_id], pivots[chunk_id], rotations[chunk_id]
        for global_index, local_index in members:
            camera = cameras[global_index]
            dm = depths[local_index]
            height, width = dm.shape
            ok = land_mask(camera, dm.shape, summary["args"]["sky"]) & np.isfinite(dm) & (dm > 1e-3)
            if confidence_threshold > 0:
                confidence = confidences[local_index]
                ok &= confidence >= np.nanpercentile(confidence, confidence_threshold)
            yy, xx = np.nonzero(ok)
            image_width, image_height = camera["image_width"], camera["image_height"]
            intrinsic = np.asarray(camera["K"], dtype=float)
            u = (xx + .5) * image_width / width - .5
            v = (yy + .5) * image_height / height - .5
            rx, ry = (u - intrinsic[0, 2]) / intrinsic[0, 0], (v - intrinsic[1, 2]) / intrinsic[1, 1]
            # Eq. 23 / original pre(x,D): affine inverse-depth correction.
            rho = np.maximum(p[0] / dm[yy, xx] + p[1] * rx + p[2] * ry + p[3], 1e-3)
            corrected_depth = 1 / rho
            keep = (corrected_depth > minimum) & (corrected_depth < maximum)
            rx, ry, corrected_depth = rx[keep], ry[keep], corrected_depth[keep]
            u, v = u[keep], v[keep]
            pose = np.asarray(camera["T_w_c"], dtype=float)
            local = np.column_stack((rx * corrected_depth, ry * corrected_depth, corrected_depth))
            world = local @ pose[:3, :3].T + pose[:3, 3]
            world = scales[chunk_id] * ((world - pivot) @ sim_rotation.T) + pivot + p[4:7]
            display = (world @ WORLD_TO_DISPLAY.T - center) / metres
            # Same fixed display bounds as the previously verified preview.
            keep = np.isfinite(display).all(axis=1) & (np.abs(display) <= 1).all(axis=1)
            display, u, v = display[keep], u[keep], v[keep]
            rng = np.random.default_rng(7025 + global_index)
            chosen = np.sort(rng.choice(len(display), min(per_frame, len(display)), replace=False))
            image = cv2.imread(camera["image_path"], cv2.IMREAD_COLOR)
            if image is None:
                raise IOError("Missing source RGB frame")
            colors = image[np.clip(np.rint(v[chosen]).astype(int), 0, image_height - 1),
                           np.clip(np.rint(u[chosen]).astype(int), 0, image_width - 1)][:, ::-1]
            points = np.empty(len(chosen), dtype=PACKED)
            points["p"] = np.rint(display[chosen] * 32767).astype("<i2")
            points["c"] = colors
            parts[global_index] = points
            records.append(dict(sourceKeyframe=global_index, sourceTime=int(camera["timestamp_ns"]) / 1e9,
                                submap=chunk_id, count=len(points)))
        del depths, confidences
    records.sort(key=lambda entry: entry["sourceKeyframe"])
    offset = 0
    for record in records:
        record["start"] = offset
        offset += record["count"]
        record["end"] = offset
    cloud = np.concatenate([parts[entry["sourceKeyframe"]] for entry in records])
    temporary = directory / "cloud-progressive.tmp"
    cloud.tofile(temporary)
    temporary.replace(directory / "cloud.bin")
    timestamps = np.array([int(c["timestamp_ns"]) / 1e9 for c in cameras])
    for index, frame in enumerate(scene["frames"]):
        g = int(np.argmin(np.abs(timestamps - frame["sourceTime"])))
        frame["sourceKeyframe"] = g
        frame["pointCount"] = 0 if index == 0 else sum(r["count"] for r in records if r["sourceKeyframe"] <= g)
        frame["submapCount"] = 0 if index == 0 else len({r["submap"] for r in records if r["sourceKeyframe"] <= g})
    scene.update(count=len(cloud), geometry="per-keyframe-depth-contributions",
                 growth="source-keyframe-order", calibration="final-promano-offline",
                 sourceKeyframeCount=len(records), submapCount=len(groups),
                 contributions=records)
    (directory / "scene.json").write_text(json.dumps(scene, separators=(",", ":")) + "\n")
    provenance.update(progressiveGeometry="Actual per-keyframe DA3 depth, owner-submap policy and final ProManO correction",
                      summary=str(summary_path), submapDirectory=str(da3_directory),
                      sourceKeyframes=len(records), displayVertices=len(cloud),
                      pointsPerKeyframeBudget=per_frame,
                      note="Replays final-corrected depth contributions in source order; not online inference or wall-clock timing.")
    (scratch / f"{ident}-progressive-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"{ident}: {len(records)} real contributions, {len(cloud)} points, {time.monotonic()-started:.1f}s", flush=True)
    return scene


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    scenes = []
    for config in json.loads(args.config.read_text()):
        scenes.append(export(config, args.root, args.scratch))
        path = args.root / "assets/demos/scenes.json"
        path.write_text(json.dumps(scenes, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
