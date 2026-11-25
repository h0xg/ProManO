#!/usr/bin/env python3
"""Export recorded SI IMU measurements onto a timestamped demo timeline.

Input columns: integer nanosecond timestamp, gyro XYZ (rad/s), accel XYZ
(m/s²), as in the EuRoC/V98 imu0.csv exports. Measurements are never
interpolated, filtered, converted, or synthesized. Only their replay times
are mapped between the source timestamps of consecutive video keyframes.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import hashlib
import json
import math
import statistics
from pathlib import Path


def export(args: argparse.Namespace) -> dict:
    scene = json.loads(args.scene.read_text())
    frames = scene['frames']
    stamps = [round(frame['sourceTime'] * 1_000_000_000) for frame in frames]
    replay_times = [frame['time'] for frame in frames]
    if any(a > b for a, b in zip(stamps, stamps[1:])):
        raise ValueError('Camera source timestamps must not decrease')
    if any(a >= b for a, b in zip(replay_times, replay_times[1:])):
        raise ValueError('Camera replay timestamps must strictly increase')
    first, last = stamps[0], stamps[-1]
    rows = []
    all_count = 0
    previous = None
    intervals = []
    digest = hashlib.sha256()
    # Padding retains the nearest real sensor reading at both endpoints.
    with args.imu_csv.open('rb') as stream:
        for raw in stream:
            digest.update(raw)
            text = raw.decode('utf-8-sig').strip()
            if not text or text.startswith('#'):
                continue
            cells = next(csv.reader([text]))
            stamp = int(cells[0])
            values = tuple(float(value) for value in cells[1:7])
            if len(values) != 6 or not all(math.isfinite(value) for value in values):
                raise ValueError('IMU rows must contain six finite measurements')
            if previous is not None:
                if stamp <= previous:
                    raise ValueError('IMU timestamps must strictly increase')
                intervals.append(stamp - previous)
            previous = stamp
            all_count += 1
            if first - 100_000_000 <= stamp <= last + 100_000_000:
                rows.append((stamp, values))
    if not rows or rows[0][0] > first or rows[-1][0] < last:
        raise ValueError('IMU recording does not cover the complete camera interval')
    source_stamps = [row[0] for row in rows]

    def nearest(stamp: int):
        index = min(bisect.bisect_left(source_stamps, stamp), len(rows) - 1)
        if index and abs(source_stamps[index - 1] - stamp) <= abs(source_stamps[index] - stamp):
            index -= 1
        return rows[index]

    candidates = []
    # Positive source intervals map continuously between the recorded video
    # anchors. Repeated camera frames leave a hold interval in replay time.
    for stamp, values in rows:
        if not first <= stamp <= last:
            continue
        index = min(bisect.bisect_right(stamps, stamp) - 1, len(stamps) - 1)
        if index == len(stamps) - 1:
            replay = replay_times[-1]
        else:
            fraction = (stamp - stamps[index]) / (stamps[index + 1] - stamps[index])
            replay = replay_times[index] + fraction * (replay_times[index + 1] - replay_times[index])
        candidates.append((replay, stamp, values, False))
    max_anchor_error = 0
    for replay, stamp in zip(replay_times, stamps):
        sensor_stamp, values = nearest(stamp)
        max_anchor_error = max(max_anchor_error, abs(sensor_stamp - stamp))
        candidates.append((replay, sensor_stamp, values, True))
    sensor_stamp, values = nearest(last)
    candidates.append((scene['duration'], sensor_stamp, values, True))
    candidates.sort(key=lambda sample: (sample[0], not sample[3]))

    # Every retained extremum is an entire real six-axis sensor sample.
    # Include every video-frame anchor, then retain each channel's min and
    # max per fixed replay-time bin to preserve short measured peaks.
    bins = max(1, (args.max_samples - len(frames) - 2) // 12)
    selected = {index for index, row in enumerate(candidates) if row[3]}
    buckets = [[] for _ in range(bins)]
    for index, row in enumerate(candidates):
        bucket = min(bins - 1, int(row[0] / scene['duration'] * bins))
        buckets[bucket].append(index)
    for bucket in buckets:
        if not bucket:
            continue
        for axis in range(6):
            selected.add(min(bucket, key=lambda index: candidates[index][2][axis]))
            selected.add(max(bucket, key=lambda index: candidates[index][2][axis]))
    samples = []
    for index in sorted(selected):
        replay, stamp, values, _ = candidates[index]
        sample = {'time': round(replay, 7), 'sourceTime': stamp / 1e9,
                  'accel': [round(value, 7) for value in values[3:]],
                  'gyro': [round(value, 7) for value in values[:3]]}
        if samples and sample['time'] == samples[-1]['time']:
            # Anchors sort first at ties, so keep their actual reading.
            continue
        samples.append(sample)
    if len(samples) > args.max_samples:
        raise ValueError('Envelope export unexpectedly exceeded its sample budget')
    result = {
        'schema': 'promano-recorded-imu-v1', 'scene': scene['id'],
        'source': 'dataset sensor recording', 'sensorFrame': 'Original IMU sensor XYZ axes',
        'accelUnit': 'm/s²', 'gyroUnit': 'rad/s',
        'accelIncludesGravity': True, 'unitConversion': 'none; source SI values retained',
        'unitEvidence': args.unit_evidence,
        'sampleRateOriginal': round(1e9 / statistics.median(intervals), 6),
        'sourceRecordingSampleCount': all_count,
        'sourceIntervalSampleCount': sum(first <= row[0] <= last for row in rows),
        'sourceCsvSha256': digest.hexdigest(),
        'duration': scene['duration'], 'sourceStart': frames[0]['sourceTime'],
        'sourceEnd': frames[-1]['sourceTime'], 'decimated': True,
        'decimation': {'method': 'union of six-axis min/max sample rows per replay-time bin plus every video-frame anchor',
                       'bins': bins, 'measurementsInterpolated': False},
        'timeMapping': 'Piecewise linear sourceTime-to-time map between video keyframe anchors; repeated camera timestamps hold the nearest recorded IMU measurement; final video frame is held to clip end.',
        'clockEvidence': args.clock_evidence,
        'cameraAnchorMaxNearestSampleErrorSeconds': max_anchor_error / 1e9,
        'sampleCount': len(samples), 'samples': samples,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    return {key: value for key, value in result.items() if key != 'samples'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', type=Path, required=True)
    parser.add_argument('--imu-csv', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--max-samples', type=int, default=1600)
    parser.add_argument('--clock-evidence', required=True)
    parser.add_argument('--unit-evidence', required=True)
    args = parser.parse_args()
    if args.max_samples < 400:
        parser.error('--max-samples must be at least 400')
    print(json.dumps(export(args), ensure_ascii=False))


if __name__ == '__main__':
    main()
